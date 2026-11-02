import type { Priority, SourceProfile, SourceStrategy, SourceType } from "./types";

/** Plain-English copy for the Library area. UK English, sentence case. */

export const PRIORITIES: { value: Priority; label: string; short: string; explanation: string }[] = [
  { value: "P1", label: "P1 Protected", short: "Protected", explanation: "Never removed automatically, even when space runs out. Use it for pages you cannot afford to lose." },
  { value: "P2", label: "P2 Important", short: "Important", explanation: "Kept for as long as possible. Removed only when space is critically short and you have allowed it in the storage policy." },
  { value: "P3", label: "P3 Standard", short: "Standard", explanation: "The normal choice. Older versions go first when space runs short." },
  { value: "P4", label: "P4 Opportunistic", short: "Opportunistic", explanation: "Nice to have. These pages are the first to be removed when space is needed." },
];
export const priorityLabel = (p: Priority | null | undefined) => PRIORITIES.find((x) => x.value === p)?.label ?? "";

export const EVICTION_EXPLANATION =
  "When disk space runs short, NoConBrain can remove older content from this source, lowest priority first. Protected (P1) always wins: a page in a P1 source or collection is never removed automatically, even if this source allows removal. A page in several places keeps the highest priority of them.";

export interface SourceTypeInfo {
  value: SourceType;
  label: string;
  description: string;
  addressLabel: string;
  addressHint: string;
  later?: string;
}

export const SOURCE_TYPES: SourceTypeInfo[] = [
  { value: "single_page", label: "Single page", description: "Save one page and nothing it links to.", addressLabel: "Page address", addressHint: "The full address of the page, for example https://example.org/guide." },
  { value: "website", label: "Website", description: "Follow links across a whole site, within the limits you set.", addressLabel: "Start address", addressHint: "Usually the home page. Pages on the same site are followed." },
  { value: "section", label: "Section of a site", description: "Stay inside one folder of a site, such as /docs/.", addressLabel: "Start address", addressHint: "The first page of the section, for example https://example.org/docs/. Only pages in the same folder are followed." },
  { value: "linked_collection", label: "Linked collection", description: "A start page and the pages it links to, including one hop to other sites.", addressLabel: "Start address", addressHint: "A page that links to the things you want, such as a reading list." },
  { value: "sitemap", label: "Sitemap", description: "Save the pages listed in a sitemap file.", addressLabel: "Sitemap address", addressHint: "Usually ends in sitemap.xml. A sitemap index file works too." },
  { value: "feed", label: "Feed", description: "Save the items in an RSS or Atom feed. Later runs save only new items.", addressLabel: "Feed address", addressHint: "The address of the RSS or Atom feed." },
  { value: "imported_documents", label: "Imported documents", description: "PDF, Markdown, text and HTML files you upload from your device. They are saved with a reader view and can be searched.", addressLabel: "", addressHint: "" },
  { value: "saved_search", label: "Saved search", description: "Pages found by a search you run again and again.", addressLabel: "", addressHint: "", later: "Arrives with online search." },
  { value: "knowledge_package", label: "Knowledge package", description: "An offline encyclopedia or other package file.", addressLabel: "", addressHint: "", later: "Arrives with offline package (ZIM) support." },
];
export const typeLabel = (t: SourceType) => SOURCE_TYPES.find((x) => x.value === t)?.label ?? t;

export const PROFILES: { value: SourceProfile; label: string; explanation: string }[] = [
  { value: "focused", label: "Focused", explanation: "Small and quick: up to 50 pages, 1 link deep." },
  { value: "balanced", label: "Balanced", explanation: "The usual choice: up to 500 pages, 3 links deep." },
  { value: "comprehensive", label: "Comprehensive", explanation: "Thorough: up to 5,000 pages, 6 links deep. Takes longer and uses more space." },
  { value: "custom", label: "Custom", explanation: "Set the depth, page count and size limits yourself." },
];

export const MODES: { value: SourceStrategy; label: string; explanation: string }[] = [
  { value: "capture", label: "Capture", explanation: "Save only the address you give. Nothing it links to." },
  { value: "explore", label: "Explore", explanation: "Follow links from the start address, most important links first, until a limit is reached." },
  { value: "mirror", label: "Mirror", explanation: "Copy the site or section as completely as the limits allow, so links between pages keep working offline." },
];

export const RETENTION_MODES = [
  { value: "latest", label: "Keep the latest versions", hint: "Older versions are removed once there are more than this." },
  { value: "all", label: "Keep every version", hint: "Uses more space over time." },
  { value: "time", label: "Keep versions for a period", hint: "Versions older than this are removed. The latest is always kept." },
  { value: "budget", label: "Stay within a size", hint: "The oldest versions go first once the source passes this size." },
] as const;

export const STATUS_LABEL: Record<string, string> = {
  never: "Not run yet",
  running: "Running",
  ok: "Finished",
  failed: "Failed",
  paused: "Paused",
  cancelled: "Cancelled",
};

/** Plain-English wording for the failure codes in docs/data-model.md. The code stays visible in details. */
export const FAILURE_COPY: Record<string, { message: string; hint: string }> = {
  network: { message: "The site could not be reached.", hint: "Check the connection, then retry." },
  robots_blocked: { message: "The site's robots.txt asks crawlers to stay away from this page.", hint: "You can turn off \"Respect robots.txt\" in the source's advanced settings if you own the site." },
  ssrf_blocked: { message: "This address points at a private or local network, which is blocked for safety.", hint: "Use a public address, or ask the administrator to allow the host." },
  size_cap: { message: "The page or download was larger than the size limit.", hint: "Raise the size limit in the source, then retry." },
  disk_full: { message: "There was not enough free disk space.", hint: "Free some space in Storage and settings, then retry." },
  timeout: { message: "The site took too long to answer.", hint: "Retry later, or lower the number of requests at once." },
  http_4xx: { message: "The site refused the request or the page does not exist.", hint: "Check the address in a browser. Retrying is unlikely to help." },
  http_5xx: { message: "The site had a problem on its side.", hint: "Retry later." },
  parse_error: { message: "The page was fetched but could not be read.", hint: "The page may be damaged or in an unsupported format." },
  limit_reached: { message: "A limit set on the source stopped the download.", hint: "Raise the page, size or time limit if you want more." },
  cancelled_by_user: { message: "Cancelled.", hint: "Retry to start it again." },
  internal: { message: "NoConBrain hit an unexpected problem.", hint: "Retry, and check the activity log if it happens again." },
};

export const STATE_LABEL: Record<string, string> = {
  queued: "Queued",
  running: "Running",
  paused: "Paused",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

export const KIND_LABEL: Record<string, string> = {
  capture: "Single page",
  explore: "Crawl",
  mirror: "Mirror",
  refresh: "Refresh",
  wikipedia: "Wikipedia",
  zim_import: "Package import",
  import: "Import",
  discovery: "Discovery",
  coverage: "Coverage",
};

export const LINK_STATE_WORDS: Record<string, string> = {
  cached: "Saved",
  partial: "Partly saved",
  queued: "Waiting to be saved",
  live_only: "Live only",
  unavailable: "Not available",
};

const PAGE_TYPE_LABELS: Record<string, string> = { html: "Web page", rendered: "Web page (rendered)", pdf: "PDF", markdown: "Markdown", text: "Plain text" };
export const pageTypeLabel = (t: string): string => PAGE_TYPE_LABELS[t] ?? t;

const VIA_LABELS: Record<string, string> = {
  seed: "Start address", link: "Followed a link", sitemap: "Listed in a sitemap", feed: "Listed in a feed", search: "From a search", manual: "Saved by hand",
};
export const discoveredViaLabel = (v: string): string => VIA_LABELS[v] ?? v;
