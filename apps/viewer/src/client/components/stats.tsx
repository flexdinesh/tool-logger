import { Check, CircleAlert } from "lucide-react";
import { number } from "../format.ts";
import { useViewerState } from "../state/viewer-context.ts";

export function Stats() {
  const { metrics, sourceHealth, loading, harnessList, selectedHarness } = useViewerState();
  const data = metrics?.data;
  const pending = loading && !data;
  const statuses = harnessList?.sourceHealth.map((source) => source.status) ?? [];
  const health = sourceHealth?.status ?? (statuses.includes("unreadable") ? "unreadable" : statuses.includes("partial") ? "partial" : statuses.includes("healthy") ? "healthy" : harnessList ? "missing" : undefined);
  const healthLabel = health === "healthy" ? "Healthy" : health === "partial" ? "Partial" : health === "unreadable" ? "Unreadable" : health === "missing" ? "No logs" : "Reading…";
  const sources = harnessList?.sourceHealth.filter((source) => !selectedHarness || selectedHarness === "all" || source.harness === selectedHarness) ?? [];
  return <section className="metric-ribbon" aria-label="Activity summary" aria-busy={pending}>
    <div className="metric"><span>Tool calls</span><strong id="stat-calls">{pending ? "—" : number(data?.totalCalls ?? 0)}</strong></div>
    <div className="metric"><span>Results observed</span><strong id="stat-completed">{pending ? "—" : number(data?.completedCalls ?? 0)}</strong>{Boolean(data?.failureCalls) && <small className="text-destructive">{number(data?.failureCalls ?? 0)} failed</small>}</div>
    <div className="metric"><span>Awaiting result</span><strong id="stat-awaiting" className={data?.awaitingCalls ? "text-warning" : ""}>{pending ? "—" : number(data?.awaitingCalls ?? 0)}</strong></div>
    <details className="metric health"><summary><span>Source health</span><strong className={health === "healthy" ? "text-success" : health === "unreadable" ? "text-destructive" : "text-warning"}>{health === "healthy" ? <Check aria-hidden="true" /> : <CircleAlert aria-hidden="true" />}{healthLabel}</strong></summary>
      <div className="health-details">{sources.map((source) => <p key={source.harness}>{source.harness === "codex" ? "Codex" : "OpenCode"}: {source.message ?? source.status}</p>)}<p>Results observed does not imply success. Outcomes follow each harness.</p></div>
    </details>
  </section>;
}
