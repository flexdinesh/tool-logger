import { Charts } from "../components/charts.tsx";
import { Stats } from "../components/stats.tsx";
import { Alert } from "../components/ui/alert.tsx";
import { Button } from "../components/ui/button.tsx";
import { useViewerActions, useViewerState } from "../state/viewer-context.ts";
import { usePreferences } from "../preferences.tsx";
export function ActivityHeading() {
  const { harnessList, selectedHarnesses } = useViewerState();
  const { selectHarness } = useViewerActions();
  const { preferences, updatePreferences } = usePreferences();
  return <div className="dashboard-heading"><div className="scope-heading"><h1>Tool activity</h1>
    <div className="harness-switch" role="group" aria-label="Filter by harness">{[{ id: "all", label: "All harnesses" }, ...harnessList?.data ?? []].map((h) => <button key={h.id} type="button" aria-pressed={h.id === "all" ? !selectedHarnesses.length : selectedHarnesses.length === 1 && selectedHarnesses[0] === h.id} onClick={() => selectHarness(h.id)}>{h.label}</button>)}</div>
    <Button variant="ghost" size="compact" aria-pressed={!preferences.chartsHidden} onClick={() => updatePreferences({ chartsHidden: !preferences.chartsHidden })}>{preferences.chartsHidden ? "Show charts" : "Hide charts"}</Button>
  </div><Stats /></div>;
}
export function ActivityOverview() {
  const { metrics } = useViewerState(); const { changeFilter } = useViewerActions(); const { preferences } = usePreferences();
  return preferences.chartsHidden ? null : <Charts metrics={metrics} onTool={(tool) => changeFilter("tool", tool)} />;
}
export function ConnectionNotice() {
  const { error, harnessError } = useViewerState(); const { retry } = useViewerActions();
  const message = [harnessError, error].filter(Boolean).join(" ");
  return <Alert id="error" className="connection-notice" hidden={!message}>{message} <Button variant="ghost" size="compact" onClick={retry}>Retry connection</Button></Alert>;
}
export function LogSource() {
  const { live, calls } = useViewerState();
  return <footer className="source-line"><span>{live ? "Live · target 1 second" : "Paused · activity frozen"}</span><span>{calls.length} loaded</span></footer>;
}
