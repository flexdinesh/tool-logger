package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"tool-logger/apps/server/internal/httpapi"
	"tool-logger/apps/server/internal/sqlite"
	"tool-logger/packages/client"
	"tool-logger/packages/protocol"
)

func TestMain(m *testing.M) {
	if len(os.Args) == 3 && os.Args[1] == "server" && os.Args[2] == "run" {
		ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		defer cancel()
		if err := Run(ctx, Config{State: os.Getenv("TOOL_LOGGER_STATE_DIR")}); err != nil {
			os.Stderr.WriteString(err.Error())
			os.Exit(1)
		}
		os.Exit(0)
	}
	os.Exit(m.Run())
}

func testState(t *testing.T) string {
	t.Helper()
	state, err := os.MkdirTemp("", "tl-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(state) })
	return state
}
func testContext(t *testing.T) context.Context {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	t.Cleanup(cancel)
	return ctx
}
func eventually(t *testing.T, check func() bool) {
	t.Helper()
	if !waitFor(8*time.Second, check) {
		t.Fatal("condition did not become true")
	}
}
func collectorEvidence(state string) string {
	directory := filepath.Join(state, "collector")
	var evidence strings.Builder
	for _, name := range []string{"server.lock", "worker.lock"} {
		lock, err := lockFile(filepath.Join(directory, name))
		if err == nil {
			unlockFile(lock)
		}
		fmt.Fprintf(&evidence, "%s lock attempt: %v\n", name, err)
	}
	for _, name := range []string{"server.log", "worker.log"} {
		content, err := os.ReadFile(filepath.Join(directory, name))
		fmt.Fprintf(&evidence, "%s (%v):\n%s\n", name, err, content)
	}
	return evidence.String()
}
func waitFor(wait time.Duration, check func() bool) bool {
	deadline := time.Now().Add(wait)
	for time.Now().Before(deadline) {
		if check() {
			return true
		}
		time.Sleep(25 * time.Millisecond)
	}
	return false
}

func TestCollectorProcessConcurrentStartupDurableDeliveryAndShutdown(t *testing.T) {
	state := testState(t)
	ctx := testContext(t)
	t.Cleanup(func() {
		stopCtx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
		defer cancel()
		_ = Stop(stopCtx, state)
	})
	var wg sync.WaitGroup
	results := make(chan error, 10)
	for range 10 {
		wg.Go(func() { results <- Ensure(ctx, state) })
	}
	wg.Wait()
	close(results)
	for err := range results {
		if err != nil {
			t.Fatal(err)
		}
	}
	initial, err := Status(ctx, state)
	if err != nil || !initial.Ready || initial.PID == os.Getpid() {
		t.Fatalf("background readiness: %+v %v", initial, err)
	}
	if err := Run(ctx, Config{State: state}); err == nil {
		t.Fatal("second writer started")
	}
	connection, err := apiclient.LocalConnection(state)
	if err != nil {
		t.Fatal(err)
	}
	client, err := apiclient.NewConnection(connection)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	workerPath, err := filepath.Abs("../../packages/transport/src/cli.ts")
	if err != nil {
		t.Fatal(err)
	}
	config, err := client.EnsureLocalSource(ctx, workerPath)
	if err != nil {
		t.Fatal(err)
	}
	eventually(t, func() bool { s, e := Status(ctx, state); return e == nil && s.WorkerPID > 0 })
	before, err := Status(ctx, state)
	if err != nil {
		t.Fatal(err)
	}
	for range 5 {
		next, err := client.EnsureLocalSource(ctx, workerPath)
		if err != nil || next.SourceID != config.SourceID || next.Token != config.Token {
			t.Fatalf("provisioning changed identity: %v", err)
		}
	}
	after, err := Status(ctx, state)
	if err != nil || before.WorkerPID != after.WorkerPID {
		t.Fatalf("provisioning duplicated worker: %+v %+v %v", before, after, err)
	}
	sources, err := client.Sources(ctx)
	if err != nil || len(sources.Data) != 1 {
		t.Fatalf("sources: %+v %v", sources, err)
	}
	root, err := filepath.Abs("../..")
	if err != nil {
		t.Fatal(err)
	}
	for _, hook := range []string{"PreToolUse", "PostToolUse"} {
		payload, _ := json.Marshal(map[string]interface{}{"hook_event_name": hook, "tool_name": "exec_command", "tool_use_id": "process-call", "session_id": "session", "cwd": state, "tool_input": map[string]string{"cmd": "pwd"}, "tool_response": "result"})
		command := exec.CommandContext(ctx, "node", filepath.Join(root, "plugins/codex-tool-logger/scripts/log-tool-call.ts"))
		command.Env = replaceEnv(os.Environ(), "TOOL_LOGGER_STATE_DIR", state)
		command.Stdin = bytes.NewReader(payload)
		if output, err := command.CombinedOutput(); err != nil || len(output) != 0 {
			t.Fatalf("plugin: %v %s", err, output)
		}
	}
	eventually(t, func() bool {
		page, e := client.Calls(ctx, nil)
		return e == nil && len(page.Data) == 1 && page.Data[0].Lifecycle == "finished"
	})
	eventually(t, func() bool { _, e := os.Stat(filepath.Join(state, "outbox", "checkpoint.json")); return e == nil })
	checkpoint, err := os.ReadFile(filepath.Join(state, "outbox", "checkpoint.json"))
	if err != nil {
		t.Fatal(err)
	}
	client.Close() // Window/client exit must not end collection.
	if status, err := Status(ctx, state); err != nil || status.PID != initial.PID {
		t.Fatalf("client exit stopped collector: %v", err)
	}
	if err := syscall.Kill(after.WorkerPID, syscall.SIGKILL); err != nil {
		t.Fatal(err)
	}
	eventually(t, func() bool {
		s, e := Status(ctx, state)
		return e == nil && s.WorkerPID > 0 && s.WorkerPID != after.WorkerPID
	})
	worker, err := Status(ctx, state)
	if err != nil {
		t.Fatal(err)
	}
	if err := Stop(ctx, state); err != nil {
		t.Fatal(err)
	}
	if err := syscall.Kill(worker.WorkerPID, 0); !errors.Is(err, syscall.ESRCH) {
		t.Fatalf("worker survived stop: %v", err)
	}
	if err := Ensure(ctx, state); err != nil {
		t.Fatal(err)
	}
	restarted, err := Status(ctx, state)
	if err != nil || restarted.PID == initial.PID || restarted.ServerID != initial.ServerID {
		t.Fatalf("restart: %+v %v", restarted, err)
	}
	client2, err := apiclient.NewConnection(connection)
	if err != nil {
		t.Fatal(err)
	}
	defer client2.Close()
	page, err := client2.Calls(ctx, nil)
	if err != nil || len(page.Data) != 1 {
		t.Fatalf("history lost: %+v %v", page, err)
	}
	var persisted domain.SourceConfig
	if err := readPrivate(filepath.Join(state, "source.json"), &persisted); err != nil || persisted.SourceID != config.SourceID || persisted.Token != config.Token {
		t.Fatalf("identity lost: %v", err)
	}
	newCheckpoint, err := os.ReadFile(filepath.Join(state, "outbox", "checkpoint.json"))
	if err != nil || !bytes.Equal(checkpoint, newCheckpoint) {
		t.Fatalf("checkpoint altered on restart: %v", err)
	}
}

func TestTLSInvitationPinReuseExpiryAndRevocation(t *testing.T) {
	state := testState(t)
	ctx := testContext(t)
	store, err := sqlite.Open(filepath.Join(state, "events.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	c := &collector{state: state, store: store, connection: domain.Connection{SchemaVersion: 1, Endpoint: "unix:///unused", Token: "local-admin", ServerID: sqlite.UUID()}, invitations: map[string]time.Time{}}
	c.api = httpapi.New(store, c.connection.Token)
	local := httptest.NewServer(c.localHandler())
	defer local.Close()
	defer c.closeRemote()
	admin, err := apiclient.New(local.URL, c.connection.Token)
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close()
	request := domain.RemoteRequest{Listen: "127.0.0.1:0", Advertise: "127.0.0.1:0"}
	invitation, err := admin.EnableRemote(ctx, request)
	if err != nil {
		t.Fatal(err)
	}
	u, _ := url.Parse(invitation.ConnectionString)
	query := u.Query()
	query.Set("fingerprint", strings.Repeat("0", 64))
	u.RawQuery = query.Encode()
	if _, err := apiclient.Pair(ctx, u.String()); err == nil {
		t.Fatal("wrong TLS pin accepted")
	}
	paired, err := apiclient.Pair(ctx, invitation.ConnectionString)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := apiclient.Pair(ctx, invitation.ConnectionString); err == nil {
		t.Fatal("invitation reused")
	}
	remote, err := apiclient.NewConnection(paired)
	if err != nil {
		t.Fatal(err)
	}
	defer remote.Close()
	if _, err := remote.Sources(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := remote.Status(ctx); err == nil {
		t.Fatal("remote client accessed local control")
	}
	stolen := paired
	stolen.Token = c.connection.Token
	other, err := apiclient.NewConnection(stolen)
	if err != nil {
		t.Fatal(err)
	}
	defer other.Close()
	if _, err := other.Sources(ctx); err == nil {
		t.Fatal("local admin accepted over remote transport")
	}
	expiring, err := admin.EnableRemote(ctx, request)
	if err != nil {
		t.Fatal(err)
	}
	c.mu.Lock()
	for key := range c.invitations {
		c.invitations[key] = time.Now().Add(-time.Second)
	}
	c.mu.Unlock()
	if _, err := apiclient.Pair(ctx, expiring.ConnectionString); err == nil {
		t.Fatal("expired invitation accepted")
	}
	clients, err := admin.RemoteClients(ctx)
	if err != nil || len(clients.Data) != 1 {
		t.Fatalf("clients %+v %v", clients, err)
	}
	if err := admin.RevokeClient(ctx, clients.Data[0].ID); err != nil {
		t.Fatal(err)
	}
	if _, err := remote.Sources(ctx); err == nil {
		t.Fatal("revoked client retained access on keepalive connection")
	}
	if _, err := admin.EnableRemote(ctx, domain.RemoteRequest{Listen: "127.0.0.1:0", Advertise: "0.0.0.0:4317"}); err == nil {
		t.Fatal("wildcard accepted")
	}
	path, err := apiclient.SaveConnection(state, paired)
	if err != nil {
		t.Fatal(err)
	}
	loaded, err := apiclient.LoadConnection(path)
	if err != nil || loaded != paired {
		t.Fatalf("descriptor round trip: %v", err)
	}
	if err := os.Chmod(path, 0644); err != nil {
		t.Fatal(err)
	}
	if _, err := apiclient.LoadConnection(path); err == nil {
		t.Fatal("public credential descriptor accepted")
	}
}

func TestProvisioningRefusesIdentityReassignment(t *testing.T) {
	state := testState(t)
	ctx := testContext(t)
	store, err := sqlite.Open(filepath.Join(state, "events.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	credentials, err := store.CreateSource(ctx, domain.SourceRequest{Name: "Original"})
	if err != nil {
		t.Fatal(err)
	}
	config := domain.SourceConfig{SchemaVersion: 1, SourceID: sqlite.UUID(), Endpoint: "http://localhost:4317", Token: credentials.Token, Name: "Original", Labels: map[string]string{}}
	if err := writePrivate(filepath.Join(state, "source.json"), config); err != nil {
		t.Fatal(err)
	}
	c := &collector{state: state, store: store, connection: domain.Connection{Endpoint: "unix:///tmp/socket"}, workerWake: make(chan struct{}, 1)}
	workerPath, _ := filepath.Abs("../../packages/transport/src/cli.ts")
	if _, err := c.ensureLocalSource(ctx, workerPath); err == nil {
		t.Fatal("reassigned existing source identity")
	}
	var preserved domain.SourceConfig
	if err := readPrivate(filepath.Join(state, "source.json"), &preserved); err != nil || preserved.SourceID != config.SourceID || preserved.Endpoint != config.Endpoint {
		t.Fatalf("source modified on refusal: %v", err)
	}
}

func TestEnsureLaunchesAfterExitingCollectorReleasesLock(t *testing.T) {
	state := testState(t)
	ctx := testContext(t)
	t.Cleanup(func() {
		stopCtx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
		defer cancel()
		_ = Stop(stopCtx, state)
	})
	if err := os.MkdirAll(filepath.Join(state, "collector"), 0700); err != nil {
		t.Fatal(err)
	}
	lock, err := lockFile(filepath.Join(state, "collector", "server.lock"))
	if err != nil {
		t.Fatal(err)
	}
	release := time.AfterFunc(300*time.Millisecond, func() { unlockFile(lock) })
	defer release.Stop()
	if err := Ensure(ctx, state); err != nil {
		t.Fatalf("Ensure after lock release: %v\n%s", err, collectorEvidence(state))
	}
	status, err := Status(ctx, state)
	if err != nil || !status.Ready || status.PID == os.Getpid() {
		t.Fatalf("collector %+v: %v", status, err)
	}
}

func TestCollectorCrashReleasesWorkerAndRetainsRemoteIdentity(t *testing.T) {
	state := testState(t)
	ctx := testContext(t)
	t.Cleanup(func() {
		stopCtx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
		defer cancel()
		_ = Stop(stopCtx, state)
	})
	if err := Ensure(ctx, state); err != nil {
		t.Fatal(err)
	}
	connection, err := apiclient.LocalConnection(state)
	if err != nil {
		t.Fatal(err)
	}
	local, err := apiclient.NewConnection(connection)
	if err != nil {
		t.Fatal(err)
	}
	defer local.Close()
	workerPath, _ := filepath.Abs("../../packages/transport/src/cli.ts")
	if _, err := local.EnsureLocalSource(ctx, workerPath); err != nil {
		t.Fatal(err)
	}
	eventually(t, func() bool { s, e := Status(ctx, state); return e == nil && s.WorkerPID > 0 })
	before, err := Status(ctx, state)
	if err != nil {
		t.Fatal(err)
	}
	invitation, err := local.EnableRemote(ctx, domain.RemoteRequest{Listen: "127.0.0.1:0", Advertise: "127.0.0.1:0"})
	if err != nil {
		t.Fatal(err)
	}
	paired, err := apiclient.Pair(ctx, invitation.ConnectionString)
	if err != nil {
		t.Fatal(err)
	}
	remote, err := apiclient.NewConnection(paired)
	if err != nil {
		t.Fatal(err)
	}
	defer remote.Close()
	source, err := remote.CreateSource(ctx, domain.SourceRequest{Name: "TLS source"})
	if err != nil {
		t.Fatal(err)
	}
	fixture, err := os.ReadFile("../../packages/protocol/fixtures/events.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixtures struct {
		Valid []domain.Event `json:"valid"`
	}
	if err := json.Unmarshal(fixture, &fixtures); err != nil {
		t.Fatal(err)
	}
	event := fixtures.Valid[0]
	event.SourceID = source.Source.ID
	sourceConnection := paired
	sourceConnection.Token = source.Token
	httpClient, err := apiclient.HTTPClient(sourceConnection)
	if err != nil {
		t.Fatal(err)
	}
	defer httpClient.CloseIdleConnections()
	for i := 0; i < 2; i++ {
		body, _ := json.Marshal(domain.IngestRequest{Events: []domain.Event{event}})
		request, err := http.NewRequestWithContext(ctx, "POST", apiclient.BaseURL(paired)+"/api/v1/ingest/events", bytes.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		request.Header.Set("Authorization", "Bearer "+source.Token)
		request.Header.Set("Content-Type", "application/json")
		response, err := httpClient.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		var ack domain.Acknowledgement
		err = json.NewDecoder(response.Body).Decode(&ack)
		response.Body.Close()
		if err != nil || response.StatusCode != 200 || len(ack.Accepted)+len(ack.Duplicates) != 1 || (i == 1 && len(ack.Duplicates) != 1) {
			t.Fatalf("TLS durable ACK %d: %+v %v", response.StatusCode, ack, err)
		}
	}
	if err := syscall.Kill(before.PID, syscall.SIGKILL); err != nil {
		t.Fatal(err)
	}
	eventually(t, func() bool { _, e := Status(ctx, state); return e != nil })
	if err := Ensure(ctx, state); err != nil {
		t.Fatalf("restart after crash: %v\n%s", err, collectorEvidence(state))
	}
	// The replacement retries worker.lock at about 0.5s, 1.5s, 3.5s, 7.5s and 15.5s
	// while the orphaned worker exits. Wait past the last retry; dump evidence if it fails.
	var last domain.ServerStatus
	var lastErr error
	if !waitFor(20*time.Second, func() bool {
		last, lastErr = Status(ctx, state)
		return lastErr == nil && last.PID != before.PID && last.WorkerPID > 0 && last.WorkerPID != before.WorkerPID
	}) {
		t.Fatalf("worker not replaced: before=%+v last=%+v err=%v oldWorkerSignal0=%v\n%s",
			before, last, lastErr, syscall.Kill(before.WorkerPID, 0), collectorEvidence(state))
	}
	page, err := remote.Calls(ctx, nil)
	if err != nil || len(page.Data) != 1 {
		t.Fatalf("TLS identity, credential or data lost on crash: %+v %v", page, err)
	}
	clients, err := local.RemoteClients(ctx)
	if err != nil || len(clients.Data) != 1 {
		t.Fatalf("client persistence: %v", err)
	}
	if err := local.RevokeClient(ctx, clients.Data[0].ID); err != nil {
		t.Fatal(err)
	}
	if _, err := remote.Calls(ctx, nil); err == nil {
		t.Fatal("persistent client revocation failed")
	}
}

func TestProvisioningRecoversAfterDatabaseCommitAndMigratesExistingEndpoint(t *testing.T) {
	state := testState(t)
	ctx := testContext(t)
	store, err := sqlite.Open(filepath.Join(state, "events.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	credentials, err := store.CreateSource(ctx, domain.SourceRequest{Name: "Original"})
	if err != nil {
		t.Fatal(err)
	}
	config := domain.SourceConfig{SchemaVersion: 1, SourceID: credentials.Source.ID, Endpoint: "http://127.0.0.1:4317", Token: credentials.Token, Name: "Original", Labels: map[string]string{}}
	if err := writePrivate(filepath.Join(state, "collector", "pending-source.json"), config); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(state, "outbox"), 0700); err != nil {
		t.Fatal(err)
	}
	for _, file := range []string{"checkpoint.json", "codex-tool-calls.jsonl"} {
		if err := os.WriteFile(filepath.Join(state, "outbox", file), []byte("existing evidence\n"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	c := &collector{state: state, store: store, connection: domain.Connection{Endpoint: "unix:///tmp/private.sock"}, workerWake: make(chan struct{}, 1)}
	workerPath, _ := filepath.Abs("../../packages/transport/src/cli.ts")
	for range 2 {
		recovered, err := c.ensureLocalSource(ctx, workerPath)
		if err != nil || recovered.SourceID != config.SourceID || recovered.Token != config.Token || recovered.Endpoint != c.connection.Endpoint {
			t.Fatalf("recovery changed identity: %v", err)
		}
	}
	sources, err := store.Sources(ctx)
	if err != nil || len(sources.Data) != 1 {
		t.Fatalf("provisioning duplicated source: %+v %v", sources, err)
	}
	for _, file := range []string{"checkpoint.json", "codex-tool-calls.jsonl"} {
		data, err := os.ReadFile(filepath.Join(state, "outbox", file))
		if err != nil || string(data) != "existing evidence\n" {
			t.Fatalf("migration modified evidence %s: %v", file, err)
		}
	}
}

func TestStopIsIdempotentWithoutCreatingCollectorState(t *testing.T) {
	state := filepath.Join(t.TempDir(), "unopened")
	for range 2 {
		if err := Stop(context.Background(), state); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := os.Stat(state); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("stop created state: %v", err)
	}
	if err := privateDirectory(filepath.Join(state, "collector")); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if err := Stop(context.Background(), state); err != nil {
			t.Fatal(err)
		}
	}
}

func TestCollectorHasNoUIDependencies(t *testing.T) {
	command := exec.CommandContext(testContext(t), "go", "list", "-deps", "tool-logger/apps/server")
	output, err := command.Output()
	if err != nil {
		t.Fatal(err)
	}
	for _, dependency := range strings.Fields(string(output)) {
		if strings.HasPrefix(dependency, "github.com/egoist/mygo") || dependency == "tool-logger/packages/webui" || strings.HasPrefix(dependency, "tool-logger/apps/desktop") || strings.HasPrefix(dependency, "tool-logger/apps/web") {
			t.Errorf("headless collector imports UI dependency: %s", dependency)
		}
	}
}

func TestCollectorRefusesUnexpectedSocketFileAndReportsStartupFailure(t *testing.T) {
	state := testState(t)
	if err := privateDirectory(filepath.Join(state, "collector")); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(state, "collector", "collector.sock")
	if err := os.WriteFile(path, []byte("preserve this file"), 0600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := Ensure(ctx, state); err == nil || !strings.Contains(err.Error(), "exited before readiness") {
		t.Fatalf("failed startup not diagnosed: %v", err)
	}
	data, err := os.ReadFile(path)
	if err != nil || string(data) != "preserve this file" {
		t.Fatalf("unexpected socket file modified: %v", err)
	}
}
