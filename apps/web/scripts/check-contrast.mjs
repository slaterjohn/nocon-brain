#!/usr/bin/env node
/**
 * Checks the design-token colour pairs against WCAG 2.2 AA (F-17).
 * Reads app/tokens.css, so the CSS stays the single source of truth.
 * Text pairs need 4.5:1; UI-component pairs (borders of inputs, focus ring) need 3:1.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "../app/tokens.css");
const css = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

function block(selector) {
  const m = css.match(new RegExp(`${selector.replace(".", "\\.")}\\s*\\{([^}]*)\\}`));
  if (!m) throw new Error(`No ${selector} block in tokens.css`);
  const out = {};
  for (const [, k, v] of m[1].matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) out[k] = v.trim();
  return out;
}

const themes = { light: block(":root"), dark: { ...block(":root"), ...block(".dark") } };

const TEXT = 4.5;
const UI = 3;
// [foreground token, background token, minimum ratio, what it is]
const PAIRS = [
  ["foreground", "background", TEXT, "body text"],
  ["foreground", "sidebar", TEXT, "text on sidebar"],
  ["foreground", "chrome", TEXT, "text on browser chrome"],
  ["card-foreground", "card", TEXT, "text on cards"],
  ["popover-foreground", "popover", TEXT, "text in menus and popovers"],
  ["primary-foreground", "primary", TEXT, "primary button text"],
  ["secondary-foreground", "secondary", TEXT, "secondary button text"],
  ["accent-foreground", "accent", TEXT, "text on hover and selected rows"],
  ["muted-foreground", "background", TEXT, "muted text on page"],
  ["muted-foreground", "card", TEXT, "muted text on cards"],
  ["muted-foreground", "muted", TEXT, "muted text on muted surfaces"],
  ["muted-foreground", "sidebar", TEXT, "muted text on sidebar"],
  ["muted-foreground", "chrome", TEXT, "muted text on browser chrome"],
  ["muted-foreground", "accent", TEXT, "muted text on hover rows"],
  ["primary", "background", TEXT, "links and primary text on page"],
  ["primary", "card", TEXT, "links on cards"],
  ["primary", "sidebar", TEXT, "links on sidebar"],
  ["destructive", "background", TEXT, "error text on page"],
  ["destructive", "card", TEXT, "error text on cards"],
  ["destructive-foreground", "destructive", TEXT, "destructive button text"],
  ["success", "background", TEXT, "success text on page"],
  ["success", "card", TEXT, "success text on cards"],
  ["warning", "background", TEXT, "warning text on page"],
  ["warning", "card", TEXT, "warning text on cards"],
  ["input", "background", UI, "input border on page"],
  ["input", "card", UI, "input border on cards"],
  ["input", "chrome", UI, "address bar border on browser chrome"],
  ["ring", "background", UI, "focus ring on page"],
  ["ring", "card", UI, "focus ring on cards"],
  ["ring", "sidebar", UI, "focus ring on sidebar"],
  ["ring", "chrome", UI, "focus ring on browser chrome"],
  ["primary", "background", UI, "primary button boundary on page"],
];

function parseHex(hex) {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? [...h].map((c) => c + c).join("") : h;
  if (!/^[0-9a-f]{6}$/i.test(full)) throw new Error(`Unsupported colour "${hex}" (use #rrggbb)`);
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255);
}
const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const luminance = (hex) => {
  const [r, g, b] = parseHex(hex).map(lin);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

let failed = 0;
for (const [name, tokens] of Object.entries(themes)) {
  console.log(`\n${name} theme`);
  for (const [fg, bg, min, label] of PAIRS) {
    if (!tokens[fg] || !tokens[bg]) throw new Error(`Missing token in ${name}: ${fg} or ${bg}`);
    const r = ratio(tokens[fg], tokens[bg]);
    const ok = r >= min;
    if (!ok) failed++;
    console.log(`  ${ok ? "pass" : "FAIL"}  ${r.toFixed(2).padStart(5)}:1 (needs ${min})  ${fg} on ${bg}  ${label}`);
  }
}
if (failed) {
  console.error(`\n${failed} token pair(s) below WCAG 2.2 AA.`);
  process.exit(1);
}
console.log("\nAll token pairs meet WCAG 2.2 AA.");
