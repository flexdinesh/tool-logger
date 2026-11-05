package main

import (
	"os/exec"
	"strings"
	"testing"
)

func TestDesktopUsesOnlyCollectorClientBoundary(t *testing.T) {
	output, err := exec.Command("go", "list", "-deps", ".").Output()
	if err != nil {
		t.Fatal(err)
	}
	for _, dependency := range strings.Fields(string(output)) {
		if strings.HasPrefix(dependency, "tool-logger/apps/server") || strings.HasPrefix(dependency, "modernc.org/sqlite") {
			t.Errorf("desktop imports collector implementation instead of client contract: %s", dependency)
		}
	}
}
