# HTTP contracts

`generate.ts` defines OpenAPI 3.1 and the standalone 2020-12 event schema.
Generated JSON is committed and checked for drift. Go DTOs live in
`packages/protocol/api.go` and `connection.go`; TypeScript encoders consume unknown JSON
through explicit validation. Shared `fixtures/events.json` exercises the actual
source encoder/schema and real Go HTTP server.

```sh
pnpm --filter @tool-logger/protocol generate
pnpm --filter @tool-logger/protocol check
```

Events use schemaVersion 1, stable source/event UUIDs, recording time and complete
native schema_version 2 wrappers. Unknown native fields are preserved. Outer
fields are validated strictly. Version changes require updating schemas, DTOs,
encoders and fixtures together. Source tokens authorize their own source only.

Ingestion batches are atomic, at most 500 events/9 MiB, allowing envelope overhead
for supported 8 MiB native journal records. The source sender normally
uses at most 100 events/about 1 MiB. ACK accepted/duplicates must cover every sent
identity before a checkpoint advances. Same source/event ID and same contents is
idempotent; conflicting contents return 409. Recording and receipt times remain
separate. Result receipt and reported outcome remain separate.

Admin GETs support ETags. Source tokens cannot read/administer; admin credentials
cannot ingest. Tokens returned by create/rotate are no-store and shown once.
Cursors bind all filters, page size and insertion watermark. Late lifecycle
evidence can update current call eligibility; refresh page one for current data.

The collector defaults to a private Unix HTTP socket. Local control routes require
its administration credential and are unavailable over TCP. Explicit remote
activation adds TLS while retaining Unix access. Pairing invitations carry the
endpoint, server UUID, SHA-256 certificate pin and a random, single-use code valid
for ten minutes. The client verifies the pin before sending that code. Pairing
issues an independent revocable client credential; source ingestion remains
write-only. Remote client hashes persist in SQLite; TLS identity and listener
configuration persist privately. Invitations expire on collector restart.

Connection descriptors use schemaVersion 1, endpoint, token, serverId and a
fingerprint for HTTPS. They are private regular JSON files. A Unix endpoint is
`unix:///absolute/path`; remote endpoints use `https://host:port`. Each window owns
one immutable descriptor and transport. Descriptor credentials must never enter
browser storage or process arguments.
