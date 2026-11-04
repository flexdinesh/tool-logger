package native

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/egoist/mygo/ui"
	"tool-logger/desktop/internal/apiclient"
	"tool-logger/desktop/internal/domain"
	"tool-logger/desktop/internal/httpapi"
	"tool-logger/desktop/internal/sqlite"
)

// This integration uses the production HTTP handler and durable store. The UI
// and client observe and administer everything through HTTP, including setup.
func TestNativeProductionRESTBoundary(t *testing.T) {
	store, err := sqlite.Open(filepath.Join(t.TempDir(), "history.sqlite"))
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
	m := newModel(client, server.URL, preferences{})
	defer m.stop()
	updates := make(chan func(), 100)
	m.update = func(fn func()) {
		select {
		case updates <- fn:
		case <-m.closed.Done():
		}
	}
	h := &viewHarness{m: m, tt: ui.NewTester(m.view, 1440, 960), updates: updates}
	m.refresh(false)
	h.until(t, func() bool { return m.loaded })
	h.click(t, "Set up source")
	h.click(t, "Source name")
	h.tt.Type("Synthetic integration workstation")
	h.click(t, "Create source")
	h.until(t, func() bool { return m.credentials != nil && !m.setupBusy })
	credentials := *m.credentials
	h.click(t, "Close setup")
	stamp := time.Now().Add(-time.Minute).UTC()
	events := []domain.Event{}
	for i, hook := range []string{"PreToolUse", "PostToolUse"} {
		id := []string{"7a1f2a55-d131-45db-a40c-9996e51a1a91", "7a1f2a55-d131-45db-a40c-9996e51a1a92"}[i]
		recorded := stamp.Add(time.Duration(i) * 100 * time.Millisecond).Format(time.RFC3339Nano)
		native := map[string]interface{}{"schema_version": 2, "event_id": id, "logged_at": recorded, "harness": "codex", "hook": hook, "event": map[string]interface{}{"hook_event_name": hook, "tool_name": "shell", "tool_use_id": "synthetic-call", "session_id": "synthetic-session", "turn_id": "synthetic-turn", "tool_input": map[string]string{"command": "echo native integration"}, "tool_response": map[string]interface{}{"output": "synthetic result <raw>&", "exit_code": 0}}, "metadata": map[string]interface{}{"session_cwd": "/synthetic/repo", "git": map[string]interface{}{"root": "/synthetic/repo", "branch": "main", "dirty": i > 0}}}
		raw, _ := json.Marshal(native)
		events = append(events, domain.Event{SchemaVersion: 1, EventID: id, SourceID: credentials.Source.ID, Harness: "codex", RecordedAt: recorded, Native: raw})
	}
	data, _ := json.Marshal(domain.IngestRequest{Events: events})
	req, _ := http.NewRequest("POST", server.URL+"/api/v1/ingest/events", bytes.NewReader(data))
	req.Header.Set("Authorization", "Bearer "+credentials.Token)
	req.Header.Set("Content-Type", "application/json")
	response, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		t.Fatalf("ingest status %d", response.StatusCode)
	}
	m.invalidateCollection()
	m.refresh(false)
	h.until(t, func() bool { return !m.loading && len(m.rows) == 1 })
	if m.metrics.TotalCalls != 1 || m.rows[0].Outcome != "unknown" {
		t.Fatalf("native outcome semantics: %+v %+v", m.rows, m.metrics)
	}
	h.click(t, "echo native integration")
	h.until(t, func() bool { return m.detail != nil })
	if len(m.detail.Native.Events) != 2 {
		t.Fatal("complete native events did not reach inspector")
	}
	h.click(t, "Result")
	h.click(t, "Copy JSON")
	if !strings.Contains(h.tt.Clipboard(), "synthetic result <raw>&") {
		t.Fatalf("raw result copy %q", h.tt.Clipboard())
	}
	m.setFilter("source", []string{credentials.Source.ID})
	h.until(t, func() bool { return !m.loading })
	if len(m.rows) != 1 {
		t.Fatal("source scope lost call")
	}
	m.setFilter("session", []string{"synthetic-session"})
	h.until(t, func() bool { return !m.loading })
	if len(m.rows) != 1 {
		t.Fatal("session scope lost call")
	}
	page, err := client.Calls(context.Background(), url.Values{"q": {"does not exist"}})
	if err != nil || len(page.Data) != 0 {
		t.Fatalf("real search: %v, %+v", err, page)
	}
	// Creation, rotation and revocation retain source identity and history.
	rotated, err := client.RotateToken(context.Background(), credentials.Source.ID)
	if err != nil {
		t.Fatal(err)
	}
	if rotated.Token == credentials.Token || rotated.Source.ID != credentials.Source.ID {
		t.Fatal("rotation changed source identity")
	}
	if err := client.RevokeToken(context.Background(), credentials.Source.ID); err != nil {
		t.Fatal(err)
	}
	detail, err := client.Detail(context.Background(), m.rows[0].ID)
	if err != nil || len(detail.Native.Events) != 2 {
		t.Fatalf("revoke removed retained history: %v", err)
	}
}
