import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils.ts";

export function Alert({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div role="alert" className={cn("rounded-md border border-destructive/20 bg-destructive-soft px-4 py-3 text-sm text-destructive", className)} {...props} />;
}
