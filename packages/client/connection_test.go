package apiclient

import (
	"context"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestConnectionDescriptorsRequirePrivateFilesAndPinnedTransport(t *testing.T) {
	state := t.TempDir()
	c := Connection{SchemaVersion: 1, Endpoint: "unix:///tmp/collector.sock", Token: "private-token", ServerID: "550e8400-e29b-41d4-a716-446655440000"}
	path, err := SaveConnection(state, c)
	if err != nil {
		t.Fatal(err)
	}
	loaded, err := LoadConnection(path)
	if err != nil || loaded != c {
		t.Fatalf("round trip: %v", err)
	}
	link := filepath.Join(state, "symlink.json")
	if err := os.Symlink(path, link); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadConnection(link); err == nil {
		t.Fatal("symlink accepted")
	}
	file, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		t.Fatal(err)
	}
	_, err = file.WriteString("{}\n")
	file.Close()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := LoadConnection(path); err == nil {
		t.Fatal("trailing JSON accepted")
	}
	for _, endpoint := range []string{"http://localhost:4317", "unix://host/tmp/socket", "unix:relative", "https://example.org/path", "https://user:secret@example.org", "https://example.org?q=1", "https://example.org#secret"} {
		invalid := c
		invalid.Endpoint = endpoint
		invalid.Fingerprint = strings.Repeat("a", 64)
		if _, err := HTTPClient(invalid); err == nil {
			t.Errorf("invalid connection accepted %q", endpoint)
		}
	}
	invalid := c
	invalid.Endpoint = "https://example.org"
	if _, err := HTTPClient(invalid); err == nil {
		t.Fatal("unpinned TLS accepted")
	}
	for _, token := range []string{"", "tab\tvalue", "line\nbreak", "nonASCII\u0080"} {
		invalid = c
		invalid.Token = token
		if _, err := HTTPClient(invalid); err == nil {
			t.Fatal("invalid credential accepted")
		}
	}
}

func TestUnixConnectionUsesExactSocketAndNeverFollowsRedirect(t *testing.T) {
	state, err := os.MkdirTemp("", "tl-client-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(state)
	socket := filepath.Join(state, "collector.sock")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Host != "localhost" || r.Header.Get("Authorization") != "Bearer private-token" {
			t.Error("Unix request lost host/auth boundary")
		}
		http.Redirect(w, r, "https://example.org/leak", 302)
	})}
	defer server.Close()
	go func() { _ = server.Serve(listener) }()
	c, err := NewConnection(Connection{SchemaVersion: 1, Endpoint: "unix://" + socket, Token: "private-token", ServerID: "550e8400-e29b-41d4-a716-446655440000"})
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if _, err := c.Sources(context.Background()); err == nil {
		t.Fatal("redirect followed")
	}
}
