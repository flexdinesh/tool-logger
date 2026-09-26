import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const css = readFileSync(new URL("../src/client/styles.css", import.meta.url), "utf8");

test("typography uses a deliberate rem-based scale", () => {
  const tokenValues = [...css.matchAll(/--font-size-[\w-]+:\s*([^;]+);/g)].map((match) => match[1]);
  assert.deepEqual(tokenValues, ["0.75rem", "0.875rem", "1rem", "1.125rem", "1.25rem", "1.5rem", "2rem"]);
  assert.ok(tokenValues.every((value) => value?.endsWith("rem")));
  assert.match(css, /body\s*{[^}]*font-size:\s*var\(--font-size-md\)/s);
  assert.doesNotMatch(css, /(?:font|font-size|letter-spacing):[^;]*\dpx/);
});

test("spacing, radii, and semantic colors use constrained tokens", () => {
  assert.deepEqual(
    [...css.matchAll(/--space-[\w-]+:\s*([^;]+);/g)].map((match) => match[1]),
    ["0.25rem", "0.5rem", "0.75rem", "1rem", "1.5rem", "2rem", "3rem", "4rem"],
  );
  assert.deepEqual(
    [...css.matchAll(/--shape-radius-[\w-]+:\s*([^;]+);/g)].map((match) => match[1]),
    ["0.25rem", "0.375rem", "0.5rem"],
  );
  for (const token of [
    "--color-app-bg", "--color-bg-surface", "--color-text-primary", "--color-text-secondary",
    "--color-text-muted", "--color-stroke", "--color-stroke-strong", "--color-action",
    "--color-action-hover", "--color-state-success", "--color-state-warning", "--color-state-destructive",
  ]) assert.match(css, new RegExp(`${token}:`));

  const components = css.replace(/:root(?:\[data-theme=light\])?\s*\{[\s\S]*?\}/g, "");
  assert.doesNotMatch(components, /#[\da-f]{3,8}\b/i);
});
