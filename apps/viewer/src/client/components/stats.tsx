import { Activity, Check, CircleX, Clock3, Timer } from "lucide-react";
import type { HarnessDescriptor, ToolCallMetrics } from "../../shared/api.ts";
import { duration, number } from "../format.ts";
import { Card } from "./ui/card.tsx";

export function Stats({ metrics, descriptor }: {
  metrics: ToolCallMetrics | undefined;
  descriptor: HarnessDescriptor | undefined;
}) {
  const data = metrics?.data;
  const explicit = Boolean(data && data.successCalls + data.failureCalls > 0);
  const cardClass = "stat p-4 lg:p-5";
  const labelClass = "stat-label flex items-center justify-between text-sm text-secondary";
  const valueClass = "my-4 block text-2xl font-semibold tracking-tight text-foreground";
  const captionClass = "stat-caption text-xs leading-5 text-muted";
  return <div className="stats mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4 lg:gap-4">
    <Card className={cardClass}><div className={labelClass}>Tool calls <Activity aria-hidden="true" className="size-4 text-muted" /></div><strong className={valueClass} id="stat-calls">{number(data?.totalCalls ?? 0)}</strong><div className={captionClass}>Across the selected view</div></Card>
    <Card className={cardClass}><div className={labelClass}>{explicit ? "Succeeded" : "Results received"} <Check aria-hidden="true" className="size-4 text-success" /></div><strong className={valueClass} id="stat-completed">{number(explicit ? data?.successCalls ?? 0 : data?.completedCalls ?? 0)}</strong><div className={captionClass}><span className="tiny-dot mr-1.5 inline-block size-1.5 rounded-full bg-success" /> {explicit ? descriptor?.capabilities.outcomeSemantics.success : "Post-tool events received"}</div></Card>
    <Card className={cardClass}><div className={labelClass}>{explicit ? "Failed" : "Awaiting result"} {explicit ? <CircleX aria-hidden="true" className="size-4 text-destructive" /> : <Clock3 aria-hidden="true" className="size-4 text-warning" />}</div><strong className={valueClass} id="stat-awaiting">{number(explicit ? data?.failureCalls ?? 0 : data?.awaitingCalls ?? 0)}</strong><div className={captionClass}>{explicit ? descriptor?.capabilities.outcomeSemantics.failure : "No matching result observed"}</div></Card>
    <Card className={cardClass}><div className={labelClass}>Average duration <Timer aria-hidden="true" className="size-4 text-muted" /></div><strong className={valueClass} id="stat-duration">{duration(data?.averageDurationMs ?? null)}</strong><div className={captionClass}>Time between paired hook events</div></Card>
  </div>;
}
