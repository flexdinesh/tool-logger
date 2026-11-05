import { createContext, useContext, useEffect, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { checkedResponse, clearApiCache } from "./api.ts";
import { isObject } from "../shared/api.ts";
import { desktop, quit } from "./bridge.ts";
import { Button } from "./components/ui/button.tsx";
import { Input } from "./components/ui/input.tsx";
type Session = { logout: () => void; ingestionEndpoint: string };
const SessionContext = createContext<Session | undefined>(undefined);
export function useIngestionEndpoint() { return useContext(SessionContext)?.ingestionEndpoint ?? ""; }
function parseEndpoint(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value !== "string") throw new Error("Unexpected ingestion endpoint.");
  const url = new URL(value);
  if (url.protocol !== "http:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("Unexpected ingestion endpoint.");
  return url.origin;
}
export function SessionAction() {
  const session = useContext(SessionContext);
  const [error, setError] = useState("");
  return <>{desktop() ? <Button variant="ghost" size="compact" onClick={() => { void quit().catch((e: unknown) => setError(e instanceof Error ? e.message : "Quit failed.")); }}>Quit</Button>
    : <Button variant="ghost" size="compact" onClick={session?.logout}>Logout</Button>}{error && <span role="alert">{error}</span>}</>;
}
export function SessionGate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<"checking" | "login" | "ready" | "error">("checking");
  const [error, setError] = useState("");
  const [token, setToken] = useState("");
  const [ingestionEndpoint, setIngestionEndpoint] = useState("");
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    void fetch("/ui/session", { credentials: "same-origin", signal: controller.signal }).then(async (r) => {
      if (r.status === 401) { if (active) setStatus("login"); return; }
      if (!r.ok) throw new Error("Session check failed (HTTP " + r.status + ").");
      const v: unknown = await r.json();
      if (!isObject(v) || v.authenticated !== true) throw new Error("Unexpected session response.");
      const endpoint = parseEndpoint(v.ingestionEndpoint);
      if (active) { setIngestionEndpoint(endpoint); setStatus("ready"); setError(""); }
    }).catch((e: unknown) => { if (active) { setError(e instanceof Error ? e.message : "Session check failed."); setStatus("error"); } });
    const expired = () => { clearApiCache(); setStatus("login"); setError("Session expired. Log in again."); };
    window.addEventListener("tool-logger:session-expired", expired);
    return () => { active = false; controller.abort(); window.removeEventListener("tool-logger:session-expired", expired); };
  }, [version]);
  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const submitted = token; setToken(""); setBusy(true); setError("");
    try {
      await checkedResponse("/ui/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: submitted }) });
      clearApiCache(); setStatus("checking"); setVersion((v) => v + 1);
    } catch (e) { setError(e instanceof Error ? e.message : "Login failed."); }
    finally { setBusy(false); }
  }
  function logout() {
    setBusy(true);
    void checkedResponse("/ui/session", { method: "DELETE" }).then(() => {
      clearApiCache(); setStatus("login"); setError("");
    }, (e: unknown) => setError(e instanceof Error ? e.message : "Logout failed.")).finally(() => setBusy(false));
  }
  if (status === "ready") return <SessionContext value={{ logout, ingestionEndpoint }}>{error && <div role="alert" className="session-error">{error}</div>}{children}</SessionContext>;
  return <main className="login-page"><section className="login-panel" aria-labelledby="login-title">
    <h1 id="login-title">Tool Logger</h1>
    {status === "checking" ? <p role="status">Checking session…</p> : status === "error" ? <><p role="alert">{error}</p><Button onClick={() => { setStatus("checking"); setVersion((v) => v + 1); }}>Retry connection</Button></> : <>
      <p>Log in with your administration token to view activity and manage sources.</p>
      <form onSubmit={(event) => { void login(event); }} autoComplete="off">
        <label htmlFor="admin-token">Administration token</label>
        <Input id="admin-token" type="password" autoComplete="off" value={token} onChange={(event) => setToken(event.currentTarget.value)} required autoFocus />
        <Button type="submit" disabled={busy || !token.trim()}>{busy ? "Logging in…" : "Log in"}</Button>
      </form>
      {error && <p role="alert">{error}</p>}
      <p className="detail-note">Source write tokens cannot log in. Your administration token is used only for this login.</p>
    </>}
  </section></main>;
}
