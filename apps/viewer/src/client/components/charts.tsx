import type { ToolCallMetrics } from "../../shared/api.ts";
import { calendarDate, clock, duration } from "../format.ts";

export function Charts({ metrics, onTool }: { metrics: ToolCallMetrics | undefined; onTool: (tool: string) => void }) {
  const activity = metrics?.data.activity ?? [];
  const peak = Math.max(1, ...activity.map((entry) => entry.count));
  const first = metrics?.data.window.since ?? activity[0]?.start;
  const last = metrics?.data.window.until ?? activity.at(-1)?.start;
  return <section className="activity-panel" aria-label="Activity overview">
    <div className="trace-heading"><h2>Activity trace</h2><div className="trace-legend"><span><i className="codex-color" />Codex</span><span><i className="opencode-color" />OpenCode</span></div></div>
    <div id="activity" className="activity-bars" role="img" aria-label={activity.length ? String(metrics?.data.totalCalls ?? 0) + " calls between " + new Date(first ?? "").toLocaleString() + " and " + new Date(last ?? "").toLocaleString() : "No calls in the selected window"}>
      {activity.map((entry, index) => <div key={entry.start} className="activity-bin" title={new Date(entry.start).toLocaleString() + " – " + new Date(activity[index + 1]?.start ?? last ?? entry.start).toLocaleString() + " · " + entry.count + " calls"}>
        <span className="activity-bar codex-color" style={{ transform: "translateY(-" + String(((entry.harnesses?.opencode ?? 0) / peak) * 100) + "%) scaleY(" + String((entry.harnesses?.codex ?? entry.count - (entry.harnesses?.opencode ?? 0)) / peak) + ")" }} />
        <span className="activity-bar opencode-color" style={{ transform: "scaleY(" + String((entry.harnesses?.opencode ?? 0) / peak) + ")" }} />
      </div>)}
    </div>
    <div className="chart-axis"><span id="chart-from">{first ? calendarDate(first) + " · " + clock(first) : "No events yet"}</span><span id="chart-to">{last ? calendarDate(last) + " · " + clock(last) : "Now"}</span></div>
    <details className="tool-breakdown"><summary>Tool breakdown <span id="tool-count">· {metrics?.data.toolUsage.length ?? 0} tools</span></summary>
      <div className="tool-breakdown-content"><p>Average duration <strong id="stat-duration">{duration(metrics?.data.averageDurationMs ?? null)}</strong></p><div id="tools">{metrics?.data.toolUsage.map(({ tool, count }) => <button key={tool} type="button" onClick={() => onTool(tool)} title={"Filter by " + tool}>{tool}<span>{count}</span></button>)}</div></div>
    </details>
  </section>;
}
