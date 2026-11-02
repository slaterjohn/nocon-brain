/**
 * A small, strict-enough XML reader for sitemaps and feeds. It builds an element tree and nothing else:
 * no DTD processing, no external entities, no entity definitions (so no entity-expansion attacks). The five
 * predefined entities and numeric references are decoded; any other `&name;` is left as written.
 * Element depth and node count are capped so hostile input cannot exhaust memory.
 */
export interface XmlElement {
  /** Qualified name as written, e.g. `dc:creator`. */
  name: string;
  /** Name without a namespace prefix, lower-cased. */
  local: string;
  attrs: Record<string, string>;
  children: XmlElement[];
  text: string;
}

export class XmlError extends Error {}

const MAX_DEPTH = 64;
const MAX_NODES = 1_000_000;

function decode(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (m, e: string) => {
    switch (e) {
      case "amp": return "&";
      case "lt": return "<";
      case "gt": return ">";
      case "quot": return '"';
      case "apos": return "'";
      default: {
        const code = e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : m;
      }
    }
  });
}

const localOf = (n: string): string => {
  const i = n.indexOf(":");
  return (i >= 0 ? n.slice(i + 1) : n).toLowerCase();
};

function parseAttrs(src: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  for (let m = re.exec(src); m; m = re.exec(src)) attrs[m[1]!] = decode(m[2] ?? m[3] ?? "");
  return attrs;
}

export function parseXml(input: string): XmlElement {
  let s = input;
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  const root: XmlElement = { name: "#document", local: "#document", attrs: {}, children: [], text: "" };
  const stack: XmlElement[] = [root];
  let i = 0;
  let nodes = 0;
  while (i < s.length) {
    const lt = s.indexOf("<", i);
    const cur = stack[stack.length - 1]!;
    if (lt < 0) {
      cur.text += decode(s.slice(i));
      break;
    }
    if (lt > i) cur.text += decode(s.slice(i, lt));
    if (s.startsWith("<!--", lt)) {
      const end = s.indexOf("-->", lt + 4);
      if (end < 0) throw new XmlError("Unterminated comment");
      i = end + 3;
    } else if (s.startsWith("<![CDATA[", lt)) {
      const end = s.indexOf("]]>", lt + 9);
      if (end < 0) throw new XmlError("Unterminated CDATA section");
      cur.text += s.slice(lt + 9, end);
      i = end + 3;
    } else if (s.startsWith("<?", lt)) {
      const end = s.indexOf("?>", lt + 2);
      if (end < 0) throw new XmlError("Unterminated processing instruction");
      i = end + 2;
    } else if (s.startsWith("<!", lt)) {
      // DOCTYPE and friends are skipped without being interpreted. An internal subset ([...]) is skipped as a whole.
      let j = lt + 2;
      let bracket = 0;
      for (; j < s.length; j++) {
        const ch = s[j];
        if (ch === "[") bracket++;
        else if (ch === "]") bracket--;
        else if (ch === ">" && bracket <= 0) break;
      }
      if (j >= s.length) throw new XmlError("Unterminated declaration");
      i = j + 1;
    } else if (s[lt + 1] === "/") {
      const end = s.indexOf(">", lt + 2);
      if (end < 0) throw new XmlError("Unterminated closing tag");
      const name = s.slice(lt + 2, end).trim();
      if (stack.length < 2 || stack[stack.length - 1]!.name !== name) throw new XmlError(`Unexpected closing tag </${name}>`);
      stack.pop();
      i = end + 1;
    } else {
      // Opening tag. Find the closing `>` outside quotes.
      let j = lt + 1;
      let quote = "";
      for (; j < s.length; j++) {
        const ch = s[j]!;
        if (quote) {
          if (ch === quote) quote = "";
        } else if (ch === '"' || ch === "'") quote = ch;
        else if (ch === ">") break;
      }
      if (j >= s.length) throw new XmlError("Unterminated tag");
      let inner = s.slice(lt + 1, j);
      const selfClosing = inner.endsWith("/");
      if (selfClosing) inner = inner.slice(0, -1);
      const sp = inner.search(/\s/);
      const name = (sp < 0 ? inner : inner.slice(0, sp)).trim();
      if (!name) throw new XmlError("Empty tag name");
      if (++nodes > MAX_NODES) throw new XmlError("The document has too many elements");
      const el: XmlElement = { name, local: localOf(name), attrs: sp < 0 ? {} : parseAttrs(inner.slice(sp)), children: [], text: "" };
      cur.children.push(el);
      if (!selfClosing) {
        if (stack.length > MAX_DEPTH) throw new XmlError("The document is nested too deeply");
        stack.push(el);
      }
      i = j + 1;
    }
  }
  if (stack.length !== 1) throw new XmlError(`Unclosed tag <${stack[stack.length - 1]!.name}>`);
  const top = root.children[0];
  if (!top) throw new XmlError("The document is empty");
  return top;
}

export const child = (el: XmlElement, local: string): XmlElement | undefined => el.children.find((c) => c.local === local);
export const childrenOf = (el: XmlElement, local: string): XmlElement[] => el.children.filter((c) => c.local === local);
export const textOf = (el: XmlElement | undefined): string => (el ? el.text.trim() : "");
