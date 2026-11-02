import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startBrowserServer, until, type BrowserTest } from "../browser/helpers.js";
import { APP_URL } from "../server/helpers.js";

export const DOCS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../fixtures/docs");
export const doc = (name: string): Buffer => fs.readFileSync(path.join(DOCS, name));

export function multipart(files: { name?: string; filename?: string; mime?: string; data: Buffer }[], fields: Record<string, string> = {}): { body: Buffer; type: string } {
  const b = "----ncbtest" + Math.random().toString(16).slice(2);
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  for (const f of files) {
    parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${f.name ?? "file"}"; filename="${f.filename ?? "x.bin"}"\r\nContent-Type: ${f.mime ?? "application/octet-stream"}\r\n\r\n`));
    parts.push(f.data, Buffer.from("\r\n"));
  }
  parts.push(Buffer.from(`--${b}--\r\n`));
  return { body: Buffer.concat(parts), type: `multipart/form-data; boundary=${b}` };
}

export interface Upload {
  status: number;
  body: any;
}

/** POST /api/archive/import as the signed-in administrator. */
export async function upload(t: BrowserTest, filename: string, data: Buffer, mime?: string, query = ""): Promise<Upload> {
  const m = multipart([{ filename, mime, data }]);
  const res = await t.server.app.inject({
    method: "POST", url: `/api/archive/import${query}`, payload: m.body,
    headers: { "content-type": m.type, "x-nocon-csrf": "1", origin: APP_URL, cookie: t.cookie },
  });
  let body: unknown;
  try { body = res.json(); } catch { body = res.body; }
  return { status: res.statusCode, body };
}

export async function importAndWait(t: BrowserTest, filename: string, data: Buffer, mime?: string) {
  const up = await upload(t, filename, data, mime);
  if (up.status !== 202 && up.status !== 200) throw new Error(`import failed: ${up.status} ${JSON.stringify(up.body)}`);
  const done = await until(() => {
    const r = t.pipeline.getCapture(up.body.downloadId);
    return r && (r.state === "completed" || r.state === "failed") ? r : undefined;
  }, 60_000);
  return { up, done };
}

export { startBrowserServer, until };
export type { BrowserTest };

/** A small valid PDF made by hand, with an Info dictionary. An empty array for a page gives a page with no text (like a scan). */
export function minimalPdf(o: { title?: string; author?: string; created?: string; pages: string[][] }): Buffer {
  const objs: string[] = [];
  const pageIds = o.pages.map((_, i) => 5 + i * 2);
  objs[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objs[2] = `<< /Type /Pages /Kids [${pageIds.map((n) => `${n} 0 R`).join(" ")}] /Count ${o.pages.length} >>`;
  objs[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  const info = [o.title ? `/Title (${o.title})` : "", o.author ? `/Author (${o.author})` : "", o.created ? `/CreationDate (${o.created})` : ""].join(" ");
  objs[4] = `<< ${info} >>`;
  o.pages.forEach((lines, i) => {
    const content = lines.length ? `BT /F1 12 Tf 72 720 Td 16 TL ${lines.map((l) => `(${l}) Tj T*`).join(" ")} ET` : "";
    const pid = 5 + i * 2;
    objs[pid] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pid + 1} 0 R >>`;
    objs[pid + 1] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
  });
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let n = 1; n < objs.length; n++) {
    offsets[n] = Buffer.byteLength(out, "latin1");
    out += `${n} 0 obj\n${objs[n]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n` + offsets.slice(1).map((off) => `${String(off).padStart(10, "0")} 00000 n \n`).join("");
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R /Info 4 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}
