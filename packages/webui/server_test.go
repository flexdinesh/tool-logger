package webui

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"tool-logger/apps/server"
	"tool-logger/packages/client"
	"tool-logger/packages/protocol"
)

const testAdmin = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"

type fixture struct {
	ui      *Server
	server  *httptest.Server
	backend *testBackend
	admin   *apiclient.Client
}

type testBackend struct {
	URL    string
	client *http.Client
}

func (b *testBackend) Client() *http.Client { return b.client }

func start(t *testing.T) *fixture {
	t.Helper()
	t.Setenv("TOOL_LOGGER_WEB_DEV_URL", "")
	t.Setenv("MYGO_DEV_URL", "")
	// Exercise the collector's public composition API, never its internal HTTP or
	// SQLite packages. This remains a real Unix HTTP/SQLite boundary test.
	// t.TempDir embeds the test name, which exceeds the 104-byte macOS socket path limit.
	state, err := os.MkdirTemp("", "tl-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(state) })
	if err := os.MkdirAll(filepath.Join(state, "collector"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(state, "collector", "admin.token"), []byte(testAdmin+"\n"), 0600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- server.Run(ctx, server.Config{State: state}) }()
	t.Cleanup(func() {
		cancel()
		if err := <-done; err != nil {
			t.Error(err)
		}
	})
	var connection apiclient.Connection
	deadline := time.Now().Add(5 * time.Second)
	for {
		var err error
		connection, err = apiclient.LocalConnection(state)
		if err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("collector did not become ready:", err)
		}
		time.Sleep(10 * time.Millisecond)
	}
	client, err := apiclient.HTTPClient(connection)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(client.CloseIdleConnections)
	admin, err := apiclient.NewConnection(connection)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(admin.Close)
	backend := &testBackend{URL: apiclient.BaseURL(connection), client: client}
	ui, httpServer := startUI(t, backend.URL, client)
	return &fixture{ui: ui, server: httpServer, backend: backend, admin: admin}
}

func newTestUI(endpoint, credential, origin string) (*Server, error) {
	return New(Config{Endpoint: endpoint, Credential: credential, Origin: origin, ServerID: "synthetic-server", HTTPClient: &http.Client{}})
}

func startUI(t *testing.T, endpoint string, clients ...*http.Client) (*Server, *httptest.Server) {
	t.Helper()
	server := httptest.NewUnstartedServer(nil)
	origin := "http://" + server.Listener.Addr().String()
	client := &http.Client{}
	if len(clients) > 0 {
		client = clients[0]
	}
	ui, err := New(Config{Endpoint: endpoint, Credential: testAdmin, Origin: origin, ServerID: "synthetic-server", HTTPClient: client})
	if err != nil {
		server.Close()
		t.Fatal(err)
	}
	server.Config.Handler = ui.Handler()
	server.Start()
	t.Cleanup(server.Close)
	return ui, server
}

func request(t *testing.T, f *fixture, method, route, body string, cookie *http.Cookie, origin string, status int) (*http.Response, []byte) {
	t.Helper()
	r, err := http.NewRequest(method, f.server.URL+route, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	if cookie != nil {
		r.AddCookie(cookie)
	}
	if origin != "" {
		r.Header.Set("Origin", origin)
	}
	if body != "" {
		r.Header.Set("Content-Type", "application/json")
	}
	response, err := f.server.Client().Do(r)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	data, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != status {
		t.Fatalf("%s %s: got %d, want %d: %s", method, route, response.StatusCode, status, data)
	}
	if status >= 400 && response.Header.Get("Cache-Control") != "no-store" {
		t.Fatal("error can be cached")
	}
	return response, data
}

func login(t *testing.T, f *fixture) *http.Cookie {
	t.Helper()
	response, _ := request(t, f, http.MethodPost, "/ui/session", `{"token":"`+testAdmin+`"}`, nil, f.server.URL, 204)
	cookies := response.Cookies()
	if len(cookies) != 1 {
		t.Fatalf("missing cookie: %v", cookies)
	}
	cookie := cookies[0]
	if cookie.Name != f.ui.cookieName || cookie.Value == "" || cookie.Value == testAdmin || cookie.Domain != "" ||
		!cookie.HttpOnly || cookie.SameSite != http.SameSiteStrictMode || cookie.Path != "/" || cookie.MaxAge != 43200 {
		t.Fatalf("unsafe cookie: %#v", cookie)
	}
	return cookie
}

func TestSessionLifecycleAndSourceCredentials(t *testing.T) {
	f := start(t)
	request(t, f, "GET", "/ui/session", "", nil, "", 401)
	request(t, f, "POST", "/ui/session", `{"token":"wrong"}`, nil, f.server.URL, 401)
	source, err := f.admin.CreateSource(context.Background(), domain.SourceRequest{Name: "test", Hostname: "host", Platform: "linux"})
	if err != nil {
		t.Fatal(err)
	}
	request(t, f, "POST", "/ui/session", `{"token":"`+source.Token+`"}`, nil, f.server.URL, 401)
	cookie := login(t, f)
	response, data := request(t, f, "GET", "/ui/session", "", cookie, "", 200)
	var session struct {
		Authenticated     bool   `json:"authenticated"`
		IngestionEndpoint string `json:"ingestionEndpoint"`
	}
	if json.Unmarshal(data, &session) != nil || !session.Authenticated || session.IngestionEndpoint != f.backend.URL || response.Header.Get("Cache-Control") != "no-store" {
		t.Fatal(string(data))
	}
	// A session seeded by Go follows exactly the same browser boundary.
	nativeCookie := f.ui.IssueSession()
	request(t, f, "GET", "/ui/session", "", nativeCookie, "", 200)
	replacement := loginWithCookie(t, f, cookie)
	request(t, f, "GET", "/ui/session", "", cookie, "", 401)
	request(t, f, "GET", "/ui/session", "", replacement, "", 200)
	cleared, _ := request(t, f, "DELETE", "/ui/session", "", replacement, f.server.URL, 204)
	if len(cleared.Cookies()) != 1 || cleared.Cookies()[0].MaxAge != -1 {
		t.Fatal("logout did not clear cookie")
	}
	request(t, f, "GET", "/ui/session", "", replacement, "", 401)
	request(t, f, "DELETE", "/ui/session", "", nil, f.server.URL, 204)
	request(t, f, "GET", "/api/v1/sources", "", replacement, "", 401)
	// A restarted boundary cannot recover old opaque session credentials.
	other, err := newTestUI(f.backend.URL, testAdmin, f.server.URL)
	if err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest("GET", "/ui/session", nil)
	r.Host = f.ui.origin.Host
	r.AddCookie(nativeCookie)
	w := httptest.NewRecorder()
	other.Handler().ServeHTTP(w, r)
	if w.Code != 401 {
		t.Fatal("session survived process boundary")
	}
}

func loginWithCookie(t *testing.T, f *fixture, cookie *http.Cookie) *http.Cookie {
	t.Helper()
	response, _ := request(t, f, "POST", "/ui/session", `{"token":"`+testAdmin+`"}`, cookie, f.server.URL, 204)
	if len(response.Cookies()) != 1 {
		t.Fatal("missing replacement cookie")
	}
	return response.Cookies()[0]
}

func TestSessionExpiryAndCapacity(t *testing.T) {
	f := start(t)
	now := time.Now()
	f.ui.mu.Lock()
	f.ui.now = func() time.Time { return now }
	f.ui.mu.Unlock()
	old := f.ui.IssueSession()
	f.ui.mu.Lock()
	now = now.Add(time.Second)
	f.ui.mu.Unlock()
	for range maxSessions {
		f.ui.IssueSession()
	}
	f.ui.mu.Lock()
	count := len(f.ui.sessions)
	f.ui.mu.Unlock()
	if count != maxSessions {
		t.Fatal("session storage unbounded")
	}
	request(t, f, "GET", "/ui/session", "", old, "", 401)
	current := f.ui.IssueSession()
	request(t, f, "GET", "/ui/session", "", current, "", 200)
	f.ui.mu.Lock()
	now = now.Add(sessionLifetime)
	f.ui.mu.Unlock()
	request(t, f, "GET", "/ui/session", "", current, "", 401)
	f.ui.mu.Lock()
	count = len(f.ui.sessions)
	f.ui.mu.Unlock()
	if count != 0 {
		t.Fatal("expired sessions retained")
	}
}

func TestStrictLoginJSON(t *testing.T) {
	f := start(t)
	for _, body := range []string{`null`, `[]`, `{}`, `{"token":null}`, `{"token":1}`, `{"token":""}`, `{"Token":"x"}`, `{"token":"x","other":true}`, `{"token":"x","token":"y"}`, `{"token":"x"} {}`, `{"token":`} {
		request(t, f, "POST", "/ui/session", body, nil, f.server.URL, 400)
	}
	request(t, f, "POST", "/ui/session", `{"token":"`+strings.Repeat("a", 5000)+`"}`, nil, f.server.URL, 413)
	r := httptest.NewRequest("POST", "/ui/session", strings.NewReader(`{"token":"`+testAdmin+`"}`))
	r.Host = f.ui.origin.Host
	r.Header.Set("Origin", f.server.URL)
	r.Header.Set("Content-Type", "text/plain")
	w := httptest.NewRecorder()
	f.ui.Handler().ServeHTTP(w, r)
	if w.Code != 415 {
		t.Fatal(w.Code)
	}
}

func TestHostOriginAndSessionIsolation(t *testing.T) {
	f := start(t)
	cookie := login(t, f)
	for _, tc := range []struct {
		method, route, host, origin, fetch string
		status                             int
	}{
		{"GET", "/", "attacker.example", "", "", 403},
		{"GET", "/api/v1/sources", "localhost", "", "", 403},
		{"GET", "/", "", "http://attacker.example", "", 403},
		{"GET", "/api/v1/sources", "", "null", "", 403},
		{"GET", "/ui/session", "", "", "cross-site", 200},
		{"DELETE", "/ui/session", "", f.server.URL, "cross-site", 403},
		{"POST", "/ui/session", "", "", "", 403},
		{"DELETE", "/ui/session", "", "", "", 403},
		{"DELETE", "/ui/session", "", "http://attacker.example", "", 403},
		{"POST", "/api/v1/sources", "", "", "", 403},
		{"PATCH", "/api/v1/sources/id", "", "", "", 403},
		{"GET", "/ui/session", "", "", "", 200},
		{"GET", "/ui/session", "", f.server.URL, "same-origin", 200},
	} {
		r := httptest.NewRequest(tc.method, f.server.URL+tc.route, strings.NewReader(`{"token":"`+testAdmin+`"}`))
		r.AddCookie(cookie)
		if tc.host != "" {
			r.Host = tc.host
		}
		if tc.origin != "" {
			r.Header.Set("Origin", tc.origin)
		}
		if tc.fetch != "" {
			r.Header.Set("Sec-Fetch-Site", tc.fetch)
		}
		// Forwarded headers must never repair an invalid Host or Origin.
		r.Header.Set("X-Forwarded-Host", f.ui.origin.Host)
		r.Header.Set("Forwarded", "host="+f.ui.origin.Host)
		w := httptest.NewRecorder()
		// Real servers receive an origin-form request URL, as opposed to the
		// absolute URLs httptest.NewRequest constructs from complete URLs.
		r.URL.Scheme, r.URL.Host = "", ""
		f.ui.Handler().ServeHTTP(w, r)
		if w.Code != tc.status {
			t.Fatalf("%+v: got %d", tc, w.Code)
		}
	}
	r := httptest.NewRequest("GET", "/ui/session", nil)
	r.Host = f.ui.origin.Host
	r.AddCookie(cookie)
	r.AddCookie(cookie)
	w := httptest.NewRecorder()
	f.ui.Handler().ServeHTTP(w, r)
	if w.Code != 401 {
		t.Fatal("ambiguous cookie accepted")
	}
	r = httptest.NewRequest("GET", "/ui/session", nil)
	r.Host = f.ui.origin.Host
	r.AddCookie(cookie)
	r.Header.Add("Origin", f.server.URL)
	r.Header.Add("Origin", f.server.URL)
	w = httptest.NewRecorder()
	f.ui.Handler().ServeHTTP(w, r)
	if w.Code != 403 {
		t.Fatal("ambiguous origin accepted")
	}
	r = httptest.NewRequest("GET", "/ui/session", nil)
	r.Host = f.ui.origin.Host
	r.AddCookie(cookie)
	r.Header.Set("X-Oversized", strings.Repeat("x", 33<<10))
	w = httptest.NewRecorder()
	f.ui.Handler().ServeHTTP(w, r)
	if w.Code != 431 {
		t.Fatal("oversized headers accepted", w.Code)
	}
	r = httptest.NewRequest("GET", "/ui/session?ignored="+strings.Repeat("x", 17<<10), nil)
	r.Host = f.ui.origin.Host
	r.AddCookie(cookie)
	w = httptest.NewRecorder()
	f.ui.Handler().ServeHTTP(w, r)
	if w.Code != 403 {
		t.Fatal("oversized URI accepted", w.Code)
	}
}

func TestAPIAdministrationAndETag(t *testing.T) {
	f := start(t)
	request(t, f, "GET", "/api/v1/sources", "", nil, "", 401)
	// An incoming administration bearer alone never creates a UI session.
	r := httptest.NewRequest("GET", "/api/v1/sources", nil)
	r.Host = f.ui.origin.Host
	r.Header.Set("Authorization", "Bearer "+testAdmin)
	w := httptest.NewRecorder()
	f.ui.Handler().ServeHTTP(w, r)
	if w.Code != 401 {
		t.Fatal("incoming bearer bypassed UI session")
	}
	cookie := login(t, f)
	_, data := request(t, f, "POST", "/api/v1/sources", `{"name":"Laptop","hostname":"host","platform":"linux","labels":{}}`, cookie, f.server.URL, 201)
	var source domain.SourceCredentials
	if err := json.Unmarshal(data, &source); err != nil {
		t.Fatal(err)
	}
	if source.Source.ID == "" || source.Token == "" {
		t.Fatal(string(data))
	}
	_, data = request(t, f, "PATCH", "/api/v1/sources/"+source.Source.ID, `{"name":"Renamed"}`, cookie, f.server.URL, 200)
	var updated domain.Source
	if err := json.Unmarshal(data, &updated); err != nil || updated.Name != "Renamed" {
		t.Fatal(string(data), err)
	}
	rotated, data := request(t, f, "POST", "/api/v1/sources/"+source.Source.ID+"/rotate-token", "", cookie, f.server.URL, 200)
	var credentials domain.SourceCredentials
	if err := json.Unmarshal(data, &credentials); err != nil || credentials.Token == source.Token || credentials.Token == "" {
		t.Fatal(string(data), err)
	}
	if rotated.Header.Get("Cache-Control") != "no-store" {
		t.Fatal("source token cacheable")
	}
	if acceptsSource(t, f, source.Token) {
		t.Fatal("rotation retained old token")
	}
	request(t, f, "DELETE", "/api/v1/sources/"+source.Source.ID+"/token", "", cookie, f.server.URL, 204)
	if acceptsSource(t, f, credentials.Token) {
		t.Fatal("revocation retained token")
	}
	for _, route := range []string{"/api/v1/harnesses", "/api/v1/sources", "/api/v1/tool-calls", "/api/v1/tool-call-facets", "/api/v1/tool-call-metrics"} {
		// Empty metrics otherwise use a moving, implicit time window.
		if strings.HasSuffix(route, "metrics") {
			route += "?since=2026-01-01T00:00:00Z&until=2026-01-02T00:00:00Z"
		}
		response, _ := request(t, f, "GET", route, "", cookie, "", 200)
		etag := response.Header.Get("ETag")
		if etag == "" {
			t.Fatal("missing ETag", route)
		}
		r, err := http.NewRequest("GET", f.server.URL+route, nil)
		if err != nil {
			t.Fatal(err)
		}
		r.AddCookie(cookie)
		r.Header.Set("If-None-Match", etag)
		response, err = f.server.Client().Do(r)
		if err != nil {
			t.Fatal(err)
		}
		data, err := io.ReadAll(response.Body)
		_ = response.Body.Close()
		if err != nil || response.StatusCode != 304 || len(data) != 0 || response.Header.Get("ETag") != etag {
			t.Fatal(response.StatusCode, string(data), err)
		}
	}
	for _, route := range []string{"/api/v1/ingest/events", "/api/v1/ingest/heartbeat", "/api/v1/sources/id/delete", "/api/v1/unknown"} {
		request(t, f, "POST", route, `{}`, cookie, f.server.URL, 404)
	}
	request(t, f, "DELETE", "/api/v1/sources/"+source.Source.ID, "", cookie, f.server.URL, 404)
	request(t, f, "POST", "/api/v1/sources", strings.Repeat("x", maxRequestBytes+1), cookie, f.server.URL, 413)
}

func TestProxyCredentialAndHeaderBoundary(t *testing.T) {
	t.Setenv("TOOL_LOGGER_WEB_DEV_URL", "")
	t.Setenv("MYGO_DEV_URL", "")
	observed := make(chan http.Header, 1)
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := r.Header.Clone()
		h.Set("Observed-Host", r.Host)
		observed <- h
		w.Header().Set("Set-Cookie", "secret=backend")
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Content-Security-Policy", "default-src *")
		w.Header().Set("Connection", "ETag")
		w.Header().Set("ETag", `"stable"`)
		_, _ = io.WriteString(w, `{}`)
	}))
	defer backend.Close()
	ui, server := startUI(t, backend.URL)
	r, err := http.NewRequest("GET", server.URL+"/api/v1/sources", nil)
	if err != nil {
		t.Fatal(err)
	}
	r.AddCookie(ui.IssueSession())
	r.Header.Set("Authorization", "Bearer attacker")
	r.Header.Set("X-Forwarded-Host", "attacker")
	r.Header.Set("Forwarded", "host=attacker")
	r.Header.Set("Proxy-Authorization", "secret")
	r.Header.Set("Connection", "Authorization, Cookie")
	response, err := server.Client().Do(r)
	if err != nil {
		t.Fatal(err)
	}
	_ = response.Body.Close()
	if response.StatusCode != 200 {
		t.Fatal(response.StatusCode)
	}
	h := <-observed
	if h.Get("Authorization") != "Bearer "+testAdmin || h.Get("Cookie") != "" || h.Get("Forwarded") != "" || h.Get("X-Forwarded-Host") != "" || h.Get("Proxy-Authorization") != "" || h.Get("Observed-Host") != strings.TrimPrefix(backend.URL, "http://") {
		t.Fatal("unsafe upstream headers", h)
	}
	if response.Header.Get("Set-Cookie") != "" || response.Header.Get("Access-Control-Allow-Origin") != "" || response.Header.Get("Content-Security-Policy") == "default-src *" {
		t.Fatal("unsafe downstream headers", response.Header)
	}
	if response.Header.Get("ETag") != "" {
		t.Fatal("hop header forwarded")
	}
}

func TestAPIReadsRealIngestionAndPreservesQuery(t *testing.T) {
	f := start(t)
	cookie := login(t, f)
	_, data := request(t, f, "POST", "/api/v1/sources", `{"name":"Laptop","hostname":"host","platform":"linux","labels":{}}`, cookie, f.server.URL, 201)
	var source domain.SourceCredentials
	if err := json.Unmarshal(data, &source); err != nil {
		t.Fatal(err)
	}
	var events []domain.Event
	for i, hook := range []string{"PreToolUse", "PostToolUse"} {
		id := fmt.Sprintf("%08x-%04x-4%03x-8%03x-%012x", i+1, i+1, i+1, i+1, i+1)
		stamp := time.Date(2026, 1, 1, 12, 0, i, 0, time.UTC).Format(time.RFC3339Nano)
		native := fmt.Sprintf(`{"schema_version":2,"harness":"codex","event_id":%q,"logged_at":%q,"hook":%q,"event":{"hook_event_name":%q,"tool_use_id":"paired-call","tool_name":"shell","session_id":"session","turn_id":"turn","cwd":"/tmp","tool_input":{"command":"pwd"},"tool_response":{"output":"/tmp"}},"metadata":{"git":{"root":"/tmp","branch":"main","dirty":false},"session_cwd":"/tmp"},"preservedFutureField":{"value":true}}`, id, stamp, hook, hook)
		events = append(events, domain.Event{SchemaVersion: 1, EventID: id, SourceID: source.Source.ID, Harness: "codex", RecordedAt: stamp, Native: json.RawMessage(native)})
	}
	payload, err := json.Marshal(domain.IngestRequest{Events: events})
	if err != nil {
		t.Fatal(err)
	}
	r, err := http.NewRequest("POST", f.backend.URL+"/api/v1/ingest/events", bytes.NewReader(payload))
	if err != nil {
		t.Fatal(err)
	}
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Authorization", "Bearer "+source.Token)
	response, err := f.backend.Client().Do(r)
	if err != nil {
		t.Fatal(err)
	}
	data, err = io.ReadAll(response.Body)
	_ = response.Body.Close()
	if err != nil || response.StatusCode != 200 {
		t.Fatal(response.StatusCode, string(data), err)
	}
	query := "?source=" + source.Source.ID + "&harness=codex&q=pwd&tool=shell&session=session&directory=%2Ftmp&since=2026-01-01T00%3A00%3A00Z&until=2026-01-02T00%3A00%3A00Z"
	_, data = request(t, f, "GET", "/api/v1/tool-calls"+query, "", cookie, "", 200)
	var page domain.CallPage
	if err := json.Unmarshal(data, &page); err != nil {
		t.Fatal(err)
	}
	if len(page.Data) != 1 || page.Data[0].SourceID != source.Source.ID || page.Data[0].Outcome != "unknown" || page.Data[0].Lifecycle != "finished" {
		t.Fatal(string(data))
	}
	_, data = request(t, f, "GET", "/api/v1/tool-calls/"+page.Data[0].ID, "", cookie, "", 200)
	var detail domain.CallDetail
	if err := json.Unmarshal(data, &detail); err != nil {
		t.Fatal(err)
	}
	if len(detail.Native.Events) != 2 || !strings.Contains(string(detail.Native.Events[0]), "preservedFutureField") || !strings.Contains(string(detail.Input), "pwd") || !strings.Contains(string(detail.Output), "/tmp") {
		t.Fatal(string(data))
	}
	_, data = request(t, f, "GET", "/api/v1/tool-call-metrics"+query, "", cookie, "", 200)
	var metrics domain.Metrics
	if err := json.Unmarshal(data, &metrics); err != nil || metrics.Data.TotalCalls != 1 {
		t.Fatal(string(data), err)
	}
	_, data = request(t, f, "GET", "/api/v1/tool-calls?q=not-present", "", cookie, "", 200)
	if err := json.Unmarshal(data, &page); err != nil || len(page.Data) != 0 {
		t.Fatal(string(data), err)
	}
	request(t, f, "GET", "/api/v1/tool-calls?unsupported=parameter", "", cookie, "", 400)
}

func TestProxyFailuresAndResponseBudget(t *testing.T) {
	t.Setenv("TOOL_LOGGER_WEB_DEV_URL", "")
	t.Setenv("MYGO_DEV_URL", "")
	for _, kind := range []string{"length", "chunked", "redirect", "failure", "truncated"} {
		t.Run(kind, func(t *testing.T) {
			backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch kind {
				case "length":
					w.Header().Set("Content-Length", fmt.Sprint(maxResponseBytes+1))
				case "chunked":
					chunk := bytes.Repeat([]byte("x"), 64<<10)
					for range (maxResponseBytes / len(chunk)) + 1 {
						if _, err := w.Write(chunk); err != nil {
							return
						}
					}
				case "redirect":
					http.Redirect(w, r, "http://attacker.example/", 302)
				case "failure":
					w.WriteHeader(500)
					_, _ = io.WriteString(w, "secret failure credential")
				case "truncated":
					w.Header().Set("Content-Length", "100")
					_, _ = io.WriteString(w, "short")
				}
			}))
			defer backend.Close()
			ui, server := startUI(t, backend.URL)
			f := &fixture{ui: ui, server: server}
			_, data := request(t, f, "GET", "/api/v1/sources", "", ui.IssueSession(), "", 502)
			if strings.Contains(string(data), "secret") || strings.Contains(string(data), "attacker") {
				t.Fatal("sensitive failure exposed")
			}
		})
	}
	backend := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	endpoint := backend.URL
	backend.Close()
	ui, server := startUI(t, endpoint)
	request(t, &fixture{ui: ui, server: server}, "GET", "/api/v1/sources", "", ui.IssueSession(), "", 502)
}

func TestProxyCancellation(t *testing.T) {
	t.Setenv("TOOL_LOGGER_WEB_DEV_URL", "")
	t.Setenv("MYGO_DEV_URL", "")
	started, cancelled := make(chan struct{}), make(chan struct{})
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(started)
		<-r.Context().Done()
		close(cancelled)
	}))
	defer backend.Close()
	ui, server := startUI(t, backend.URL)
	ctx, cancel := context.WithCancel(context.Background())
	r, err := http.NewRequestWithContext(ctx, "GET", server.URL+"/api/v1/sources", nil)
	if err != nil {
		t.Fatal(err)
	}
	r.AddCookie(ui.IssueSession())
	done := make(chan struct{})
	go func() {
		defer close(done)
		response, err := server.Client().Do(r)
		if err == nil {
			_ = response.Body.Close()
		}
	}()
	select {
	case <-started:
	case <-time.After(3 * time.Second):
		cancel()
		t.Fatal("backend not reached")
	}
	cancel()
	select {
	case <-cancelled:
	case <-time.After(3 * time.Second):
		t.Fatal("backend cancellation lost")
	}
	<-done
}

func TestProxyConcurrencyBudget(t *testing.T) {
	t.Setenv("TOOL_LOGGER_WEB_DEV_URL", "")
	t.Setenv("MYGO_DEV_URL", "")
	started := make(chan struct{}, 8)
	release := make(chan struct{})
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		started <- struct{}{}
		select {
		case <-release:
		case <-r.Context().Done():
		}
		_, _ = io.WriteString(w, `{}`)
	}))
	defer backend.Close()
	defer close(release)
	ui, server := startUI(t, backend.URL)
	cookie := ui.IssueSession()
	results := make(chan error, 8)
	for range 8 {
		go func() {
			r, err := http.NewRequest("GET", server.URL+"/api/v1/sources", nil)
			if err != nil {
				results <- err
				return
			}
			r.AddCookie(cookie)
			response, err := server.Client().Do(r)
			if err == nil {
				_, err = io.Copy(io.Discard, response.Body)
				_ = response.Body.Close()
				if response.StatusCode != 200 {
					err = fmt.Errorf("queued request: %d", response.StatusCode)
				}
			}
			results <- err
		}()
	}
	for range 8 {
		select {
		case <-started:
		case <-time.After(3 * time.Second):
			t.Fatal("requests did not reach backend")
		}
	}
	request(t, &fixture{ui: ui, server: server}, "GET", "/api/v1/sources", "", cookie, "", 503)
	// Unblock the eight in-flight requests without closing the channel twice.
	for range 8 {
		release <- struct{}{}
	}
	for range 8 {
		if err := <-results; err != nil {
			t.Fatal(err)
		}
	}
}

func TestEmbeddedAssetsAndPathBoundaries(t *testing.T) {
	f := start(t)
	response, data := request(t, f, "GET", "/", "", nil, "", 200)
	if !strings.Contains(strings.ToLower(string(data)), "<!doctype html>") {
		t.Fatal("missing production entry point")
	}
	for _, header := range []string{"Content-Security-Policy", "X-Content-Type-Options", "X-Frame-Options", "Referrer-Policy"} {
		if response.Header.Get(header) == "" {
			t.Fatal("missing security header", header)
		}
	}
	for _, route := range []string{"/sources", "/settings", "/activity"} {
		request(t, f, "GET", route, "", nil, "", 200)
	}
	assetCount := 0
	if err := fs.WalkDir(assets, "dist", func(name string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() || (!strings.HasSuffix(name, ".js") && !strings.HasSuffix(name, ".css")) {
			return nil
		}
		assetCount++
		response, body := request(t, f, "GET", strings.TrimPrefix(name, "dist"), "", nil, "", 200)
		if len(body) == 0 || response.Header.Get("Content-Type") == "text/html; charset=utf-8" {
			t.Fatal("asset fell back to document", name)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if assetCount == 0 {
		t.Fatal("no generated JavaScript/CSS assets embedded")
	}
	for _, route := range []string{"/missing.js", "/assets", "/unknown-route", "/.env", "/.git/config", "/outbox/events.jsonl", "/state.sqlite", "/ui/missing", "/api/v2/missing"} {
		status := 404
		if strings.HasPrefix(route, "/api/") {
			status = 401
		}
		request(t, f, "GET", route, "", nil, "", status)
	}
	for _, route := range []string{"/../index.html", "/assets/../index.html", "/%2e%2e/index.html", "/assets%2findex.html", "/foo\\bar", "//index.html"} {
		r := httptest.NewRequest("GET", route, nil)
		r.Host = f.ui.origin.Host
		w := httptest.NewRecorder()
		f.ui.Handler().ServeHTTP(w, r)
		if w.Code != 404 {
			t.Fatalf("traversal %s: %d", route, w.Code)
		}
	}
	r, err := http.NewRequest("GET", f.server.URL+"/", nil)
	if err != nil {
		t.Fatal(err)
	}
	r.Header.Set("If-None-Match", response.Header.Get("ETag"))
	response, err = f.server.Client().Do(r)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != 304 {
		t.Fatal("asset ETag not preserved")
	}
}

func TestDevelopmentProxyIsExplicitAndStripsCredentials(t *testing.T) {
	collector := start(t)
	observed := make(chan http.Header, 1)
	dev := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		observed <- r.Header.Clone()
		w.Header().Set("Content-Type", "text/html")
		_, _ = io.WriteString(w, "development frontend")
	}))
	defer dev.Close()
	t.Setenv("MYGO_DEV_URL", dev.URL)
	t.Setenv("TOOL_LOGGER_WEB_DEV_URL", "")
	ui, server := startUI(t, collector.backend.URL, collector.backend.Client())
	r, err := http.NewRequest("GET", server.URL+"/", nil)
	if err != nil {
		t.Fatal(err)
	}
	r.AddCookie(ui.IssueSession())
	r.Header.Set("Authorization", "Bearer secret")
	response, err := server.Client().Do(r)
	if err != nil {
		t.Fatal(err)
	}
	data, err := io.ReadAll(response.Body)
	_ = response.Body.Close()
	if err != nil || string(data) != "development frontend" {
		t.Fatal(string(data), err)
	}
	headers := <-observed
	if headers.Get("Authorization") != "" || headers.Get("Cookie") != "" {
		t.Fatal("credentials reached Vite")
	}
	if !strings.Contains(response.Header.Get("Content-Security-Policy"), "ws://"+strings.TrimPrefix(dev.URL, "http://")) {
		t.Fatal("missing explicit development CSP")
	}
	request(t, &fixture{ui: ui, server: server}, "GET", "/api/v1/sources", "", nil, "", 401)
}

func TestConfigurationRejectsUnsafeOrigins(t *testing.T) {
	t.Setenv("TOOL_LOGGER_WEB_DEV_URL", "")
	t.Setenv("MYGO_DEV_URL", "")
	for _, invalid := range []string{"", "http://0.0.0.0:4318", "http://example.com", "https://127.0.0.1:4318", "http://127.0.0.1:0", "http://127.0.0.1:99999", "http://127.0.0.1/", "http://user:pass@127.0.0.1", "http://127.0.0.1?token=secret", "http://127.0.0.1#fragment"} {
		if _, err := newTestUI(invalid, testAdmin, "http://127.0.0.1:4318"); err == nil && !strings.HasPrefix(invalid, "https://") {
			t.Fatal("unsafe backend accepted", invalid)
		}
		if _, err := newTestUI("http://127.0.0.1:4317", testAdmin, invalid); err == nil {
			t.Fatal("unsafe UI origin accepted", invalid)
		}
	}
	for _, valid := range []string{"http://127.0.0.1:4318", "http://[::1]:4318"} {
		if _, err := newTestUI("http://127.0.0.1:4317", testAdmin, valid); err != nil {
			t.Fatal(valid, err)
		}
	}
	for _, endpoint := range []string{"http://192.168.1.2:4317", "http://10.0.0.2:4317", "http://172.16.0.2:4317", "http://[fd00::2]:4317"} {
		if _, err := newTestUI(endpoint, testAdmin, "http://127.0.0.1:4318"); err != nil {
			t.Fatal("explicit private backend rejected", endpoint, err)
		}
		if _, err := newTestUI("http://127.0.0.1:4317", testAdmin, endpoint); err == nil {
			t.Fatal("private UI origin accepted", endpoint)
		}
	}
	if _, err := newTestUI("http://8.8.8.8:4317", testAdmin, "http://127.0.0.1:4318"); err == nil {
		t.Fatal("public backend accepted")
	}
	if _, err := newTestUI("http://127.0.0.1:4317", "", "http://127.0.0.1:4318"); err == nil {
		t.Fatal("empty admin credential accepted")
	}
	t.Setenv("TOOL_LOGGER_WEB_DEV_URL", "http://example.com:5173")
	if _, err := newTestUI("http://127.0.0.1:4317", testAdmin, "http://127.0.0.1:4318"); err == nil {
		t.Fatal("unsafe development origin accepted")
	}
}

func acceptsSource(t *testing.T, f *fixture, token string) bool {
	t.Helper()
	r, err := http.NewRequest("POST", f.backend.URL+"/api/v1/ingest/heartbeat", strings.NewReader(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	r.Header.Set("Authorization", "Bearer "+token)
	r.Header.Set("Content-Type", "application/json")
	response, err := f.backend.Client().Do(r)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	return response.StatusCode != http.StatusUnauthorized
}
