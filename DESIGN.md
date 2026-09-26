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

## Overview

**Creative North Star: "Graphite"**

Graphite is a compact, precise workspace for reading local tool evidence. Charcoal and near-white surfaces, slate text, thin rules, and restrained green accents keep dense information calm and readable. Shared React, Tailwind, and shadcn/ui primitives maintain consistent controls and states.

Both themes use the same semantic roles. Tone and borders establish depth; short motion explains state changes. Native evidence remains readable text. Page strategy and composition stay in the viewer surface contract.

**Key Characteristics:**

- Compact controls
- Thin neutral rules
- Paired light and dark palettes
- Readable native evidence

## Colors

Frontmatter is normative. Unprefixed color slugs record dark defaults; light-* slugs record the light counterparts. These are paired palettes, not separate component APIs: :root[data-theme=light] overrides the same --color-* semantic variables.

### Primary

Soft Lime / Deep Green action tokens mark filled actions, selected scope, focus, links, and selected rows. action-hover changes tone; action-soft supplies a quiet selection fill; on-action supplies the filled-action foreground.

### Secondary

Slate Trace (data) identifies OpenCode; Green Trace (data-strong) identifies Codex. Series retain text labels; chart color does not express outcome.

### Neutral

Charcoal / Near White app-bg is the canvas; bg-surface is content; bg-surface-secondary groups fields, hover rows, and payloads. Slate text-primary, text-secondary, and text-muted establish hierarchy. stroke and stroke-strong draw thin rules. scope-hover supplies quiet harness hover; bg-overlay dims only modal details.

Native state-success, state-warning, and state-destructive each pair with a soft fill. Explicit success and readable source health use success; awaiting results, partial source health, paused updates, and test-data notices use warning; failures and unreadable sources use destructive. Received results with unknown outcome remain neutral.

**The Native Outcomes Rule.** Result presence stays neutral; use success or failure colors only for a reported outcome.

First visit follows OS preference; explicit light/dark selection persists locally under tool-logger-theme. The top-right toggle switches modes. Each theme sets CSS color-scheme. When storage is unavailable, selection lasts for the current visit.

## Typography

**UI Font:** Inter, then the declared system sans stack. Inter is requested, not shipped locally; availability determines rendering.
**Evidence Font:** SFMono-Regular, Consolas, Liberation Mono, then monospace.

Apply global antialiased font smoothing on WebKit and grayscale smoothing on Firefox/macOS.

- Title: semibold 20px / 30px, tight tracking; workspace and inspector headings.
- Section: semibold 14px / 21px on desktop; phone calls heading uses 16px / 24px.
- Body: regular 16px / 24px inherited baseline.
- Control: medium 14px / 21px; buttons, scope, and payload tabs. Phone search/selects use 16px text.
- Label: medium 12px / 18px; badges and compact labels. Metadata may use regular weight.
- Code: medium 12px / 18px tool names; regular mono summaries and identifiers.
- Payload: regular 12px / 24px native JSON, two-space tab width.

Use tabular numerals for measurements and dates. Truncate list summaries, wrap detail paths, and cap empty-state explanation width at 65ch. No display type role is established.

**The Shared Scale Rule.** Use shared rem type roles and the 4px spacing rhythm; use monospace for evidence.

## Layout

Flat, edge-to-edge content uses thin horizontal rules. The 4px rhythm supplies 4–12px tight groups, 16px panel padding, and 24px desktop gutters. No centered floating dashboard frame or desktop width cap is established.

Observed viewer composition: 44px desktop header, compact heading/metrics, shallow activity trace, inline filters, ruled calls, and source details. At 48rem and below the heading stacks. At 40rem and below, 16px gutters, two-column metrics, single-column expanded filters, and full-width call buttons replace the table. The phone header occupies at least 52px including its 44px controls and vertical padding. Preserve tool, summary, harness, native state, date, and duration when reflowing.

Desktop buttons and fields are 32px high; phone controls are at least 44px high. Phone icon controls and tabs also reach 44px width. Body minimum width is 20rem. Disclosures stay inline; raw payload scrolling stays inside its panel.

Current viewer inspector docks right from 70rem: nonmodal, without scrim or shadow, top 44px, width clamp(24rem, 32vw, 30rem). Workspace reserves that width, permitting successive row selection. Below 70rem it becomes a modal right sheet, maximum 520px from 40rem, full width below 40rem. These surface details remain examples; the surface contract owns composition.

## Elevation & Depth

Tone and 1px borders establish structure. Content and desktop details remain flat. Modal inspector shadows: dark -0.5rem 0 1.5rem #00000026; light -0.5rem 0 1.5rem #20262e14. Modal scrim uses bg-overlay. No decorative blur or live-indicator halo is used.

**The Structural Depth Rule.** Keep content flat; reserve the overlay shadow and scrim for the modal inspector.

Activity transforms transition over 180ms ease-out. Inspector reveal moves horizontally from 1.5rem to rest over 180ms cubic-bezier(0.16,1,0.3,1). Reduced motion sets transitions and animations to 0.01ms. No page entrance choreography.

## Shapes

Restrained corners: 4px badges, 6px controls and payloads, 8px reusable bordered surfaces. Main workspace and rows stay square and ruled. Borders are 1px; selected scope and payload tabs use 2px underlines. Small circular markers accompany readable series and status labels.

## Components

- Buttons: primary uses action/on-action; outline uses surface/secondary text/neutral border; ghost uses action text. Shared 6px corners, 12px horizontal padding, 32px desktop height, 32px square icon controls. Hover changes tone; focus uses a 2px ring and 2px canvas offset. Disabled opacity is 50%.
- Fields: surface fill, 1px border, 6px corners, 12px padding, 14px text. Focus changes border and adds a 2px ring at 20% opacity; placeholders are muted. Phone fields reach 44px.
- Scope/navigation: quiet underline selection, 16px gap, muted default text, primary selected text and 2px action rule. Hover uses scope-hover. State uses aria-pressed. Payload tabs share ruled selection with action-colored active text.
- Status: label plus 6px marker, 4px corners, 8px horizontal/4px vertical padding, 12px medium type. Neutral surface/text/border; native success, warning, destructive use matching soft fill, foreground, and 20% foreground border. Labels are not actions.
- Containers: reusable card primitive has surface fill, 1px border, 8px corners, no shadow or prescribed padding. Dashboard sections remain edge to edge.
- Rows: secondary hover, action-soft selection, mono tool/summary, tabular dates/duration. Desktop supports keyboard selection with inset focus outline; phone calls become full-width buttons.
- Payload: ruled tabs, secondary fill, 6px corners, 1px border, 12px padding, 12px mono/24px leading. Wrap long text and scroll inside a 58vh cap. Copy feedback remains readable.
- Inspector: 20px heading, close action, native status, ruled metadata, payload near top. Desktop permits successive row selection; modal contains focus. Escape dismisses; focus returns to the call or search fallback. Radix/application code supplies behavior beyond visual snippets.
- States: quiet loading skeletons, recovery messages, distinct absent-log versus unmatched-filter empty states. Health, tools, sources, context disclose inline.

## Do's and Don'ts

### Do:

- Do reuse semantic variables and shared components in both themes.
- Do pair chart and state colors with readable labels and visible keyboard focus.
- Do preserve native outcomes, identifiers, and payload text.
- Do reflow data for phones and respect reduced motion.

### Don't:

- Don't infer tool success from result presence.
- Don't add oversized color fields, floating dashboard frames, or decorative effects that compete with calls.
- Don't hard-code theme colors in shared components.
- Don't carry unused navigation or live-glow compatibility tokens into new surfaces.
