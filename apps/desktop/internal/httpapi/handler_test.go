package httpapi

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"tool-logger/desktop/internal/domain"
	"tool-logger/desktop/internal/sqlite"
)

const adminToken = "synthetic-test-admin-token"

type fixtureServer struct {
	store  *sqlite.Store
	server *httptest.Server
	client *http.Client
}

func start(t *testing.T) *fixtureServer {
	t.Helper()
	store, err := sqlite.Open(filepath.Join(t.TempDir(), "http.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(New(store, adminToken))
	t.Cleanup(func() { server.Close(); _ = store.Close() })
	return &fixtureServer{store, server, &http.Client{Timeout: 10 * time.Second}}
}
func request(t *testing.T, f *fixtureServer, method, path, token string, body interface{}, status int) []byte {
	t.Helper()
	var data []byte
	var err error
	if text, ok := body.(string); ok {
		data = []byte(text)
	} else if body != nil {
		data, err = json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
	}
	r, err := http.NewRequest(method, f.server.URL+path, bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
	if body != nil {
		r.Header.Set("Content-Type", "application/json")
	}
	response, err := f.client.Do(r)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	b, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != status {
		t.Fatalf("%s %s: want %d got %d: %s", method, path, status, response.StatusCode, b)
	}
	if status >= 400 {
		var p domain.Problem
		if json.Unmarshal(b, &p) != nil || p.Status != status || p.Title == "" || p.Type == "" || !strings.HasPrefix(response.Header.Get("Content-Type"), "application/problem+json") {
			t.Fatalf("unstructured error: %s", b)
		}
	}
	return b
}
func decodeValue[T interface{}](t *testing.T, b []byte) T {
	t.Helper()
	var value T
	if err := json.Unmarshal(b, &value); err != nil {
		t.Fatal(err)
	}
	return value
}
func create(t *testing.T, f *fixtureServer) domain.SourceCredentials {
	t.Helper()
	return decodeValue[domain.SourceCredentials](t, request(t, f, "POST", "/api/v1/sources", adminToken, domain.SourceRequest{Name: "Laptop", Hostname: "host", Platform: "linux", Labels: map[string]string{"host.name": "host"}}, 201))
}
func nativeEvent(source, call, phase string, stamp time.Time) domain.Event {
	id := sqlite.UUID()
	hook := "PreToolUse"
	if phase == "post" {
		hook = "PostToolUse"
	}
	recorded := stamp.UTC().Format(time.RFC3339Nano)
	w := map[string]interface{}{"schema_version": 2, "harness": "codex", "event_id": id, "logged_at": recorded, "hook": hook, "event": map[string]interface{}{"hook_event_name": hook, "tool_use_id": call, "tool_name": "shell", "session_id": "session", "turn_id": "turn", "cwd": "/work/repo", "tool_input": map[string]string{"command": "pwd"}, "tool_response": map[string]string{"output": "/work/repo"}}, "metadata": map[string]interface{}{"git": map[string]interface{}{"root": "/work/repo", "branch": "main", "dirty": false}, "session_cwd": "/work/repo"}, "futureNativeField": map[string]bool{"preserved": true}}
	b, _ := json.Marshal(w)
	return domain.Event{SchemaVersion: 1, EventID: id, SourceID: source, Harness: "codex", RecordedAt: recorded, Native: b}
}

func TestHTTPSourceAndAdminScopes(t *testing.T) {
	f := start(t)
	request(t, f, "GET", "/healthz", "", nil, 200)
	for _, path := range []string{"/api/v1/harnesses", "/api/v1/sources", "/api/v1/tool-calls", "/api/v1/tool-call-facets", "/api/v1/tool-call-metrics"} {
		request(t, f, "GET", path, "", nil, 401)
	}
	a := create(t, f)
	b := create(t, f)
	request(t, f, "GET", "/api/v1/sources", a.Token, nil, 401)
	request(t, f, "POST", "/api/v1/ingest/events", adminToken, domain.IngestRequest{Events: []domain.Event{nativeEvent(a.Source.ID, "call", "pre", time.Now())}}, 403)
	request(t, f, "POST", "/api/v1/ingest/events", a.Token, domain.IngestRequest{Events: []domain.Event{nativeEvent(b.Source.ID, "call", "pre", time.Now())}}, 403)
	request(t, f, "POST", "/api/v1/ingest/heartbeat", a.Token, domain.Heartbeat{SourceID: b.Source.ID}, 403)
	request(t, f, "POST", "/api/v1/ingest/heartbeat", a.Token, domain.Heartbeat{SourceID: a.Source.ID, Hostname: "remote", Platform: "darwin", Labels: map[string]string{"container.id": "synthetic"}}, 204)
	sources := decodeValue[domain.SourceList](t, request(t, f, "GET", "/api/v1/sources", adminToken, nil, 200))
	if len(sources.Data) != 2 {
		t.Fatal(sources)
	}
	for _, source := range sources.Data {
		if source.ID == a.Source.ID && (source.Status != "online" || source.Hostname != "remote" || source.Labels["container.id"] != "synthetic") {
			t.Fatalf("heartbeat not projected: %+v", source)
		}
	}
	harnesses := decodeValue[domain.HarnessList](t, request(t, f, "GET", "/api/v1/harnesses", adminToken, nil, 200))
	if len(harnesses.Data) != 2 {
		t.Fatal(harnesses)
	}
	updated := decodeValue[domain.Source](t, request(t, f, "PATCH", "/api/v1/sources/"+a.Source.ID, adminToken, `{"name":"Renamed"}`, 200))
	if updated.Name != "Renamed" || updated.Hostname != "remote" || updated.Platform != "darwin" || updated.Labels["container.id"] != "synthetic" {
		t.Fatalf("PATCH erased omitted properties: %+v", updated)
	}
	request(t, f, "DELETE", "/api/v1/sources/"+a.Source.ID, adminToken, nil, 405)
}

func TestHTTPDurableAckPairingConflictAndArchive(t *testing.T) {
	f := start(t)
	c := create(t, f)
	at := time.Now()
	pre := nativeEvent(c.Source.ID, "call", "pre", at)
	post := nativeEvent(c.Source.ID, "call", "post", at.Add(time.Second))
	ack := decodeValue[domain.Acknowledgement](t, request(t, f, "POST", "/api/v1/ingest/events", c.Token, domain.IngestRequest{Events: []domain.Event{post, pre}}, 200))
	if len(ack.Accepted) != 2 || len(ack.Duplicates) != 0 {
		t.Fatal(ack)
	}
	ack = decodeValue[domain.Acknowledgement](t, request(t, f, "POST", "/api/v1/ingest/events", c.Token, domain.IngestRequest{Events: []domain.Event{post, pre}}, 200))
	if len(ack.Accepted) != 0 || len(ack.Duplicates) != 2 {
		t.Fatal(ack)
	}
	page := decodeValue[domain.CallPage](t, request(t, f, "GET", "/api/v1/tool-calls?source="+c.Source.ID, adminToken, nil, 200))
	if len(page.Data) != 1 || page.Data[0].Lifecycle != "finished" || page.Data[0].Outcome != "unknown" {
		t.Fatal(page)
	}
	detail := decodeValue[domain.CallDetail](t, request(t, f, "GET", "/api/v1/tool-calls/"+page.Data[0].ID, adminToken, nil, 200))
	if len(detail.Native.Events) != 2 || !bytes.Contains(detail.Native.Events[0], []byte(`"futureNativeField"`)) {
		t.Fatal("native wrapper lost")
	}
	conflicting := pre
	conflicting.RecordedAt = at.Add(time.Minute).Format(time.RFC3339Nano)
	// A fully valid wrapper with reused event ID must conflict, rather than fail wrapper validation.
	var wrapper map[string]json.RawMessage
	if err := json.Unmarshal(pre.Native, &wrapper); err != nil {
		t.Fatal(err)
	}
	wrapper["logged_at"], _ = json.Marshal(conflicting.RecordedAt)
	conflicting.Native, _ = json.Marshal(wrapper)
	request(t, f, "POST", "/api/v1/ingest/events", c.Token, domain.IngestRequest{Events: []domain.Event{nativeEvent(c.Source.ID, "new", "pre", at), conflicting}}, 409)
	page = decodeValue[domain.CallPage](t, request(t, f, "GET", "/api/v1/tool-calls", adminToken, nil, 200))
	if len(page.Data) != 1 {
		t.Fatal("partial batch committed")
	}
	rotated := decodeValue[domain.SourceCredentials](t, request(t, f, "POST", "/api/v1/sources/"+c.Source.ID+"/rotate-token", adminToken, nil, 200))
	if rotated.Token == c.Token {
		t.Fatal("token reused")
	}
	request(t, f, "POST", "/api/v1/ingest/events", c.Token, domain.IngestRequest{Events: []domain.Event{pre}}, 401)
	request(t, f, "POST", "/api/v1/ingest/events", rotated.Token, domain.IngestRequest{Events: []domain.Event{pre}}, 200)
	request(t, f, "DELETE", "/api/v1/sources/"+c.Source.ID+"/token", adminToken, nil, 204)
	request(t, f, "POST", "/api/v1/ingest/heartbeat", rotated.Token, domain.Heartbeat{SourceID: c.Source.ID}, 401)
	page = decodeValue[domain.CallPage](t, request(t, f, "GET", "/api/v1/tool-calls", adminToken, nil, 200))
	if len(page.Data) != 1 {
		t.Fatal("archive deleted history")
	}
	sources := decodeValue[domain.SourceList](t, request(t, f, "GET", "/api/v1/sources", adminToken, nil, 200))
	if sources.Data[0].Status != "revoked" {
		t.Fatal(sources)
	}
}

func TestHTTPValidationLimitsErrorsAndETag(t *testing.T) {
	f := start(t)
	c := create(t, f)
	for _, body := range []string{`{`, `{"events":[]}`, `{"events":[],"typo":true}`, `{"events":[]} {}`, `{"events":null}`, `[]`} {
		request(t, f, "POST", "/api/v1/ingest/events", c.Token, body, 400)
	}
	request(t, f, "POST", "/api/v1/ingest/events", c.Token, `{"events":[{"native":"`+strings.Repeat("x", int(MaxBodyBytes))+`"}]}`, 413)
	e := nativeEvent(c.Source.ID, "call", "pre", time.Now())
	e.Native = json.RawMessage(`{"hook_event_name":"PreToolUse"}`)
	request(t, f, "POST", "/api/v1/ingest/events", c.Token, domain.IngestRequest{Events: []domain.Event{e}}, 400)
	for _, path := range []string{"/api/v1/tool-calls?limit=501", "/api/v1/tool-calls?since=no", "/api/v1/tool-calls?cursor=no", "/api/v1/tool-calls?invalid=x", "/api/v1/tool-call-metrics?cursor=no"} {
		request(t, f, "GET", path, adminToken, nil, 400)
	}
	request(t, f, "GET", "/api/v1/tool-calls/absent", adminToken, nil, 404)
	request(t, f, "PATCH", "/api/v1/sources/"+c.Source.ID, adminToken, `null`, 400)
	request(t, f, "POST", "/api/v1/ingest/heartbeat", c.Token, domain.Heartbeat{SourceID: c.Source.ID, PendingEvents: -1}, 400)
	request(t, f, "GET", "/unknown", adminToken, nil, 404)
	request(t, f, "PUT", "/api/v1/sources", adminToken, nil, 405)
	r, err := http.NewRequest("GET", f.server.URL+"/api/v1/harnesses", nil)
	if err != nil {
		t.Fatal(err)
	}
	r.Header.Set("Authorization", "Bearer "+adminToken)
	response, err := f.client.Do(r)
	if err != nil {
		t.Fatal(err)
	}
	etag := response.Header.Get("ETag")
	response.Body.Close()
	if etag == "" {
		t.Fatal("missing etag")
	}
	r.Header.Set("If-None-Match", etag)
	response, err = f.client.Do(r)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != 304 {
		t.Fatal(response.Status)
	}
	r, err = http.NewRequest("POST", f.server.URL+"/api/v1/ingest/events", strings.NewReader(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	r.Header.Set("Authorization", "Bearer "+c.Token)
	r.Header.Set("Content-Type", "text/plain")
	response, err = f.client.Do(r)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != 415 {
		t.Fatal(response.Status)
	}
	if err = f.store.Close(); err != nil {
		t.Fatal(err)
	}
	request(t, f, "GET", "/api/v1/tool-calls", adminToken, nil, 500)
}

func TestHTTPConcurrentClientsAndPersistentAcknowledgements(t *testing.T) {
	path := filepath.Join(t.TempDir(), "persistent.sqlite")
	store, err := sqlite.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(New(store, adminToken))
	f := &fixtureServer{store, server, &http.Client{Timeout: 10 * time.Second}}
	c := create(t, f)
	at := time.Now()
	var wg sync.WaitGroup
	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			event := nativeEvent(c.Source.ID, fmt.Sprint(i), "pre", at)
			request(t, f, "POST", "/api/v1/ingest/events", c.Token, domain.IngestRequest{Events: []domain.Event{event, event}}, 200)
		}(i)
	}
	wg.Wait()
	page := decodeValue[domain.CallPage](t, request(t, f, "GET", "/api/v1/tool-calls", adminToken, nil, 200))
	if len(page.Data) != 10 {
		t.Fatal(page)
	}
	e := nativeEvent(c.Source.ID, "restart", "pre", at)
	request(t, f, "POST", "/api/v1/ingest/events", c.Token, domain.IngestRequest{Events: []domain.Event{e}}, 200)
	server.Close()
	if err = store.Close(); err != nil {
		t.Fatal(err)
	}
	store, err = sqlite.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	server = httptest.NewServer(New(store, adminToken))
	defer server.Close()
	f = &fixtureServer{store, server, &http.Client{Timeout: 10 * time.Second}}
	ack := decodeValue[domain.Acknowledgement](t, request(t, f, "POST", "/api/v1/ingest/events", c.Token, domain.IngestRequest{Events: []domain.Event{e}}, 200))
	if len(ack.Duplicates) != 1 || len(ack.Accepted) != 0 {
		t.Fatal("ACK not durable")
	}
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(b, []byte(c.Token)) {
		t.Fatal("plaintext source credential persisted")
	}
}
