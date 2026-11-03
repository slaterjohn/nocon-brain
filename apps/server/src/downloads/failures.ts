import type { FailureCode } from "@ncb/shared";

export interface FailureInfo {
  message: string;
  hint: string;
  retryable: boolean;
}

/** Plain-English text for every failure code (docs/api.md section 8). The page-specific detail stays in the activity log. */
export const FAILURE_INFO: Record<FailureCode, FailureInfo> = {
  network: {
    message: "The site could not be reached.",
    hint: "Check the connection and that the address is right, then retry. The log shows the exact error.",
    retryable: true,
  },
  robots_blocked: {
    message: "The site's robots.txt asks crawlers not to save this page.",
    hint: "NoConBrain respects robots.txt for background downloads. Saving the page yourself from the browser is allowed.",
    retryable: false,
  },
  ssrf_blocked: {
    message: "That address points inside a private network, so it was not fetched.",
    hint: "Only public web addresses can be saved. Use a public address instead.",
    retryable: false,
  },
  size_cap: {
    message: "The page is larger than the size limit.",
    hint: "Raise the size limit in the source settings if you want pages this large, or skip this one.",
    retryable: false,
  },
  disk_full: {
    message: "There is not enough free space to save this.",
    hint: "Free some space or add a storage volume, then retry.",
    retryable: true,
  },
  timeout: {
    message: "The site took too long to answer.",
    hint: "Try again later; the site may be slow or busy.",
    retryable: true,
  },
  http_4xx: {
    message: "The site refused the request or the page does not exist.",
    hint: "Check the address. Pages that need a sign-in cannot be saved.",
    retryable: false,
  },
  http_5xx: {
    message: "The site reported an error of its own.",
    hint: "This is usually temporary. Try again later.",
    retryable: true,
  },
  parse_error: {
    message: "The page was fetched but could not be read.",
    hint: "The page may not be a normal web page. The log shows which step failed.",
    retryable: true,
  },
  limit_reached: {
    message: "A limit stopped this download.",
    hint: "Raise the page, size or time limit in the source settings if you want more.",
    retryable: false,
  },
  cancelled_by_user: {
    message: "You stopped this download.",
    hint: "Start it again from the source or the browser if you still want it.",
    retryable: false,
  },
  internal: {
    message: "Something went wrong inside NoConBrain.",
    hint: "Retry once. If it keeps failing, the log has the details to report.",
    retryable: true,
  },
};

export function failureFor(code: string | null | undefined, rawMessage?: string | null): { code: FailureCode; message: string; retryable: boolean; hint: string } {
  const c = (code && code in FAILURE_INFO ? code : "internal") as FailureCode;
  const info = FAILURE_INFO[c];
  // The stored message is the specific reason (for example "The server answered 503."); the fixed text follows it.
  const detail = rawMessage && rawMessage.trim() ? rawMessage.trim() : undefined;
  // The detail is often a raw reason ("other side closed", "timed out waiting for response headers"): present it as a sentence.
  const sentence = detail ? `${detail[0]!.toUpperCase()}${detail.slice(1)}${/[.!?]$/.test(detail) ? "" : "."}` : undefined;
  return { code: c, message: sentence && detail !== info.message ? `${info.message} ${sentence}` : info.message, retryable: info.retryable, hint: info.hint };
}

/** Why a crawl ended, in words. */
export const STOP_MESSAGES: Record<string, string> = {
  completed: "Finished: every page in scope was saved.",
  max_pages: "Stopped at the page limit.",
  max_bytes: "Stopped at the size limit.",
  max_depth: "Finished: it followed links as far as the depth limit allows.",
  deadline: "Stopped at the time limit.",
  source_budget: "Stopped because the source reached its storage budget.",
  volume_full: "Stopped because the storage volume is full.",
  cancelled: "Stopped by you.",
};

export const PAUSE_MESSAGES = {
  user: "You paused this download.",
  window_closed: "Paused because the download window is closed. It resumes when the window opens.",
  volume_full: "Paused because free space is below the reserve. It resumes by itself when space is available.",
  offline: "Waiting for the connection to return.",
} as const;
export type PauseReason = keyof typeof PAUSE_MESSAGES;

export const WAIT_MESSAGES = {
  throttled: "Waiting: Opportunistic (P4) downloads are paused while storage is above its soft threshold. This one continues when space is freed or the threshold is raised.",
} as const;
