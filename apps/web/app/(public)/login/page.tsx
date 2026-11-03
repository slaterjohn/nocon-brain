"use client";

import * as React from "react";
import { ApiError, api, get } from "@/lib/api";
import type { SetupStatus } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import { Field, FormError } from "@/components/common/form";
import { ThemeToggle } from "@/components/layout/theme";
import { Wordmark } from "@/components/layout/app-shell";

export default function LoginPage() {
  const [username, setUsername] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [expired, setExpired] = React.useState(false);
  const [fieldError, setFieldError] = React.useState<{ username?: string; password?: string }>({});

  // Sent here because the session ended: say so, so the sign-in screen does not look like a failure of its own.
  React.useEffect(() => setExpired(new URLSearchParams(window.location.search).get("expired") === "1"), []);

  // First run: no administrator yet, so there is nothing to sign in to.
  React.useEffect(() => {
    get<SetupStatus>("/api/setup/status")
      .then((s) => {
        if (!s.adminExists) window.location.replace("/setup");
      })
      .catch(() => {});
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const fe: typeof fieldError = {};
    if (!username.trim()) fe.username = "Enter the username.";
    if (!password) fe.password = "Enter the password.";
    setFieldError(fe);
    if (fe.username || fe.password) return;
    setBusy(true);
    setError(null);
    try {
      await api("/api/auth/login", { method: "POST", body: { username: username.trim(), password }, noRedirect: true });
      const next = new URLSearchParams(window.location.search).get("next");
      window.location.assign(next && next.startsWith("/") && !next.startsWith("//") ? next : "/");
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) {
        setError("Too many sign-in attempts. Wait a minute, then try again.");
      } else if (err instanceof ApiError && err.status === 401) {
        setError("The username or password is wrong. Check both and try again.");
      } else if (err instanceof ApiError && err.code === "setup_required") {
        window.location.assign("/setup");
      } else {
        setError(err instanceof ApiError && err.code === "network" ? err.message : "Sign-in didn't work. Check the connection, then try again.");
      }
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center p-4">
      <div className="absolute top-3 right-3">
        <ThemeToggle />
      </div>
      <main id="main" className="w-full max-w-sm">
        <div className="mb-6 text-center text-2xl" aria-hidden="true">
          <Wordmark />
        </div>
        <Card>
          <CardHeader>
            <h1 className="text-xl leading-tight font-semibold">Sign in to NoConBrain</h1>
            <CardDescription>Use the administrator account created during setup.</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={submit} noValidate className="space-y-4">
              {expired && !error ? (
                <p role="status" className="rounded-md border bg-muted px-3 py-2 text-sm" data-testid="session-ended">
                  Your session has ended. Sign in again to carry on where you were.
                </p>
              ) : null}
              <FormError message={error} />
              <Field id="username" label="Username" error={fieldError.username}>
                {(p) => (
                  <Input {...p} autoComplete="username" autoFocus value={username} onChange={(e) => setUsername(e.target.value)} />
                )}
              </Field>
              <Field id="password" label="Password" error={fieldError.password}>
                {(p) => (
                  <Input {...p} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
                )}
              </Field>
              <Button type="submit" className="w-full" disabled={busy}>
                {busy ? "Signing in…" : "Sign in"}
              </Button>
            </form>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
