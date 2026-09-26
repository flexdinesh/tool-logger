---
version: 1
slug: "src-client-app-tsx"
primary_target: "src/client/app.tsx"
related_targets: ["src/client/styles.css","src/client/components/inspector.tsx"]
---

# Viewer dashboard

Mode: Operate. Developers scan local runs and inspect native evidence.
Scope: Graphite light/dark dashboard, compact controls, right inspector; preserve read-only APIs, filters, URLs, live updates and outcome semantics.

## Direction contract

THESIS: A compact console workspace keeps calls dominant, with evidence beside the list.

OWN-WORLD: Charcoal, slate and soft lime in dark mode; near-white, slate ink and deep green accents in light mode. Thin neutral rules, small controls, no oversized color field or floating dashboard frame.

STORY: Scan health and activity, scope All/Codex/OpenCode, filter calls, inspect native evidence, then continue through the list.

FIRST VIEWPORT: A 44px brand/status/theme bar; compact title/scope and summary row; shallow two-series trace; search and newest calls. Desktop details dock at right with payload visible near the top. Phones use a full-width accessible sheet.

FORM: User-selected Graphite, grounded candidate 2, seed 8bca8fd3, round 1; code-first. User overrides the concept's bottom dock with a right inspector and requests both themes. Signature interaction: select successive rows while the desktop inspector stays open; theme selection persists across reloads. Motion is a short horizontal reveal, immediate with reduced motion.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

Open decisions: none. System theme on first visit; explicit light/dark choice saved locally. Decision image is a critique reference, not a pixel spec. No shipping raster assets.

## Finish evidence

2026-09-26: Graphite light/dark implemented. Desktop >=70rem uses a nonmodal right inspector; phones use a full-width modal sheet. Explicit theme choices persist locally.

Typecheck, Vite build, and all 11 browser tests passed. Nine settled desktop/phone captures reviewed. Detector: zero findings. Fresh finish reviewer: ship; no material fixes owed. Optional future work: expose selected call state programmatically. Verdict: .impeccable/review/graphite-verdict.md.

DESIGN.md and .impeccable/design.json regenerated from shipping tokens/components and verified. No shipping raster assets.
