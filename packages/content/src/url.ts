import { getDomain } from "tldts";

/** Resolves `href` against `base`. Returns an absolute http(s) URL without fragment, or null. */
export function resolveHttpUrl(href: string, base: string): string | null {
  const t = href.trim();
  if (!t || /^(javascript|data|mailto|tel|blob|about|file|sms|ftp):/i.test(t)) return null;
  try {
    const u = new URL(t, base);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    u.hash = "";
    return u.href;
  } catch {
    return null;
  }
}

/** The registrable domain (eTLD+1) of a host; IPs, localhost and unknown suffixes are returned as they are. */
export function registrableDomain(host: string): string {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  return getDomain(h) ?? h;
}

export function hostOf(url: string): string {
  return new URL(url).hostname.toLowerCase();
}
