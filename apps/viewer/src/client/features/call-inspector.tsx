import { Inspector } from "../components/inspector.tsx";
import { useViewerActions, useViewerFocus, useViewerState } from "../state/viewer-context.ts";

export function CallInspector() {
  const { selectedCall, descriptor, payloadTab } = useViewerState();
  const { closeInspector, selectPayloadTab } = useViewerActions();
  const { returnFocusRef, searchRef } = useViewerFocus();
  if (!selectedCall) return null;

  return (
    <Inspector
      key={selectedCall.summary.id} call={selectedCall} descriptor={descriptor}
      tab={payloadTab} onTabChange={selectPayloadTab} onClose={closeInspector}
      returnFocusRef={returnFocusRef} searchRef={searchRef}
    />
  );
}
