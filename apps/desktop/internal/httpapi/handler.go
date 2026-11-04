// Package httpapi serves the versioned admin and source APIs. Source credentials
// can only ingest; admin credentials can only administer and query.
package httpapi

import (
	"bytes"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"strings"

	"tool-logger/desktop/internal/domain"
	"tool-logger/desktop/internal/harnesses"
	"tool-logger/desktop/internal/sqlite"
)

// Native journals permit 8 MiB records. Reserve envelope/batch framing space so
// every supported single record remains deliverable after HTTP wrapping.
const MaxBodyBytes int64 = 9 << 20

type server struct {
	store        *sqlite.Store
	adminHash    [32]byte
	adminEnabled bool
}

func New(store *sqlite.Store, adminToken string) http.Handler {
	s := &server{store: store, adminHash: sha256.Sum256([]byte(adminToken)), adminEnabled: adminToken != ""}
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		if !method(w, r, http.MethodGet) {
			return
		}
		respond(w, r, 200, map[string]string{"status": "ok"})
	})
	mux.HandleFunc("/api/v1/ingest/events", s.source(func(w http.ResponseWriter, r *http.Request, id string) {
		if !method(w, r, http.MethodPost) {
			return
		}
		var request domain.IngestRequest
		if !decode(w, r, &request) {
			return
		}
		ack, err := s.store.Ingest(r.Context(), id, request.Events)
		if err != nil {
			problem(w, err)
			return
		}
		respond(w, r, 200, ack)
	}))
	mux.HandleFunc("/api/v1/ingest/heartbeat", s.source(func(w http.ResponseWriter, r *http.Request, id string) {
		if !method(w, r, http.MethodPost) {
			return
		}
		var request domain.Heartbeat
		if !decode(w, r, &request) {
			return
		}
		if err := s.store.Heartbeat(r.Context(), id, request); err != nil {
			problem(w, err)
			return
		}
		w.WriteHeader(204)
	}))
	mux.HandleFunc("/api/v1/harnesses", s.admin(func(w http.ResponseWriter, r *http.Request) {
		if !method(w, r, http.MethodGet) {
			return
		}
		respond(w, r, 200, harnesses.List())
	}))
	mux.HandleFunc("/api/v1/sources", s.admin(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			value, err := s.store.Sources(r.Context())
			if err != nil {
				problem(w, err)
				return
			}
			respond(w, r, 200, value)
		case http.MethodPost:
			var request domain.SourceRequest
			if !decode(w, r, &request) {
				return
			}
			value, err := s.store.CreateSource(r.Context(), request)
			if err != nil {
				problem(w, err)
				return
			}
			w.Header().Set("Cache-Control", "no-store")
			respond(w, r, 201, value)
		default:
			allowed(w, http.MethodGet+", "+http.MethodPost)
		}
	}))
	mux.HandleFunc("/api/v1/sources/{id}", s.admin(func(w http.ResponseWriter, r *http.Request) {
		if !method(w, r, http.MethodPatch) {
			return
		}
		var patch struct {
			Name     *string            `json:"name"`
			Hostname *string            `json:"hostname"`
			Platform *string            `json:"platform"`
			Labels   *map[string]string `json:"labels"`
		}
		if !decode(w, r, &patch) {
			return
		}
		current, err := s.store.Source(r.Context(), r.PathValue("id"))
		if err != nil {
			problem(w, err)
			return
		}
		request := domain.SourceRequest{Name: current.Name, Hostname: current.Hostname, Platform: current.Platform, Labels: current.Labels}
		if patch.Name != nil {
			request.Name = *patch.Name
		}
		if patch.Hostname != nil {
			request.Hostname = *patch.Hostname
		}
		if patch.Platform != nil {
			request.Platform = *patch.Platform
		}
		if patch.Labels != nil {
			request.Labels = *patch.Labels
		}
		value, err := s.store.UpdateSource(r.Context(), current.ID, request)
		if err != nil {
			problem(w, err)
			return
		}
		respond(w, r, 200, value)
	}))
	mux.HandleFunc("/api/v1/sources/{id}/rotate-token", s.admin(func(w http.ResponseWriter, r *http.Request) {
		if !method(w, r, http.MethodPost) {
			return
		}
		value, err := s.store.RotateToken(r.Context(), r.PathValue("id"))
		if err != nil {
			problem(w, err)
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		respond(w, r, 200, value)
	}))
	mux.HandleFunc("/api/v1/sources/{id}/token", s.admin(func(w http.ResponseWriter, r *http.Request) {
		if !method(w, r, http.MethodDelete) {
			return
		}
		if err := s.store.RevokeToken(r.Context(), r.PathValue("id")); err != nil {
			problem(w, err)
			return
		}
		w.WriteHeader(204)
	}))
	mux.HandleFunc("/api/v1/tool-calls", s.admin(func(w http.ResponseWriter, r *http.Request) {
		if !method(w, r, http.MethodGet) {
			return
		}
		q, err := sqlite.ParseQuery(r.URL.Query())
		if err != nil {
			problem(w, err)
			return
		}
		value, err := s.store.Calls(r.Context(), q)
		if err != nil {
			problem(w, err)
			return
		}
		respond(w, r, 200, value)
	}))
	mux.HandleFunc("/api/v1/tool-calls/{id}", s.admin(func(w http.ResponseWriter, r *http.Request) {
		if !method(w, r, http.MethodGet) {
			return
		}
		value, err := s.store.Call(r.Context(), r.PathValue("id"))
		if err != nil {
			problem(w, err)
			return
		}
		respond(w, r, 200, value)
	}))
	mux.HandleFunc("/api/v1/tool-call-facets", s.admin(func(w http.ResponseWriter, r *http.Request) {
		if !method(w, r, http.MethodGet) {
			return
		}
		q, err := sqlite.ParseQuery(r.URL.Query())
		if err != nil {
			problem(w, err)
			return
		}
		if q.Cursor != "" {
			problem(w, sqlite.Invalid("cursor is only supported for calls"))
			return
		}
		value, err := s.store.Facets(r.Context(), q)
		if err != nil {
			problem(w, err)
			return
		}
		respond(w, r, 200, value)
	}))
	mux.HandleFunc("/api/v1/tool-call-metrics", s.admin(func(w http.ResponseWriter, r *http.Request) {
		if !method(w, r, http.MethodGet) {
			return
		}
		q, err := sqlite.ParseQuery(r.URL.Query())
		if err != nil {
			problem(w, err)
			return
		}
		if q.Cursor != "" {
			problem(w, sqlite.Invalid("cursor is only supported for calls"))
			return
		}
		value, err := s.store.Metrics(r.Context(), q)
		if err != nil {
			problem(w, err)
			return
		}
		respond(w, r, 200, value)
	}))
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		problem(w, &sqlite.Error{Status: 404, Title: "Not found", Detail: "Unknown API endpoint."})
	})
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Cache-Control", "no-cache")
		mux.ServeHTTP(w, r)
	})
}

func bearer(r *http.Request) string {
	h := r.Header.Values("Authorization")
	if len(h) != 1 {
		return ""
	}
	parts := strings.Fields(h[0])
	if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") || len(parts[1]) > 512 {
		return ""
	}
	return parts[1]
}
func (s *server) isAdmin(token string) bool {
	h := sha256.Sum256([]byte(token))
	return s.adminEnabled && token != "" && subtle.ConstantTimeCompare(h[:], s.adminHash[:]) == 1
}
func (s *server) admin(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !s.isAdmin(bearer(r)) {
			w.Header().Set("WWW-Authenticate", `Bearer realm="tool-logger-admin"`)
			problem(w, &sqlite.Error{Status: 401, Title: "Unauthorized", Detail: "An administration bearer credential is required."})
			return
		}
		next(w, r)
	}
}
func (s *server) source(next func(http.ResponseWriter, *http.Request, string)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		t := bearer(r)
		if s.isAdmin(t) {
			problem(w, &sqlite.Error{Status: 403, Title: "Forbidden", Detail: "Ingestion requires a source credential."})
			return
		}
		id, err := s.store.AuthenticateSource(r.Context(), t)
		if err != nil {
			w.Header().Set("WWW-Authenticate", `Bearer realm="tool-logger-source"`)
			problem(w, err)
			return
		}
		next(w, r, id)
	}
}
func decode(w http.ResponseWriter, r *http.Request, destination interface{}) bool {
	media, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || media != "application/json" {
		problem(w, &sqlite.Error{Status: 415, Title: "Unsupported media type", Detail: "Content-Type must be application/json."})
		return false
	}
	r.Body = http.MaxBytesReader(w, r.Body, MaxBodyBytes)
	decoder := json.NewDecoder(r.Body)
	var body json.RawMessage
	if err = decoder.Decode(&body); err != nil {
		decodeProblem(w, err)
		return false
	}
	var trailing json.RawMessage
	if err = decoder.Decode(&trailing); err != io.EOF {
		if err == nil {
			err = errors.New("body must contain exactly one JSON object")
		}
		decodeProblem(w, err)
		return false
	}
	if len(body) == 0 || body[0] != '{' {
		problem(w, sqlite.Invalid("Body must be a JSON object."))
		return false
	}
	strict := json.NewDecoder(bytes.NewReader(body))
	strict.DisallowUnknownFields()
	if err = strict.Decode(destination); err != nil {
		decodeProblem(w, err)
		return false
	}
	return true
}
func decodeProblem(w http.ResponseWriter, err error) {
	var large *http.MaxBytesError
	if errors.As(err, &large) {
		problem(w, &sqlite.Error{Status: 413, Title: "Payload too large", Detail: "Body exceeds 9 MiB."})
		return
	}
	problem(w, sqlite.Invalid("Invalid JSON body: "+err.Error()))
}
func method(w http.ResponseWriter, r *http.Request, expected string) bool {
	if r.Method != expected {
		allowed(w, expected)
		return false
	}
	return true
}
func allowed(w http.ResponseWriter, methods string) {
	w.Header().Set("Allow", methods)
	problem(w, &sqlite.Error{Status: 405, Title: "Method not allowed"})
}
func problem(w http.ResponseWriter, err error) {
	value := domain.Problem{Type: "about:blank", Title: "Internal server error", Status: 500}
	var typed *sqlite.Error
	if errors.As(err, &typed) {
		value.Title, value.Status, value.Detail = typed.Title, typed.Status, typed.Detail
	}
	w.Header().Set("Content-Type", "application/problem+json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(value.Status)
	_ = json.NewEncoder(w).Encode(value)
}
func respond(w http.ResponseWriter, r *http.Request, status int, value interface{}) {
	b, err := json.Marshal(value)
	if err != nil {
		problem(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	if r.Method == http.MethodGet {
		hash := sha256.Sum256(b)
		etag := `"` + hex.EncodeToString(hash[:]) + `"`
		w.Header().Set("ETag", etag)
		if r.Header.Get("If-None-Match") == etag {
			w.WriteHeader(304)
			return
		}
	}
	w.WriteHeader(status)
	_, _ = w.Write(b)
}
