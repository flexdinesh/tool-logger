# Observer architecture

The headless `tool-logger` CLI manages an independent collector. A separate MyGo executable owns the webview and a loopback UI gateway; browser mode uses the same gateway and React frontend. The collector owns SQLite and supervises one Node source worker. Local clients and workers use its private Unix socket; explicit remote mode adds a pinned-TLS TCP listener. Installed use needs no checkout or build.

## Boundaries

| Package | Ownership |
| --- | --- |
| `apps/cli` | Headless commands, collector/desktop launch and browser fallback |
| `apps/server` | Collector, private listeners/control, TLS pairing and worker supervision |
| `apps/server/internal/harnesses` | Native validation, correlation and projection semantics |
| `apps/server/internal/sqlite` | Immutable ingestion, credentials, projections and migrations |
| `apps/server/internal/httpapi` | Authentication, routes, bounded validation, errors and ETags |
| `apps/desktop` | MyGo lifecycle, menus, navigation and private desktop preferences |
| `apps/web` | React presentation, typed REST parsing and stale-response rejection |
| `packages/protocol` | Versioned serializable contracts, OpenAPI and shared fixtures |
| `packages/client` | Immutable connection descriptors, Unix/pinned-TLS clients and pairing |
| `packages/webui` | Embedded frontend, loopback sessions and bounded REST gateway |
| `packages/transport` | Node source configuration, journal delivery and checkpoints |
| `packages/installer` | Standalone harness registration, snapshots and ownership checks |

One root Go module retains native package privacy. Collector internals cannot be imported by UI packages. Dependency checks prevent MyGo/UI imports in the collector and persistence imports in desktop. The gateway receives an immutable connection and its HTTP client through explicit composition; Unix/TLS policy changes dialing, not domain behavior. UI data uses REST exclusively. MyGo bindings expose preferences and Quit. No service locator or generic repository.

## Identity and semantics

A source is an independently provisioned installation with persistent UUID/state. UUIDs scope deduplication and correlation; hostname, OS, container and resource labels help recognition. Peer IP never establishes identity.

Envelopes contain schema version, source/event UUID, recording time, harness and complete native wrapper. Server owns receipt time. Unknown native fields survive. Correlation includes source/harness/version/session/turn/call IDs. Missing IDs stay unpaired; occupied phases with another event UUID conflict. Late before events can complete result-only calls.

Codex/OpenCode V1 result receipt stays separate from outcome. Only explicit V2 native status establishes success/failure.

## Durability

Complete append-only journal writes serialize across processes. HTTP stays outside hooks. One supervised worker drains bounded batches, advances atomic checkpoints only for complete ACKs, and retries temporary errors with exponential backoff/jitter. Permanent rejects retain original bytes and durable references. Malformed checkpoints/journal replacement stop visibly.

SQLite WAL with synchronous FULL commits raw events/projections atomically. Source/event uniqueness deduplicates replay; changed contents conflict. Triggers prohibit event updates/deletes. Explicit projection rebuild retains raw evidence. Unsupported future database schemas are refused.

Full retention grows disk use. No automatic deletion, rotation, import or silent truncation. Native journal records over 8 MiB create visible local rejection references; HTTP requests allow 9 MiB to accommodate wrapping. Storage exhaustion can prevent capture; hooks still fail open. Offline delivery needs persistent storage and a running/restarted forwarder.

## Queries

Filter/aggregate indexed projections without loading native histories into memory. Calls order by fixed observation time and ID. Cursors bind normalized filters, page size and insertion watermark, excluding new/backdated insertions midway through pagination. Late evidence can change existing projection eligibility; refresh page one for current membership.

Collection summaries omit full first/last/result metadata and attributes over 4 KiB. Lazy detail retains those values and original events completely, so ordinary collection pages do not exceed client response limits because of large Git snapshots.

Facets omit their own dimension and respect other filters. Facets/tool usage cap at 500 groups; activity uses bounded buckets. The client polls every second, freezes collection/metrics when paused, and supports independent detail retry. Cancellation/generation checks reject stale responses.

## Credentials and lifecycle

Local administration credentials live privately in collector/admin.token. Source creation returns a random token once; SQLite stores only its hash. Rotation/revocation retain history. Source credentials cannot read/administer; admin credentials cannot ingest. The default socket is mode 0600 inside the private collector directory. Local provisioning preserves existing source identity and serializes with the collector's database writer.

Explicit remote mode adds TLS on network interfaces, default port 4317, and retains the local socket. Invitations contain the endpoint, stable certificate fingerprint and a single-use random pairing code expiring after ten minutes. Pairing checks the certificate before transmitting the code and returns a revocable remote client credential; SQLite stores its hash. Local control endpoints remain unavailable over TCP. No remote UI assets are served.

Each UI gateway listens on literal loopback and targets one immutable collector connection. Go retains the upstream credential; browsers receive an opaque HttpOnly SameSite=Strict session cookie. A single-use short-lived browser launch capability bootstraps the session without exposing the upstream credential. Host/Origin checks, isolated cookie names and restricted proxy routes prevent sessions crossing connections. Credentials never enter browser storage. Normal logout, expiry or gateway restart invalidates the session.

MyGo installs its session cookie from Go, trusts only the exact UI origin and opens external web links outside the application. Desktop settings are private Go-owned files; compatible native settings seed the first webview launch without changing the original file. Browser settings stay in that browser. Activity data and credentials never enter preference storage.

Window close hides the UI; activation reopens it. Quit stops that UI process and gateway, leaving collection running. Browser exit likewise leaves collection running. `server stop` shuts down collector listeners, its supervised worker and SQLite. `remote` enables the network listener on the existing collector rather than starting another writer. Crashes release process locks; restart retains database, source identity and TLS identity. Ordinary status never prints credentials or payloads; only explicit remote pairing prints its expiring invitation.

## Verification and scale

packages/protocol/generate.ts owns OpenAPI/schema artifacts; drift is checked. Shared fixtures test the schema, actual TS encoder and Go HTTP server. Headless browser tests exercise the React UI against real HTTP/SQLite. Opt-in MyGo e2e automation evaluates the page and drives native menus/lifecycle in built processes. Ordinary releases omit automation.

pnpm check aggregates workspace/schema/TypeScript/plugin/network/Go race/vet checks. test:browser separately covers web views; test:e2e covers the real webview/window process where a display is available. check:pr runs all of these plus platform packaging locally; CI runs no tests. Personal target: five sources, 100,000 calls, ten events/second, ordinary visibility within two seconds. Benchmarks seed through ingestion. Single-writer SQLite, arbitrary substring search and high-cardinality facets define current scaling limits.
