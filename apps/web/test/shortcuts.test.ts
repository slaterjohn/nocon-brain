import { describe, expect, it } from "vitest";
import { BROWSER_RESERVED, SHORTCUTS, isTypingTarget, matchShortcut, spelled, type KeyLike } from "../lib/shortcuts";

const ev = (o: Partial<KeyLike>): KeyLike => ({ key: "", code: "", altKey: false, shiftKey: false, ctrlKey: false, metaKey: false, ...o });

describe("A-19 shortcut map", () => {
  it("contains no combination the browser keeps", () => {
    const reserved = new Set(BROWSER_RESERVED.map((s) => s.toLowerCase()));
    for (const d of SHORTCUTS) for (const s of spelled(d)) expect(reserved.has(s.toLowerCase()), `${d.id}: ${s}`).toBe(false);
  });

  it("never uses Ctrl or Cmd, and every app shortcut needs Alt and Shift", () => {
    for (const d of SHORTCUTS) {
      expect(d.keys).not.toMatch(/Ctrl|Cmd|Meta/i);
      if (d.code) expect(d.keys).toContain("Alt+Shift+");
    }
    expect(matchShortcut(ev({ ctrlKey: true, altKey: true, shiftKey: true, code: "KeyN" }))).toBeNull();
    expect(matchShortcut(ev({ metaKey: true, key: "/" }))).toBeNull();
  });

  it("has unique keys, ids and labels", () => {
    expect(new Set(SHORTCUTS.map((d) => d.id)).size).toBe(SHORTCUTS.length);
    const codes = SHORTCUTS.flatMap((d) => (d.code ? [d.code] : []));
    expect(new Set(codes).size).toBe(codes.length);
    expect(new Set(SHORTCUTS.map((d) => d.label)).size).toBe(SHORTCUTS.length);
  });

  it("matches on the physical key, so Option on a Mac works", () => {
    expect(matchShortcut(ev({ altKey: true, shiftKey: true, code: "KeyN", key: "˜" }))).toEqual({ id: "newTab" });
    expect(matchShortcut(ev({ altKey: true, shiftKey: true, code: "Digit3", key: "£" }))).toEqual({ id: "tab1", tab: 3 });
    expect(matchShortcut(ev({ altKey: true, code: "KeyN" }))).toBeNull();
    expect(matchShortcut(ev({ altKey: true, shiftKey: true, code: "KeyZ" }))).toBeNull();
  });

  it("single keys work outside text fields only, and can be switched off", () => {
    expect(matchShortcut(ev({ key: "/", target: { tagName: "BODY" } }))).toEqual({ id: "focusAddress" });
    expect(matchShortcut(ev({ key: "?", target: { tagName: "DIV" } }))).toEqual({ id: "help" });
    expect(matchShortcut(ev({ key: "/", target: { tagName: "INPUT", type: "text" } }))).toBeNull();
    expect(matchShortcut(ev({ key: "/", target: { tagName: "TEXTAREA" } }))).toBeNull();
    expect(matchShortcut(ev({ key: "/", target: { tagName: "DIV", isContentEditable: true } }))).toBeNull();
    expect(matchShortcut(ev({ key: "/", target: { tagName: "INPUT", type: "checkbox" } }))).toEqual({ id: "focusAddress" });
    expect(matchShortcut(ev({ key: "/", target: { tagName: "BODY" } }), false)).toBeNull();
    // The Alt+Shift forms still work with single keys off.
    expect(matchShortcut(ev({ altKey: true, shiftKey: true, code: "KeyH" }), false)).toEqual({ id: "help" });
    expect(isTypingTarget(null)).toBe(false);
  });
});
