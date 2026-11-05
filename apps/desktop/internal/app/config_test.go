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

func TestUIListenerRejectsNonliteralAndNonloopbackAddresses(t *testing.T) {
	for _, address := range []string{"localhost:0", ":0", "0.0.0.0:0", "[::]:0", "192.168.1.2:4318", "8.8.8.8:4318", "[fe80::1%lo]:0", "[::1%lo]:0", "127.0.0.1:http", "127.0.0.1:-1", "127.0.0.1:65536", "127.0.0.1"} {
		t.Run(address, func(t *testing.T) {
			listener, err := ListenUI(address)
			if err == nil {
				listener.Close()
				t.Fatal("accepted unsafe UI listener")
			}
		})
	}
}

func TestUIListenerResolvesExactEphemeralOrigin(t *testing.T) {
	for _, address := range []string{"127.0.0.1:0", "[::1]:0"} {
		t.Run(address, func(t *testing.T) {
			listener, err := ListenUI(address)
			if err != nil {
				t.Fatal(err)
			}
			defer listener.Close()
			origin, err := ClientEndpoint(listener.Addr())
			if err != nil || origin != "http://"+listener.Addr().String() {
				t.Fatalf("origin %q differs from actual listener %s: %v", origin, listener.Addr(), err)
			}
			_, port, err := net.SplitHostPort(listener.Addr().String())
			if err != nil || port == "0" {
				t.Fatalf("unresolved port: %s, %v", port, err)
			}
		})
	}
}
