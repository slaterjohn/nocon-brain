import { describe, expect, it } from "vitest";
import {
  WikipediaClient, WikipediaError, articleUrl, attributionFromImageInfo, extractWikiImages, extractWikiLinks, historyUrl, isMainNamespace, normaliseTitle,
  parseWikipediaUrl, parsoidMeta, revisionFromEtag, skipKindOf, skipReason, validContact, wikipediaUserAgent,
} from "../src/wikipedia/index.js";

describe("parseWikipediaUrl", () => {
  it.each([
    ["https://en.wikipedia.org/wiki/Benzene", "en", "Benzene"],
    ["https://en.m.wikipedia.org/wiki/Benzene", "en", "Benzene"],
    ["https://de.wikipedia.org/wiki/Schwarzes_Loch", "de", "Schwarzes_Loch"],
    ["https://fr.m.wikipedia.org/wiki/Trou_noir#Histoire", "fr", "Trou_noir"],
    ["https://en.wikipedia.org/wiki/black_hole", "en", "Black_hole"],
    ["https://en.wikipedia.org/wiki/Black%20hole", "en", "Black_hole"],
    ["http://en.wikipedia.org/wiki/Benzene", "en", "Benzene"],
    ["https://en.wikipedia.org/w/index.php?title=Benzene", "en", "Benzene"],
    ["https://en.wikipedia.org/index.php?title=Aromaticity&redirect=no", "en", "Aromaticity"],
    ["https://en.wikipedia.org/wiki/AC%2FDC", "en", "AC/DC"],
    ["https://en.wikipedia.org/wiki/Star_Trek:_Voyager", "en", "Star_Trek:_Voyager"],
    ["https://simple.wikipedia.org/wiki/Moon", "simple", "Moon"],
    ["https://zh-yue.wikipedia.org/wiki/月球", "zh-yue", "月球"],
  ])("%s is an article", (u, lang, title) => {
    expect(parseWikipediaUrl(u)).toEqual({ lang, title });
  });

  it.each([
    "https://en.wikipedia.org/wiki/Category:Stars",
    "https://en.wikipedia.org/wiki/File:Sun.png",
    "https://en.wikipedia.org/wiki/Special:Search?search=x",
    "https://en.wikipedia.org/wiki/Talk:Benzene",
    "https://en.wikipedia.org/wiki/Template:Reflist",
    "https://en.wikipedia.org/wiki/Benzene?action=edit",
    "https://en.wikipedia.org/wiki/Benzene?oldid=12345",
    "https://en.wikipedia.org/w/index.php?title=Benzene&action=history",
    "https://en.wikipedia.org/w/index.php?title=Benzene&oldid=1",
    "https://en.wikipedia.org/w/index.php",
    "https://en.wikipedia.org/",
    "https://www.wikipedia.org/",
    "https://wikipedia.org/wiki/Benzene",
    "https://commons.wikimedia.org/wiki/Benzene",
    "https://example.org/wiki/Benzene",
    "https://en.wikipedia.org.evil.example/wiki/Benzene",
    "https://user:pw@en.wikipedia.org/wiki/Benzene",
    "ftp://en.wikipedia.org/wiki/Benzene",
    "not a url",
  ])("%s is not", (u) => {
    expect(parseWikipediaUrl(u)).toBeUndefined();
  });

  it("reads addresses on a replacement origin as articles of the default language", () => {
    const o = { origin: "http://127.0.0.1:4555", defaultLang: "en" };
    expect(parseWikipediaUrl("http://127.0.0.1:4555/wiki/Astronomy", o)).toEqual({ lang: "en", title: "Astronomy" });
    expect(parseWikipediaUrl("http://127.0.0.1:9999/wiki/Astronomy", o)).toBeUndefined();
    expect(articleUrl({ lang: "en", title: "Black_hole" }, o)).toBe("http://127.0.0.1:4555/wiki/Black_hole");
    expect(historyUrl({ lang: "en", title: "Black_hole" }, o)).toBe("http://127.0.0.1:4555/w/index.php?title=Black_hole&action=history");
  });

  it("builds the reading and history addresses", () => {
    expect(articleUrl({ lang: "de", title: "Schwarzes_Loch" })).toBe("https://de.wikipedia.org/wiki/Schwarzes_Loch");
    expect(articleUrl({ lang: "en", title: "AC/DC" })).toBe("https://en.wikipedia.org/wiki/AC%2FDC");
    expect(historyUrl({ lang: "en", title: "Benzene" })).toBe("https://en.wikipedia.org/w/index.php?title=Benzene&action=history");
  });

  it("normalises titles and namespaces", () => {
    expect(normaliseTitle("  black  hole#History ")).toBe("Black_hole");
    expect(isMainNamespace("Star_Trek:_Voyager")).toBe(true);
    expect(isMainNamespace("Wikipedia:About")).toBe(false);
    expect(isMainNamespace("Help:Contents")).toBe(false);
  });
});

describe("skip rules", () => {
  it("recognises disambiguation, list and year or date pages by title", () => {
    expect(skipKindOf("Mercury_(disambiguation)")).toBe("disambiguation");
    expect(skipKindOf("List_of_chemical_elements")).toBe("list");
    expect(skipKindOf("Lists_of_stars")).toBe("list");
    expect(skipKindOf("Index_of_physics_articles")).toBe("list");
    for (const y of ["1969", "44_BC", "1990s", "20th_century", "July_20", "1969_in_science", "Deaths_in_2020", "2019–20_Premier_League"]) expect(skipKindOf(y), y).toBe("year");
    for (const t of ["Benzene", "Black_hole", "Apollo_11", "Mercury_(planet)", "Listeria", "1984_(novel)"]) expect(skipKindOf(t), t).toBeUndefined();
  });

  it("applies only the kinds that are switched on", () => {
    const on = { disambiguation: true, lists: true, years: true };
    expect(skipReason("List_of_stars", on)).toBe("wikipedia:list");
    expect(skipReason("List_of_stars", { ...on, lists: false })).toBeNull();
    expect(skipReason("1969", on)).toBe("wikipedia:year");
    expect(skipReason("Mercury_(disambiguation)", on)).toBe("wikipedia:disambiguation");
    expect(skipReason("Benzene", on)).toBeNull();
  });
});

const PARSOID = `<!DOCTYPE html><html about="//en.wikipedia.org/wiki/Special:Redirect/revision/1234567"><head><meta property="mw:pageId" content="42"/><meta property="mw:pageNamespace" content="0"/><meta property="dc:modified" content="2026-10-01T12:00:00.000Z"/><base href="//en.wikipedia.org/wiki/"/></head><body>
<section data-mw-section-id="0"><p><a rel="mw:WikiLink" href="./Toluene" title="Toluene">toluene</a>, <a rel="mw:WikiLink" href="./Aromaticity#Definition">aromaticity</a>, <a rel="mw:WikiLink" href="./Category:Benzene" title="Category:Benzene">cat</a>, <a rel="mw:WikiLink" href="./File:Benzene.png">f</a>, <a rel="mw:ExtLink" href="https://example.org/">ext</a></p></section>
<section data-mw-section-id="1"><h2 id="History">History</h2><p><a rel="mw:WikiLink" href="./Toluene">again</a>, <a rel="mw:WikiLink" href="./Michael_Faraday" title="Michael Faraday">Faraday</a>, <a rel="mw:WikiLink" href="./Nonexistent_page?action=edit&amp;redlink=1" class="new">red</a>, <a rel="mw:WikiLink" href="./Star_Trek:_Voyager">voyager</a>, <a rel="mw:WikiLink" href="./Help:Contents">help</a></p></section>
<figure><a href="./File:Benzol.svg"><img resource="./File:Benzol.svg" src="//upload.wikimedia.org/wikipedia/commons/thumb/d/da/Benzol.svg/250px-Benzol.svg.png" alt=""/></a></figure>
<img src="//upload.wikimedia.org/math/x.svg" alt="math"/>
</body></html>`;

describe("Parsoid HTML", () => {
  it("lists article links only: namespace 0, no red links, no external links, repeats merged, lead links marked", () => {
    const links = extractWikiLinks(PARSOID);
    expect(links.map((l) => l.title)).toEqual(["Toluene", "Aromaticity", "Michael_Faraday", "Star_Trek:_Voyager"]);
    const by = Object.fromEntries(links.map((l) => [l.title, l]));
    expect(by.Toluene).toMatchObject({ lead: true, count: 2, position: 0 });
    expect(by.Aromaticity).toMatchObject({ lead: true, count: 1 });
    expect(by.Michael_Faraday).toMatchObject({ lead: false, count: 1 });
  });

  it("treats everything before the first heading as the lead when there are no section wrappers", () => {
    const html = `<body><p><a rel="mw:WikiLink" href="./A">a</a></p><h2>Next</h2><p><a rel="mw:WikiLink" href="./B">b</a></p></body>`;
    expect(extractWikiLinks(html).map((l) => [l.title, l.lead])).toEqual([["A", true], ["B", false]]);
  });

  it("reads the revision from the document and from the ETag", () => {
    expect(parsoidMeta(PARSOID)).toMatchObject({ revisionId: "1234567", pageId: "42", namespace: "0", modified: "2026-10-01T12:00:00.000Z" });
    expect(revisionFromEtag('W/"1234567/9f1c0a60-aaaa"')).toBe("1234567");
    expect(revisionFromEtag('"98/abc"')).toBe("98");
    expect(revisionFromEtag("nonsense")).toBeUndefined();
    expect(revisionFromEtag(undefined)).toBeUndefined();
  });

  it("lists the images that have a file page", () => {
    expect(extractWikiImages(PARSOID)).toEqual([{ file: "File:Benzol.svg", src: "//upload.wikimedia.org/wikipedia/commons/thumb/d/da/Benzol.svg/250px-Benzol.svg.png" }]);
  });

  it("turns imageinfo extmetadata into plain-text credit details", () => {
    const a = attributionFromImageInfo({
      descriptionurl: "//commons.wikimedia.org/wiki/File:Benzol.svg",
      extmetadata: {
        Artist: { value: '<a href="//commons.wikimedia.org/wiki/User:Edgar181" title="User:Edgar181">Edgar181</a> &amp; friends' },
        LicenseShortName: { value: "CC BY-SA 4.0" }, LicenseUrl: { value: "//creativecommons.org/licenses/by-sa/4.0" }, NonFree: { value: "false" },
        ImageDescription: { value: "<p>Benzene <i>ring</i></p>" }, AttributionRequired: { value: "true" },
      },
    }, "https://en.wikipedia.org");
    expect(a).toMatchObject({
      author: "Edgar181 & friends", licenseName: "CC BY-SA 4.0", licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0", sourcePageUrl: "https://commons.wikimedia.org/wiki/File:Benzol.svg",
      nonFree: false, description: "Benzene ring", attributionRequired: true,
    });
    expect(attributionFromImageInfo({ extmetadata: { NonFree: { value: "true" }, LicenseShortName: { value: "Fair use" } } }, "https://en.wikipedia.org").nonFree).toBe(true);
  });
});

describe("contact and User-Agent", () => {
  it("accepts a web address or an email address and nothing else", () => {
    for (const c of ["https://github.com/slaterjohn/nocon-brain", "http://example.org/contact", "ops@example.org"]) expect(validContact(c), c).toBe(true);
    for (const c of [undefined, "", "   ", "me", "ftp://x.org", "a b", "x\r\nHost: evil", "https://x.org/(a)", "<a@b.co>"]) expect(validContact(c as string), String(c)).toBe(false);
  });
  it("builds an identifying agent", () => {
    expect(wikipediaUserAgent("0.1.0", "https://github.com/slaterjohn/nocon-brain")).toBe("NoConBrain/0.1.0 (https://github.com/slaterjohn/nocon-brain)");
    expect(wikipediaUserAgent("0.1.0", "ops@example.org")).toBe("NoConBrain/0.1.0 (ops@example.org; https://github.com/slaterjohn/nocon-brain)");
  });
});

// ---- the client, on virtual time ---------------------------------------------------------------------------------------------------

interface Call { url: string; at: number; headers: Record<string, string> }

/** A client whose clock and sleep are virtual, answering from a script. */
function harness(script: (call: Call, n: number) => Response | Promise<Response>, o: Partial<ConstructorParameters<typeof WikipediaClient>[0]> = {}) {
  let t = 1_000_000;
  const calls: Call[] = [];
  const sleeps: number[] = [];
  const client = new WikipediaClient({
    contact: "https://github.com/slaterjohn/nocon-brain", version: "9.9.9", minBackoffMs: 5000,
    now: () => t, sleep: async (ms) => { sleeps.push(ms); t += ms; },
    fetch: (async (input: string | URL, init?: RequestInit) => {
      const call = { url: String(input), at: t, headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)) };
      calls.push(call);
      t += 5; // a request takes a few milliseconds
      return script(call, calls.length);
    }) as typeof fetch,
    ...o,
  });
  return { client, calls, sleeps, now: () => t, advance: (ms: number) => { t += ms; } };
}
const html = (body = "<p>ok</p>", headers: Record<string, string> = {}) => new Response(body, { status: 200, headers: { "content-type": "text/html", etag: 'W/"777/abc"', ...headers } });

describe("WikipediaClient", () => {
  it("refuses to make a request without a usable contact", async () => {
    for (const contact of [undefined, "", "nobody", "x\ny"]) {
      const h = harness(() => html(), { contact });
      await expect(h.client.pageHtml("en", "Benzene")).rejects.toMatchObject({ reason: "no_contact", code: "bad_request" });
      await expect(h.client.api("en", { action: "query" })).rejects.toBeInstanceOf(WikipediaError);
      expect(h.calls).toHaveLength(0);
    }
  });

  it("identifies itself on every request and asks for the core REST html route", async () => {
    const h = harness(() => html());
    await h.client.pageHtml("en", "black hole");
    expect(h.calls[0]!.url).toBe("https://en.wikipedia.org/w/rest.php/v1/page/Black_hole/html");
    expect(h.calls[0]!.headers["user-agent"]).toBe("NoConBrain/9.9.9 (https://github.com/slaterjohn/nocon-brain)");
  });

  it("starts at most one request a second, whatever is asked at once", async () => {
    const h = harness(() => html());
    await Promise.all(["A", "B", "C", "D", "E"].map((t) => h.client.pageHtml("en", t)));
    expect(h.calls).toHaveLength(5);
    for (let i = 1; i < h.calls.length; i++) expect(h.calls[i]!.at - h.calls[i - 1]!.at).toBeGreaterThanOrEqual(1000);
  });

  it("never has two requests in flight", async () => {
    let inFlight = 0;
    let max = 0;
    const h = harness(async () => {
      inFlight++;
      max = Math.max(max, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return html();
    });
    await Promise.all(Array.from({ length: 6 }, (_, i) => h.client.pageHtml("en", `T${i}`)));
    expect(max).toBe(1);
  });

  it("waits out Retry-After on a 429 and on a 503, then carries on", async () => {
    const h = harness((_c, n) => (n === 1 ? new Response("slow down", { status: 429, headers: { "retry-after": "7" } }) : n === 2 ? new Response("busy", { status: 503, headers: { "retry-after": "3" } }) : html()));
    const r = await h.client.pageHtml("en", "Benzene");
    expect(r.kind).toBe("ok");
    expect(h.calls).toHaveLength(3);
    expect(h.calls[1]!.at - h.calls[0]!.at).toBeGreaterThanOrEqual(7000);
    expect(h.calls[2]!.at - h.calls[1]!.at).toBeGreaterThanOrEqual(3000);
  });

  it("waits at least five seconds, then longer, when no delay is named", async () => {
    const h = harness((_c, n) => (n <= 2 ? new Response("", { status: 429 }) : html()));
    await h.client.pageHtml("en", "Benzene");
    expect(h.calls[1]!.at - h.calls[0]!.at).toBeGreaterThanOrEqual(5000);
    expect(h.calls[2]!.at - h.calls[1]!.at).toBeGreaterThanOrEqual(10_000);
  });

  it("hands a wait it will not sit through back to the caller", async () => {
    const h = harness(() => new Response("", { status: 429, headers: { "retry-after": "600" } }));
    await expect(h.client.pageHtml("en", "Benzene")).rejects.toMatchObject({ reason: "rate_limited", retryAfterMs: 600_000, code: "rate_limited" });
    expect(h.calls).toHaveLength(1);
  });

  it("gives up after its tries and reports the delay", async () => {
    const h = harness(() => new Response("", { status: 503, headers: { "retry-after": "2" } }), { maxAttempts: 3 });
    await expect(h.client.pageHtml("en", "Benzene")).rejects.toMatchObject({ reason: "rate_limited", retryAfterMs: 2000 });
    expect(h.calls).toHaveLength(3);
  });

  it("opens the circuit after repeated 429s and answers nothing while it is open", async () => {
    const h = harness(() => new Response("", { status: 429, headers: { "retry-after": "1" } }), { maxAttempts: 2, breaker: { failures: 4, openMs: 300_000 } });
    await expect(h.client.pageHtml("en", "A")).rejects.toMatchObject({ reason: "rate_limited" });
    await expect(h.client.pageHtml("en", "B")).rejects.toMatchObject({ reason: "rate_limited" });
    const made = h.calls.length;
    await expect(h.client.pageHtml("en", "C")).rejects.toMatchObject({ reason: "circuit_open", retryAfterMs: expect.any(Number) });
    expect(h.calls).toHaveLength(made);
    expect(h.client.state().breaker.state).toBe("open");
    h.client.reset();
    expect(h.client.state().breaker.state).toBe("closed");
  });

  it("after the pause one request decides: a good answer closes the circuit, a refusal reopens it at once", async () => {
    let answer: "bad" | "good" = "bad";
    const h = harness(() => (answer === "bad" ? new Response("", { status: 403 }) : html()), { breaker: { failures: 2, openMs: 60_000 } });
    await expect(h.client.pageHtml("en", "A")).rejects.toMatchObject({ reason: "forbidden" });
    await expect(h.client.pageHtml("en", "B")).rejects.toMatchObject({ reason: "forbidden" });
    await expect(h.client.pageHtml("en", "C")).rejects.toMatchObject({ reason: "circuit_open" });
    const made = h.calls.length;
    h.advance(61_000);
    await expect(h.client.pageHtml("en", "D")).rejects.toMatchObject({ reason: "forbidden" }); // the one request, refused again
    expect(h.calls).toHaveLength(made + 1);
    await expect(h.client.pageHtml("en", "E")).rejects.toMatchObject({ reason: "circuit_open" }); // reopened without another try
    h.advance(61_000);
    answer = "good";
    expect((await h.client.pageHtml("en", "F")).kind).toBe("ok");
    expect(h.client.state().breaker.state).toBe("closed");
  });

  it("sends the ETag back and reports a 304 as not modified", async () => {
    const h = harness((c) => (c.headers["if-none-match"] ? new Response(null, { status: 304, headers: { etag: 'W/"777/abc"' } }) : html()));
    const first = await h.client.pageHtml("en", "Benzene");
    expect(first).toMatchObject({ kind: "ok", etag: 'W/"777/abc"', revisionId: "777", licence: { name: "CC BY-SA 4.0", url: "https://creativecommons.org/licenses/by-sa/4.0/" } });
    const second = await h.client.pageHtml("en", "Benzene", { etag: 'W/"777/abc"' });
    expect(second).toMatchObject({ kind: "not_modified" });
  });

  it("reports a missing article, the revision header, and a redirect to the real title", async () => {
    const h = harness((c) => {
      if (c.url.includes("/Nope/")) return new Response("{}", { status: 404 });
      if (c.url.includes("/Blackhole/")) return new Response(null, { status: 307, headers: { location: "/w/rest.php/v1/page/Black_hole/html" } });
      return html("<p>x</p>", { "x-revision-id": "4242" });
    });
    expect(await h.client.pageHtml("en", "Nope")).toMatchObject({ kind: "missing" });
    const r = await h.client.pageHtml("en", "Blackhole");
    expect(r).toMatchObject({ kind: "ok", revisionId: "4242", redirectedFrom: "Blackhole", target: { lang: "en", title: "Black_hole" }, articleUrl: "https://en.wikipedia.org/wiki/Black_hole" });
    expect(r.kind === "ok" && r.historyUrl).toBe("https://en.wikipedia.org/w/index.php?title=Black_hole&action=history");
  });

  it("counts a redirect hop as a request of its own", async () => {
    const h = harness((c) => (c.url.includes("/Blackhole/") ? new Response(null, { status: 307, headers: { location: "/w/rest.php/v1/page/Black_hole/html" } }) : html()));
    await h.client.pageHtml("en", "Blackhole");
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1]!.at - h.calls[0]!.at).toBeGreaterThanOrEqual(1000);
  });

  it("never follows a redirect off Wikimedia and never fetches other hosts", async () => {
    const h = harness(() => new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data" } }));
    await expect(h.client.pageHtml("en", "Benzene")).rejects.toMatchObject({ reason: "blocked_host" });
    await expect(h.client.media("https://example.org/x.png")).rejects.toMatchObject({ reason: "blocked_host" });
    await expect(h.client.media("http://upload.wikimedia.org/x.png")).rejects.toMatchObject({ reason: "blocked_host" });
    expect(h.calls).toHaveLength(1);
  });

  it("adds maxlag=5 to Action API calls and waits out a maxlag answer", async () => {
    const h = harness((_c, n) => (n === 1
      ? new Response(JSON.stringify({ error: { code: "maxlag", info: "lagged" } }), { status: 200, headers: { "retry-after": "5" } })
      : new Response(JSON.stringify({ query: { pages: [{ title: "File:A.png", imageinfo: [{ url: "//u/x.png", extmetadata: { LicenseShortName: { value: "CC BY 4.0" } } }] }] } }), { status: 200 })));
    const info = await h.client.imageInfo("en", ["File:A.png"]);
    expect(new URL(h.calls[0]!.url).searchParams.get("maxlag")).toBe("5");
    expect(new URL(h.calls[0]!.url).searchParams.get("action")).toBe("query");
    expect(new URL(h.calls[0]!.url).searchParams.get("prop")).toBe("imageinfo");
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1]!.at - h.calls[0]!.at).toBeGreaterThanOrEqual(5000);
    expect(info.get("File:A.png")).toMatchObject({ licenseName: "CC BY 4.0" });
  });

  it("reads the credits of a file that lives on Commons, which the wiki itself reports as missing (shape seen on the real en.wikipedia.org)", async () => {
    const real = {
      batchcomplete: true,
      query: { pages: [{
        ns: 6, title: "File:Ethylbenzene-2D-skeletal.svg", missing: true, known: true, imagerepository: "shared",
        imageinfo: [{
          url: "https://upload.wikimedia.org/wikipedia/commons/9/9e/Ethylbenzene-2D-skeletal.svg",
          descriptionurl: "https://commons.wikimedia.org/wiki/File:Ethylbenzene-2D-skeletal.svg",
          extmetadata: { Artist: { value: "Benjah-bmm27", source: "commons-desc-page" }, LicenseShortName: { value: "Public domain", source: "commons-desc-page" }, NonFree: { value: "", source: "commons-desc-page" } },
        }],
      }, { ns: 6, title: "File:Gone.png", missing: true, known: false }] },
    };
    const h = harness(() => new Response(JSON.stringify(real), { status: 200 }));
    const info = await h.client.imageInfo("en", ["File:Ethylbenzene-2D-skeletal.svg", "File:Gone.png"]);
    expect(info.get("File:Ethylbenzene-2D-skeletal.svg")).toMatchObject({ author: "Benjah-bmm27", licenseName: "Public domain", sourcePageUrl: "https://commons.wikimedia.org/wiki/File:Ethylbenzene-2D-skeletal.svg", nonFree: false });
    expect(info.has("File:Gone.png")).toBe(false);
  });

  it("asks for at most 50 titles per Action API request", async () => {
    const h = harness((c) => {
      const titles = (new URL(c.url).searchParams.get("titles") ?? "").split("|");
      return new Response(JSON.stringify({ query: { pages: titles.map((title) => ({ title })) } }), { status: 200 });
    });
    const files = Array.from({ length: 120 }, (_, i) => `File:F${i}.png`);
    await h.client.imageInfo("en", files);
    expect(h.calls).toHaveLength(3);
    expect(h.calls.map((c) => (new URL(c.url).searchParams.get("titles") ?? "").split("|").length)).toEqual([50, 50, 20]);
  });

  it("uses the replacement origin for every language and allows only that origin besides Wikimedia", async () => {
    const h = harness(() => html(), { origin: "http://127.0.0.1:4555" });
    await h.client.pageHtml("de", "Benzol");
    expect(h.calls[0]!.url).toBe("http://127.0.0.1:4555/w/rest.php/v1/page/Benzol/html");
    await expect(h.client.media("http://127.0.0.1:9/x.png")).rejects.toMatchObject({ reason: "blocked_host" });
  });
});
