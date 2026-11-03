/**
 * H-03 SSRF corpus. Every entry is an address a server-side fetch must refuse, however it is spelled. `canary` is the port of a local
 * server that counts requests; the loopback spellings point at it, so a guard that fails open shows up as a hit, not just a wrong error.
 * Nothing here needs the internet: names that would need DNS are resolved by a fake resolver (see `FAKE_DNS`).
 */

export interface Target {
  name: string;
  url: string;
  /** Why it must be refused. */
  why: string;
}

/** Representative private, loopback, link-local, metadata and reserved IPv4 addresses (one or two per range). */
export const PRIVATE_V4: [string, [number, number, number, number]][] = [
  ["this-network", [0, 0, 0, 0]],
  ["this-network-1", [0, 1, 2, 3]],
  ["private-10", [10, 0, 0, 1]],
  ["private-10-high", [10, 255, 255, 254]],
  ["cgnat", [100, 64, 0, 1]],
  ["cgnat-high", [100, 127, 255, 254]],
  ["loopback", [127, 0, 0, 1]],
  ["loopback-other", [127, 1, 2, 3]],
  ["loopback-high", [127, 255, 255, 254]],
  ["metadata-aws-gcp-azure", [169, 254, 169, 254]],
  ["metadata-ecs", [169, 254, 170, 2]],
  ["link-local", [169, 254, 0, 1]],
  ["private-172-16", [172, 16, 0, 1]],
  ["private-172-31", [172, 31, 255, 254]],
  ["ietf-protocol", [192, 0, 0, 8]],
  ["test-net-1", [192, 0, 2, 1]],
  ["private-192-168", [192, 168, 1, 1]],
  ["private-192-168-high", [192, 168, 255, 254]],
  ["benchmark", [198, 18, 0, 1]],
  ["test-net-2", [198, 51, 100, 7]],
  ["test-net-3", [203, 0, 113, 9]],
  ["multicast", [224, 0, 0, 1]],
  ["multicast-high", [239, 255, 255, 250]],
  ["reserved", [240, 0, 0, 1]],
  ["broadcast", [255, 255, 255, 255]],
];

/** A public address that must still be allowed (the guard must not simply refuse everything). */
export const PUBLIC_V4: [number, number, number, number][] = [[93, 184, 216, 34], [8, 8, 8, 8], [1, 1, 1, 1], [151, 101, 1, 69], [185, 199, 108, 153]];

const n = (o: [number, number, number, number]) => o[0] * 2 ** 24 + o[1] * 2 ** 16 + o[2] * 2 ** 8 + o[3];

/** Every spelling of an IPv4 address that WHATWG URL and the legacy `inet_aton` family accept. */
export function v4Spellings(o: [number, number, number, number]): string[] {
  const [a, b, c, d] = o;
  const v = n(o);
  const hex = (x: number) => "0x" + x.toString(16);
  const oct = (x: number) => (x === 0 ? "0" : "0" + x.toString(8));
  const out = [
    `${a}.${b}.${c}.${d}`,
    `${v}`, // single decimal number
    hex(v), // single hex number
    "0x" + v.toString(16).toUpperCase().padStart(8, "0"),
    "0x" + v.toString(16).padStart(12, "0"), // leading zeros in hex
    oct(v), // single octal number
    `${hex(a)}.${hex(b)}.${hex(c)}.${hex(d)}`,
    `${oct(a)}.${oct(b)}.${oct(c)}.${oct(d)}`,
    `${hex(a)}.${b}.${c}.${d}`,
    `${a}.${hex(b)}.${oct(c)}.${d}`,
    `${a}.${b}.${c * 256 + d}`, // three parts: last holds 16 bits
    `${a}.${b * 65536 + c * 256 + d}`, // two parts: last holds 24 bits
    `${a}.${hex(b * 65536 + c * 256 + d)}`,
    `${a}.${b}.${c}.${d}.`, // trailing dot
  ];
  return [...new Set(out)];
}

/** IPv6 spellings that embed or encode an IPv4 address. */
export function v6Spellings(o: [number, number, number, number]): string[] {
  const [a, b, c, d] = o;
  const h1 = ((a << 8) | b).toString(16);
  const h2 = ((c << 8) | d).toString(16);
  const h1p = ((a << 8) | b).toString(16).padStart(4, "0");
  const h2p = ((c << 8) | d).toString(16).padStart(4, "0");
  return [
    `::ffff:${a}.${b}.${c}.${d}`, // IPv4-mapped, dotted
    `::ffff:${h1}:${h2}`, // IPv4-mapped, hex
    `::FFFF:${h1}:${h2}`,
    `0:0:0:0:0:ffff:${h1p}:${h2p}`, // fully written
    `0000:0000:0000:0000:0000:ffff:${a}.${b}.${c}.${d}`,
    `::${a}.${b}.${c}.${d}`, // deprecated IPv4-compatible
    `::${h1}:${h2}`,
    `64:ff9b::${a}.${b}.${c}.${d}`, // NAT64 well-known prefix
    `64:ff9b::${h1}:${h2}`,
    `2002:${h1p}:${h2p}::`, // 6to4
    `2002:${h1p}:${h2p}::1`,
    `::ffff:0:${a}.${b}.${c}.${d}`, // SIIT
    `::ffff:0:${h1}:${h2}`,
  ];
}

/** IPv6 addresses that are local, private or reserved in their own right. */
export const PRIVATE_V6: [string, string][] = [
  ["unspecified", "::"],
  ["loopback", "::1"],
  ["loopback-long", "0:0:0:0:0:0:0:1"],
  ["loopback-padded", "0000:0000:0000:0000:0000:0000:0000:0001"],
  ["link-local", "fe80::1"],
  ["link-local-high", "febf::1"],
  ["link-local-zone", "fe80::1%eth0"],
  ["link-local-zone-lo", "fe80::1%25lo0"],
  ["unique-local-fc", "fc00::1"],
  ["unique-local-fd", "fd12:3456:789a::1"],
  ["aws-ipv6-metadata", "fd00:ec2::254"],
  ["multicast", "ff02::1"],
  ["documentation", "2001:db8::1"],
  ["discard", "100::1"],
  ["teredo", "2001:0:4136:e378:8000:63bf:3fff:fdd2"],
  ["site-local-deprecated", "fec0::1"],
];

export interface NameTarget extends Target {
  /** The host the fake resolver must answer for. */
  host: string;
}

/**
 * Names the fake resolver answers with a disallowed address. A name that is public on the internet but private inside the network
 * (split-horizon, `*.internal`, `localtest.me`, nip.io) is the classic bypass, so the check must be on the resolved address.
 */
export const FAKE_DNS: Record<string, string[]> = {
  "localtest.example": ["127.0.0.1"],
  "internal.example": ["10.1.2.3"],
  "metadata.google.internal": ["169.254.169.254"],
  "metadata.example": ["169.254.169.254"],
  "ipv6-loopback.example": ["::1"],
  "mapped.example": ["::ffff:127.0.0.1"],
  "mapped-hex.example": ["::ffff:7f00:1"],
  "linklocal.example": ["fe80::1"],
  "ula.example": ["fd00::1"],
  "cgnat.example": ["100.64.1.1"],
  "zero.example": ["0.0.0.0"],
  "private-192.example": ["192.168.0.10"],
  "two-private.example": ["10.0.0.1", "192.168.0.1"],
  "nat64.example": ["64:ff9b::7f00:1"],
  "sixtofour.example": ["2002:7f00:1::"],
  "multicast.example": ["224.0.0.1"],
  // upper-case and trailing-dot spellings must resolve the same way
  "MiXeD-CaSe.example": ["127.0.0.1"],
  "dotted.example.": ["127.0.0.1"],
};

/** Hosts that name the local machine without DNS help. */
export const LOCAL_NAMES = ["localhost", "LOCALHOST", "LocalHost", "localhost.", "localhost..", "foo.localhost", "a.b.c.localhost", "FOO.LOCALHOST."];

/** Schemes a fetch must never follow. */
export const BAD_SCHEMES = [
  "file:///etc/passwd", "file://localhost/etc/passwd", "file:/etc/passwd", "FILE:///etc/passwd",
  "ftp://127.0.0.1/", "ftp://example.com/", "gopher://127.0.0.1:6379/_PING", "gopher://example.com/",
  "data:text/html,<script>alert(1)</script>", "data:,hello", "javascript:alert(1)", "JaVaScRiPt:alert(1)",
  "ws://127.0.0.1/", "wss://example.com/", "dict://127.0.0.1:11211/stat", "ldap://127.0.0.1/", "tftp://127.0.0.1/x", "sftp://example.com/x",
  "jar:http://example.com/a.jar!/", "blob:http://example.com/uuid", "about:blank", "view-source:http://example.com/", "chrome://settings",
  "mailto:a@example.com", "tel:+123", "smb://127.0.0.1/share", "ssh://127.0.0.1/", "telnet://127.0.0.1/", "ssrf:http://127.0.0.1/",
  "  javascript:alert(1)", "\tfile:///etc/passwd", "\nfile:///etc/passwd",
];

/** URLs with credentials. They are refused outright (the userinfo trick `http://public@private/` fools naive host checks). */
export function userinfoTricks(canary: number): Target[] {
  return [
    { name: "userinfo-public-at-loopback", url: `http://example.com@127.0.0.1:${canary}/canary`, why: "host is 127.0.0.1" },
    { name: "userinfo-pass-at-loopback", url: `http://example.com:80@127.0.0.1:${canary}/canary`, why: "host is 127.0.0.1" },
    { name: "userinfo-loopback-at-public", url: "http://127.0.0.1@example.com/", why: "credentials in URL" },
    { name: "userinfo-user-pass-public", url: "https://user:pass@example.com/", why: "credentials in URL" },
    { name: "userinfo-empty-user", url: "http://:pass@example.com/", why: "credentials in URL" },
    { name: "userinfo-encoded-at", url: `http://example.com%40127.0.0.1:${canary}/canary`, why: "encoded @ is part of the host, which is invalid" },
    { name: "userinfo-metadata", url: "http://google.com@169.254.169.254/", why: "host is the metadata address" },
  ];
}

/** Malformed or ambiguous URLs, as the fetch layer would be handed them. */
export const MALFORMED = [
  "", " ", "http://", "http:///", "http://:80/", "http://[::1", "http://[::1]x/", "http://[127.0.0.1]/", "http://[::ffff:127.0.0.1/",
  "http://127.0.0.1:99999/", "http://example.com:-1/", "http://example.com:0x50/", "http://%00/", "http://exa mple.com/", "http://exa%20mple.com/",
  "//127.0.0.1/", "/\\127.0.0.1/", "127.0.0.1", "localhost", "example.com", "http:", "https:",
  "http://example.com\u0000.evil.com/", "http://\u0000127.0.0.1/", "http://127.0.0.1\u0000.example.com/",
  "http://１２７.０.０.１/", // full-width digits normalise to 127.0.0.1
  "http://127。0。0。1/", // ideographic full stop normalises to a dot
  "http://127%2e0%2e0%2e1/", // percent-encoded dots
  "http://%31%32%37.0.0.1/", // percent-encoded digits
  "http://①②⑦.0.0.1/", // circled digits: invalid after IDNA, or 127 if mapped: either way not public
  "http://0.0.0.0.0/", "http://256.256.256.256/", "http://1.2.3.4.5/", "http://999999999999/", "http://0x100000000/", "http://0177777777777/",
];

/** Ports that must not be reached even on a public name (service ports an SSRF is used to talk to). */
export const BLOCKED_PORTS = [22, 23, 25, 53, 110, 111, 135, 139, 143, 445, 1433, 1883, 2049, 2375, 2379, 3306, 3389, 4243, 5432, 5672, 5900, 5985, 6379, 6443, 9200, 10250, 11211, 27017];

/** Redirect `Location` values that point inside. Relative and scheme-relative forms resolve against the current URL. */
export function redirectLocations(canary: number): { name: string; location: string }[] {
  return [
    { name: "absolute-loopback", location: `http://127.0.0.1:${canary}/canary` },
    { name: "absolute-localhost", location: `http://localhost:${canary}/canary` },
    { name: "scheme-relative-loopback", location: `//127.0.0.1:${canary}/canary` },
    { name: "backslash-scheme-relative", location: `/\\127.0.0.1:${canary}/canary` },
    { name: "single-slash-scheme", location: `http:/127.0.0.1:${canary}/canary` },
    { name: "no-slash-scheme", location: `http:127.0.0.1:${canary}/canary` },
    { name: "decimal", location: `http://2130706433:${canary}/canary` },
    { name: "hex", location: `http://0x7f000001:${canary}/canary` },
    { name: "octal", location: `http://0177.0.0.1:${canary}/canary` },
    { name: "ipv6-loopback", location: `http://[::1]:${canary}/canary` },
    { name: "ipv4-mapped", location: `http://[::ffff:127.0.0.1]:${canary}/canary` },
    { name: "ipv4-mapped-hex", location: `http://[::ffff:7f00:1]:${canary}/canary` },
    { name: "metadata", location: "http://169.254.169.254/latest/meta-data/" },
    { name: "private-10", location: "http://10.0.0.1/" },
    { name: "private-192", location: "http://192.168.0.1/admin" },
    { name: "file", location: "file:///etc/passwd" },
    { name: "gopher", location: "gopher://127.0.0.1:6379/_PING" },
    { name: "data", location: "data:text/html,<script>1</script>" },
    { name: "javascript", location: "javascript:alert(1)" },
    { name: "userinfo", location: `http://example.com@127.0.0.1:${canary}/canary` },
    { name: "space-prefixed", location: ` http://127.0.0.1:${canary}/canary` },
    { name: "tab-inside", location: `http://127.0.0.1:${canary}/\tcanary` },
    { name: "fake-dns-private", location: "http://internal.example/" },
    { name: "fake-dns-loopback", location: `http://localtest.example:${canary}/canary` },
    { name: "fake-dns-metadata", location: "http://metadata.google.internal/computeMetadata/v1/" },
  ];
}

/** Every URL a test should try to fetch directly, with the canary port filled in. */
export function directTargets(canary: number): Target[] {
  const out: Target[] = [];
  for (const [name, o] of PRIVATE_V4) {
    for (const [i, host] of v4Spellings(o).entries()) out.push({ name: `v4 ${name} #${i} ${host}`, url: `http://${host}:${canary}/canary`, why: `${name} spelled ${host}` });
    for (const [i, host] of v6Spellings(o).entries()) out.push({ name: `v6 ${name} #${i} ${host}`, url: `http://[${host}]:${canary}/canary`, why: `${name} as ${host}` });
  }
  for (const [name, host] of PRIVATE_V6) out.push({ name: `v6 ${name}`, url: `http://[${host}]:${canary}/canary`, why: name });
  for (const h of LOCAL_NAMES) out.push({ name: `name ${h}`, url: `http://${h}:${canary}/canary`, why: "local name" });
  for (const u of BAD_SCHEMES) out.push({ name: `scheme ${JSON.stringify(u)}`, url: u, why: "scheme" });
  for (const t of userinfoTricks(canary)) out.push(t);
  for (const host of Object.keys(FAKE_DNS)) out.push({ name: `dns ${host}`, url: `http://${host}:${canary}/canary`, why: "resolves to a disallowed address" });
  for (const p of BLOCKED_PORTS) out.push({ name: `port ${p}`, url: `http://public.example:${p}/`, why: "blocked port" });
  return out;
}
