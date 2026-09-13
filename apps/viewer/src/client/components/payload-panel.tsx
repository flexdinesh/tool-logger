import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ToolCallDetail } from "../../shared/api.ts";
import type { PayloadTab } from "../state/viewer-reducer.ts";
import { Button } from "./ui/button.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs.tsx";

const tabs: { name: PayloadTab; label: string }[] = [
  { name: "input", label: "Input" },
  { name: "output", label: "Result" },
  { name: "raw", label: "Raw events" },
];

function isPayloadTab(value: string): value is PayloadTab {
  return value === "input" || value === "output" || value === "raw";
}

function CopyPayloadButton({ payload }: { payload: string }) {
  const [label, setLabel] = useState("Copy JSON");
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearTimeout(timer.current);
    };
  }, []);

  async function copy() {
    let result: string;
    try {
      await navigator.clipboard.writeText(payload);
      result = "Copied";
    } catch {
      result = "Select text to copy";
    }
    if (!mounted.current) return;
    clearTimeout(timer.current);
    setLabel(result);
    timer.current = setTimeout(() => setLabel("Copy JSON"), 1500);
  }

  return <Button id="copy" variant="ghost" size="compact" onClick={() => { void copy(); }}>{label === "Copied" ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}{label}</Button>;
}

export function PayloadPanel({ call, tab, onTabChange }: {
  call: ToolCallDetail;
  tab: PayloadTab;
  onTabChange: (tab: PayloadTab) => void;
}) {
  const value = tab === "input" ? call.input : tab === "output" ? call.output : call.native.events;
  const payload = tab === "output" && call.summary.lifecycle === "awaiting"
    ? "No matching result event has been observed."
    : JSON.stringify(value, null, 2) ?? "";
  return (
    <Tabs value={tab} onValueChange={(value) => { if (isPayloadTab(value)) onTabChange(value); }}>
      <TabsList className="detail-tabs" aria-label="Call payload">
        {tabs.map(({ name, label }) => (
          <TabsTrigger key={name} id={`tab-${name}`} value={name}>
            {label}
          </TabsTrigger>
        ))}
      </TabsList>
      <div className="payload-heading mt-5 mb-2 flex items-center justify-between gap-3 text-xs font-medium tracking-wide text-muted">
        <span id="payload-label">{tab === "input" ? "TOOL INPUT" : tab === "output" ? "TOOL RESULT" : "ORIGINAL HOOK EVENTS"}</span>
        <CopyPayloadButton payload={payload} />
      </div>
      <TabsContent value={tab} id="payload" className="max-h-[58vh] overflow-auto rounded-md border border-border bg-surface-secondary p-4 font-mono text-sm leading-7 text-secondary whitespace-pre-wrap wrap-break-word" tabIndex={0} aria-labelledby={`tab-${tab}`}>
        <pre>{payload}</pre>
      </TabsContent>
    </Tabs>
  );
}
