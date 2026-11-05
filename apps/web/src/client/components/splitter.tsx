import type { PointerEvent } from "react";
export function Splitter({ label, value, min, max, onChange, percentage = false }: {
  label: string; value: number; min: number; max: number; onChange: (value: number) => void; percentage?: boolean;
}) {
  function drag(event: PointerEvent<HTMLDivElement>) {
    event.preventDefault();
    const start = event.clientX, original = value;
    const width = percentage ? innerWidth : event.currentTarget.parentElement?.getBoundingClientRect().width ?? innerWidth;
    event.currentTarget.setPointerCapture(event.pointerId);
    const target = event.currentTarget;
    const move = (e: globalThis.PointerEvent) => onChange(Math.max(min, Math.min(max, original + (e.clientX - start) * (percentage ? 100 / width : 1))));
    const done = () => { target.removeEventListener("pointermove", move); target.removeEventListener("pointerup", done); target.removeEventListener("pointercancel", done); };
    target.addEventListener("pointermove", move); target.addEventListener("pointerup", done); target.addEventListener("pointercancel", done);
  }
  return <div className="pane-splitter" role="separator" aria-label={label} aria-orientation="vertical" aria-valuenow={Math.round(value)} aria-valuemin={min} aria-valuemax={max} tabIndex={0} onPointerDown={drag}
    onKeyDown={(e) => { if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "Home" || e.key === "End") {
      e.preventDefault(); onChange(e.key === "Home" ? min : e.key === "End" ? max : Math.max(min, Math.min(max, value + (e.key === "ArrowLeft" ? -1 : 1) * (percentage ? 2 : 16))));
    } }} />;
}
