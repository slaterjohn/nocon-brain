/** Path matching for scope rules. Pure, no dependencies. */

const GLOB_CHARS = /[*?[{]/;

export function isGlob(pattern: string): boolean {
  return GLOB_CHARS.test(pattern);
}

const escapeRe = (c: string) => c.replace(/[.+^${}()|[\]\\/]/g, "\\$&");

/**
 * Compiles a path glob to an anchored regular expression.
 * `*` is any run inside one segment, `**` crosses segments, `?` is one character, `[abc]`/`[a-z]`/`[!a]` a class,
 * `{a,b}` alternatives. A trailing `/**` also matches the directory itself. A pattern without a leading `/` matches at
 * any depth (`*.pdf` is `**` + `/*.pdf`).
 */
export function globToRegExp(pattern: string): RegExp {
  let p = pattern.trim();
  if (!p.startsWith("/")) p = "/**/" + p;
  let out = "";
  let braces = 0;
  for (let i = 0; i < p.length; i++) {
    const c = p[i]!;
    if (c === "*") {
      if (p[i + 1] === "*") {
        // `**/` = any number of whole segments (including none); a trailing `/**` = the directory and everything below it.
        if (p[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 2;
        } else {
          if (out.endsWith("\\/")) {
            out = out.slice(0, -2);
            out += i + 2 >= p.length ? "(?:/.*)?" : "/.*";
          } else out += ".*";
          i += 1;
        }
      } else out += "[^/]*";
    } else if (c === "?") out += "[^/]";
    else if (c === "[") {
      const end = p.indexOf("]", i + 2);
      if (end < 0) out += "\\[";
      else {
        let body = p.slice(i + 1, end);
        if (body.startsWith("!")) body = "^" + body.slice(1);
        out += `[${body.replace(/\\/g, "\\\\")}]`;
        i = end;
      }
    } else if (c === "{") {
      braces++;
      out += "(?:";
    } else if (c === "}" && braces > 0) {
      braces--;
      out += ")";
    } else if (c === "," && braces > 0) out += "|";
    else out += escapeRe(c);
  }
  while (braces-- > 0) out += ")";
  return new RegExp(`^${out}$`);
}

const cache = new Map<string, RegExp>();
function compiled(pattern: string): RegExp {
  let r = cache.get(pattern);
  if (!r) {
    r = globToRegExp(pattern);
    if (cache.size > 500) cache.clear();
    cache.set(pattern, r);
  }
  return r;
}

const trimSlash = (s: string) => (s.length > 1 && s.endsWith("/") ? s.replace(/\/+$/, "") || "/" : s);

/**
 * True when `pathname` matches `pattern`. A pattern with no glob characters is a prefix at a segment boundary:
 * `/docs` matches `/docs`, `/docs/` and `/docs/a`, not `/docsx`. Globs match the whole path; a trailing slash on the
 * path is ignored.
 */
export function pathMatches(pattern: string, pathname: string): boolean {
  const path = pathname || "/";
  if (!isGlob(pattern)) {
    let prefix = pattern.trim();
    if (!prefix.startsWith("/")) prefix = "/" + prefix;
    prefix = trimSlash(prefix);
    if (prefix === "/") return true;
    const p = trimSlash(path);
    return p === prefix || p.startsWith(prefix + "/");
  }
  const re = compiled(pattern);
  return re.test(path) || re.test(trimSlash(path)) || (!path.endsWith("/") && re.test(path + "/"));
}

export function anyPathMatches(patterns: readonly string[], pathname: string): boolean {
  return patterns.some((p) => pathMatches(p, pathname));
}
