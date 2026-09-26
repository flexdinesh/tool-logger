import { Inspector } from "../components/inspector.tsx";
import { useViewerActions, useViewerFocus, useViewerState } from "../state/viewer-context.ts";

export function CallInspector() {
  const { selectedCall, selectedCallId, detailLoading, error, harnessList, payloadTab } = useViewerState();
  const { closeInspector, selectPayloadTab } = useViewerActions();
  const { returnFocusRef, searchRef } = useViewerFocus();
  if (!selectedCallId) return null;

  return (
    <Inspector
      key={selectedCallId} call={selectedCall} loading={detailLoading} error={error}
      descriptor={harnessList?.data.find((harness) => harness.id === selectedCall?.summary.harness)}
      tab={payloadTab} onTabChange={selectPayloadTab} onClose={closeInspector}
      returnFocusRef={returnFocusRef} searchRef={searchRef}
    />
  );
}
