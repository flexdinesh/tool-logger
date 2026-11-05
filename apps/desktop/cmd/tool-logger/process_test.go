package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/cookiejar"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"tool-logger/desktop/internal/apiclient"
	"tool-logger/desktop/internal/domain"
	"tool-logger/desktop/internal/sqlite"
)

type appProcess struct {
	command                 *exec.Cmd
	finished                chan error
	state, endpoint, origin string
}

func buildProcess(t *testing.T, tags string) string {
	t.Helper()
	binary := filepath.Join(t.TempDir(), "tool-logger")
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	args := []string{"build", "-o", binary}
	if tags != "" {
		args = append(args, "-tags", tags)
	}
	args = append(args, ".")
	if output, err := exec.CommandContext(ctx, "go", args...).CombinedOutput(); err != nil {
		t.Fatalf("build executable: %v: %s", err, output)
	}
	return binary
}

func startProcess(t *testing.T, binary string, env, args []string) *appProcess {
	t.Helper()
	dir, err := os.MkdirTemp("", "tl-process-")
	if err != nil {
		t.Fatal(err)
	}
	p := &appProcess{state: filepath.Join(dir, "state"), finished: make(chan error, 1)}
	args = append([]string{"--listen", "127.0.0.1:0", "--ui-listen", "127.0.0.1:0"}, args...)
	p.command = exec.Command(binary, args...)
	p.command.Env = append(os.Environ(), "TOOL_LOGGER_STATE_DIR="+p.state, "MYGO_DEV_URL=", "TOOL_LOGGER_WEB_DEV_URL=", "MYGO_AUTOMATION="+filepath.Join(dir, "automation.sock"), "XDG_RUNTIME_DIR="+dir, "XDG_DATA_HOME="+filepath.Join(dir, "data"), "XDG_CONFIG_HOME="+filepath.Join(dir, "config"))
	p.command.Env = append(p.command.Env, env...)
	stderr, err := p.command.StderrPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := p.command.Start(); err != nil {
		t.Fatal(err)
	}
	go func() { p.finished <- p.command.Wait(); close(p.finished) }()
	t.Cleanup(func() {
		_ = p.command.Process.Kill()
		select {
		case <-p.finished:
		case <-time.After(5 * time.Second):
			t.Error("process did not exit")
		}
		_ = os.RemoveAll(dir)
	})
	endpoints := make(chan [2]string, 1)
	go func() {
		defer close(endpoints)
		scanner := bufio.NewScanner(stderr)
		for scanner.Scan() {
			line := scanner.Text()
			if _, rest, ok := strings.Cut(line, "Tool Logger ingestion "); ok {
				if endpoint, origin, ok := strings.Cut(rest, "; UI "); ok {
					endpoints <- [2]string{endpoint, origin}
				}
			} else {
				fmt.Fprintln(os.Stderr, line)
			}
		}
	}()
	select {
	case value := <-endpoints:
		p.endpoint, p.origin = value[0], value[1]
		if p.endpoint == "" || p.origin == "" {
			t.Fatal("process exited before reporting listeners")
		}
	case err := <-p.finished:
		t.Fatalf("process exited before ready: %v", err)
	case <-time.After(15 * time.Second):
		t.Fatal("process did not start listeners")
	}
	return p
}

func processRequest(t *testing.T, client *http.Client, method, endpoint, origin string, value interface{}, status int, out interface{}) *http.Response {
	t.Helper()
	var body io.Reader
	if value != nil {
		data, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		body = bytes.NewReader(data)
	}
	request, err := http.NewRequest(method, endpoint, body)
	if err != nil {
		t.Fatal(err)
	}
	if origin != "" {
		request.Header.Set("Origin", origin)
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != status {
		data, _ := io.ReadAll(response.Body)
		t.Fatalf("%s %s status = %d, want %d: %s", method, endpoint, response.StatusCode, status, data)
	}
	if out != nil {
		if err := json.NewDecoder(response.Body).Decode(out); err != nil {
			t.Fatal(err)
		}
	}
	return response
}

func (p *appProcess) admin(t *testing.T) string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(p.state, "collector", "admin.token"))
	if err != nil {
		t.Fatal(err)
	}
	return strings.TrimSpace(string(data))
}

func (p *appProcess) source(t *testing.T) domain.SourceCredentials {
	t.Helper()
	client, err := apiclient.New(p.endpoint, p.admin(t))
	if err != nil {
		t.Fatal(err)
	}
	credentials, err := client.CreateSource(context.Background(), domain.SourceRequest{Name: "Composed process source"})
	if err != nil {
		t.Fatal(err)
	}
	return credentials
}

func (p *appProcess) ingest(t *testing.T, source domain.SourceCredentials, id, tool string) {
	t.Helper()
	stamp := time.Now().UTC().Format(time.RFC3339Nano)
	native, err := json.Marshal(map[string]interface{}{"schema_version": 2, "event_id": id, "logged_at": stamp, "harness": "codex", "hook": "PreToolUse", "metadata": map[string]interface{}{}, "event": map[string]interface{}{"hook_event_name": "PreToolUse", "session_id": "composed-session", "tool_use_id": id, "tool_name": tool, "tool_input": map[string]string{"cmd": "composed evidence"}}})
	if err != nil {
		t.Fatal(err)
	}
	body, err := json.Marshal(domain.IngestRequest{Events: []domain.Event{{SchemaVersion: 1, EventID: id, SourceID: source.Source.ID, Harness: "codex", RecordedAt: stamp, Native: native}}})
	if err != nil {
		t.Fatal(err)
	}
	request, err := http.NewRequest("POST", p.endpoint+"/api/v1/ingest/events", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Authorization", "Bearer "+source.Token)
	request.Header.Set("Content-Type", "application/json")
	response, err := (&http.Client{Timeout: 5 * time.Second}).Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		data, _ := io.ReadAll(response.Body)
		t.Fatalf("ingest = %d: %s", response.StatusCode, data)
	}
}

func (p *appProcess) assertStopped(t *testing.T) {
	t.Helper()
	select {
	case err := <-p.finished:
		if err != nil {
			t.Fatalf("process shutdown: %v", err)
		}
	case <-time.After(12 * time.Second):
		t.Fatal("process did not stop cleanly")
	}
	client := &http.Client{Timeout: time.Second}
	for _, endpoint := range []string{p.endpoint + "/healthz", p.origin + "/"} {
		if response, err := client.Get(endpoint); err == nil {
			response.Body.Close()
			t.Fatalf("listener survived shutdown: %s", endpoint)
		}
	}
	store, err := sqlite.Open(filepath.Join(p.state, "collector", "events.sqlite"))
	if err != nil {
		t.Fatalf("SQLite unavailable after shutdown: %v", err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestServeProcessOwnsHTTPAuthenticationIngestionAndShutdownWithoutDisplay(t *testing.T) {
	p := startProcess(t, buildProcess(t, ""), []string{"DISPLAY=", "WAYLAND_DISPLAY="}, []string{"--serve"})
	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatal(err)
	}
	client := &http.Client{Jar: jar, Timeout: 5 * time.Second}
	processRequest(t, client, "GET", p.origin+"/", "", nil, 200, nil)
	processRequest(t, client, "GET", p.origin+"/api/v1/tool-calls", "", nil, 401, nil)
	source := p.source(t)
	processRequest(t, client, "POST", p.origin+"/ui/session", p.origin, map[string]string{"token": source.Token}, 401, nil)
	login := processRequest(t, client, "POST", p.origin+"/ui/session", p.origin, map[string]string{"token": p.admin(t)}, 204, nil)
	cookies := login.Cookies()
	if len(cookies) != 1 || !cookies[0].HttpOnly || cookies[0].SameSite != http.SameSiteStrictMode {
		t.Fatal("login did not issue an opaque HttpOnly SameSite=Strict session")
	}
	if cookies[0].Value == p.admin(t) {
		t.Fatal("session exposes administration credential")
	}
	processRequest(t, client, "GET", p.origin+"/ui/session", "", nil, 200, nil)
	id := "550e8400-e29b-41d4-a716-446655440011"
	p.ingest(t, source, id, "composed-tool")
	var calls domain.CallPage
	processRequest(t, client, "GET", p.origin+"/api/v1/tool-calls", "", nil, 200, &calls)
	if len(calls.Data) != 1 || calls.Data[0].SourceID != source.Source.ID || calls.Data[0].Tool != "composed-tool" {
		t.Fatalf("UI proxy lost ingested evidence: %+v", calls.Data)
	}
	processRequest(t, client, "POST", p.origin+"/api/v1/ingest/events", p.origin, domain.IngestRequest{}, 404, nil)
	processRequest(t, client, "DELETE", p.origin+"/ui/session", p.origin, nil, 204, nil)
	processRequest(t, client, "GET", p.origin+"/api/v1/tool-calls", "", nil, 401, nil)
	if err := p.command.Process.Signal(syscall.SIGTERM); err != nil {
		t.Fatal(err)
	}
	p.assertStopped(t)
}

func TestStartupFailureReleasesAlreadyOpenedIngestionListener(t *testing.T) {
	// An invalid UI address fails after SQLite and ingestion have opened.
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := listener.Addr().String()
	listener.Close()
	if _, err := startServers(t.TempDir(), address, "0.0.0.0:0"); err == nil {
		t.Fatal("unsafe UI startup succeeded")
	}
	listener, err = net.Listen("tcp", address)
	if err != nil {
		t.Fatalf("partial startup leaked ingestion listener: %v", err)
	}
	listener.Close()
}

func TestBindingGenerationDoesNotOpenStateOrListeners(t *testing.T) {
	directory := t.TempDir()
	state := filepath.Join(directory, "unopened-state")
	bindings := filepath.Join(directory, "bindings.ts")
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, buildProcess(t, ""))
	command.Env = append(os.Environ(), "MYGO_GENERATE="+bindings, "TOOL_LOGGER_STATE_DIR="+state,
		"TOOL_LOGGER_LISTEN=invalid", "TOOL_LOGGER_UI_LISTEN=invalid", "DISPLAY=", "WAYLAND_DISPLAY=")
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("generate bindings without backend or display: %v: %s", err, output)
	}
	if _, err := os.Stat(state); !os.IsNotExist(err) {
		t.Fatalf("generation touched application state: %v", err)
	}
	data, err := os.ReadFile(bindings)
	if err != nil {
		t.Fatal(err)
	}
	for _, method := range []string{"Shell.Preferences", "Shell.SavePreferences", "Shell.Quit"} {
		if !strings.Contains(string(data), method) {
			t.Fatalf("missing generated method %s", method)
		}
	}
	if strings.Contains(string(output), "Tool Logger ingestion") {
		t.Fatal("generation started application listeners")
	}
}

func TestServeValidatesUIListenEnvironmentWithoutInitializingMyGo(t *testing.T) {
	t.Setenv("TOOL_LOGGER_STATE_DIR", t.TempDir())
	t.Setenv("TOOL_LOGGER_UI_LISTEN", "0.0.0.0:0")
	err := runArgs(context.Background(), []string{"--serve", "--listen", "127.0.0.1:0"})
	if err == nil || !strings.Contains(err.Error(), "literal loopback IP") {
		t.Fatalf("UI listener environment was not validated: %v", err)
	}
}
