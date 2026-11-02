# Document import

Task C-14. Code: `apps/server/src/imports`. API: `docs/api.md` section 4 (`POST /api/archive/import`, `GET /api/archive/versions/{id}/import`, `GET /api/archive/versions/{id}/original`, `GET /api/archive/import/limits`). Table: `import_documents` (migration 0008, `docs/data-model.md` 3.4b).

## What happens to an upload

1. `routes.ts` reads one multipart file (field `file`) under the size limit `NCB_IMPORT_MAX_MB` (default 50 MiB). A `Content-Length` over the limit is refused before the body is read; without one the stream limit applies.
2. `detect.ts` decides the type from the bytes first, then the labels: `%PDF-` within the first 1 KiB, signatures of common binary formats (ZIP/Office, PNG, JPEG, GIF, gzip, ELF, PE, SQLite, 7-Zip), NUL bytes and control characters. The MIME type and the extension must not contradict each other (`text/plain` is refined by the extension, so `notes.md` sent as `text/plain` is Markdown). PDF bytes under a text label are read as a PDF; a `.pdf` without the header is a malformed PDF.
3. `service.ts` converts in the `extract` worker pool (a worker thread with a heap limit; in-thread with `NCB_EXTRACT_WORKERS=0`):
   - HTML is stored as uploaded. The ordinary pipeline sanitises at serve time; nothing in it is fetched (stage 3 is skipped for imports).
   - Markdown: `marked` (GitHub flavoured) then the reader allowlist (`@ncb/content` `sanitiseReaderHtml`), so raw HTML, scripts and `javascript:` links are gone before anything is stored.
   - Plain text: blank-line paragraphs, single line breaks kept, everything escaped.
   - PDF: `pdf.js` text extraction (below), one `<section id="page-N">` per page, title, author, subject and creation date as `<title>` and `<meta>` so the metadata stage picks them up.
4. The derived HTML is stored as the version's document, the upload's own bytes as the `original` (kept for download and for re-deriving later). A version, a `download_jobs` row (`kind = 'import'`) and a `process` job are created in one transaction, and the 15 stages run as for any capture. The page is linked to the Imports source (or the `imported_documents` source named by `sourceId`).
5. The same bytes import to the same address (`https://imports.noconbrain.invalid/<sha256 prefix>/<name>`), so a repeat upload returns the existing version (`duplicate: true`) and makes nothing new.

## PDF text extraction

`pdf.ts` uses `pdfjs-dist` (Apache-2.0), legacy build, inside the `extract` worker. The choice, the alternatives and the measurements are in the C-14 spike result in `docs/implementation-plan.md`. Limits: 3,000 pages and 8,000,000 characters of text (the rest is dropped and the reader view says so), 60 s per file (the request fails with `pdf_too_complex`; a worker that stops answering is replaced by the pool's heartbeat check), a heap limit of `NCB_WORKER_MEMORY_MB` in the worker. Encrypted PDFs are refused (`encrypted_pdf`). Scanned PDFs have no text layer: they are stored, the reader view says "no text to extract" and points to the download. There is no OCR. Known gaps: pdf.js is given no CMap or standard-font data in the bundle, so text in some CJK PDFs that rely on external CMaps can come out wrong; reading order follows the content stream, which is not always visual order for multi-column pages.

Chromium's PDF viewer does not work inside the sandboxed archive frame (risk R-24), so a PDF is offered as a download of the original plus the reader text, and the "original" view of an imported PDF is the derived text document.

## Tests

`tests/integration/imports` (one test per format, refusals, duplicates, source choice, deletion), `apps/server/test/imports.test.ts` (detection, conversion, PDF helpers). Fixtures: `tests/fixtures/docs` (README there).
