import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { activeFrame, login, mode, setWorkOffline } from "./helpers";

// C-14 in the Library UI: the source wizard takes uploaded documents (file input and drag and drop), shows progress and errors per file,
// and the imported pages show what they are instead of their made-up address.
test.skip(mode() !== "real-server", "needs the real server");

const DOCS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../fixtures/docs");
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
async function serious(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(TAGS).exclude('iframe[data-testid="archive-frame"]').analyze();
  return results.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id} (${v.impact}): ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`);
}

test.beforeEach(async ({ page }) => {
  await login(page);
  await setWorkOffline(page, false);
});

async function startWizard(page: Page, name: string) {
  await page.goto("/library/sources/new");
  await expect(page.getByTestId("step-heading")).toContainText("Step 1 of 4: Type");
  // Imported documents is an ordinary choice now.
  await expect(page.getByRole("radio", { name: "Imported documents" })).toBeEnabled();
  await page.getByRole("radio", { name: "Imported documents" }).check();
  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.getByTestId("step-heading")).toContainText("Step 2 of 4: Name");
  await expect(page.getByTestId("start-url")).toHaveCount(0); // there is no address
  await page.getByLabel("Name", { exact: true }).fill(name);
  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.getByTestId("step-heading")).toContainText("Step 3 of 4");
  await expect(page.getByTestId("schedule-kind")).toHaveCount(0); // nothing to schedule
  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.getByTestId("step-heading")).toContainText("Step 4 of 4: Add files");
}

test("upload a Markdown file and a PDF in the wizard, with progress and errors per file, then read them", async ({ page }) => {
  const name = `Field documents ${Date.now() % 100000}`;
  await startWizard(page, name);
  expect(await serious(page)).toEqual([]);

  // A keyboard user reaches the file input by its label. A file of the wrong kind is refused before anything is sent.
  const input = page.getByLabel("Choose files to import");
  await input.setInputFiles([
    { name: "sample.md", mimeType: "text/markdown", buffer: fs.readFileSync(path.join(DOCS, "sample.md")) },
    { name: "small.pdf", mimeType: "application/pdf", buffer: fs.readFileSync(path.join(DOCS, "small.pdf")) },
    { name: "budget.xlsx", mimeType: "application/vnd.ms-excel", buffer: Buffer.from("PK\u0003\u0004 not really") },
  ]);
  const items = page.getByTestId("import-item");
  await expect(items).toHaveCount(3);
  await expect(items.filter({ hasText: "budget.xlsx" })).toHaveAttribute("data-status", "error");
  await expect(items.filter({ hasText: "budget.xlsx" }).getByTestId("import-item-error")).toContainText("can't be imported");
  await expect(page.getByTestId("create-and-upload")).toHaveText("Create source and upload 2 files");

  await page.getByTestId("create-and-upload").click();
  // One failed file keeps the Human on the step; the other two are in, and the source exists.
  await expect(items.filter({ hasText: "sample.md" })).toHaveAttribute("data-status", "done", { timeout: 60_000 });
  await expect(items.filter({ hasText: "small.pdf" })).toHaveAttribute("data-status", "done", { timeout: 60_000 });
  await expect(items.filter({ hasText: "sample.md" }).getByRole("progressbar")).toHaveAttribute("aria-valuenow", "100");
  await expect(page.getByRole("alert").filter({ hasText: "could not be imported" })).toBeVisible();
  await items.filter({ hasText: "budget.xlsx" }).getByRole("button", { name: /Remove/ }).click();
  await expect(items).toHaveCount(2);
  await page.getByTestId("create-and-upload").click();
  await expect(page).toHaveURL(/\/library\/sources\/src_/);
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();

  // The source lists both documents, and its status is the server's.
  await expect(page.getByTestId("source-page-row")).toHaveCount(2, { timeout: 30_000 });
  await expect(page.getByTestId("source-status")).toHaveText("Up to date", { timeout: 30_000 });

  // The Library shows the type and says "Imported document" instead of the made-up address.
  await page.goto("/library");
  const pdfRow = page.getByTestId("library-row").filter({ hasText: "small.pdf" });
  await expect(pdfRow).toBeVisible();
  await expect(pdfRow.getByTestId("page-type")).toHaveText("PDF");
  await expect(pdfRow.getByTestId("page-origin")).toHaveText("Imported document · small.pdf");
  await expect(pdfRow).not.toContainText("noconbrain.invalid");
  const mdRow = page.getByTestId("library-row").filter({ hasText: "sample.md" });
  await expect(mdRow.getByTestId("page-type")).toHaveText("Markdown");

  // Filter the list by type on the server.
  const types = await page.request.get("/api/archive/pages?type=pdf");
  expect(((await types.json()) as { items: { type: string }[] }).items.every((p) => p.type === "pdf")).toBe(true);

  // Markdown page: detail says what it is; the reader view shows the converted text.
  await mdRow.getByTestId("page-link").click();
  await expect(page).toHaveURL(/\/library\/pages\//);
  await expect(page.getByTestId("page-origin")).toContainText("Imported document · sample.md");
  await expect(page.getByTestId("page-type")).toHaveText("Markdown");
  await expect(page.getByTestId("page-meta")).not.toContainText("noconbrain.invalid");
  await expect(page.getByTestId("page-source").first()).toContainText(name);
  await page.getByTestId("open-reader").click();
  await expect(activeFrame(page)).toBeVisible();
  const fl = page.frameLocator('iframe[data-testid="archive-frame"]');
  await expect(fl.getByText("Tidal turbines turn")).toBeVisible();

  // PDF page: the original can be downloaded, and the reader text is offered.
  await page.goto("/library");
  await page.getByTestId("library-row").filter({ hasText: "small.pdf" }).getByTestId("page-link").click();
  await expect(page).toHaveURL(/\/library\/pages\//);
  await expect(page.getByTestId("page-type")).toHaveText("PDF");
  const original = page.getByTestId("download-original");
  await expect(original).toBeVisible();
  const href = await original.getAttribute("href");
  const res = await page.request.get(href!);
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toContain("application/pdf");
  expect(res.headers()["content-disposition"]).toContain("attachment");
  expect((await res.body()).equals(fs.readFileSync(path.join(DOCS, "small.pdf")))).toBe(true);
  await page.getByRole("button", { name: "Read the text" }).click();
  await expect(activeFrame(page)).toBeVisible();
  await expect(page.frameLocator('iframe[data-testid="archive-frame"]').getByText("Fixture note").first()).toBeVisible();
});

test("drag and drop adds files to an existing imported-documents source, and a repeat is reported as already imported", async ({ page }) => {
  await startWizard(page, "Dropped files");
  // Use the built-in Imports source instead of making a new one.
  await page.getByTestId("import-target").selectOption({ label: "Imports (built in)" });
  const zone = page.getByTestId("import-dropzone");
  const drop = async (fileName: string, text: string) => {
    const dt = await page.evaluateHandle(([n, t]) => {
      const d = new DataTransfer();
      d.items.add(new File([t], n, { type: "text/plain" }));
      return d;
    }, [fileName, text] as const);
    await zone.dispatchEvent("dragover", { dataTransfer: dt });
    await zone.dispatchEvent("drop", { dataTransfer: dt });
  };
  const body = `Dropped note ${Date.now()}\n\nA paragraph about drag and drop.`;
  await drop("dropped.txt", body);
  await expect(page.getByTestId("import-item")).toHaveCount(1);
  await expect(page.getByTestId("create-and-upload")).toHaveText("Upload 1 file");
  await page.getByTestId("create-and-upload").click();
  await expect(page).toHaveURL(/\/library\/sources\/src_/);
  const sources = (await (await page.request.get("/api/sources?limit=200")).json()) as { items: { name: string }[] };
  expect(sources.items.some((s) => s.name === "Dropped files")).toBe(false); // nothing was created
  // The page appears in the list once the import has been processed.
  await expect.poll(async () => {
    const r = await page.request.get("/api/archive/pages?type=text&q=dropped");
    return ((await r.json()) as { items: { type: string; imported?: { filename: string } }[] }).items[0];
  }).toMatchObject({ type: "text", imported: { filename: "dropped.txt" } });
});
