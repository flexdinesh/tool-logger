package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"tool-logger/packages/client"
	"tool-logger/packages/protocol"
)

type appProcess struct {
	command                 *exec.Cmd
	connection              apiclient.Connection
	client                  *http.Client
	descriptor              string
	cli                     string
	finished                chan error
	state, endpoint, origin string
}

var processBuilds = struct {
	sync.Mutex
	directory string
	binaries  map[string]string
}{binaries: make(map[string]string)}

func TestMain(m *testing.M) {
	var err error
	processBuilds.directory, err = os.MkdirTemp("", "tl-desktop-build-")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	code := m.Run()
	if err := os.RemoveAll(processBuilds.directory); err != nil {
		fmt.Fprintln(os.Stderr, err)
		code = 1
	}
	os.Exit(code)
}

// Each target/tag is built once per test process, never reused across checks.
func buildExecutable(t *testing.T, target, tags string) string {
	t.Helper()
	processBuilds.Lock()
	defer processBuilds.Unlock()
	key := target + ":" + tags
	if binary, ok := processBuilds.binaries[key]; ok {
		return binary
	}
	binary := filepath.Join(processBuilds.directory, fmt.Sprintf("tool-logger-%d", len(processBuilds.binaries)))
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	args := []string{"build", "-o", binary}
	if tags != "" {
		args = append(args, "-tags", tags)
	}
	args = append(args, target)
	if output, err := exec.CommandContext(ctx, "go", args...).CombinedOutput(); err != nil {
		t.Fatalf("build executable: %v: %s", err, output)
	}
	processBuilds.binaries[key] = binary
	return binary
}

func buildProcess(t *testing.T, tags string) string {
	t.Helper()
	return buildExecutable(t, ".", tags)
}

func copyProcessCLI(t *testing.T, destination string) {
	t.Helper()
	data, err := os.ReadFile(buildExecutable(t, "../../../cli", ""))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(destination), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(destination, data, 0700); err != nil {
		t.Fatal(err)
	}
}

func startProcess(t *testing.T, binary string, env, args []string) *appProcess {
	t.Helper()
	dir, err := os.MkdirTemp("", "tl-process-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	p := &appProcess{state: filepath.Join(dir, "state"), finished: make(chan error, 1)}
	p.cli = filepath.Join(dir, "tool-logger")
	copyProcessCLI(t, p.cli)
	cli := exec.Command(p.cli, "server", "start")
	cli.Env = append(os.Environ(), "TOOL_LOGGER_STATE_DIR="+p.state)
	if output, err := cli.CombinedOutput(); err != nil {
		t.Fatalf("start collector: %v: %s", err, output)
	}
	t.Cleanup(func() {
		command := exec.Command(p.cli, "server", "stop")
		command.Env = cli.Env
		if output, err := command.CombinedOutput(); err != nil {
			t.Errorf("stop collector: %v: %s", err, output)
		}
	})
	p.connection, err = apiclient.LocalConnection(p.state)
	if err != nil {
		t.Fatal(err)
	}
	p.client, err = apiclient.HTTPClient(p.connection)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(p.client.CloseIdleConnections)
	p.descriptor, err = apiclient.SaveConnection(p.state, p.connection)
	if err != nil {
		t.Fatal(err)
	}
	p.endpoint = apiclient.BaseURL(p.connection)
	args = append([]string{"--connection", p.descriptor}, args...)
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
	})
	endpoints := make(chan string, 1)
	go func() {
		defer close(endpoints)
		scanner := bufio.NewScanner(stderr)
		for scanner.Scan() {
			line := scanner.Text()
			if _, rest, ok := strings.Cut(line, "Tool Logger UI "); ok {
				endpoints <- rest
			} else {
				fmt.Fprintln(os.Stderr, line)
			}
		}
	}()
	select {
	case value := <-endpoints:
		p.origin = value
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
	client, err := apiclient.NewConnection(p.connection)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
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
	response, err := p.client.Do(request)
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
	if response, err := client.Get(p.origin + "/"); err == nil {
		response.Body.Close()
		t.Fatal("UI listener survived Quit")
	}
	processRequest(t, p.client, "GET", p.endpoint+"/healthz", "", nil, 200, nil)
	source := p.source(t)
	p.ingest(t, source, "550e8400-e29b-41d4-a716-446655440013", "after-quit-tool")
	// Actual durable API remains available after the UI process exits.
	admin, err := apiclient.NewConnection(p.connection)
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close()
	calls, err := admin.Calls(context.Background(), nil)
	if err != nil || len(calls.Data) < 3 {
		t.Fatalf("collector history after Quit: %+v, %v", calls, err)
	}
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
