// Package sqlite owns durable ingestion and bounded indexed query projections.
package sqlite

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	_ "modernc.org/sqlite"
	"tool-logger/apps/server/internal/harnesses"
	"tool-logger/packages/protocol"
)

type Error struct {
	Status        int
	Title, Detail string
}

func (e *Error) Error() string     { return e.Title + ": " + e.Detail }
func Invalid(detail string) error  { return &Error{400, "Invalid request", detail} }
func missing() error               { return &Error{404, "Not found", "The requested resource does not exist."} }
func conflict(detail string) error { return &Error{409, "Conflicting event", detail} }

type Store struct{ db *sql.DB }

const schema = `
CREATE TABLE sources (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, hostname TEXT NOT NULL, platform TEXT NOT NULL,
 labels TEXT NOT NULL, token_hash TEXT, revoked INTEGER NOT NULL DEFAULT 0,
 last_seen TEXT, last_event TEXT, pending INTEGER NOT NULL DEFAULT 0,
 rejected INTEGER NOT NULL DEFAULT 0, last_error TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX source_token ON sources(token_hash) WHERE token_hash IS NOT NULL;
CREATE TABLE events (
 seq INTEGER PRIMARY KEY AUTOINCREMENT, source_id TEXT NOT NULL REFERENCES sources(id),
 event_id TEXT NOT NULL, harness TEXT NOT NULL, call_id TEXT NOT NULL, phase TEXT NOT NULL,
 recorded_at TEXT NOT NULL, received_at TEXT NOT NULL, digest TEXT NOT NULL, envelope BLOB NOT NULL, native BLOB NOT NULL,
 UNIQUE(source_id,event_id), UNIQUE(source_id,call_id,phase)
);
CREATE INDEX events_call ON events(source_id,call_id);
CREATE INDEX events_projection ON events(call_id,seq);
CREATE TRIGGER immutable_event_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT,'events are immutable'); END;
CREATE TRIGGER immutable_event_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT,'events are immutable'); END;
CREATE TABLE calls (
 seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, source_id TEXT NOT NULL REFERENCES sources(id),
 harness TEXT NOT NULL, observed_at TEXT NOT NULL, observed_ms INTEGER NOT NULL,
 tool TEXT NOT NULL, session TEXT, agent TEXT, repository TEXT, directory TEXT,
 lifecycle TEXT NOT NULL, outcome TEXT NOT NULL, duration REAL, search_text TEXT NOT NULL,
 summary BLOB NOT NULL, detail BLOB NOT NULL
);
CREATE INDEX calls_order ON calls(observed_at DESC,id DESC);
CREATE INDEX calls_source ON calls(source_id,observed_at DESC,id DESC);
CREATE INDEX calls_harness ON calls(harness,observed_at DESC,id DESC);
CREATE INDEX calls_tool ON calls(tool,observed_at DESC,id DESC);
CREATE INDEX calls_session ON calls(session,observed_at DESC,id DESC);
CREATE INDEX calls_agent ON calls(agent,observed_at DESC,id DESC);
CREATE INDEX calls_repository ON calls(repository,observed_at DESC,id DESC);
CREATE INDEX calls_directory ON calls(directory,observed_at DESC,id DESC);
CREATE INDEX calls_lifecycle ON calls(lifecycle,observed_at DESC,id DESC);
CREATE INDEX calls_outcome ON calls(outcome,observed_at DESC,id DESC);
CREATE INDEX calls_filters ON calls(source_id,harness,lifecycle,outcome,tool,session,agent,repository,directory,observed_at,id,duration,observed_ms);
PRAGMA user_version=1;
`

func Open(path string) (*Store, error) {
	if path == "" {
		return nil, fmt.Errorf("database path is required")
	}
	dsn := path
	if path != ":memory:" {
		absolute, err := filepath.Abs(path)
		if err != nil {
			return nil, err
		}
		if err = os.MkdirAll(filepath.Dir(absolute), 0700); err != nil {
			return nil, err
		}
		u := url.URL{Scheme: "file", Path: absolute}
		dsn = u.String()
	}
	separator := "?"
	if strings.Contains(dsn, "?") {
		separator = "&"
	}
	dsn += separator + "_pragma=busy_timeout(10000)&_pragma=foreign_keys(1)&_pragma=journal_mode(WAL)&_pragma=synchronous(FULL)&_txlock=immediate"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	fail := func(err error) (*Store, error) { _ = db.Close(); return nil, err }
	tx, err := db.Begin()
	if err != nil {
		return fail(err)
	}
	defer tx.Rollback()
	var version int
	if err = tx.QueryRow("PRAGMA user_version").Scan(&version); err != nil {
		return fail(err)
	}
	if version > 1 {
		return fail(fmt.Errorf("unsupported database schema %d", version))
	}
	if version == 0 {
		if _, err = tx.Exec(schema); err != nil {
			return fail(err)
		}
	}
	// Additive credential table preserves the existing event/projection schema.
	if _, err = tx.Exec(`CREATE TABLE IF NOT EXISTS remote_clients (
	 id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL
	)`); err != nil {
		return fail(err)
	}
	if err = tx.Commit(); err != nil {
		return fail(err)
	}
	return &Store{db: db}, nil
}
func (s *Store) Close() error { return s.db.Close() }

func UUID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	b[6] = (b[6] & 15) | 64
	b[8] = (b[8] & 63) | 128
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}
func ValidUUID(s string) bool {
	if len(s) != 36 || s[8] != '-' || s[13] != '-' || s[18] != '-' || s[23] != '-' {
		return false
	}
	_, err := hex.DecodeString(strings.ReplaceAll(s, "-", ""))
	return err == nil
}
func token() (string, string, error) {
	var b [32]byte
	_, err := rand.Read(b[:])
	if err != nil {
		return "", "", err
	}
	t := base64.RawURLEncoding.EncodeToString(b[:])
	return t, hash(t), nil
}
func hash(t string) string { h := sha256.Sum256([]byte(t)); return hex.EncodeToString(h[:]) }
func now() string          { return time.Now().UTC().Format("2006-01-02T15:04:05.000000000Z") }

func validateSource(r domain.SourceRequest) error {
	if strings.TrimSpace(r.Name) == "" || len(r.Name) > 256 || len(r.Hostname) > 256 || len(r.Platform) > 64 {
		return Invalid("name is required (max 256 bytes); hostname max 256; platform max 64")
	}
	return validateLabels(r.Labels)
}
func validateLabels(labels map[string]string) error {
	if len(labels) > 64 {
		return Invalid("at most 64 labels are allowed")
	}
	for k, v := range labels {
		if len(k) == 0 || len(k) > 256 || len(v) > 4096 {
			return Invalid("invalid label size")
		}
	}
	return nil
}
func (s *Store) CreateSource(ctx context.Context, r domain.SourceRequest) (domain.SourceCredentials, error) {
	var result domain.SourceCredentials
	if err := validateSource(r); err != nil {
		return result, err
	}
	if r.Labels == nil {
		r.Labels = map[string]string{}
	}
	t, h, err := token()
	if err != nil {
		return result, err
	}
	id := UUID()
	labels, _ := json.Marshal(r.Labels)
	_, err = s.db.ExecContext(ctx, "INSERT INTO sources(id,name,hostname,platform,labels,token_hash) VALUES(?,?,?,?,?,?)", id, r.Name, r.Hostname, r.Platform, string(labels), h)
	if err != nil {
		return result, err
	}
	result.Source, err = s.Source(ctx, id)
	result.Token = t
	return result, err
}
func (s *Store) UpdateSource(ctx context.Context, id string, r domain.SourceRequest) (domain.Source, error) {
	if err := validateSource(r); err != nil {
		return domain.Source{}, err
	}
	if r.Labels == nil {
		r.Labels = map[string]string{}
	}
	labels, _ := json.Marshal(r.Labels)
	res, err := s.db.ExecContext(ctx, "UPDATE sources SET name=?,hostname=?,platform=?,labels=? WHERE id=?", r.Name, r.Hostname, r.Platform, string(labels), id)
	if err != nil {
		return domain.Source{}, err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return domain.Source{}, missing()
	}
	return s.Source(ctx, id)
}
func (s *Store) RotateToken(ctx context.Context, id string) (domain.SourceCredentials, error) {
	var result domain.SourceCredentials
	t, h, err := token()
	if err != nil {
		return result, err
	}
	res, err := s.db.ExecContext(ctx, "UPDATE sources SET token_hash=?,revoked=0 WHERE id=?", h, id)
	if err != nil {
		return result, err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return result, missing()
	}
	result.Source, err = s.Source(ctx, id)
	result.Token = t
	return result, err
}
func (s *Store) RevokeToken(ctx context.Context, id string) error {
	r, err := s.db.ExecContext(ctx, "UPDATE sources SET token_hash=NULL,revoked=1 WHERE id=?", id)
	if err != nil {
		return err
	}
	n, _ := r.RowsAffected()
	if n == 0 {
		return missing()
	}
	return nil
}
func (s *Store) AuthenticateSource(ctx context.Context, t string) (string, error) {
	var id string
	if t == "" {
		return "", &Error{401, "Unauthorized", "A source bearer credential is required."}
	}
	err := s.db.QueryRowContext(ctx, "SELECT id FROM sources WHERE token_hash=? AND revoked=0", hash(t)).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return "", &Error{401, "Unauthorized", "Invalid or revoked source credential."}
	}
	return id, err
}

const sourceSelect = "SELECT id,name,hostname,platform,labels,revoked,last_seen,last_event,pending,rejected,last_error FROM sources"

type scanner interface{ Scan(...interface{}) error }

func scanSource(row scanner) (domain.Source, error) {
	var s domain.Source
	var labels string
	var revoked int
	err := row.Scan(&s.ID, &s.Name, &s.Hostname, &s.Platform, &labels, &revoked, &s.LastSeenAt, &s.LastEventAt, &s.PendingEvents, &s.RejectedEvents, &s.LastError)
	if err != nil {
		return s, err
	}
	if err = json.Unmarshal([]byte(labels), &s.Labels); err != nil {
		return s, err
	}
	s.Status = "never-seen"
	if s.LastSeenAt != nil {
		seen, _ := time.Parse(time.RFC3339Nano, *s.LastSeenAt)
		s.Status = "online"
		if time.Since(seen) > 60*time.Second {
			s.Status = "stale"
		} else if s.LastError != "" || s.RejectedEvents > 0 || s.PendingEvents > 0 {
			s.Status = "degraded"
		}
	}
	if revoked != 0 {
		s.Status = "revoked"
	}
	return s, nil
}
func (s *Store) Source(ctx context.Context, id string) (domain.Source, error) {
	r, err := scanSource(s.db.QueryRowContext(ctx, sourceSelect+" WHERE id=?", id))
	if errors.Is(err, sql.ErrNoRows) {
		err = missing()
	}
	return r, err
}
func (s *Store) Sources(ctx context.Context) (domain.SourceList, error) {
	result := domain.SourceList{Data: []domain.Source{}}
	rows, err := s.db.QueryContext(ctx, sourceSelect+" ORDER BY name,id")
	if err != nil {
		return result, err
	}
	defer rows.Close()
	for rows.Next() {
		v, err := scanSource(rows)
		if err != nil {
			return result, err
		}
		result.Data = append(result.Data, v)
	}
	return result, rows.Err()
}
func (s *Store) Heartbeat(ctx context.Context, id string, h domain.Heartbeat) error {
	if h.SourceID != id {
		return &Error{403, "Forbidden", "Credential is scoped to another source."}
	}
	if h.PendingEvents < 0 || h.RejectedEvents < 0 || len(h.LastError) > 4096 || len(h.Hostname) > 256 || len(h.Platform) > 64 {
		return Invalid("invalid heartbeat values")
	}
	if err := validateLabels(h.Labels); err != nil {
		return err
	}
	if h.Labels == nil {
		h.Labels = map[string]string{}
	}
	labels, _ := json.Marshal(h.Labels)
	result, err := s.db.ExecContext(ctx, "UPDATE sources SET hostname=?,platform=?,labels=?,last_seen=?,pending=?,rejected=?,last_error=? WHERE id=? AND revoked=0", h.Hostname, h.Platform, string(labels), now(), h.PendingEvents, h.RejectedEvents, h.LastError, id)
	if err != nil {
		return err
	}
	n, _ := result.RowsAffected()
	if n == 0 {
		return &Error{401, "Unauthorized", "Source credential was revoked."}
	}
	return nil
}

// Ingest is one SQLite transaction, including deduplication, raw evidence and all
// projections. The returned acknowledgement exists only after FULL sync commit.
func (s *Store) Ingest(ctx context.Context, source string, events []domain.Event) (ack domain.Acknowledgement, resultErr error) {
	ack = domain.Acknowledgement{Accepted: []string{}, Duplicates: []string{}}
	defer func() {
		if resultErr != nil {
			ack = domain.Acknowledgement{Accepted: []string{}, Duplicates: []string{}}
		}
	}()
	if len(events) == 0 || len(events) > 500 {
		return ack, Invalid("events must contain 1 to 500 records")
	}
	parsed := make([]harnesses.Parsed, len(events))
	for i, e := range events {
		if e.SourceID != source {
			return ack, &Error{403, "Forbidden", "Credential is scoped to another source."}
		}
		if e.SchemaVersion != domain.SchemaVersion || !ValidUUID(e.EventID) || !ValidUUID(e.SourceID) {
			return ack, Invalid("schemaVersion must be 1; eventId and sourceId must be UUIDs")
		}
		p, err := harnesses.Parse(e)
		if err != nil {
			return ack, Invalid(fmt.Sprintf("event %d: %s", i, err))
		}
		parsed[i] = p
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return ack, err
	}
	defer tx.Rollback()
	var active int
	if err = tx.QueryRowContext(ctx, "SELECT count(*) FROM sources WHERE id=? AND revoked=0", source).Scan(&active); err != nil {
		return ack, err
	}
	if active == 0 {
		return ack, &Error{401, "Unauthorized", "Source is revoked or unknown."}
	}
	for i, e := range events {
		p := parsed[i]
		// Preserve native bytes in the digest; insignificant whitespace changes are
		// conflicting evidence too, rather than silently changing stored history.
		identity, _ := json.Marshal([]interface{}{e.SchemaVersion, e.EventID, e.SourceID, e.Harness, e.RecordedAt, string(e.Native)})
		digest := hash(string(identity))
		var previous string
		err = tx.QueryRowContext(ctx, "SELECT digest FROM events WHERE source_id=? AND event_id=?", source, e.EventID).Scan(&previous)
		if err == nil {
			if previous != digest {
				return ack, conflict("eventId already exists with different content")
			}
			ack.Duplicates = append(ack.Duplicates, e.EventID)
			continue
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return ack, err
		}
		var phaseEvent string
		err = tx.QueryRowContext(ctx, "SELECT event_id FROM events WHERE source_id=? AND call_id=? AND phase=?", source, p.Key, p.Phase).Scan(&phaseEvent)
		if err == nil {
			return ack, conflict("native call identity already has a different " + p.Phase + " event")
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return ack, err
		}
		envelope, _ := json.Marshal(e)
		if _, err = tx.ExecContext(ctx, "INSERT INTO events(source_id,event_id,harness,call_id,phase,recorded_at,received_at,digest,envelope,native) VALUES(?,?,?,?,?,?,?,?,?,?)", source, e.EventID, e.Harness, p.Key, p.Phase, p.RecordedAt, now(), digest, envelope, []byte(e.Native)); err != nil {
			return ack, err
		}
		if err = projectCall(ctx, tx, p.Key); err != nil {
			return ack, err
		}
		ack.Accepted = append(ack.Accepted, e.EventID)
		_, err = tx.ExecContext(ctx, "UPDATE sources SET last_event=CASE WHEN last_event IS NULL OR last_event<? THEN ? ELSE last_event END WHERE id=?", p.RecordedAt, p.RecordedAt, source)
		if err != nil {
			return ack, err
		}
	}
	if _, err = tx.ExecContext(ctx, "UPDATE sources SET last_seen=? WHERE id=?", now(), source); err != nil {
		return ack, err
	}
	if err = tx.Commit(); err != nil {
		return domain.Acknowledgement{}, err
	}
	return ack, nil
}
func mustMarshal(v interface{}) []byte { b, _ := json.Marshal(v); return b }
func value(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}
