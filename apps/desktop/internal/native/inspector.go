package native

import (
	"bytes"
	"encoding/json"
	"fmt"
	"slices"
	"strings"

	"github.com/egoist/mygo/ui"
)

func (m *model) inspector(c *ui.Context) {
	ui.Column(c).Fill().Padding(16).Gap(12).Role(ui.RoleGroup).Label("Call details").Children(func() {
		ui.Row(c).Gap(8).Children(func() {
			ui.Text(c, "Call details").FontSize(20).Bold().Grow(1)
			if ui.Button(c, "Close").Key("close-inspector").Bind(&m.inspectorClose).Clicked() {
				m.closeDetail()
			}
		})
		if m.detailLoading {
			ui.Text(c, "Loading call details…").FontSize(12)
		}
		if m.detailError != "" {
			ui.Text(c, "Details unavailable").Bold().TextColor(c.Theme().Danger)
			ui.Text(c, m.detailError).Selectable().Wrap()
			if ui.Button(c, "Retry details").Key("retry-detail").Clicked() {
				m.selectCall(m.prefs.Selected, true)
			}
		}
		if m.detail == nil {
			return
		}
		s := m.detail.Summary
		ui.Text(c, s.Tool).Font("monospace").FontSize(18).Bold().Selectable()
		ui.Text(c, s.Lifecycle+" · "+s.Outcome).FontSize(12)
		tabs := []string{"Input", "Result", "Native", "Raw events", "Metadata", "Git"}
		index := max(0, slices.Index(tabs, m.prefs.Tab))
		parts := ui.TabsBase(c.Key("inspector-tabs"), &index, len(tabs))
		parts.List.Wrap().Gap(4).Children(func() {
			for i, tab := range tabs {
				c.Key("tab-" + strings.ToLower(tab))
				e := parts.Tab(i).Label(tab).Padding(8, 10).BorderWidth(0, 0, 2, 0)
				if i == index {
					e = e.BorderColor(c.Theme().Accent).TextColor(c.Theme().Text)
				} else {
					e = e.BorderColor(ui.Transparent).TextColor(c.Theme().TextMuted)
				}
				e.Children(func() { ui.Text(c, tab) })
			}
		})
		if parts.List.Changed() {
			m.prefs.Tab = tabs[index]
			m.copyMessage = ""
			m.save()
		}
		if m.prefs.Tab == "Metadata" {
			ui.Scroll(c.Key("metadata-scroll")).Grow(1).Children(func() {
				ui.Column(c).Gap(8).Children(func() {
					for _, v := range []struct{ label, value string }{
						{"Call", s.ID}, {"Source", s.SourceID}, {"Harness", s.Harness}, {"API version", optional(s.HarnessAPIVersion)},
						{"Observed", s.ObservedAt}, {"Started", optional(s.StartedAt)}, {"Finished", optional(s.FinishedAt)},
						{"Session", optional(s.SessionID)}, {"Agent", optional(s.AgentID)}, {"Repository", optional(s.Repository)}, {"Directory", optional(s.Directory)},
					} {
						ui.Text(c, v.label).FontSize(12).TextColor(c.Theme().TextMuted)
						ui.Text(c, v.value).Selectable().Wrap()
					}
					keys := []string{}
					for k := range s.Attributes {
						keys = append(keys, k)
					}
					slices.Sort(keys)
					for _, k := range keys {
						ui.Text(c, k).Bold()
						ui.Text(c, pretty(s.Attributes[k])).Font("monospace").Selectable().Wrap()
					}
				})
			})
		} else if m.prefs.Tab == "Git" {
			m.gitSnapshots(c)
		} else {
			payload := m.payload()
			ui.TextArea(c.Key("payload-"+m.prefs.Tab), &payload).Grow(1).ReadOnly(true).Font("monospace").FontSize(12).Label(m.prefs.Tab + " JSON")
		}
		ui.Row(c).Gap(8).Children(func() {
			if ui.Button(c, "Copy JSON").Key("copy-json").Clicked() || c.Shortcut(ui.Cmd|ui.Shift, ui.KeyC) {
				c.WriteClipboard(m.payload())
				m.copyMessage = "JSON copied"
			}
			ui.Text(c, m.copyMessage).FontSize(12)
		})
	})
}

func optional(v *string) string {
	if v == nil || *v == "" {
		return "Not recorded"
	}
	return *v
}
func pretty(v json.RawMessage) string {
	if len(v) == 0 {
		return "null"
	}
	var value interface{}
	decoder := json.NewDecoder(bytes.NewReader(v))
	decoder.UseNumber()
	if err := decoder.Decode(&value); err != nil {
		return string(v)
	}
	return jsonText(value)
}

func jsonText(value interface{}) string {
	var b bytes.Buffer
	encoder := json.NewEncoder(&b)
	encoder.SetEscapeHTML(false)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(value); err != nil {
		return "null"
	}
	return strings.TrimSuffix(b.String(), "\n")
}

func (m *model) payload() string {
	if m.detail == nil {
		return "null"
	}
	switch m.prefs.Tab {
	case "Input":
		return pretty(m.detail.Input)
	case "Result":
		return pretty(m.detail.Output)
	case "Native", "Git":
		return pretty(json.RawMessage(jsonText(m.detail.Native)))
	case "Raw events":
		return pretty(json.RawMessage(jsonText(m.detail.Native.Events)))
	default:
		return pretty(json.RawMessage(jsonText(m.detail.Summary)))
	}
}

func (m *model) gitSnapshots(c *ui.Context) {
	ui.Scroll(c.Key("git-scroll")).Grow(1).Children(func() {
		ui.Column(c).Gap(12).Children(func() {
			events := m.detail.Native.Events
			for i, title := range []string{"First event", "Last event"} {
				ui.Text(c, title).Bold()
				index := 0
				if i == 1 {
					index = len(events) - 1
				}
				if index < 0 || index >= len(events) || (i == 1 && len(events) < 2) {
					ui.Text(c, "No matching hook event recorded.").Wrap()
					continue
				}
				var native struct {
					LoggedAt string `json:"logged_at"`
					Metadata struct {
						Directory string            `json:"cwd"`
						Git       json.RawMessage   `json:"git"`
						Errors    []json.RawMessage `json:"errors"`
					} `json:"metadata"`
				}
				if err := json.Unmarshal(events[index], &native); err != nil {
					ui.Text(c, fmt.Sprintf("Cannot decode recorded event: %v", err)).Wrap()
					continue
				}
				if native.LoggedAt != "" {
					ui.Text(c, displayTime(native.LoggedAt)).FontSize(12)
				}
				if native.Metadata.Directory != "" {
					ui.Text(c, native.Metadata.Directory).Selectable().Wrap()
				}
				if len(native.Metadata.Git) == 0 {
					ui.Text(c, "Git context not recorded.").Wrap()
				} else {
					ui.Text(c, strings.ReplaceAll(pretty(native.Metadata.Git), "\\u0000", "\\n")).Font("monospace").FontSize(12).Selectable().Wrap()
				}
				for _, e := range native.Metadata.Errors {
					ui.Text(c, pretty(e)).FontSize(12).TextColor(c.Theme().Warning).Selectable().Wrap()
				}
			}
		})
	})
}
