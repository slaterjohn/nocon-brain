import { expect, test } from "@playwright/test";

test("the app sends strict security headers", async ({ request }) => {
  const r = await request.get("/login");
  const csp = r.headers()["content-security-policy"]!;
  expect(csp).toContain("default-src 'self'");
  expect(csp).toContain("connect-src 'self'");
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).not.toMatch(/https?:\/\//);
  expect(r.headers()["x-content-type-options"]).toBe("nosniff");
  expect(r.headers()["x-frame-options"]).toBe("DENY");
});
