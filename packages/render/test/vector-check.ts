import { parse } from "parse5";

/** An independent check of sanitiser output (does not share code with the sanitiser). Returns the problems found. */
export function problemsIn(out: string): string[] {
  const problems: string[] = [];
  if (/<script/i.test(out)) problems.push("raw <script");
  if (/<\/style\s*>[\s\S]*<\/style/i.test(out) === false && /<style[^>]*>[^]*?<(?!\/style)/i.test(out)) {
    // a `<` inside style text other than the closing tag
    const m = /<style[^>]*>([^]*?)<\/style>/gi;
    let x: RegExpExecArray | null;
    while ((x = m.exec(out))) if (x[1]!.includes("<")) problems.push("'<' inside style text");
  }
  const doc = parse(out, { scriptingEnabled: false });
  const ALLOWED_URL = /^(\/|#|data:image\/(png|jpe?g|gif|webp|avif|bmp|x-icon|vnd\.microsoft\.icon);base64,[A-Za-z0-9+/=]*$)/i;
  const BAD_TAGS = new Set(["script", "iframe", "frame", "frameset", "object", "embed", "applet", "base", "template", "noscript", "xmp", "plaintext", "math", "foreignobject", "animate", "set", "animatetransform", "animatemotion", "handler", "discard", "listener", "bgsound", "dialog", "portal", "fencedframe", "isindex", "keygen", "noembed", "noframes"]);
  const URLISH = new Set(["href", "src", "srcset", "poster", "action", "formaction", "data", "codebase", "cite", "background", "longdesc", "manifest", "ping", "xlink:href", "dynsrc", "lowsrc", "icon", "profile", "usemap"]);
  const walk = (n: any) => {
    for (const c of n.childNodes ?? []) {
      if (c.nodeName === "#comment") problems.push("comment");
      if (c.nodeName === "#documentType" || c.nodeName.startsWith("#")) continue;
      const tag = String(c.tagName).toLowerCase();
      if (BAD_TAGS.has(tag)) problems.push(`tag ${tag}`);
      if (tag === "meta" && c.attrs.some((a: any) => a.name === "http-equiv")) problems.push("meta http-equiv");
      if (c.namespaceURI !== "http://www.w3.org/1999/xhtml" && c.namespaceURI !== "http://www.w3.org/2000/svg") problems.push(`ns ${tag}`);
      if (c.namespaceURI === "http://www.w3.org/2000/svg" && tag === "style") problems.push("svg style");
      for (const a of c.attrs) {
        const name = (a.prefix ? `${a.prefix}:${a.name}` : a.name).toLowerCase();
        const v: string = a.value;
        const squashed = v.replace(/[\u0000- ]/g, "").toLowerCase();
        if (name.startsWith("on")) problems.push(`handler ${name}`);
        if (name === "srcdoc") problems.push("srcdoc");
        if (/^(javascript|vbscript|livescript|data:text|data:application|data:image\/svg)/.test(squashed)) problems.push(`scheme in ${name}`);
        if (name === "target" && /^_(top|parent)/i.test(v)) problems.push("target top");
        if (URLISH.has(name)) {
          const parts = name === "srcset" ? v.split(",").map((s) => s.trim().split(/\s+/)[0]!) : [v.trim()];
          for (const p of parts) if (p && !ALLOWED_URL.test(p)) problems.push(`non-archive url in ${name}: ${p.slice(0, 40)}`);
        }
        if (name === "style" || (c.namespaceURI === "http://www.w3.org/2000/svg" && /url\(/i.test(v))) {
          if (/expression|behaviou?r|binding|javascript|@import/i.test(v)) problems.push(`css vector in ${name}`);
          for (const m of v.matchAll(/url\(\s*['"]?([^'")]*)/gi)) if (!ALLOWED_URL.test(m[1]!.trim())) problems.push(`css url ${m[1]!.slice(0, 40)}`);
        }
        if (name.startsWith("data-") && /[a-z][a-z0-9+.-]*:|\/\//i.test(v)) problems.push("data attr url");
      }
      if (tag === "style") {
        const text = (c.childNodes ?? []).map((t: any) => t.value ?? "").join("");
        if (/expression|behaviou?r\s*:|-moz-binding|javascript:|@import|@namespace/i.test(text)) problems.push("css vector in style element");
        for (const m of text.matchAll(/url\(\s*['"]?([^'")]*)/gi)) if (!ALLOWED_URL.test(m[1]!.trim())) problems.push(`css url ${m[1]!.slice(0, 40)}`);
        if (/image-set|src\(|image\(|element\(|paint\(|cross-fade/i.test(text)) problems.push("blocked css function");
      }
      walk(c);
    }
  };
  walk(doc);
  return problems;
}
