import { describe, expect, it } from "vitest";
import { editDistance, escapeHtml, hamming, MARK_CLOSE, MARK_OPEN, sanitiseMarked, simhash, tokenize } from "../src/text.js";

describe("S-09 sanitiser", () => {
  it("escapes everything except our marks", () => {
    const raw = `${MARK_OPEN}a${MARK_CLOSE} <script>alert("x")</script> <img src=x onerror=alert(1)> & 'q'`;
    const out = sanitiseMarked(raw);
    expect(out).toBe("<mark>a</mark> &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &lt;img src=x onerror=alert(1)&gt; &amp; &#39;q&#39;");
    expect(out.replace(/<\/?mark>/g, "")).not.toMatch(/[<>]/);
  });
  it("closes a mark left open and drops stray closers", () => {
    expect(sanitiseMarked(`${MARK_OPEN}open`)).toBe("<mark>open</mark>");
    expect(sanitiseMarked(`x${MARK_CLOSE}y`)).toBe("xy");
  });
  it("escapeHtml removes marker characters", () => {
    expect(escapeHtml(`${MARK_OPEN}<b>`)).toBe("&lt;b&gt;");
  });
});

describe("helpers", () => {
  it("folds accents and case", () => expect(tokenize("Café Zürich-2026")).toEqual(["cafe", "zurich", "2026"]));
  it("edit distance with transposition", () => {
    expect(editDistance("astronamy", "astronomy", 2)).toBe(1);
    expect(editDistance("plenets", "planets", 1)).toBe(1);
    expect(editDistance("teh", "the", 1)).toBe(1);
    expect(editDistance("abcdef", "uvwxyz", 2)).toBe(3);
  });
  it("simhash: near-identical texts are close, different texts far", () => {
    const a = Array.from({ length: 300 }, (_, i) => `word${i % 97} alpha${i % 31}`).join(" ");
    const b = a.replace("word5 ", "other ");
    const c = Array.from({ length: 300 }, (_, i) => `zeta${i % 89} beta${i % 53}`).join(" ");
    expect(hamming(simhash(a), simhash(a))).toBe(0);
    expect(hamming(simhash(a), simhash(b))).toBeLessThanOrEqual(6);
    expect(hamming(simhash(a), simhash(c))).toBeGreaterThan(12);
  });
});
