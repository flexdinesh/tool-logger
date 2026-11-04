package native

import (
	"encoding/json"
	"fmt"
	"image/png"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/egoist/mygo/ui"
	"tool-logger/desktop/internal/apiclient"
	"tool-logger/desktop/internal/domain"
)

type testAPI struct {
	mu             sync.Mutex
	queries        []url.Values
	calls          []domain.CallSummary
	details        map[string]domain.CallDetail
	detailErrors   map[string]bool
	activityError  bool
	discoveryError bool
	delay          map[string]chan struct{}
	started        chan string
	detailRequests int
	sources        []domain.Source
	tokens         int
}

func syntheticCall(id, harness string) domain.CallSummary {
	session, agent, repo, dir := "session-"+id, "agent-"+id, "/repo", "/repo/sub"
	return domain.CallSummary{ID: id, SourceID: "source-1", Harness: harness, Tool: "exec_command", ObservedAt: "2026-11-04T10:00:00Z", Lifecycle: "completed", Outcome: "unknown", SessionID: &session, AgentID: &agent, Repository: &repo, Directory: &dir, InputSummary: "echo synthetic " + id}
}

func newTestAPI() *testAPI {
	a, b := syntheticCall("a", "codex"), syntheticCall("b", "opencode")
	details := map[string]domain.CallDetail{}
	for _, v := range []domain.CallSummary{a, b} {
		details[v.ID] = domain.CallDetail{Summary: v, Input: json.RawMessage(`{"command":"echo  synthetic\n<raw>&"}`), Output: json.RawMessage(`{"text":"result ` + v.ID + `"}`), Native: domain.NativeDetail{Events: []json.RawMessage{json.RawMessage(`{"logged_at":"2026-11-04T10:00:00Z","metadata":{"git":{"branch":"main","dirty":false}}}`), json.RawMessage(`{"metadata":{"git":{"branch":"feature/native","dirty":true,"status_porcelain_v2":"1 .M synthetic"}}}`)}}}
	}
	return &testAPI{calls: []domain.CallSummary{a, b}, details: details, detailErrors: map[string]bool{}, delay: map[string]chan struct{}{}, started: make(chan string, 100), sources: []domain.Source{{ID: "source-1", Name: "Synthetic workstation", Status: "healthy", Labels: map[string]string{"test": "synthetic"}}}}
}

func (a *testAPI) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/healthz" && r.Header.Get("Authorization") != "Bearer synthetic-admin" {
		w.WriteHeader(401)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	a.mu.Lock()
	if strings.HasPrefix(r.URL.Path, "/api/v1/tool-calls/") {
		id := strings.TrimPrefix(r.URL.Path, "/api/v1/tool-calls/")
		detail := a.details[id]
		fail := a.detailErrors[id]
		wait := a.delay[id]
		a.detailRequests++
		a.mu.Unlock()
		a.started <- id
		if wait != nil {
			select {
			case <-wait:
			case <-r.Context().Done():
				return
			}
		}
		if fail {
			w.WriteHeader(503)
			_, _ = w.Write([]byte(`{"title":"Synthetic detail failure","status":503}`))
			return
		}
		_ = json.NewEncoder(w).Encode(detail)
		return
	}
	defer a.mu.Unlock()
	switch r.URL.Path {
	case "/healthz":
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	case "/api/v1/harnesses":
		if a.discoveryError {
			w.WriteHeader(503)
			_, _ = w.Write([]byte(`{"title":"Discovery unavailable"}`))
			return
		}
		_ = json.NewEncoder(w).Encode(domain.HarnessList{Data: []domain.Harness{{ID: "codex", Label: "Codex"}, {ID: "opencode", Label: "OpenCode"}}})
	case "/api/v1/sources":
		if r.Method == "POST" {
			var v domain.SourceRequest
			_ = json.NewDecoder(r.Body).Decode(&v)
			s := domain.Source{ID: "created-source", Name: v.Name, Hostname: v.Hostname, Platform: v.Platform, Labels: v.Labels}
			a.sources = append(a.sources, s)
			a.tokens++
			w.WriteHeader(201)
			_ = json.NewEncoder(w).Encode(domain.SourceCredentials{Source: s, Token: fmt.Sprintf("synthetic-token-%d", a.tokens)})
			return
		}
		_ = json.NewEncoder(w).Encode(domain.SourceList{Data: a.sources})
	case "/api/v1/sources/created-source/rotate-token":
		a.tokens++
		_ = json.NewEncoder(w).Encode(domain.SourceCredentials{Source: a.sources[len(a.sources)-1], Token: fmt.Sprintf("synthetic-token-%d", a.tokens)})
	case "/api/v1/sources/created-source/token":
		w.WriteHeader(204)
	case "/api/v1/sources/created-source":
		var v domain.SourceRequest
		_ = json.NewDecoder(r.Body).Decode(&v)
		s := a.sources[len(a.sources)-1]
		s.Name = v.Name
		s.Labels = v.Labels
		a.sources[len(a.sources)-1] = s
		_ = json.NewEncoder(w).Encode(s)
	case "/api/v1/tool-calls":
		a.queries = append(a.queries, r.URL.Query())
		if a.activityError {
			w.WriteHeader(503)
			_, _ = w.Write([]byte(`{"title":"Synthetic activity failure","status":503}`))
			return
		}
		rows := []domain.CallSummary{}
		for _, v := range a.calls {
			q := r.URL.Query()
			if h := q.Get("harness"); h != "" && h != v.Harness {
				continue
			}
			if q.Get("q") == "absent" {
				continue
			}
			if since := q.Get("since"); since != "" && v.ObservedAt < since {
				continue
			}
			if until := q.Get("until"); until != "" && v.ObservedAt > until {
				continue
			}
			if status := q.Get("lifecycle"); status != "" && status != v.Lifecycle {
				continue
			}
			rows = append(rows, v)
		}
		page := domain.Page{}
		if r.URL.Query().Get("cursor") == "older" {
			rows = []domain.CallSummary{syntheticCall("c", "codex"), syntheticCall("b", "opencode")}
		} else {
			cursor := "older"
			page = domain.Page{HasMore: true, NextCursor: &cursor}
		}
		_ = json.NewEncoder(w).Encode(domain.CallPage{Data: rows, Page: page})
	case "/api/v1/tool-call-metrics":
		_ = json.NewEncoder(w).Encode(domain.Metrics{Data: domain.MetricData{TotalCalls: int64(len(a.calls)), CompletedCalls: int64(len(a.calls)), UnknownCalls: int64(len(a.calls)), Activity: []domain.ActivityBucket{{Start: "2026-11-04T10:00:00Z", Count: 2, Harnesses: map[string]int64{"codex": 1, "opencode": 1}}}, ToolUsage: []domain.ToolUsage{{Tool: "exec_command", Count: 2}}}})
	case "/api/v1/tool-call-facets":
		_ = json.NewEncoder(w).Encode(domain.Facets{Data: domain.FacetData{Tools: []domain.FacetBucket{{Value: "exec_command", Count: 2}}, Lifecycles: []domain.FacetBucket{{Value: "awaiting", Count: 1}, {Value: "completed", Count: 2}}}})
	default:
		http.NotFound(w, r)
	}
}

type viewHarness struct {
	m       *model
	tt      *ui.Tester
	updates chan func()
	api     *testAPI
}

func startView(t *testing.T) *viewHarness {
	t.Helper()
	a := newTestAPI()
	server := httptest.NewServer(a)
	t.Cleanup(server.Close)
	c, err := apiclient.New(server.URL, "synthetic-admin")
	if err != nil {
		t.Fatal(err)
	}
	m := newModel(c, server.URL, preferences{})
	t.Cleanup(m.stop)
	updates := make(chan func(), 100)
	m.update = func(fn func()) {
		select {
		case updates <- fn:
		case <-m.closed.Done():
		}
	}
	h := &viewHarness{m: m, tt: ui.NewTester(m.view, 1440, 960), updates: updates, api: a}
	m.refresh(false)
	h.until(t, func() bool { return m.loaded })
	return h
}

func (h *viewHarness) until(t *testing.T, done func() bool) {
	t.Helper()
	timeout := time.NewTimer(4 * time.Second)
	defer timeout.Stop()
	for !done() {
		select {
		case fn := <-h.updates:
			fn()
			h.tt.Frame()
		case <-timeout.C:
			t.Fatalf("UI did not settle: loading=%v error=%s detail=%s texts=%q", h.m.loading, h.m.activityError, h.m.detailError, h.tt.Texts())
		}
	}
	h.tt.Frame()
}
func (h *viewHarness) click(t *testing.T, label string) {
	t.Helper()
	if err := h.tt.Click(label); err != nil {
		t.Fatalf("click %s: %v; texts=%q", label, err, h.tt.Texts())
	}
}

func TestNativeCollectionInspectorAndCopy(t *testing.T) {
	h := startView(t)
	if !h.tt.HasText("Codex") || !h.tt.HasText("OpenCode") || !h.tt.HasText("2 calls") {
		t.Fatalf("missing combined collection: %q", h.tt.Texts())
	}
	h.api.mu.Lock()
	n := h.api.detailRequests
	h.api.mu.Unlock()
	if n != 0 {
		t.Fatal("details fetched before selection")
	}
	h.click(t, "echo synthetic a")
	h.until(t, func() bool { return h.m.detail != nil })
	if h.m.detail.Summary.ID != "a" {
		t.Fatal("wrong selected call")
	}
	h.click(t, "Copy JSON")
	if !strings.Contains(h.tt.Clipboard(), `echo  synthetic\n<raw>&`) {
		t.Fatalf("input text lost: %q", h.tt.Clipboard())
	}
	h.click(t, "Result")
	h.click(t, "Input")
	h.tt.Key(0, ui.KeyRight)
	if h.m.prefs.Tab != "Result" {
		t.Fatal("tab arrow navigation failed")
	}
	h.click(t, "Copy JSON")
	if !strings.Contains(h.tt.Clipboard(), "result a") {
		t.Fatal("result tab")
	}
	h.click(t, "Native")
	h.click(t, "Copy JSON")
	if !strings.Contains(h.tt.Clipboard(), "feature/native") {
		t.Fatal("native events missing")
	}
	h.click(t, "Raw events")
	h.click(t, "Copy JSON")
	var rawEvents []json.RawMessage
	if err := json.Unmarshal([]byte(h.tt.Clipboard()), &rawEvents); err != nil || len(rawEvents) != 2 {
		t.Fatal("raw-events tab must copy the original event array")
	}
	h.click(t, "Git")
	if !h.tt.HasText("First event") || !h.tt.HasText("Last event") {
		t.Fatal("git snapshots missing")
	}
	h.click(t, "Metadata")
	if !h.tt.HasText("session-a") {
		t.Fatal("metadata absent")
	}
	h.click(t, "echo synthetic b")
	h.until(t, func() bool { return h.m.detail != nil && h.m.detail.Summary.ID == "b" })
	h.tt.Key(0, ui.KeyEscape)
	if h.m.prefs.Selected != "" {
		t.Fatal("Escape did not close inspector")
	}
	h.tt.Key(ui.Cmd, ui.KeyF)
	if !h.tt.Focused("Search calls") {
		t.Fatal("search shortcut did not focus")
	}
	h.click(t, "echo synthetic a")
	h.until(t, func() bool { return h.m.detail != nil })
	h.tt.Key(0, ui.KeyEnter)
	if !h.tt.Focused("Close") {
		t.Fatal("Enter did not focus inspector close action")
	}
	h.tt.Key(0, ui.KeyEscape)
	h.tt.Key(0, ui.KeySlash)
	if !h.tt.Focused("Search calls") {
		t.Fatal("slash did not focus search")
	}
	if dir := os.Getenv("NATIVE_SNAPSHOTS"); dir != "" {
		h.click(t, "echo synthetic a")
		h.until(t, func() bool { return h.m.detail != nil && h.m.detail.Summary.ID == "a" })
		h.m.prefs.Tab = "Input"
		h.tt.Frame()
		saveView(t, h, dir, "graphite-light.png")
		h.m.prefs.Theme = "Dark"
		h.tt.Frame()
		saveView(t, h, dir, "graphite-dark.png")
		h.tt.SetSize(1000, 720)
		saveView(t, h, dir, "graphite-compact.png")
		h.tt.SetSize(1440, 960)
		h.click(t, "Filters")
		saveView(t, h, dir, "graphite-filters.png")
		h.m.editSource(domain.Source{})
		h.tt.Frame()
		saveView(t, h, dir, "graphite-source-setup.png")
	}
}

func saveView(t *testing.T, h *viewHarness, dir, name string) {
	t.Helper()
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	f, err := os.Create(filepath.Join(dir, name))
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if err := png.Encode(f, h.tt.Image()); err != nil {
		t.Fatal(err)
	}
}

func TestNativeFiltersHistoryPagingAndPause(t *testing.T) {
	h := startView(t)
	h.click(t, "Pause")
	if !h.m.prefs.Paused {
		t.Fatal("pause")
	}
	h.click(t, "All harnesses")
	if h.m.loading {
		t.Fatal("same scope must not replace paused rows")
	}
	h.click(t, "Load more")
	h.until(t, func() bool { return !h.m.loading })
	if len(h.m.rows) != 3 || h.m.rows[2].ID != "c" {
		t.Fatalf("cursor dedupe: %+v", h.m.rows)
	}
	h.click(t, "Codex")
	h.until(t, func() bool { return !h.m.loading })
	if h.m.prefs.Query.Get("harness") != "codex" {
		t.Fatal("harness scope")
	}
	h.click(t, "Back")
	h.until(t, func() bool { return !h.m.loading })
	if h.m.prefs.Query.Get("harness") != "" {
		t.Fatal("back did not restore")
	}
	h.click(t, "Forward")
	h.until(t, func() bool { return !h.m.loading })
	h.click(t, "Search calls")
	h.tt.Type("absent")
	h.until(t, func() bool { return !h.m.loading })
	if !h.tt.HasText("No calls match these filters") {
		t.Fatalf("filtered empty state: %q", h.tt.Texts())
	}
	h.click(t, "Reset")
	h.until(t, func() bool { return !h.m.loading })
	if h.m.prefs.Query.Encode() != "" {
		t.Fatal("reset")
	}
	h.click(t, "Resume")
	h.until(t, func() bool { return !h.m.loading })
	if h.m.prefs.Paused {
		t.Fatal("resume")
	}
}

func TestDetailErrorsRetryAndStaleSelection(t *testing.T) {
	h := startView(t)
	h.api.mu.Lock()
	h.api.detailErrors["a"] = true
	h.api.mu.Unlock()
	h.click(t, "echo synthetic a")
	h.until(t, func() bool { return h.m.detailError != "" })
	h.m.refresh(false)
	h.until(t, func() bool { return !h.m.loading })
	if h.m.detailError == "" {
		t.Fatal("healthy poll cleared detail error")
	}
	h.api.mu.Lock()
	h.api.detailErrors["a"] = false
	h.api.mu.Unlock()
	h.click(t, "Retry details")
	h.until(t, func() bool { return h.m.detail != nil })
	gate := make(chan struct{})
	h.api.mu.Lock()
	h.api.delay["a"] = gate
	h.api.mu.Unlock()
	h.m.selectCall("a", true)
	h.click(t, "echo synthetic b")
	h.until(t, func() bool { return h.m.detail != nil && h.m.detail.Summary.ID == "b" })
	close(gate)
	if h.m.prefs.Selected != "b" || h.m.detail.Summary.ID != "b" {
		t.Fatal("late selection overwrote detail")
	}
}

func TestPausedActivityRetryKeepsDetailPending(t *testing.T) {
	h := startView(t)
	h.click(t, "Pause")
	gate := make(chan struct{})
	h.api.mu.Lock()
	h.api.delay["a"] = gate
	h.api.activityError = true
	h.api.mu.Unlock()
	h.click(t, "echo synthetic a")
	h.m.refresh(false)
	h.until(t, func() bool { return h.m.activityError != "" })
	if !h.m.detailLoading {
		t.Fatal("activity failure canceled pending detail")
	}
	h.api.mu.Lock()
	h.api.activityError = false
	h.api.mu.Unlock()
	h.click(t, "Retry activity")
	h.until(t, func() bool { return !h.m.loading })
	if !h.m.prefs.Paused {
		t.Fatal("retry resumed live")
	}
	close(gate)
	h.until(t, func() bool { return h.m.detail != nil })
}

func TestSourceSetupUsesHTTPAndCopiesConfiguration(t *testing.T) {
	h := startView(t)
	h.click(t, "Add source")
	h.click(t, "Source name")
	h.tt.Type("Synthetic container")
	h.click(t, "Create source")
	h.until(t, func() bool { return !h.m.setupBusy && h.m.credentials != nil })
	h.click(t, "Copy configuration")
	var config struct{ SourceID, Token, Endpoint string }
	if err := json.Unmarshal([]byte(h.tt.Clipboard()), &config); err != nil {
		t.Fatal(err)
	}
	if config.SourceID != "created-source" || config.Token != "synthetic-token-1" || config.Endpoint != h.m.endpoint {
		t.Fatalf("config %+v", config)
	}
	h.click(t, "Source name")
	h.tt.Key(ui.Cmd, ui.KeyA)
	h.tt.Type("Renamed synthetic source")
	h.click(t, "Save source")
	h.until(t, func() bool { return !h.m.setupBusy })
	if h.m.credentials.Source.Name != "Renamed synthetic source" {
		t.Fatal("configuration retained source name from before edit")
	}
	h.click(t, "Rotate token")
	h.until(t, func() bool { return !h.m.setupBusy })
	if h.m.credentials.Token != "synthetic-token-2" {
		t.Fatal("rotation not applied")
	}
	h.click(t, "Revoke token…")
	h.click(t, "Confirm revoke")
	h.until(t, func() bool { return !h.m.setupBusy })
	if h.m.credentials != nil || !strings.Contains(h.m.setupMessage, "revoked") {
		t.Fatal("revoke must clear token")
	}
	h.click(t, "Connection diagnostics")
	h.until(t, func() bool { return !h.m.setupBusy })
	if !strings.Contains(h.m.setupMessage, "accepted") {
		t.Fatal(h.m.setupMessage)
	}
}

func TestFilterAndWindowPreferencesDeepLinks(t *testing.T) {
	m := newModel(nil, "http://localhost:4317", preferences{})
	defer m.stop()
	raw := "tool-logger://activity?source=one&source=two&harness=codex&tool=a&tool=b&session=s&agent=g&repository=%2Frepo&directory=%2Frepo%2Fsub&lifecycle=awaiting&outcome=unknown&q=a%26b&since=2026-11-04T00%3A00%3A00Z&until=2026-11-04T01%3A00%3A00Z&call=selected"
	if err := m.openLink(raw); err != nil {
		t.Fatal(err)
	}
	q := m.query(time.Now())
	for _, key := range []string{"source", "harness", "tool", "session", "agent", "repository", "directory", "lifecycle", "outcome", "q", "since", "until"} {
		if len(q[key]) == 0 {
			t.Fatalf("lost %s", key)
		}
	}
	if len(q["source"]) != 2 || len(q["tool"]) != 2 {
		t.Fatal("multi filters lost")
	}
	m.prefs.Theme = "Dark"
	m.prefs.Sidebar = 234
	m.prefs.Collection = 57
	m.prefs.Paused = true
	path := filepath.Join(t.TempDir(), "state", "native.json")
	if err := writePreferences(path, m.prefs); err != nil {
		t.Fatal(err)
	}
	p := loadPreferences(path)
	if p.Query.Encode() != m.prefs.Query.Encode() || p.Theme != "Dark" || p.Sidebar != 234 || p.Collection != 57 || !p.Paused {
		t.Fatalf("state round trip %+v", p)
	}
	clone := newModel(nil, "http://localhost:4317", preferences{})
	defer clone.stop()
	if err := clone.openLink(m.deepLink()); err != nil {
		t.Fatal(err)
	}
	if clone.prefs.Query.Encode() != m.prefs.Query.Encode() || clone.prefs.Selected != "selected" {
		t.Fatal("link round trip")
	}
	if err := m.openLink("tool-logger://activity?harness=invalid"); err != nil || len(m.prefs.Query["harness"]) != 0 {
		t.Fatal("invalid harness did not fall back")
	}
}

func TestAllTimeClearsCustomBoundsAndHistoryRestoresThem(t *testing.T) {
	h := startView(t)
	h.m.setFilter("since", []string{"2026-11-04T00:00:00Z"})
	h.m.setFilter("until", []string{"2026-11-05T00:00:00Z"})
	h.until(t, func() bool { return !h.m.loading })
	if h.m.prefs.TimeRange != "Custom" {
		t.Fatal("explicit bounds must select custom time")
	}
	h.m.setTimeRange("All time")
	h.until(t, func() bool { return !h.m.loading })
	h.api.mu.Lock()
	q := h.api.queries[len(h.api.queries)-1]
	h.api.mu.Unlock()
	if q.Has("since") || q.Has("until") || h.m.filterDraft["since"] != "" || h.m.filterDraft["until"] != "" {
		t.Fatalf("all-time scope retained custom bounds: %v", q)
	}
	h.m.back(-1)
	h.until(t, func() bool { return !h.m.loading })
	if h.m.prefs.TimeRange != "Custom" || h.m.query(time.Now()).Get("until") == "" {
		t.Fatal("back navigation lost custom window")
	}
}

func TestLiveFilterRetainsInspectorWhenRowLeavesScope(t *testing.T) {
	h := startView(t)
	h.api.mu.Lock()
	h.api.calls[0].Lifecycle = "awaiting"
	detail := h.api.details["a"]
	detail.Summary.Lifecycle = "awaiting"
	h.api.details["a"] = detail
	h.api.mu.Unlock()
	h.m.setFilter("lifecycle", []string{"awaiting"})
	h.until(t, func() bool { return !h.m.loading })
	h.click(t, "echo synthetic a")
	h.until(t, func() bool { return h.m.detail != nil })
	h.api.mu.Lock()
	h.api.calls[0].Lifecycle = "finished"
	detail = h.api.details["a"]
	detail.Summary.Lifecycle = "finished"
	h.api.details["a"] = detail
	h.api.mu.Unlock()
	h.m.refresh(false)
	h.until(t, func() bool { return !h.m.loading && !h.m.detailLoading })
	if len(h.m.rows) != 0 || h.m.prefs.Selected != "a" || h.m.detail.Summary.Lifecycle != "finished" {
		t.Fatal("live filter must remove row and keep selected detail current")
	}
}

func TestStableRowsSelectionAndPauseFreeze(t *testing.T) {
	h := startView(t)
	h.click(t, "echo synthetic a")
	h.until(t, func() bool { return h.m.detail != nil })
	h.click(t, "Pause")
	h.api.mu.Lock()
	h.api.calls = append([]domain.CallSummary{syntheticCall("new", "codex")}, h.api.calls...)
	h.api.mu.Unlock()
	if len(h.m.rows) != 2 || h.m.metrics.TotalCalls != 2 {
		t.Fatal("pause mutated collection")
	}
	h.click(t, "Resume")
	h.until(t, func() bool { return !h.m.loading && !h.m.detailLoading })
	if len(h.m.rows) != 3 || h.m.selectedRow != 1 || h.m.prefs.Selected != "a" || h.m.detail.Summary.ID != "a" {
		t.Fatal("live prepend moved selection to another call")
	}
}

func TestDiscoveryRetryAndOnboarding(t *testing.T) {
	h := startView(t)
	h.api.mu.Lock()
	h.api.discoveryError = true
	h.api.mu.Unlock()
	h.m.refresh(false)
	h.until(t, func() bool { return !h.m.loading })
	if !h.tt.HasText("Activity unavailable") {
		t.Fatal("discovery error not visible")
	}
	h.api.mu.Lock()
	h.api.discoveryError = false
	h.api.sources = nil
	h.api.calls = nil
	h.api.mu.Unlock()
	h.click(t, "Retry activity")
	h.until(t, func() bool { return !h.m.loading })
	if !h.tt.HasText("Connect your first source") {
		t.Fatal("first-run source setup missing")
	}
	h.click(t, "Set up source")
	if !h.m.showSetup {
		t.Fatal("onboarding action did not open source setup")
	}
}

func TestFilterWidgetsSendEveryFilterAndKeepMissingFacet(t *testing.T) {
	h := startView(t)
	h.click(t, "Filters")
	for _, f := range []struct{ label, key, value string }{{"Lifecycle filter", "lifecycle", "completed"}, {"Outcome filter", "outcome", "unknown"}, {"Tool filter", "tool", "shell; read_file"}, {"Session filter", "session", "session-a"}, {"Agent filter", "agent", "agent-a"}, {"Repository filter", "repository", "/repo"}, {"Directory filter", "directory", "/repo/sub"}, {"Since (RFC3339) filter", "since", "2026-11-04T00:00:00Z"}, {"Until (RFC3339) filter", "until", "2026-11-05T00:00:00Z"}} {
		// Every filter is present, including values absent from current facets.
		if _, ok := h.tt.Find(f.label); !ok {
			t.Fatalf("missing %s", f.label)
		}
		h.click(t, f.label)
		h.tt.Key(ui.Cmd, ui.KeyA)
		h.tt.Type(f.value)
		h.until(t, func() bool { return !h.m.loading })
	}
	h.api.mu.Lock()
	q := h.api.queries[len(h.api.queries)-1]
	h.api.mu.Unlock()
	for _, key := range []string{"lifecycle", "outcome", "tool", "session", "agent", "repository", "directory", "since", "until"} {
		if len(q[key]) == 0 {
			t.Errorf("missing HTTP filter %s", key)
		}
	}
	if len(q["tool"]) != 2 || h.m.prefs.Query.Get("agent") != "agent-a" {
		t.Fatal("multi-value filter or missing facet selection lost")
	}
	// Exercise text editing itself, including a separator typed before its value.
	h.click(t, "Tool filter")
	h.tt.Key(ui.Cmd, ui.KeyA)
	h.tt.Type("shell;")
	h.tt.Type(" read_file")
	h.until(t, func() bool { return !h.m.loading })
	if strings.Join(h.m.prefs.Query["tool"], ",") != "shell,read_file" {
		t.Fatalf("multi input %+v", h.m.prefs.Query["tool"])
	}
	h.click(t, "Directory filter")
	h.tt.Key(ui.Cmd, ui.KeyA)
	h.tt.TypeKey(0, ui.KeySlash, "/")
	if !h.tt.Focused("Directory filter") {
		t.Fatal("slash shortcut stole focus from editable directory")
	}
}

func TestThemeSystemPreferenceAndVirtualization(t *testing.T) {
	m := newModel(nil, "http://localhost:4317", preferences{})
	defer m.stop()
	m.loaded = true
	m.rows = make([]domain.CallSummary, 100000)
	for i := range m.rows {
		m.rows[i] = syntheticCall(fmt.Sprint(i), "codex")
	}
	tt := ui.NewTester(m.view, 1440, 900)
	if len(tt.Texts()) > 500 {
		t.Fatalf("virtual table built too many rows: %d", len(tt.Texts()))
	}
	assertBackground := func(want ui.Color) {
		t.Helper()
		// Sample empty canvas padding. Table pixels can hit text, whose glyph
		// positions vary with platform fonts and do not establish the theme.
		got := tt.Image().RGBAAt(0, 0)
		if got.R != want.R || got.G != want.G || got.B != want.B || got.A != want.A {
			t.Fatalf("appearance %s: canvas %v, want %v", m.prefs.Theme, got, want)
		}
	}
	dark, light := ui.Hex("#17191d"), ui.Hex("#f5f6f7")
	tt.SetDark(true)
	assertBackground(dark)
	tt.SetDark(false)
	assertBackground(light)
	m.prefs.Theme = "Light"
	tt.Frame()
	tt.SetDark(true)
	assertBackground(light)
	m.prefs.Theme = "Dark"
	tt.Frame()
	tt.SetDark(false)
	assertBackground(dark)
	m.prefs.Theme = "System"
	tt.Frame()
	assertBackground(light)
	if err := tt.Click("echo synthetic 0"); err != nil {
		t.Fatal(err)
	}
	tt.Key(0, ui.KeyEnd)
	if m.selectedRow != 99999 || m.prefs.Selected != "99999" {
		t.Fatal("keyboard End did not reach last virtual row")
	}
}

func TestNativeSplitterKeyboardAndPreferenceSnapshotIsolation(t *testing.T) {
	h := startView(t)
	r, ok := h.tt.Find("Divider")
	if !ok {
		t.Fatal("missing accessible splitter")
	}
	before := h.m.prefs.Sidebar
	h.tt.ClickAt(r.X+r.W/2, r.Y+r.H/2)
	h.tt.Key(0, ui.KeyRight)
	if h.m.prefs.Sidebar <= before {
		t.Fatal("splitter arrow key did not resize sidebar")
	}
	p := preferences{Query: url.Values{"tool": {"shell"}}, Columns: ui.TableLayout{Order: []string{"Tool"}, Widths: map[string]float32{"Tool": 150}}}
	copy := clonePreferences(p)
	p.Query["tool"][0] = "changed"
	p.Columns.Order[0] = "changed"
	p.Columns.Widths["Tool"] = 999
	if copy.Query.Get("tool") != "shell" || copy.Columns.Order[0] != "Tool" || copy.Columns.Widths["Tool"] != 150 {
		t.Fatal("persistence snapshot shares mutable UI memory")
	}
}

func TestTimePagingFreezesWindowAndLiveRefreshExpiresRows(t *testing.T) {
	h := startView(t)
	now := time.Date(2026, 11, 4, 10, 10, 0, 0, time.UTC)
	h.m.now = func() time.Time { return now }
	p := clonePreferences(h.m.prefs)
	p.TimeRange = "15 minutes"
	h.m.navigate(p, true)
	h.until(t, func() bool { return !h.m.loading })
	initialSince := h.m.lastQuery.Get("since")
	initialUntil := h.m.lastQuery.Get("until")
	now = now.Add(2 * time.Minute)
	h.click(t, "Load more")
	h.until(t, func() bool { return !h.m.loading })
	h.api.mu.Lock()
	last := h.api.queries[len(h.api.queries)-1]
	h.api.mu.Unlock()
	if last.Get("cursor") != "older" || last.Get("since") != initialSince || last.Get("until") != initialUntil {
		t.Fatal("paging changed cursor-bound time window")
	}
	now = now.Add(20 * time.Minute)
	h.m.pages = 1
	h.m.refresh(false)
	h.until(t, func() bool { return !h.m.loading })
	if len(h.m.rows) != 0 || h.m.lastQuery.Get("since") == initialSince {
		t.Fatal("live relative window did not expire calls")
	}
}
