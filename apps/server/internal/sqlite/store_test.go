package sqlite

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"tool-logger/packages/protocol"
	"tool-logger/apps/server/internal/harnesses"
)

var ctx = context.Background()

func openTest(t testing.TB) (*Store, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "history.sqlite")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return s, path
}
func sourceTest(t testing.TB, s *Store) domain.SourceCredentials {
	t.Helper()
	c, err := s.CreateSource(ctx, domain.SourceRequest{Name: "Workstation", Hostname: "host", Platform: "linux", Labels: map[string]string{"service.name": "tool-logger"}})
	if err != nil {
		t.Fatal(err)
	}
	return c
}
func eventTest(source, call, phase, harness string, version int, stamp time.Time) domain.Event {
	id := UUID()
	hook := "PreToolUse"
	if phase == "post" {
		hook = "PostToolUse"
	}
	n := map[string]interface{}{"hook_event_name": hook, "tool_use_id": call, "session_id": "session", "turn_id": "turn", "tool_name": "shell", "tool_input": map[string]string{"command": "pwd"}, "tool_response": "/work", "cwd": "/work"}
	if harness == "opencode" {
		hook = "tool.execute.before"
		if phase == "post" {
			hook = "tool.execute.after"
		}
		if version == 1 {
			n = map[string]interface{}{"input": map[string]interface{}{"callID": call, "sessionID": "session", "tool": "shell", "args": map[string]string{"command": "pwd"}}, "output": map[string]interface{}{"args": map[string]string{"command": "pwd"}, "output": "/work", "metadata": map[string]int{"exit": 0}}}
		} else {
			n = map[string]interface{}{"id": call, "sessionID": "session", "tool": "shell", "status": "success", "input": map[string]string{"command": "pwd"}, "result": map[string]string{"content": "/work"}, "agent": "builder"}
		}
	}
	recorded := stamp.UTC().Format(time.RFC3339Nano)
	w := map[string]interface{}{"schema_version": 2, "event_id": id, "logged_at": recorded, "harness": harness, "hook": hook, "event": n, "metadata": map[string]interface{}{"session_cwd": "/work", "git": map[string]interface{}{"root": "/work", "branch": "main", "dirty": false}}}
	if version > 0 {
		w["api_version"] = version
	}
	b, _ := json.Marshal(w)
	return domain.Event{SchemaVersion: 1, SourceID: source, EventID: id, Harness: harness, RecordedAt: recorded, Native: b}
}
func queryTest(t testing.TB, values url.Values) Query {
	t.Helper()
	q, err := ParseQuery(values)
	if err != nil {
		t.Fatal(err)
	}
	return q
}
func countTest(t testing.TB, s *Store, table string) int {
	t.Helper()
	var n int
	if err := s.db.QueryRow("SELECT count(*) FROM " + table).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}
func statusTest(t testing.TB, err error, status int) {
	t.Helper()
	var problem *Error
	if !errors.As(err, &problem) || problem.Status != status {
		t.Fatalf("want status %d, got %v", status, err)
	}
}

func TestAtomicReplayLatePairingAndRestart(t *testing.T) {
	s, path := openTest(t)
	c := sourceTest(t, s)
	stamp := time.Date(2026, 11, 4, 1, 0, 0, 0, time.UTC)
	pre := eventTest(c.Source.ID, "call", "pre", "codex", 0, stamp)
	post := eventTest(c.Source.ID, "call", "post", "codex", 0, stamp.Add(time.Second))
	ack, err := s.Ingest(ctx, c.Source.ID, []domain.Event{post})
	if err != nil || len(ack.Accepted) != 1 {
		t.Fatalf("ack: %+v %v", ack, err)
	}
	page, err := s.Calls(ctx, queryTest(t, nil))
	if err != nil || len(page.Data) != 1 || page.Data[0].Lifecycle != "result-only" {
		t.Fatalf("page: %+v %v", page, err)
	}
	id, observed := page.Data[0].ID, page.Data[0].ObservedAt
	if _, err = s.Ingest(ctx, c.Source.ID, []domain.Event{pre}); err != nil {
		t.Fatal(err)
	}
	d, err := s.Call(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	if d.Summary.ID != id || d.Summary.ObservedAt != observed || d.Summary.Lifecycle != "finished" || d.Summary.Outcome != "unknown" || d.Summary.DurationMs == nil || *d.Summary.DurationMs != 1000 || len(d.Native.Events) != 2 {
		t.Fatalf("late pair lost evidence: %+v", d)
	}
	ack, err = s.Ingest(ctx, c.Source.ID, []domain.Event{pre, post, pre})
	if err != nil || len(ack.Accepted) != 0 || len(ack.Duplicates) != 3 {
		t.Fatalf("duplicate batch: %+v %v", ack, err)
	}
	if err = s.Close(); err != nil {
		t.Fatal(err)
	}
	s, err = Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	ack, err = s.Ingest(ctx, c.Source.ID, []domain.Event{post})
	if err != nil || len(ack.Duplicates) != 1 || countTest(t, s, "events") != 2 || countTest(t, s, "calls") != 1 {
		t.Fatalf("restart lost ack: %+v %v", ack, err)
	}
	if _, err = s.AuthenticateSource(ctx, c.Token); err != nil {
		t.Fatal(err)
	}
}

func TestConflictsAndProjectionFailureRollBackBatch(t *testing.T) {
	s, _ := openTest(t)
	c := sourceTest(t, s)
	at := time.Now()
	e := eventTest(c.Source.ID, "call", "pre", "codex", 0, at)
	if _, err := s.Ingest(ctx, c.Source.ID, []domain.Event{e}); err != nil {
		t.Fatal(err)
	}
	newEvent := eventTest(c.Source.ID, "new", "pre", "codex", 0, at)
	changed := e
	changed.Native = append([]byte(" \n"), changed.Native...)
	ack, err := s.Ingest(ctx, c.Source.ID, []domain.Event{newEvent, changed})
	statusTest(t, err, 409)
	if len(ack.Accepted) != 0 || len(ack.Duplicates) != 0 {
		t.Fatal("returned acknowledgement for rolled-back events")
	}
	if countTest(t, s, "events") != 1 || countTest(t, s, "calls") != 1 {
		t.Fatal("partial conflicting batch committed")
	}
	occupied := eventTest(c.Source.ID, "call", "pre", "codex", 0, at)
	_, err = s.Ingest(ctx, c.Source.ID, []domain.Event{occupied})
	statusTest(t, err, 409)
	if _, err = s.db.Exec(`CREATE TRIGGER fail_projection BEFORE INSERT ON calls BEGIN SELECT RAISE(ABORT,'simulated disk/projection failure'); END`); err != nil {
		t.Fatal(err)
	}
	if _, err = s.Ingest(ctx, c.Source.ID, []domain.Event{newEvent}); err == nil {
		t.Fatal("acknowledged failed projection")
	}
	if countTest(t, s, "events") != 1 || countTest(t, s, "calls") != 1 {
		t.Fatal("raw event committed without projection")
	}
	for _, sql := range []string{"DELETE FROM events", "UPDATE events SET received_at='tampered'"} {
		if _, err = s.db.Exec(sql); err == nil {
			t.Fatal("raw event mutation allowed")
		}
	}
	var native []byte
	if err = s.db.QueryRow("SELECT native FROM events").Scan(&native); err != nil {
		t.Fatal(err)
	}
	if string(native) != string(e.Native) {
		t.Fatal("native bytes changed")
	}
}

func TestSourceIsolationMissingIDsAndMixedVersions(t *testing.T) {
	s, _ := openTest(t)
	a := sourceTest(t, s)
	b := sourceTest(t, s)
	at := time.Now()
	events := []domain.Event{eventTest(a.Source.ID, "same", "pre", "opencode", 1, at), eventTest(a.Source.ID, "same", "post", "opencode", 2, at), eventTest(a.Source.ID, "", "pre", "codex", 0, at), eventTest(a.Source.ID, "", "post", "codex", 0, at)}
	if _, err := s.Ingest(ctx, a.Source.ID, events); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Ingest(ctx, b.Source.ID, []domain.Event{eventTest(b.Source.ID, "same", "post", "opencode", 1, at)}); err != nil {
		t.Fatal(err)
	}
	page, err := s.Calls(ctx, queryTest(t, nil))
	if err != nil || len(page.Data) != 5 {
		t.Fatalf("invented pairs: %+v %v", page, err)
	}
	_, err = s.Ingest(ctx, b.Source.ID, events)
	statusTest(t, err, 403)
	page, err = s.Calls(ctx, queryTest(t, url.Values{"source": {a.Source.ID}, "harness": {"opencode"}}))
	if err != nil || len(page.Data) != 2 {
		t.Fatalf("source/harness scope: %+v %v", page, err)
	}
	for _, v := range page.Data {
		if v.HarnessAPIVersion != nil && *v.HarnessAPIVersion == "1" && v.Outcome != "unknown" {
			t.Fatal("V1 fabricated outcome")
		}
	}
}

func TestSourceCredentialLifecycleAndHealth(t *testing.T) {
	s, _ := openTest(t)
	c := sourceTest(t, s)
	if c.Source.Status != "never-seen" {
		t.Fatal(c.Source.Status)
	}
	var stored string
	if err := s.db.QueryRow("SELECT token_hash FROM sources WHERE id=?", c.Source.ID).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if stored == c.Token || stored != hash(c.Token) {
		t.Fatal("credential not hashed")
	}
	beat := domain.Heartbeat{SourceID: c.Source.ID, Hostname: "newhost", Platform: "darwin", Labels: map[string]string{"container.id": "abc"}}
	if err := s.Heartbeat(ctx, c.Source.ID, beat); err != nil {
		t.Fatal(err)
	}
	check := func(want string) {
		t.Helper()
		v, err := s.Source(ctx, c.Source.ID)
		if err != nil || v.Status != want {
			t.Fatalf("want %s got %+v %v", want, v, err)
		}
	}
	check("online")
	beat.PendingEvents = 2
	if err := s.Heartbeat(ctx, c.Source.ID, beat); err != nil {
		t.Fatal(err)
	}
	check("degraded")
	if _, err := s.db.Exec("UPDATE sources SET last_seen=? WHERE id=?", time.Now().Add(-2*time.Minute).Format(time.RFC3339Nano), c.Source.ID); err != nil {
		t.Fatal(err)
	}
	check("stale")
	if err := s.RevokeToken(ctx, c.Source.ID); err != nil {
		t.Fatal(err)
	}
	check("revoked")
	_, err := s.AuthenticateSource(ctx, c.Token)
	statusTest(t, err, 401)
	rotated, err := s.RotateToken(ctx, c.Source.ID)
	if err != nil {
		t.Fatal(err)
	}
	if rotated.Token == c.Token {
		t.Fatal("rotation reused token")
	}
	if _, err = s.AuthenticateSource(ctx, rotated.Token); err != nil {
		t.Fatal(err)
	}
	_, err = s.AuthenticateSource(ctx, c.Token)
	statusTest(t, err, 401)
	beat.SourceID = UUID()
	statusTest(t, s.Heartbeat(ctx, c.Source.ID, beat), 403)
}

func TestStableCursorNewEventsAndEveryFilterScope(t *testing.T) {
	s, _ := openTest(t)
	c := sourceTest(t, s)
	at := time.Now()
	batch := []domain.Event{}
	for i := 0; i < 7; i++ {
		batch = append(batch, eventTest(c.Source.ID, fmt.Sprint(i), "pre", "codex", 0, at.Add(time.Duration(i)*time.Second)))
	}
	if _, err := s.Ingest(ctx, c.Source.ID, batch); err != nil {
		t.Fatal(err)
	}
	values := url.Values{"source": {c.Source.ID}, "limit": {"2"}}
	q := queryTest(t, values)
	page, err := s.Calls(ctx, q)
	if err != nil || page.Page.NextCursor == nil {
		t.Fatalf("first page: %+v %v", page, err)
	}
	seen := map[string]bool{}
	for _, call := range page.Data {
		seen[call.ID] = true
	}
	cursorValue := *page.Page.NextCursor
	// Both a new latest row and a backdated row must be excluded from this walk.
	if _, err = s.Ingest(ctx, c.Source.ID, []domain.Event{eventTest(c.Source.ID, "new", "pre", "codex", 0, at.Add(time.Hour)), eventTest(c.Source.ID, "backdated", "pre", "codex", 0, at.Add(-time.Hour))}); err != nil {
		t.Fatal(err)
	}
	for {
		q.Cursor = *page.Page.NextCursor
		page, err = s.Calls(ctx, q)
		if err != nil {
			t.Fatal(err)
		}
		for _, call := range page.Data {
			if seen[call.ID] {
				t.Fatal("duplicate page row")
			}
			seen[call.ID] = true
		}
		if !page.Page.HasMore {
			break
		}
	}
	if len(seen) != 7 {
		t.Fatalf("walk got %d rows", len(seen))
	}
	for key, v := range map[string]string{"source": UUID(), "harness": "opencode", "q": "changed", "lifecycle": "finished", "outcome": "success", "tool": "different", "session": "different", "agent": "different", "repository": "/different", "directory": "/different", "since": "2020-01-01T00:00:00Z", "until": "2030-01-01T00:00:00Z", "limit": "3"} {
		changed := url.Values{}
		for key, items := range values {
			changed[key] = append([]string{}, items...)
		}
		changed.Set(key, v)
		changed.Set("cursor", cursorValue)
		_, err = s.Calls(ctx, queryTest(t, changed))
		statusTest(t, err, 400)
	}
	// Ordering and duplicate filters normalize to the same cursor fingerprint.
	values.Set("cursor", cursorValue)
	values["source"] = []string{c.Source.ID, c.Source.ID}
	if _, err = s.Calls(ctx, queryTest(t, values)); err != nil {
		t.Fatal(err)
	}
}

func TestFacetsMetricsAndLiteralSearch(t *testing.T) {
	s, _ := openTest(t)
	c := sourceTest(t, s)
	at := time.Now()
	events := []domain.Event{}
	for _, tc := range []struct {
		h  string
		v  int
		id string
	}{{"codex", 0, "c"}, {"opencode", 1, "v1"}, {"opencode", 2, "v2"}} {
		events = append(events, eventTest(c.Source.ID, tc.id, "pre", tc.h, tc.v, at), eventTest(c.Source.ID, tc.id, "post", tc.h, tc.v, at.Add(time.Second)))
	}
	events = append(events, eventTest(c.Source.ID, "pending", "pre", "codex", 0, at))
	if _, err := s.Ingest(ctx, c.Source.ID, events); err != nil {
		t.Fatal(err)
	}
	m, err := s.Metrics(ctx, queryTest(t, nil))
	if err != nil {
		t.Fatal(err)
	}
	d := m.Data
	if d.TotalCalls != 4 || d.CompletedCalls != 3 || d.AwaitingCalls != 1 || d.SuccessCalls != 1 || d.UnknownCalls != 3 || d.FailureRate == nil || *d.FailureRate != 0 || d.AverageDurationMs == nil || *d.AverageDurationMs != 1000 {
		t.Fatalf("bad metrics: %+v", d)
	}
	var activity int64
	for _, bucket := range d.Activity {
		activity += bucket.Count
	}
	if activity != 4 || len(d.Activity) > 36 || len(d.ToolUsage) != 1 || d.ToolUsage[0].Count != 4 {
		t.Fatalf("bad grouped metrics: %+v", d)
	}
	f, err := s.Facets(ctx, queryTest(t, url.Values{"tool": {"absent"}, "source": {c.Source.ID}}))
	if err != nil {
		t.Fatal(err)
	}
	if len(f.Data.Tools) != 1 || f.Data.Tools[0].Value != "shell" || len(f.Data.Sessions) != 0 {
		t.Fatalf("facet own-filter behavior: %+v", f)
	}
	for _, search := range []string{"' OR 1=1 --", "%", "___"} {
		p, err := s.Calls(ctx, queryTest(t, url.Values{"q": {search}}))
		if err != nil {
			t.Fatal(err)
		}
		if len(p.Data) != 0 {
			t.Fatalf("search treated as SQL pattern: %s", search)
		}
	}
	p, err := s.Calls(ctx, queryTest(t, url.Values{"q": {"PWD"}, "source": {c.Source.ID}, "directory": {"/work"}, "repository": {"/work"}}))
	if err != nil || len(p.Data) != 4 {
		t.Fatalf("combined filters/search: %+v %v", p, err)
	}
}

func TestConcurrentStoresSerializeRetries(t *testing.T) {
	a, path := openTest(t)
	b, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer b.Close()
	c := sourceTest(t, a)
	e := eventTest(c.Source.ID, "same", "pre", "codex", 0, time.Now())
	var wg sync.WaitGroup
	failures := make(chan error, 20)
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			s := a
			if i%2 == 1 {
				s = b
			}
			_, err := s.Ingest(ctx, c.Source.ID, []domain.Event{e})
			failures <- err
		}(i)
	}
	wg.Wait()
	close(failures)
	for err := range failures {
		if err != nil {
			t.Fatal(err)
		}
	}
	if countTest(t, a, "events") != 1 || countTest(t, a, "calls") != 1 {
		t.Fatal("concurrent retries duplicated")
	}
}

func TestCrashHelper(t *testing.T) {
	path := os.Getenv("TOOL_LOGGER_CRASH_TEST_DB")
	if path == "" {
		return
	}
	s, err := Open(path)
	if err != nil {
		panic(err)
	}
	sources, err := s.Sources(ctx)
	if err != nil || len(sources.Data) != 1 {
		panic("source missing")
	}
	source := sources.Data[0].ID
	if os.Getenv("TOOL_LOGGER_CRASH_TEST_MODE") == "concurrent" {
		body, err := os.ReadFile(os.Getenv("TOOL_LOGGER_PROCESS_EVENT"))
		if err != nil {
			t.Fatal(err)
		}
		var event domain.Event
		if err = json.Unmarshal(body, &event); err != nil {
			t.Fatal(err)
		}
		if _, err = s.Ingest(ctx, source, []domain.Event{event}); err != nil {
			t.Fatal(err)
		}
		if err = s.Close(); err != nil {
			t.Fatal(err)
		}
		return
	}
	e := eventTest(source, "crash", "pre", "codex", 0, time.Now())
	if os.Getenv("TOOL_LOGGER_CRASH_TEST_MODE") == "committed" {
		if _, err = s.Ingest(ctx, source, []domain.Event{e}); err != nil {
			panic(err)
		}
	} else {
		if _, err = s.db.Exec("PRAGMA cache_size=1"); err != nil {
			panic(err)
		}
		p, err := harnesses.Parse(e)
		if err != nil {
			panic(err)
		}
		tx, err := s.db.Begin()
		if err != nil {
			panic(err)
		}
		b, _ := json.Marshal(e)
		if _, err = tx.Exec("INSERT INTO events(source_id,event_id,harness,call_id,phase,recorded_at,received_at,digest,envelope,native) VALUES(?,?,?,?,?,?,?,?,?,?)", source, e.EventID, e.Harness, p.Key, p.Phase, p.RecordedAt, now(), "uncommitted", b, []byte(e.Native)); err != nil {
			panic(err)
		}
		// Exit without commit, rollback, Close, or Go deferred cleanup.
	}
	os.Exit(37)
}

func TestConcurrentProcessesDeduplicate(t *testing.T) {
	s, path := openTest(t)
	c := sourceTest(t, s)
	e := eventTest(c.Source.ID, "cross-process", "pre", "codex", 0, time.Now())
	body, _ := json.Marshal(e)
	file := filepath.Join(t.TempDir(), "event.json")
	if err := os.WriteFile(file, body, 0600); err != nil {
		t.Fatal(err)
	}
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	commands := []*exec.Cmd{}
	for i := 0; i < 4; i++ {
		command := exec.Command(executable, "-test.run=^TestCrashHelper$")
		command.Env = append(os.Environ(), "TOOL_LOGGER_CRASH_TEST_DB="+path, "TOOL_LOGGER_CRASH_TEST_MODE=concurrent", "TOOL_LOGGER_PROCESS_EVENT="+file)
		commands = append(commands, command)
	}
	var wg sync.WaitGroup
	failures := make(chan string, len(commands))
	for _, command := range commands {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if output, err := command.CombinedOutput(); err != nil {
				failures <- fmt.Sprintf("%v: %s", err, output)
			}
		}()
	}
	wg.Wait()
	close(failures)
	for failure := range failures {
		t.Error(failure)
	}
	if countTest(t, s, "events") != 1 || countTest(t, s, "calls") != 1 {
		t.Fatal("concurrent processes duplicated raw events or projections")
	}
}

func TestCrashRecovery(t *testing.T) {
	for _, mode := range []string{"uncommitted", "committed"} {
		t.Run(mode, func(t *testing.T) {
			s, path := openTest(t)
			sourceTest(t, s)
			if err := s.Close(); err != nil {
				t.Fatal(err)
			}
			executable, err := os.Executable()
			if err != nil {
				t.Fatal(err)
			}
			command := exec.Command(executable, "-test.run=^TestCrashHelper$")
			command.Env = append(os.Environ(), "TOOL_LOGGER_CRASH_TEST_DB="+path, "TOOL_LOGGER_CRASH_TEST_MODE="+mode)
			output, err := command.CombinedOutput()
			var exit *exec.ExitError
			if !errors.As(err, &exit) || exit.ExitCode() != 37 {
				t.Fatalf("helper failed: %v %s", err, output)
			}
			s, err = Open(path)
			if err != nil {
				t.Fatal(err)
			}
			defer s.Close()
			want := 0
			if mode == "committed" {
				want = 1
			}
			if countTest(t, s, "events") != want || countTest(t, s, "calls") != want {
				t.Fatal("crash broke atomicity/durability")
			}
			var integrity string
			if err = s.db.QueryRow("PRAGMA integrity_check").Scan(&integrity); err != nil || integrity != "ok" {
				t.Fatalf("integrity: %s %v", integrity, err)
			}
		})
	}
}

func TestQueryValidation(t *testing.T) {
	for _, value := range []string{"limit=0", "limit=501", "harness=unknown", "lifecycle=completed", "outcome=maybe", "since=yesterday", "since=2026-01-01T00:00:00Z&until=2020-01-01T00:00:00Z", "q=x&q=y", "unknown=true", "cursor=" + strings.Repeat("x", 5000)} {
		v, err := url.ParseQuery(value)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = ParseQuery(v); err == nil {
			t.Fatalf("accepted %s", value)
		}
	}
}

func TestProjectionRebuildIsAtomicAndPreservesCursor(t *testing.T) {
	s, _ := openTest(t)
	c := sourceTest(t, s)
	events := []domain.Event{}
	at := time.Now()
	for i := 0; i < 205; i++ {
		events = append(events, eventTest(c.Source.ID, fmt.Sprint(i), "pre", "codex", 0, at.Add(time.Duration(i)*time.Millisecond)))
	}
	if _, err := s.Ingest(ctx, c.Source.ID, events); err != nil {
		t.Fatal(err)
	}
	q := queryTest(t, url.Values{"limit": {"2"}})
	page, err := s.Calls(ctx, q)
	if err != nil {
		t.Fatal(err)
	}
	if page.Page.NextCursor == nil {
		t.Fatal("missing cursor")
	}
	q.Cursor = *page.Page.NextCursor
	before, err := s.Calls(ctx, q)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.db.Exec("UPDATE calls SET summary='{}',detail='{}'"); err != nil {
		t.Fatal(err)
	}
	if err = s.Rebuild(ctx); err != nil {
		t.Fatal(err)
	}
	after, err := s.Calls(ctx, q)
	if err != nil {
		t.Fatal(err)
	}
	if string(mustMarshal(before)) != string(mustMarshal(after)) {
		t.Fatal("rebuild changed ordering or cursor membership")
	}
	if countTest(t, s, "events") != 205 || countTest(t, s, "calls") != 205 {
		t.Fatal("rebuild lost evidence")
	}
	if _, err = s.db.Exec(`CREATE TRIGGER fail_rebuild BEFORE INSERT ON calls BEGIN SELECT RAISE(ABORT,'rebuild failed'); END`); err != nil {
		t.Fatal(err)
	}
	if err = s.Rebuild(ctx); err == nil {
		t.Fatal("failed rebuild succeeded")
	}
	if countTest(t, s, "calls") != 205 {
		t.Fatal("failed rebuild deleted existing projections")
	}
}

func TestMetricsRemainConsistentDuringIngestion(t *testing.T) {
	s, _ := openTest(t)
	c := sourceTest(t, s)
	done := make(chan error, 1)
	go func() {
		for i := 0; i < 30; i++ {
			_, err := s.Ingest(ctx, c.Source.ID, []domain.Event{eventTest(c.Source.ID, fmt.Sprint(i), "pre", "codex", 0, time.Now())})
			if err != nil {
				done <- err
				return
			}
		}
		done <- nil
	}()
	for i := 0; i < 10; i++ {
		m, err := s.Metrics(ctx, queryTest(t, nil))
		if err != nil {
			t.Fatal(err)
		}
		var activity, tools int64
		for _, b := range m.Data.Activity {
			activity += b.Count
		}
		for _, u := range m.Data.ToolUsage {
			tools += u.Count
		}
		if m.Data.TotalCalls != activity || activity != tools {
			t.Fatalf("inconsistent metric snapshot: total=%d activity=%d tools=%d", m.Data.TotalCalls, activity, tools)
		}
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestTinyMetricWindowStaysInsideRequestedRange(t *testing.T) {
	s, _ := openTest(t)
	c := sourceTest(t, s)
	at := time.Date(2026, 11, 4, 1, 0, 0, 123456789, time.UTC)
	if _, err := s.Ingest(ctx, c.Source.ID, []domain.Event{eventTest(c.Source.ID, "one", "pre", "codex", 0, at)}); err != nil {
		t.Fatal(err)
	}
	end := at.Add(37 * time.Millisecond)
	m, err := s.Metrics(ctx, queryTest(t, url.Values{"since": {at.Format(time.RFC3339Nano)}, "until": {end.Format(time.RFC3339Nano)}}))
	if err != nil {
		t.Fatal(err)
	}
	var count int64
	for _, bucket := range m.Data.Activity {
		stamp, err := time.Parse(time.RFC3339Nano, bucket.Start)
		if err != nil || stamp.Before(at) || stamp.After(end) {
			t.Fatalf("bucket outside requested range: %s", bucket.Start)
		}
		count += bucket.Count
	}
	if count != 1 {
		t.Fatal("bucket lost call")
	}
}

func TestDatabaseDurabilityConfigurationAndMigrationGuard(t *testing.T) {
	s, path := openTest(t)
	var mode string
	var sync, foreign, version int
	if err := s.db.QueryRow("PRAGMA journal_mode").Scan(&mode); err != nil {
		t.Fatal(err)
	}
	if err := s.db.QueryRow("PRAGMA synchronous").Scan(&sync); err != nil {
		t.Fatal(err)
	}
	if err := s.db.QueryRow("PRAGMA foreign_keys").Scan(&foreign); err != nil {
		t.Fatal(err)
	}
	if err := s.db.QueryRow("PRAGMA user_version").Scan(&version); err != nil {
		t.Fatal(err)
	}
	if mode != "wal" || sync != 2 || foreign != 1 || version != 1 {
		t.Fatalf("unsafe database configuration: %s %d %d %d", mode, sync, foreign, version)
	}
	if _, err := s.db.Exec("PRAGMA user_version=2"); err != nil {
		t.Fatal(err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	if future, err := Open(path); err == nil {
		future.Close()
		t.Fatal("opened newer schema")
	}
	memory, err := Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer memory.Close()
	sourceTest(t, memory)
}

func BenchmarkPersonalUse100k(b *testing.B) {
	s, path := openTest(b)
	sources := []domain.SourceCredentials{}
	for i := 0; i < 5; i++ {
		sources = append(sources, sourceTest(b, s))
	}
	at := time.Date(2026, 11, 4, 1, 0, 0, 0, time.UTC)
	started := time.Now()
	for sourceIndex, c := range sources {
		for batch := 0; batch < 40; batch++ {
			events := make([]domain.Event, 500)
			for i := range events {
				n := batch*500 + i
				events[i] = eventTest(c.Source.ID, fmt.Sprint(n), "pre", "codex", 0, at.Add(time.Duration(n+sourceIndex)*time.Millisecond))
			}
			if _, err := s.Ingest(ctx, c.Source.ID, events); err != nil {
				b.Fatal(err)
			}
		}
	}
	elapsed := time.Since(started)
	b.Logf("seeded 100000 calls across 5 sources in %s (%.0f events/s)", elapsed, 100000/elapsed.Seconds())
	if countTest(b, s, "calls") != 100000 {
		b.Fatal("benchmark did not retain 100000 calls")
	}
	var size int64
	for _, file := range []string{path, path + "-wal"} {
		if info, err := os.Stat(file); err == nil {
			size += info.Size()
		}
	}
	b.Logf("database and WAL: %d bytes", size)
	for _, scope := range []struct {
		name   string
		values url.Values
		count  int64
	}{{"source", url.Values{"source": {sources[0].Source.ID}, "harness": {"codex"}, "limit": {"100"}}, 20000}, {"all", url.Values{"limit": {"100"}}, 100000}} {
		q := queryTest(b, scope.values)
		b.Run(scope.name+"/page100", func(b *testing.B) {
			b.ReportAllocs()
			for i := 0; i < b.N; i++ {
				p, err := s.Calls(ctx, q)
				if err != nil || len(p.Data) != 100 {
					b.Fatalf("query: %v", err)
				}
			}
		})
		b.Run(scope.name+"/metrics", func(b *testing.B) {
			b.ReportAllocs()
			for i := 0; i < b.N; i++ {
				m, err := s.Metrics(ctx, q)
				if err != nil || m.Data.TotalCalls != scope.count {
					b.Fatalf("metrics: %+v %v", m.Data, err)
				}
			}
		})
		b.Run(scope.name+"/facets", func(b *testing.B) {
			b.ReportAllocs()
			for i := 0; i < b.N; i++ {
				if _, err := s.Facets(ctx, q); err != nil {
					b.Fatal(err)
				}
			}
		})
	}
}
