package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"tool-logger/packages/client"
	"tool-logger/packages/protocol"
)

var processBuildDirectory string

func TestMain(m *testing.M) {
	var err error
	processBuildDirectory, err = os.MkdirTemp("", "tl-cli-build-")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	code := m.Run()
	if err := os.RemoveAll(processBuildDirectory); err != nil {
		fmt.Fprintln(os.Stderr, err)
		code = 1
	}
	os.Exit(code)
}

// Cache only within this test process; later check invocations build current sources.
var processCLI = sync.OnceValues(func() (string, error) {
	path := filepath.Join(processBuildDirectory, "tool-logger")
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	if output, err := exec.CommandContext(ctx, "go", "build", "-o", path, ".").CombinedOutput(); err != nil {
		return "", fmt.Errorf("build CLI: %w: %s", err, output)
	}
	return path, nil
})

func buildCLI(t *testing.T) string {
	t.Helper()
	binary, err := processCLI()
	if err != nil {
		t.Fatal(err)
	}
	// Tests install different desktop companions beside the CLI.
	path := filepath.Join(t.TempDir(), "tool-logger")
	data, err := os.ReadFile(binary)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0700); err != nil {
		t.Fatal(err)
	}
	return path
}

// Unix sockets have a platform path length limit. Go's descriptive test temp
// directories can exceed it before the collector appends its socket filename.
func shortState(t *testing.T) string {
	t.Helper()
	directory, err := os.MkdirTemp("", "tl-cli-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(directory) })
	return filepath.Join(directory, "state")
}

func processEnvironment(state string, extra ...string) []string {
	values := map[string]string{"TOOL_LOGGER_STATE_DIR": state, "DISPLAY": "", "WAYLAND_DISPLAY": "", "MYGO_DEV_URL": "", "TOOL_LOGGER_WEB_DEV_URL": "", "TOOL_LOGGER_UI_LISTEN": ""}
	for _, value := range extra {
		key, text, _ := strings.Cut(value, "=")
		values[key] = text
	}
	var env []string
	for _, value := range os.Environ() {
		key, _, _ := strings.Cut(value, "=")
		if _, ok := values[key]; !ok {
			env = append(env, value)
		}
	}
	for key, value := range values {
		env = append(env, key+"="+value)
	}
	return env
}

func cli(t *testing.T, binary string, env []string, args ...string) string {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, binary, args...)
	command.Env = env
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("CLI %v: %v: %s", args, err, output)
	}
	return strings.TrimSpace(string(output))
}

func collectorCleanup(t *testing.T, binary string, env []string) {
	t.Helper()
	t.Cleanup(func() { cli(t, binary, env, "server", "stop") })
}

type uiProcess struct {
	command        *exec.Cmd
	done           chan error
	origin, launch string
}

func startUIProcess(t *testing.T, binary string, env []string, args ...string) *uiProcess {
	t.Helper()
	p := &uiProcess{command: exec.Command(binary, args...), done: make(chan error, 1)}
	p.command.Env = env
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	p.command.Stdout, p.command.Stderr = writer, writer
	if err := p.command.Start(); err != nil {
		t.Fatal(err)
	}
	_ = writer.Close()
	go func() { p.done <- p.command.Wait(); close(p.done) }()
	t.Cleanup(func() {
		_ = p.command.Process.Kill()
		select {
		case <-p.done:
		case <-time.After(5 * time.Second):
			t.Error("UI did not exit")
		}
		reader.Close()
	})
	ready := make(chan [2]string, 1)
	go func() {
		scanner := bufio.NewScanner(reader)
		var origin, launch string
		for scanner.Scan() {
			line := scanner.Text()
			if _, value, ok := strings.Cut(line, "Tool Logger UI "); ok {
				origin = value
			}
			if value, ok := strings.CutPrefix(line, "Open "); ok {
				launch = value
			}
			if origin != "" && launch != "" {
				ready <- [2]string{origin, launch}
				return
			}
		}
		close(ready)
	}()
	select {
	case value := <-ready:
		p.origin, p.launch = value[0], value[1]
		if p.origin == "" {
			t.Fatal("UI exited before ready")
		}
	case err := <-p.done:
		t.Fatalf("UI exited: %v", err)
	case <-time.After(20 * time.Second):
		t.Fatal("UI readiness timed out")
	}
	return p
}

func (p *uiProcess) stop(t *testing.T) {
	t.Helper()
	if err := p.command.Process.Signal(syscall.SIGTERM); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-p.done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(8 * time.Second):
		t.Fatal("UI shutdown timed out")
	}
}

func loginUI(t *testing.T, p *uiProcess) *http.Client {
	t.Helper()
	launch, err := url.Parse(p.launch)
	if err != nil {
		t.Fatal(err)
	}
	secret := strings.TrimPrefix(launch.Fragment, "session=")
	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatal(err)
	}
	client := &http.Client{Jar: jar, Timeout: 5 * time.Second}
	data, _ := json.Marshal(map[string]string{"token": secret})
	r, _ := http.NewRequest("POST", p.origin+"/ui/session", bytes.NewReader(data))
	r.Header.Set("Origin", p.origin)
	r.Header.Set("Content-Type", "application/json")
	response, err := client.Do(r)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != 204 {
		t.Fatal("bootstrap login", response.StatusCode)
	}
	for _, cookie := range response.Cookies() {
		if !cookie.HttpOnly || cookie.Value == secret {
			t.Fatal("unsafe session")
		}
	}
	return client
}

func TestHeadlessCLIConcurrentStartupBrowserAndCollectorLifetimes(t *testing.T) {
	binary := buildCLI(t)
	state := shortState(t)
	env := processEnvironment(state)
	var group sync.WaitGroup
	results := make(chan error, 4)
	for range 4 {
		group.Go(func() {
			ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
			defer cancel()
			command := exec.CommandContext(ctx, binary, "server", "start")
			command.Env = env
			_, err := command.CombinedOutput()
			results <- err
		})
	}
	group.Wait()
	close(results)
	for err := range results {
		if err != nil {
			t.Fatal("concurrent startup", err)
		}
	}
	collectorCleanup(t, binary, env)
	var status domain.ServerStatus
	if err := json.Unmarshal([]byte(cli(t, binary, env, "server", "status")), &status); err != nil || !status.Ready || status.PID == 0 {
		t.Fatalf("status %+v %v", status, err)
	}
	connection, err := apiclient.LocalConnection(state)
	if err != nil {
		t.Fatal(err)
	}
	admin, err := apiclient.NewConnection(connection)
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close()
	source, err := admin.CreateSource(context.Background(), domain.SourceRequest{Name: "Process evidence"})
	if err != nil {
		t.Fatal(err)
	}
	p := startUIProcess(t, binary, env, "browser", "--no-open")
	client := loginUI(t, p)
	response, err := client.Get(p.origin + "/api/v1/sources")
	if err != nil {
		t.Fatal(err)
	}
	data, err := io.ReadAll(response.Body)
	response.Body.Close()
	if err != nil || response.StatusCode != 200 || !strings.Contains(string(data), source.Source.ID) {
		t.Fatalf("Unix gateway: %d %s %v", response.StatusCode, data, err)
	}
	p.stop(t)
	if response, err := client.Get(p.origin + "/"); err == nil {
		response.Body.Close()
		t.Fatal("UI survived shutdown")
	}
	after, err := admin.Status(context.Background())
	if err != nil || after.PID != status.PID {
		t.Fatalf("collector changed after UI exit %+v %v", after, err)
	}
	if _, err := admin.CreateSource(context.Background(), domain.SourceRequest{Name: "After UI exit"}); err != nil {
		t.Fatal("collector no longer writes", err)
	}
}

func TestDesktopFailureFallsBackWithoutCredentialArguments(t *testing.T) {
	binary := buildCLI(t)
	state := shortState(t)
	capture := filepath.Join(filepath.Dir(binary), "arguments")
	fake := filepath.Join(filepath.Dir(binary), "tool-logger-desktop")
	if err := os.WriteFile(fake, []byte("#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$CAPTURE\"\nexit 1\n"), 0700); err != nil {
		t.Fatal(err)
	}
	opener := filepath.Join(filepath.Dir(binary), "xdg-open")
	if err := os.WriteFile(opener, []byte("#!/bin/sh\nexit 0\n"), 0700); err != nil {
		t.Fatal(err)
	}
	env := processEnvironment(state, "CAPTURE="+capture, "PATH="+filepath.Dir(binary)+":"+os.Getenv("PATH"))
	p := startUIProcess(t, binary, env)
	collectorCleanup(t, binary, env)
	args, err := os.ReadFile(capture)
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(string(args)), "\n")
	if len(lines) != 2 || lines[0] != "--connection" {
		t.Fatalf("desktop arguments: %q", args)
	}
	connection, err := apiclient.LoadConnection(lines[1])
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(args), connection.Token) || strings.Contains(p.launch, connection.Token) {
		t.Fatal("credential in process arguments or browser URL")
	}
	loginUI(t, p)
	p.stop(t)
	if _, err := os.Stat(lines[1]); !os.IsNotExist(err) {
		t.Fatal("transient local descriptor retained", err)
	}
}

func TestRemoteCommandConnectAndPinnedBrowserUseIndependentHistory(t *testing.T) {
	binary := buildCLI(t)
	state := shortState(t)
	env := processEnvironment(state)
	output := cli(t, binary, env, "remote", "--listen", "127.0.0.1:0", "--advertise", "127.0.0.1:0")
	collectorCleanup(t, binary, env)
	invitation, ok := strings.CutPrefix(output, "tool-logger connect '")
	if !ok || !strings.HasSuffix(invitation, "'") {
		t.Fatal("connect command not shell quoted", output)
	}
	invitation = strings.TrimSuffix(invitation, "'")
	connection, err := apiclient.LocalConnection(state)
	if err != nil {
		t.Fatal(err)
	}
	admin, err := apiclient.NewConnection(connection)
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close()
	if _, err := admin.CreateSource(context.Background(), domain.SourceRequest{Name: "Remote-only evidence"}); err != nil {
		t.Fatal(err)
	}
	// A successful companion lets connect return after saving the real paired
	// credential. Native window behavior is covered by the e2e-tagged suite.
	fake := filepath.Join(filepath.Dir(binary), "tool-logger-desktop")
	if err := os.WriteFile(fake, []byte("#!/bin/sh\nexit 0\n"), 0700); err != nil {
		t.Fatal(err)
	}
	clientState := shortState(t)
	clientEnv := processEnvironment(clientState)
	saved := strings.TrimPrefix(cli(t, binary, clientEnv, "connect", invitation), "Connection saved: ")
	paired, err := apiclient.LoadConnection(saved)
	if err != nil {
		t.Fatal(err)
	}
	if paired.ServerID != connection.ServerID || paired.Token == connection.Token || paired.Fingerprint == "" {
		t.Fatal("invalid paired descriptor")
	}
	p := startUIProcess(t, binary, clientEnv, "browser", "--no-open", "--connection", saved)
	client := loginUI(t, p)
	response, err := client.Get(p.origin + "/api/v1/sources")
	if err != nil {
		t.Fatal(err)
	}
	data, _ := io.ReadAll(response.Body)
	response.Body.Close()
	if response.StatusCode != 200 || !strings.Contains(string(data), "Remote-only evidence") {
		t.Fatalf("pinned gateway: %d %s", response.StatusCode, data)
	}
	if _, err := os.Stat(filepath.Join(clientState, "collector")); !os.IsNotExist(err) {
		t.Fatal("remote UI started local collector")
	}
	p.stop(t)
	if _, err := apiclient.LoadConnection(saved); err != nil {
		t.Fatal("saved connection removed", err)
	}
}

func TestVersionNeedsNeitherDisplayNorState(t *testing.T) {
	state := filepath.Join(t.TempDir(), "absent")
	t.Setenv("TOOL_LOGGER_STATE_DIR", state)
	var output bytes.Buffer
	if err := runArgs(context.Background(), []string{"--version"}, &output, &output); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(output.String(), "tool-logger dev") {
		t.Fatal(output.String())
	}
	if _, err := os.Stat(state); !os.IsNotExist(err) {
		t.Fatal("version touched state", err)
	}
}

func TestPluginCommandPassesSelectionAndKeepsOneWorkerAcrossUIExit(t *testing.T) {
	binary := buildCLI(t)
	state := shortState(t)
	env := processEnvironment(state)
	bundle := filepath.Join(t.TempDir(), "bundle with spaces")
	transport := filepath.Join(bundle, "plugins", "codex-tool-logger", "transport")
	if err := os.MkdirAll(transport, 0700); err != nil {
		t.Fatal(err)
	}
	// Installer selection and persistent worker path are the CLI's boundary.
	// Harness trust and delivery are exercised by their owning packages.
	installer := `import { writeFileSync } from "node:fs";
import { join } from "node:path";
const state = process.env.TOOL_LOGGER_STATE_DIR;
if (!state) throw new Error("state missing");
writeFileSync(join(state,"selection"),process.argv[2] ?? "");
`
	if err := os.MkdirAll(state, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(bundle, "install.ts"), []byte(installer), 0600); err != nil {
		t.Fatal(err)
	}
	worker := `process.on("SIGTERM",()=>process.exit(0)); setInterval(()=>{},1000);`
	if err := os.WriteFile(filepath.Join(transport, "cli.ts"), []byte(worker), 0600); err != nil {
		t.Fatal(err)
	}
	cli(t, binary, env, "plugins", "install", "all", "--bundle", bundle)
	collectorCleanup(t, binary, env)
	selection, err := os.ReadFile(filepath.Join(state, "selection"))
	if err != nil || string(selection) != "all" {
		t.Fatalf("installer selection %q %v", selection, err)
	}
	connection, err := apiclient.LocalConnection(state)
	if err != nil {
		t.Fatal(err)
	}
	admin, err := apiclient.NewConnection(connection)
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close()
	var before domain.ServerStatus
	deadline := time.Now().Add(5 * time.Second)
	for {
		before, err = admin.Status(context.Background())
		if err == nil && before.WorkerPID > 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("worker not ready %+v %v", before, err)
		}
		time.Sleep(20 * time.Millisecond)
	}
	sourceBefore, err := os.ReadFile(filepath.Join(state, "source.json"))
	if err != nil {
		t.Fatal(err)
	}
	cli(t, binary, env, "plugins", "install", "all", "--bundle", bundle)
	sourceAfter, err := os.ReadFile(filepath.Join(state, "source.json"))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(sourceBefore, sourceAfter) {
		t.Fatal("reinstall changed source identity/config")
	}
	p := startUIProcess(t, binary, env, "browser", "--no-open")
	loginUI(t, p)
	p.stop(t)
	after, err := admin.Status(context.Background())
	if err != nil || after.PID != before.PID || after.WorkerPID != before.WorkerPID {
		t.Fatalf("UI exit/reinstall changed collector/worker: before %+v after %+v %v", before, after, err)
	}
}
