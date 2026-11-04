package apiclient

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"strings"
	"testing"
	"time"

	"tool-logger/desktop/internal/domain"
)

func TestHTTPContract(t *testing.T) {
	type observed struct {
		Method, Path, Auth string
		Query              url.Values
		Body               json.RawMessage
	}
	requests := make(chan observed, 20)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body json.RawMessage
		if r.Body != nil {
			_ = json.NewDecoder(r.Body).Decode(&body)
		}
		requests <- observed{r.Method, r.URL.Path, r.Header.Get("Authorization"), r.URL.Query(), body}
		w.Header().Set("Content-Type", "application/json")
		if r.Method == "DELETE" {
			w.WriteHeader(204)
			return
		}
		if strings.HasSuffix(r.URL.Path, "facets") || strings.HasSuffix(r.URL.Path, "metrics") {
			_, _ = w.Write([]byte(`{"data":{}}`))
			return
		}
		_, _ = w.Write([]byte(`{"data":[],"page":{"hasMore":false}}`))
	}))
	defer server.Close()
	c, err := New(server.URL+"/", "admin-secret")
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	q := url.Values{"source": {"one", "two"}, "harness": {"codex", "opencode"}, "q": {"a & b"}, "cursor": {"opaque+token/="}}
	operations := []struct {
		method, path string
		run          func() error
	}{
		{"GET", "/healthz", func() error { return c.Health(ctx) }},
		{"GET", "/api/v1/harnesses", func() error { _, e := c.Harnesses(ctx); return e }},
		{"GET", "/api/v1/sources", func() error { _, e := c.Sources(ctx); return e }},
		{"GET", "/api/v1/tool-calls", func() error { _, e := c.Calls(ctx, q); return e }},
		{"GET", "/api/v1/tool-call-facets", func() error { _, e := c.Facets(ctx, q); return e }},
		{"GET", "/api/v1/tool-call-metrics", func() error { _, e := c.Metrics(ctx, q); return e }},
		{"GET", "/api/v1/tool-calls/id with space", func() error { _, e := c.Detail(ctx, "id with space"); return e }},
		{"POST", "/api/v1/sources", func() error {
			_, e := c.CreateSource(ctx, domain.SourceRequest{Name: "Desktop", Labels: map[string]string{"host.name": "test"}})
			return e
		}},
		{"PATCH", "/api/v1/sources/id", func() error { _, e := c.UpdateSource(ctx, "id", domain.SourceRequest{Name: "Renamed"}); return e }},
		{"POST", "/api/v1/sources/id/rotate-token", func() error { _, e := c.RotateToken(ctx, "id"); return e }},
		{"DELETE", "/api/v1/sources/id/token", func() error { return c.RevokeToken(ctx, "id") }},
	}
	for _, op := range operations {
		if err := op.run(); err != nil {
			t.Fatalf("%s %s: %v", op.method, op.path, err)
		}
		r := <-requests
		if r.Method != op.method || r.Path != op.path {
			t.Fatalf("request %+v", r)
		}
		wantAuth := "Bearer admin-secret"
		if op.path == "/healthz" {
			wantAuth = ""
		}
		if r.Auth != wantAuth {
			t.Fatalf("auth for %s: %q", op.path, r.Auth)
		}
		if strings.HasSuffix(op.path, "tool-calls") || strings.HasSuffix(op.path, "facets") || strings.HasSuffix(op.path, "metrics") {
			if !reflect.DeepEqual(q, r.Query) {
				t.Errorf("query lost values: %v", r.Query)
			}
		}
		if op.path == "/api/v1/sources" && op.method == "POST" {
			var v domain.SourceRequest
			if err := json.Unmarshal(r.Body, &v); err != nil || v.Name != "Desktop" || v.Labels["host.name"] != "test" {
				t.Fatalf("source body %s", r.Body)
			}
		}
	}
}

func TestProblemCancellationAndRedirect(t *testing.T) {
	t.Run("problem", func(t *testing.T) {
		s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(401)
			_, _ = w.Write([]byte(`{"status":401,"title":"Unauthorized","detail":"Admin token required"}`))
		}))
		defer s.Close()
		c, _ := New(s.URL, "secret")
		_, err := c.Sources(context.Background())
		var problem *Error
		if !errors.As(err, &problem) || problem.Problem.Status != 401 || !strings.Contains(err.Error(), "Admin token required") {
			t.Fatalf("problem: %v", err)
		}
	})
	t.Run("cancel", func(t *testing.T) {
		started := make(chan struct{})
		s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { close(started); <-r.Context().Done() }))
		defer s.Close()
		c, _ := New(s.URL, "secret")
		ctx, cancel := context.WithCancel(context.Background())
		done := make(chan error, 1)
		go func() { _, err := c.Calls(ctx, nil); done <- err }()
		<-started
		cancel()
		select {
		case err := <-done:
			if !errors.Is(err, context.Canceled) {
				t.Fatal(err)
			}
		case <-time.After(time.Second):
			t.Fatal("request ignored cancellation")
		}
	})
	t.Run("redirect", func(t *testing.T) {
		leaked := false
		target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { leaked = true }))
		defer target.Close()
		s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, target.URL, 302) }))
		defer s.Close()
		c, _ := New(s.URL, "secret")
		_, err := c.Sources(context.Background())
		if err == nil || leaked {
			t.Fatal("must reject redirect without forwarding admin credentials")
		}
	})
}

func TestRejectInvalidEndpoints(t *testing.T) {
	for _, endpoint := range []string{"", "file:///tmp/a", "http://user:password@host", "http://host?q=1", "https://host/#fragment"} {
		if _, err := New(endpoint, "secret"); err == nil {
			t.Errorf("accepted %q", endpoint)
		}
	}
}

func TestConditionalPollingUsesETagAndHonorsNoStore(t *testing.T) {
	for _, noStore := range []bool{false, true} {
		t.Run(fmt.Sprint(noStore), func(t *testing.T) {
			requests := 0
			s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				requests++
				w.Header().Set("ETag", `"synthetic-v1"`)
				if noStore {
					w.Header().Set("Cache-Control", "no-store")
				}
				if requests > 1 && !noStore {
					if r.Header.Get("If-None-Match") != `"synthetic-v1"` {
						t.Error("missing conditional header")
					}
					w.WriteHeader(304)
					return
				}
				if noStore && r.Header.Get("If-None-Match") != "" {
					t.Error("cached no-store response")
				}
				_, _ = w.Write([]byte(`{"data":[{"id":"synthetic-source","name":"Synthetic"}]}`))
			}))
			defer s.Close()
			c, _ := New(s.URL, "secret")
			for i := 0; i < 2; i++ {
				sources, err := c.Sources(context.Background())
				if err != nil || len(sources.Data) != 1 || sources.Data[0].ID != "synthetic-source" {
					t.Fatalf("conditional result %+v: %v", sources, err)
				}
			}
		})
	}
}

func TestConditionalCacheIsBounded(t *testing.T) {
	c, _ := New("http://localhost:4317", "secret")
	for i := 0; i < 150; i++ {
		c.remember(fmt.Sprint(i), "etag", []byte(`{"data":[]}`))
	}
	if len(c.cache) != 128 || len(c.cacheOrder) != 128 {
		t.Fatalf("unbounded cache %d", len(c.cache))
	}
	c.remember("149", "new", []byte(`{"data":[1]}`))
	if len(c.cache) != 128 || len(c.cacheOrder) != 128 {
		t.Fatal("duplicate cache entry retained")
	}
	c.remember("large", "etag", make([]byte, cacheLimit))
	if c.cacheBytes != cacheLimit || len(c.cache) != 1 {
		t.Fatal("cache byte budget exceeded")
	}
}
