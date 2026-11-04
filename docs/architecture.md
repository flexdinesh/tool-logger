# Native observer architecture

One desktop executable owns the REST server, SQLite database and MyGo windows. Source hooks journal locally; supervised Node workers deliver over HTTP. Sources need neither Go nor repository scripts at runtime.

## Boundaries

| Package | Ownership |
| --- | --- |
| domain | Serializable HTTP DTOs, no UI/SQL/HTTP imports |
| harnesses | Validate native wrappers, correlate/project native semantics |
| sqlite | Immutable ingestion, credentials, health, projections, queries, migrations |
| httpapi | Authentication, routing, bounded validation, errors, ETags |
| apiclient | Typed cancellable REST, bounded conditional-response cache |
| native | Main-thread presentation/state, async coordination, preferences, lifecycle |
| app / cmd | Filesystem credentials, listener and resource composition |
| transport | Source configuration, journal scanning, HTTP delivery/checkpoints/diagnostics |

Native views cannot import persistence. Use explicit composition and small consumer-owned boundary interfaces. No service locator, generic repository or speculative dynamic extension framework.

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

Administration credentials live privately in collector/admin.token. Source creation returns a random token once; SQLite stores only its hash. Rotation/revocation retain history. Source credentials cannot read/administer; admin credentials cannot ingest. Loopback is default; private-network bindings are explicit.

The native client uses loopback even with wildcard ingestion bindings. Window close hides the UI while ingestion continues. Single-instance activation reopens it. Quit ends the event loop, shuts down HTTP and closes storage. A --serve diagnostic mode runs the same backend without a window. Startup/status never print credentials or payloads.

## Verification and scale

packages/protocol/generate.ts owns OpenAPI/schema artifacts; drift is checked. Shared fixtures test the schema, actual TS encoder and Go HTTP server. ui.Tester exercises real views; opt-in e2e automation drives built native processes over actual REST. Ordinary releases omit automation.

pnpm check aggregates workspace/schema/TypeScript/plugin/network/Go race/vet/view checks. Personal target: five sources, 100,000 calls, ten events/second, ordinary visibility within two seconds. Benchmarks seed through ingestion. Single-writer SQLite, arbitrary substring search and high-cardinality facets define current scaling limits.
