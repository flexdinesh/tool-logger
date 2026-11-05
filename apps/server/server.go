package server

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
	"tool-logger/apps/server/internal/app"
	"tool-logger/apps/server/internal/httpapi"
	"tool-logger/apps/server/internal/sqlite"
	"tool-logger/packages/client"
	"tool-logger/packages/protocol"
)

type Config struct {
	State      string
	WorkerPath string
}

func StateDirectory(override string) (string, error) {
	if override == "" {
		override = os.Getenv("TOOL_LOGGER_STATE_DIR")
	}
	return app.StateDirectory(override)
}

type collector struct {
	state       string
	connection  domain.Connection
	store       *sqlite.Store
	api         http.Handler
	cancel      context.CancelFunc
	ctx         context.Context
	mu          sync.Mutex
	workerPID   int
	workerError string
	workerPath  string
	workerWake  chan struct{}
	remote      *remoteListener
	invitations map[string]time.Time
}

// Run owns the SQLite writer, socket, remote listener and one supervised worker.
// The caller handles process signals by cancelling ctx.
func Run(ctx context.Context, config Config) error {
	state, err := StateDirectory(config.State)
	if err != nil {
		return err
	}
	directory := filepath.Join(state, "collector")
	if err := privateDirectory(directory); err != nil {
		return err
	}
	lock, err := lockFile(filepath.Join(directory, "server.lock"))
	if err != nil {
		return fmt.Errorf("collector already running or lock unavailable: %w", err)
	}
	defer unlockFile(lock)
	token, err := app.AdminToken(state)
	if err != nil {
		return err
	}
	var identity struct {
		ID string `json:"id"`
	}
	err = readPrivate(filepath.Join(directory, "identity.json"), &identity)
	if errors.Is(err, os.ErrNotExist) {
		identity.ID = sqlite.UUID()
		err = writePrivate(filepath.Join(directory, "identity.json"), identity)
	}
	if err != nil {
		return err
	}
	if !sqlite.ValidUUID(identity.ID) {
		return errors.New("invalid collector identity")
	}
	socket := filepath.Join(directory, "collector.sock")
	if info, err := os.Lstat(socket); err == nil {
		if info.Mode()&os.ModeSocket == 0 {
			return errors.New("collector socket path contains another file; preserve and repair it")
		}
		if err := os.Remove(socket); err != nil {
			return err
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	listener, err := net.Listen("unix", socket)
	if err != nil {
		return err
	}
	defer listener.Close()
	if err := os.Chmod(socket, 0600); err != nil {
		return err
	}
	store, err := sqlite.Open(filepath.Join(directory, "events.sqlite"))
	if err != nil {
		return err
	}
	defer store.Close()
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	c := &collector{state: state, store: store, cancel: cancel, ctx: ctx, workerWake: make(chan struct{}, 1), invitations: map[string]time.Time{}}
	c.connection = domain.Connection{SchemaVersion: 1, Endpoint: (&url.URL{Scheme: "unix", Path: socket}).String(), Token: token, ServerID: identity.ID}
	c.api = httpapi.New(store, token)
	var worker struct {
		Path string `json:"path"`
	}
	err = readPrivate(filepath.Join(directory, "worker.json"), &worker)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	c.workerPath = worker.Path
	if config.WorkerPath != "" {
		if _, err := c.ensureLocalSource(ctx, config.WorkerPath); err != nil {
			return err
		}
	}
	var remote domain.RemoteRequest
	err = readPrivate(filepath.Join(directory, "remote.json"), &remote)
	if err == nil {
		if _, err = c.startRemote(remote); err != nil {
			return err
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	defer c.closeRemote()
	if err := writePrivate(filepath.Join(directory, "connection.json"), c.connection); err != nil {
		return err
	}
	httpServer := newHTTPServer(c.localHandler())
	done := make(chan error, 1)
	go func() { done <- httpServer.Serve(listener) }()
	workerDone := make(chan struct{})
	go func() { defer close(workerDone); c.superviseWorker() }()
	var serveErr error
	select {
	case <-ctx.Done():
	case serveErr = <-done:
	}
	cancel()
	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 5*time.Second)
	err = httpServer.Shutdown(shutdownCtx)
	shutdownCancel()
	if err != nil {
		_ = httpServer.Close()
	}
	<-workerDone
	if serveErr != nil && !errors.Is(serveErr, http.ErrServerClosed) {
		return serveErr
	}
	return err
}

func newHTTPServer(handler http.Handler) *http.Server {
	return &http.Server{Handler: handler, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second, WriteTimeout: 30 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16 << 10}
}

func Status(ctx context.Context, state string) (domain.ServerStatus, error) {
	state, err := StateDirectory(state)
	if err != nil {
		return domain.ServerStatus{}, err
	}
	c, err := apiclient.LocalConnection(state)
	if err != nil {
		return domain.ServerStatus{}, err
	}
	client, err := apiclient.NewConnection(c)
	if err != nil {
		return domain.ServerStatus{}, err
	}
	defer client.Close()
	return client.Status(ctx)
}

// Ensure serializes launches and waits for authenticated readiness, not a PID file.
func Ensure(ctx context.Context, state string) error {
	state, err := StateDirectory(state)
	if err != nil {
		return err
	}
	if err := privateDirectory(filepath.Join(state, "collector")); err != nil {
		return err
	}
	var lock *os.File
	for {
		lock, err = lockFile(filepath.Join(state, "collector", "start.lock"))
		if err == nil {
			break
		}
		if !errors.Is(err, unix.EWOULDBLOCK) && !errors.Is(err, unix.EAGAIN) {
			return err
		}
		if err := pause(ctx, 25*time.Millisecond); err != nil {
			return err
		}
	}
	defer unlockFile(lock)
	probe, cancel := context.WithTimeout(ctx, 500*time.Millisecond)
	status, statusErr := Status(probe, state)
	cancel()
	if statusErr == nil && status.Ready {
		return nil
	}
	// A live collector may still be opening SQLite. Never launch a second writer.
	probeLock, err := lockFile(filepath.Join(state, "collector", "server.lock"))
	var processDone <-chan error
	if err == nil {
		unlockFile(probeLock)
		executable, err := os.Executable()
		if err != nil {
			return err
		}
		log, err := openPrivateLog(filepath.Join(state, "collector", "server.log"))
		if err != nil {
			return err
		}
		command := exec.Command(executable, "server", "run")
		command.Env = replaceEnv(os.Environ(), "TOOL_LOGGER_STATE_DIR", state)
		command.Stdout = log
		command.Stderr = log
		command.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
		err = command.Start()
		_ = log.Close()
		if err != nil {
			return err
		}
		done := make(chan error, 1)
		processDone = done
		go func() { done <- command.Wait() }()
	} else if !errors.Is(err, unix.EWOULDBLOCK) && !errors.Is(err, unix.EAGAIN) {
		return err
	}
	readyCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	for {
		probe, cancel := context.WithTimeout(readyCtx, 300*time.Millisecond)
		status, err := Status(probe, state)
		cancel()
		if err == nil && status.Ready {
			return nil
		}
		select {
		case <-processDone:
			return errors.New("collector exited before readiness; inspect collector/server.log")
		default:
		}
		if err := pause(readyCtx, 30*time.Millisecond); err != nil {
			return fmt.Errorf("collector did not become ready; inspect collector/server.log: %w", err)
		}
	}
}

func Stop(ctx context.Context, state string) error {
	state, err := StateDirectory(state)
	if err != nil {
		return err
	}
	// Stopping an absent collector is successful. Install/uninstall can safely
	// repeat shutdown without manufacturing a new state directory or token.
	if _, err := os.Lstat(filepath.Join(state, "collector")); errors.Is(err, os.ErrNotExist) {
		return nil
	} else if err != nil {
		return err
	}
	lock, err := lockFile(filepath.Join(state, "collector", "server.lock"))
	if err == nil {
		unlockFile(lock)
		return nil
	}
	if !errors.Is(err, unix.EWOULDBLOCK) && !errors.Is(err, unix.EAGAIN) {
		return err
	}
	c, err := apiclient.LocalConnection(state)
	if err != nil {
		return err
	}
	client, err := apiclient.NewConnection(c)
	if err != nil {
		return err
	}
	defer client.Close()
	if err := client.Stop(ctx); err != nil {
		return err
	}
	for {
		lock, err := lockFile(filepath.Join(state, "collector", "server.lock"))
		if err == nil {
			unlockFile(lock)
			return nil
		}
		if !errors.Is(err, unix.EWOULDBLOCK) && !errors.Is(err, unix.EAGAIN) {
			return err
		}
		if err := pause(ctx, 25*time.Millisecond); err != nil {
			return err
		}
	}
}

func EnsureLocalSource(ctx context.Context, state, workerPath string) error {
	state, err := StateDirectory(state)
	if err != nil {
		return err
	}
	if err := Ensure(ctx, state); err != nil {
		return err
	}
	c, err := apiclient.LocalConnection(state)
	if err != nil {
		return err
	}
	client, err := apiclient.NewConnection(c)
	if err != nil {
		return err
	}
	defer client.Close()
	_, err = client.EnsureLocalSource(ctx, workerPath)
	return err
}

func EnableRemote(ctx context.Context, state string, request domain.RemoteRequest) (domain.Invitation, error) {
	state, err := StateDirectory(state)
	if err != nil {
		return domain.Invitation{}, err
	}
	if err := Ensure(ctx, state); err != nil {
		return domain.Invitation{}, err
	}
	c, err := apiclient.LocalConnection(state)
	if err != nil {
		return domain.Invitation{}, err
	}
	client, err := apiclient.NewConnection(c)
	if err != nil {
		return domain.Invitation{}, err
	}
	defer client.Close()
	return client.EnableRemote(ctx, request)
}

func pause(ctx context.Context, d time.Duration) error {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}
func replaceEnv(env []string, key, value string) []string {
	result := make([]string, 0, len(env)+1)
	for _, v := range env {
		if !strings.HasPrefix(v, key+"=") {
			result = append(result, v)
		}
	}
	return append(result, key+"="+value)
}
