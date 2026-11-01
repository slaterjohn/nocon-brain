import { sanitiseReaderHtml } from "./reader.js";

export interface OutlineSection {
  /** 0 for the introduction before the first heading, otherwise 1 to 6. */
  level: number;
  heading: string;
  /** Fragment id of the heading in the reader HTML. Empty for the introduction. */
  anchor: string;
  /** Offset of the section's text in the plain-text blob. */
  start: number;
  end: number;
  text: string;
}

export interface Outline {
  v: 1;
  sections: OutlineSection[];
}

/** Headings and sections with stable anchors (task A-08). Anchors come from the same code as the reader HTML. */
export function buildOutline(articleHtml: string, baseUrl: string): Outline {
  const r = sanitiseReaderHtml(articleHtml, baseUrl);
  const sections: OutlineSection[] = [];
  const hs = r.headings;
  const firstStart = hs.length ? hs[0]!.offset : r.text.length;
  if (firstStart > 0 && r.text.slice(0, firstStart).trim()) {
    sections.push({ level: 0, heading: "", anchor: "", start: 0, end: firstStart, text: r.text.slice(0, firstStart).trim() });
  }
  hs.forEach((h, i) => {
    const end = i + 1 < hs.length ? hs[i + 1]!.offset : r.text.length;
    const body = r.text.slice(h.offset, end).trim();
    sections.push({ level: h.level, heading: h.text, anchor: h.anchor, start: h.offset, end, text: body });
  });
  return { v: 1, sections };
}
