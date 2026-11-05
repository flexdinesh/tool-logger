package main

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"tool-logger/packages/client"
)

func TestRepairedConnectionCannotForwardIntoRevokedNativeWindow(t *testing.T) {
	old := apiclient.Connection{SchemaVersion: 1, ServerID: "server", Endpoint: "https://host:4317", Token: "old-credential", Fingerprint: strings.Repeat("a", 64)}
	paired := old
	paired.Token = "new-credential"
	if connectionIdentity(old) == connectionIdentity(paired) {
		t.Fatal("re-pairing reused window holding old credential")
	}
	if strings.Contains(connectionIdentity(paired), paired.Token) {
		t.Fatal("native profile identity exposes credential")
	}
}

func writeExecutable(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("#!/bin/sh\nexit 0\n"), 0700); err != nil {
		t.Fatal(err)
	}
}

func TestCompanionResolutionCoversInstalledLocalBuildAndDevelopmentLayouts(t *testing.T) {
	for _, tc := range []struct{ name, gui, cli, override string }{
		{"installed sibling", "tool-logger-desktop", "tool-logger", ""},
		{"Linux MyGo resources", "tool-logger-desktop", "bin/tool-logger", ""},
		{"macOS MyGo resources", "Tool Logger.app/Contents/MacOS/Tool Logger", "Tool Logger.app/Contents/Resources/bin/tool-logger", ""},
		{"development override", ".mygo/dev/tool-logger-desktop", ".mygo/tool-logger", ".mygo/tool-logger"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			root := t.TempDir()
			gui, cli := filepath.Join(root, tc.gui), filepath.Join(root, tc.cli)
			writeExecutable(t, gui)
			writeExecutable(t, cli)
			var override string
			if tc.override != "" {
				override = filepath.Join(root, tc.override)
			}
			got, err := resolveCompanionCLI(gui, override)
			if err != nil || got != cli {
				t.Fatalf("companion=%q, want %q: %v", got, cli, err)
			}
		})
	}
}

func TestCompanionResolutionUsesRealBundleAndRejectsBrokenExplicitOverrides(t *testing.T) {
	root := t.TempDir()
	gui := filepath.Join(root, "bundle", "tool-logger-desktop")
	companion := filepath.Join(root, "bundle", "bin", "tool-logger")
	writeExecutable(t, gui)
	writeExecutable(t, companion)
	link := filepath.Join(root, "tool-logger-desktop")
	if err := os.Symlink(gui, link); err != nil {
		t.Fatal(err)
	}
	got, err := resolveCompanionCLI(link, "")
	if err != nil || got != companion {
		t.Fatalf("bundle companion %q: %v", got, err)
	}
	for _, override := range []string{"relative/tool-logger", filepath.Join(root, "missing"), root} {
		if _, err := resolveCompanionCLI(gui, override); err == nil {
			t.Fatal("invalid override fell back to another binary", override)
		}
	}
	if err := os.Chmod(companion, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := resolveCompanionCLI(gui, companion); err == nil {
		t.Fatal("non-executable override accepted")
	}
	if _, err := resolveCompanionCLI(gui, ""); err == nil {
		t.Fatal("missing executable companion accepted")
	}
}

func TestDevelopmentCompanionStartsRealCollectorWithoutDisplay(t *testing.T) {
	directory, err := os.MkdirTemp("", "tl-companion-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(directory) })
	state := filepath.Join(directory, "state")
	t.Setenv("TOOL_LOGGER_STATE_DIR", state)
	t.Setenv("DISPLAY", "")
	t.Setenv("WAYLAND_DISPLAY", "")
	companion := filepath.Join(directory, ".mygo", "tool-logger")
	command := exec.Command("go", "build", "-o", companion, "../../../cli")
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("build development CLI: %v: %s", err, output)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	if err := startCollectorCompanion(ctx, filepath.Join(directory, ".mygo", "dev", "tool-logger-desktop"), companion); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		command := exec.Command(companion, "server", "stop")
		if output, err := command.CombinedOutput(); err != nil {
			t.Errorf("stop development collector: %v: %s", err, output)
		}
	})
	connection, err := apiclient.LocalConnection(state)
	if err != nil {
		t.Fatal(err)
	}
	client, err := apiclient.NewConnection(connection)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	status, err := client.Status(ctx)
	if err != nil || !status.Ready || status.PID == 0 {
		t.Fatalf("development collector %+v %v", status, err)
	}
}
