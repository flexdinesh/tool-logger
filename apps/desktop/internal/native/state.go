// Package native implements the native observer. All model mutations happen on
// the UI thread; workers communicate through Window.Update.
package native

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/egoist/mygo/ui"
	"tool-logger/desktop/internal/apiclient"
	"tool-logger/desktop/internal/domain"
)

type preferences struct {
	Query        url.Values     `json:"query"`
	Theme        string         `json:"theme"`
	Sidebar      float32        `json:"sidebar"`
	Collection   float32        `json:"collection"`
	Tab          string         `json:"tab"`
	Selected     string         `json:"selected"`
	Paused       bool           `json:"paused"`
	TimeRange    string         `json:"timeRange"`
	Columns      ui.TableLayout `json:"columns"`
	Filters      bool           `json:"filters"`
	ChartsHidden bool           `json:"chartsHidden"`
}

type snapshot struct {
	calls     domain.CallPage
	metrics   domain.Metrics
	facets    domain.Facets
	sources   domain.SourceList
	harnesses domain.HarnessList
}

type model struct {
	client               *apiclient.Client
	endpoint             string
	prefs                preferences
	rows                 []domain.CallSummary
	metrics              domain.MetricData
	facets               domain.FacetData
	sources              []domain.Source
	harnesses            []domain.Harness
	page                 domain.Page
	lastQuery            url.Values
	pages                int
	loading              bool
	loaded               bool
	activityError        string
	detail               *domain.CallDetail
	detailLoading        bool
	detailError          string
	detailID             string
	collectionGeneration uint64
	detailGeneration     uint64
	cancel               context.CancelFunc
	detailCancel         context.CancelFunc
	update               func(func())
	// Tests use a queue for update so ui.Tester applies workers on its own thread.
	closed          context.Context
	stop            context.CancelFunc
	persist         chan preferences
	history         []preferences
	historyAt       int
	selectedRow     int
	focusTable      bool
	table           ui.ListState
	search          ui.Handle
	inspectorClose  ui.Handle
	focusInspector  bool
	showFilters     bool
	showCharts      bool
	showSetup       bool
	sourceID        string
	sourceName      string
	sourceHost      string
	sourcePlatform  string
	sourceLabels    string
	setupError      string
	setupMessage    string
	setupBusy       bool
	setupGeneration uint64
	credentials     *domain.SourceCredentials
	revokeConfirm   bool
	copyMessage     string
	filterDraft     map[string]string
	quit            func()
	now             func() time.Time
}

func newModel(client *apiclient.Client, endpoint string, p preferences) *model {
	if p.Query == nil {
		p.Query = url.Values{}
	}
	if p.Sidebar < 150 {
		p.Sidebar = 208
	}
	if p.Collection < 30 || p.Collection > 85 {
		p.Collection = 64
	}
	if p.Theme != "Light" && p.Theme != "Dark" {
		p.Theme = "System"
	}
	if !slices.Contains([]string{"Input", "Result", "Native", "Raw events", "Metadata", "Git"}, p.Tab) {
		p.Tab = "Input"
	}
	if p.TimeRange == "" {
		p.TimeRange = "All time"
	}
	ctx, stop := context.WithCancel(context.Background())
	m := &model{client: client, endpoint: endpoint, prefs: p, pages: 1, selectedRow: -1, filterDraft: map[string]string{}, sourceLabels: "{}", showFilters: p.Filters, showCharts: !p.ChartsHidden, closed: ctx, stop: stop, quit: func() {}, now: time.Now}
	m.history = []preferences{clonePreferences(p)}
	m.syncDrafts()
	return m
}

func clonePreferences(p preferences) preferences {
	p.Query = cloneQuery(p.Query)
	p.Columns.Order = slices.Clone(p.Columns.Order)
	p.Columns.Widths = maps.Clone(p.Columns.Widths)
	return p
}
func cloneQuery(q url.Values) url.Values {
	out := url.Values{}
	for k, v := range q {
		out[k] = slices.Clone(v)
	}
	return out
}

func (m *model) syncDrafts() {
	for _, key := range []string{"q", "lifecycle", "outcome", "tool", "session", "agent", "repository", "directory", "since", "until"} {
		m.filterDraft[key] = strings.Join(m.prefs.Query[key], "; ")
	}
}

func (m *model) save() {
	if m.persist == nil {
		return
	}
	p := clonePreferences(m.prefs)
	// Only the latest view state needs persistence. Credentials never enter it.
	select {
	case m.persist <- p:
	default:
		select {
		case <-m.persist:
		default:
		}
		select {
		case m.persist <- p:
		default:
		}
	}
}

func (m *model) navigate(p preferences, record bool) {
	if p.Query.Encode() == m.prefs.Query.Encode() && p.TimeRange == m.prefs.TimeRange && p.Selected == m.prefs.Selected {
		return
	}
	m.prefs.Query, m.prefs.TimeRange, m.prefs.Selected = cloneQuery(p.Query), p.TimeRange, p.Selected
	m.pages = 1
	m.syncDrafts()
	if record {
		m.history = append(m.history[:m.historyAt+1], clonePreferences(m.prefs))
		m.historyAt = len(m.history) - 1
	}
	m.save()
	m.invalidateCollection()
	m.refresh(false)
	if m.prefs.Selected != "" {
		m.selectCall(m.prefs.Selected, true)
	} else if m.detailID != "" || m.detail != nil || m.detailLoading || m.detailError != "" {
		m.closeDetail()
	}
}

func (m *model) back(delta int) {
	next := m.historyAt + delta
	if next < 0 || next >= len(m.history) {
		return
	}
	m.historyAt = next
	m.navigate(m.history[next], false)
}

func (m *model) setFilter(key string, values []string) {
	p := clonePreferences(m.prefs)
	if key == "since" || key == "until" {
		p.TimeRange = "Custom"
	}
	delete(p.Query, key)
	for _, value := range values {
		if strings.TrimSpace(value) != "" && value != "All" {
			p.Query.Add(key, value)
		}
	}
	m.navigate(p, true)
}

func (m *model) setTimeRange(value string) {
	p := clonePreferences(m.prefs)
	p.TimeRange = value
	if value != "Custom" {
		delete(p.Query, "since")
		delete(p.Query, "until")
	}
	m.navigate(p, true)
}

func (m *model) query(now time.Time) url.Values {
	q := cloneQuery(m.prefs.Query)
	delete(q, "cursor")
	q.Set("limit", "100")
	var duration time.Duration
	switch m.prefs.TimeRange {
	case "All time":
		delete(q, "since")
		delete(q, "until")
	case "15 minutes":
		duration = 15 * time.Minute
	case "1 hour":
		duration = time.Hour
	case "24 hours":
		duration = 24 * time.Hour
	case "7 days":
		duration = 7 * 24 * time.Hour
	}
	if duration > 0 {
		q.Set("since", now.Add(-duration).UTC().Format(time.RFC3339))
		q.Set("until", now.UTC().Format(time.RFC3339))
	}
	return q
}

func (m *model) invalidateCollection() {
	m.collectionGeneration++
	if m.cancel != nil {
		m.cancel()
	}
	m.loading = false
}

func (m *model) refresh(appendPage bool) {
	if m.loading || m.update == nil || m.client == nil {
		return
	}
	if appendPage && (!m.page.HasMore || m.page.NextCursor == nil) {
		return
	}
	m.loading = true
	m.collectionGeneration++
	generation := m.collectionGeneration
	ctx, cancel := context.WithCancel(m.closed)
	m.cancel = cancel
	q := m.query(m.now())
	depth := m.pages
	if appendPage {
		q = cloneQuery(m.activeQuery())
		q.Set("cursor", *m.page.NextCursor)
		depth = 1
	}
	go func() {
		defer cancel()
		var s snapshot
		var err error
		for i := 0; i < depth; i++ {
			var page domain.CallPage
			page, err = m.client.Calls(ctx, q)
			if err != nil {
				break
			}
			s.calls.Data = append(s.calls.Data, page.Data...)
			s.calls.Page = page.Page
			if !page.Page.HasMore || page.Page.NextCursor == nil {
				break
			}
			q.Set("cursor", *page.Page.NextCursor)
		}
		delete(q, "cursor")
		if err == nil && !appendPage {
			s.metrics, err = m.client.Metrics(ctx, q)
		}
		if err == nil && !appendPage {
			s.facets, err = m.client.Facets(ctx, q)
		}
		if err == nil && !appendPage {
			s.sources, err = m.client.Sources(ctx)
		}
		if err == nil && !appendPage {
			s.harnesses, err = m.client.Harnesses(ctx)
		}
		m.update(func() {
			if generation != m.collectionGeneration || m.closed.Err() != nil {
				return
			}
			m.loading = false
			if err != nil {
				if !errors.Is(err, context.Canceled) {
					m.activityError = err.Error()
				}
				return
			}
			m.activityError = ""
			m.loaded = true
			m.acceptCollection(s, appendPage)
			m.lastQuery = cloneQuery(q)
		})
	}()
}

func (m *model) activeQuery() url.Values {
	if m.lastQuery != nil {
		return m.lastQuery
	}
	return m.query(m.now())
}

func (m *model) acceptCollection(s snapshot, appendPage bool) {
	if appendPage {
		m.rows = uniqueRows(append(m.rows, s.calls.Data...))
		m.pages++
	} else {
		m.rows = uniqueRows(s.calls.Data)
		m.metrics = s.metrics.Data
		m.facets = s.facets.Data
		m.sources = s.sources.Data
		m.harnesses = s.harnesses.Data
	}
	m.page = s.calls.Page
	m.selectedRow = slices.IndexFunc(m.rows, func(v domain.CallSummary) bool { return v.ID == m.prefs.Selected })
	if m.prefs.Selected != "" && !m.detailLoading && m.detailError == "" {
		m.selectCall(m.prefs.Selected, false)
	}
}

func uniqueRows(rows []domain.CallSummary) []domain.CallSummary {
	seen := map[string]bool{}
	out := make([]domain.CallSummary, 0, len(rows))
	for _, r := range rows {
		if !seen[r.ID] {
			seen[r.ID] = true
			out = append(out, r)
		}
	}
	return out
}

func (m *model) pause() {
	m.prefs.Paused = !m.prefs.Paused
	if m.prefs.Paused {
		m.invalidateCollection()
	} else {
		m.refresh(false)
	}
	m.save()
}

func (m *model) selectCall(id string, retry bool) {
	if id != m.prefs.Selected {
		m.focusTable = true
	}
	if m.update == nil || m.client == nil {
		m.prefs.Selected = id
		return
	}
	changed := m.detailID != id
	if !changed && m.detailLoading && !retry {
		return
	}
	if m.detailCancel != nil {
		m.detailCancel()
	}
	m.prefs.Selected = id
	m.detailID = id
	m.detailLoading = true
	if changed {
		m.detail = nil
		m.detailError = ""
		m.copyMessage = ""
	}
	if retry {
		m.detailError = ""
	}
	m.detailGeneration++
	generation := m.detailGeneration
	ctx, cancel := context.WithCancel(m.closed)
	m.detailCancel = cancel
	m.save()
	go func() {
		defer cancel()
		detail, err := m.client.Detail(ctx, id)
		m.update(func() {
			if generation != m.detailGeneration || m.prefs.Selected != id || m.closed.Err() != nil {
				return
			}
			m.detailLoading = false
			if err != nil {
				if !errors.Is(err, context.Canceled) {
					m.detailError = err.Error()
				}
				return
			}
			m.detail = &detail
			m.detailError = ""
		})
	}()
}

func (m *model) closeDetail() {
	if m.detailCancel != nil {
		m.detailCancel()
	}
	m.detailGeneration++
	m.prefs.Selected = ""
	m.detailID = ""
	m.detail = nil
	m.detailLoading = false
	m.detailError = ""
	m.selectedRow = -1
	m.focusTable = true
	m.save()
}

func (m *model) deepLink() string {
	q := cloneQuery(m.prefs.Query)
	if m.prefs.TimeRange != "All time" {
		q.Set("range", m.prefs.TimeRange)
	}
	if m.prefs.Selected != "" {
		q.Set("call", m.prefs.Selected)
	}
	return "tool-logger://activity?" + q.Encode()
}

func (m *model) openLink(raw string) error {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "tool-logger" || u.Host != "activity" {
		return fmt.Errorf("expected tool-logger://activity link")
	}
	p := clonePreferences(m.prefs)
	p.Query = url.Values{}
	q := u.Query()
	for _, key := range []string{"source", "harness", "q", "lifecycle", "outcome", "tool", "session", "agent", "repository", "directory", "since", "until"} {
		if len(q[key]) > 0 {
			p.Query[key] = slices.Clone(q[key])
		}
	}
	for _, h := range p.Query["harness"] {
		if h == "all" || (h != "codex" && h != "opencode") {
			delete(p.Query, "harness")
			break
		}
	}
	p.Selected = q.Get("call")
	p.TimeRange = q.Get("range")
	if !slices.Contains([]string{"All time", "15 minutes", "1 hour", "24 hours", "7 days", "Custom"}, p.TimeRange) {
		p.TimeRange = "All time"
		if p.Query.Get("since") != "" || p.Query.Get("until") != "" {
			p.TimeRange = "Custom"
		}
	}
	m.navigate(p, true)
	return nil
}

func preferencesPath() string {
	root := os.Getenv("TOOL_LOGGER_STATE_DIR")
	if root == "" {
		home, _ := os.UserHomeDir()
		root = filepath.Join(home, ".local", "state", "tool-logger")
	}
	return filepath.Join(root, "native-preferences.json")
}

func loadPreferences(path string) preferences {
	var p preferences
	b, err := os.ReadFile(path)
	if err == nil {
		_ = json.Unmarshal(b, &p)
	}
	return p
}

func writePreferences(path string, p preferences) error {
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	b, err := json.MarshalIndent(p, "", "  ")
	if err != nil {
		return err
	}
	if err = os.WriteFile(path+".tmp", b, 0600); err != nil {
		return err
	}
	return os.Rename(path+".tmp", path)
}
