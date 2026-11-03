// Manual check of the Wikipedia client against the real Wikipedia (docs/api.md section 15.2, task Z-07). Not part of the test suites: it needs the
// internet and makes TWO requests in all, one second apart, with the User-Agent policy applied.
//   NCB_CONTACT=https://github.com/slaterjohn/nocon-brain node --import tsx scripts/manual-wikipedia-check.ts [Title] [lang]
// NCB_CONTACT must be a web address or an email address that reaches the person running NoConBrain. It is required; the script refuses without one.
import { VERSION, WikipediaClient, extractWikiImages, extractWikiLinks, parsoidMeta } from "@ncb/server";

const contact = process.env.NCB_CONTACT;
if (!contact) {
  console.error("Set NCB_CONTACT to a web address or email address, for example https://github.com/slaterjohn/nocon-brain");
  process.exit(2);
}
const title = process.argv[2] ?? "Ethylbenzene";
const lang = process.argv[3] ?? "en";

const client = new WikipediaClient({ contact, version: VERSION });
console.log("user agent:", client.userAgent);

const t0 = Date.now();
const page = await client.pageHtml(lang, title);
console.log(`request 1: GET /w/rest.php/v1/page/${title}/html in ${Date.now() - t0} ms`);
if (page.kind !== "ok") {
  console.log("result:", page.kind);
  process.exit(1);
}
const html = page.body.toString("utf8");
const links = extractWikiLinks(html);
const images = extractWikiImages(html);
console.log(JSON.stringify({
  bytes: page.bytes, etag: page.etag, lastModified: page.lastModified, revisionId: page.revisionId, contentLanguage: page.contentLanguage, redirectedFrom: page.redirectedFrom ?? null,
  licence: page.licence, articleUrl: page.articleUrl, historyUrl: page.historyUrl, parsoid: parsoidMeta(html),
  wikiLinks: links.length, leadLinks: links.filter((l) => l.lead).length, firstLinks: links.slice(0, 5).map((l) => l.title), images: images.length,
}, null, 2));

if (images[0]) {
  const t1 = Date.now();
  const info = await client.imageInfo(lang, [images[0].file]);
  console.log(`request 2: Action API imageinfo (maxlag=5) for ${images[0].file} in ${Date.now() - t1} ms`);
  console.log(JSON.stringify([...info.entries()], null, 2));
} else console.log("request 2: skipped, the article has no images with a file page");
console.log("client state:", JSON.stringify(client.state()));
