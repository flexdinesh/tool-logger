package sqlite

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"tool-logger/packages/protocol"
	"tool-logger/apps/server/internal/harnesses"
)

func projectCall(ctx context.Context, tx *sql.Tx, key string) error {
	rows, err := tx.QueryContext(ctx, "SELECT seq,phase,recorded_at,envelope,native FROM events WHERE call_id=? ORDER BY seq LIMIT 2", key)
	if err != nil {
		return err
	}
	var pre, post *domain.Event
	var firstSequence int64
	var observed, source, harness string
	for rows.Next() {
		var seq int64
		var phase, stamp string
		var envelope, native []byte
		if err = rows.Scan(&seq, &phase, &stamp, &envelope, &native); err != nil {
			break
		}
		var event domain.Event
		if err = json.Unmarshal(envelope, &event); err != nil {
			break
		}
		event.Native = native
		if firstSequence == 0 {
			firstSequence = seq
			observed = stamp
			source = event.SourceID
			harness = event.Harness
		}
		if phase == "pre" {
			pre = &event
		} else {
			post = &event
		}
	}
	rowErr := rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	if rowErr != nil {
		return rowErr
	}
	if firstSequence == 0 {
		return fmt.Errorf("projection has no raw evidence")
	}
	d, err := harnesses.Project(key, source, harness, observed, pre, post)
	if err != nil {
		return err
	}
	sm := d.Summary
	summary, _ := json.Marshal(sm)
	detail, _ := json.Marshal(d)
	stamp, _ := time.Parse(time.RFC3339Nano, observed)
	search := strings.ToLower(strings.Join([]string{sm.Tool, value(sm.SessionID), value(sm.AgentID), value(sm.Directory), value(sm.Repository), string(d.Input), string(d.Output), string(mustMarshal(sm.Attributes))}, " "))
	_, err = tx.ExecContext(ctx, `INSERT INTO calls(seq,id,source_id,harness,observed_at,observed_ms,tool,session,agent,repository,directory,lifecycle,outcome,duration,search_text,summary,detail)
	 VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET tool=excluded.tool,session=excluded.session,agent=excluded.agent,repository=excluded.repository,directory=excluded.directory,lifecycle=excluded.lifecycle,outcome=excluded.outcome,duration=excluded.duration,search_text=excluded.search_text,summary=excluded.summary,detail=excluded.detail`, firstSequence, sm.ID, source, harness, observed, stamp.UnixMilli(), sm.Tool, sm.SessionID, sm.AgentID, sm.Repository, sm.Directory, sm.Lifecycle, sm.Outcome, sm.DurationMs, search, summary, detail)
	return err
}

// Rebuild replaces only derived projections, atomically, using bounded batches.
// Raw evidence, source history, IDs, ordering, and insertion watermarks survive.
// Maintenance holds the writer lock; it is intentionally not an HTTP endpoint.
func (s *Store) Rebuild(ctx context.Context) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, "DELETE FROM calls"); err != nil {
		return err
	}
	last := ""
	for {
		rows, err := tx.QueryContext(ctx, "SELECT call_id FROM events WHERE call_id>? GROUP BY call_id ORDER BY call_id LIMIT 200", last)
		if err != nil {
			return err
		}
		keys := []string{}
		for rows.Next() {
			var key string
			if err = rows.Scan(&key); err != nil {
				break
			}
			keys = append(keys, key)
		}
		rowErr := rows.Err()
		rows.Close()
		if err != nil {
			return err
		}
		if rowErr != nil {
			return rowErr
		}
		if len(keys) == 0 {
			break
		}
		for _, key := range keys {
			if err = projectCall(ctx, tx, key); err != nil {
				return err
			}
		}
		last = keys[len(keys)-1]
	}
	return tx.Commit()
}
