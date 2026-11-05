// Package harnesses adapts complete native journal records without inferring outcomes.
package harnesses

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"tool-logger/packages/protocol"
)

type Object map[string]json.RawMessage

func object(raw json.RawMessage) Object {
	var result Object
	if json.Unmarshal(raw, &result) != nil || result == nil {
		return Object{}
	}
	return result
}
func text(o Object, key string) string { var s string; _ = json.Unmarshal(o[key], &s); return s }
func raw(o Object, key string) json.RawMessage {
	if v := o[key]; len(v) > 0 {
		return v
	}
	return json.RawMessage("null")
}
func nullable(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// Parsed contains only facts supported by a single native event. Key includes source,
// harness, API version, session, turn and native call ID. Missing IDs never pair.
type Parsed struct {
	Key                                         string
	Phase                                       string
	Version                                     *string
	Tool, Session, Agent, Directory, Repository string
	Input, Output                               json.RawMessage
	Attributes                                  Object
	Metadata                                    json.RawMessage
	Outcome                                     string
	RecordedAt                                  string
}

func Parse(e domain.Event) (Parsed, error) {
	p := Parsed{Outcome: "unknown", Attributes: Object{}, Input: json.RawMessage("null"), Output: json.RawMessage("null")}
	w := object(e.Native)
	var schema int
	_ = json.Unmarshal(w["schema_version"], &schema)
	if schema != 2 || text(w, "harness") != e.Harness {
		return p, fmt.Errorf("native must be a schema_version:2 %s journal record", e.Harness)
	}
	if text(w, "event_id") != e.EventID {
		return p, fmt.Errorf("native event_id must match eventId")
	}
	nativeTime, err := time.Parse(time.RFC3339Nano, text(w, "logged_at"))
	if err != nil {
		return p, fmt.Errorf("native logged_at must be RFC3339")
	}
	recorded, err := time.Parse(time.RFC3339Nano, e.RecordedAt)
	if err != nil || !nativeTime.Equal(recorded) {
		return p, fmt.Errorf("recordedAt must match native logged_at")
	}
	p.RecordedAt = recorded.UTC().Format("2006-01-02T15:04:05.000000000Z")
	if len(w["event"]) == 0 || string(w["event"]) == "null" || !strings.HasPrefix(strings.TrimSpace(string(w["event"])), "{") {
		return p, fmt.Errorf("native event must be an object")
	}
	n := object(w["event"])
	var call, turn, version string
	switch e.Harness {
	case "codex":
		hook := text(n, "hook_event_name")
		if hook != "PreToolUse" && hook != "PostToolUse" {
			return p, fmt.Errorf("unsupported Codex hook")
		}
		if text(w, "hook") != hook {
			return p, fmt.Errorf("native hook mismatch")
		}
		p.Phase = "pre"
		if hook == "PostToolUse" {
			p.Phase = "post"
		}
		p.Tool, p.Session, call, turn = text(n, "tool_name"), text(n, "session_id"), text(n, "tool_use_id"), text(n, "turn_id")
		p.Directory = text(n, "cwd")
		p.Input, p.Output = raw(n, "tool_input"), raw(n, "tool_response")
		p.Attributes["turnId"], p.Attributes["callId"] = raw(n, "turn_id"), raw(n, "tool_use_id")
	case "opencode":
		var v int
		_ = json.Unmarshal(w["api_version"], &v)
		if v != 1 && v != 2 {
			return p, fmt.Errorf("unsupported OpenCode api_version")
		}
		version = fmt.Sprint(v)
		p.Version = &version
		hook := text(w, "hook")
		if hook != "tool.execute.before" && hook != "tool.execute.after" {
			return p, fmt.Errorf("unsupported OpenCode hook")
		}
		p.Phase = "pre"
		if hook == "tool.execute.after" {
			p.Phase = "post"
		}
		identity := n
		if v == 1 {
			identity = object(n["input"])
			out := object(n["output"])
			call = text(identity, "callID")
			if p.Phase == "pre" {
				p.Input = raw(out, "args")
			} else {
				p.Input = raw(identity, "args")
				p.Output = raw(out, "output")
			}
			p.Attributes["title"], p.Attributes["resultMetadata"] = raw(out, "title"), raw(out, "metadata")
		} else {
			call = text(n, "id")
			p.Input = raw(n, "input")
			p.Attributes["status"] = raw(n, "status")
			if p.Phase == "post" {
				switch text(n, "status") {
				case "error":
					p.Outcome = "failure"
					p.Output = raw(n, "error")
				case "success":
					p.Outcome = "success"
					p.Output = raw(n, "result")
				default:
					p.Output = raw(n, "result")
				}
			}
			p.Attributes["resultMetadata"] = raw(object(n["result"]), "metadata")
		}
		p.Tool, p.Session, p.Agent = text(identity, "tool"), text(identity, "sessionID"), text(identity, "agent")
		p.Attributes["messageId"], p.Attributes["callId"] = raw(identity, "messageID"), mustJSON(call)
	default:
		return p, fmt.Errorf("unsupported harness")
	}
	if p.Tool == "" {
		p.Tool = "Unknown tool"
	}
	p.Metadata = raw(w, "metadata")
	m := object(p.Metadata)
	g := object(m["git"])
	if p.Directory == "" {
		p.Directory = text(m, "session_cwd")
	}
	p.Repository = text(g, "root")
	identity := []string{e.SourceID, e.Harness, version, p.Session, turn, call}
	if call == "" {
		identity = append(identity, "unpaired", e.EventID)
	}
	b, _ := json.Marshal(identity)
	hash := sha256.Sum256(b)
	p.Key = hex.EncodeToString(hash[:])
	return p, nil
}

func mustJSON(v interface{}) json.RawMessage { b, _ := json.Marshal(v); return b }

// Project retains complete wrappers, first/last metadata and native attributes.
// observedAt is fixed by storage when the call first appears; late evidence cannot
// move an existing row across a pagination boundary.
func Project(id, source, harness, observed string, pre, post *domain.Event) (domain.CallDetail, error) {
	d := domain.CallDetail{Input: json.RawMessage("null"), Output: json.RawMessage("null"), Native: domain.NativeDetail{Attributes: Object{}, Events: []json.RawMessage{}}}
	s := domain.CallSummary{ID: id, SourceID: source, Harness: harness, ObservedAt: observed, Lifecycle: "awaiting", Outcome: "unknown", Attributes: Object{}}
	var before, after *Parsed
	if pre != nil {
		p, err := Parse(*pre)
		if err != nil {
			return d, err
		}
		before = &p
		s.StartedAt = &p.RecordedAt
		d.Native.Events = append(d.Native.Events, pre.Native)
	}
	if post != nil {
		p, err := Parse(*post)
		if err != nil {
			return d, err
		}
		after = &p
		s.FinishedAt = &p.RecordedAt
		d.Native.Events = append(d.Native.Events, post.Native)
		s.Lifecycle = "finished"
		s.Outcome = p.Outcome
		if pre == nil {
			s.Lifecycle = "result-only"
		}
	}
	base := before
	if base == nil {
		base = after
	}
	if base == nil {
		return d, fmt.Errorf("empty call")
	}
	s.Tool, s.HarnessAPIVersion, s.SessionID, s.AgentID = base.Tool, base.Version, nullable(base.Session), nullable(base.Agent)
	context := base
	if after != nil && string(after.Metadata) != "null" {
		context = after
	}
	dir := context.Directory
	if dir == "" {
		dir = base.Directory
	}
	s.Directory, s.Repository = nullable(dir), nullable(context.Repository)
	git := object(object(context.Metadata)["git"])
	for native, name := range map[string]string{"branch": "branch", "commit": "commit", "upstream": "upstream", "ahead_behind": "divergence"} {
		if v := text(git, native); v != "" {
			s.Attributes[name] = mustJSON(v)
		}
	}
	var dirty bool
	if value, ok := git["dirty"]; ok && json.Unmarshal(value, &dirty) == nil && string(value) != "null" {
		s.Attributes["dirty"] = value
	}
	d.Input = base.Input
	if base.Version != nil && *base.Version == "1" && string(d.Input) == "null" && after != nil {
		d.Input = after.Input
	}
	for k, v := range base.Attributes {
		s.Attributes[k] = v
	}
	if before != nil {
		s.Attributes["firstMetadata"] = before.Metadata
		d.Native.Attributes["firstMetadata"] = before.Metadata
	}
	if after != nil {
		d.Output = after.Output
		if after.Version != nil && *after.Version == "1" && string(after.Attributes["resultMetadata"]) != "null" {
			d.Output = mustJSON(map[string]json.RawMessage{"output": after.Output, "metadata": after.Attributes["resultMetadata"]})
		}
		for k, v := range after.Attributes {
			if string(v) != "null" {
				s.Attributes[k] = v
			}
		}
		s.Attributes["lastMetadata"] = after.Metadata
		d.Native.Attributes["lastMetadata"] = after.Metadata
		if before == nil {
			s.Attributes["firstMetadata"] = after.Metadata
			d.Native.Attributes["firstMetadata"] = after.Metadata
		}
	} else if before != nil {
		s.Attributes["lastMetadata"] = before.Metadata
		d.Native.Attributes["lastMetadata"] = before.Metadata
	}
	if before != nil && after != nil {
		a, _ := time.Parse(time.RFC3339Nano, before.RecordedAt)
		b, _ := time.Parse(time.RFC3339Nano, after.RecordedAt)
		ms := float64(b.Sub(a)) / float64(time.Millisecond)
		if ms >= 0 {
			s.DurationMs = &ms
		}
	}
	input := strings.Join(strings.Fields(string(d.Input)), " ")
	if string(d.Input) == "null" {
		input = "No input recorded"
	} else {
		inputObject := object(d.Input)
		for _, key := range []string{"command", "cmd", "query", "path", "file_path", "filePath", "url"} {
			var candidate string
			if v, ok := inputObject[key]; ok && json.Unmarshal(v, &candidate) == nil && string(v) != "null" {
				input = strings.Join(strings.Fields(candidate), " ")
				break
			}
		}
	}
	if len(input) > 240 {
		input = string([]rune(input)[:min(240, len([]rune(input)))]) + "…"
	}
	s.InputSummary = input
	for k, v := range s.Attributes {
		d.Native.Attributes[k] = v
	}
	// Collection queries stay compact. Full metadata and unusually large native
	// attributes belong to the lazy detail response, where their bytes are retained.
	for k, v := range s.Attributes {
		if k == "firstMetadata" || k == "lastMetadata" || k == "resultMetadata" || len(v) > 4096 {
			delete(s.Attributes, k)
		}
	}
	d.Summary = s
	return d, nil
}

func List() domain.HarnessList {
	return domain.HarnessList{Data: []domain.Harness{
		{ID: "codex", Label: "Codex", APIVersions: []string{}, OutcomeSemantics: map[string]string{"success": "Not reported by Codex hooks.", "failure": "Not reported by Codex hooks.", "unknown": "Codex PostToolUse does not report a reliable execution outcome."}},
		{ID: "opencode", Label: "OpenCode", APIVersions: []string{"1", "2"}, OutcomeSemantics: map[string]string{"success": "V2 explicit success status.", "failure": "V2 explicit error status.", "unknown": "V1 and missing or unrecognized V2 status do not imply success."}},
	}}
}
