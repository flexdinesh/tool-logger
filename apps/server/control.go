package server

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"

	"tool-logger/apps/server/internal/sqlite"
	"tool-logger/packages/protocol"
)

func (c *collector) localHandler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/v1/control/status", func(w http.ResponseWriter, r *http.Request) {
		c.mu.Lock()
		defer c.mu.Unlock()
		status := domain.ServerStatus{Ready: true, PID: os.Getpid(), WorkerPID: c.workerPID, WorkerError: c.workerError, ServerID: c.connection.ServerID}
		if c.remote != nil {
			status.RemoteEndpoint = c.remote.endpoint
		}
		writeJSON(w, status)
	})
	mux.HandleFunc("POST /api/v1/control/stop", func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204); c.cancel() })
	mux.HandleFunc("POST /api/v1/control/local-source", func(w http.ResponseWriter, r *http.Request) {
		var request domain.LocalSourceRequest
		if !readRequest(w, r, &request) {
			return
		}
		value, err := c.ensureLocalSource(r.Context(), request.WorkerPath)
		if err != nil {
			controlError(w, err)
			return
		}
		writeJSON(w, value)
	})
	mux.HandleFunc("POST /api/v1/control/remote", func(w http.ResponseWriter, r *http.Request) {
		var request domain.RemoteRequest
		if !readRequest(w, r, &request) {
			return
		}
		value, err := c.invite(request)
		if err != nil {
			controlError(w, err)
			return
		}
		writeJSON(w, value)
	})
	mux.HandleFunc("GET /api/v1/control/clients", func(w http.ResponseWriter, r *http.Request) {
		value, err := c.store.RemoteClients(r.Context())
		if err != nil {
			controlError(w, err)
			return
		}
		writeJSON(w, value)
	})
	mux.HandleFunc("DELETE /api/v1/control/clients/{id}", func(w http.ResponseWriter, r *http.Request) {
		if err := c.store.RevokeClient(r.Context(), r.PathValue("id")); err != nil {
			controlError(w, err)
			return
		}
		w.WriteHeader(204)
	})
	mux.Handle("/", c.api)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		if strings.HasPrefix(r.URL.Path, "/api/v1/control/") && !equalToken(requestToken(r), c.connection.Token) {
			controlError(w, &sqlite.Error{Status: 401, Title: "Unauthorized"})
			return
		}
		mux.ServeHTTP(w, r)
	})
}

func requestToken(r *http.Request) string {
	values := r.Header.Values("Authorization")
	if len(values) != 1 {
		return ""
	}
	parts := strings.Fields(values[0])
	if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") || len(parts[1]) > 512 {
		return ""
	}
	return parts[1]
}
func equalToken(a, b string) bool {
	x := sha256.Sum256([]byte(a))
	y := sha256.Sum256([]byte(b))
	return a != "" && b != "" && subtle.ConstantTimeCompare(x[:], y[:]) == 1
}
func readRequest(w http.ResponseWriter, r *http.Request, value interface{}) bool {
	media, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || media != "application/json" {
		controlError(w, &sqlite.Error{Status: 415, Title: "Content-Type must be application/json"})
		return false
	}
	d := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10))
	var body json.RawMessage
	if err := d.Decode(&body); err != nil {
		controlError(w, sqlite.Invalid("Invalid JSON request"))
		return false
	}
	if d.Decode(new(json.RawMessage)) != io.EOF {
		controlError(w, sqlite.Invalid("Expected one JSON object"))
		return false
	}
	if len(body) == 0 || body[0] != '{' {
		controlError(w, sqlite.Invalid("Expected one JSON object"))
		return false
	}
	strict := json.NewDecoder(bytes.NewReader(body))
	strict.DisallowUnknownFields()
	if err := strict.Decode(value); err != nil {
		controlError(w, sqlite.Invalid("Invalid JSON request"))
		return false
	}
	return true
}
func writeJSON(w http.ResponseWriter, value interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(value)
}
func controlError(w http.ResponseWriter, err error) {
	p := domain.Problem{Type: "about:blank", Status: 500, Title: "Collector operation failed"}
	var typed *sqlite.Error
	if errors.As(err, &typed) {
		p.Status = typed.Status
		p.Title = typed.Title
		p.Detail = typed.Detail
	}
	w.Header().Set("Content-Type", "application/problem+json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(p.Status)
	_ = json.NewEncoder(w).Encode(p)
}

// Provisioning executes inside the collector so no second process writes SQLite.
func (c *collector) ensureLocalSource(ctx context.Context, workerPath string) (domain.SourceConfig, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	var config domain.SourceConfig
	if workerPath == "" || !filepath.IsAbs(workerPath) {
		return config, sqlite.Invalid("workerPath must be an absolute installed transport CLI path")
	}
	info, err := os.Stat(workerPath)
	if err != nil || !info.Mode().IsRegular() {
		return config, sqlite.Invalid("Installed transport CLI is unavailable")
	}
	node, err := exec.LookPath("node")
	if err != nil {
		return config, sqlite.Invalid("Node 26 is required for local collection")
	}
	probeCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	version, err := exec.CommandContext(probeCtx, node, "--version").Output()
	cancel()
	if err != nil || !strings.HasPrefix(string(version), "v26.") {
		return config, sqlite.Invalid("Node 26 is required for local collection")
	}
	path := filepath.Join(c.state, "source.json")
	err = readPrivate(path, &config)
	if errors.Is(err, os.ErrNotExist) {
		hostname, _ := os.Hostname()
		if hostname == "" {
			hostname = "Local machine"
		}
		pending := filepath.Join(c.state, "collector", "pending-source.json")
		err := readPrivate(pending, &config)
		if errors.Is(err, os.ErrNotExist) {
			var bytes [32]byte
			if _, err := rand.Read(bytes[:]); err != nil {
				return config, err
			}
			config = domain.SourceConfig{SchemaVersion: 1, SourceID: sqlite.UUID(), Endpoint: c.connection.Endpoint, Token: base64.RawURLEncoding.EncodeToString(bytes[:]), Name: hostname, Labels: map[string]string{}}
			if err := writePrivate(pending, config); err != nil {
				return config, err
			}
		} else if err != nil {
			return config, err
		}
		if config.SchemaVersion != 1 {
			return config, sqlite.Invalid("Invalid pending local source configuration")
		}
		if err := c.store.ProvisionLocalSource(ctx, config, domain.SourceRequest{Name: config.Name, Hostname: hostname, Platform: runtime.GOOS, Labels: config.Labels}); err != nil {
			return config, err
		}
		if err := writePrivate(path, config); err != nil {
			return config, err
		}
		if err := os.Remove(pending); err != nil {
			return config, err
		}
	} else if err != nil {
		return config, sqlite.Invalid("Existing source configuration is invalid; preserve and repair it")
	}
	if config.SchemaVersion != 1 || !sqlite.ValidUUID(config.SourceID) || strings.TrimSpace(config.Name) == "" || config.Labels == nil {
		return config, sqlite.Invalid("Existing source configuration is invalid; preserve and repair it")
	}
	id, err := c.store.AuthenticateSource(ctx, config.Token)
	if err != nil || id != config.SourceID {
		return config, sqlite.Invalid("Existing source identity does not belong to this collector; use a fresh state directory")
	}
	if config.Endpoint != c.connection.Endpoint {
		config.Endpoint = c.connection.Endpoint
		if err := writePrivate(path, config); err != nil {
			return config, err
		}
	}
	if err := writePrivate(filepath.Join(c.state, "collector", "worker.json"), struct {
		Path string `json:"path"`
	}{workerPath}); err != nil {
		return config, err
	}
	if c.workerPath != workerPath {
		c.workerPath = workerPath
		select {
		case c.workerWake <- struct{}{}:
		default:
		}
	}
	return config, nil
}

func (c *collector) superviseWorker() {
	backoff := 500 * time.Millisecond
	for c.ctx.Err() == nil {
		c.mu.Lock()
		path := c.workerPath
		select {
		case <-c.workerWake:
		default:
		}
		c.mu.Unlock()
		if path == "" {
			select {
			case <-c.ctx.Done():
				return
			case <-c.workerWake:
				continue
			}
		}
		command, owner, err := c.startWorker(path)
		if err != nil {
			c.mu.Lock()
			c.workerError = "Worker could not start; inspect collector/worker.log"
			c.mu.Unlock()
			if pause(c.ctx, backoff) != nil {
				return
			}
			backoff = min(backoff*2, 30*time.Second)
			continue
		}
		c.mu.Lock()
		c.workerPID = command.Process.Pid
		c.workerError = ""
		c.mu.Unlock()
		started := time.Now()
		done := make(chan error, 1)
		go func() { done <- command.Wait() }()
		restart := false
		select {
		case <-c.ctx.Done():
			stopWorker(command, done)
		case <-c.workerWake:
			restart = true
			stopWorker(command, done)
		case <-done:
			c.mu.Lock()
			c.workerError = "Worker exited; retrying; inspect collector/worker.log"
			c.mu.Unlock()
		}
		_ = owner.Close()
		c.mu.Lock()
		c.workerPID = 0
		c.mu.Unlock()
		if c.ctx.Err() != nil {
			return
		}
		if restart {
			backoff = 500 * time.Millisecond
			continue
		}
		if time.Since(started) > 30*time.Second {
			backoff = 500 * time.Millisecond
		}
		if pause(c.ctx, backoff) != nil {
			return
		}
		backoff = min(backoff*2, 30*time.Second)
	}
}

func (c *collector) startWorker(path string) (*exec.Cmd, *os.File, error) {
	lock, err := lockFile(filepath.Join(c.state, "collector", "worker.lock"))
	if err != nil {
		return nil, nil, err
	}
	// The inherited flock stays held until Node exits, including after SIGKILL of
	// its collector. A replacement collector waits rather than duplicating work.
	defer lock.Close()
	reader, owner, err := os.Pipe()
	if err != nil {
		return nil, nil, err
	}
	defer reader.Close()
	command := exec.Command("node", path, "run")
	command.ExtraFiles = []*os.File{reader, lock}
	command.Env = replaceEnv(replaceEnv(os.Environ(), "TOOL_LOGGER_STATE_DIR", c.state), "TOOL_LOGGER_OWNER_FD", "3")
	log, err := openPrivateLog(filepath.Join(c.state, "collector", "worker.log"))
	if err != nil {
		owner.Close()
		return nil, nil, err
	}
	command.Stdout = log
	command.Stderr = log
	err = command.Start()
	_ = log.Close()
	if err != nil {
		owner.Close()
		return nil, nil, err
	}
	return command, owner, nil
}

func stopWorker(command *exec.Cmd, done <-chan error) {
	_ = command.Process.Signal(syscall.SIGTERM)
	timer := time.NewTimer(5 * time.Second)
	defer timer.Stop()
	select {
	case <-done:
	case <-timer.C:
		_ = command.Process.Kill()
		<-done
	}
}
