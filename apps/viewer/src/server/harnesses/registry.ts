import { codexAdapter } from "./codex.ts";
import { openCodeAdapter } from "./opencode.ts";
import type { HarnessAdapter } from "./types.ts";

export const harnessAdapters: readonly HarnessAdapter[] = [codexAdapter, openCodeAdapter];

export function harnessAdapter(id: string): HarnessAdapter | undefined {
  return harnessAdapters.find((adapter) => adapter.id === id);
}
