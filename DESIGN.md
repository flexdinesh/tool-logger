---
name: Tool Logger
description: A compact Graphite workspace for local tool evidence.
colors:
  "app-bg": "#17191d"
  "bg-surface": "#1b1f24"
  "bg-surface-secondary": "#22272e"
  "text-primary": "#e9edf2"
  "text-secondary": "#c5ccd6"
  "text-muted": "#9ca6b3"
  "stroke": "#343b44"
  "stroke-strong": "#4d5865"
  "action": "#c7e780"
  "action-hover": "#d8efa5"
  "action-soft": "#2d3727"
  "on-action": "#18210e"
  "state-success": "#9bd58e"
  "state-success-soft": "#263528"
  "state-warning": "#efbe6b"
  "state-warning-soft": "#382f22"
  "state-destructive": "#ff9c9c"
  "state-destructive-soft": "#3c252c"
  "focus-ring": "#c7e780"
  "bg-overlay": "#10121699"
  "data": "#8898af"
  "data-strong": "#c7e780"
  "scope-hover": "#22272e"
  "light-app-bg": "#f5f6f7"
  "light-bg-surface": "#ffffff"
  "light-bg-surface-secondary": "#eef1f3"
  "light-text-primary": "#232a33"
  "light-text-secondary": "#4a5663"
  "light-text-muted": "#606b77"
  "light-stroke": "#dce1e5"
  "light-stroke-strong": "#b6bec7"
  "light-action": "#486b1c"
  "light-action-hover": "#355213"
  "light-action-soft": "#edf4e1"
  "light-on-action": "#ffffff"
  "light-state-success": "#2d713e"
  "light-state-success-soft": "#ebf6ee"
  "light-state-warning": "#8b6013"
  "light-state-warning-soft": "#fff5dd"
  "light-state-destructive": "#b74248"
  "light-state-destructive-soft": "#fff0f0"
  "light-focus-ring": "#486b1c"
  "light-bg-overlay": "#20262e45"
  "light-data": "#60718b"
  "light-data-strong": "#668b2e"
  "light-scope-hover": "#eef1f3"
typography:
  title:
    fontFamily: "Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif"
    fontSize: "1.25rem"
    fontWeight: 600
    lineHeight: 1.5
    letterSpacing: "-0.025em"
  section:
    fontFamily: "Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif"
    fontSize: "0.875rem"
    fontWeight: 600
    lineHeight: 1.5
    letterSpacing: "normal"
  body:
    fontFamily: "Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
  control:
    fontFamily: "Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif"
    fontSize: "0.875rem"
    fontWeight: 500
    lineHeight: 1.5
    letterSpacing: "normal"
  label:
    fontFamily: "Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif"
    fontSize: "0.75rem"
    fontWeight: 500
    lineHeight: 1.5
    letterSpacing: "normal"
  code:
    fontFamily: "\"SFMono-Regular\", Consolas, \"Liberation Mono\", monospace"
    fontSize: "0.75rem"
    fontWeight: 500
    lineHeight: 1.5
    letterSpacing: "normal"
  payload:
    fontFamily: "\"SFMono-Regular\", Consolas, \"Liberation Mono\", monospace"
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: 2
    letterSpacing: "normal"
rounded:
  "sm": "0.25rem"
  "md": "0.375rem"
  "lg": "0.5rem"
spacing:
  "1": "0.25rem"
  "2": "0.5rem"
  "3": "0.75rem"
  "4": "1rem"
  "6": "1.5rem"
  "12": "3rem"
components:
  button-primary:
    textColor: "{colors.on-action}"
    rounded: "{rounded.md}"
    padding: "0 0.75rem"
    height: "2rem"
    backgroundColor: "{colors.action}"
  button-outline:
    textColor: "{colors.text-secondary}"
    rounded: "{rounded.md}"
    padding: "0 0.75rem"
    height: "2rem"
    backgroundColor: "{colors.bg-surface}"
  button-ghost:
    textColor: "{colors.action}"
    rounded: "{rounded.md}"
    padding: "0 0.75rem"
    height: "2rem"
  input:
    textColor: "{colors.text-primary}"
    rounded: "{rounded.md}"
    padding: "0 0.75rem"
    height: "2rem"
    backgroundColor: "{colors.bg-surface}"
  scope-control:
    textColor: "{colors.text-muted}"
    padding: "0 0.25rem 0.5rem"
    height: "2rem"
  status-neutral:
    backgroundColor: "{colors.bg-surface-secondary}"
    textColor: "{colors.text-secondary}"
    rounded: "{rounded.sm}"
    padding: "0.25rem 0.5rem"
  content-surface:
    backgroundColor: "{colors.bg-surface}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.lg}"
  payload:
    backgroundColor: "{colors.bg-surface-secondary}"
    textColor: "{colors.text-secondary}"
    typography: "{typography.payload}"
    rounded: "{rounded.md}"
    padding: "0.75rem"
  inspector:
    backgroundColor: "{colors.bg-surface}"
    textColor: "{colors.text-primary}"
    padding: "1rem"
    width: "clamp(24rem, 32vw, 30rem)"
---

# Design System: Tool Logger

Graphite is a compact workspace for agent tool evidence in a MyGo webview and ordinary browsers. Charcoal/near-white surfaces, slate text, thin rules and restrained green accents keep calls dominant. The frontmatter retains the semantic palette and role scale; CSS maps those roles in apps/web/src/client/styles.css.

## Web implementation

React owns the interface. Shared Tailwind/Radix primitives provide consistent controls and accessible interaction; MyGo owns only the surrounding desktop lifecycle. Use the declared system UI font stack and platform monospace font for payloads/identifiers, without network font dependencies. Controls use 14px, titles 20px and evidence 12px; spacing follows a 4px rhythm with restrained 6px control corners. Use rem units for the shared type scale.

Map CSS semantic variables to matching frontmatter roles. Both themes use the same variable names. Keep selected rows distinct, text readable and focus visible. Form controls and scrollbars follow the selected CSS color-scheme; System follows the platform preference.

## Workspace

A compact toolbar exposes navigation, pause/resume, activity links and theme. A source sidebar separates harness scope from source scope and keeps setup/connection diagnostics reachable. The center holds compact metrics, optional activity/tool charts, search/filters and a virtualized ruled calls table. A resizable inspector stays beside the table and follows successive selections.

The MyGo app starts at 1440 by 900, with minimum 960 by 640. Narrow desktop windows retain useful call columns; evidence panels resize and scroll internally. Browser layouts reflow for phones: controls reach 44px, call buttons replace wide tables, and the inspector becomes a focus-contained modal sheet. Keep full payload scrolling inside the inspector. MyGo exposes explicit Quit; browsers expose Logout. Either client distinguishes live/paused state and loaded count.

Preserve the flat edge-to-edge composition, thin borders and restrained green selection. Avoid decorative gradients, floating dashboard frames, live glows and oversized metric cards.

## Evidence and states

Use selectable, scrollable monospace JSON. Input, Result, Native, Raw events, Metadata and Git remain separate labeled tabs. Copy JSON provides readable feedback. Git snapshots describe first/last recorded lifecycle context, including unknown/missing values.

Result presence stays neutral. Success/failure colors require an explicit reported outcome. Awaiting, backlog, stale delivery and retry states use clear text with semantic warning/error colors. Harness chart series retain labels; color never establishes outcome.

Distinguish waiting for a first call from unmatched filters and connection failures. Show source configuration, write-token lifecycle and delivery health without exposing administration credentials. Source configuration copy is an explicit action and contains its source credential.

## Preferences, keyboard and accessibility

System theme on first launch; Light/Dark/System selection, pane widths, column layout and filter navigation persist per client. MyGo keeps private preferences in Go and seeds compatible native settings once without changing the original file. Browsers use local preference storage. Menus use platform roles/shortcuts. Search, back/forward, row selection, tabs, pane dividers, copy, close, logout and Quit support keyboard operation. Keep visible focus and meaningful accessible labels. Modal sheets contain focus and restore it when dismissed.

React owns view state. Stable call IDs preserve selection through paging/live refresh. Abort requests and check generations so late responses cannot replace newer scopes or selections. Pause freezes activity while preserving detail recovery. Respect prefers-reduced-motion and avoid continuous decorative animation. Keep browser admin credentials out of preference storage; login clears the token field and uses an HttpOnly session cookie.

Window close hides the UI and retains ingestion. Tray/Dock/second-instance activation reopens it. Quit ends the app. Browser logout or tab close leaves ingestion running. Browser tests cover both themes, keyboard/focus, responsive layouts, payload copy, resizable panes and virtualized rows; e2e builds use MyGo page/menu automation against real HTTP ingestion. Displayless tests do not establish native rendering or lifecycle correctness.
