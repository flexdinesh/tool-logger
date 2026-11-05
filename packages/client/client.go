// Package apiclient is the native application's only data boundary.
package apiclient

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"tool-logger/packages/protocol"
)

type Client struct {
	base       string
	token      string
	http       *http.Client
	cacheMu    sync.Mutex
	cache      map[string]cacheEntry
	cacheOrder []string
	cacheBytes int
}

type cacheEntry struct {
	etag string
	body []byte
}

const cacheLimit = 16 << 20

func (c *Client) cached(key string) (cacheEntry, bool) {
	c.cacheMu.Lock()
	defer c.cacheMu.Unlock()
	entry, ok := c.cache[key]
	return entry, ok
}
func (c *Client) remember(key, etag string, body []byte) {
	if len(body) > cacheLimit {
		return
	}
	c.cacheMu.Lock()
	defer c.cacheMu.Unlock()
	if c.cache == nil {
		c.cache = map[string]cacheEntry{}
	}
	if old, ok := c.cache[key]; ok {
		c.cacheBytes -= len(old.body)
		delete(c.cache, key)
		for i, v := range c.cacheOrder {
			if v == key {
				c.cacheOrder = append(c.cacheOrder[:i], c.cacheOrder[i+1:]...)
				break
			}
		}
	}
	for len(c.cacheOrder) > 0 && (c.cacheBytes+len(body) > cacheLimit || len(c.cache) >= 128) {
		old := c.cacheOrder[0]
		c.cacheOrder = c.cacheOrder[1:]
		c.cacheBytes -= len(c.cache[old].body)
		delete(c.cache, old)
	}
	c.cache[key] = cacheEntry{etag, body}
	c.cacheOrder = append(c.cacheOrder, key)
	c.cacheBytes += len(body)
}

func New(endpoint, adminToken string) (*Client, error) {
	u, err := url.Parse(endpoint)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return nil, errors.New("endpoint must be an HTTP(S) base URL without credentials, query, or fragment")
	}
	return &Client{base: strings.TrimRight(endpoint, "/"), token: adminToken, http: &http.Client{Timeout: 10 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}, nil
}

// Error preserves actionable server diagnostics without exposing credentials.
type Error struct{ Problem domain.Problem }

func (e *Error) Error() string {
	if e.Problem.Detail != "" {
		return fmt.Sprintf("HTTP %d: %s: %s", e.Problem.Status, e.Problem.Title, e.Problem.Detail)
	}
	return fmt.Sprintf("HTTP %d: %s", e.Problem.Status, e.Problem.Title)
}

func (c *Client) request(ctx context.Context, method, path string, query url.Values, body, result interface{}) error {
	var data io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return err
		}
		data = bytes.NewReader(b)
	}
	target := c.base + path
	if len(query) > 0 {
		target += "?" + query.Encode()
	}
	req, err := http.NewRequestWithContext(ctx, method, target, data)
	if err != nil {
		return err
	}
	if path != "/healthz" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	entry, hasEntry := c.cached(target)
	if method == http.MethodGet && hasEntry {
		req.Header.Set("If-None-Match", entry.etag)
	}
	res, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("connect to %s: %w", c.base, err)
	}
	defer res.Body.Close()
	if res.StatusCode == http.StatusNotModified && hasEntry && method == http.MethodGet {
		if result == nil {
			return nil
		}
		return json.Unmarshal(entry.body, result)
	}
	if res.StatusCode < 200 || res.StatusCode > 299 {
		p := domain.Problem{Status: res.StatusCode, Title: http.StatusText(res.StatusCode)}
		_ = json.NewDecoder(io.LimitReader(res.Body, 64<<10)).Decode(&p)
		p.Status = res.StatusCode
		return &Error{Problem: p}
	}
	if result == nil || res.StatusCode == http.StatusNoContent {
		return nil
	}
	b, err := io.ReadAll(io.LimitReader(res.Body, (64<<20)+1))
	if err != nil {
		return fmt.Errorf("read %s: %w", path, err)
	}
	if len(b) > 64<<20 {
		return fmt.Errorf("%s response exceeds 64 MiB", path)
	}
	if err := json.Unmarshal(b, result); err != nil {
		return fmt.Errorf("decode %s: %w", path, err)
	}
	if etag := res.Header.Get("ETag"); method == http.MethodGet && etag != "" && !strings.Contains(strings.ToLower(res.Header.Get("Cache-Control")), "no-store") {
		c.remember(target, etag, b)
	}
	return nil
}

func (c *Client) Health(ctx context.Context) error {
	return c.request(ctx, "GET", "/healthz", nil, nil, nil)
}
func (c *Client) Harnesses(ctx context.Context) (r domain.HarnessList, err error) {
	err = c.request(ctx, "GET", "/api/v1/harnesses", nil, nil, &r)
	return
}
func (c *Client) Sources(ctx context.Context) (r domain.SourceList, err error) {
	err = c.request(ctx, "GET", "/api/v1/sources", nil, nil, &r)
	return
}
func (c *Client) Calls(ctx context.Context, q url.Values) (r domain.CallPage, err error) {
	err = c.request(ctx, "GET", "/api/v1/tool-calls", q, nil, &r)
	return
}
func (c *Client) Detail(ctx context.Context, id string) (r domain.CallDetail, err error) {
	err = c.request(ctx, "GET", "/api/v1/tool-calls/"+url.PathEscape(id), nil, nil, &r)
	return
}
func (c *Client) Facets(ctx context.Context, q url.Values) (r domain.Facets, err error) {
	err = c.request(ctx, "GET", "/api/v1/tool-call-facets", q, nil, &r)
	return
}
func (c *Client) Metrics(ctx context.Context, q url.Values) (r domain.Metrics, err error) {
	err = c.request(ctx, "GET", "/api/v1/tool-call-metrics", q, nil, &r)
	return
}
func (c *Client) CreateSource(ctx context.Context, v domain.SourceRequest) (r domain.SourceCredentials, err error) {
	err = c.request(ctx, "POST", "/api/v1/sources", nil, v, &r)
	return
}
func (c *Client) UpdateSource(ctx context.Context, id string, v domain.SourceRequest) (r domain.Source, err error) {
	err = c.request(ctx, "PATCH", "/api/v1/sources/"+url.PathEscape(id), nil, v, &r)
	return
}
func (c *Client) RotateToken(ctx context.Context, id string) (r domain.SourceCredentials, err error) {
	err = c.request(ctx, "POST", "/api/v1/sources/"+url.PathEscape(id)+"/rotate-token", nil, nil, &r)
	return
}
func (c *Client) RevokeToken(ctx context.Context, id string) error {
	return c.request(ctx, "DELETE", "/api/v1/sources/"+url.PathEscape(id)+"/token", nil, nil, nil)
}
