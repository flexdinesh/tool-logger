package main

import (
	"os/exec"
	"strings"
	"testing"
)

func TestHeadlessCLIDoesNotLoadMyGo(t *testing.T) {
	output, err := exec.Command("go", "list", "-deps", ".").Output()
	if err != nil {
		t.Fatal(err)
	}
	for _, dependency := range strings.Fields(string(output)) {
		if strings.HasPrefix(dependency, "github.com/egoist/mygo") || strings.HasPrefix(dependency, "tool-logger/apps/desktop") {
			t.Errorf("headless CLI imports desktop dependency: %s", dependency)
		}
	}
}
