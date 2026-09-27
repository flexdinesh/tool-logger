import { Inspector } from "../components/inspector.tsx";
import { useViewerActions, useViewerFocus, useViewerState } from "../state/viewer-context.ts";

export function CallInspector() {
  const { selectedCall, selectedCallId, selectedCallHarness, detailLoading, detailError, harnessList, payloadTab } = useViewerState();
  const { closeInspector, selectPayloadTab, retryDetail } = useViewerActions();
  const { returnFocusRef, searchRef } = useViewerFocus();
  if (!selectedCallId) return null;

  return (
    <Inspector
      key={selectedCallId} call={selectedCall} loading={detailLoading} error={detailError} onRetry={retryDetail}
      descriptor={harnessList?.data.find((harness) => harness.id === selectedCallHarness)}
      tab={payloadTab} onTabChange={selectPayloadTab} onClose={closeInspector}
      returnFocusRef={returnFocusRef} searchRef={searchRef}
    />
  );
}
