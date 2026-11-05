import * as DialogPrimitive from "@radix-ui/react-dialog";
import { forwardRef } from "react";
import type { ComponentPropsWithoutRef, ComponentRef, HTMLAttributes } from "react";
import { cn } from "@/lib/utils.ts";

export const Sheet = DialogPrimitive.Root;

export const SheetContent = forwardRef<
  ComponentRef<typeof DialogPrimitive.Content>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & { docked?: boolean }
>(({ className, children, docked = false, ...props }, ref) => (
  <DialogPrimitive.Portal>
    {!docked && <DialogPrimitive.Overlay className="overlay fixed inset-0 z-40 bg-overlay" />}
    <DialogPrimitive.Content
      ref={ref}
      className={cn("inspector fixed inset-y-0 right-0 z-50 w-full overflow-y-auto bg-surface p-4 outline-none", docked ? "inspector-docked" : "shadow-overlay sm:max-w-[520px]", className)}
      {...props}
    >
      {children}
    </DialogPrimitive.Content>
  </DialogPrimitive.Portal>
));
SheetContent.displayName = DialogPrimitive.Content.displayName;

export function SheetHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex items-center justify-between gap-4", className)} {...props} />;
}

export const SheetTitle = DialogPrimitive.Title;
