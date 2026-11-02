/** The server's side of the renderer's API: `POST /render` and `GET /health`. The renderer never touches the database. */

export interface RenderRequest {
  url: string;
  /** Wall-clock budget for the whole page. */
  timeoutMs: number;
  /** Upper bound on the bytes the page may load, and on the DOM returned. */
  maxBytes: number;
  userAgent: string;
}

export interface RenderResponse {
  finalUrl: string;
  status: number;
  /** `document.documentElement` serialised after scripts ran, with the doctype. */
  html: string;
  title: string | null;
  /** Bytes the page loaded. */
  loadedBytes: number;
  durationMs: number;
  requests: number;
  blockedRequests: number;
  /** Container memory in MiB at the end of the render, when the renderer can read it. */
  memoryMb?: number;
}

/** The renderer is rendering something else. Try again later; this does not count against the job. */
export class RenderBusy extends Error {}
/** The renderer answered with a failure. `permanent` failures (the page timed out, was too big, or would not load) are not retried. */
export class RenderFailed extends Error {
  constructor(message: string, readonly code: string, readonly permanent: boolean) {
    super(message);
  }
}

export interface RendererClientOptions {
  baseUrl: string;
  secret?: string;
  fetch?: typeof fetch;
}

/** Failures that trying again will not fix: a page that is too slow or too big stays that way. */
const PERMANENT = new Set(["bad_request", "unauthorised", "timeout", "too_large", "navigation_failed"]);

export class RendererClient {
  private readonly f: typeof fetch;
  constructor(private readonly o: RendererClientOptions) {
    this.f = o.fetch ?? fetch;
  }

  private headers(): Record<string, string> {
    return { "content-type": "application/json", ...(this.o.secret ? { authorization: `Bearer ${this.o.secret}` } : {}) };
  }

  async health(signal?: AbortSignal): Promise<boolean> {
    try {
      const r = await this.f(new URL("/health", this.o.baseUrl), { signal: signal ?? AbortSignal.timeout(3000) });
      return r.ok;
    } catch {
      return false;
    }
  }

  async render(req: RenderRequest, signal?: AbortSignal): Promise<RenderResponse> {
    let res: Response;
    try {
      res = await this.f(new URL("/render", this.o.baseUrl), {
        method: "POST", headers: this.headers(), body: JSON.stringify(req),
        signal: AbortSignal.any([AbortSignal.timeout(req.timeoutMs + 15_000), ...(signal ? [signal] : [])]),
      });
    } catch (e) {
      throw new RenderFailed(`The renderer could not be reached (${(e as Error).message}).`, "unreachable", false);
    }
    if (res.status === 429 || res.status === 503) throw new RenderBusy("The renderer is busy.");
    const body = (await res.json().catch(() => null)) as (Partial<RenderResponse> & { error?: string; message?: string }) | null;
    if (!res.ok || !body || typeof body.html !== "string") {
      const code = body?.error ?? `http_${res.status}`;
      throw new RenderFailed(body?.message ?? `The renderer answered ${res.status}.`, code, PERMANENT.has(code));
    }
    return body as RenderResponse;
  }
}
