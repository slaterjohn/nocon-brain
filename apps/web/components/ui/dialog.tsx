"use client";

import * as React from "react";
import { Dialog as D } from "radix-ui";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

export const Dialog = D.Root;
export const DialogTrigger = D.Trigger;
export const DialogClose = D.Close;
export const DialogTitle = ({ className, ...p }: React.ComponentProps<typeof D.Title>) => (
  <D.Title className={cn("text-lg font-semibold tracking-tight", className)} {...p} />
);
export const DialogDescription = ({ className, ...p }: React.ComponentProps<typeof D.Description>) => (
  <D.Description className={cn("text-sm text-muted-foreground", className)} {...p} />
);

/** Modal dialog. Radix traps focus, closes on Escape and returns focus to the trigger. */
export function DialogContent({ className, children, ...props }: React.ComponentProps<typeof D.Content>) {
  return (
    <D.Portal>
      <D.Overlay className="fixed inset-0 z-50 bg-black/50" />
      <D.Content
        className={cn(
          "fixed top-1/2 left-1/2 z-50 flex max-h-[90dvh] w-[calc(100vw-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 flex-col gap-4 overflow-y-auto rounded-lg border bg-popover p-5 text-popover-foreground shadow-lg",
          className,
        )}
        {...props}
      >
        {children}
        <D.Close className="absolute top-3 right-3 inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground">
          <X className="size-4" aria-hidden="true" />
          <span className="sr-only">Close</span>
        </D.Close>
      </D.Content>
    </D.Portal>
  );
}
