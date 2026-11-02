import { startBrowserServer, until, type BrowserTest } from "../browser/helpers.js";
import { importAndWait } from "../imports/helpers.js";
import type { StartOptions } from "../server/helpers.js";

export { until, startBrowserServer };
export type { BrowserTest };

export const htmlDoc = (title: string, body: string, extra = ""): Buffer =>
  Buffer.from(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>${extra}</head><body><article><h1>${title}</h1><p>${body}</p><p>${body} A second paragraph so the article extractor sees enough text to keep this page as an article rather than falling back to the body text.</p></article></body></html>`);

/** Imports an HTML document and waits for it to be searchable. */
export async function addDoc(t: BrowserTest, name: string, title: string, body: string, extra = "") {
  const { up, done } = await importAndWait(t, name, htmlDoc(title, body, extra), "text/html");
  if (done.state !== "completed") throw new Error(`import failed: ${JSON.stringify(done)}`);
  return up.body as { pageId: string; versionId: string };
}

export async function searchApi(t: BrowserTest, body: Record<string, unknown>) {
  return t.api("POST", "/api/search", body);
}

/** Waits until the index worker has applied everything queued. */
export async function drained(t: BrowserTest): Promise<void> {
  await t.svc.search.drain();
}

export async function startSearchServer(opts: StartOptions & { signIn?: boolean } = {}): Promise<BrowserTest> {
  return startBrowserServer({ ...opts, env: { NCB_EXTRACT_WORKERS: "0", ...(opts.env ?? {}) } });
}
