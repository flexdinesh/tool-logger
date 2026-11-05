package sqlite

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"time"

	"tool-logger/packages/protocol"
)

// Query is constructed by ParseQuery so HTTP and native clients share validation.
type Query struct {
	Filters      map[string][]string `json:"filters"`
	Q            string              `json:"q"`
	Since, Until string
	Limit        int
	Cursor       string `json:"-"`
}

var columns = map[string]string{"source": "source_id", "harness": "harness", "lifecycle": "lifecycle", "outcome": "outcome", "tool": "tool", "session": "session", "agent": "agent", "repository": "repository", "directory": "directory"}

func ParseQuery(values url.Values) (Query, error) {
	q := Query{Filters: map[string][]string{}, Limit: 100}
	for k, v := range values {
		if _, ok := columns[k]; ok {
			if len(v) > 64 {
				return q, Invalid("too many filter values")
			}
			for _, item := range v {
				if item == "" || item == "all" {
					continue
				}
				if len(item) > 4096 {
					return q, Invalid("filter value too long")
				}
				q.Filters[k] = append(q.Filters[k], item)
			}
			slices.Sort(q.Filters[k])
			q.Filters[k] = slices.Compact(q.Filters[k])
			if len(q.Filters[k]) == 0 {
				delete(q.Filters, k)
			}
			continue
		}
		if !slices.Contains([]string{"q", "since", "until", "limit", "cursor"}, k) {
			return q, Invalid("unknown query parameter: " + k)
		}
		if len(v) != 1 {
			return q, Invalid("query parameter must occur once: " + k)
		}
	}
	for _, v := range q.Filters["harness"] {
		if v != "codex" && v != "opencode" {
			return q, Invalid("unsupported harness")
		}
	}
	for _, v := range q.Filters["lifecycle"] {
		if !slices.Contains([]string{"awaiting", "finished", "result-only"}, v) {
			return q, Invalid("unsupported lifecycle")
		}
	}
	for _, v := range q.Filters["outcome"] {
		if !slices.Contains([]string{"unknown", "success", "failure"}, v) {
			return q, Invalid("unsupported outcome")
		}
	}
	q.Q = strings.ToLower(strings.TrimSpace(values.Get("q")))
	if len(q.Q) > 1024 {
		return q, Invalid("q exceeds 1024 bytes")
	}
	for _, key := range []string{"since", "until"} {
		v := values.Get(key)
		if v == "" {
			continue
		}
		t, err := time.Parse(time.RFC3339Nano, v)
		if err != nil {
			return q, Invalid(key + " must be RFC3339")
		}
		normalized := t.UTC().Format("2006-01-02T15:04:05.000000000Z")
		if key == "since" {
			q.Since = normalized
		} else {
			q.Until = normalized
		}
	}
	if q.Since != "" && q.Until != "" && q.Since > q.Until {
		return q, Invalid("since must precede until")
	}
	if v := values.Get("limit"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 || n > 500 {
			return q, Invalid("limit must be 1 to 500")
		}
		q.Limit = n
	}
	q.Cursor = values.Get("cursor")
	if len(q.Cursor) > 4096 {
		return q, Invalid("cursor too long")
	}
	return q, nil
}

func (q Query) where(omit string) (string, []interface{}) {
	parts := []string{"1=1"}
	args := []interface{}{}
	keys := make([]string, 0, len(q.Filters))
	for k := range q.Filters {
		keys = append(keys, k)
	}
	slices.Sort(keys)
	for _, k := range keys {
		if k == omit {
			continue
		}
		column, ok := columns[k]
		if !ok {
			continue
		}
		v := q.Filters[k]
		if len(v) == 0 {
			continue
		}
		marks := make([]string, len(v))
		for i, item := range v {
			marks[i] = "?"
			args = append(args, item)
		}
		predicate := column + " IN (" + strings.Join(marks, ",") + ")"
		if slices.Contains(v, "unknown") && slices.Contains([]string{"session", "agent", "repository", "directory"}, k) {
			predicate = "(" + predicate + " OR " + column + " IS NULL)"
		}
		parts = append(parts, predicate)
	}
	if q.Q != "" {
		parts = append(parts, "instr(search_text,?)>0")
		args = append(args, q.Q)
	}
	if q.Since != "" {
		parts = append(parts, "observed_at>=?")
		args = append(args, q.Since)
	}
	if q.Until != "" {
		parts = append(parts, "observed_at<=?")
		args = append(args, q.Until)
	}
	return strings.Join(parts, " AND "), args
}

type cursor struct {
	Fingerprint string `json:"f"`
	Maximum     int64  `json:"m"`
	Time        string `json:"t"`
	ID          string `json:"i"`
}

func (q Query) fingerprint() string {
	b, _ := json.Marshal(q)
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}
func (q Query) decodeCursor() (cursor, error) {
	var c cursor
	b, err := base64.RawURLEncoding.DecodeString(q.Cursor)
	if err != nil {
		return c, Invalid("invalid cursor")
	}
	if json.Unmarshal(b, &c) != nil || c.Maximum < 0 || len(c.ID) != 64 || c.Time == "" || c.Fingerprint != q.fingerprint() {
		return c, Invalid("cursor does not match the query scope")
	}
	if _, err = time.Parse(time.RFC3339Nano, c.Time); err != nil {
		return c, Invalid("invalid cursor time")
	}
	return c, nil
}

func (s *Store) Calls(ctx context.Context, q Query) (domain.CallPage, error) {
	result := domain.CallPage{Data: []domain.CallSummary{}}
	if q.Limit < 1 || q.Limit > 500 {
		return result, Invalid("invalid limit")
	}
	var c cursor
	var err error
	if q.Cursor != "" {
		c, err = q.decodeCursor()
		if err != nil {
			return result, err
		}
	} else {
		err = s.db.QueryRowContext(ctx, "SELECT coalesce(max(seq),0) FROM calls").Scan(&c.Maximum)
		if err != nil {
			return result, err
		}
		c.Fingerprint = q.fingerprint()
	}
	where, args := q.where("")
	where += " AND seq<=?"
	args = append(args, c.Maximum)
	if c.Time != "" {
		where += " AND (observed_at<? OR (observed_at=? AND id<?))"
		args = append(args, c.Time, c.Time, c.ID)
	}
	args = append(args, q.Limit+1)
	rows, err := s.db.QueryContext(ctx, "SELECT summary FROM calls WHERE "+where+" ORDER BY observed_at DESC,id DESC LIMIT ?", args...)
	if err != nil {
		return result, err
	}
	defer rows.Close()
	for rows.Next() {
		var b []byte
		if err = rows.Scan(&b); err != nil {
			return result, err
		}
		var summary domain.CallSummary
		if err = json.Unmarshal(b, &summary); err != nil {
			return result, err
		}
		result.Data = append(result.Data, summary)
	}
	if err = rows.Err(); err != nil {
		return result, err
	}
	if len(result.Data) > q.Limit {
		result.Data = result.Data[:q.Limit]
		result.Page.HasMore = true
		last := result.Data[len(result.Data)-1]
		c.Time, c.ID = last.ObservedAt, last.ID
		b, _ := json.Marshal(c)
		token := base64.RawURLEncoding.EncodeToString(b)
		result.Page.NextCursor = &token
	}
	return result, nil
}
func (s *Store) Call(ctx context.Context, id string) (domain.CallDetail, error) {
	var d domain.CallDetail
	var b []byte
	err := s.db.QueryRowContext(ctx, "SELECT detail FROM calls WHERE id=?", id).Scan(&b)
	if errors.Is(err, sql.ErrNoRows) {
		return d, missing()
	}
	if err != nil {
		return d, err
	}
	err = json.Unmarshal(b, &d)
	return d, err
}

func (s *Store) Facets(ctx context.Context, q Query) (domain.Facets, error) {
	r := domain.Facets{}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return r, err
	}
	defer tx.Rollback()
	// Each facet ignores its own dimension, preserving options during selection.
	groups := []struct {
		key    string
		target *[]domain.FacetBucket
	}{{"tool", &r.Data.Tools}, {"session", &r.Data.Sessions}, {"agent", &r.Data.Agents}, {"repository", &r.Data.Repositories}, {"directory", &r.Data.Directories}, {"lifecycle", &r.Data.Lifecycles}, {"outcome", &r.Data.Outcomes}}
	for _, g := range groups {
		*g.target = []domain.FacetBucket{}
		where, args := q.where(g.key)
		column := columns[g.key]
		rows, err := tx.QueryContext(ctx, "SELECT coalesce("+column+",'unknown') AS value,count(*) FROM calls WHERE "+where+" GROUP BY value ORDER BY value LIMIT 500", args...)
		if err != nil {
			return r, err
		}
		for rows.Next() {
			var b domain.FacetBucket
			if err = rows.Scan(&b.Value, &b.Count); err != nil {
				rows.Close()
				return r, err
			}
			b.Label = b.Value
			*g.target = append(*g.target, b)
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return r, err
		}
	}
	return r, nil
}

func (s *Store) Metrics(ctx context.Context, q Query) (domain.Metrics, error) {
	r := domain.Metrics{Data: domain.MetricData{Activity: []domain.ActivityBucket{}, ToolUsage: []domain.ToolUsage{}}}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return r, err
	}
	defer tx.Rollback()
	d := &r.Data
	where, args := q.where("")
	var minimum, maximum *int64
	err = tx.QueryRowContext(ctx, `SELECT count(*),coalesce(sum(lifecycle!='awaiting'),0),coalesce(sum(lifecycle='awaiting'),0),coalesce(sum(outcome='success'),0),coalesce(sum(outcome='failure'),0),coalesce(sum(outcome='unknown'),0),avg(duration),min(observed_ms),max(observed_ms) FROM calls WHERE `+where, args...).Scan(&d.TotalCalls, &d.CompletedCalls, &d.AwaitingCalls, &d.SuccessCalls, &d.FailureCalls, &d.UnknownCalls, &d.AverageDurationMs, &minimum, &maximum)
	if err != nil {
		return r, err
	}
	known := d.SuccessCalls + d.FailureCalls
	if known > 0 {
		rate := float64(d.FailureCalls) / float64(known)
		d.FailureRate = &rate
	}
	start := time.Now().UTC().Add(-time.Hour)
	end := start.Add(time.Hour)
	if minimum != nil {
		start = time.UnixMilli(*minimum)
		end = time.UnixMilli(*maximum).Add(time.Millisecond)
	}
	if q.Since != "" {
		start, _ = time.Parse(time.RFC3339Nano, q.Since)
	}
	if q.Until != "" {
		end, _ = time.Parse(time.RFC3339Nano, q.Until)
	}
	if end.Before(start) {
		if q.Since != "" {
			end = start.Add(time.Hour)
		} else {
			start = end.Add(-time.Hour)
		}
	}
	a, b := start.UTC().Format(time.RFC3339Nano), end.UTC().Format(time.RFC3339Nano)
	d.Window = domain.TimeWindow{Since: &a, Until: &b}
	width := max(int64(1), end.UnixMilli()-start.UnixMilli())
	bucketCount := min(int64(36), width)
	for i := int64(0); i < bucketCount; i++ {
		d.Activity = append(d.Activity, domain.ActivityBucket{Start: time.UnixMilli(start.UnixMilli() + i*width/bucketCount).Add(time.Duration(start.Nanosecond() % 1_000_000)).UTC().Format(time.RFC3339Nano), Harnesses: map[string]int64{}})
	}
	activityArgs := []interface{}{bucketCount - 1, start.UnixMilli(), bucketCount, width}
	activityArgs = append(activityArgs, args...)
	rows, err := tx.QueryContext(ctx, "SELECT min(?,max(0,(observed_ms-?)*?/?)) AS bucket,harness,count(*) FROM calls WHERE "+where+" GROUP BY bucket,harness ORDER BY bucket", activityArgs...)
	if err != nil {
		return r, err
	}
	for rows.Next() {
		var bucket int
		var harness string
		var count int64
		if err = rows.Scan(&bucket, &harness, &count); err != nil {
			rows.Close()
			return r, err
		}
		if bucket < 0 || bucket >= len(d.Activity) {
			rows.Close()
			return r, fmt.Errorf("invalid activity bucket")
		}
		d.Activity[bucket].Count += count
		d.Activity[bucket].Harnesses[harness] = count
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return r, err
	}
	rows, err = tx.QueryContext(ctx, "SELECT tool,count(*) AS n FROM calls WHERE "+where+" GROUP BY tool ORDER BY n DESC,tool LIMIT 500", args...)
	if err != nil {
		return r, err
	}
	defer rows.Close()
	for rows.Next() {
		var usage domain.ToolUsage
		if err = rows.Scan(&usage.Tool, &usage.Count); err != nil {
			return r, err
		}
		d.ToolUsage = append(d.ToolUsage, usage)
	}
	return r, rows.Err()
}
