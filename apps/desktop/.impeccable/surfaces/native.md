# Native activity workspace

Mode: Operate. Approved Graphite identity, source sidebar, virtual calls table and resizable right inspector. Linux/macOS desktop, minimum 960 by 640. Use native controls/menus and semantic themes from internal/native/theme.go.

Primary target: internal/native/view.go. Related: state.go, inspector.go, sources.go, run.go.

Signature interaction: select successive calls while evidence remains beside the table. Source and harness scopes are independent. Pause freezes collection/metrics; detail retry remains available. Native activity links and back/forward restore scope. Closing a window retains ingestion until explicit Quit.

Verification: actual ui.Tester views in light/dark/compact variants inspected; keyboard, copy, source setup, filters, live/pause, errors, paging, virtual 100k rows and pane resize tested. Built native Linux process automation and composed executable lifetime passed with real HTTP ingestion. Mac runtime remains CI-owned.
