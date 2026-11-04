//go:build e2e

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
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"tool-logger/desktop/internal/domain"
)

// This tests the composed executable, including its owned listener and shutdown,
// rather than embedding an HTTP test server outside the native process.
func TestComposedAppOwnsServerThroughWindowCloseAndQuit(t *testing.T) {
	if os.Getenv("TOOL_LOGGER_NATIVE_E2E") != "1" {
		t.Skip("set TOOL_LOGGER_NATIVE_E2E=1 in a desktop session")
	}
	dir, err := os.MkdirTemp("", "tl-composed-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(dir)
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	binary := filepath.Join(dir, "observer")
	build := exec.CommandContext(ctx, "go", "build", "-tags", "e2e", "-o", binary, ".")
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build: %v: %s", err, output)
	}
	state := filepath.Join(dir, "state")
	socket := filepath.Join(dir, "automation.sock")
	command := exec.CommandContext(ctx, binary, "--listen", "127.0.0.1:0")
	command.Env = append(os.Environ(), "TOOL_LOGGER_STATE_DIR="+state, "MYGO_AUTOMATION="+socket, "XDG_RUNTIME_DIR="+dir, "XDG_DATA_HOME="+filepath.Join(dir, "data"), "XDG_CONFIG_HOME="+filepath.Join(dir, "config"))
	stderr, err := command.StderrPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	finished := make(chan error, 1)
	go func() { finished <- command.Wait() }()
	defer func() { _ = command.Process.Kill() }()
	endpoints := make(chan string, 1)
	go func() {
		scanner := bufio.NewScanner(stderr)
		for scanner.Scan() {
			line := scanner.Text()
			if _, endpoint, ok := strings.Cut(line, "native client "); ok {
				endpoints <- endpoint
			}
		}
	}()
	var endpoint string
	select {
	case endpoint = <-endpoints:
	case err := <-finished:
		t.Fatalf("app exited before ready: %v", err)
	case <-ctx.Done():
		t.Fatal("listener was not started")
	}
	token, err := os.ReadFile(filepath.Join(state, "collector", "admin.token"))
	if err != nil {
		t.Fatal(err)
	}
	admin := strings.TrimSpace(string(token))
	request := func(method, path, credential string, value interface{}, result interface{}) {
		t.Helper()
		body, _ := json.Marshal(value)
		req, _ := http.NewRequestWithContext(ctx, method, endpoint+path, bytes.NewReader(body))
		req.Header.Set("Authorization", "Bearer "+credential)
		req.Header.Set("Content-Type", "application/json")
		response, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		if response.StatusCode >= 300 {
			detail, _ := io.ReadAll(response.Body)
			t.Fatalf("%s %s: %d %s", method, path, response.StatusCode, detail)
		}
		if result != nil {
			if err := json.NewDecoder(response.Body).Decode(result); err != nil {
				t.Fatal(err)
			}
		}
	}
	var credentials domain.SourceCredentials
	request("POST", "/api/v1/sources", admin, domain.SourceRequest{Name: "Composed process source"}, &credentials)
	stamp := time.Now().UTC().Format(time.RFC3339Nano)
	id := "550e8400-e29b-41d4-a716-446655440011"
	native, _ := json.Marshal(map[string]interface{}{"schema_version": 2, "event_id": id, "logged_at": stamp, "harness": "codex", "hook": "PreToolUse", "metadata": map[string]interface{}{}, "event": map[string]interface{}{"hook_event_name": "PreToolUse", "session_id": "composed-session", "tool_use_id": "composed-call", "tool_name": "composed-tool", "tool_input": map[string]string{"cmd": "composed evidence"}}})
	var conn net.Conn
	for conn == nil {
		conn, err = net.DialTimeout("unix", socket, 100*time.Millisecond)
		if err != nil {
			select {
			case <-ctx.Done():
				t.Fatal("automation did not start")
			case <-time.After(20 * time.Millisecond):
			}
		}
	}
	defer conn.Close()
	encoder, decoder := json.NewEncoder(conn), json.NewDecoder(conn)
	call := func(method string, params interface{}, result interface{}) {
		t.Helper()
		_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
		if err := encoder.Encode(map[string]interface{}{"id": 1, "method": method, "params": params}); err != nil {
			t.Fatal(err)
		}
		var reply struct {
			Result json.RawMessage                 `json:"result"`
			Error  *struct{ Code, Message string } `json:"error"`
		}
		if err := decoder.Decode(&reply); err != nil {
			t.Fatal(err)
		}
		if reply.Error != nil {
			t.Fatal(fmt.Sprintf("%s: %+v", method, reply.Error))
		}
		if result != nil {
			if err := json.Unmarshal(reply.Result, result); err != nil {
				t.Fatal(err)
			}
		}
	}
	for {
		var windows struct {
			Windows []json.RawMessage `json:"windows"`
		}
		call("windows", nil, &windows)
		if len(windows.Windows) > 0 {
			break
		}
		select {
		case <-ctx.Done():
			t.Fatal("native window did not open")
		case <-time.After(20 * time.Millisecond):
		}
	}
	started := time.Now()
	request("POST", "/api/v1/ingest/events", credentials.Token, domain.IngestRequest{Events: []domain.Event{{SchemaVersion: 1, EventID: id, SourceID: credentials.Source.ID, Harness: "codex", RecordedAt: stamp, Native: native}}}, nil)
	for {
		var tree struct {
			Nodes []struct {
				Label string `json:"label"`
			} `json:"nodes"`
		}
		call("tree", nil, &tree)
		found := false
		for _, node := range tree.Nodes {
			if strings.Contains(node.Label, "composed evidence") {
				found = true
				break
			}
		}
		if found {
			break
		}
		select {
		case <-ctx.Done():
			t.Fatal("ingested evidence never reached the native view")
		case <-time.After(20 * time.Millisecond):
		}
	}
	if elapsed := time.Since(started); elapsed > 2*time.Second {
		t.Fatalf("live visibility exceeded 2 seconds: %v", elapsed)
	}
	call("menu", map[string]interface{}{"path": []string{"Activity", "Close Window"}}, nil)
	response, err := http.Get(endpoint + "/healthz")
	if err != nil {
		t.Fatalf("window close stopped ingestion: %v", err)
	}
	response.Body.Close()
	if response.StatusCode != 200 {
		t.Fatal("server not healthy after window close")
	}
	call("menu", map[string]interface{}{"path": []string{"Activity", "Open Tool Logger"}}, nil)
	call("menu", map[string]interface{}{"path": []string{"Activity", "Quit"}}, nil)
	select {
	case err := <-finished:
		if err != nil {
			t.Fatalf("Quit failed: %v", err)
		}
	case <-ctx.Done():
		t.Fatal("Quit did not stop composed app")
	}
	if response, err := http.Get(endpoint + "/healthz"); err == nil {
		response.Body.Close()
		t.Fatal("HTTP listener survived Quit")
	}
}
