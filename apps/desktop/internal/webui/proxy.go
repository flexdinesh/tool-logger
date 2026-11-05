package webui

import (
	"bytes"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
)

func (s *Server) proxy(w http.ResponseWriter, r *http.Request, target *url.URL, admin bool) {
	select {
	case s.requests <- struct{}{}:
		defer func() { <-s.requests }()
	default:
		problem(w, http.StatusServiceUnavailable)
		return
	}
	body, err := io.ReadAll(r.Body)
	if err != nil {
		var large *http.MaxBytesError
		if errors.As(err, &large) {
			problem(w, http.StatusRequestEntityTooLarge)
		} else {
			problem(w, http.StatusBadRequest)
		}
		return
	}
	u := *target
	u.Path, u.RawQuery = r.URL.Path, r.URL.RawQuery
	upstream, err := http.NewRequestWithContext(r.Context(), r.Method, u.String(), bytes.NewReader(body))
	if err != nil {
		problem(w, http.StatusBadGateway)
		return
	}
	// An allowlist prevents credentials, forwarding metadata, Connection-nominated
	// headers and browser-controlled Host values from crossing either boundary.
	for _, name := range []string{"Accept", "Content-Type", "If-None-Match", "If-Modified-Since"} {
		if hopHeader(r.Header, name) {
			continue
		}
		if value := r.Header.Get(name); value != "" {
			upstream.Header.Set(name, value)
		}
	}
	if admin {
		upstream.Header.Set("Authorization", "Bearer "+s.adminToken)
	}
	response, err := s.client.Do(upstream)
	if err != nil {
		problem(w, http.StatusBadGateway)
		return
	}
	defer response.Body.Close()
	if response.StatusCode >= 300 && response.StatusCode != http.StatusNotModified && response.StatusCode < 400 {
		problem(w, http.StatusBadGateway)
		return
	}
	if response.StatusCode >= 500 {
		problem(w, http.StatusBadGateway)
		return
	}
	if response.ContentLength > maxResponseBytes {
		problem(w, http.StatusBadGateway)
		return
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, maxResponseBytes+1))
	if err != nil || len(data) > maxResponseBytes {
		problem(w, http.StatusBadGateway)
		return
	}
	for _, name := range []string{"Content-Type", "Cache-Control", "ETag", "Last-Modified", "Allow"} {
		if hopHeader(response.Header, name) {
			continue
		}
		if value := response.Header.Get(name); value != "" {
			w.Header().Set(name, value)
		}
	}
	if r.Method != http.MethodGet || response.StatusCode >= 400 {
		w.Header().Set("Cache-Control", "no-store")
	} else if admin && !strings.Contains(w.Header().Get("Cache-Control"), "no-store") {
		w.Header().Set("Cache-Control", "private, no-cache")
	}
	w.WriteHeader(response.StatusCode)
	if r.Method != http.MethodHead {
		_, _ = w.Write(data)
	}
}

func hopHeader(header http.Header, name string) bool {
	for _, value := range header.Values("Connection") {
		for _, token := range strings.Split(value, ",") {
			if strings.EqualFold(strings.TrimSpace(token), name) {
				return true
			}
		}
	}
	return false
}
