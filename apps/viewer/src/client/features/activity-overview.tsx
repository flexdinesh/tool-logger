import { Charts } from "../components/charts.tsx";
import { Stats } from "../components/stats.tsx";
import { Alert } from "../components/ui/alert.tsx";
import { Button } from "../components/ui/button.tsx";
import { useViewerActions, useViewerState } from "../state/viewer-context.ts";

export function ActivityHeading() {
  const { harnessList, selectedHarness } = useViewerState();
  const { selectHarness } = useViewerActions();
  const harnesses = harnessList?.data ?? [];
  return <div className="dashboard-heading"><div className="scope-heading">
    <div><h1>Tool activity</h1><p>Recent calls across your coding tools.</p></div>
    <div className="harness-switch" role="group" aria-label="Filter by harness">
      {harnesses.length > 0 && [{ id: "all", label: "All harnesses" }, ...harnesses].map((harness) =>
        <button key={harness.id} type="button" aria-pressed={selectedHarness === harness.id} onClick={() => selectHarness(harness.id)}>{harness.label}</button>)}
      {harnessList && !harnesses.length && <span>No harness data</span>}
    </div>
  </div><Stats /></div>;
}

export function ActivityOverview() {
  const { metrics } = useViewerState();
  const { changeFilter } = useViewerActions();
  return <Charts metrics={metrics} onTool={(tool) => changeFilter("tool", tool)} />;
}

export function ConnectionNotice() {
  const { error, harnessError } = useViewerState();
  const { retry } = useViewerActions();
  const message = [harnessError, error].filter(Boolean).join(" ");
  return <Alert id="error" className="connection-notice" hidden={!message}>{message} <Button variant="ghost" size="compact" onClick={retry}>Retry connection</Button></Alert>;
}

export function LogSource() {
  const { harnessList, selectedHarness } = useViewerState();
  const sources = harnessList?.sourceHealth.filter((source) => !selectedHarness || selectedHarness === "all" || source.harness === selectedHarness) ?? [];
  return <footer className="source-line"><details><summary>Log sources <span>· {sources.length} sources</span></summary>
    <div id="source">{sources.map((source) => <div key={source.harness}><strong>{source.harness === "codex" ? "Codex" : "OpenCode"}</strong><code>{source.sourceLabel}</code><span>{source.message ?? source.status}</span></div>)}</div>
  </details><span className="read-only">Read only</span></footer>;
}
