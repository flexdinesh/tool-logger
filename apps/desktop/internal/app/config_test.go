package app

import (
	"net"
	"os"
	"path/filepath"
	"testing"
)

func TestAdminCredentialPersistsPrivatelyAndRejectsSymlinks(t *testing.T) {
	directory := t.TempDir()
	first, err := AdminToken(directory)
	if err != nil {
		t.Fatal(err)
	}
	second, err := AdminToken(directory)
	if err != nil || first != second {
		t.Fatalf("credential changed: %v", err)
	}
	path := filepath.Join(directory, "collector", "admin.token")
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(directory, "other"), path); err != nil {
		t.Fatal(err)
	}
	if _, err := AdminToken(directory); err == nil {
		t.Fatal("accepted symlink credential")
	}
}

func TestNativeClientUsesLoopbackForWildcardListeners(t *testing.T) {
	for _, tc := range []struct{ ip, want string }{{"0.0.0.0", "http://127.0.0.1:4317"}, {"::", "http://[::1]:4317"}, {"127.0.0.1", "http://127.0.0.1:4317"}} {
		t.Run(tc.ip, func(t *testing.T) {
			got, err := ClientEndpoint(&net.TCPAddr{IP: net.ParseIP(tc.ip), Port: 4317})
			if err != nil || got != tc.want {
				t.Fatalf("got %q %v", got, err)
			}
		})
	}
}
