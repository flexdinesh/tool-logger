package desktop

import (
	"os/exec"
	"strings"
	"testing"
)

func TestCommandsAndDeepLinksValidateBeforeDispatch(t *testing.T) {
	for _, command := range commands {
		event, err := commandEvent(command)
		if err != nil || event.Name != "tool-logger:command" || event.Detail != command {
			t.Fatalf("command %q: %+v %v", command, event, err)
		}
	}
	for _, command := range []string{"quit", "eval", "search();alert(1)", ""} {
		if _, err := commandEvent(command); err == nil {
			t.Fatalf("accepted command %q", command)
		}
	}
	valid := "tool-logger://activity?harness=codex&call=source-call&q=%27%3Cscript%3E"
	if event, err := linkEvent(valid); err != nil || event.Detail != valid {
		t.Fatalf("link: %+v %v", event, err)
	}
	for _, raw := range []string{"https://activity", "javascript:alert(1)", "file:///etc/passwd", "tool-logger://other", "tool-logger://user@activity", "tool-logger://activity/path", "tool-logger://activity#fragment", "tool-logger://activity?q=%zz", "tool-logger://activity?q=" + strings.Repeat("x", 16<<10)} {
		if _, err := linkEvent(raw); err == nil {
			t.Fatalf("accepted link %q", raw)
		}
	}
}

func TestNavigationKeepsExactOriginAndOnlyOpensWebLinksExternally(t *testing.T) {
	origin := "http://127.0.0.1:4318"
	if !sameOrigin(origin, origin+"/activity?call=test") {
		t.Fatal("rejected UI navigation")
	}
	for _, raw := range []string{"http://localhost:4318", "http://127.0.0.1:4319", "https://127.0.0.1:4318", "http://127.0.0.1:4318.evil.example", "http://user@127.0.0.1:4318", "file:///tmp/page.html", "javascript:alert(1)"} {
		if sameOrigin(origin, raw) {
			t.Fatalf("trusted %q", raw)
		}
	}
	for _, raw := range []string{"https://example.com/docs", "http://127.0.0.1:4317/"} {
		if !externalURL(raw) {
			t.Fatalf("rejected web link %q", raw)
		}
	}
	for _, raw := range []string{"file:///tmp/page.html", "javascript:alert(1)", "tool-logger://activity", "mailto:someone@example.com", "https://user:secret@example.com/", "https://example.com/\n"} {
		if externalURL(raw) {
			t.Fatalf("opened unapproved URL %q", raw)
		}
	}
}

func TestEventDeliveryWaitsForFrontendReadinessAndPreservesLiteralDetail(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("Node required for headless DOM event delivery check")
	}
	link, err := linkEvent("tool-logger://activity?q=%27%3Balert(1)%3B%2F%2F")
	if err != nil {
		t.Fatal(err)
	}
	command, err := commandEvent("search")
	if err != nil {
		t.Fatal(err)
	}
	script := `
import assert from 'node:assert/strict';
const delivered = [];
let notify;
let disconnected = false;
globalThis.document = {documentElement: {dataset: {}}};
globalThis.window = {dispatchEvent: (event) => delivered.push(event)};
globalThis.CustomEvent = class { constructor(type, options) { this.type = type; this.detail = options.detail; } };
globalThis.MutationObserver = class { constructor(callback) { notify = callback; } observe() {} disconnect() { disconnected = true; } };
` + eventScript([]pageEvent{link, command}) + `;
assert.equal(delivered.length, 0);
document.documentElement.dataset.ready = 'false';
notify();
assert.equal(delivered.length, 0);
document.documentElement.dataset.ready = 'true';
notify();
assert.equal(delivered.length, 2);
assert.equal(delivered[0].type, 'tool-logger:open-link');
assert.equal(delivered[0].detail, 'tool-logger://activity?q=%27%3Balert(1)%3B%2F%2F');
assert.equal(delivered[1].type, 'tool-logger:command');
assert.equal(delivered[1].detail, 'search');
assert.equal(disconnected, true);
` + eventScript([]pageEvent{command}) + `;
assert.equal(delivered.length, 3);
`
	if output, err := exec.Command(node, "--input-type=module", "-e", script).CombinedOutput(); err != nil {
		t.Fatalf("event delivery: %v: %s", err, output)
	}
}
