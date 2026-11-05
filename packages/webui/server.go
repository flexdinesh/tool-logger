// Package webui serves the browser UI and exchanges administration credentials
// for short-lived, process-local sessions. Data stays behind the existing REST API.
package webui

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net"
	"net/http"
	"net/url"
	"os"
	"path"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	cookieName      = "tool_logger_session"
	sessionLifetime = 12 * time.Hour
	maxSessions     = 128
	maxRequestBytes = 1 << 20
	// Detail responses retain both complete native wrappers plus projections.
	maxResponseBytes = 64 << 20
	requestTimeout   = 30 * time.Second
)

type Server struct {
	endpoint           *url.URL
	origin             *url.URL
	dev                *url.URL
	adminToken         string
	adminHash          [32]byte
	client             *http.Client
	devClient          *http.Client
	serverID           string
	cookieName         string
	connectionEndpoint string
	mu                 sync.Mutex
	sessions           map[[32]byte]time.Time
	bootstraps         map[[32]byte]time.Time
	now                func() time.Time
	requests           chan struct{}
}

// Config fixes one connection for the lifetime of a gateway. HTTPClient carries
// Unix socket dialing or certificate pinning, supplied by the shared client.
type Config struct {
	Endpoint, Credential, Origin, ServerID, ConnectionEndpoint string
	HTTPClient                                                 *http.Client
}

func New(config Config) (*Server, error) {
	backend, err := url.Parse(config.Endpoint)
	if err != nil || backend.User != nil || backend.Host == "" ||
		(backend.Scheme != "http" && backend.Scheme != "https") ||
		backend.Path != "" || backend.RawQuery != "" || backend.ForceQuery || backend.Fragment != "" {
		return nil, errors.New("invalid backend origin")
	}
	if backend.Scheme == "http" && backend.Host != "localhost" {
		if _, err := httpOrigin(config.Endpoint, true); err != nil {
			return nil, errors.New("invalid HTTP backend origin")
		}
	}
	ui, err := httpOrigin(config.Origin, false)
	if err != nil {
		return nil, errors.New("invalid UI origin: require a loopback HTTP origin")
	}
	adminToken := config.Credential
	if adminToken == "" || len(adminToken) > 512 || strings.ContainsAny(adminToken, "\r\n") {
		return nil, errors.New("invalid administration credential")
	}
	if config.HTTPClient == nil || config.ServerID == "" {
		return nil, errors.New("connection transport and server identity required")
	}
	devURL := os.Getenv("TOOL_LOGGER_WEB_DEV_URL")
	if devURL == "" {
		devURL = os.Getenv("MYGO_DEV_URL")
	}
	var dev *url.URL
	if devURL != "" {
		dev, err = httpOrigin(devURL, false)
		if err != nil {
			return nil, errors.New("invalid development URL: require a loopback HTTP origin")
		}
	}
	transport := &http.Transport{
		DialContext:  (&net.Dialer{Timeout: 5 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
		MaxIdleConns: 16, MaxIdleConnsPerHost: 8, MaxConnsPerHost: 8,
		IdleConnTimeout: 90 * time.Second, ResponseHeaderTimeout: 10 * time.Second,
		MaxResponseHeaderBytes: 32 << 10, DisableCompression: true,
	}
	client := *config.HTTPClient
	client.Timeout = requestTimeout
	client.Jar = nil
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	if config.ConnectionEndpoint == "" {
		config.ConnectionEndpoint = config.Endpoint
	}
	// Cookies ignore ports. Scope the name to this gateway so concurrent
	// loopback windows cannot overwrite each other's sessions.
	cookieHash := sha256.Sum256([]byte(config.Origin + "\x00" + config.ServerID))
	return &Server{endpoint: backend, origin: ui, dev: dev, adminToken: adminToken, serverID: config.ServerID,
		cookieName:         fmt.Sprintf("%s_%x", cookieName, cookieHash[:8]),
		connectionEndpoint: config.ConnectionEndpoint,
		adminHash:          sha256.Sum256([]byte(adminToken)), sessions: make(map[[32]byte]time.Time),
		bootstraps: make(map[[32]byte]time.Time), client: &client,
		now: time.Now, requests: make(chan struct{}, 8),
		devClient: &http.Client{Transport: transport, Timeout: requestTimeout,
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }},
	}, nil
}

// BrowserURL contains only a one-use, one-minute local login capability. The
// frontend removes the fragment before making requests. Admin tokens stay in Go.
func (s *Server) BrowserURL() string {
	token := rand.Text()
	s.mu.Lock()
	defer s.mu.Unlock()
	s.pruneLocked()
	if len(s.bootstraps) >= maxSessions {
		clear(s.bootstraps)
	}
	s.bootstraps[sha256.Sum256([]byte(token))] = s.now().Add(time.Minute)
	return s.origin.String() + "/#session=" + token
}

func httpOrigin(raw string, allowPrivate bool) (*url.URL, error) {
	u, err := url.Parse(raw)
	if err != nil {
		return nil, err
	}
	ip := net.ParseIP(u.Hostname())
	if u.Scheme != "http" || u.User != nil || u.Opaque != "" || u.Host == "" ||
		u.Path != "" || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" ||
		(ip == nil || (!ip.IsLoopback() && !(allowPrivate && ip.IsPrivate()))) {
		return nil, errors.New("not an allowed literal HTTP origin")
	}
	if u.Port() == "0" {
		return nil, errors.New("listener port must be resolved")
	}
	if u.Port() != "" {
		port, err := strconv.Atoi(u.Port())
		if err != nil || port < 1 || port > 65535 {
			return nil, errors.New("invalid listener port")
		}
	}
	return u, nil
}

// IssueSession seeds the native webview without exposing the admin token to JS.
// Creating another session at capacity evicts the earliest-expiring session.
func (s *Server) IssueSession() *http.Cookie {
	token := rand.Text()
	s.mu.Lock()
	expires := s.now().Add(sessionLifetime)
	s.pruneLocked()
	if len(s.sessions) >= maxSessions {
		var oldest [32]byte
		var earliest time.Time
		for key, expiry := range s.sessions {
			if earliest.IsZero() || expiry.Before(earliest) {
				oldest, earliest = key, expiry
			}
		}
		delete(s.sessions, oldest)
	}
	s.sessions[sha256.Sum256([]byte(token))] = expires
	s.mu.Unlock()
	return &http.Cookie{Name: s.cookieName, Value: token, Path: "/", HttpOnly: true,
		SameSite: http.SameSiteStrictMode, MaxAge: int(sessionLifetime.Seconds()), Expires: expires}
}

func (s *Server) pruneLocked() {
	for token, expires := range s.sessions {
		if !s.now().Before(expires) {
			delete(s.sessions, token)
		}
	}
	for token, expires := range s.bootstraps {
		if !s.now().Before(expires) {
			delete(s.bootstraps, token)
		}
	}
}

func (s *Server) sessionKey(r *http.Request) ([32]byte, bool) {
	var key [32]byte
	cookies := r.CookiesNamed(s.cookieName)
	if len(cookies) != 1 || cookies[0].Value == "" || len(cookies[0].Value) > 128 {
		return key, false
	}
	key = sha256.Sum256([]byte(cookies[0].Value))
	s.mu.Lock()
	defer s.mu.Unlock()
	s.pruneLocked()
	_, ok := s.sessions[key]
	return key, ok
}

func (s *Server) Handler() http.Handler { return http.HandlerFunc(s.serveHTTP) }

func (s *Server) serveHTTP(w http.ResponseWriter, r *http.Request) {
	s.securityHeaders(w)
	if r.Host != s.origin.Host || r.URL.IsAbs() || len(r.URL.RequestURI()) > 16<<10 {
		problem(w, http.StatusForbidden)
		return
	}
	headerBytes := 0
	for name, values := range r.Header {
		headerBytes += len(name)
		for _, value := range values {
			headerBytes += len(value)
		}
	}
	if headerBytes > 32<<10 {
		problem(w, http.StatusRequestHeaderFieldsTooLarge)
		return
	}
	origins := r.Header.Values("Origin")
	safe := r.Method == http.MethodGet || r.Method == http.MethodHead
	if len(origins) > 1 || (len(origins) == 1 && origins[0] != s.origin.String()) || (!safe && r.Header.Get("Sec-Fetch-Site") == "cross-site") {
		problem(w, http.StatusForbidden)
		return
	}
	if !safe && (len(origins) != 1 || origins[0] != s.origin.String()) {
		problem(w, http.StatusForbidden)
		return
	}
	if r.URL.RawPath != "" || path.Clean(r.URL.Path) != r.URL.Path || strings.Contains(r.URL.Path, "\\") {
		problem(w, http.StatusNotFound)
		return
	}
	controller := http.NewResponseController(w)
	_ = controller.SetReadDeadline(time.Now().Add(15 * time.Second))
	_ = controller.SetWriteDeadline(time.Now().Add(requestTimeout))
	ctx, cancel := context.WithTimeout(r.Context(), requestTimeout)
	defer cancel()
	r = r.WithContext(ctx)
	r.Body = http.MaxBytesReader(w, r.Body, maxRequestBytes)
	if r.URL.Path == "/ui/connection" && r.Method == http.MethodGet {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		_ = json.NewEncoder(w).Encode(struct {
			ServerID string `json:"serverId"`
		}{s.serverID})
		return
	}
	if r.URL.Path == "/ui/session" {
		s.session(w, r)
		return
	}
	if r.URL.Path == "/api" || strings.HasPrefix(r.URL.Path, "/api/") {
		if _, ok := s.sessionKey(r); !ok {
			problem(w, http.StatusUnauthorized)
			return
		}
		if !allowedAPI(r.Method, r.URL.Path) {
			problem(w, http.StatusNotFound)
			return
		}
		s.proxy(w, r, s.endpoint, true)
		return
	}
	if r.URL.Path == "/ui" || strings.HasPrefix(r.URL.Path, "/ui/") {
		problem(w, http.StatusNotFound)
		return
	}
	if !safe {
		problem(w, http.StatusMethodNotAllowed)
		return
	}
	if s.dev != nil {
		s.proxy(w, r, s.dev, false)
		return
	}
	serveAsset(w, r)
}

func (s *Server) session(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	switch r.Method {
	case http.MethodGet:
		if _, ok := s.sessionKey(r); !ok {
			problem(w, http.StatusUnauthorized)
			return
		}
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		_ = json.NewEncoder(w).Encode(struct {
			Authenticated     bool   `json:"authenticated"`
			IngestionEndpoint string `json:"ingestionEndpoint"`
			ServerID          string `json:"serverId"`
		}{true, s.connectionEndpoint, s.serverID})
	case http.MethodPost:
		media, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
		if err != nil || media != "application/json" {
			problem(w, http.StatusUnsupportedMediaType)
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, 4096)
		token, err := decodeToken(r.Body)
		if err != nil {
			var large *http.MaxBytesError
			if errors.As(err, &large) {
				problem(w, http.StatusRequestEntityTooLarge)
			} else {
				problem(w, http.StatusBadRequest)
			}
			return
		}
		hash := sha256.Sum256([]byte(token))
		s.mu.Lock()
		s.pruneLocked()
		_, bootstrap := s.bootstraps[hash]
		delete(s.bootstraps, hash)
		s.mu.Unlock()
		if !bootstrap && subtle.ConstantTimeCompare(hash[:], s.adminHash[:]) != 1 {
			problem(w, http.StatusUnauthorized)
			return
		}
		// Replace a browser's prior session rather than leaving an orphan behind.
		if key, ok := s.sessionKey(r); ok {
			s.mu.Lock()
			delete(s.sessions, key)
			s.mu.Unlock()
		}
		http.SetCookie(w, s.IssueSession())
		w.WriteHeader(http.StatusNoContent)
	case http.MethodDelete:
		if key, ok := s.sessionKey(r); ok {
			s.mu.Lock()
			delete(s.sessions, key)
			s.mu.Unlock()
		}
		http.SetCookie(w, &http.Cookie{Name: s.cookieName, Path: "/", HttpOnly: true,
			SameSite: http.SameSiteStrictMode, MaxAge: -1, Expires: time.Unix(1, 0)})
		w.WriteHeader(http.StatusNoContent)
	default:
		w.Header().Set("Allow", "GET, POST, DELETE")
		problem(w, http.StatusMethodNotAllowed)
	}
}

// Token decoding rejects unknown and duplicate keys, nulls and trailing values.
func decodeToken(body io.Reader) (string, error) {
	d := json.NewDecoder(body)
	opening, err := d.Token()
	if err != nil {
		return "", err
	}
	if opening != json.Delim('{') {
		return "", errors.New("expected object")
	}
	key, err := d.Token()
	if err != nil {
		return "", err
	}
	if key != "token" {
		return "", errors.New("expected token")
	}
	var value json.RawMessage
	if err := d.Decode(&value); err != nil {
		return "", err
	}
	var token string
	if len(value) == 0 || value[0] != '"' || json.Unmarshal(value, &token) != nil || token == "" || len(token) > 512 {
		return "", errors.New("invalid token")
	}
	closing, err := d.Token()
	if err != nil {
		return "", err
	}
	if closing != json.Delim('}') {
		return "", errors.New("unexpected field")
	}
	if _, err := d.Token(); err != io.EOF {
		if err == nil {
			err = errors.New("trailing value")
		}
		return "", err
	}
	return token, nil
}

func allowedAPI(method, route string) bool {
	switch route {
	case "/api/v1/harnesses", "/api/v1/tool-calls", "/api/v1/tool-call-facets", "/api/v1/tool-call-metrics":
		return method == http.MethodGet
	case "/api/v1/sources":
		return method == http.MethodGet || method == http.MethodPost
	}
	parts := strings.Split(strings.TrimPrefix(route, "/api/v1/"), "/")
	if !strings.HasPrefix(route, "/api/v1/") || len(parts) < 2 || parts[1] == "" || strings.HasPrefix(parts[1], ".") {
		return false
	}
	if len(parts) == 2 {
		return (parts[0] == "tool-calls" && method == http.MethodGet) || (parts[0] == "sources" && method == http.MethodPatch)
	}
	return len(parts) == 3 && parts[0] == "sources" &&
		((parts[2] == "rotate-token" && method == http.MethodPost) || (parts[2] == "token" && method == http.MethodDelete))
}

func problem(w http.ResponseWriter, status int) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/problem+json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(struct {
		Type   string `json:"type"`
		Title  string `json:"title"`
		Status int    `json:"status"`
	}{"about:blank", http.StatusText(status), status})
}

func (s *Server) securityHeaders(w http.ResponseWriter) {
	csp := "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'"
	if s.dev != nil {
		// Vite's React refresh preamble and optional HMR sockets are permitted
		// only when development proxying was explicitly configured.
		csp = strings.Replace(csp, "script-src 'self'", "script-src 'self' 'unsafe-inline'", 1)
		csp = strings.Replace(csp, "connect-src 'self'", "connect-src 'self' ws://"+s.origin.Host+" ws://"+s.dev.Host, 1)
	}
	w.Header().Set("Content-Security-Policy", csp)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("X-Frame-Options", "DENY")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("Cache-Control", "no-cache")
}
