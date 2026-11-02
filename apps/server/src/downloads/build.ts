import type { CrawlConfig } from "@ncb/crawl";
import type { PriorityNumber } from "@ncb/shared";
import { z } from "zod";
import { parseOrThrow } from "../lib/zod.js";
import { toCrawlConfig } from "../sources/crawl-port.js";
import { configInputSchema, resolveConfig } from "../sources/schema.js";

const body = configInputSchema.extend({ profile: z.enum(["focused", "balanced", "comprehensive", "custom"]).optional() });

/**
 * The crawl config for a download made from a URL with no source behind it (`POST /api/downloads` with `kind: "explore"`
 * or `"mirror"`). `config` takes the same fields as a source's config plus an optional `profile`.
 */
export function crawlConfigForDownload(
  a: { url: string; mode: "explore" | "mirror"; priority: PriorityNumber; config: unknown }, resource: "pi-lite" | "standard",
): CrawlConfig {
  const { profile, ...rest } = parseOrThrow(body, a.config ?? {}, "body", "config");
  const config = resolveConfig(rest, "website", profile ?? "focused", resource, a.url);
  return toCrawlConfig({ mode: a.mode, seeds: [a.url], priority: a.priority, requestedBy: "user", config }, resource);
}
