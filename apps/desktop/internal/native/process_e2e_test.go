//go:build e2e

package native

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"tool-logger/desktop/internal/apiclient"
	"tool-logger/desktop/internal/domain"
	"tool-logger/desktop/internal/httpapi"
	"tool-logger/desktop/internal/sqlite"
)

// The test binary doubles as a built native process. TestMain runs on the
// process's main thread, as MyGo requires. No automation endpoint exists in a
// normal build because both this helper and the import use the e2e tag.
func TestMain(m *testing.M) {
	if os.Getenv("TOOL_LOGGER_NATIVE_E2E_CHILD") == "1" {
		if err := Run(os.Getenv("TOOL_LOGGER_NATIVE_E2E_ENDPOINT"), "synthetic-admin"); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		os.Exit(0)
	}
	os.Exit(m.Run())
}

type automationNode struct {
	ID     string                                `json:"id"`
	Key    json.RawMessage                       `json:"key"`
	Label  string                                `json:"label"`
	Role   string                                `json:"role"`
	Bounds struct{ X, Y, Width, Height float32 } `json:"bounds"`
}
type automationDriver struct {
	conn    net.Conn
	decoder *json.Decoder
	encoder *json.Encoder
	id      int
}

func (d *automationDriver) call(method string, params interface{}, out interface{}) error {
	d.id++
	_ = d.conn.SetDeadline(time.Now().Add(5 * time.Second))
	if err := d.encoder.Encode(map[string]interface{}{"id": d.id, "method": method, "params": params}); err != nil {
		return err
	}
	var reply struct {
		Result json.RawMessage                 `json:"result"`
		Error  *struct{ Code, Message string } `json:"error"`
	}
	if err := d.decoder.Decode(&reply); err != nil {
		return err
	}
	if reply.Error != nil {
		return fmt.Errorf("%s: %s", reply.Error.Code, reply.Error.Message)
	}
	if out != nil {
		return json.Unmarshal(reply.Result, out)
	}
	return nil
}
func (d *automationDriver) nodes() ([]automationNode, error) {
	var tree struct {
		Nodes []automationNode `json:"nodes"`
	}
	err := d.call("tree", nil, &tree)
	return tree.Nodes, err
}
func (d *automationDriver) wait(t *testing.T, predicate func([]automationNode) bool) {
	t.Helper()
	deadline := time.NewTimer(8 * time.Second)
	defer deadline.Stop()
	tick := time.NewTicker(30 * time.Millisecond)
	defer tick.Stop()
	for {
		nodes, err := d.nodes()
		if err == nil && predicate(nodes) {
			return
		}
		select {
		case <-deadline.C:
			t.Fatalf("native automation condition timed out: %v, nodes=%+v", err, nodes)
		case <-tick.C:
		}
	}
}

func TestNativeProcessHTTPIngestionAndAutomation(t *testing.T) {
	if os.Getenv("TOOL_LOGGER_NATIVE_E2E") != "1" {
		t.Skip("set TOOL_LOGGER_NATIVE_E2E=1 in a Linux/macOS desktop session")
	}
	if runtime.GOOS == "linux" && os.Getenv("DISPLAY") == "" && os.Getenv("WAYLAND_DISPLAY") == "" {
		t.Skip("native process requires a virtual or physical display and GTK 3 libraries")
	}
	dir, err := os.MkdirTemp("", "tl-native-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(dir)
	store, err := sqlite.Open(filepath.Join(dir, "history.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	server := httptest.NewServer(httpapi.New(store, "synthetic-admin"))
	defer server.Close()
	client, err := apiclient.New(server.URL, "synthetic-admin")
	if err != nil {
		t.Fatal(err)
	}
	credentials, err := client.CreateSource(context.Background(), domain.SourceRequest{Name: "Synthetic e2e source", Labels: map[string]string{"test": "synthetic"}})
	if err != nil {
		t.Fatal(err)
	}
	stamp := time.Now().UTC().Format(time.RFC3339Nano)
	id := "3da60e47-cf28-4e6a-b8df-d2814b49e331"
	native := map[string]interface{}{"schema_version": 2, "event_id": id, "logged_at": stamp, "harness": "codex", "hook": "PreToolUse", "event": map[string]interface{}{"hook_event_name": "PreToolUse", "tool_name": "shell", "tool_use_id": "synthetic-call", "session_id": "synthetic-session", "turn_id": "synthetic-turn", "tool_input": map[string]string{"command": "echo native e2e"}}, "metadata": map[string]interface{}{"session_cwd": "/synthetic", "git": map[string]interface{}{"root": "/synthetic", "branch": "main", "dirty": false}}}
	raw, _ := json.Marshal(native)
	batch := domain.IngestRequest{Events: []domain.Event{{SchemaVersion: 1, EventID: id, SourceID: credentials.Source.ID, Harness: "codex", RecordedAt: stamp, Native: raw}}}
	data, _ := json.Marshal(batch)
	req, _ := http.NewRequest("POST", server.URL+"/api/v1/ingest/events", bytes.NewReader(data))
	req.Header.Set("Authorization", "Bearer "+credentials.Token)
	req.Header.Set("Content-Type", "application/json")
	response, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != 200 {
		t.Fatalf("ingest status %d", response.StatusCode)
	}
	socket := filepath.Join(dir, "automation.sock")
	cmd := exec.Command(os.Args[0], "-test.run=^$")
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "TOOL_LOGGER_NATIVE_E2E_CHILD=1", "TOOL_LOGGER_NATIVE_E2E_ENDPOINT="+server.URL, "TOOL_LOGGER_STATE_DIR="+filepath.Join(dir, "state"), "MYGO_AUTOMATION="+socket, "XDG_RUNTIME_DIR="+dir, "XDG_DATA_HOME="+filepath.Join(dir, "data"), "XDG_CONFIG_HOME="+filepath.Join(dir, "config"))
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	finished := make(chan error, 1)
	go func() { finished <- cmd.Wait(); close(finished) }()
	defer func() {
		_ = cmd.Process.Kill()
		select {
		case <-finished:
		case <-time.After(2 * time.Second):
		}
	}()
	var conn net.Conn
	deadline := time.NewTimer(8 * time.Second)
	defer deadline.Stop()
	tick := time.NewTicker(30 * time.Millisecond)
	defer tick.Stop()
connecting:
	for {
		conn, err = net.DialTimeout("unix", socket, 100*time.Millisecond)
		if err == nil {
			break
		}
		select {
		case err := <-finished:
			t.Fatalf("native process exited: %v", err)
		case <-deadline.C:
			t.Fatalf("automation unavailable: %v", err)
		case <-tick.C:
			continue connecting
		}
	}
	defer conn.Close()
	driver := &automationDriver{conn: conn, decoder: json.NewDecoder(bufio.NewReader(conn)), encoder: json.NewEncoder(conn)}
	driver.wait(t, func(nodes []automationNode) bool {
		for _, n := range nodes {
			if strings.Contains(n.Label, "echo native e2e") {
				return true
			}
		}
		return false
	})
	nodes, err := driver.nodes()
	if err != nil {
		t.Fatal(err)
	}
	for _, n := range nodes {
		if strings.Contains(n.Label, "echo native e2e") && n.Role == "row" {
			err = driver.call("input", map[string]interface{}{"events": []interface{}{map[string]interface{}{"type": "click", "x": n.Bounds.X + 20, "y": n.Bounds.Y + n.Bounds.Height/2}}}, nil)
			break
		}
	}
	if err != nil {
		t.Fatal(err)
	}
	driver.wait(t, func(nodes []automationNode) bool {
		for _, n := range nodes {
			if string(n.Key) == `"copy-json"` {
				return true
			}
		}
		return false
	})
	if err := driver.call("act", map[string]string{"key": "tab-native", "action": "press"}, nil); err != nil {
		t.Fatal(err)
	}
	if err := driver.call("act", map[string]string{"key": "toggle-live", "action": "press"}, nil); err != nil {
		t.Fatal(err)
	}
	driver.wait(t, func(nodes []automationNode) bool {
		for _, n := range nodes {
			if n.Label == "Resume" {
				return true
			}
		}
		return false
	})
	if err := driver.call("menu", map[string]interface{}{"path": []string{"Activity", "Close Window"}}, nil); err != nil {
		t.Fatal(err)
	}
	var windows struct {
		Windows []struct {
			Visible bool `json:"visible"`
		} `json:"windows"`
	}
	if err := driver.call("windows", nil, &windows); err != nil {
		t.Fatal(err)
	}
	if len(windows.Windows) != 1 || windows.Windows[0].Visible {
		t.Fatal("close must hide window and keep process alive")
	}
	if err := client.Health(context.Background()); err != nil {
		t.Fatal("ingestion server stopped on window close")
	}
	second := exec.Command(os.Args[0], "-test.run=^$", "tool-logger://activity?harness=codex")
	second.Dir = dir
	second.Env = cmd.Env
	if output, err := second.CombinedOutput(); err != nil {
		t.Fatalf("second instance: %v: %s", err, output)
	}
	driver.wait(t, func(nodes []automationNode) bool {
		for _, n := range nodes {
			if n.Label == "Activity" {
				return true
			}
		}
		return false
	})
	if err := driver.call("windows", nil, &windows); err != nil {
		t.Fatal(err)
	}
	if len(windows.Windows) != 1 || !windows.Windows[0].Visible {
		t.Fatal("second instance did not reopen existing window")
	}
	// Quit may close the automation socket before its final reply is delivered.
	quitError := driver.call("menu", map[string]interface{}{"path": []string{"Activity", "Quit"}}, nil)
	select {
	case err := <-finished:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(4 * time.Second):
		t.Fatalf("Quit did not stop native process: %v", quitError)
	}
}
