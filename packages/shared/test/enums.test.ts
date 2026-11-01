import { describe, expect, it } from "vitest";
import { PRIORITY_NAMES, Priority, parsePriority, priorityToCode } from "../src/index.js";

describe("priority", () => {
  it("uses P1 Protected to P4 Opportunistic, lower is more important", () => {
    expect(PRIORITY_NAMES).toEqual({ 1: "Protected", 2: "Important", 3: "Standard", 4: "Opportunistic" });
    expect(Priority.Protected).toBe(1);
    expect(priorityToCode(4)).toBe("P4");
  });

  it("parses numbers and API codes", () => {
    expect(parsePriority("P2")).toBe(2);
    expect(parsePriority(3)).toBe(3);
    for (const bad of ["P0", "P5", 0, 5, "2", null, undefined, 1.5]) expect(parsePriority(bad)).toBeUndefined();
  });
});
