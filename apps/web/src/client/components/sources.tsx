import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { Plus, Settings, X } from "lucide-react";
import { api } from "../api.ts";
import { useIngestionEndpoint } from "../session.tsx";
import { isObject } from "../../shared/api.ts";
import type { Source, SourceCredentials } from "../../shared/api.ts";
import { useViewerActions, useViewerState } from "../state/viewer-context.ts";
import { Button } from "./ui/button.tsx";
import { Input } from "./ui/input.tsx";
export function sourceHealth(source: Source): string {
  if (source.status === "revoked") return "Revoked";
  if (source.lastError || source.rejectedEvents > 0) return "Delivery errors";
  if (source.pendingEvents > 0) return "Backlog";
  if (!source.lastSeenAt) return "Awaiting heartbeat";
  if (Date.now() - Date.parse(source.lastSeenAt) > 120_000) return "Stale heartbeat";
  return source.status === "online" ? "Online" : source.status;
}
function SourceEvidence({ source }: { source: Source }) {
  return <dl className="source-evidence"><dt>Source UUID</dt><dd><code>{source.id}</code></dd>
    <dt>Delivery</dt><dd>{sourceHealth(source)}</dd>
    <dt>Last heartbeat</dt><dd>{source.lastSeenAt ? new Date(source.lastSeenAt).toLocaleString() : "Not recorded"}</dd>
    <dt>Last event</dt><dd>{source.lastEventAt ? new Date(source.lastEventAt).toLocaleString() : "Not recorded"}</dd>
    <dt>Pending / rejected</dt><dd>{source.pendingEvents} / {source.rejectedEvents}</dd>
    {source.lastError && <><dt>Forwarder error</dt><dd className="text-warning">{source.lastError}</dd></>}
    <dt>Labels</dt><dd><pre>{JSON.stringify(source.labels, null, 2)}</pre></dd></dl>;
}
export function SourceSidebar() {
  const { sources, selectedSources, harnessList, selectedHarnesses, diagnostics } = useViewerState();
  const { selectSource, toggleSource, toggleHarness, selectHarness, setDiagnostics } = useViewerActions();
  const [editing, setEditing] = useState<string | null>(null);
  return <aside className="source-sidebar" aria-label="Sources and harnesses">
    <section className="sidebar-section"><h2>Harnesses</h2><Button variant="ghost" size="compact" aria-pressed={!selectedHarnesses.length} onClick={() => selectHarness("all")}>All harnesses</Button>
      {harnessList?.data.map((h) => <label key={h.id} className="scope-option"><input type="checkbox" checked={selectedHarnesses.includes(h.id)} onChange={() => toggleHarness(h.id)} /><span>{h.label}</span></label>)}
    </section>
    <section className="sidebar-section"><div className="sidebar-heading"><h2>Sources</h2><Button variant="ghost" size="icon" aria-label="Add source" onClick={() => setEditing("")}><Plus aria-hidden="true" /></Button></div>
      <Button variant="ghost" size="compact" aria-pressed={!selectedSources.length} onClick={() => selectSource("all")}>All sources</Button>
      {sources.map((source) => <div key={source.id} className="source-option"><label className="scope-option"><input type="checkbox" checked={selectedSources.includes(source.id)} onChange={() => toggleSource(source.id)} /><span><strong>{source.name}</strong><small>{source.hostname || source.platform || source.id.slice(0, 8)} · {sourceHealth(source)}</small></span></label><Button variant="ghost" size="icon" aria-label={"Manage source " + source.name} onClick={() => setEditing(source.id)}><Settings aria-hidden="true" /></Button></div>)}
      {!sources.length && <p>No sources yet. Add a source to connect a machine or container.</p>}
    </section>
    <Button variant="ghost" size="compact" onClick={() => setDiagnostics(!diagnostics)}>Connection diagnostics</Button>
    {editing !== null && <SourceSetup key={editing} source={sources.find((s) => s.id === editing)} onClose={() => setEditing(null)} />}
  </aside>;
}
function SourceSetup({ source, onClose }: { source: Source | undefined; onClose: () => void }) {
  const { sources } = useViewerState();
  const { refreshSources } = useViewerActions();
  const [id, setId] = useState(source?.id ?? "");
  const [name, setName] = useState(source?.name ?? "");
  const [hostname, setHostname] = useState(source?.hostname ?? "");
  const [platform, setPlatform] = useState(source?.platform ?? "");
  const [labels, setLabels] = useState(JSON.stringify(source?.labels ?? {}, null, 2));
  const [credentials, setCredentials] = useState<SourceCredentials>();
  const initialEndpoint = useIngestionEndpoint();
  const [endpoint, setEndpoint] = useState(initialEndpoint);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const evidence = sources.find((s) => s.id === id) ?? source;
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(""); setNotice("");
    let parsed: unknown;
    try { parsed = JSON.parse(labels); } catch { setError("Labels must be a JSON object with string values."); return; }
    if (!isObject(parsed) || Object.values(parsed).some((v) => typeof v !== "string")) { setError("Labels must be a JSON object with string values."); return; }
    const checked: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) if (typeof value === "string") {
      Object.defineProperty(checked, key, { value, enumerable: true, configurable: true, writable: true });
    }
    const request = { name: name.trim(), hostname, platform, labels: checked };
    setBusy(true);
    try {
      if (id) {
        const updated = await api.updateSource(id, request);
        if (alive.current) setCredentials((c) => c ? { ...c, source: updated } : undefined);
      } else {
        const created = await api.createSource(request);
        if (alive.current) { setId(created.source.id); setCredentials(created); }
      }
      refreshSources(); if (alive.current) setNotice("Source saved");
    } catch (reason) { if (alive.current) setError(reason instanceof Error ? reason.message : "Source save failed."); }
    finally { if (alive.current) setBusy(false); }
  }
  async function tokenAction(rotate: boolean) {
    setBusy(true); setError(""); setNotice(""); setCredentials(undefined);
    try {
      if (rotate) { const c = await api.rotateSource(id); if (alive.current) { setCredentials(c); setNotice("Token rotated. Update source.json on this source."); } }
      else { await api.revokeSource(id); if (alive.current) { setNotice("Token revoked. History retained."); setConfirmRevoke(false); } }
      refreshSources();
    } catch (reason) { if (alive.current) setError(reason instanceof Error ? reason.message : "Token action failed."); }
    finally { if (alive.current) setBusy(false); }
  }
  const config = credentials ? JSON.stringify({ schemaVersion: 1, sourceId: credentials.source.id, endpoint, token: credentials.token, name: credentials.source.name, labels: credentials.source.labels }, null, 2) : "";
  return <section className="source-setup" aria-label={id ? "Manage source" : "Add source"}>
    <div className="sidebar-heading"><h2>{id ? "Manage source" : "Add source"}</h2><Button variant="ghost" size="icon" aria-label="Close source setup" onClick={onClose}><X aria-hidden="true" /></Button></div>
    <p>Each machine or container has its own source UUID. Its token can write only that source’s events.</p>
    <form onSubmit={(event) => { void save(event); }}>
      <label>Source name<Input aria-label="Source name" value={name} onChange={(e) => setName(e.currentTarget.value)} required /></label>
      <label>Hostname<Input aria-label="Source hostname" value={hostname} onChange={(e) => setHostname(e.currentTarget.value)} /></label>
      <label>Platform<Input aria-label="Source platform" value={platform} onChange={(e) => setPlatform(e.currentTarget.value)} placeholder="linux or darwin" /></label>
      <label>Labels (JSON object)<textarea aria-label="Source labels" value={labels} onChange={(e) => setLabels(e.currentTarget.value)} rows={4} /></label>
      <Button type="submit" disabled={busy || !name.trim()}>{id ? "Save source" : "Create source"}</Button>
    </form>
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {id && <div className="token-actions"><Button variant="outline" size="compact" disabled={busy} onClick={() => { void tokenAction(true); }}>Rotate token</Button>
      {confirmRevoke ? <><p>Revoking stops delivery. History remains available.</p><Button variant="outline" size="compact" disabled={busy} onClick={() => { void tokenAction(false); }}>Confirm revoke</Button><Button variant="ghost" size="compact" onClick={() => setConfirmRevoke(false)}>Keep token</Button></> : <Button variant="outline" size="compact" disabled={busy} onClick={() => setConfirmRevoke(true)}>Revoke token…</Button>}
    </div>}
    {credentials && <section className="source-credentials"><h3>Source configuration</h3><p>Copy now. This token appears only after creation or rotation. Save as source.json in this source’s state directory.</p>
      <label>Forwarder endpoint<Input aria-label="Forwarder endpoint" type="url" placeholder="http://host:ingestion-port" value={endpoint} onChange={(e) => setEndpoint(e.currentTarget.value)} /></label>
      <p>Use the ingestion listener. For remote sources, enter the reachable host, SSH tunnel or private network endpoint.</p>
      <textarea aria-label="Source configuration JSON" rows={10} readOnly value={config} />
      <Button size="compact" onClick={() => { void navigator.clipboard.writeText(config).then(() => { if (alive.current) setNotice("Configuration copied"); }, () => { if (alive.current) setError("Copy failed. Select the configuration text to copy."); }); }}>Copy configuration</Button>
    </section>}
    {evidence && <SourceEvidence source={evidence} />}
  </section>;
}
export function Diagnostics() {
  const { diagnostics, sources } = useViewerState();
  const { setDiagnostics, retry } = useViewerActions();
  const [result, setResult] = useState("");
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  if (!diagnostics) return null;
  async function diagnose() {
    setBusy(true); setResult("Testing connection…");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try { await api.sources(controller.signal); if (alive.current) setResult("Server reachable; administration access accepted."); retry(); }
    catch (e) { if (alive.current) setResult((e instanceof Error ? e.message : "Connection failed.") + " Check listener, host gateway and SSH/VPN tunnel."); }
    finally { clearTimeout(timeout); if (alive.current) setBusy(false); }
  }
  return <section className="diagnostics" aria-label="Connection diagnostics"><div className="sidebar-heading"><h2>Connection diagnostics</h2><Button size="icon" variant="ghost" aria-label="Close diagnostics" onClick={() => setDiagnostics(false)}><X aria-hidden="true" /></Button></div>
    <p>UI connection: <code>{location.origin}</code></p><p>The UI listener serves this client. Source forwarders use the separate ingestion listener. No legacy history is imported.</p>
    <Button size="compact" disabled={busy} onClick={() => { void diagnose(); }}>Test connection</Button><p role="status">{result}</p>
    {sources.map((s) => <details key={s.id}><summary>{s.name} · {sourceHealth(s)}</summary><SourceEvidence source={s} /></details>)}
  </section>;
}
