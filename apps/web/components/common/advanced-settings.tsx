"use client";

import * as React from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Disclosure for rarely changed options. Closed by default, remembers nothing.
 * The panel is hidden with the `hidden` attribute, so its fields stay in React state and are still submitted.
 */
export function AdvancedSettings({
  open,
  onOpenChange,
  changed = 0,
  children,
  title = "Advanced settings",
  id,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** How many advanced values differ from their defaults. */
  changed?: number;
  children: React.ReactNode;
  title?: string;
  id?: string;
}) {
  const autoId = React.useId();
  const base = id ?? `adv${autoId.replace(/:/g, "")}`;
  const panelId = `${base}-panel`;
  const buttonId = `${base}-button`;
  return (
    <div className="rounded-lg border">
      <button
        type="button"
        id={buttonId}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => onOpenChange(!open)}
        className="flex w-full items-center gap-2 rounded-lg px-4 py-3 text-left text-sm font-medium hover:bg-accent"
      >
        <ChevronRight className={cn("size-4 shrink-0 transition-transform", open && "rotate-90")} aria-hidden="true" />
        <span>
          {title}
          {changed > 0 ? <span className="font-normal text-muted-foreground"> · {changed} changed</span> : null}
        </span>
      </button>
      <div id={panelId} role="region" aria-labelledby={buttonId} hidden={!open} className="space-y-5 border-t p-4">
        {children}
      </div>
    </div>
  );
}

/**
 * Open-state and focus handling for a form with an AdvancedSettings section.
 * Call `reveal(errors)` after validation: it opens the section if any error is inside it
 * and moves focus to the first invalid field.
 */
export function useAdvancedDisclosure(advancedKeys: readonly string[]) {
  const [open, setOpen] = React.useState(false);
  const [tick, setTick] = React.useState(0);
  const formRef = React.useRef<HTMLFormElement>(null);

  React.useEffect(() => {
    if (!tick) return;
    const el = formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]');
    el?.focus();
  }, [tick]);

  const reveal = React.useCallback(
    (errors: Record<string, string>) => {
      const keys = Object.keys(errors);
      if (!keys.length) return;
      if (keys.some((k) => advancedKeys.some((a) => k === a || k.startsWith(`${a}.`)))) setOpen(true);
      setTick((t) => t + 1);
    },
    [advancedKeys],
  );

  return { open, setOpen, reveal, formRef };
}
