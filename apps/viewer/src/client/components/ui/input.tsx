import type { InputHTMLAttributes, Ref } from "react";
import { cn } from "@/lib/utils.ts";

export function Input({ className, ref, ...props }: InputHTMLAttributes<HTMLInputElement> & { ref?: Ref<HTMLInputElement> }) {
  return <input ref={ref} className={cn("h-8 min-w-0 rounded-md border border-border bg-surface px-3 text-sm text-foreground outline-none max-sm:h-11 placeholder:text-muted focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20 disabled:cursor-not-allowed disabled:opacity-50", className)} {...props} />;
}
