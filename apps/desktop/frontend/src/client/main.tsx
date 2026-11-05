import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app.tsx";
import { ViewerProvider } from "./state/viewer-provider.tsx";
import { loadPreferences, PreferencesProvider } from "./preferences.tsx";
import type { Preferences } from "./preferences.tsx";
import { SessionGate } from "./session.tsx";
import "./styles.css";

function Root({ initial }: { initial: Preferences }) {
  return <StrictMode><PreferencesProvider initial={initial}><SessionGate><ViewerProvider><App /></ViewerProvider></SessionGate></PreferencesProvider></StrictMode>;
}
function BootFailure({ error }: { error: string }) {
  const [busy, setBusy] = useState(false);
  return <main className="login-page"><section className="login-panel"><h1>Tool Logger</h1><p role="alert">{error}</p><button disabled={busy} onClick={() => { setBusy(true); location.reload(); }}>Retry startup</button></section></main>;
}
const element = document.getElementById("root");
if (!element) throw new Error("Missing application root");
const root = createRoot(element);
void loadPreferences().then((initial) => root.render(<Root initial={initial} />),
  (e: unknown) => root.render(<BootFailure error={e instanceof Error ? e.message : "Preferences could not be loaded."} />));
