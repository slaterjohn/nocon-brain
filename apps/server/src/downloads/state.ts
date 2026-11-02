export type DownloadState = "queued" | "running" | "paused" | "completed" | "failed" | "cancelled";
export type DownloadAction = "pause" | "resume" | "cancel" | "retry" | "setPriority";

/**
 * The download state machine (docs/data-model.md section 3.5): queued -> running -> paused | completed | failed | cancelled,
 * paused -> queued (resume), failed -> queued (retry), queued | paused -> cancelled. completed and cancelled are terminal.
 */
export const ACTIONS: Record<DownloadState, readonly DownloadAction[]> = {
  queued: ["pause", "cancel", "setPriority"],
  running: ["pause", "cancel", "setPriority"],
  paused: ["resume", "cancel", "setPriority"],
  failed: ["retry"],
  completed: [],
  cancelled: [],
};

export const TARGET: Partial<Record<DownloadAction, Partial<Record<DownloadState, DownloadState>>>> = {
  pause: { queued: "paused", running: "paused" },
  resume: { paused: "queued" },
  cancel: { queued: "cancelled", running: "cancelled", paused: "cancelled" },
  retry: { failed: "queued" },
};

export function allowed(state: DownloadState, action: DownloadAction): boolean {
  return ACTIONS[state].includes(action);
}

/** The state an action leads to, or undefined when the action is not allowed. `setPriority` keeps the state. */
export function next(state: DownloadState, action: DownloadAction): DownloadState | undefined {
  if (!allowed(state, action)) return undefined;
  return action === "setPriority" ? state : TARGET[action]?.[state];
}

export const isFinal = (s: DownloadState): boolean => s === "completed" || s === "cancelled" || s === "failed";

/** Kinds whose failed work can be started again. A crawl is restarted from its source instead. */
export const RETRYABLE_KINDS = new Set(["capture", "refresh"]);
