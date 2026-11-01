import { describe, expect, it } from "vitest";
import { extractMetadata, flattenJsonLd, parseDate } from "../src/index.js";

const url = "https://news.example.com/2024/03/05/story";
const page = (head: string, body = "<p>x</p>", htmlAttrs = ' lang="en"') => `<!doctype html><html${htmlAttrs}><head>${head}</head><body>${body}</body></html>`;
const ld = (o: unknown) => `<script type="application/ld+json">${typeof o === "string" ? o : JSON.stringify(o)}</script>`;

describe("A-07 metadata precedence", () => {
  it("title: og:title > JSON-LD headline > <title> > h1", () => {
    const all = page(`<title>Plain | Example News</title><meta property="og:title" content="OG title">${ld({ "@type": "Article", headline: "LD headline" })}`);
    expect(extractMetadata(all, { url })).toMatchObject({ title: "OG title", titleSource: "og" });
    expect(extractMetadata(page(`<title>Plain</title>${ld({ "@type": "Article", headline: "LD headline" })}`), { url })).toMatchObject({ title: "LD headline", titleSource: "jsonld" });
    expect(extractMetadata(page("<title>Plain</title>"), { url })).toMatchObject({ title: "Plain", titleSource: "title" });
    expect(extractMetadata(page("", "<h1>Heading only</h1>"), { url })).toMatchObject({ title: "Heading only", titleSource: "h1" });
  });

  it("removes the site suffix from <title> only when it matches the site name", () => {
    expect(extractMetadata(page('<title>Big story | Example News</title><meta property="og:site_name" content="Example News">'), { url }).title).toBe("Big story");
    expect(extractMetadata(page("<title>Cats - dogs</title>"), { url }).title).toBe("Cats - dogs");
  });

  it("description, site name and author follow their precedence", () => {
    const m = extractMetadata(page(`<meta name="description" content="meta desc"><meta property="og:description" content="og desc"><meta property="og:site_name" content="OG Site"><meta name="author" content="Meta Author">${ld({ "@type": "Article", author: { "@type": "Person", name: "LD Author" }, publisher: { name: "LD Pub" } })}`), { url });
    expect(m).toMatchObject({ description: "og desc", siteName: "OG Site", author: "Meta Author" });
    const m2 = extractMetadata(page(ld({ "@type": "Article", description: "ld desc", author: [{ name: "A" }, { name: "B" }], publisher: { name: "LD Pub" } })), { url });
    expect(m2).toMatchObject({ description: "ld desc", siteName: "LD Pub", author: "A, B" });
  });

  it("dates carry a source and confidence, and the URL pattern is the last resort", () => {
    const og = extractMetadata(page('<meta property="article:published_time" content="2024-03-01T10:00:00+01:00">'), { url });
    expect(og.published).toEqual({ at: Date.UTC(2024, 2, 1, 9), source: "og", confidence: "high" });
    expect(extractMetadata(page(ld({ "@type": "Article", datePublished: "2024-02-02", dateModified: "2024-02-03T00:00:00Z" })), { url })).toMatchObject({
      published: { source: "jsonld", confidence: "high" }, modified: { source: "jsonld" },
    });
    expect(extractMetadata(page("", '<article><time datetime="2023-12-24">Xmas</time></article>'), { url }).published).toMatchObject({ source: "time_element", confidence: "medium" });
    expect(extractMetadata(page('<meta name="date" content="2023-01-02">'), { url }).published).toMatchObject({ source: "meta" });
    expect(extractMetadata(page(""), { url }).published).toEqual({ at: Date.UTC(2024, 2, 5), source: "url", confidence: "low" });
  });

  it("never uses the fetch date as the publication date", () => {
    const m = extractMetadata(page("<title>x</title>"), { url: "https://example.com/about", headers: { date: new Date().toUTCString(), "last-modified": "Wed, 21 Oct 2015 07:28:00 GMT" } });
    expect(m.published).toBeNull();
    expect(m.modified).toBeNull();
  });

  it("rejects absurd dates", () => {
    expect(parseDate("0001-01-01")).toBeNull();
    expect(parseDate("not a date")).toBeNull();
    expect(parseDate("2024-03-01 10:00")).toBe(Date.UTC(2024, 2, 1, 10));
  });

  it("language: <html lang> first, then Content-Language, then franc-min on the text", () => {
    const french = "Le gouvernement a annoncé hier une série de mesures destinées à soutenir les entreprises touchées par la hausse des prix de l'énergie dans plusieurs régions du pays.";
    expect(extractMetadata(page("", `<p>${french}</p>`, ' lang="de-at"'), { url })).toMatchObject({ language: "de-AT", languageSource: "html_lang" });
    expect(extractMetadata(page("", `<p>${french}</p>`, ""), { url, headers: { "content-language": "pt-br" } })).toMatchObject({ language: "pt-BR", languageSource: "content_language" });
    expect(extractMetadata(page("", `<article><p>${french}</p></article>`, ""), { url })).toMatchObject({ language: "fr", languageSource: "franc" });
    expect(extractMetadata(page("", "<p>Hi</p>", ""), { url })).toMatchObject({ language: null, languageSource: "none" });
    expect(extractMetadata(page("", `<p>${french}</p>`, ' lang="und"'), { url }).languageSource).toBe("franc");
  });

  it("tolerates invalid and oversize JSON-LD and flattens @graph", () => {
    const bad = page(`${ld("{ not json")}${ld('{"@type":"Article","headline":"Trailing comma",}')}`);
    const m = extractMetadata(bad, { url });
    expect(m.jsonLd).toMatchObject({ blocks: 2, invalid: 1 });
    expect(m.title).toBe("Trailing comma");
    const graph = ld({ "@context": "https://schema.org", "@graph": [{ "@type": "WebSite", "@id": "#site", name: "Graph Site" }, { "@type": "Article", headline: "In graph", author: { "@id": "#me" }, isPartOf: { "@id": "#site" } }, { "@type": "Person", "@id": "#me", name: "Me Myself" }] });
    const g = extractMetadata(page(graph), { url });
    expect(g).toMatchObject({ title: "In graph", author: "Me Myself" });
    expect(g.jsonLd.types).toEqual(["WebSite", "Article", "Person"]);
    const big = extractMetadata(page(ld({ "@type": "Article", headline: "Big", pad: "x".repeat(2000) })), { url, maxJsonLdBytes: 100 });
    expect(big.jsonLd.oversize).toBe(1);
    expect(big.title).toBeNull();
    expect(flattenJsonLd([{ "@type": "A" }, [{ "@type": "B" }]]).map((x) => x["@type"])).toEqual(["A", "B"]);
  });

  it("falls back to the source text when the DOM parser loses the title", () => {
    expect(extractMetadata("<title>Lost title</title><p>no html element</p>", { url }).title).toBeTruthy();
  });
});
