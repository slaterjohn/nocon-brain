# @ncb/content

Pure content functions for the pipeline (tasks A-07 to A-09, A-12 shares the allowlist idea). No database, no network, no logging. They run in the extract worker thread.

- `decodeHtml(bytes, contentType)`: BOM, header charset, `<meta charset>`, UTF-8.
- `guardHtml(html, limits)`: rejects pathological pages before any DOM parser sees them (default 5 MiB, 400,000 elements, nesting 512).
- `extractMetadata(html, { url, headers })`: title, description, author, site name, language (`<html lang>`, `Content-Language`, `og:locale`, then franc-min), dates with source and confidence, JSON-LD (invalid JSON tolerated, `@graph` flattened, size capped). Never uses the fetch date.
- `extractReadable(html, { url })`: linkedom plus Readability, defuddle as a second opinion when Readability is short, body text last.
- `sanitiseReaderHtml(html, baseUrl)`: the reader allowlist below; returns `{ html, text, headings }`.
- `buildOutline(articleHtml, baseUrl)`: sections with anchors that equal the ids in the reader HTML.
- `extractLinks(html, { url })`: links with region, density, anchor, position and URL-shape features and a deterministic 0 to 1 score.
- `discoverHtmlAssets`, `discoverCssRefs`: `img`, `source`, `video poster`, `link`, `srcset`, inline CSS, and CSS `url()`/`@import`.

## Reader HTML allowlist

This is the small, strict list for reader mode. The full sanitiser for original mode (stage 11) is separate and belongs to the rendering code.

- Elements kept: `p br hr h1-h6 ul ol li dl dt dd blockquote pre code em strong b i u s del ins sub sup small mark abbr cite q kbd samp var time a img figure figcaption table caption thead tbody tfoot tr th td div span section article address details summary wbr`.
- Attributes kept: `a[href]`, `img[src alt width height]`, `td/th[colspan rowspan]`, `ol[start]`, `time[datetime]`, `abbr[title]`, `lang` and `dir` anywhere, and the generated `id` on headings.
- URLs: only absolute `http(s)` after resolving against the page URL. `javascript:`, `data:` and everything else are dropped.
- Removed with their children: `script style iframe frame object embed applet noscript template svg math canvas audio video source form input button select textarea label nav head title link meta base ...`.
- Any other element is unwrapped (children kept). Output is written by this module from allowlisted nodes only, so no source markup passes through. Event handlers, `style`, `class`, `srcset`, `target` never survive.
- Consumers must still rewrite `href` and `src` (the archive listener maps them through the version's resource table and links).
