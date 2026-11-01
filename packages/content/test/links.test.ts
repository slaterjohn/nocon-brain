import { describe, expect, it } from "vitest";
import { extractLinks, REGION_BASE } from "../src/index.js";

const url = "https://example.com/blog/post";
const doc = `<!doctype html><html><body>
<header><a href="/">Logo</a></header>
<nav><a href="/about">About us today</a><a href="/login">Log in</a></nav>
<main><article>
<h1>Post</h1>
<p>Read the <a href="/blog/other-post">other post about careful reading</a> and see <a href="https://elsewhere.org/x" rel="nofollow">an external source</a>.</p>
<h2><a href="/blog/start">Start here for beginners</a></h2>
<p><a href="/blog/other-post">again</a> <a href="#frag">skip</a> <a href="mailto:a@b.c">mail</a> <a href="javascript:void 0">js</a></p>
</article></main>
<aside class="related-posts"><a href="/blog/related-one">Related reading one</a></aside>
<footer><a href="/privacy">Privacy policy statement</a><a href="/blog/page/2">older</a></footer>
</body></html>`;

describe("A-09 link classification", () => {
  const links = extractLinks(doc, { url });
  const find = (suffix: string, region?: string) => links.find((l) => l.url.endsWith(suffix) && (!region || l.region === region))!;

  it("classifies regions and drops non-navigational links", () => {
    expect(find("/blog/other-post", "content").region).toBe("content");
    expect(find("/blog/start").region).toBe("heading");
    expect(find("/blog/related-one").region).toBe("related");
    expect(find("/about").region).toBe("nav");
    expect(find("/", "nav").region).toBe("nav"); // header counts as navigation chrome
    expect(find("/privacy").region).toBe("footer");
    expect(links.some((l) => /frag|mailto|javascript/.test(l.url))).toBe(false);
  });

  it("orders main article > headings > related > nav > footer whatever the modifiers", () => {
    const best = (r: string) => Math.max(...links.filter((l) => l.region === r).map((l) => l.score));
    const worst = (r: string) => Math.min(...links.filter((l) => l.region === r).map((l) => l.score));
    expect(worst("content")).toBeGreaterThan(best("heading"));
    expect(worst("heading")).toBeGreaterThan(best("related"));
    expect(worst("related")).toBeGreaterThan(best("nav"));
    expect(worst("nav")).toBeGreaterThan(best("footer"));
    for (const l of links) expect(Math.abs(l.score - REGION_BASE[l.region])).toBeLessThanOrEqual(0.081);
  });

  it("records the features that explain a score", () => {
    const ext = find("/x", "content");
    expect(ext.relNofollow).toBe(true);
    expect(ext.isInternal).toBe(false);
    expect(ext.score).toBeLessThan(find("/blog/other-post", "content").score);
    expect(find("/login").features.urlShape).toBe("chrome");
    expect(find("/blog/page/2").features.urlShape).toBe("pagination");
    expect(find("/blog/other-post", "content").features).toMatchObject({ anchorQuality: "strong", samePrefix: true });
    expect(find("/blog/other-post", "content").anchorText).toBe("other post about careful reading");
    expect(find("/blog/other-post", "content").context).toContain("Read the");
  });

  it("keeps one row per region and URL but not per occurrence", () => {
    expect(links.filter((l) => l.url.endsWith("/blog/other-post"))).toHaveLength(1);
  });

  it("without any landmark, plain links count as content and density drives the score", () => {
    const l = extractLinks(`<body><div><p>Long prose with <a href="/a">one useful link here</a> in the middle of the sentence and more words after it.</p></div></body>`, { url });
    expect(l[0]!.region).toBe("content");
  });
});
