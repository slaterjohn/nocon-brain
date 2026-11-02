// Generates the sample PDFs in tests/fixtures/docs with the Chromium that Playwright already downloads.
// The text comes from the fixture article data (original, deterministic sentences), so there is nothing to attribute.
// Usage: node scripts/gen-doc-fixtures.mjs   (needs `npx playwright install chromium` once)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { SENTENCES } from "../tests/fixtures/sites/articles-data.mjs";

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), "../tests/fixtures/docs");
const all = Object.values(SENTENCES).flat();
const para = (i, n = 6) => Array.from({ length: n }, (_, k) => all[(i * 7 + k * 3) % all.length]).join(" ");

function html(title, pages, author) {
  const body = Array.from({ length: pages }, (_, p) => `<section style="page-break-after:always"><h2>${title}: section ${p + 1}</h2>${Array.from({ length: 5 }, (_, k) => `<p>${para(p * 5 + k)}</p>`).join("")}</section>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title><meta name="author" content="${author}"></head><body style="font:12pt Georgia,serif"><h1>${title}</h1>${body}</body></html>`;
}

const browser = await chromium.launch();
for (const [name, title, pages] of [["small", "Fixture note", 1], ["medium", "Fixture report", 24], ["large", "Fixture handbook", 240]]) {
  const page = await browser.newPage();
  await page.setContent(html(title, pages, "Ada Marlowe"));
  await page.pdf({ path: path.join(out, `${name}.pdf`), format: "A4", margin: { top: "20mm", bottom: "20mm", left: "20mm", right: "20mm" } });
  await page.close();
}
await browser.close();
for (const f of fs.readdirSync(out)) console.log(f, fs.statSync(path.join(out, f)).size);
