/**
 * Search snippets from a ZIM are HTML written by someone else (task Z-05). libzim escapes text and wraps matches in `<b>`, but a snippet
 * is shown with `innerHTML`, so nothing is trusted: only `<b>` and `</b>` with no attributes survive. Every other tag is removed (the text
 * inside stays, except `<script>` and `<style>`, whose content goes too), stray `<`, `>` and bare `&` are escaped, and `<b>` is balanced.
 */
export function sanitiseSnippet(html: string, maxChars = 400): string {
  let src = String(html ?? "");
  src = src.replace(/<(script|style|iframe|object|embed|noscript|template)\b[\s\S]*?<\/\1\s*>/gi, " ");
  src = src.replace(/<(script|style|iframe|object|embed|noscript|template)\b[\s\S]*$/gi, " "); // unclosed
  src = src.replace(/<!--[\s\S]*?-->/g, " ");
  const out: string[] = [];
  let open = 0;
  let text = 0;
  const re = /<\/?[a-zA-Z!?][^>]*>?|[<>]|&(?![a-zA-Z][a-zA-Z0-9]{1,31};|#\d{1,7};|#[xX][0-9a-fA-F]{1,6};)|[^<>&]+|&[^<>&]*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const tok = m[0];
    if (text >= maxChars && open === 0) break;
    if (tok === "<b>" || tok === "<B>") { open++; out.push("<b>"); continue; }
    if (tok === "</b>" || tok === "</B>") { if (open > 0) { open--; out.push("</b>"); } continue; }
    if (tok.startsWith("<") && tok.length > 1) continue; // any other tag is dropped
    if (tok === "<") { out.push("&lt;"); text++; continue; }
    if (tok === ">") { out.push("&gt;"); text++; continue; }
    if (tok === "&") { out.push("&amp;"); text++; continue; }
    const chunk = text + tok.length > maxChars ? tok.slice(0, maxChars - text) : tok;
    out.push(chunk.replace(/"/g, "&quot;").replace(/'/g, "&#39;"));
    text += chunk.length;
  }
  while (open-- > 0) out.push("</b>");
  return out.join("").replace(/\s+/g, " ").trim();
}

/** Plain text for a title: tags stripped, entities escaped, nothing else allowed. */
export function escapeText(t: string): string {
  return String(t ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** A title with the query's words wrapped in `<b>`, built from escaped text, so it is safe to show as HTML. */
export function highlightTitle(title: string, terms: string[]): string {
  const esc = escapeText(title);
  const words = [...new Set(terms.map((t) => t.toLowerCase()).filter((t) => t.length > 1))].map((t) => escapeText(t).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!words.length) return esc;
  return esc.replace(new RegExp(`(${words.join("|")})`, "gi"), "<b>$1</b>");
}
