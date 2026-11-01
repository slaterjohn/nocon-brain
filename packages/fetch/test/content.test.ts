import { describe, expect, it } from "vitest";
import { decodeText, detectCharset, sniffType, typeAllowed, parseContentType } from "../src";

const b = (s: string) => Buffer.from(s);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

describe("sniffType", () => {
  it("html beats text/plain, image/* and octet-stream and a missing type", () => {
    const html = b("  <!DOCTYPE html><title>x</title>");
    for (const d of ["text/plain", "image/png", "application/octet-stream", null]) expect(sniffType(html, d).type).toBe("text/html");
  });
  it("png beats text/html", () => expect(sniffType(PNG, "text/html").type).toBe("image/png"));
  it("pdf beats text/html", () => expect(sniffType(b("%PDF-1.4\n"), "text/html").type).toBe("application/pdf"));
  it("json beats text/html when the body is not markup", () => expect(sniffType(b('{"a":1}'), "text/html").type).toBe("application/json"));
  it("keeps an honest header", () => {
    expect(sniffType(b("body{color:red}"), "text/css").type).toBe("text/css");
    expect(sniffType(b("<!doctype html>"), "text/html").overridden).toBe(false);
  });
  it("keeps declared svg", () => expect(sniffType(b("<svg xmlns='x'></svg>"), "image/svg+xml").type).toBe("image/svg+xml"));
  it("unknown binary stays octet-stream", () => expect(sniffType(Buffer.from([1, 2, 3, 4, 5]), "application/octet-stream").type).toBe("application/octet-stream"));
});

describe("type allowlist", () => {
  it("matches exact, wildcard and any", () => {
    expect(typeAllowed("text/html", ["text/html"])).toBe(true);
    expect(typeAllowed("font/woff2", ["font/*"])).toBe(true);
    expect(typeAllowed("application/zip", ["*/*"])).toBe(true);
    expect(typeAllowed("application/zip", ["text/html"])).toBe(false);
    expect(typeAllowed(null, ["text/html"])).toBe(false);
  });
  it("parses content-type", () => expect(parseContentType('Text/HTML; Charset="UTF-8"')).toEqual({ type: "text/html", charset: "UTF-8" }));
});

describe("charset", () => {
  it("BOM wins over header", () => expect(detectCharset(Buffer.from([0xef, 0xbb, 0xbf, 0x41]), "iso-8859-1", true)).toEqual({ charset: "utf-8", source: "bom" }));
  it("header over meta", () => expect(detectCharset(b('<meta charset="utf-8">'), "iso-8859-1", true)).toEqual({ charset: "windows-1252", source: "header" }));
  it("meta charset", () => expect(detectCharset(b('<!doctype html><meta charset="windows-1252">'), null, true)).toEqual({ charset: "windows-1252", source: "meta" }));
  it("meta http-equiv", () => expect(detectCharset(b('<meta http-equiv="Content-Type" content="text/html; charset=shift_jis">'), null, true).charset).toBe("shift_jis"));
  it("meta ignored for non-html", () => expect(detectCharset(b('<meta charset="koi8-r">'), null, false).charset).toBeNull());
  it("unknown labels are ignored", () => expect(detectCharset(b("x"), "bogus-charset", false).charset).toBeNull());
  it("decodeText handles latin1 and strips BOM", () => {
    expect(decodeText(Buffer.from([0x63, 0x61, 0x66, 0xe9]), "iso-8859-1")).toBe("café");
    expect(decodeText(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), b("hi")]), "utf-8")).toBe("hi");
  });
});
