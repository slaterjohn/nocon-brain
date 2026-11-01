import { BlockList, isIP } from "node:net";

export class CidrError extends Error {}

interface Parsed {
  net: string;
  prefix: number;
  family: "ipv4" | "ipv6";
}

const PRIVATE_V4: [string, number][] = [["10.0.0.0", 8], ["172.16.0.0", 12], ["192.168.0.0", 16], ["127.0.0.0", 8], ["169.254.0.0", 16]];
const PRIVATE_V6: [string, number][] = [["fc00::", 7], ["fe80::", 10], ["::1", 128]];

export function parseCidr(text: string): Parsed {
  const [addr, bits, extra] = text.trim().split("/");
  const fam = addr ? isIP(addr) : 0;
  if (!addr || fam === 0 || extra !== undefined) throw new CidrError(`"${text}" is not a CIDR range such as 192.168.1.0/24`);
  const family = fam === 4 ? "ipv4" : "ipv6";
  const max = fam === 4 ? 32 : 128;
  const prefix = bits === undefined ? max : /^\d+$/.test(bits) ? Number(bits) : NaN;
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > max) throw new CidrError(`"${text}" has an invalid prefix length`);
  return { net: addr, prefix, family };
}

/** True only when the whole range lies inside private address space (RFC 1918, loopback, link-local, ULA). */
export function isPrivateCidr(text: string): boolean {
  const c = parseCidr(text);
  // Checking the network address alone is not enough (0.0.0.0/0 starts outside private space, but 10.0.0.0/4
  // would start inside it), so the prefix must also be at least as long as the private block containing it.
  const blocks = c.family === "ipv4" ? PRIVATE_V4 : PRIVATE_V6;
  return blocks.some(([n, p]) => {
    const b = new BlockList();
    b.addSubnet(n, p, c.family);
    return c.prefix >= p && b.check(c.net, c.family);
  });
}

/** Builds a matcher. Throws `CidrError` for malformed or non-private ranges. */
export function privateCidrMatcher(cidrs: string[]): (ip: string) => boolean {
  const list = new BlockList();
  for (const text of cidrs) {
    if (!isPrivateCidr(text)) throw new CidrError(`"${text}" is not a private range. Trusted-LAN mode only accepts private addresses.`);
    const c = parseCidr(text);
    list.addSubnet(c.net, c.prefix, c.family);
  }
  return (ip: string) => {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
    const addr = mapped ? mapped[1]! : ip;
    const fam = isIP(addr);
    if (fam === 0) return false;
    return list.check(addr, fam === 4 ? "ipv4" : "ipv6");
  };
}
