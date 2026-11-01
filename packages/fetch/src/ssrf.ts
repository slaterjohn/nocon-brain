import dns from "node:dns";
import ipaddr from "ipaddr.js";

export type SsrfReason = "scheme" | "credentials" | "port" | "ip_literal" | "hostname" | "resolved_address" | "invalid_url";

export class SsrfError extends Error {
  readonly code = "ESSRF";
  constructor(readonly reason: SsrfReason, message: string, readonly host?: string) {
    super(message);
    this.name = "SsrfError";
  }
}

export function isSsrfError(err: unknown): SsrfError | null {
  for (let e: unknown = err, i = 0; e && i < 6; i++, e = (e as { cause?: unknown }).cause) {
    if (e instanceof SsrfError || (e as { code?: string }).code === "ESSRF") return e as SsrfError;
  }
  return null;
}

/** Well-known internal service ports refused by the default `denylist` port policy. */
export const DEFAULT_BLOCKED_PORTS: readonly number[] = [
  1, 7, 9, 11, 13, 15, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117,
  119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601,
  636, 873, 993, 995, 1433, 1521, 2049, 2375, 2376, 3306, 3389, 4369, 5432, 5900, 5984, 6379, 6660, 6661, 6662, 6663, 6664, 6665,
  6666, 6667, 6668, 6669, 8086, 9042, 9200, 9300, 11211, 15672, 27017, 50070,
];

// ---------- IP literal parsing (independent of ipaddr.js, then classified by it) ----------

function parseLegacyPart(p: string): number | null {
  if (p === "") return null;
  let radix = 10;
  let s = p;
  if (/^0x/i.test(s)) {
    radix = 16;
    s = s.slice(2);
    if (s === "") return 0;
  } else if (s.length > 1 && s[0] === "0") {
    radix = 8;
    s = s.slice(1);
  }
  const re = radix === 16 ? /^[0-9a-f]+$/i : radix === 8 ? /^[0-7]+$/ : /^[0-9]+$/;
  if (!re.test(s)) return null;
  const n = parseInt(s, radix);
  return Number.isFinite(n) ? n : null;
}

/** WHATWG-style IPv4 parser: accepts decimal, hex, octal and short forms (`2130706433`, `0x7f.1`, `0177.0.0.1`). */
export function parseLegacyIPv4(host: string): [number, number, number, number] | null {
  const parts = host.split(".");
  if (parts.length > 1 && parts[parts.length - 1] === "") parts.pop();
  if (parts.length === 0 || parts.length > 4) return null;
  const nums: number[] = [];
  for (const p of parts) {
    const n = parseLegacyPart(p);
    if (n === null) return null;
    nums.push(n);
  }
  for (let i = 0; i < nums.length - 1; i++) if (nums[i]! > 255) return null;
  const last = nums[nums.length - 1]!;
  if (last >= 256 ** (5 - nums.length)) return null;
  let v = last;
  for (let i = 0; i < nums.length - 1; i++) v += nums[i]! * 256 ** (3 - i);
  return [(v / 2 ** 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
}

export type ParsedIp = ipaddr.IPv4 | ipaddr.IPv6;

/** Returns the address if `host` is any IP literal form, else null. */
export function parseIpLiteral(host: string): ParsedIp | null {
  let h = host.trim();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  const pct = h.indexOf("%");
  if (pct >= 0) h = h.slice(0, pct);
  if (h.includes(":")) {
    try {
      return ipaddr.IPv6.isValid(h) ? ipaddr.IPv6.parse(h) : null;
    } catch {
      return null;
    }
  }
  const v4 = parseLegacyIPv4(h);
  if (v4) return new ipaddr.IPv4(v4);
  return null;
}

/** Unwraps IPv4-mapped IPv6. */
function unwrap(a: ParsedIp): ParsedIp {
  return a.kind() === "ipv6" && (a as ipaddr.IPv6).isIPv4MappedAddress() ? (a as ipaddr.IPv6).toIPv4Address() : a;
}

export function ipRange(a: ParsedIp): string {
  return unwrap(a).range();
}

/** Only globally routable unicast addresses pass. */
export function isPublicUnicast(a: ParsedIp): boolean {
  return ipRange(a) === "unicast";
}

// ---------- operator allowlist ----------

export type AllowEntry =
  | { kind: "host"; host: string; port?: number }
  | { kind: "suffix"; suffix: string; port?: number }
  | { kind: "cidr"; range: [ParsedIp, number]; port?: number };

export function parseAllowlist(spec: string | readonly string[] | undefined | null): AllowEntry[] {
  const items = typeof spec === "string" ? spec.split(/[,\s]+/) : [...(spec ?? [])];
  const out: AllowEntry[] = [];
  for (let item of items) {
    item = item.trim().toLowerCase();
    if (!item) continue;
    let port: number | undefined;
    // trailing :port (a bare IPv6 address has several colons and no port)
    const m = item.match(/^(\[.*\]):(\d{1,5})$/) ?? (item.split(":").length === 2 ? item.match(/^(.*):(\d{1,5})$/) : null);
    if (m) {
      item = m[1]!;
      port = Number(m[2]);
    }
    if (item.startsWith("*.")) {
      out.push({ kind: "suffix", suffix: item.slice(1), port });
      continue;
    }
    if (item.includes("/")) {
      const [addr, bits] = item.replace(/^\[|\]$/g, "").split("/");
      const ip = parseIpLiteral(addr!);
      if (!ip || !/^\d+$/.test(bits ?? "")) throw new Error(`invalid allowlist CIDR: ${item}`);
      out.push({ kind: "cidr", range: [ip, Number(bits)], port });
      continue;
    }
    const ip = parseIpLiteral(item);
    if (ip) out.push({ kind: "cidr", range: [ip, ip.kind() === "ipv4" ? 32 : 128], port });
    else out.push({ kind: "host", host: item.replace(/\.$/, ""), port });
  }
  return out;
}

export function allowlistFromEnv(env: Record<string, string | undefined> = process.env): AllowEntry[] {
  return parseAllowlist(env.NCB_FETCH_ALLOW_PRIVATE_HOSTS);
}

function cidrMatch(ip: ParsedIp, [net, bits]: [ParsedIp, number]): boolean {
  const a = unwrap(ip);
  const n = unwrap(net);
  if (a.kind() !== n.kind()) return false;
  try {
    return (a as ipaddr.IPv4).match(n as ipaddr.IPv4, bits);
  } catch {
    return false;
  }
}

// ---------- guard ----------

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}
export type Resolver = (host: string, family?: number) => Promise<ResolvedAddress[]>;

export interface SsrfGuardOptions {
  /** Intentionally allowed private hosts: string (comma separated) or entries. Default none. */
  allow?: string | readonly string[] | readonly AllowEntry[];
  /** Default `["http:", "https:"]`. */
  allowedSchemes?: readonly string[];
  /** `denylist` (default): block `blockedPorts`. `strict`: only 80, 443 and `allowedPorts`. */
  portPolicy?: "denylist" | "strict";
  blockedPorts?: readonly number[];
  allowedPorts?: readonly number[];
  /** Replace DNS resolution (tests, DNS rebinding simulation). */
  resolver?: Resolver;
}

export type LookupCallback = (err: NodeJS.ErrnoException | null, address?: string | dns.LookupAddress[], family?: number) => void;

export interface SsrfGuard {
  /** Validates scheme, credentials, port and IP literals. Returns the parsed URL. Throws SsrfError. */
  checkUrl(input: string | URL): URL;
  /** Resolves `location` against `from`, then runs `checkUrl`. */
  checkRedirect(from: string | URL, location: string): URL;
  /** Pass as undici `connect.lookup`. Returns only allowed addresses. */
  lookup(hostname: string, options: dns.LookupOptions, cb: LookupCallback): void;
  /** True when this address would be accepted for `hostname`. */
  isAddressAllowed(address: string, hostname?: string): boolean;
}

const defaultResolver: Resolver = async (host, family) => {
  const res = await dns.promises.lookup(host, { all: true, verbatim: true, family: family ?? 0 });
  return res.map((r) => ({ address: r.address, family: r.family as 4 | 6 }));
};

export function createSsrfGuard(opts: SsrfGuardOptions = {}): SsrfGuard {
  const allow: AllowEntry[] = Array.isArray(opts.allow) && opts.allow.length && typeof opts.allow[0] === "object"
    ? [...(opts.allow as AllowEntry[])]
    : parseAllowlist(opts.allow as string | string[] | undefined);
  const schemes = new Set(opts.allowedSchemes ?? ["http:", "https:"]);
  const blocked = new Set(opts.blockedPorts ?? DEFAULT_BLOCKED_PORTS);
  const strictPorts = new Set([80, 443, ...(opts.allowedPorts ?? [])]);
  const resolver = opts.resolver ?? defaultResolver;

  const hostEntryMatches = (e: AllowEntry, host: string): boolean =>
    (e.kind === "host" && e.host === host) || (e.kind === "suffix" && host.endsWith(e.suffix));
  const portOk = (e: AllowEntry, port: number | undefined): boolean => e.port === undefined || port === undefined || e.port === port;

  function portCheck(url: URL, explicitlyAllowed: boolean): void {
    const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
    if (explicitlyAllowed) return;
    if (opts.portPolicy === "strict") {
      if (!strictPorts.has(port)) throw new SsrfError("port", `port ${port} is not allowed`, url.hostname);
    } else if (blocked.has(port)) {
      throw new SsrfError("port", `port ${port} is blocked`, url.hostname);
    }
  }

  function checkUrl(input: string | URL): URL {
    let url: URL;
    try {
      url = typeof input === "string" ? new URL(input) : new URL(input.href);
    } catch {
      throw new SsrfError("invalid_url", `not a valid URL: ${String(input).slice(0, 200)}`);
    }
    if (!schemes.has(url.protocol)) throw new SsrfError("scheme", `scheme ${url.protocol} is not allowed`, url.hostname);
    if (url.username || url.password) throw new SsrfError("credentials", "credentials in URLs are not allowed", url.hostname);
    const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
    const host = url.hostname.toLowerCase().replace(/\.+$/, "");
    const bare = host.replace(/^\[|\]$/g, "");

    const ip = parseIpLiteral(host);
    if (ip) {
      const entry = allow.find((e) => e.kind === "cidr" && cidrMatch(ip, e.range) && portOk(e, port));
      if (!isPublicUnicast(ip) && !entry) {
        throw new SsrfError("ip_literal", `address ${bare} (${ipRange(ip)}) is not allowed`, host);
      }
      portCheck(url, entry?.port !== undefined);
      return url;
    }
    // Hostname. (A numeric-looking name that is not a valid IP cannot get here: WHATWG rejects it.)
    const named = allow.filter((e) => hostEntryMatches(e, host));
    if (named.length && !named.some((e) => portOk(e, port))) {
      throw new SsrfError("port", `host ${host} is allowlisted only for other ports`, host);
    }
    if (!named.length && (host === "localhost" || host.endsWith(".localhost"))) {
      throw new SsrfError("hostname", `host ${host} is not allowed`, host);
    }
    portCheck(url, named.some((e) => e.port !== undefined));
    return url;
  }

  function isAddressAllowed(address: string, hostname?: string): boolean {
    const ip = parseIpLiteral(address);
    if (!ip) return false;
    if (isPublicUnicast(ip)) return true;
    const host = hostname?.toLowerCase().replace(/\.+$/, "");
    if (host && allow.some((e) => hostEntryMatches(e, host))) return true;
    // Port-bound address entries only apply to IP-literal URLs (checkUrl): the lookup does not know the port,
    // so a hostname resolving into such an address must not slip through on another port.
    return allow.some((e) => e.kind === "cidr" && e.port === undefined && cidrMatch(ip, e.range));
  }

  function lookup(hostname: string, options: dns.LookupOptions, cb: LookupCallback): void {
    const family = options?.family === 4 || options?.family === 6 ? options.family : 0;
    const literal = parseIpLiteral(hostname);
    const resolved: Promise<ResolvedAddress[]> = literal
      ? Promise.resolve([{ address: hostname.replace(/^\[|\]$/g, ""), family: literal.kind() === "ipv4" ? 4 : 6 }])
      : resolver(hostname, family);
    resolved.then(
      (addrs) => {
        const ok = addrs.filter((a) => isAddressAllowed(a.address, hostname));
        if (!ok.length) {
          return cb(new SsrfError("resolved_address", `${hostname} resolves to a disallowed address (${addrs.map((a) => a.address).join(", ") || "none"})`, hostname));
        }
        if (options?.all) return cb(null, ok.map((a) => ({ address: a.address, family: a.family })));
        cb(null, ok[0]!.address, ok[0]!.family);
      },
      (err) => cb(err),
    );
  }

  function checkRedirect(from: string | URL, location: string): URL {
    let next: URL;
    try {
      next = new URL(location, from);
    } catch {
      throw new SsrfError("invalid_url", `bad redirect target: ${location.slice(0, 200)}`);
    }
    return checkUrl(next);
  }

  return { checkUrl, checkRedirect, lookup, isAddressAllowed };
}
