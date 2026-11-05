import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app.tsx";
import { ViewerProvider } from "./state/viewer-provider.tsx";
import { loadPreferences, PreferencesProvider } from "./preferences.tsx";
import type { Preferences } from "./preferences.tsx";
import { SessionGate } from "./session.tsx";
import { isObject } from "../shared/api.ts";
import "./styles.css";

function Root({ initial, serverId }: { initial: Preferences; serverId: string }) {
  return <StrictMode><PreferencesProvider initial={initial} serverId={serverId}><SessionGate><ViewerProvider><App /></ViewerProvider></SessionGate></PreferencesProvider></StrictMode>;
}
function BootFailure({ error }: { error: string }) {
  const [busy, setBusy] = useState(false);
  return <main className="login-page"><section className="login-panel"><h1>Tool Logger</h1><p role="alert">{error}</p><button disabled={busy} onClick={() => { setBusy(true); location.reload(); }}>Retry startup</button></section></main>;
}
const element = document.getElementById("root");
if (!element) throw new Error("Missing application root");
const root = createRoot(element);
async function boot() {
  const response = await fetch("/ui/connection", { credentials: "same-origin", cache: "no-store" });
  if (!response.ok) throw new Error("Connection identity unavailable.");
  const value: unknown = await response.json();
  if (!isObject(value) || typeof value.serverId !== "string" || !value.serverId) throw new Error("Invalid connection identity.");
  const initial = await loadPreferences(value.serverId);
  return { initial, serverId: value.serverId };
}
void boot().then((props) => root.render(<Root {...props} />),
  (e: unknown) => root.render(<BootFailure error={e instanceof Error ? e.message : "Preferences could not be loaded."} />));
