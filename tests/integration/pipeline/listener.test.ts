import { describe, expect, it } from "vitest";
import { capture, startPipelineServer, useFixtures } from "./helpers.js";

const fixtures = useFixtures();

describe("pipeline data served by the archive listener (SqliteCaptureStore)", () => {
  it("serves a captured article sanitised, with rewritten deduplicated assets and link states", async () => {
    const t = await startPipelineServer({ server: { archive: true } });
    const { archivePort } = await t.server.listen();
    const origin = `http://127.0.0.1:${archivePort}`;
    const tokens = t.server.archive!.tokens()!;
    const token = tokens.mint({ userId: "u1", frameId: "fr_1", appOrigin: "http://localhost:3000" });

    const base = fixtures().urls.article;
    // The article links to other articles; archive one of them so that it is "cached" and another is not.
    const stars = await capture(t, `${base}/solar-system`);
    expect(stars.outcome).toBe("created");
    const r = await capture(t, `${base}/astronomy`);
    const v = t.pipeline.getVersion(r.versionId!)!;
    const page = t.pipeline.getPage(v.pageId)!;

    const res = await fetch(`${origin}/a/${token}/p/${page.publicId}`, { redirect: "manual" });
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toBeNull();
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("sandbox");
    expect(csp).toContain("default-src 'none'");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    const html = await res.text();
    expect(html).toContain("Astronomy");
    expect(html).not.toMatch(/<script|onerror=|javascript:/i);
    expect(html).not.toContain(base); // no raw external URL survives

    // Link states: solar-system is archived, black-holes is not.
    expect(html).toMatch(/href="[^"]*\/p\/pg_[^"]*"/);
    expect(html).toContain("data-ncb-link");
    const unarchivedState = html.match(/<a[^>]*data-ncb-link="(live-only|unavailable|queued)"[^>]*>/);
    expect(unarchivedState).not.toBeNull();

    // Sub-resources: stylesheet rewritten to /v/{version}/r/{key} and served from the one stored blob.
    const css = t.pipeline.listResources(v.id).find((x) => x.url.endsWith("/assets/site.css"))!;
    expect(html).toContain(`/v/${v.publicId}/r/${css.key}`);
    const cssRes = await fetch(`${origin}/a/${token}/v/${v.publicId}/r/${css.key}`);
    expect(cssRes.status).toBe(200);
    expect(cssRes.headers.get("content-type")).toContain("text/css");
    const body = await cssRes.text();
    const stored = await t.svc.blobs.read(css.blobSha256!);
    expect(body.length).toBeGreaterThan(0);
    expect(stored.data.toString("utf8").length).toBeGreaterThan(0);
    // The same blob serves the other page that shares it.
    const other = t.pipeline.listResources(t.pipeline.getVersion(stars.versionId!)!.id).find((x) => x.url.endsWith("/assets/site.css"))!;
    expect(other.blobSha256).toBe(css.blobSha256);

    // An asset the version does not reference is a 404.
    expect((await fetch(`${origin}/a/${token}/v/${v.publicId}/r/rdeadbeef0000000`)).status).toBe(404);
    // Reader route works from the reader blob.
    const reader = await fetch(`${origin}/a/${token}/p/${page.publicId}/reader`);
    expect(reader.status).toBe(200);
    expect(await reader.text()).toContain("Overview");
    // last_accessed_at is written in batches
    await t.server.archive!.flush();
    expect(t.svc.db.get<{ a: number | null }>("SELECT last_accessed_at AS a FROM page_versions WHERE id = ?", [v.id])!.a).not.toBeNull();
    // A version that is still capturing is invisible.
    t.svc.db.run("UPDATE page_versions SET status='capturing' WHERE id = ?", [v.id]);
    expect((await fetch(`${origin}/a/${token}/v/${v.publicId}`)).status).toBe(404);
  });
});
