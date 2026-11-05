# Graphite activity workspace

Mode: Operate. Approved Graphite identity restored from the earlier React viewer, extended with current source administration and health. One frontend runs in MyGo on Linux/macOS and ordinary local browsers. Desktop retains a source sidebar, virtual calls table and resizable right inspector; phone browsers reflow calls and use a modal evidence sheet.

Primary target: frontend/src/client/app.tsx. Related: state/, components/, preferences.tsx and session.tsx. MyGo lifecycle belongs to internal/desktop; typed REST data flows through internal/webui to the existing API.

Signature interaction: select successive calls while evidence remains beside the table. Source and harness scopes are independent. Pause freezes collection/metrics; detail retry remains available. URLs/deep links and back/forward restore scope. Closing a MyGo window retains ingestion until explicit Quit; browser logout leaves the server running.

Verification: headless browser tests against real Go HTTP/SQLite plus shell event/preference and composed headless process checks. Display-dependent MyGo lifecycle remains a separate e2e/CI check; never infer it from browser test success.
