"use client";

import * as React from "react";
import { FileUp, RotateCcw, X } from "lucide-react";
import { ApiError, useApi } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { cn, formatBytes } from "@/lib/utils";

export interface ImportLimits {
  maxBytes: number;
  accepted: string[];
  extensions: string[];
  description: string;
}

export interface ImportResult {
  downloadId: string;
  pageId: string;
  versionId: string;
  duplicate: boolean;
  kind: string;
  filename: string;
  title: string;
  sourceId: string;
}

export type UploadStatus = "queued" | "uploading" | "done" | "duplicate" | "error";

export interface UploadItem {
  key: string;
  file: File;
  status: UploadStatus;
  /** 0 to 100. */
  progress: number;
  error?: string;
  /** False for a file refused before upload (wrong type, too large, empty): sending it again cannot help. */
  retryable?: boolean;
  result?: ImportResult;
}

/** The server's refusals (`details.kind` of docs/api.md section 4) in plain words, for when its own message is not enough. */
const REFUSAL_WORDS: Record<string, string> = {
  no_file: "No file was sent.",
  empty: "The file is empty.",
  unsupported_type: "This kind of file can't be imported. Use a PDF, Markdown, text or HTML file.",
  type_mismatch: "The file's name and its contents don't agree about what it is.",
  binary_content: "The file looks like a binary file, not text.",
  file_too_large: "The file is larger than the upload limit.",
  malformed_pdf: "This PDF is damaged and can't be read.",
  encrypted_pdf: "This PDF is password protected. Remove the password and try again.",
  pdf_too_complex: "This PDF took too long to read.",
  invalid_name: "The file name isn't allowed.",
  wrong_source_type: "That source doesn't take uploaded files.",
};

function refusalMessage(status: number, body: unknown): string {
  const b = (body ?? {}) as { message?: string; details?: { kind?: string } };
  const kind = b.details?.kind;
  if (kind && REFUSAL_WORDS[kind]) return b.message ?? REFUSAL_WORDS[kind]!;
  if (b.message) return b.message;
  if (status === 0) return "Can't reach the server. Check the connection, then try again.";
  if (status === 401) return "The session has ended. Sign in again.";
  if (status === 413) return "The file is larger than the upload limit.";
  return "The upload failed. Try again.";
}

/** One file to `POST /api/archive/import`, with upload progress (fetch cannot report it). */
export function uploadFile(file: File, sourceId: string, onProgress: (pct: number) => void): Promise<{ result: ImportResult }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/archive/import?sourceId=${encodeURIComponent(sourceId)}`);
    xhr.setRequestHeader("X-NoCon-CSRF", "1");
    xhr.setRequestHeader("Accept", "application/json");
    xhr.withCredentials = true;
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.min(99, Math.round((e.loaded / e.total) * 100)));
    };
    xhr.onerror = () => reject(new ApiError(0, "network", refusalMessage(0, null)));
    xhr.onload = () => {
      let body: unknown = null;
      try { body = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress(100);
        resolve({ result: body as ImportResult });
      } else {
        reject(new ApiError(xhr.status, (body as { error?: string } | null)?.error ?? "bad_request", refusalMessage(xhr.status, body)));
      }
    };
    const form = new FormData();
    form.append("file", file, file.name);
    xhr.send(form);
  });
}

let counter = 0;

/** The list of chosen files and the sequential upload. Files that failed can be retried; files that were uploaded are not sent twice. */
export function useImportQueue(limits: ImportLimits | undefined) {
  const [items, setItems] = React.useState<UploadItem[]>([]);
  const [running, setRunning] = React.useState(false);
  const itemsRef = React.useRef(items);
  itemsRef.current = items;

  const patch = React.useCallback((key: string, p: Partial<UploadItem>) => setItems((list) => list.map((i) => (i.key === key ? { ...i, ...p } : i))), []);

  const add = React.useCallback((files: File[]) => {
    const exts = limits?.extensions ?? [];
    setItems((list) => [
      ...list,
      ...files.map((file): UploadItem => {
        const ext = file.name.includes(".") ? `.${file.name.split(".").pop()!.toLowerCase()}` : "";
        let error: string | undefined;
        if (limits && file.size > limits.maxBytes) error = `The file is larger than the ${formatBytes(limits.maxBytes, 0)} limit.`;
        else if (file.size === 0) error = REFUSAL_WORDS.empty;
        else if (exts.length && !exts.includes(ext)) error = `${ext || "This kind of file"} can't be imported. ${limits?.description ?? ""}`.trim();
        return { key: `f${++counter}`, file, status: error ? "error" : "queued", progress: 0, error, retryable: !error };
      }),
    ]);
  }, [limits]);

  const remove = React.useCallback((key: string) => setItems((list) => list.filter((i) => i.key !== key)), []);

  const retry = React.useCallback((key: string) => patch(key, { status: "queued", progress: 0, error: undefined }), [patch]);

  /** Uploads every queued file, one after another. Resolves with how many were imported (or already were) and how many failed. */
  const start = React.useCallback(async (sourceId: string): Promise<{ uploaded: number; failed: number }> => {
    setRunning(true);
    // Files refused before upload, and earlier failures not yet retried, still count: the Human has to look at them.
    let failed = itemsRef.current.filter((i) => i.status === "error").length;
    let uploaded = 0;
    for (const item of itemsRef.current.filter((i) => i.status === "queued")) {
      patch(item.key, { status: "uploading", progress: 0 });
      try {
        const { result } = await uploadFile(item.file, sourceId, (pct) => patch(item.key, { progress: pct }));
        uploaded++;
        patch(item.key, { status: result.duplicate ? "duplicate" : "done", progress: 100, result });
      } catch (e) {
        failed++;
        patch(item.key, { status: "error", retryable: true, error: e instanceof Error ? e.message : "The upload failed. Try again." });
      }
    }
    setRunning(false);
    return { uploaded, failed };
  }, [patch]);

  const queued = items.filter((i) => i.status === "queued").length;
  return { items, add, remove, retry, start, running, queued, failed: items.filter((i) => i.status === "error").length };
}

const STATUS_WORDS: Record<UploadStatus, string> = {
  queued: "Waiting",
  uploading: "Uploading",
  done: "Imported",
  duplicate: "Already imported",
  error: "Failed",
};

/**
 * The upload area: drag and drop, or the file input (both add to the same list), then a list with a progress bar and the error
 * of each file. The upload itself starts from the parent through `queue.start(sourceId)`.
 */
export function ImportDropzone({ queue, limits, disabled }: { queue: ReturnType<typeof useImportQueue>; limits?: ImportLimits; disabled?: boolean }) {
  const [over, setOver] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const hintId = React.useId();
  const accept = limits?.extensions.join(",");

  return (
    <div className="space-y-3" data-testid="import-upload">
      <div
        role="group"
        aria-labelledby={`${hintId}-label`}
        data-testid="import-dropzone"
        onDragOver={(e) => { e.preventDefault(); if (!disabled) setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          if (!disabled) queue.add(Array.from(e.dataTransfer.files));
        }}
        className={cn("flex flex-col items-center gap-2 rounded-lg border-2 border-dashed p-6 text-center", over && "border-primary bg-accent/40")}
      >
        <FileUp className="size-6 text-muted-foreground" aria-hidden="true" />
        <p id={`${hintId}-label`} className="text-sm font-medium">Drop files here, or choose them</p>
        <p id={hintId} className="text-xs text-muted-foreground">
          {limits ? `${limits.description} Up to ${formatBytes(limits.maxBytes, 0)} each.` : "PDF, Markdown, text or HTML files."}
        </p>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={accept}
          disabled={disabled}
          aria-label="Choose files to import"
          aria-describedby={hintId}
          data-testid="import-file-input"
          className="max-w-full text-sm file:mr-3 file:rounded-md file:border file:bg-background file:px-3 file:py-1.5 file:text-sm"
          onChange={(e) => {
            queue.add(Array.from(e.target.files ?? []));
            e.target.value = "";
          }}
        />
      </div>

      <p role="status" aria-live="polite" className="sr-only" data-testid="import-status">
        {queue.items.length === 0 ? "No files chosen." : `${queue.items.filter((i) => i.status === "done" || i.status === "duplicate").length} of ${queue.items.length} files imported${queue.failed ? `, ${queue.failed} failed` : ""}.`}
      </p>

      {queue.items.length > 0 ? (
        <ul className="divide-y rounded-lg border" aria-label="Files to import" data-testid="import-list">
          {queue.items.map((i) => (
            <li key={i.key} className="space-y-1 p-3 text-sm" data-testid="import-item" data-status={i.status} data-name={i.file.name}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="min-w-0 grow break-all font-medium">{i.file.name}</span>
                <span className="text-xs text-muted-foreground">{formatBytes(i.file.size, 0)}</span>
                <span className={cn("text-xs", i.status === "error" ? "font-medium text-destructive" : "text-muted-foreground")} data-testid="import-item-status">{STATUS_WORDS[i.status]}</span>
                {i.status === "error" && i.retryable && !queue.running ? (
                  <Button type="button" size="sm" variant="ghost" onClick={() => queue.retry(i.key)}>
                    <RotateCcw aria-hidden="true" /> Retry<span className="sr-only"> {i.file.name}</span>
                  </Button>
                ) : null}
                {i.status === "queued" || i.status === "error" ? (
                  <Button type="button" size="sm" variant="ghost" onClick={() => queue.remove(i.key)} disabled={queue.running && i.status === "queued"}>
                    <X aria-hidden="true" /> Remove<span className="sr-only"> {i.file.name}</span>
                  </Button>
                ) : null}
              </div>
              {i.status === "uploading" || i.status === "done" || i.status === "duplicate" ? <Progress value={i.progress} label={`Upload of ${i.file.name}`} /> : null}
              {i.status === "error" && i.error ? <p role="alert" className="text-xs text-destructive" data-testid="import-item-error">{i.error}</p> : null}
              {i.result ? <p className="text-xs text-muted-foreground">{i.result.duplicate ? "This file was already imported. Nothing new was saved." : `Saved as “${i.result.title}”.`}</p> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function useImportLimits() {
  return useApi<ImportLimits>("/api/archive/import/limits");
}
