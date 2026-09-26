import { ChevronDown } from "lucide-react";
import type { SelectHTMLAttributes } from "react";
import { cn } from "@/lib/utils.ts";

export function Select({ className, children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <span className={cn("relative inline-flex min-w-0 items-center", className)}>
      <select className="h-8 w-full appearance-none rounded-md border border-border bg-surface py-0 pr-9 pl-3 text-sm text-secondary outline-none transition-colors max-sm:h-11 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20 disabled:cursor-not-allowed disabled:opacity-50" {...props}>{children}</select>
      <ChevronDown aria-hidden="true" className="pointer-events-none absolute right-3 size-4 text-muted" />
    </span>
  );
}
