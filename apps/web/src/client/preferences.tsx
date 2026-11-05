import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { desktop, saveShellPreferences, shellPreferences } from "./bridge.ts";
import { defaults, normalizePreferences } from "./preferences-model.ts";
import type { Preferences } from "./preferences-model.ts";
export { defaultColumns, defaults, isPayloadTab, normalizePreferences } from "./preferences-model.ts";
export type { Theme, PayloadTab, Preferences } from "./preferences-model.ts";
export function preferencesStorageKey(serverId: string): string { return "tool-logger-web-preferences-v1:" + serverId; }
export async function loadPreferences(serverId: string): Promise<Preferences> {
  if (desktop()) return normalizePreferences(await shellPreferences());
  try { return normalizePreferences(JSON.parse(localStorage.getItem(preferencesStorageKey(serverId)) ?? "null")); }
  catch { return structuredClone(defaults); }
}
type Settings = { preferences: Preferences; updatePreferences: (patch: Partial<Preferences>) => void; preferencesError: string };
const Context = createContext<Settings | undefined>(undefined);
export function PreferencesProvider({ initial, serverId, children }: { initial: Preferences; serverId: string; children: ReactNode }) {
  const key = preferencesStorageKey(serverId);
  const [preferences, setPreferences] = useState(initial);
  const [preferencesError, setError] = useState("");
  const saveQueue = useRef(Promise.resolve());
  useEffect(() => {
    document.documentElement.style.setProperty("--inspector-width", "max(300px, " + (100 - preferences.collection) + "vw)");
  }, [preferences.collection]);
  useEffect(() => {
    const query = matchMedia("(prefers-color-scheme: dark)");
    const apply = () => { document.documentElement.dataset.theme = preferences.theme === "system" ? query.matches ? "dark" : "light" : preferences.theme; };
    apply(); query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }, [preferences.theme]);
  useEffect(() => {
    let active = true;
    const timer = setTimeout(() => {
      const save = async () => {
        try {
          if (desktop()) await saveShellPreferences(preferences);
          else localStorage.setItem(key, JSON.stringify(preferences));
          if (active) setError("");
        } catch (reason) { if (active) setError(reason instanceof Error ? reason.message : "Preferences could not be saved."); }
      };
      saveQueue.current = saveQueue.current.then(save, save);
    }, 200);
    return () => { active = false; clearTimeout(timer); };
  }, [preferences, key]);
  const updatePreferences = useCallback((patch: Partial<Preferences>) => setPreferences((p) => ({ ...p, ...patch })), []);
  const value = useMemo(() => ({ preferences, preferencesError, updatePreferences }), [preferences, preferencesError, updatePreferences]);
  return <Context value={value}>{children}</Context>;
}
export function usePreferences() {
  const value = useContext(Context);
  if (!value) throw new Error("PreferencesProvider missing");
  return value;
}
