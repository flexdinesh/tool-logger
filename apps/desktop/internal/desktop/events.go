package desktop

import (
	"encoding/json"
	"errors"
	"net/url"
	"slices"
	"strings"
)

var commands = []string{"search", "back", "forward", "pause", "copy-json", "copy-link", "diagnostics"}

func commandEvent(command string) (pageEvent, error) {
	if !slices.Contains(commands, command) {
		return pageEvent{}, errors.New("unrecognized desktop command")
	}
	return pageEvent{Name: "tool-logger:command", Detail: command}, nil
}

func linkEvent(raw string) (pageEvent, error) {
	u, err := url.Parse(raw)
	if err != nil || len(raw) > 16<<10 || u.Scheme != "tool-logger" || u.Host != "activity" || u.User != nil || u.Path != "" || u.Fragment != "" || u.Opaque != "" {
		return pageEvent{}, errors.New("expected tool-logger://activity link")
	}
	if _, err := url.ParseQuery(u.RawQuery); err != nil {
		return pageEvent{}, errors.New("invalid activity query")
	}
	return pageEvent{Name: "tool-logger:open-link", Detail: raw}, nil
}

func sameOrigin(origin, raw string) bool {
	u, err := url.Parse(raw)
	return err == nil && u.User == nil && u.Opaque == "" && u.Scheme+"://"+u.Host == origin
}

func externalURL(raw string) bool {
	u, err := url.Parse(raw)
	return err == nil && u.User == nil && (u.Scheme == "http" || u.Scheme == "https") && u.Hostname() != "" && !strings.ContainsAny(raw, "\r\n")
}

type pageEvent struct {
	Name   string `json:"name"`
	Detail string `json:"detail"`
}

// The observer keeps events until React installs its listeners. No credentials
// enter this script. JSON encoding also keeps URLs from becoming executable code.
func eventScript(events []pageEvent) string {
	data, _ := json.Marshal(events)
	return `(() => {
const events = ` + string(data) + `;
const root = document.documentElement;
const deliver = () => {
  if (root.dataset.ready !== 'true') return false;
  for (const event of events) window.dispatchEvent(new CustomEvent(event.name, {detail: event.detail}));
  return true;
};
if (!deliver()) {
  const observer = new MutationObserver(() => { if (deliver()) observer.disconnect(); });
  observer.observe(root, {attributes: true, attributeFilter: ['data-ready']});
}
})()`
}
