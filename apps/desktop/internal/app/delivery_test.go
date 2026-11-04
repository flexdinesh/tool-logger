package app

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"testing"
	"time"

	"tool-logger/desktop/internal/domain"
	"tool-logger/desktop/internal/httpapi"
	"tool-logger/desktop/internal/sqlite"
)

func TestRealCodexPluginForwardsToGoCollector(t *testing.T) {
	state := t.TempDir()
	store, err := sqlite.Open(filepath.Join(t.TempDir(), "events.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	server := httptest.NewServer(httpapi.New(store, "synthetic-admin"))
	defer server.Close()
	credentials, err := store.CreateSource(context.Background(), domain.SourceRequest{Name: "Real Node plugin"})
	if err != nil {
		t.Fatal(err)
	}
	config, _ := json.Marshal(map[string]interface{}{"schemaVersion": 1, "sourceId": credentials.Source.ID, "endpoint": server.URL, "token": credentials.Token, "name": credentials.Source.Name, "labels": map[string]string{}})
	if err := os.WriteFile(filepath.Join(state, "source.json"), config, 0600); err != nil {
		t.Fatal(err)
	}
	root, err := filepath.Abs("../../../..")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	for _, hook := range []string{"PreToolUse", "PostToolUse"} {
		payload, _ := json.Marshal(map[string]interface{}{"hook_event_name": hook, "tool_name": "exec_command", "tool_use_id": "real-call", "session_id": "real-session", "cwd": state, "tool_input": map[string]string{"cmd": "pwd"}, "tool_response": "synthetic-result"})
		command := exec.CommandContext(ctx, "node", filepath.Join(root, "plugins/codex-tool-logger/scripts/log-tool-call.ts"))
		command.Env = append(os.Environ(), "TOOL_LOGGER_STATE_DIR="+state)
		command.Stdin = bytes.NewReader(payload)
		output, err := command.CombinedOutput()
		if err != nil || len(output) != 0 {
			t.Fatalf("plugin error %v, output %s", err, output)
		}
	}
	worker := exec.CommandContext(ctx, "node", filepath.Join(root, "plugins/codex-tool-logger/transport/cli.ts"), "run")
	worker.Env = append(os.Environ(), "TOOL_LOGGER_STATE_DIR="+state)
	var output bytes.Buffer
	worker.Stdout = &output
	worker.Stderr = &output
	if err := worker.Start(); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- worker.Wait() }()
	defer func() {
		_ = worker.Process.Signal(syscall.SIGTERM)
		select {
		case err := <-done:
			if err != nil {
				t.Errorf("worker: %v: %s", err, output.String())
			}
		case <-time.After(5 * time.Second):
			_ = worker.Process.Kill()
			<-done
			t.Error("worker did not stop")
		}
	}()
	query, err := sqlite.ParseQuery(nil)
	if err != nil {
		t.Fatal(err)
	}
	ticker := time.NewTicker(25 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			t.Fatal("plugin events were not delivered before deadline")
		case <-ticker.C:
			page, err := store.Calls(ctx, query)
			if err != nil {
				t.Fatal(err)
			}
			if len(page.Data) != 1 || page.Data[0].Lifecycle != "finished" {
				continue
			}
			call := page.Data[0]
			if call.SourceID != credentials.Source.ID || call.Tool != "exec_command" || call.Outcome != "unknown" {
				t.Fatalf("incorrect projection: %+v", call)
			}
			detail, err := store.Call(ctx, call.ID)
			if err != nil {
				t.Fatal(err)
			}
			if len(detail.Native.Events) != 2 || !bytes.Contains(detail.Output, []byte("synthetic-result")) {
				t.Fatalf("native evidence lost: %+v", detail)
			}
			return
		}
	}
}
