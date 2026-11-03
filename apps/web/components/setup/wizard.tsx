"use client";

import * as React from "react";
import { AlertTriangle, Check } from "lucide-react";
import { ApiError, api, errorMessage, fieldErrors, get, post } from "@/lib/api";
import type { Me, ResourceProfile, SetupStatus, SetupStorageResponse, SetupStorageValidateResponse, StorageWarning } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input, Select } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardFooter, CardHeader } from "@/components/ui/card";
import { Field, FormError } from "@/components/common/form";
import { AdvancedSettings } from "@/components/common/advanced-settings";
import { ThemeToggle } from "@/components/layout/theme";
import { Wordmark } from "@/components/layout/app-shell";
import { SourceNotice } from "@/components/layout/source-notice";
import { LoadingSkeleton } from "@/components/layout/states";
import { Label } from "@/components/ui/label";

const STEPS = ["Administrator", "Storage", "Resources", "Online search", "First source", "Finish"] as const;
const GIB = 1024 ** 3;

const WARNING_TEXT: Record<StorageWarning, string> = {
  on_container_filesystem:
    "This folder is on the container's own filesystem. Anything saved here is lost if the container is recreated. Mount a drive or volume and use that path instead.",
  sd_card_suspected:
    "This looks like an SD card. Archiving writes a lot of small files, which wears SD cards quickly. An SSD over USB is a better choice.",
  low_free_space: "This location has little free space. Downloads will pause when free space runs low.",
};

export function SetupWizard() {
  const [step, setStep] = React.useState<number | null>(null);
  const [status, setStatus] = React.useState<SetupStatus | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const headingRef = React.useRef<HTMLHeadingElement>(null);
  const first = React.useRef(true);

  React.useEffect(() => {
    (async () => {
      try {
        const s = await get<SetupStatus>("/api/setup/status");
        if (s.complete) {
          window.location.replace("/");
          return;
        }
        setStatus(s);
        if (!s.adminExists) return setStep(0);
        // Resuming: the later steps need the administrator's session.
        try {
          await api<Me>("/api/auth/me", { noRedirect: true });
        } catch (e) {
          if (e instanceof ApiError && e.status === 401) {
            window.location.replace("/login?next=/setup");
            return;
          }
          throw e;
        }
        setStep(!s.storageConfigured ? 1 : !s.profile ? 2 : 3);
      } catch (e) {
        setLoadError(errorMessage(e));
      }
    })();
  }, []);

  // Move focus to the new step's heading so keyboard and screen-reader users land in the right place.
  React.useEffect(() => {
    if (step === null) return;
    if (first.current) {
      first.current = false;
      return;
    }
    headingRef.current?.focus();
  }, [step]);

  const next = () => setStep((s) => (s === null ? 0 : Math.min(s + 1, STEPS.length - 1)));

  return (
    <div className="flex min-h-dvh flex-col items-center p-4 sm:py-10">
      <div className="absolute top-3 right-3">
        <ThemeToggle />
      </div>
      <main id="main" className="w-full max-w-xl">
        <div className="mb-6 text-center text-2xl" aria-hidden="true">
          <Wordmark />
        </div>
        {loadError ? (
          <FormError message={`Couldn't start setup. ${loadError}`} />
        ) : step === null || !status ? (
          <LoadingSkeleton variant="page" label="Loading setup" />
        ) : (
          <>
            <ol className="mb-4 flex flex-wrap gap-x-4 gap-y-1 text-sm" aria-label="Setup progress">
              {STEPS.map((name, i) => (
                <li
                  key={name}
                  aria-current={i === step ? "step" : undefined}
                  className={cn("flex items-center gap-1", i === step ? "font-semibold" : "text-muted-foreground")}
                >
                  {i < step ? <Check className="size-3.5" aria-hidden="true" /> : <span aria-hidden="true">{i + 1}.</span>}
                  {name}
                  {i < step ? <span className="sr-only"> (done)</span> : null}
                </li>
              ))}
            </ol>
            {step === 0 ? <AdminStep headingRef={headingRef} onDone={next} /> : null}
            {step === 1 ? <StorageStep headingRef={headingRef} onDone={next} /> : null}
            {step === 2 ? <ProfileStep headingRef={headingRef} initial={status.profile ?? undefined} onDone={next} /> : null}
            {step === 3 ? <ProvidersStep headingRef={headingRef} onDone={next} /> : null}
            {step === 4 ? <SourceStep headingRef={headingRef} onDone={next} created={status.firstSourceCreated} /> : null}
            {step === 5 ? <FinishStep headingRef={headingRef} /> : null}
          </>
        )}
      </main>
      <SourceNotice className="mt-8 border-t-0" />
    </div>
  );
}

type StepProps = { headingRef: React.RefObject<HTMLHeadingElement | null>; onDone: () => void };

function StepCard({
  title,
  description,
  headingRef,
  children,
}: {
  title: string;
  description: React.ReactNode;
  headingRef: React.RefObject<HTMLHeadingElement | null>;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <h1 ref={headingRef} tabIndex={-1} className="text-xl leading-tight font-semibold outline-none">
          {title}
        </h1>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      {children}
    </Card>
  );
}

function AdminStep({ headingRef, onDone }: StepProps) {
  const [username, setUsername] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [confirm, setConfirm] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [errs, setErrs] = React.useState<Record<string, string>>({});

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const fe: Record<string, string> = {};
    if (username.trim().length < 3) fe.username = "Use at least 3 characters.";
    if (password.length < 10) fe.password = "Use at least 10 characters. A few random words work well.";
    if (confirm !== password) fe.confirm = "The two passwords don't match.";
    setErrs(fe);
    setError(null);
    if (Object.keys(fe).length) return;
    setBusy(true);
    try {
      await api("/api/setup/admin", { method: "POST", body: { username: username.trim(), password }, noRedirect: true });
      // The contract doesn't say whether creating the admin also signs in. Check, and sign in if not.
      try {
        await api<Me>("/api/auth/me", { noRedirect: true });
      } catch {
        await api("/api/auth/login", { method: "POST", body: { username: username.trim(), password }, noRedirect: true });
      }
      onDone();
    } catch (err) {
      const f = fieldErrors(err);
      setErrs(f);
      setError(Object.keys(f).length ? "Fix the highlighted fields and try again." : errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <StepCard headingRef={headingRef} title="Create the administrator account" description="This account manages NoConBrain. There is no way to recover the password, so keep it somewhere safe.">
      <form onSubmit={submit} noValidate>
        <CardContent className="space-y-4">
          <FormError message={error} />
          <Field id="admin-username" label="Username" error={errs.username}>
            {(p) => <Input {...p} autoComplete="username" autoFocus value={username} onChange={(e) => setUsername(e.target.value)} />}
          </Field>
          <Field id="admin-password" label="Password" hint="At least 10 characters." error={errs.password}>
            {(p) => <Input {...p} type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />}
          </Field>
          <Field id="admin-confirm" label="Confirm password" error={errs.confirm}>
            {(p) => <Input {...p} type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />}
          </Field>
        </CardContent>
        <CardFooter>
          <Button type="submit" disabled={busy}>{busy ? "Creating…" : "Create account"}</Button>
        </CardFooter>
      </form>
    </StepCard>
  );
}

function formatGb(bytes: number) {
  const gb = bytes / GIB;
  return `${gb >= 100 ? Math.round(gb) : gb.toFixed(1)} GB`;
}

function StorageStep({ headingRef, onDone }: StepProps) {
  const [path, setPath] = React.useState("/volumes/main");
  const [name, setName] = React.useState("Main");
  const [quotaGb, setQuotaGb] = React.useState("");
  const [reserveGb, setReserveGb] = React.useState("");
  const [advOpen, setAdvOpen] = React.useState(false);
  const [checking, setChecking] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [errs, setErrs] = React.useState<Record<string, string>>({});
  // The last successful check, and the path it was for. Editing the path discards it.
  const [checked, setChecked] = React.useState<{ path: string; result: SetupStorageValidateResponse } | null>(null);
  const latest = React.useRef(0);

  const bytesOf = (v: string) => {
    const n = Number(v);
    return Math.round(n * GIB);
  };
  const badNumber = (v: string) => v.trim() !== "" && (!Number.isFinite(Number(v)) || Number(v) < 0);

  async function check(): Promise<SetupStorageValidateResponse | null> {
    const p = path.trim();
    if (checked && checked.path === p) return checked.result;
    if (!p.startsWith("/")) {
      setErrs((e) => ({ ...e, path: "Enter an absolute folder path, starting with /." }));
      setError(null);
      return null;
    }
    const mine = ++latest.current;
    setChecking(true);
    setError(null);
    setErrs((e) => ({ ...e, path: "" }));
    try {
      const result = await api<SetupStorageValidateResponse>("/api/setup/storage/validate", {
        method: "POST",
        noRedirect: true,
        body: { path: p, ...(reserveGb.trim() && !badNumber(reserveGb) ? { reserveFreeBytes: bytesOf(reserveGb) } : {}) },
      });
      if (mine !== latest.current) return null;
      if (result.ok) {
        setChecked({ path: p, result });
      } else {
        setChecked(null);
        const msg = result.errors[0]?.message ?? "That folder can't be used.";
        setErrs((e) => ({ ...e, path: msg }));
        setError(result.errors.map((x) => x.message).join(" ") || msg);
      }
      return result;
    } catch (err) {
      if (mine !== latest.current) return null;
      setChecked(null);
      setError(errorMessage(err));
      return null;
    } finally {
      if (mine === latest.current) setChecking(false);
    }
  }

  async function register(e: React.FormEvent) {
    e.preventDefault();
    const fe: Record<string, string> = {};
    if (!name.trim()) fe.name = "Give the volume a name.";
    if (badNumber(quotaGb)) fe.quotaBytes = "Enter a number of gigabytes, or leave this empty.";
    if (badNumber(reserveGb)) fe.reserveFreeBytes = "Enter a number of gigabytes, or leave this empty.";
    setErrs(fe);
    setError(null);
    if (Object.keys(fe).length) {
      if (fe.quotaBytes || fe.reserveFreeBytes) setAdvOpen(true);
      return;
    }
    // Nothing is registered until the folder has passed a check.
    if (!checked || checked.path !== path.trim()) {
      await check();
      return;
    }
    setBusy(true);
    try {
      await api<SetupStorageResponse>("/api/setup/storage", {
        method: "POST",
        noRedirect: true,
        body: {
          path: path.trim(),
          name: name.trim(),
          ...(quotaGb.trim() ? { quotaBytes: bytesOf(quotaGb) } : {}),
          ...(reserveGb.trim() ? { reserveFreeBytes: bytesOf(reserveGb) } : {}),
        },
      });
      onDone();
    } catch (err) {
      const f = fieldErrors(err);
      setErrs(f);
      if (f.quotaBytes || f.reserveFreeBytes) setAdvOpen(true);
      setChecked(null);
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  const result = checked && checked.path === path.trim() ? checked.result : null;

  return (
    <StepCard headingRef={headingRef} title="Choose where to keep archived pages" description="Pick a folder on a drive with plenty of free space. NoConBrain checks the folder before it uses it.">
      <form onSubmit={register} noValidate>
        <CardContent className="space-y-4">
          <FormError message={error} />
          <Field id="vol-path" label="Folder path" hint="Must be inside an allowed storage root. In Docker this is usually under /volumes." error={errs.path}>
            {(p) => (
              <Input
                {...p}
                autoFocus
                value={path}
                onChange={(e) => {
                  setPath(e.target.value);
                  setChecked(null);
                  setError(null);
                }}
                onBlur={() => {
                  if (path.trim()) void check();
                }}
                spellCheck={false}
                className="font-mono"
              />
            )}
          </Field>
          <Field id="vol-name" label="Name" error={errs.name}>
            {(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} />}
          </Field>
          <AdvancedSettings open={advOpen} onOpenChange={setAdvOpen} changed={(quotaGb ? 1 : 0) + (reserveGb ? 1 : 0)}>
            <Field id="vol-quota" label="Limit in GB" optional hint="Stop archiving at this size, even if the drive has more room." error={errs.quotaBytes}>
              {(p) => <Input {...p} inputMode="decimal" value={quotaGb} onChange={(e) => setQuotaGb(e.target.value)} />}
            </Field>
            <Field id="vol-reserve" label="Keep this much free, in GB" optional hint="Downloads pause before free space drops below this." error={errs.reserveFreeBytes}>
              {(p) => <Input {...p} inputMode="decimal" value={reserveGb} onChange={(e) => { setReserveGb(e.target.value); setChecked(null); }} />}
            </Field>
          </AdvancedSettings>
          <div aria-live="polite" data-testid="storage-checks" className="space-y-2">
            {checking ? <p className="text-sm text-muted-foreground">Checking the folder…</p> : null}
            {result ? (
              <>
                <p className="flex items-center gap-2 text-sm">
                  <Check className="size-4 shrink-0 text-success" aria-hidden="true" />
                  <span>
                    This folder can be used
                    {result.freeBytes !== undefined && result.totalBytes !== undefined
                      ? `. ${formatGb(result.freeBytes)} free of ${formatGb(result.totalBytes)}.`
                      : "."}
                  </span>
                </p>
                {result.warnings.length ? (
                  <ul className="space-y-2" aria-label="Warnings">
                    {result.warnings.map((w) => (
                      <li key={w} className="flex gap-2 rounded-md border border-warning/60 p-3 text-sm">
                        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
                        <span>{WARNING_TEXT[w] ?? w}</span>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </>
            ) : null}
          </div>
        </CardContent>
        <CardFooter className="gap-2">
          {result ? (
            <Button type="submit" disabled={busy}>{busy ? "Saving…" : "Use this folder"}</Button>
          ) : (
            <Button type="submit" disabled={checking}>{checking ? "Checking…" : "Check folder"}</Button>
          )}
        </CardFooter>
      </form>
    </StepCard>
  );
}

const PROFILES: { value: ResourceProfile; title: string; text: string }[] = [
  { value: "pi-lite", title: "Raspberry Pi (light)", text: "Fewer parallel downloads, less memory, gentler on the CPU and the drive. Choose this for a Raspberry Pi or other small device." },
  { value: "standard", title: "Standard", text: "More parallel work and more memory. Choose this for a desktop, laptop or server." },
];

function ProfileStep({ headingRef, initial, onDone }: StepProps & { initial?: ResourceProfile }) {
  const [profile, setProfile] = React.useState<ResourceProfile>(initial ?? "standard");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/api/setup/profile", { method: "POST", body: { profile }, noRedirect: true });
      onDone();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <StepCard headingRef={headingRef} title="Choose a resource profile" description="This sets how hard NoConBrain works. You can change it later.">
      <form onSubmit={submit}>
        <CardContent className="space-y-4">
          <FormError message={error} />
          <fieldset className="space-y-2">
            <legend className="sr-only">Resource profile</legend>
            {PROFILES.map((p) => (
              <label key={p.value} htmlFor={`profile-${p.value}`} className={cn("flex cursor-pointer gap-3 rounded-md border p-3 has-[:checked]:border-primary has-[:checked]:bg-accent")}>
                <input
                  id={`profile-${p.value}`}
                  type="radio"
                  name="profile"
                  value={p.value}
                  checked={profile === p.value}
                  onChange={() => setProfile(p.value)}
                  className="mt-1 size-4 accent-[var(--primary)]"
                />
                <span>
                  <span className="block text-sm font-medium">{p.title}</span>
                  <span className="block text-sm text-muted-foreground">{p.text}</span>
                </span>
              </label>
            ))}
          </fieldset>
        </CardContent>
        <CardFooter>
          <Button type="submit" disabled={busy}>{busy ? "Saving…" : "Continue"}</Button>
        </CardFooter>
      </form>
    </StepCard>
  );
}

const PROVIDER_KINDS = [
  { value: "searxng", label: "SearXNG (your own server)", needsUrl: true, needsKey: false },
  { value: "brave", label: "Brave Search", needsUrl: false, needsKey: true },
  { value: "mojeek", label: "Mojeek", needsUrl: false, needsKey: true },
] as const;

function ProvidersStep({ headingRef, onDone }: StepProps) {
  const [adding, setAdding] = React.useState(false);
  const [kind, setKind] = React.useState<(typeof PROVIDER_KINDS)[number]["value"]>("searxng");
  const [baseUrl, setBaseUrl] = React.useState("");
  const [apiKey, setApiKey] = React.useState("");
  const [ack, setAck] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [errs, setErrs] = React.useState<Record<string, string>>({});
  const def = PROVIDER_KINDS.find((k) => k.value === kind)!;

  // Skipping is recorded on the server (`skip: true`); if that call fails the wizard still moves on, because
  // the step is optional and no provider is needed to reach the main UI.
  async function skip() {
    await api("/api/setup/providers", { method: "POST", body: { skip: true }, noRedirect: true }).catch(() => {});
    onDone();
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const fe: Record<string, string> = {};
    if (def.needsUrl && !/^https?:\/\//i.test(baseUrl.trim())) fe.baseUrl = "Enter the full address, starting with http:// or https://.";
    if (def.needsKey && !apiKey.trim()) fe.apiKey = "Enter the API key from the provider.";
    if (!ack) fe.ack = "Confirm that you understand before adding a provider.";
    setErrs(fe);
    setError(null);
    if (Object.keys(fe).length) return;
    setBusy(true);
    try {
      await api("/api/setup/providers", {
        method: "POST",
        noRedirect: true,
        body: { providers: [{ kind, name: def.label, ...(def.needsUrl ? { baseUrl: baseUrl.trim() } : {}), ...(def.needsKey ? { apiKey: apiKey.trim() } : {}) }], acknowledgedDisclosure: true },
      });
      onDone();
    } catch (err) {
      setErrs(fieldErrors(err));
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <StepCard headingRef={headingRef} title="Online search (optional)" description="NoConBrain searches your saved pages without the internet. You can also let it search the web through a provider.">
      <CardContent className="space-y-4">
        <div role="note" className="rounded-md border border-warning/60 p-3 text-sm" data-testid="provider-disclosure">
          <p className="font-medium">What leaves this device</p>
          <p className="mt-1">
            If you add a provider, the words you search for are sent to that provider's servers, along with the IP address of this device or its network. The provider can see and may keep them. Nothing is sent unless you add a provider and turn online search on. Saved pages and local search never leave this device.
          </p>
        </div>
        {adding ? (
          <form onSubmit={submit} noValidate className="space-y-4" aria-label="Add a search provider">
            <FormError message={error} />
            <Field id="prov-kind" label="Provider">
              {(p) => (
                <Select {...p} value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
                  {PROVIDER_KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
                </Select>
              )}
            </Field>
            {def.needsUrl ? (
              <Field id="prov-url" label="Server address" hint="For example http://searxng:8080" error={errs.baseUrl}>
                {(p) => <Input {...p} type="url" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} spellCheck={false} />}
              </Field>
            ) : null}
            {def.needsKey ? (
              <Field id="prov-key" label="API key" error={errs.apiKey}>
                {(p) => <Input {...p} type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />}
              </Field>
            ) : null}
            <div className="space-y-1">
              <div className="flex items-start gap-3">
                <Checkbox id="prov-ack" checked={ack} onCheckedChange={(v) => setAck(v === true)} aria-invalid={errs.ack ? true : undefined} aria-describedby={errs.ack ? "prov-ack-err" : undefined} />
                <Label htmlFor="prov-ack" className="font-normal">I understand that my search queries will be sent to this provider.</Label>
              </div>
              {errs.ack ? <p id="prov-ack-err" className="text-xs font-medium text-destructive">{errs.ack}</p> : null}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={busy}>{busy ? "Adding…" : "Add provider and continue"}</Button>
              <Button variant="ghost" onClick={() => setAdding(false)} disabled={busy}>Cancel</Button>
            </div>
          </form>
        ) : null}
      </CardContent>
      {!adding ? (
        <CardFooter className="flex-wrap">
          <Button onClick={() => void skip()}>Skip for now</Button>
          <Button variant="outline" onClick={() => setAdding(true)}>Add a provider</Button>
        </CardFooter>
      ) : null}
    </StepCard>
  );
}

function SourceStep({ headingRef, onDone, created }: StepProps & { created: boolean }) {
  const [url, setUrl] = React.useState("");
  const [kind, setKind] = React.useState<"page" | "website">("page");
  const [run, setRun] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [errs, setErrs] = React.useState<Record<string, string>>({});
  const [done, setDone] = React.useState<{ name: string; started: boolean } | null>(created ? { name: "", started: false } : null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const fe: Record<string, string> = {};
    if (!url.trim()) fe.url = "Enter the address of a page or site.";
    else if (!/^https?:\/\/[^\s/]+/i.test(url.trim())) fe.url = "Start the address with https:// or http://.";
    setErrs(fe);
    setError(null);
    if (Object.keys(fe).length) return;
    setBusy(true);
    try {
      const r = await post<{ source: { name: string }; downloadIds?: string[] }>("/api/setup/first-source", { url: url.trim(), kind, run });
      setDone({ name: r.source.name, started: !!r.downloadIds?.length });
    } catch (err) {
      const f = fieldErrors(err);
      setErrs(f);
      setError(Object.keys(f).length ? null : errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <StepCard headingRef={headingRef} title="Your first source is ready" description="You can see it, and add more, in the Library.">
        <CardContent>
          <p className="text-sm" role="status" data-testid="first-source-done">
            {done.name ? `“${done.name}” was added${done.started ? " and is being saved now" : ""}.` : "A first source was already added."}
            {done.started ? " Follow it on the Downloads screen once setup is finished." : ""}
          </p>
        </CardContent>
        <CardFooter>
          <Button onClick={onDone} data-testid="first-source-continue">Continue</Button>
        </CardFooter>
      </StepCard>
    );
  }

  return (
    <StepCard headingRef={headingRef} title="Add your first source" description="A source is a page or site that NoConBrain saves for offline use. This step is optional.">
      <form onSubmit={submit} noValidate>
        <CardContent className="space-y-4">
          <FormError message={error} />
          <fieldset className="space-y-2">
            <legend className="mb-1 text-sm font-medium">What do you want to save?</legend>
            {([["page", "A single page", "Just this page, with its images and styles."], ["website", "A whole website", "Follow links on the same site, within sensible limits."]] as const).map(([v, label, text]) => (
              <label key={v} className="flex cursor-pointer items-start gap-3 rounded-lg border p-3 has-[:checked]:border-primary">
                <input type="radio" name="first-kind" value={v} checked={kind === v} onChange={() => setKind(v)} className="mt-1 size-4 accent-[var(--primary)]" data-testid={`first-kind-${v}`} />
                <span className="text-sm"><span className="font-medium">{label}</span><span className="block text-xs text-muted-foreground">{text}</span></span>
              </label>
            ))}
          </fieldset>
          <Field id="first-url" label="Web address" hint="For example https://example.org/guide." error={errs.url}>
            {(p) => <Input {...p} type="url" inputMode="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.org/" autoComplete="off" spellCheck={false} />}
          </Field>
          <div className="flex items-start gap-3">
            <Checkbox id="first-run" checked={run} onCheckedChange={(v) => setRun(v === true)} />
            <Label htmlFor="first-run" className="font-normal">Start saving it now</Label>
          </div>
        </CardContent>
        <CardFooter className="flex-wrap gap-2">
          <Button type="submit" disabled={busy} data-testid="first-source-add">{busy ? "Adding…" : "Add source and continue"}</Button>
          <Button type="button" variant="outline" onClick={onDone} disabled={busy}>Skip for now</Button>
        </CardFooter>
      </form>
    </StepCard>
  );
}

function FinishStep({ headingRef }: { headingRef: React.RefObject<HTMLHeadingElement | null> }) {
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function finish() {
    setBusy(true);
    setError(null);
    try {
      await post("/api/setup/complete");
      window.location.assign("/");
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <StepCard headingRef={headingRef} title="Ready to go" description="NoConBrain is set up. Nothing has been archived yet.">
      <CardContent className="space-y-3">
        <FormError message={error} />
        <p className="text-sm">Finishing opens the browser. You can change storage, resources and providers later from Storage and settings.</p>
      </CardContent>
      <CardFooter>
        <Button onClick={() => void finish()} disabled={busy}>{busy ? "Finishing…" : "Finish setup"}</Button>
      </CardFooter>
    </StepCard>
  );
}
