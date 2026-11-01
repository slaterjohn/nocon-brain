"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { LogOut } from "lucide-react";
import { cn } from "@/lib/utils";
import { areas, isActive } from "@/lib/nav";
import { api, get, useApi, errorMessage } from "@/lib/api";
import type { Me, SetupStatus } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { ErrorState, LoadingSkeleton } from "./states";
import { ThemeToggle } from "./theme";
import { ConnectivityIndicator, EventsProvider, WorkOfflineSwitch } from "./events";
import { BrowserProvider } from "@/components/browser/tabs";

export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn("font-semibold tracking-tight", className)}>
      NoCon<span className="text-primary">Brain</span>
    </span>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { toast } = useToast();
  const me = useApi<Me>("/api/auth/me");
  const [checkedSetup, setCheckedSetup] = React.useState(false);

  // Send people to the wizard until setup is complete. A 409 `setup_required` from any call does the same (lib/api.ts).
  React.useEffect(() => {
    if (!me.data) return;
    get<SetupStatus>("/api/setup/status")
      .then((s) => {
        if (!s.complete) window.location.replace("/setup");
        else setCheckedSetup(true);
      })
      .catch(() => setCheckedSetup(true));
  }, [me.data]);

  async function logout() {
    try {
      await api("/api/auth/logout", { method: "POST", noRedirect: true });
    } catch (e) {
      toast({ title: "Couldn't sign out", description: errorMessage(e), variant: "error" });
      return;
    }
    window.location.assign("/login");
  }

  const ready = !!me.data && checkedSetup;
  const guest = me.data?.mode === "guest";

  return (
    <EventsProvider enabled={!!me.data}>
    <BrowserProvider>
    <div className="flex min-h-dvh flex-col">
      <a
        href="#main"
        className="sr-only z-[200] rounded-md bg-primary px-3 py-2 text-primary-foreground focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
      >
        Skip to main content
      </a>
      <header className="flex h-14 shrink-0 items-center gap-3 border-b bg-background px-3 sm:px-4">
        <Link href="/" className="rounded-md px-1 text-lg">
          <Wordmark />
        </Link>
        <div className="ml-auto flex items-center gap-2">
          <ConnectivityIndicator />
          {me.data && !guest ? <WorkOfflineSwitch /> : null}
          <ThemeToggle />
          {me.data ? (
            <>
              <span className="hidden text-sm text-muted-foreground sm:inline" data-testid="signed-in-as">
                {guest ? "Guest" : me.data.user.username}
              </span>
              {guest ? (
                <Button asChild variant="outline" size="sm">
                  <Link href="/login">Sign in</Link>
                </Button>
              ) : (
                <Button variant="outline" size="sm" onClick={() => void logout()}>
                  <LogOut aria-hidden="true" /> Sign out
                </Button>
              )}
            </>
          ) : null}
        </div>
      </header>
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <nav
          aria-label="Areas"
          className="shrink-0 border-b bg-sidebar p-2 lg:w-56 lg:border-r lg:border-b-0 lg:p-3"
        >
          <ul className="flex gap-1 overflow-x-auto lg:flex-col lg:overflow-visible">
            {areas.map((item) => {
              const active = isActive(item, pathname);
              const Icon = item.icon;
              return (
                <li key={item.href} className="shrink-0">
                  <Link
                    href={item.href}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "flex items-center gap-2.5 rounded-md px-3 py-2 text-sm whitespace-nowrap hover:bg-accent hover:text-accent-foreground",
                      active && "bg-accent font-medium text-accent-foreground",
                    )}
                  >
                    <Icon className="size-4 shrink-0" aria-hidden="true" />
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
        <main id="main" tabIndex={-1} className="min-w-0 flex-1 outline-none">
          {me.error ? (
            me.error.status === 401 ? (
              <div className="p-6"><LoadingSkeleton variant="page" label="Redirecting to sign in" /></div>
            ) : (
              <div className="p-6"><ErrorState title="Couldn't reach the server" message={me.error.message} onRetry={() => void me.mutate()} /></div>
            )
          ) : !ready ? (
            <div className="p-6"><LoadingSkeleton variant="page" label="Loading" /></div>
          ) : (
            children
          )}
        </main>
      </div>
    </div>
    </BrowserProvider>
    </EventsProvider>
  );
}
