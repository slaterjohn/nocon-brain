"use client";

import * as React from "react";
import { CheckCircle2, AlertTriangle, Info, X } from "lucide-react";
import { cn } from "@/lib/utils";

type Variant = "default" | "success" | "error";
interface ToastItem {
  id: number;
  title: string;
  description?: string;
  variant: Variant;
}
interface ToastApi {
  toast: (t: { title: string; description?: string; variant?: Variant }) => void;
}

const Ctx = React.createContext<ToastApi>({ toast: () => {} });
export const useToast = () => React.useContext(Ctx);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = React.useState<ToastItem[]>([]);
  const idRef = React.useRef(0);

  const dismiss = React.useCallback((id: number) => setItems((l) => l.filter((t) => t.id !== id)), []);
  const toast = React.useCallback<ToastApi["toast"]>(
    (t) => {
      const id = ++idRef.current;
      setItems((l) => [...l.slice(-3), { id, title: t.title, description: t.description, variant: t.variant ?? "default" }]);
      setTimeout(() => dismiss(id), t.variant === "error" ? 10000 : 5000);
    },
    [dismiss],
  );
  const value = React.useMemo(() => ({ toast }), [toast]);

  const render = (list: ToastItem[]) =>
    list.map((t) => (
      <div
        key={t.id}
        className={cn(
          "pointer-events-auto flex items-start gap-2 rounded-lg border bg-popover p-3 text-sm text-popover-foreground shadow-lg",
          t.variant === "error" && "border-destructive",
          t.variant === "success" && "border-success",
        )}
      >
        {t.variant === "error" ? (
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden="true" />
        ) : t.variant === "success" ? (
          <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" aria-hidden="true" />
        ) : (
          <Info className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
        )}
        <div className="min-w-0 flex-1">
          <p className="font-medium">{t.title}</p>
          {t.description ? <p className="text-muted-foreground">{t.description}</p> : null}
        </div>
        <button
          type="button"
          onClick={() => dismiss(t.id)}
          className="rounded p-1 text-muted-foreground hover:bg-accent"
        >
          <X className="size-3.5" aria-hidden="true" />
          <span className="sr-only">Dismiss</span>
        </button>
      </div>
    ));

  return (
    <Ctx.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed right-4 bottom-4 z-[100] flex w-[calc(100%-2rem)] max-w-sm flex-col gap-2">
        <div role="status" aria-live="polite" className="flex flex-col gap-2">
          {render(items.filter((t) => t.variant !== "error"))}
        </div>
        <div role="alert" aria-live="assertive" className="flex flex-col gap-2">
          {render(items.filter((t) => t.variant === "error"))}
        </div>
      </div>
    </Ctx.Provider>
  );
}
