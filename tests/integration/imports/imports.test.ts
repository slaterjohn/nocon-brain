import { describe, expect, it } from "vitest";
import { doc, importAndWait, minimalPdf, multipart, startBrowserServer, upload, until } from "./helpers.js";
import { APP_URL } from "../server/helpers.js";

const readerText = async (t: Awaited<ReturnType<typeof startBrowserServer>>, versionPublicId: string): Promise<string> => {
  const v = t.pipeline.getVersion(versionPublicId)!;
  const { data } = await t.svc.blobs.read(v.content.textSha256!);
  return data.toString("utf8");
};
const readerHtml = async (t: Awaited<ReturnType<typeof startBrowserServer>>, versionPublicId: string): Promise<string> => {
  const v = t.pipeline.getVersion(versionPublicId)!;
  const { data } = await t.svc.blobs.read(v.content.readerSha256!);
  return data.toString("utf8");
};

describe("C-14 document import: one test per format", () => {
  it("HTML: stored as a capture under the Imports source, extracted, viewable, original downloadable", async () => {
    const t = await startBrowserServer({ env: { NCB_EXTRACT_WORKERS: "0" } });
    const { up, done } = await importAndWait(t, "lighthouse.html", doc("sample.html"), "text/html");
    expect(done.state).toBe("completed");
    expect(up.body).toMatchObject({ kind: "html", filename: "lighthouse.html", duplicate: false });
    const v = t.pipeline.getVersion(up.body.versionId)!;
    expect(v.status).toBe("ready");
    expect(v.title).toBe("Lighthouse keeper's log");
    expect(v.author).toBe("Ada Marlowe");
    expect(await readerText(t, v.publicId)).toContain("fog signal");
    expect(await readerHtml(t, v.publicId)).not.toMatch(/<script|onerror|stolen/);
    // The page belongs to the Imports system source (priority P3) and is marked as an import.
    const row = t.svc.db.get<{ origin: string; content_type: string; sname: string; prio: number }>(
      `SELECT p.origin, p.content_type, s.system_kind AS sname, s.priority AS prio FROM pages p JOIN page_sources ps ON ps.page_id = p.id JOIN sources s ON s.id = ps.source_id WHERE p.public_id = ?`, [up.body.pageId])!;
    expect(row).toMatchObject({ origin: "import", content_type: "html", sname: "imports", prio: 3 });
    // No network fetch was made for a relative image: assets are skipped for imports.
    expect(v.stages.find((s) => s.stage === "assets")?.state).toBe("done");
    // Viewable through the archive listener, sanitised at serve time.
    const g = await t.api("POST", "/api/archive/frame-grants", { versionId: up.body.versionId, mode: "original" });
    const page = await t.archiveFetch(g.body.url);
    expect(page.status).toBe(200);
    const served = await page.text();
    expect(served).toContain("fog signal");
    expect(served).not.toMatch(/window\.stolen|onerror/);
    // Original bytes come back as a download, never as HTML.
    const res = await t.server.app.inject({ method: "GET", url: `/api/archive/versions/${up.body.versionId}/original`, headers: { cookie: t.cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/octet-stream");
    expect(String(res.headers["content-disposition"])).toMatch(/^attachment; filename="lighthouse\.html"/);
    expect(res.rawPayload.equals(doc("sample.html"))).toBe(true);
  });

  it("Markdown: rendered to sanitised HTML through the reader allowlist", async () => {
    const t = await startBrowserServer();
    const { up, done } = await importAndWait(t, "turbines.md", doc("sample.md"), "text/markdown");
    expect(done.state).toBe("completed");
    expect(up.body.kind).toBe("markdown");
    const v = t.pipeline.getVersion(up.body.versionId)!;
    expect(v.title).toBe("Field notes on tidal turbines");
    const html = await readerHtml(t, v.publicId);
    expect(html).toMatch(/<table/);
    expect(html).toMatch(/<code/);
    expect(html).toContain("Pentland Firth");
    expect(html).not.toMatch(/<script|javascript:|alert\(/);
    expect(html).toContain('href="https://example.org/turbines"');
    expect(await readerText(t, v.publicId)).toContain("800 times denser");
    const dl = await t.server.app.inject({ method: "GET", url: up.body.links.original, headers: { cookie: t.cookie } });
    expect(dl.headers["content-type"]).toBe("text/plain; charset=utf-8");
    expect(dl.rawPayload.equals(doc("sample.md"))).toBe(true);
    const info = await t.api("GET", `/api/archive/versions/${up.body.versionId}/import`);
    expect(info.body).toMatchObject({ kind: "markdown", filename: "turbines.md" });
  });

  it("plain text: wrapped into paragraphs", async () => {
    const t = await startBrowserServer();
    const { up, done } = await importAndWait(t, "harbour.txt", doc("sample.txt"), "text/plain");
    expect(done.state).toBe("completed");
    const v = t.pipeline.getVersion(up.body.versionId)!;
    expect(v.title).toBe("harbour");
    const html = await readerHtml(t, v.publicId);
    expect(html).toContain("<p>");
    expect(html).toContain("The ferry leaves at eight.");
    expect(await readerText(t, v.publicId)).toContain("quokkaterm wind");
    expect(t.svc.db.get<{ content_type: string }>("SELECT content_type FROM pages WHERE public_id = ?", [up.body.pageId])!.content_type).toBe("text");
  });

  it("PDF: text for reader and search, page count, metadata, and the PDF itself as a download", async () => {
    const t = await startBrowserServer();
    const { up, done } = await importAndWait(t, "report.pdf", doc("medium.pdf"), "application/pdf");
    expect(done.state).toBe("completed");
    expect(up.body).toMatchObject({ kind: "pdf", pageCount: 24, mime: "application/pdf" });
    const v = t.pipeline.getVersion(up.body.versionId)!;
    expect(v.status).toBe("ready");
    expect(v.title).toBe("Fixture report");
    expect(v.wordCount).toBeGreaterThan(1000);
    expect(await readerText(t, v.publicId)).toContain("black hole");
    const info = (await t.api("GET", `/api/archive/versions/${up.body.versionId}/import`)).body;
    expect(info).toMatchObject({ kind: "pdf", pageCount: 24, detectedMime: "application/pdf" });
    expect(t.svc.db.get<{ content_type: string }>("SELECT content_type FROM pages WHERE public_id = ?", [up.body.pageId])!.content_type).toBe("pdf");
    const dl = await t.server.app.inject({ method: "GET", url: info.downloadUrl, headers: { cookie: t.cookie } });
    expect(dl.headers["content-type"]).toBe("application/pdf");
    expect(String(dl.headers["content-disposition"])).toMatch(/^attachment;/);
    expect(dl.headers["x-content-type-options"]).toBe("nosniff");
    expect(dl.rawPayload.equals(doc("medium.pdf"))).toBe(true);
    // The reader view is offered through the listener (Chromium's PDF viewer does not work in the sandbox, R-24).
    const g = await t.api("POST", "/api/archive/frame-grants", { versionId: up.body.versionId, mode: "reader" });
    expect((await t.archiveFetch(g.body.url)).status).toBe(200);
  });

  it("PDF metadata (title, author, dates) reaches the version, and a page without text does not fail the import", async () => {
    const t = await startBrowserServer();
    const pdf = minimalPdf({ title: "Tide tables", author: "Eleni Kostas", created: "D:20250106090000Z", pages: [["Low water at Falmouth is at 0412.", "High water follows at 1027."], []] });
    const { up, done } = await importAndWait(t, "tides.pdf", pdf, "application/pdf");
    expect(done.state).toBe("completed");
    expect(up.body.pageCount).toBe(2);
    const v = t.pipeline.getVersion(up.body.versionId)!;
    expect(v).toMatchObject({ title: "Tide tables", author: "Eleni Kostas", status: "ready" });
    expect(new Date(v.publishedAt!).toISOString()).toBe("2025-01-06T09:00:00.000Z");
    expect(await readerText(t, v.publicId)).toContain("Low water at Falmouth");
    const info = (await t.api("GET", `/api/archive/versions/${up.body.versionId}/import`)).body;
    expect(info.info).toMatchObject({ author: "Eleni Kostas", pageCount: 2, emptyPages: 1 });
  });

  it("a PDF with no extractable text at all is still stored, with a note that points to the download", async () => {
    const t = await startBrowserServer();
    const { up, done } = await importAndWait(t, "scan.pdf", minimalPdf({ pages: [[], []] }), "application/pdf");
    expect(done.state).toBe("completed");
    const html = await readerHtml(t, up.body.versionId);
    expect(html).toMatch(/no text to extract/i);
  });

  it("PDF extraction also works in a worker thread", async () => {
    const t = await startBrowserServer({ env: { NCB_EXTRACT_WORKERS: "1" } });
    const { up, done } = await importAndWait(t, "small.pdf", doc("small.pdf"), "application/pdf");
    expect(done.state).toBe("completed");
    expect(up.body.pageCount).toBe(1);
    expect(await readerText(t, up.body.versionId)).toContain("Fixture note");
  });
});

describe("C-14 checks and clean refusals", () => {
  it("re-importing the same file returns the existing version instead of making another", async () => {
    const t = await startBrowserServer();
    const first = await importAndWait(t, "a.txt", doc("sample.txt"), "text/plain");
    const again = await upload(t, "a.txt", doc("sample.txt"), "text/plain");
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ duplicate: true, versionId: first.up.body.versionId, pageId: first.up.body.pageId });
    expect(t.pipeline.listVersions(first.up.body.pageId)).toHaveLength(1);
  });

  it("a malformed or truncated PDF is rejected with a clear message and stores nothing", async () => {
    const t = await startBrowserServer();
    const before = t.svc.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM pages")!.n;
    for (const [name, data] of [["malformed.pdf", doc("malformed.pdf")], ["truncated.pdf", doc("truncated.pdf")], ["noheader.pdf", Buffer.from("just some text, not a pdf")]] as const) {
      const r = await upload(t, name, data, "application/pdf");
      expect(r.status, name).toBe(400);
      expect(r.body.error).toBe("bad_request");
      expect(r.body.details.kind, name).toBe("malformed_pdf");
      expect(r.body.message).toMatch(/PDF/);
    }
    expect(t.svc.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM pages")!.n).toBe(before);
    expect(t.svc.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM import_documents")!.n).toBe(0);
    expect(t.svc.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM download_jobs WHERE kind = 'import'")!.n).toBe(0);
  });

  it("an oversized file is refused by size, before anything is read", async () => {
    const t = await startBrowserServer({ env: { NCB_IMPORT_MAX_MB: "1" } });
    const big = Buffer.alloc(1.5 * 1024 * 1024, "a");
    const r = await upload(t, "big.txt", big, "text/plain");
    expect(r.status).toBe(400);
    expect(r.body.details.kind).toBe("file_too_large");
    expect(r.body.message).toMatch(/1 MB limit/);
    expect(t.svc.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM import_documents")!.n).toBe(0);
    // Without a Content-Length the stream limit still holds.
    const m = multipart([{ filename: "big2.txt", mime: "text/plain", data: big }]);
    const res = await t.server.app.inject({
      method: "POST", url: "/api/archive/import", payload: m.body, headers: { "content-type": m.type, "x-nocon-csrf": "1", origin: APP_URL, cookie: t.cookie },
    });
    expect(res.json().details.kind).toBe("file_too_large");
    // And just under the limit works.
    expect((await upload(t, "ok.txt", Buffer.alloc(900 * 1024, "word "), "text/plain")).status).toBe(202);
  });

  it("checks the MIME type, the extension and the magic bytes against each other", async () => {
    const t = await startBrowserServer();
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
    const cases: [string, Buffer, string | undefined, string][] = [
      ["pic.png", png, "image/png", "unsupported_type"],
      ["notes.txt", png, "text/plain", "binary_content"],
      ["page.html", Buffer.from("PK\x03\x04zipbytes"), "text/html", "binary_content"],
      ["data.bin", Buffer.from("hello"), "application/octet-stream", "unsupported_type"],
      ["doc.pdf", Buffer.from("<html><body>hi</body></html>"), "text/html", "type_mismatch"],
      ["empty.txt", Buffer.alloc(0), "text/plain", "empty"],
      ["nul.txt", Buffer.from("abc\0def\0ghi"), "text/plain", "binary_content"],
    ];
    for (const [name, data, mime, kind] of cases) {
      const r = await upload(t, name, data, mime);
      expect(r.status, name).toBe(400);
      expect(r.body.details.kind, name).toBe(kind);
    }
    // A PDF labelled as plain text is still read as a PDF: the bytes win.
    const sneaky = await upload(t, "notes.txt", doc("small.pdf"), "text/plain");
    expect(sneaky.status).toBe(202);
    expect(sneaky.body.kind).toBe("pdf");
    // An octet-stream upload falls back to the extension.
    expect((await upload(t, "readme.md", Buffer.from("# Hi\n\nthere"), "application/octet-stream")).body.kind).toBe("markdown");
  });

  it("needs a signed-in administrator, a file field, and the CSRF header", async () => {
    const t = await startBrowserServer();
    const m = multipart([{ filename: "a.txt", mime: "text/plain", data: Buffer.from("hello") }]);
    const noAuth = await t.server.app.inject({ method: "POST", url: "/api/archive/import", payload: m.body, headers: { "content-type": m.type, "x-nocon-csrf": "1", origin: APP_URL } });
    expect(noAuth.statusCode).toBe(401);
    const noCsrf = await t.server.app.inject({ method: "POST", url: "/api/archive/import", payload: m.body, headers: { "content-type": m.type, cookie: t.cookie } });
    expect(noCsrf.statusCode).toBe(403);
    const none = multipart([]);
    const noFile = await t.server.app.inject({ method: "POST", url: "/api/archive/import", payload: none.body, headers: { "content-type": none.type, "x-nocon-csrf": "1", origin: APP_URL, cookie: t.cookie } });
    expect(noFile.statusCode).toBe(400);
    expect(noFile.json().details.kind).toBe("no_file");
    const json = await t.server.app.inject({ method: "POST", url: "/api/archive/import", payload: { a: 1 }, headers: { "x-nocon-csrf": "1", origin: APP_URL, cookie: t.cookie } });
    expect(json.statusCode).toBe(400);
  });

  it("an import moves its source off 'never' at once, and to 'ok' when the import ends", async () => {
    const t = await startBrowserServer();
    const created = await t.api("POST", "/api/sources", { name: "Status papers", type: "imported_documents", priority: "P2" });
    expect(created.status).toBe(201);
    expect(created.body.lastStatus).toBe("never");
    const r = await upload(t, "status.txt", Buffer.from(`Status check ${Date.now()}\n\nA paragraph.`), "text/plain", `?sourceId=${created.body.id}`);
    expect(r.status).toBe(202);
    // The answer to the upload is already enough for the Library to see a run in progress (it polls only while "running").
    const during = await t.api("GET", `/api/sources/${created.body.id}`);
    expect(during.body.lastRunAt).not.toBeNull();
    expect(["running", "ok"]).toContain(during.body.lastStatus);
    expect(during.body.lastStatus).not.toBe("never");
    await until(() => t.pipeline.getCapture(r.body.downloadId)?.state === "completed");
    await until(async () => (await t.api("GET", `/api/sources/${created.body.id}`)).body.lastStatus === "ok");
  });

  it("imports into a chosen imported_documents source and refuses other source types", async () => {
    const t = await startBrowserServer();
    const created = await t.api("POST", "/api/sources", { name: "Papers", type: "imported_documents", priority: "P2" });
    expect(created.status).toBe(201);
    const bad = await t.api("POST", "/api/sources", { name: "Site", type: "website", startUrl: "http://127.0.0.1:1/" });
    const r = await upload(t, "a.txt", doc("sample.txt"), "text/plain", `?sourceId=${created.body.id}`);
    expect(r.status).toBe(202);
    expect(r.body.sourceId).toBe(created.body.id);
    expect(t.svc.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM page_sources ps JOIN sources s ON s.id = ps.source_id WHERE s.public_id = ?", [created.body.id])!.n).toBe(1);
    const wrong = await upload(t, "b.txt", Buffer.from("other text"), "text/plain", `?sourceId=${bad.body.id}`);
    expect(wrong.status).toBe(400);
    expect(wrong.body.details.kind).toBe("wrong_source_type");
    // Running such a source says what to do instead.
    const run = await t.api("POST", `/api/sources/${created.body.id}/run`);
    expect(run.status).toBe(409);
    await until(() => t.pipeline.getCapture(r.body.downloadId)?.state === "completed");
  });

  it("deleting an imported page releases the uploaded file", async () => {
    const t = await startBrowserServer();
    const { up } = await importAndWait(t, "gone.txt", Buffer.from("A short note about nothing in particular.\n\nSecond paragraph."), "text/plain");
    const orig = t.svc.db.get<{ id: number; refcount: number }>("SELECT b.id, b.refcount FROM import_documents i JOIN blobs b ON b.id = i.original_blob_id")!;
    expect(orig.refcount).toBeGreaterThan(0);
    const del = await t.api("DELETE", `/api/archive/pages/${up.body.pageId}?confirmProtected=true`);
    expect(del.status).toBe(200);
    expect(t.svc.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM import_documents")!.n).toBe(0);
    expect(t.svc.db.get<{ refcount: number }>("SELECT refcount FROM blobs WHERE id = ?", [orig.id])?.refcount ?? 0).toBe(0);
  });
});
