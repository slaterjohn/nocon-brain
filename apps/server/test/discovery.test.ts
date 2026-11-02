import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { AppError } from "@ncb/shared";
import { parseFeed } from "../src/sources/discovery/feed.js";
import { fetchText, readFeed, readSitemap, type DiscoveryFetcher } from "../src/sources/discovery/fetch.js";
import { parseSitemap } from "../src/sources/discovery/sitemap.js";
import { parseXml, XmlError } from "../src/sources/discovery/xml.js";

function fakeFetcher(files: Record<string, Buffer | string | { status: number }>, calls: string[] = []): DiscoveryFetcher {
  return {
    async fetch(url) {
      calls.push(url);
      const f = files[url];
      if (f === undefined) return { status: 404, body: Buffer.alloc(0) };
      if (typeof f === "object" && !Buffer.isBuffer(f)) return { status: f.status, body: Buffer.alloc(0) };
      return { status: 200, body: Buffer.isBuffer(f) ? f : Buffer.from(f) };
    },
  };
}

const urlset = (locs: string[]) => `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locs.map((l) => `<url><loc>${l}</loc></url>`).join("")}</urlset>`;
const index = (locs: string[]) => `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locs.map((l) => `<sitemap><loc>${l}</loc></sitemap>`).join("")}</sitemapindex>`;

describe("XML reader", () => {
  it("decodes entities and CDATA, skips comments and processing instructions", () => {
    const x = parseXml(`<?xml version="1.0"?><!-- c --><a x="1 &amp; 2"><b><![CDATA[<raw> & text]]></b><c>&lt;t&gt; &#65;&#x42;</c><d/></a>`);
    expect(x.attrs.x).toBe("1 & 2");
    expect(x.children[0]!.text).toBe("<raw> & text");
    expect(x.children[1]!.text).toBe("<t> AB");
    expect(x.children[2]!.name).toBe("d");
  });

  it("never expands entities from a DOCTYPE (no billion laughs, no external files)", () => {
    const evil = `<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;"><!ENTITY xxe SYSTEM "file:///etc/passwd">]><a>&lol2;&xxe;</a>`;
    const x = parseXml(evil);
    expect(x.text).toBe("&lol2;&xxe;");
  });

  it.each([
    ["unclosed tag", "<a><b></a>"],
    ["stray closing tag", "</a>"],
    ["unterminated comment", "<a><!-- x </a>"],
    ["empty", "   "],
    ["truncated tag", "<a><b"],
  ])("rejects %s", (_n, doc) => {
    expect(() => parseXml(doc)).toThrow(XmlError);
  });

  it("refuses runaway nesting", () => {
    expect(() => parseXml("<a>".repeat(200) + "</a>".repeat(200))).toThrow(/nested too deeply/);
  });
});

describe("sitemap parsing", () => {
  it("reads a urlset with lastmod, changefreq and priority", () => {
    const s = parseSitemap(`<urlset><url><loc> https://a.test/x </loc><lastmod>2025-01-06</lastmod><changefreq>weekly</changefreq><priority>0.8</priority></url><url><loc>/relative</loc></url></urlset>`, { base: "https://a.test/" });
    expect(s.kind).toBe("urlset");
    if (s.kind !== "urlset") return;
    expect(s.urls).toEqual([
      { loc: "https://a.test/x", lastmod: Date.parse("2025-01-06"), changefreq: "weekly", priority: 0.8 },
      { loc: "https://a.test/relative", lastmod: undefined, changefreq: undefined, priority: undefined },
    ]);
  });

  it("reads an index, a plain-text list, and skips unusable addresses", () => {
    const i = parseSitemap(index(["https://a.test/s1.xml", "ftp://a.test/no", "https://u:p@a.test/cred"]));
    expect(i.kind === "index" && i.sitemaps.map((s) => s.loc)).toEqual(["https://a.test/s1.xml"]);
    const t = parseSitemap("# comment\nhttps://a.test/1\n\nhttps://a.test/2\njavascript:alert(1)\n");
    expect(t.kind === "urlset" && t.urls.map((u) => u.loc)).toEqual(["https://a.test/1", "https://a.test/2"]);
    expect(t.kind === "urlset" && t.skipped).toBe(1);
  });

  it("caps a huge sitemap at the URL limit and says so", () => {
    const big = urlset(Array.from({ length: 50_005 }, (_, i) => `https://a.test/p${i}`));
    const s = parseSitemap(big);
    expect(s.kind === "urlset" && s.urls.length).toBe(50_000);
    expect(s.kind === "urlset" && s.truncated).toBe(true);
    const small = parseSitemap(big, { maxUrls: 10 });
    expect(small.kind === "urlset" && small.urls.length).toBe(10);
  });

  it("rejects malformed and non-sitemap documents", () => {
    expect(() => parseSitemap("<urlset><url><loc>x</url>")).toThrow(XmlError);
    expect(() => parseSitemap("<html><body/></html>")).toThrow(/top element is <html>/);
    expect(() => parseSitemap("not a sitemap at all")).toThrow(/holds no web addresses/);
  });
});

describe("sitemap fetching through the guard", () => {
  it("follows an index, unpacks gzip by its magic bytes, and de-duplicates across files", async () => {
    const calls: string[] = [];
    const f = fakeFetcher({
      "https://a.test/index.xml": index(["https://a.test/1.xml", "https://a.test/2.xml.gz", "https://a.test/1.xml"]),
      "https://a.test/1.xml": urlset(["https://a.test/a", "https://a.test/b"]),
      "https://a.test/2.xml.gz": gzipSync(Buffer.from(urlset(["https://a.test/b", "https://a.test/c"]))),
    }, calls);
    const r = await readSitemap(f, "https://a.test/index.xml");
    expect(r.urls.map((u) => u.loc)).toEqual(["https://a.test/a", "https://a.test/b", "https://a.test/c"]);
    expect(r.filesFetched).toBe(3);
    expect(calls.filter((c) => c.endsWith("1.xml"))).toHaveLength(1);
    expect(r.truncated).toBe(false);
  });

  it("stops at the recursion cap and at the file cap, with a warning", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 6; i++) files[`https://a.test/n${i}.xml`] = index([`https://a.test/n${i + 1}.xml`]);
    files["https://a.test/n6.xml"] = urlset(["https://a.test/deep"]);
    const r = await readSitemap(fakeFetcher(files), "https://a.test/n0.xml", { maxDepth: 3 });
    expect(r.urls).toHaveLength(0);
    expect(r.warnings.join(" ")).toMatch(/nested sitemaps below 3 levels/);

    const wide: Record<string, string> = { "https://a.test/i.xml": index(Array.from({ length: 10 }, (_, i) => `https://a.test/c${i}.xml`)) };
    for (let i = 0; i < 10; i++) wide[`https://a.test/c${i}.xml`] = urlset([`https://a.test/p${i}`]);
    const w = await readSitemap(fakeFetcher(wide), "https://a.test/i.xml", { maxFiles: 4 });
    expect(w.filesFetched).toBe(4);
    expect(w.truncated).toBe(true);
    expect(w.urls).toHaveLength(3);
  });

  it("stops at 50,000 distinct addresses", async () => {
    const f = fakeFetcher({
      "https://a.test/i.xml": index(["https://a.test/1.xml", "https://a.test/2.xml"]),
      "https://a.test/1.xml": urlset(Array.from({ length: 30_000 }, (_, i) => `https://a.test/x${i}`)),
      "https://a.test/2.xml": urlset(Array.from({ length: 30_000 }, (_, i) => `https://a.test/y${i}`)),
    });
    const r = await readSitemap(f, "https://a.test/i.xml");
    expect(r.urls).toHaveLength(50_000);
    expect(r.truncated).toBe(true);
    expect(r.warnings.join(" ")).toMatch(/50,000/);
  });

  it("skips a broken child but fails on a broken start document", async () => {
    const f = fakeFetcher({
      "https://a.test/i.xml": index(["https://a.test/bad.xml", "https://a.test/missing.xml", "https://a.test/ok.xml"]),
      "https://a.test/bad.xml": "<urlset><url>",
      "https://a.test/ok.xml": urlset(["https://a.test/fine"]),
    });
    const r = await readSitemap(f, "https://a.test/i.xml");
    expect(r.urls.map((u) => u.loc)).toEqual(["https://a.test/fine"]);
    expect(r.warnings).toHaveLength(2);
    await expect(readSitemap(fakeFetcher({ "https://a.test/s.xml": "<urlset><url>" }), "https://a.test/s.xml")).rejects.toThrow(/not a valid sitemap/);
    await expect(readSitemap(fakeFetcher({}), "https://a.test/none.xml")).rejects.toMatchObject({ code: "provider_error" });
  });

  it("enforces the 50 MB limit on the unpacked size of a gzip bomb", async () => {
    const bomb = gzipSync(Buffer.alloc(6 * 1024 * 1024, 0x20)); // 6 MiB of spaces, a few KB on the wire
    const f = fakeFetcher({ "https://a.test/b.gz": bomb });
    await expect(fetchText(f, "https://a.test/b.gz", 1024 * 1024)).rejects.toThrow(/larger than the 1 MB limit once unpacked/);
    const ok = await fetchText(f, "https://a.test/b.gz", 8 * 1024 * 1024);
    expect(ok.text.length).toBe(6 * 1024 * 1024);
  });

  it("turns guard errors into plain API errors", async () => {
    const f: DiscoveryFetcher = { fetch: async () => { throw Object.assign(new Error("blocked"), { code: "ssrf_blocked" }); } };
    await expect(fetchText(f, "http://10.0.0.1/s.xml", 1000)).rejects.toMatchObject({ code: "blocked" });
    const g: DiscoveryFetcher = { fetch: async () => { throw Object.assign(new Error("big"), { code: "size_cap" }); } };
    await expect(fetchText(g, "http://x.test/s.xml", 50 * 1048576)).rejects.toBeInstanceOf(AppError);
  });
});

const rss2 = `<?xml version="1.0"?><rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel><title>Gazette</title><link>https://a.test/</link>
<item><title>One &amp; more</title><link>https://a.test/one</link><guid isPermaLink="false">g-1</guid><pubDate>Mon, 06 Jan 2025 00:00:00 GMT</pubDate><dc:creator>Ann</dc:creator><description>First</description></item>
<item><title>Two</title><link>/two</link><guid>https://a.test/two</guid><pubDate>Sat, 11 Jan 2025 00:00:00 GMT</pubDate></item>
<item><title>One again</title><link>https://a.test/one#frag</link><guid isPermaLink="false">g-1</guid></item>
<item><title>Three, only a guid URL</title><guid>https://a.test/three</guid></item>
<item><title>No address</title><guid isPermaLink="false">nothing</guid></item>
</channel></rss>`;

const atom = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Atom feed</title><link href="https://a.test/atom" rel="self"/>
<entry><title>A</title><link rel="alternate" href="https://a.test/a"/><link rel="enclosure" href="https://a.test/a.mp3"/><id>tag:a,1</id><published>2025-01-06T00:00:00Z</published><updated>2025-01-07T00:00:00Z</updated><author><name>Bea</name></author><summary>Sum</summary></entry>
<entry><title>B</title><link href="/b"/><id>tag:a,2</id><updated>2025-02-01T00:00:00Z</updated></entry>
<entry><title>A newer</title><link href="https://a.test/a/"/><id>tag:a,1</id><updated>2025-03-01T00:00:00Z</updated></entry>
</feed>`;

const rss1 = `<?xml version="1.0"?><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/">
<channel rdf:about="https://a.test/"><title>Old school</title></channel>
<item rdf:about="https://a.test/r1"><title>R1</title><link>https://a.test/r1</link><dc:date>2025-01-06T00:00:00Z</dc:date><dc:creator>Cy</dc:creator></item>
<item rdf:about="https://a.test/r2"><title>R2</title><link>https://a.test/r2</link></item></rdf:RDF>`;

describe("feed normalisation", () => {
  it("RSS 2.0: dates, authors, relative links, guid-as-link, duplicate removal", () => {
    const f = parseFeed(rss2, { base: "https://a.test/feed.xml" });
    expect(f.format).toBe("rss2");
    expect(f.title).toBe("Gazette");
    expect(f.items.map((i) => i.url)).toEqual(["https://a.test/one", "https://a.test/two", "https://a.test/three"]);
    expect(f.items[0]).toMatchObject({ title: "One & more", id: "g-1", author: "Ann", published: Date.UTC(2025, 0, 6), summary: "First" });
    expect(f.duplicates).toBe(1);
    expect(f.skipped).toBe(1);
  });

  it("Atom: prefers the alternate link, merges duplicates by id and by address, keeps the newest update", () => {
    const f = parseFeed(atom, { base: "https://a.test/atom" });
    expect(f.format).toBe("atom");
    expect(f.items.map((i) => i.url)).toEqual(["https://a.test/a", "https://a.test/b"]);
    expect(f.items[0]).toMatchObject({ id: "tag:a,1", author: "Bea", published: Date.UTC(2025, 0, 6), updated: Date.UTC(2025, 2, 1) });
    expect(f.duplicates).toBe(1);
  });

  it("RSS 1.0 (RDF) items sit beside the channel", () => {
    const f = parseFeed(rss1);
    expect(f.format).toBe("rss1");
    expect(f.items.map((i) => [i.url, i.author, i.published])).toEqual([["https://a.test/r1", "Cy", Date.UTC(2025, 0, 6)], ["https://a.test/r2", undefined, undefined]]);
  });

  it("rejects a feed that is HTML, broken, or not a feed", async () => {
    expect(() => parseFeed("<html><body>Not a feed</body></html>")).toThrow(/not a feed/);
    expect(() => parseFeed("<rss><channel><item>")).toThrow(XmlError);
    expect(() => parseFeed(`<rss version="2.0"></rss>`)).toThrow(/no channel/);
    await expect(readFeed(fakeFetcher({ "https://a.test/f": "<html/>" }), "https://a.test/f")).rejects.toThrow(/not a valid feed/);
  });

  it("caps the number of items", () => {
    const many = `<rss><channel>${Array.from({ length: 30 }, (_, i) => `<item><link>https://a.test/${i}</link></item>`).join("")}</channel></rss>`;
    const f = parseFeed(many, { maxItems: 10 });
    expect(f.items).toHaveLength(10);
    expect(f.truncated).toBe(true);
  });
});
