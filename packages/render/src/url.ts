/** A 1x1 transparent GIF, used where an image was not archived. Matches the CSP `img-src data:`. */
export const TRANSPARENT_PIXEL = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

/** Bumped whenever rewriter output could change for the same input. Part of the resource `ETag`. */
export const REWRITER_VERSION = "r1";

export const DEFAULT_MAX_DATA_URI_BYTES = 512 * 1024;

const DATA_IMAGE = /^data:image\/(png|jpe?g|gif|webp|avif|bmp|x-icon|vnd\.microsoft\.icon);base64,([A-Za-z0-9+/]*={0,2})$/i;

/**
 * Accepts a `data:` URI only when it is a base64 raster image under the size cap. SVG data URIs are
 * refused (they can carry markup). Returns the cleaned URI or null.
 */
export function safeDataImage(raw: string, maxBytes = DEFAULT_MAX_DATA_URI_BYTES): string | null {
  const compact = raw.replace(/[\t\n\f\r ]+/g, "");
  if (compact.length > Math.ceil((maxBytes * 4) / 3) + 64) return null;
  const m = DATA_IMAGE.exec(compact);
  if (!m) return null;
  return compact;
}

/** Resolves like a browser would (the URL parser also strips tabs and newlines, defeating `java\nscript:`). */
export function resolveUrl(raw: string, base: string | URL): URL | null {
  try {
    return new URL(raw.trim(), base);
  } catch {
    return null;
  }
}

export function isHttp(u: URL): boolean {
  return u.protocol === "http:" || u.protocol === "https:";
}

/** Parses `base`, returning null when it is not an http(s) URL. */
export function parseHttpBase(base: string): URL | null {
  try {
    const u = new URL(base);
    return isHttp(u) ? u : null;
  } catch {
    return null;
  }
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
