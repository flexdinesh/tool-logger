package app

import (
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
