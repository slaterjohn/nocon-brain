import { afterAll, beforeAll, describe } from "vitest";
import { ADAPTERS } from "@ncb/server";
import { startFixtures } from "../fixtures/sites/index.mjs";
import { defineConformance, type Mode, type Target } from "./suite.js";

// The three shipped adapters run against the fixture providers (tests/fixtures/sites/providers.mjs). A new adapter adds one entry here.
let fx: Awaited<ReturnType<typeof startFixtures>>;
beforeAll(async () => { fx = await startFixtures(); });
afterAll(async () => { await fx?.close(); });

function target(kind: "searxng" | "brave" | "mojeek", apiKey: string | undefined, storage: Target["storage"]): () => Target {
  return () => {
    const base = fx.urls[kind] as string;
    return {
      name: kind, adapter: ADAPTERS[kind], baseUrl: base, apiKey, query: "astronomy", storage,
      async setMode(mode: Mode, o) {
        const q = new URLSearchParams({ mode, ...(o?.retryAfter ? { retryAfter: String(o.retryAfter) } : {}) });
        await fetch(`${base}/__control?${q}`);
      },
    };
  };
}

describe("searxng", () => defineConformance(target("searxng", undefined, "unrestricted")));
describe("brave", () => defineConformance(target("brave", "fixture-brave-token", "none")));
describe("mojeek", () => defineConformance(target("mojeek", "fixture-mojeek-key", "ttl")));
