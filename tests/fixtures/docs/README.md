# Document import fixtures

Samples for the imported-documents source (C-14) and the PDF extraction spike. Nothing here is copied from a third party.

| File | What it is | Licence |
|---|---|---|
| `sample.html` | A short page with a script, an `onerror` handler, a relative image and an external link | CC0 (written for this repository) |
| `sample.md` | Markdown with front matter, a table, a code block, raw `<script>` and a `javascript:` link | CC0 |
| `sample.txt` | Plain text with blank-line paragraphs | CC0 |
| `small.pdf`, `medium.pdf`, `large.pdf` | 1, 24 and 240 pages of fixture article sentences, made by `scripts/gen-doc-fixtures.mjs` with Playwright's Chromium (`page.pdf()`), author "Ada Marlowe" | CC0 (the text is the fixture data, the files are generated) |
| `malformed.pdf` | Starts with `%PDF-1.4` and then stops making sense | CC0 |
| `truncated.pdf` | The first 700 bytes of `small.pdf` | CC0 |

Regenerate the PDFs with `node scripts/gen-doc-fixtures.mjs`. The output is not byte-identical between Chromium versions, so tests assert on text and page counts, never on hashes.
