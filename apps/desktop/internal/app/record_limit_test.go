package app

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"tool-logger/desktop/internal/domain"
	"tool-logger/desktop/internal/httpapi"
	"tool-logger/desktop/internal/sqlite"
)

func TestMaximumSupportedJournalRecordSurvivesRealEncoderAndHTTPFraming(t *testing.T) {
	const maxRecord = 8 << 20
	store, err := sqlite.Open(filepath.Join(t.TempDir(), "events.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	server := httptest.NewServer(httpapi.New(store, "synthetic-admin"))
	defer server.Close()
	credentials, err := store.CreateSource(context.Background(), domain.SourceRequest{Name: "Maximum record"})
	if err != nil {
		t.Fatal(err)
	}
	id := "550e8400-e29b-41d4-a716-446655440012"
	stamp := "2026-11-04T10:00:00Z"
	native := map[string]interface{}{"schema_version": 2, "event_id": id, "logged_at": stamp, "harness": "codex", "hook": "PreToolUse", "metadata": map[string]interface{}{}, "event": map[string]interface{}{"hook_event_name": "PreToolUse", "tool_name": "shell", "tool_use_id": "limit-call", "tool_input": map[string]string{"data": ""}}}
	base, _ := json.Marshal(native)
	native["event"] = map[string]interface{}{"hook_event_name": "PreToolUse", "tool_name": "shell", "tool_use_id": "limit-call", "tool_input": map[string]string{"data": strings.Repeat("x", maxRecord-len(base))}}
	record, _ := json.Marshal(native)
	if len(record) != maxRecord {
		t.Fatalf("fixture has %d bytes", len(record))
	}
	root, err := filepath.Abs("../../../..")
	if err != nil {
		t.Fatal(err)
	}
	// Exercise the actual installed TypeScript encoder, not a second Go envelope.
	command := exec.Command("node", "--input-type=module", "-e", `import { readFileSync } from 'node:fs'; import { envelope } from './plugins/codex-tool-logger/transport/journal.ts'; process.stdout.write(JSON.stringify({events:[envelope(readFileSync(0),process.argv[1],'codex')]}));`, credentials.Source.ID)
	command.Dir = root
	command.Stdin = bytes.NewReader(record)
	body, err := command.Output()
	if err != nil {
		t.Fatal(err)
	}
	if len(body) <= maxRecord {
		t.Fatal("fixture did not exercise envelope overhead")
	}
	request, _ := http.NewRequest("POST", server.URL+"/api/v1/ingest/events", bytes.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer "+credentials.Token)
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		t.Fatalf("supported maximum record rejected after wrapping: %d", response.StatusCode)
	}
	var ack domain.Acknowledgement
	if err := json.NewDecoder(response.Body).Decode(&ack); err != nil {
		t.Fatal(err)
	}
	if len(ack.Accepted) != 1 || ack.Accepted[0] != id {
		t.Fatal("record was not durably acknowledged")
	}
}
