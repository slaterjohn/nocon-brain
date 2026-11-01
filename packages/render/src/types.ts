/** Link states shown to the Human (docs/api.md section 5). They drive `data-ncb-link` and the CSS legend. */
export type LinkState = "cached" | "partial" | "queued" | "live-only" | "unavailable" | "unsupported";

export const LINK_STATES: readonly LinkState[] = ["cached", "partial", "queued", "live-only", "unavailable", "unsupported"];

/** What a sub-resource is used for. The resolver can pick a different asset or refuse by kind. */
export type ResourceKind = "image" | "css" | "font" | "media" | "icon" | "other";

export interface LinkResolution {
  /** The archive-listener URL to put in `href` (absolute path, fragment already appended). */
  href: string;
  state: LinkState;
}

/**
 * Callbacks that tie the pure rewriter to an archive. Both receive an absolute `http(s)` URL (fragment
 * included for links). Returning `null` means "not available": the sub-resource is dropped (or replaced
 * with a placeholder) and the link loses its `href`. Without callbacks nothing external survives.
 */
export interface RewriteCallbacks {
  resource?: (absUrl: string, kind: ResourceKind) => string | null;
  link?: (absUrl: string) => LinkResolution | null;
}

export interface SanitizeStats {
  /** Elements removed with their content. */
  removedElements: number;
  removedAttributes: number;
  /** Sub-resource references with no archived copy (dropped or placeholdered). */
  missingResources: number;
  rewrittenLinks: number;
}
