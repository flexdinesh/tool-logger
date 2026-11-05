//go:build e2e

package main

import (
	"encoding/json"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

type automationDriver struct {
	conn    net.Conn
	encoder *json.Encoder
	decoder *json.Decoder
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

func (d *automationDriver) waitDOM(t *testing.T, script string, timeout time.Duration) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	var lastErr error
	for time.Now().Before(deadline) {
		var reply struct {
			Value bool `json:"value"`
		}
		lastErr = d.call("eval", map[string]string{"script": script}, &reply)
		if lastErr == nil && reply.Value {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("DOM condition timed out: %s: %v", script, lastErr)
}

func (d *automationDriver) menu(t *testing.T, label string) {
	t.Helper()
	if err := d.call("menu", map[string][]string{"path": {"Activity", label}}, nil); err != nil {
		t.Fatal(err)
	}
}

func (d *automationDriver) assertVisible(t *testing.T, want bool) {
	t.Helper()
	var reply struct {
		Windows []struct {
			Visible bool `json:"visible"`
		} `json:"windows"`
	}
	if err := d.call("windows", nil, &reply); err != nil {
		t.Fatal(err)
	}
	if len(reply.Windows) != 1 || reply.Windows[0].Visible != want {
		t.Fatalf("windows = %+v, want one visible=%t", reply.Windows, want)
	}
}

// Real MyGo process checks are available to Linux/macOS desktop CI. All page
// interactions use eval and DOM semantics; native widget trees no longer exist.
func TestDesktopQuitLeavesCollectorRunning(t *testing.T) {
	if os.Getenv("TOOL_LOGGER_NATIVE_E2E") != "1" {
		t.Skip("set TOOL_LOGGER_NATIVE_E2E=1 in a Linux/macOS desktop session with WebKit support")
	}
	if runtime.GOOS == "linux" && os.Getenv("DISPLAY") == "" && os.Getenv("WAYLAND_DISPLAY") == "" {
		t.Skip("MyGo webview process requires a display and WebKitGTK; not available headlessly")
	}
	p := startProcess(t, buildProcess(t, "e2e"), nil, []string{"tool-logger://activity?harness=codex&q=first-launch"})
	var conn net.Conn
	var err error
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		conn, err = net.DialTimeout("unix", filepath.Join(filepath.Dir(p.state), "automation.sock"), 100*time.Millisecond)
		if err == nil {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if err != nil {
		t.Fatalf("automation did not start: %v", err)
	}
	defer conn.Close()
	driver := &automationDriver{conn: conn, encoder: json.NewEncoder(conn), decoder: json.NewDecoder(conn)}
	driver.waitDOM(t, `document.documentElement.dataset.ready === 'true' && document.querySelector('input[type="search"]')?.value === 'first-launch'`, 10*time.Second)
	// Start a fresh unfiltered navigation through a forwarded activity link.
	second := exec.Command(p.command.Path, "--connection", p.descriptor, "tool-logger://activity?harness=codex")
	second.Env = p.command.Env
	if output, err := second.CombinedOutput(); err != nil {
		t.Fatalf("second instance: %v: %s", err, output)
	}
	driver.waitDOM(t, `document.querySelector('input[type="search"]')?.value === ''`, 5*time.Second)
	source := p.source(t)
	started := time.Now()
	p.ingest(t, source, "550e8400-e29b-41d4-a716-446655440011", "composed-tool")
	driver.waitDOM(t, `document.body.textContent.includes('composed-tool')`, 2*time.Second)
	if time.Since(started) > 2*time.Second {
		t.Fatal("event visibility exceeded two seconds")
	}
	driver.menu(t, "Search calls")
	driver.waitDOM(t, `document.activeElement?.matches('input[type="search"]') === true`, 3*time.Second)
	driver.menu(t, "Pause / Resume")
	driver.waitDOM(t, `document.querySelector('#live')?.getAttribute('aria-pressed') === 'false'`, 3*time.Second)
	driver.menu(t, "Pause / Resume")
	driver.menu(t, "Close Window")
	driver.assertVisible(t, false)
	processRequest(t, p.client, "GET", p.endpoint+"/healthz", "", nil, 200, nil)
	// Window close retains actual ingestion, not just a health handler.
	p.ingest(t, source, "550e8400-e29b-41d4-a716-446655440012", "hidden-window-tool")
	second = exec.Command(p.command.Path, "--connection", p.descriptor, "tool-logger://activity?harness=codex&q=hidden-window-tool")
	second.Env = p.command.Env
	if output, err := second.CombinedOutput(); err != nil {
		t.Fatalf("second instance reopen: %v: %s", err, output)
	}
	driver.waitDOM(t, `document.querySelector('input[type="search"]')?.value === 'hidden-window-tool' && document.body.textContent.includes('hidden-window-tool')`, 5*time.Second)
	driver.assertVisible(t, true)
	// Quit can close the socket before replying.
	_ = driver.call("menu", map[string][]string{"path": {"Activity", "Quit"}}, nil)
	p.assertStopped(t)
}

func TestDesktopConnectionsKeepNativeProfilesAndHistoriesSeparate(t *testing.T) {
	if os.Getenv("TOOL_LOGGER_NATIVE_E2E") != "1" {
		t.Skip("set TOOL_LOGGER_NATIVE_E2E=1 in a Linux/macOS desktop session with WebKit support")
	}
	if runtime.GOOS == "linux" && os.Getenv("DISPLAY") == "" && os.Getenv("WAYLAND_DISPLAY") == "" {
		t.Skip("MyGo webview process requires a display and WebKitGTK; not available headlessly")
	}
	binary := buildProcess(t, "e2e")
	first, second := startProcess(t, binary, nil, nil), startProcess(t, binary, nil, nil)
	connect := func(p *appProcess) *automationDriver {
		t.Helper()
		deadline := time.Now().Add(15 * time.Second)
		for time.Now().Before(deadline) {
			conn, err := net.DialTimeout("unix", filepath.Join(filepath.Dir(p.state), "automation.sock"), 100*time.Millisecond)
			if err == nil {
				t.Cleanup(func() { conn.Close() })
				return &automationDriver{conn: conn, encoder: json.NewEncoder(conn), decoder: json.NewDecoder(conn)}
			}
			time.Sleep(20 * time.Millisecond)
		}
		t.Fatal("connection-specific native process did not start")
		return nil
	}
	a, b := connect(first), connect(second)
	a.waitDOM(t, `document.documentElement.dataset.ready === 'true'`, 10*time.Second)
	b.waitDOM(t, `document.documentElement.dataset.ready === 'true'`, 10*time.Second)
	a.assertVisible(t, true)
	b.assertVisible(t, true)
	source := first.source(t)
	first.ingest(t, source, "550e8400-e29b-41d4-a716-446655440014", "first-connection-only")
	a.waitDOM(t, `document.body.textContent.includes('first-connection-only')`, 3*time.Second)
	b.waitDOM(t, `document.querySelector('#stat-calls')?.textContent === '0' && !document.body.textContent.includes('first-connection-only')`, 3*time.Second)
	// Both native sessions stay authenticated even though loopback cookies
	// share a host. Closing one window cannot redirect the other's connection.
	a.menu(t, "Close Window")
	a.assertVisible(t, false)
	b.assertVisible(t, true)
	b.waitDOM(t, `document.querySelector('#stat-calls')?.textContent === '0'`, 3*time.Second)
}
