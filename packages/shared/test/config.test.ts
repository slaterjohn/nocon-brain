import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/index.js";

describe("loadConfig", () => {
  it("applies defaults", () => {
    const c = loadConfig({}, "x64");
    expect(c.NCB_API_PORT).toBe(3001);
    expect(c.NCB_VOLUMES_ALLOWED_ROOTS).toEqual(["/volumes"]);
    expect(c.NCB_COOKIE_SECURE).toBe(false);
    expect(c.resourceProfile).toBe("standard");
  });

  it("picks pi-lite on arm64 unless overridden", () => {
    expect(loadConfig({}, "arm64").resourceProfile).toBe("pi-lite");
    expect(loadConfig({ NCB_RESOURCE_PROFILE: "standard" }, "arm64").resourceProfile).toBe("standard");
  });

  it("parses numbers, booleans and lists from strings", () => {
    const c = loadConfig({ NCB_API_PORT: "4000", NCB_COOKIE_SECURE: "true", NCB_VOLUMES_ALLOWED_ROOTS: "/a, /b" });
    expect(c.NCB_API_PORT).toBe(4000);
    expect(c.NCB_COOKIE_SECURE).toBe(true);
    expect(c.NCB_VOLUMES_ALLOWED_ROOTS).toEqual(["/a", "/b"]);
  });

  it("names the variable in every error", () => {
    try {
      loadConfig({ NCB_API_PORT: "abc", NCB_APP_URL: "not a url", NCB_LOG_LEVEL: "loud" });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      const vars = (e as ConfigError).issues.map((i) => i.variable).sort();
      expect(vars).toEqual(["NCB_API_PORT", "NCB_APP_URL", "NCB_LOG_LEVEL"]);
      expect((e as Error).message).toContain("NCB_API_PORT");
    }
  });

  it("rejects out-of-range ports", () => {
    expect(() => loadConfig({ NCB_WEB_PORT: "70000" })).toThrow(/NCB_WEB_PORT/);
  });

  it("requires a proxy secret in production", () => {
    expect(() => loadConfig({ NODE_ENV: "production" })).toThrow(/NCB_PROXY_SECRET/);
    expect(loadConfig({ NODE_ENV: "production", NCB_PROXY_SECRET: "x".repeat(32) }).NCB_PROXY_SECRET).toBeDefined();
  });
});
