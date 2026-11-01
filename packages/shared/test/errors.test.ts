import { describe, expect, it } from "vitest";
import { AppError, ERROR_CODES, ERROR_STATUS, toApiError } from "../src/index.js";

describe("errors", () => {
  it("has a status for every code", () => {
    for (const c of ERROR_CODES) expect(ERROR_STATUS[c]).toBeGreaterThanOrEqual(400);
  });

  it("serialises AppError without a stack", () => {
    const { status, body } = toApiError(new AppError("conflict", "Already exists.", { field: "name" }), "req_1");
    expect(status).toBe(409);
    expect(body).toEqual({ error: "conflict", message: "Already exists.", details: { field: "name" }, requestId: "req_1" });
  });

  it("hides unknown errors", () => {
    const { status, body } = toApiError(new Error("secret internals at /srv/x"), "req_2");
    expect(status).toBe(500);
    expect(body.error).toBe("internal");
    expect(JSON.stringify(body)).not.toContain("secret internals");
  });
});
