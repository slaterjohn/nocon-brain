// The keyboard map for the browser area (A-19). Pure data and matching, so it can be unit tested without React.
//
// Rules:
// - Nothing the browser keeps for itself. Chrome, Edge, Firefox and Safari reserve Ctrl or Cmd with T, W, N, L, R, F, D, Tab and
//   the digits, Alt with the arrow keys (Back and Forward), Alt+D, F5, F6 and F11. Page scripts cannot override most of them,
//   so using them would only work some of the time. Ctrl+F (find in the page) stays native, and works inside the saved page too.
// - App shortcuts use Alt+Shift and a letter, matched on the physical key (`code`) so Option on a Mac does not type a symbol.
// - Single-key shortcuts ("/" and "?") only run outside text fields, and can be switched off (WCAG 2.1.4).

export type ShortcutId =
  | "newTab" | "closeTab" | "focusAddress" | "back" | "forward" | "reload" | "bookmark" | "save" | "reader" | "openLive"
  | "find" | "workOffline" | "help" | "tab1";

export interface ShortcutDef {
  id: ShortcutId;
  label: string;
  group: "Tabs" | "Address bar and history" | "This page" | "General";
  /** Shown to people, "Alt" is "Option" on a Mac. */
  keys: string;
  /** Alt+Shift+<code>. */
  code?: string;
  /** Plain key with no modifier, ignored inside text fields. */
  single?: string;
}

export const SHORTCUTS: readonly ShortcutDef[] = [
  { id: "newTab", label: "New tab", group: "Tabs", keys: "Alt+Shift+N", code: "KeyN" },
  { id: "closeTab", label: "Close the current tab", group: "Tabs", keys: "Alt+Shift+X", code: "KeyX" },
  { id: "tab1", label: "Go to tab 1 to 9", group: "Tabs", keys: "Alt+Shift+1 to 9" },
  { id: "focusAddress", label: "Go to the address bar", group: "Address bar and history", keys: "/ or Alt+Shift+L", code: "KeyL", single: "/" },
  { id: "back", label: "Back in this tab", group: "Address bar and history", keys: "Alt+Shift+B", code: "KeyB" },
  { id: "forward", label: "Forward in this tab", group: "Address bar and history", keys: "Alt+Shift+G", code: "KeyG" },
  { id: "reload", label: "Reload", group: "Address bar and history", keys: "Alt+Shift+E", code: "KeyE" },
  { id: "bookmark", label: "Bookmark or remove the bookmark", group: "This page", keys: "Alt+Shift+D", code: "KeyD" },
  { id: "save", label: "Save for offline", group: "This page", keys: "Alt+Shift+S", code: "KeyS" },
  { id: "reader", label: "Switch between the saved page and reader view", group: "This page", keys: "Alt+Shift+R", code: "KeyR" },
  { id: "openLive", label: "Open the live site in a new browser tab", group: "This page", keys: "Alt+Shift+U", code: "KeyU" },
  { id: "find", label: "Find in this page (the browser's own Ctrl+F or Cmd+F also works)", group: "This page", keys: "Alt+Shift+F", code: "KeyF" },
  { id: "workOffline", label: "Switch work offline on or off", group: "General", keys: "Alt+Shift+O", code: "KeyO" },
  { id: "help", label: "Show these shortcuts", group: "General", keys: "? or Alt+Shift+H", code: "KeyH", single: "?" },
];

/** Combinations browsers keep. The map above must never contain one (checked in the unit tests). */
export const BROWSER_RESERVED: readonly string[] = [
  "Ctrl+T", "Ctrl+W", "Ctrl+N", "Ctrl+L", "Ctrl+R", "Ctrl+F", "Ctrl+D", "Ctrl+H", "Ctrl+J", "Ctrl+K", "Ctrl+E", "Ctrl+P", "Ctrl+S", "Ctrl+U",
  "Ctrl+Tab", "Ctrl+Shift+T", "Ctrl+Shift+N", "Ctrl+Shift+W", "Ctrl+Shift+R", "Ctrl+Shift+B", "Ctrl+Shift+Delete",
  "Alt+ArrowLeft", "Alt+ArrowRight", "Alt+D", "Alt+F4", "Alt+Home", "Alt+E", "Alt+F", "Alt+Tab", "F1", "F3", "F5", "F6", "F11", "F12",
];

/** The reserved-key spelling of a definition, for the check against `BROWSER_RESERVED`. */
export function spelled(def: ShortcutDef): string[] {
  const out: string[] = [];
  if (def.code) out.push(`Alt+Shift+${def.code.replace(/^Key/, "").replace(/^Digit/, "")}`);
  if (def.single) out.push(def.single);
  return out;
}

export interface KeyLike {
  key: string;
  code: string;
  altKey: boolean;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  target?: unknown;
}

/** True for text fields, where a plain key is typing and never a shortcut. */
export function isTypingTarget(t: unknown): boolean {
  const el = t as { tagName?: string; isContentEditable?: boolean; type?: string } | null;
  if (!el || !el.tagName) return false;
  const tag = el.tagName.toLowerCase();
  if (tag === "textarea" || tag === "select" || el.isContentEditable) return true;
  if (tag === "input") return !["checkbox", "radio", "button", "submit", "reset"].includes((el.type ?? "text").toLowerCase());
  return false;
}

/** Which shortcut a key event is, if any. `singleKeys` is the Human's choice for the plain-key shortcuts. */
export function matchShortcut(e: KeyLike, singleKeys = true): { id: ShortcutId; tab?: number } | null {
  if (e.ctrlKey || e.metaKey) return null;
  if (e.altKey && e.shiftKey) {
    const digit = /^Digit([1-9])$/.exec(e.code);
    if (digit) return { id: "tab1", tab: Number(digit[1]) };
    for (const d of SHORTCUTS) if (d.code && d.code === e.code) return { id: d.id };
    return null;
  }
  if (e.altKey) return null;
  if (singleKeys && !isTypingTarget(e.target)) {
    for (const d of SHORTCUTS) if (d.single && d.single === e.key) return { id: d.id };
  }
  return null;
}
