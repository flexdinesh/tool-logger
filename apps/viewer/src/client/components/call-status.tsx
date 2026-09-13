import type { HarnessDescriptor, ToolCallSummary } from "../../shared/api.ts";
import { Badge } from "./ui/badge.tsx";

export function CallStatus({ call, descriptor }: { call: ToolCallSummary; descriptor: HarnessDescriptor | undefined }) {
  const label = call.outcome === "failure" ? "Failed"
    : call.outcome === "success" ? "Succeeded"
      : call.lifecycle === "awaiting" ? "Awaiting result"
        : call.lifecycle === "result-only" ? "Result only" : "Result received";
  const variant = call.outcome === "failure" ? "destructive"
    : call.outcome === "success" ? "success" : call.lifecycle === "awaiting" ? "warning" : "success";
  const semantics = descriptor?.capabilities.outcomeSemantics[call.outcome];
  return (
    <Badge className="status-pill" variant={variant} title={semantics}>
      <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
      {label}
    </Badge>
  );
}
