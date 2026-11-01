"use client";

import * as React from "react";
import { useSearchParams } from "next/navigation";
import { Save } from "lucide-react";
import { api, errorMessage } from "@/lib/api";
import type { SaveResponse } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { EmptyState, PageHeader } from "@/components/layout/states";
import { CaptureStatus } from "@/components/browser/capture-status";
import { useEvents } from "@/components/layout/events";

/**
 * Where "Save for offline" and "Queue" in a saved page's interstitial lead. The archive listener has no session, so it opens
 * this page in a new tab and the Human's own session does the saving.
 */
export function SaveView() {
  const params = useSearchParams();
  const url = params.get("url") ?? "";
  const queue = params.get("queue") === "1";
  const { connectivity, trackCapture } = useEvents();
  const [id, setId] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  async function start() {
    setError(null);
    try {
      const r = await api<SaveResponse>("/api/browser/save", { method: "POST", body: { url, queue: queue || connectivity === "offline" } });
      trackCapture({ downloadId: r.downloadId, url: r.url, state: "queued", held: r.held, outcome: "pending", label: r.held ? "Waiting for the connection to return" : "Waiting to start", percent: 0 });
      setId(r.downloadId);
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  if (!/^https?:\/\//i.test(url)) {
    return (
      <div className="mx-auto w-full max-w-2xl p-4 sm:p-6">
        <PageHeader title="Save a page" />
        <EmptyState icon={Save} title="No address to save" description="Open a page in the Browser and choose Save for offline." />
      </div>
    );
  }
  return (
    <div className="mx-auto w-full max-w-2xl p-4 sm:p-6">
      <PageHeader title={queue ? "Queue a page" : "Save a page for offline"} description="The page and its images and styles are saved on this server." />
      <p className="mb-4 break-all rounded-md border p-3 text-sm" data-testid="save-url">{url}</p>
      {id ? (
        <CaptureStatus downloadId={id} compact />
      ) : (
        <Button onClick={() => void start()} data-testid="save-start">
          <Save aria-hidden="true" /> {queue || connectivity === "offline" ? "Queue to save when online" : "Save for offline"}
        </Button>
      )}
      {error ? <p role="alert" className="mt-3 text-sm text-destructive">{error}</p> : null}
    </div>
  );
}
