import { number } from "../format.ts";
import { useViewerState } from "../state/viewer-context.ts";
import { sourceHealth } from "./sources.tsx";
export function Stats() {
  const { metrics, loading, sources, selectedSources } = useViewerState();
  const data = metrics?.data, pending = loading && !data;
  const relevant = selectedSources.length ? sources.filter((s) => selectedSources.includes(s.id)) : sources;
  const problems = relevant.filter((s) => sourceHealth(s) !== "Online");
  return <section className="metric-ribbon" aria-label="Activity summary" aria-busy={pending}>
    <div className="metric"><span>Tool calls</span><strong id="stat-calls">{pending ? "…" : number(data?.totalCalls ?? 0)}</strong></div>
    <div className="metric"><span>Results observed</span><strong id="stat-completed">{pending ? "…" : number(data?.completedCalls ?? 0)}</strong>{Boolean(data?.failureCalls) && <small className="text-destructive">{number(data?.failureCalls ?? 0)} failed</small>}</div>
    <div className="metric"><span>Awaiting result</span><strong id="stat-awaiting" className={data?.awaitingCalls ? "text-warning" : ""}>{pending ? "…" : number(data?.awaitingCalls ?? 0)}</strong></div>
    <details className="metric health"><summary><span>Source health</span><strong className={problems.length ? "text-warning" : ""}>{!relevant.length ? "No sources" : problems.length ? problems.length + " need attention" : "Online"}</strong></summary><div className="health-details">{relevant.map((s) => <p key={s.id}>{s.name}: {sourceHealth(s)} · {s.pendingEvents} pending · {s.rejectedEvents} rejected</p>)}<p>Results observed does not imply success. Outcomes follow each harness.</p></div></details>
  </section>;
}
