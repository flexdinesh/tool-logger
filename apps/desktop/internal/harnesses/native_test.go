package harnesses

import (
	"encoding/json"
	"strings"
	"testing"
	"tool-logger/desktop/internal/domain"
)

func fixture(harness string, version int, phase string, payload Object, metadata Object) domain.Event {
	id := "00000000-0000-4000-8000-000000000001"
	stamp := "2026-11-04T01:00:00Z"
	hook := "PreToolUse"
	if phase == "post" {
		hook = "PostToolUse"
	}
	if harness == "opencode" {
		hook = "tool.execute.before"
		if phase == "post" {
			hook = "tool.execute.after"
		}
	}
	if harness == "codex" {
		payload["hook_event_name"] = mustJSON(hook)
	}
	w := map[string]interface{}{"schema_version": 2, "harness": harness, "event_id": id, "logged_at": stamp, "hook": hook, "event": payload, "metadata": metadata}
	if version > 0 {
		w["api_version"] = version
	}
	b, _ := json.Marshal(w)
	return domain.Event{SchemaVersion: 1, SourceID: "10000000-0000-4000-8000-000000000001", EventID: id, Harness: harness, RecordedAt: stamp, Native: b}
}
func obj(s string) Object { return object(json.RawMessage(s)) }

func TestLargeNativeMetadataIsLazyWhileEvidenceRemainsComplete(t *testing.T) {
	evidence := strings.Repeat("native-metadata", 80_000)
	e := fixture("opencode", 2, "post", Object{
		"id": mustJSON("large-call"), "tool": mustJSON("shell"), "status": mustJSON("success"),
		"result": mustJSON(map[string]interface{}{"content": "ok", "metadata": map[string]string{"evidence": evidence}}),
	}, Object{"git": mustJSON(map[string]string{"root": "/work", "status_porcelain_v2": evidence})})
	p, err := Parse(e)
	if err != nil {
		t.Fatal(err)
	}
	d, err := Project(p.Key, e.SourceID, e.Harness, p.RecordedAt, nil, &e)
	if err != nil {
		t.Fatal(err)
	}
	summary, err := json.Marshal(d.Summary)
	if err != nil {
		t.Fatal(err)
	}
	if len(summary) > 4096 {
		t.Fatalf("collection eagerly embeds native metadata: %d bytes", len(summary))
	}
	if !strings.Contains(string(d.Native.Attributes["resultMetadata"]), evidence) || !strings.Contains(string(d.Native.Attributes["lastMetadata"]), evidence) || string(d.Native.Events[0]) != string(e.Native) {
		t.Fatal("lazy detail lost native evidence")
	}
}

func TestNativeSemantics(t *testing.T) {
	for _, tc := range []struct {
		name, harness          string
		version                int
		payload                string
		outcome, input, output string
	}{
		{"codex error-looking output stays unknown", "codex", 0, `{"tool_use_id":"call","tool_name":"shell","tool_input":{"command":"exit 1"},"tool_response":{"error":"failed"}}`, "unknown", `{"command":"exit 1"}`, `{"error":"failed"}`},
		{"v1 result stays unknown", "opencode", 1, `{"input":{"callID":"call","tool":"shell","args":{"command":"pwd"}},"output":{"output":"/work","metadata":{"exit":0},"title":"shell"}}`, "unknown", `{"command":"pwd"}`, `{"metadata":{"exit":0},"output":"/work"}`},
		{"v2 explicit success", "opencode", 2, `{"id":"call","tool":"shell","status":"success","input":{"command":"pwd"},"result":{"content":"/work","metadata":{"exit":0}}}`, "success", `{"command":"pwd"}`, `{"content":"/work","metadata":{"exit":0}}`},
		{"v2 explicit failure", "opencode", 2, `{"id":"call","tool":"shell","status":"error","input":{},"error":{"message":"denied"}}`, "failure", `{}`, `{"message":"denied"}`},
		{"v2 absent status stays unknown", "opencode", 2, `{"id":"call","tool":"shell","input":{},"result":{"content":"maybe"}}`, "unknown", `{}`, `{"content":"maybe"}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			e := fixture(tc.harness, tc.version, "post", obj(tc.payload), Object{})
			p, err := Parse(e)
			if err != nil {
				t.Fatal(err)
			}
			d, err := Project(p.Key, e.SourceID, e.Harness, p.RecordedAt, nil, &e)
			if err != nil {
				t.Fatal(err)
			}
			if d.Summary.Outcome != tc.outcome || d.Summary.Lifecycle != "result-only" || string(d.Input) != tc.input || string(d.Output) != tc.output {
				t.Fatalf("unexpected detail: %+v input=%s output=%s", d.Summary, d.Input, d.Output)
			}
		})
	}
}

func TestMetadataAndVersionIsolation(t *testing.T) {
	pre := fixture("codex", 0, "pre", obj(`{"tool_use_id":"call","session_id":"session","turn_id":"turn","tool_name":"shell","cwd":"/work/repo","tool_input":{"command":"git checkout feature"}}`), obj(`{"git":{"root":"/work/repo","branch":"main","commit":"abc","dirty":false}}`))
	post := fixture("codex", 0, "post", obj(`{"tool_use_id":"call","session_id":"session","turn_id":"turn","tool_name":"shell","cwd":"/work/repo/sub","tool_response":"ok"}`), obj(`{"git":{"root":"/work/repo","branch":"feature","commit":"def","dirty":true,"upstream":"origin/main","ahead_behind":"+2 -1","status_porcelain_v2":"? file\u0000"},"unknown":{"kept":true}}`))
	p, _ := Parse(pre)
	q, _ := Parse(post)
	if p.Key != q.Key {
		t.Fatal("pre/post failed to correlate")
	}
	d, err := Project(p.Key, pre.SourceID, "codex", p.RecordedAt, &pre, &post)
	if err != nil {
		t.Fatal(err)
	}
	if d.Summary.Repository == nil || *d.Summary.Repository != "/work/repo" || d.Summary.Directory == nil || *d.Summary.Directory != "/work/repo/sub" || d.Summary.Lifecycle != "finished" || d.Summary.DurationMs == nil || *d.Summary.DurationMs != 0 {
		t.Fatalf("unexpected projection: %+v", d.Summary)
	}
	first := object(d.Native.Attributes["firstMetadata"])
	last := object(d.Native.Attributes["lastMetadata"])
	if text(object(first["git"]), "branch") != "main" || text(object(last["git"]), "branch") != "feature" || string(last["unknown"]) != `{"kept":true}` {
		t.Fatalf("lost snapshots: %+v", d.Native.Attributes)
	}
	v1 := fixture("opencode", 1, "pre", obj(`{"input":{"callID":"same","sessionID":"s"},"output":{"args":{}}}`), nil)
	v2 := fixture("opencode", 2, "post", obj(`{"id":"same","sessionID":"s","status":"success"}`), nil)
	a, _ := Parse(v1)
	b, _ := Parse(v2)
	if a.Key == b.Key {
		t.Fatal("cross-version correlation")
	}
	v2.SourceID = "20000000-0000-4000-8000-000000000001"
	c, _ := Parse(v2)
	if b.Key == c.Key {
		t.Fatal("cross-source correlation")
	}
}

func TestRejectInnerEventsAndMismatchedWrappers(t *testing.T) {
	e := fixture("codex", 0, "pre", Object{}, nil)
	for _, mutate := range []func(*domain.Event){
		func(e *domain.Event) { e.Native = json.RawMessage(`{"hook_event_name":"PreToolUse"}`) },
		func(e *domain.Event) { e.EventID = "different" },
		func(e *domain.Event) { e.RecordedAt = "2020-01-01T00:00:00Z" },
		func(e *domain.Event) { e.Harness = "opencode" },
	} {
		copy := e
		mutate(&copy)
		if _, err := Parse(copy); err == nil {
			t.Fatal("accepted mismatched wrapper")
		}
	}
}

func TestV1BeforeArgumentsAndPostFallback(t *testing.T) {
	for _, tc := range []struct{ before, input string }{{`{"args":{"command":"before"}}`, `{"command":"before"}`}, {`{}`, `{"command":"after"}`}} {
		pre := fixture("opencode", 1, "pre", obj(`{"input":{"callID":"c","tool":"shell"},"output":`+tc.before+`}`), nil)
		post := fixture("opencode", 1, "post", obj(`{"input":{"callID":"c","tool":"shell","args":{"command":"after"}},"output":{"output":"done"}}`), nil)
		p, err := Parse(pre)
		if err != nil {
			t.Fatal(err)
		}
		d, err := Project(p.Key, pre.SourceID, "opencode", p.RecordedAt, &pre, &post)
		if err != nil {
			t.Fatal(err)
		}
		if string(d.Input) != tc.input {
			t.Fatalf("want %s got %s", tc.input, d.Input)
		}
	}
}

func TestMalformedGitMetadataDoesNotInventFacts(t *testing.T) {
	e := fixture("codex", 0, "pre", obj(`{"tool_name":"shell"}`), obj(`{"session_cwd":"/work","git":{"root":12,"branch":{},"dirty":"false"},"errors":[{"source":"git","message":"Git timed out"}]}`))
	p, err := Parse(e)
	if err != nil {
		t.Fatal(err)
	}
	d, err := Project(p.Key, e.SourceID, "codex", p.RecordedAt, &e, nil)
	if err != nil {
		t.Fatal(err)
	}
	if d.Summary.Repository != nil {
		t.Fatal("invented repository")
	}
	if _, ok := d.Summary.Attributes["dirty"]; ok {
		t.Fatal("invented clean repository")
	}
	if _, ok := d.Summary.Attributes["branch"]; ok {
		t.Fatal("invented branch")
	}
	if d.Summary.Directory == nil || *d.Summary.Directory != "/work" {
		t.Fatal("lost directory fallback")
	}
}
