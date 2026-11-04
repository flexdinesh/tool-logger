package native

import (
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/egoist/mygo/ui"
	"github.com/egoist/mygo/ui/chart"
	"tool-logger/desktop/internal/domain"
)

func (m *model) view(c *ui.Context) {
	dark := c.Theme().Dark
	if m.prefs.Theme != "System" {
		dark = m.prefs.Theme == "Dark"
	}
	c.SetTheme(graphite(dark))
	c.OnShortcut(ui.Cmd, ui.KeyF, func() { m.search.Focus() })
	if c.Shortcut(0, ui.KeySlash) {
		m.search.Focus()
	}
	c.OnShortcut(ui.Cmd, ui.KeyQ, m.quit)
	if c.Shortcut(ui.Alt, ui.KeyLeft) {
		m.back(-1)
	}
	if c.Shortcut(ui.Alt, ui.KeyRight) {
		m.back(1)
	}
	if c.Shortcut(0, ui.KeyEscape) {
		if m.showSetup {
			m.showSetup = false
		} else {
			m.closeDetail()
		}
	}
	ui.Column(c).Fill().Children(func() {
		m.toolbar(c)
		ui.Divider(c)
		if ui.Split(c.Key("workspace-split"), &m.prefs.Sidebar, func() { m.sidebar(c) }, func() {
			if m.showSetup || m.prefs.Selected != "" {
				if ui.SplitPercent(c.Key("inspector-split"), &m.prefs.Collection, func() { m.collection(c) }, func() {
					if m.showSetup {
						m.sourceSetup(c)
					} else {
						m.inspector(c)
					}
				}).Fill().Changed() {
					m.save()
				}
			} else {
				m.collection(c)
			}
		}).Grow(1).Changed() {
			m.save()
		}
		ui.Divider(c)
		ui.Row(c).Padding(8, 16).Gap(12).Children(func() {
			state := "Live · refresh every second"
			if m.prefs.Paused {
				state = "Paused · collection and charts frozen"
			}
			ui.Text(c, state).FontSize(12).TextColor(c.Theme().TextMuted)
			ui.Spacer(c)
			ui.Text(c, fmt.Sprintf("%d loaded", len(m.rows))).FontSize(12)
			if ui.Button(c, "Quit").Key("quit").Clicked() {
				m.quit()
			}
		})
	})
	if m.focusInspector {
		m.inspectorClose.Focus()
		m.focusInspector = false
	}
}

func (m *model) toolbar(c *ui.Context) {
	ui.Row(c).Padding(8, 16).Gap(8).Children(func() {
		ui.Text(c, "Tool Logger").FontSize(20).Bold()
		if ui.Button(c, "Back").Key("back").Disabled(m.historyAt == 0).Clicked() {
			m.back(-1)
		}
		if ui.Button(c, "Forward").Key("forward").Disabled(m.historyAt >= len(m.history)-1).Clicked() {
			m.back(1)
		}
		ui.Spacer(c)
		label := "Pause"
		if m.prefs.Paused {
			label = "Resume"
		}
		if ui.Button(c, label).Key("toggle-live").Clicked() {
			m.pause()
		}
		if ui.Button(c, "Copy link").Key("copy-link").Clicked() {
			c.WriteClipboard(m.deepLink())
			m.copyMessage = "Link copied"
		}
		if ui.Select(c.Key("theme"), &m.prefs.Theme, []string{"System", "Light", "Dark"}).Width(100).Label("Appearance").Changed() {
			m.save()
		}
	})
}

func (m *model) sidebar(c *ui.Context) {
	ui.Column(c).Fill().Padding(12).Gap(8).Children(func() {
		ui.Text(c, "Harnesses").Bold()
		if ui.Button(c, "All harnesses").Key("harness-all").Selected(len(m.prefs.Query["harness"]) == 0).Clicked() {
			m.setFilter("harness", nil)
		}
		for _, h := range m.harnesses {
			if ui.Button(c, h.Label).Key("harness-" + h.ID).Selected(slices.Contains(m.prefs.Query["harness"], h.ID)).Clicked() {
				m.setFilter("harness", []string{h.ID})
			}
		}
		ui.Divider(c).MarginY(8)
		ui.Text(c, "Sources").Bold()
		if ui.Button(c, "All sources").Key("source-all").Selected(len(m.prefs.Query["source"]) == 0).Clicked() {
			m.setFilter("source", nil)
		}
		ui.Scroll(c.Key("source-list")).Grow(1).Children(func() {
			ui.Column(c).Gap(8).Children(func() {
				for _, s := range m.sources {
					ui.Column(c.Key("source-" + s.ID)).Gap(4).Children(func() {
						if ui.Button(c, s.Name).Key("scope").Selected(slices.Contains(m.prefs.Query["source"], s.ID)).Clicked() {
							m.setFilter("source", []string{s.ID})
						}
						ui.Text(c, sourceHealth(s)).FontSize(12).TextColor(c.Theme().TextMuted)
						if ui.Button(c, "Manage "+s.Name).Key("manage").Clicked() {
							m.editSource(s)
						}
					})
				}
			})
		})
		if ui.Button(c, "Add source").Key("add-source").Clicked() {
			m.editSource(domain.Source{})
		}
		if ui.Button(c, "Connection diagnostics").Key("diagnostics").Clicked() {
			m.showSetup = true
			m.diagnose()
		}
	})
}

func sourceHealth(s domain.Source) string {
	status := s.Status
	if status == "" {
		status = "No heartbeat"
	}
	if s.PendingEvents > 0 {
		status += fmt.Sprintf(" · %d pending", s.PendingEvents)
	}
	if s.RejectedEvents > 0 {
		status += fmt.Sprintf(" · %d rejected", s.RejectedEvents)
	}
	return status
}

func (m *model) collection(c *ui.Context) {
	ui.Column(c).Fill().MinWidth(0).Padding(16).Gap(12).Children(func() {
		ui.Row(c).Gap(8).Children(func() {
			ui.Text(c, "Activity").FontSize(20).Bold()
			ui.Spacer(c)
			if ui.Button(c, "Filters").Key("filters-toggle").Selected(m.showFilters).Clicked() {
				m.showFilters = !m.showFilters
				m.prefs.Filters = m.showFilters
				m.save()
			}
			if ui.Button(c, "Charts").Key("charts-toggle").Selected(m.showCharts).Clicked() {
				m.showCharts = !m.showCharts
				m.prefs.ChartsHidden = !m.showCharts
				m.save()
			}
		})
		ui.Row(c).Gap(8).Children(func() {
			v := m.filterDraft["q"]
			if ui.TextInput(c.Key("search"), &v).Grow(1).Bind(&m.search).Placeholder("Search calls").Label("Search calls").Changed() {
				m.filterDraft["q"] = v
				m.setFilter("q", []string{v})
			}
			prev := m.prefs.TimeRange
			if ui.Select(c.Key("time-range"), &m.prefs.TimeRange, []string{"All time", "15 minutes", "1 hour", "24 hours", "7 days", "Custom"}).Width(132).Label("Time range").Changed() {
				selected := m.prefs.TimeRange
				m.prefs.TimeRange = prev
				m.setTimeRange(selected)
			}
			if ui.Button(c, "Reset").Key("reset-filters").Clicked() {
				p := clonePreferences(m.prefs)
				p.Query = map[string][]string{}
				p.TimeRange = "All time"
				m.navigate(p, true)
			}
		})
		if m.showFilters {
			m.filters(c)
		}
		if m.activityError != "" {
			ui.Column(c.Key("activity-error")).Gap(4).Children(func() {
				ui.Text(c, "Activity unavailable").Bold().TextColor(c.Theme().Danger)
				ui.Text(c, m.activityError).Selectable().Wrap()
				if ui.Button(c, "Retry activity").Key("retry-activity").Disabled(m.loading).Clicked() {
					m.refresh(false)
				}
			})
		}
		if !m.loaded && m.loading {
			ui.Text(c, "Loading sources and calls…").Label("Loading activity")
		}
		m.metricStrip(c)
		if m.showCharts {
			m.charts(c)
		}
		ui.Divider(c)
		ui.Text(c, "Tool calls").Bold()
		if len(m.rows) == 0 && m.loaded {
			ui.Column(c).Grow(1).Gap(8).Children(func() {
				if len(m.sources) == 0 {
					ui.Text(c, "Connect your first source").FontSize(18).Bold()
					ui.Text(c, "Create a source, copy its configuration, then start the source forwarder.").Wrap()
					if ui.PrimaryButton(c, "Set up source").Key("setup-empty").Clicked() {
						m.editSource(domain.Source{})
					}
				} else if len(m.prefs.Query) > 0 || m.prefs.TimeRange != "All time" {
					ui.Text(c, "No calls match these filters").Bold()
					ui.Text(c, "Reset filters or widen the time range.").Wrap()
				} else {
					ui.Text(c, "Waiting for tool calls").Bold()
					ui.Text(c, "Sources appear here after durable HTTP delivery.").Wrap()
				}
			})
		} else {
			m.callsTable(c)
		}
		ui.Row(c).Gap(8).Children(func() {
			if m.loading && m.loaded {
				ui.Text(c, "Updating…").FontSize(12)
			}
			ui.Spacer(c)
			if ui.Button(c, "Load more").Key("load-more").Disabled(!m.page.HasMore || m.loading).Clicked() {
				m.refresh(true)
			}
		})
	})
}

func (m *model) filters(c *ui.Context) {
	ui.Scroll(c.Key("filter-panel")).Height(204).Children(func() {
		ui.Column(c).Gap(8).Children(func() {
			for _, row := range [][]struct {
				key, label string
				buckets    []domain.FacetBucket
			}{
				{{"lifecycle", "Lifecycle", m.facets.Lifecycles}, {"outcome", "Outcome", m.facets.Outcomes}, {"tool", "Tool", m.facets.Tools}},
				{{"session", "Session", m.facets.Sessions}, {"agent", "Agent", m.facets.Agents}, {"repository", "Repository", m.facets.Repositories}},
				{{"directory", "Directory", m.facets.Directories}, {"since", "Since (RFC3339)", nil}, {"until", "Until (RFC3339)", nil}},
			} {
				ui.Row(c).Gap(8).AlignItems(ui.Start).Children(func() {
					for _, f := range row {
						ui.Column(c.Key("filter-" + f.key)).Grow(1).Basis(0).MinWidth(0).Gap(4).Children(func() {
							ui.Text(c, f.label).FontSize(12)
							v := m.filterDraft[f.key]
							if ui.TextInput(c.Key("value"), &v).Label(f.label + " filter").Placeholder("All; separate values with ;").Changed() {
								m.filterDraft[f.key] = v
								p := clonePreferences(m.prefs)
								delete(p.Query, f.key)
								for _, s := range strings.Split(v, ";") {
									if s = strings.TrimSpace(s); s != "" {
										p.Query.Add(f.key, s)
									}
								}
								if f.key == "since" || f.key == "until" {
									p.TimeRange = "Custom"
								}
								m.navigate(p, true)
								m.filterDraft[f.key] = v
							}
							if len(f.buckets) > 0 {
								options := []string{"All"}
								for _, b := range f.buckets {
									options = append(options, b.Value)
								}
								selected := strings.Join(m.prefs.Query[f.key], "; ")
								if selected == "" {
									selected = "All"
								} else if !slices.Contains(options, selected) {
									options = append(options, selected)
								}
								if ui.Select(c.Key("facet"), &selected, options).Label("Choose " + f.label).Changed() {
									m.setFilter(f.key, []string{selected})
								}
							}
						})
					}
				})
			}
		})
	})
}

func (m *model) metricStrip(c *ui.Context) {
	v := m.metrics
	average := "No duration"
	if v.AverageDurationMs != nil {
		average = fmt.Sprintf("%.0f ms average", *v.AverageDurationMs)
	}
	failure := "No reported outcomes"
	if v.FailureRate != nil {
		failure = fmt.Sprintf("%.1f%% failure", *v.FailureRate*100)
	}
	ui.Row(c).Wrap().Gap(16).Children(func() {
		for _, s := range []string{fmt.Sprintf("%d calls", v.TotalCalls), fmt.Sprintf("%d completed", v.CompletedCalls), fmt.Sprintf("%d awaiting", v.AwaitingCalls), fmt.Sprintf("%d success", v.SuccessCalls), fmt.Sprintf("%d failure", v.FailureCalls), fmt.Sprintf("%d unknown", v.UnknownCalls), average, failure} {
			ui.Text(c, s).FontSize(12)
		}
	})
}

func (m *model) charts(c *ui.Context) {
	ui.Column(c.Key("charts")).Gap(4).Children(func() {
		ui.Text(c, "Activity · Codex / OpenCode").FontSize(12).TextColor(c.Theme().TextMuted)
		maxCount := int64(1)
		labels := []string{}
		for _, b := range m.metrics.Activity {
			maxCount = max(maxCount, b.Count)
			labels = append(labels, b.Start)
		}
		x := chart.NewBand(labels...).Padding(.25, .1)
		y := chart.NewLinear(0, float64(maxCount))
		chart.Plot(c, chart.Axes{}, func(area ui.Element) {
			for i, b := range m.metrics.Activity {
				base := int64(0)
				for _, h := range []string{"codex", "opencode"} {
					n := b.Harnesses[h]
					color := c.Theme().Accent
					if h == "opencode" {
						color = ui.Hex("#8898af")
						if !c.Theme().Dark {
							color = ui.Hex("#60718b")
						}
					}
					chart.Rect(c.Key(fmt.Sprintf("activity-%d-%s", i, h)), x.Band(i), y.Span(float64(base), float64(base+n))).Background(color).Tooltip(fmt.Sprintf("%s · %s: %d", b.Start, h, n))
					base += n
				}
			}
		}).Height(64).Label("Calls over time").Description("Stacked call counts by recorded time and harness")
		ui.Row(c).Gap(12).Children(func() {
			if len(m.metrics.Activity) == 0 {
				ui.Text(c, "No events yet").FontSize(12)
			} else {
				ui.Text(c, displayTime(m.metrics.Activity[0].Start)).FontSize(12).TextColor(c.Theme().TextMuted)
				ui.Spacer(c)
				ui.Text(c, displayTime(m.metrics.Activity[len(m.metrics.Activity)-1].Start)).FontSize(12).TextColor(c.Theme().TextMuted)
			}
		})
		if len(m.metrics.ToolUsage) > 0 {
			ui.Text(c, "Tool usage").FontSize(12).TextColor(c.Theme().TextMuted)
			names := []string{}
			maximum := int64(1)
			for _, v := range m.metrics.ToolUsage {
				names = append(names, v.Tool)
				maximum = max(maximum, v.Count)
			}
			bands := chart.NewBand(names...).Padding(.35, .1)
			counts := chart.NewLinear(0, float64(maximum))
			chart.Plot(c, chart.Axes{}, func(area ui.Element) {
				for i, v := range m.metrics.ToolUsage {
					chart.Rect(c.Key("tool-bar-"+v.Tool), bands.Band(i), counts.Span(0, float64(v.Count))).Background(c.Theme().Accent).Tooltip(fmt.Sprintf("%s: %d calls", v.Tool, v.Count))
				}
			}).Height(40).Label("Tool usage counts").Description("Call counts by tool; choose a tool below to filter")
		}
		ui.Row(c).Wrap().Gap(12).Children(func() {
			for _, tool := range m.metrics.ToolUsage {
				if ui.Button(c, fmt.Sprintf("%s · %d", tool.Tool, tool.Count)).Key("usage-" + tool.Tool).Clicked() {
					m.setFilter("tool", []string{tool.Tool})
				}
			}
		})
	})
}

func (m *model) callsTable(c *ui.Context) {
	t := *c.Theme()
	t.Accent = t.Selection
	t.AccentText = t.Text
	ui.Themed(c.Key("table-theme"), &t).Grow(1).MinHeight(0).Children(func() { m.tableContent(c) })
}

func (m *model) tableContent(c *ui.Context) {
	m.table.Selected = &m.selectedRow
	m.table.Columns = m.prefs.Columns
	m.table.Key = func(i int) interface{} { return m.rows[i].ID }
	m.table.Label = func(i int) string {
		v := m.rows[i]
		return v.Tool + " · " + v.InputSummary + " · " + v.Lifecycle + " · " + v.Outcome
	}
	columns := []ui.TableColumn{{Title: "Tool", Width: 128, MinWidth: 80}, {Title: "Input", MinWidth: 180}, {Title: "Harness", Width: 80}, {Title: "State", Width: 132}, {Title: "Recorded", Width: 156}, {Title: "Duration", Width: 84}}
	table := ui.Table(c.Key("calls-table"), &m.table, columns, len(m.rows), func(row, col int) {
		v := m.rows[row]
		var text string
		switch col {
		case 0:
			text = v.Tool
		case 1:
			text = v.InputSummary
		case 2:
			text = v.Harness
		case 3:
			text = v.Lifecycle + " · " + v.Outcome
		case 4:
			text = displayTime(v.ObservedAt)
		case 5:
			if v.DurationMs != nil {
				text = fmt.Sprintf("%.0f ms", *v.DurationMs)
			} else {
				text = "Unknown"
			}
		}
		e := ui.Text(c, text).SingleLine().FontSize(12)
		if col < 2 {
			e = e.Font("monospace")
		}
		if col == 3 {
			switch v.Outcome {
			case "success":
				e = e.TextColor(c.Theme().Success)
			case "failure":
				e = e.TextColor(c.Theme().Danger)
			}
		}
	}).Grow(1).Label("Tool calls")
	m.prefs.Columns = m.table.Columns
	if m.focusTable {
		m.table.Focus(c)
		m.focusTable = false
	}
	if (table.Changed() || table.Submitted()) && m.selectedRow >= 0 && m.selectedRow < len(m.rows) {
		m.showSetup = false
		m.selectCall(m.rows[m.selectedRow].ID, false)
		if table.Submitted() {
			m.focusInspector = true
			m.focusTable = false
		}
		m.save()
	}
}

func displayTime(raw string) string {
	if t, err := time.Parse(time.RFC3339Nano, raw); err == nil {
		return t.Local().Format("Jan 02 15:04:05.000")
	}
	return raw
}
