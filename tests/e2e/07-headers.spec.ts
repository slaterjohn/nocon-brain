import { expect, test } from "@playwright/test";

test("the app sends strict security headers", async ({ request }) => {
  const r = await request.get("/login");
  const csp = r.headers()["content-security-policy"]!;
  expect(csp).toContain("default-src 'self'");
  expect(csp).toContain("connect-src 'self'");
  expect(csp).toContain("frame-ancestors 'none'");
  // The only address in the policy is the archive listener, and only as a frame source (A-14).
  const withAddresses = csp.split(";").map((d) => d.trim()).filter((d) => /https?:\/\//.test(d));
  expect(withAddresses).toEqual([`frame-src 'self' ${process.env.E2E_ARCHIVE_URL ?? "http://127.0.0.1:25002"}`]);
  expect(r.headers()["x-content-type-options"]).toBe("nosniff");
  expect(r.headers()["x-frame-options"]).toBe("DENY");
});
