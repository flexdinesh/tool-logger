package desktop

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func TestPreferencesMigrationPreservesNativeFile(t *testing.T) {
	state := t.TempDir()
	native := filepath.Join(state, "native-preferences.json")
	seed := `{"query":{"harness":["codex"]},"theme":"dark"}`
	if err := os.WriteFile(native, []byte(seed), 0644); err != nil {
		t.Fatal(err)
	}
	shell := &Shell{state: state}
	if got := shell.Preferences(); got != seed {
		t.Fatalf("seed = %q", got)
	}
	if err := shell.SavePreferences(`{"theme":"light"}`); err != nil {
		t.Fatal(err)
	}
	if got := shell.Preferences(); got != `{"theme":"light"}` {
		t.Fatalf("saved = %q", got)
	}
	data, err := os.ReadFile(native)
	if err != nil || string(data) != seed {
		t.Fatalf("modified native file: %q %v", data, err)
	}
	info, err := os.Stat(filepath.Join(state, "webview-preferences.json"))
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0600 {
		t.Fatalf("preferences mode = %v", info.Mode())
	}
	if err := shell.SavePreferences("invalid"); err == nil {
		t.Fatal("accepted invalid JSON")
	}
	if err := shell.SavePreferences(`"` + strings.Repeat("x", maxPreferences) + `"`); err == nil {
		t.Fatal("accepted unbounded JSON")
	}
	if got := shell.Preferences(); got != `{"theme":"light"}` {
		t.Fatal("failed save replaced valid settings")
	}
	files, err := filepath.Glob(filepath.Join(state, ".webview-preferences-*"))
	if err != nil || len(files) != 0 {
		t.Fatalf("temporary files remain: %v %v", files, err)
	}
}

func TestPreferencesRejectSymlinksAndDoNotFallBackOverBrokenNewFile(t *testing.T) {
	state := t.TempDir()
	shell := &Shell{state: state}
	if got := shell.Preferences(); got != "{}" {
		t.Fatalf("missing = %q", got)
	}
	native := filepath.Join(state, "native-preferences.json")
	if err := os.WriteFile(native, []byte(`{"theme":"dark"}`), 0600); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(state, "webview-preferences.json")
	if err := os.Symlink(native, path); err != nil {
		t.Fatal(err)
	}
	if got := shell.Preferences(); got != "{}" {
		t.Fatalf("followed symlink or reused migration seed: %s", got)
	}
	if err := shell.SavePreferences(`{"theme":"light"}`); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(native)
	if err != nil || string(data) != `{"theme":"dark"}` {
		t.Fatal("save overwrote symlink target")
	}
	if err := os.Chmod(path, 0644); err != nil {
		t.Fatal(err)
	}
	if got := shell.Preferences(); got != "{}" {
		t.Fatal("read public webview preferences")
	}
}

func TestPreferencesConcurrentBindingsRemainValid(t *testing.T) {
	shell := &Shell{state: t.TempDir()}
	var wg sync.WaitGroup
	for range 8 {
		wg.Go(func() {
			if err := shell.SavePreferences(`{"theme":"light"}`); err != nil {
				t.Error(err)
			}
			if got := shell.Preferences(); got != `{"theme":"light"}` {
				t.Errorf("partial settings: %q", got)
			}
		})
	}
	wg.Wait()
}
