import { describe, expect, it } from "vitest";
import { markdownToDocument, pdfToDocument, textToDocument, decodeUploadedText } from "../src/imports/convert.js";
import { cleanFilename, detectImport, ImportRefused } from "../src/imports/detect.js";
import { pageParagraphs, parsePdfDate } from "../src/imports/pdf.js";

const refusal = (fn: () => unknown): string | undefined => {
  try { fn(); } catch (e) { return e instanceof ImportRefused ? e.refusal : `other:${String(e)}`; }
  return undefined;
};
const b = (s: string) => Buffer.from(s);

describe("C-14 type detection", () => {
  it("accepts the four formats by content and label", () => {
    expect(detectImport("a.html", "text/html", b("<html><body>x</body></html>"))).toEqual({ kind: "html", mime: "text/html" });
    expect(detectImport("a.pdf", "application/pdf", b("%PDF-1.7\n...")).kind).toBe("pdf");
    expect(detectImport("a.md", "text/markdown", b("# x")).kind).toBe("markdown");
    expect(detectImport("a.txt", "text/plain", b("x")).kind).toBe("text");
    expect(detectImport("notes.md", "text/plain", b("# x")).kind).toBe("markdown");
    expect(detectImport("a.markdown", "", b("# x")).kind).toBe("markdown");
    expect(detectImport("readme", "text/markdown", b("# x")).kind).toBe("markdown");
  });

  it("a PDF header may follow up to 1 KiB of junk, as the format allows", () => {
    expect(detectImport("a.pdf", "application/pdf", Buffer.concat([Buffer.alloc(900, 0x20), b("%PDF-1.4\n")])).kind).toBe("pdf");
    expect(refusal(() => detectImport("a.pdf", "application/pdf", Buffer.concat([Buffer.alloc(1100, 0x20), b("%PDF-1.4\n")])))).toBe("malformed_pdf");
  });

  it("believes the bytes over the label", () => {
    expect(detectImport("a.txt", "text/plain", b("%PDF-1.4\nrest")).kind).toBe("pdf");
    expect(refusal(() => detectImport("a.pdf", "application/pdf", b("plain text")))).toBe("malformed_pdf");
    expect(refusal(() => detectImport("a.txt", "text/plain", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))).toBe("binary_content");
    expect(refusal(() => detectImport("a.html", "text/html", Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2])))).toBe("binary_content");
    expect(refusal(() => detectImport("a.txt", "text/plain", b("a\0b")))).toBe("binary_content");
  });

  it("refuses other types, contradictory labels and empty files", () => {
    expect(refusal(() => detectImport("a.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", b("x")))).toBe("unsupported_type");
    expect(refusal(() => detectImport("a.png", "image/png", b("x")))).toBe("unsupported_type");
    expect(refusal(() => detectImport("a.bin", "application/octet-stream", b("x")))).toBe("unsupported_type");
    expect(refusal(() => detectImport("a.pdf", "text/html", b("<html>")))).toBe("type_mismatch");
    expect(refusal(() => detectImport("a.txt", "text/plain", Buffer.alloc(0)))).toBe("empty");
  });

  it("accepts UTF-16 text with a byte order mark", () => {
    const u16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("hello there", "utf16le")]);
    expect(detectImport("a.txt", "text/plain", u16).kind).toBe("text");
    expect(decodeUploadedText(u16)).toBe("hello there");
  });

  it("cleans file names", () => {
    expect(cleanFilename("C:\\Users\\me\\report.pdf")).toBe("report.pdf");
    expect(cleanFilename("../../etc/passwd")).toBe("passwd");
    expect(cleanFilename("a\u0000b\nc.txt")).toBe("abc.txt");
    expect(cleanFilename("..")).toBe("");
    expect(cleanFilename(undefined)).toBe("");
    expect(cleanFilename("x".repeat(300) + ".pdf").length).toBeLessThanOrEqual(200);
    expect(cleanFilename("x".repeat(300) + ".pdf").endsWith(".pdf")).toBe(true);
  });
});

describe("C-14 conversion", () => {
  it("text becomes escaped paragraphs", () => {
    const d = textToDocument("First <b>para</b>\nsecond line\n\nSecond & last", "my_notes.txt");
    expect(d.title).toBe("my notes");
    expect(d.html).toContain("<p>First &lt;b&gt;para&lt;/b&gt;<br>\nsecond line</p>");
    expect(d.html).toContain("<p>Second &amp; last</p>");
    expect(d.html).not.toContain("<b>");
  });

  it("Markdown goes through the reader allowlist", () => {
    const d = markdownToDocument("# Title here\n\nText <script>alert(1)</script> and [x](javascript:alert(1)) and ![p](https://e.org/p.png) <img src=x onerror=alert(1)>\n\n- a\n- b\n", "n.md", "https://imports.noconbrain.invalid/x/n.md");
    expect(d.title).toBe("Title here");
    expect(d.html).not.toMatch(/<script|javascript:|onerror/);
    expect(d.html).toContain("<li>a</li>");
    expect(d.html.match(/<h1>/g)).toHaveLength(1);
  });

  it("PDF pages become sections and metadata becomes meta tags", () => {
    const d = pdfToDocument({
      pageCount: 3, pages: [["One."], [], ["Three & four."]], emptyPages: 1, truncated: false, chars: 20,
      info: { title: "T <1>", author: "A", subject: "S", keywords: null, creator: null, producer: null, createdAt: "2025-01-01T00:00:00Z", modifiedAt: null, pdfVersion: "1.7" },
    }, "x.pdf");
    expect(d.pageCount).toBe(3);
    expect(d.html).toContain('<title>T &lt;1&gt;</title>');
    expect(d.html).toContain('<meta name="author" content="A">');
    expect(d.html).toContain('id="page-3"');
    expect(d.html).not.toContain('id="page-2"');
    expect(d.html).toContain("Three &amp; four.");
  });

  it("flags a long PDF that was cut and a PDF with no text", () => {
    const info = { title: null, author: null, subject: null, keywords: null, creator: null, producer: null, createdAt: null, modifiedAt: null, pdfVersion: null };
    expect(pdfToDocument({ pageCount: 9, pages: [["a"]], emptyPages: 0, truncated: true, chars: 1, info }, "long.pdf").html).toMatch(/Only the first part/);
    expect(pdfToDocument({ pageCount: 2, pages: [[], []], emptyPages: 2, truncated: false, chars: 0, info }, "scan.pdf").html).toMatch(/no text to extract/);
  });
});

describe("C-14 pdf helpers", () => {
  const item = (str: string, y: number, hasEOL = false, height = 12) => ({ str, transform: [1, 0, 0, 1, 0, y], height, hasEOL });

  it("joins lines of a paragraph and splits on large gaps", () => {
    const paras = pageParagraphs([item("The tide", 700), item(" comes in", 700, true), item("and goes out.", 686, true), item("A new paragraph.", 650, true)]);
    expect(paras).toEqual(["The tide comes in and goes out.", "A new paragraph."]);
  });

  it("repairs a word hyphenated at a line end", () => {
    expect(pageParagraphs([item("the lighthouse was auto-", 700, true), item("matic and bright", 686, true)])).toEqual(["the lighthouse was automatic and bright"]);
    expect(pageParagraphs([item("a well-", 700, true), item("Known thing", 686, true)])).toEqual(["a well- Known thing"]);
  });

  it("parses PDF dates", () => {
    expect(parsePdfDate("D:20250106090000Z")).toBe("2025-01-06T09:00:00Z");
    expect(parsePdfDate("D:20250106090000+01'00'")).toBe("2025-01-06T09:00:00+01:00");
    expect(parsePdfDate("D:2025")).toBe("2025-01-01T00:00:00Z");
    expect(parsePdfDate("nonsense")).toBeNull();
    expect(parsePdfDate(undefined)).toBeNull();
  });
});
