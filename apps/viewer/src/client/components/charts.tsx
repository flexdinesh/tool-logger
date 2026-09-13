import type { ToolCallMetrics } from "../../shared/api.ts";
import { clock } from "../format.ts";
import { Card } from "./ui/card.tsx";

function ActivityChart({ metrics }: { metrics: ToolCallMetrics | undefined }) {
  const activity = metrics?.data.activity ?? [];
  const peak = Math.max(1, ...activity.map((entry) => entry.count));
  const first = activity[0]?.start;
  const last = activity.at(-1)?.start;
  return (
    <Card className="activity-panel p-5">
      <div className="panel-heading flex items-center justify-between"><h2 className="text-base font-semibold">Activity over time</h2><span className="legend flex items-center gap-1.5 text-xs text-muted"><i className="size-2 rounded-sm bg-chart-strong" /> Tool calls</span></div>
      <div id="activity" className="activity-bars" role="img" aria-label={activity.length
        ? `${metrics?.data.totalCalls ?? 0} calls between ${clock(first ?? "")} and ${clock(last ?? "")}`
        : "No calls in the selected window"}>
        {activity.map((entry) => <div key={entry.start} className="activity-bar" style={{ height: `${(entry.count / peak) * 100}%` }} title={`${clock(entry.start)} · ${entry.count} call${entry.count === 1 ? "" : "s"}`} />)}
      </div>
      <div className="chart-axis mt-3 flex justify-between text-xs text-muted"><span id="chart-from">{first ? clock(first) : "No events yet"}</span><span id="chart-to">{last ? clock(last) : "Now"}</span></div>
    </Card>
  );
}

function ToolUsageChart({ metrics, onTool }: { metrics: ToolCallMetrics | undefined; onTool: (tool: string) => void }) {
  const tools = metrics?.data.toolUsage ?? [];
  const top = tools.slice(0, 4);
  return (
    <Card className="tools-panel p-5">
      <div className="panel-heading flex items-center justify-between"><h2 className="text-base font-semibold">Tools in use</h2><span id="tool-count" className="text-xs text-muted">{tools.length} tools</span></div>
      <div id="tools" className="tool-bars mt-5 flex flex-col gap-3">{top.map(({ tool, count }) => <button key={tool} className="tool-row grid grid-cols-[minmax(95px,1fr)_1fr_25px] items-center gap-3 text-left text-sm text-secondary outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring" type="button" title={`Filter by ${tool}`} onClick={() => onTool(tool)}><span className="tool-name truncate">{tool}</span><span className="tool-track h-1.5 overflow-hidden rounded-sm bg-surface-secondary"><span className="tool-fill block h-full rounded-sm bg-chart" style={{ width: `${(count / Math.max(1, top[0]?.count ?? 1)) * 100}%` }} /></span><span className="text-right text-xs tabular-nums">{count}</span></button>)}{!top.length && <p className="text-sm text-muted">Tools appear here as calls arrive.</p>}</div>
    </Card>
  );
}

export function Charts({ metrics, onTool }: { metrics: ToolCallMetrics | undefined; onTool: (tool: string) => void }) {
  return (
    <section className="charts mb-6 grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.7fr)_minmax(240px,1fr)]" aria-label="Activity overview">
      <ActivityChart metrics={metrics} />
      <ToolUsageChart metrics={metrics} onTool={onTool} />
    </section>
  );
}
