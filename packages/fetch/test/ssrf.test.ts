import { describe, expect, it } from "vitest";
import { createSsrfGuard, parseAllowlist, parseIpLiteral, parseLegacyIPv4, isPublicUnicast, SsrfError, type Resolver } from "../src";

const reason = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(SsrfError);
    return (e as SsrfError).reason;
  }
  return null;
};

describe("IP literal forms", () => {
  const blocked = [
    "http://127.0.0.1/", "http://127.0.0.1:3000/", "http://2130706433/", "http://0x7f.1/", "http://0x7f000001/", "http://0177.0.0.1/",
    "http://127.1/", "http://[::1]/", "http://[::ffff:127.0.0.1]/", "http://[::ffff:7f00:1]/", "http://[0:0:0:0:0:ffff:7f00:1]/",
    "http://169.254.169.254/latest/meta-data/", "http://[::ffff:169.254.169.254]/", "http://100.64.0.1/", "http://10.0.0.1/", "http://172.16.0.1/",
    "http://172.31.255.255/", "http://192.168.1.1/", "http://0.0.0.0/", "http://0/", "http://255.255.255.255/", "http://224.0.0.1/",
    "http://[fd00::1]/", "http://[fe80::1]/", "http://[fd00:ec2::254]/", "http://[::]/", "http://[64:ff9b::7f00:1]/", "http://[2002:7f00:1::]/",
    "http://192.0.2.1/", "http://198.18.0.1/", "http://240.0.0.1/", "http://[ff02::1]/", "http://3232235777/", "http://0xa9fea9fe/",
    "http://017700000001/", "http://localhost/", "http://foo.localhost/", "http://LOCALHOST./",
  ];
  for (const u of blocked) it(`blocks ${u}`, () => expect(reason(() => createSsrfGuard().checkUrl(u))).toMatch(/ip_literal|hostname/));

  const allowed = ["http://93.184.216.34/", "https://example.com/", "http://[2606:4700::1111]/", "http://8.8.8.8:8080/", "http://[::ffff:8.8.8.8]/"];
  for (const u of allowed) it(`allows ${u}`, () => expect(reason(() => createSsrfGuard().checkUrl(u))).toBeNull());

  it("parses legacy IPv4 spellings", () => {
    expect(parseLegacyIPv4("2130706433")).toEqual([127, 0, 0, 1]);
    expect(parseLegacyIPv4("0x7f.1")).toEqual([127, 0, 0, 1]);
    expect(parseLegacyIPv4("0177.0.0.1")).toEqual([127, 0, 0, 1]);
    expect(parseLegacyIPv4("1.2.3.256")).toBeNull();
    expect(parseLegacyIPv4("example")).toBeNull();
    expect(parseIpLiteral("[::1]")).not.toBeNull();
    expect(isPublicUnicast(parseIpLiteral("8.8.8.8")!)).toBe(true);
  });
});

describe("scheme, credentials, port", () => {
  const g = createSsrfGuard();
  for (const u of ["file:///etc/passwd", "ftp://example.com/", "gopher://example.com/", "javascript:alert(1)", "data:text/html,x"]) {
    it(`rejects ${u}`, () => expect(reason(() => g.checkUrl(u))).toBe("scheme"));
  }
  it("rejects credentials", () => {
    expect(reason(() => g.checkUrl("http://example.com@127.0.0.1:3000/"))).toBe("credentials");
    expect(reason(() => g.checkUrl("https://user:pw@example.com/"))).toBe("credentials");
  });
  it("rejects garbage", () => expect(reason(() => g.checkUrl("nonsense"))).toBe("invalid_url"));
  it("denylist ports", () => {
    for (const p of [22, 25, 3306, 6379, 2375]) expect(reason(() => g.checkUrl(`http://example.com:${p}/`))).toBe("port");
    expect(reason(() => g.checkUrl("http://example.com:8080/"))).toBeNull();
    expect(reason(() => g.checkUrl("https://example.com:8443/"))).toBeNull();
  });
  it("strict ports", () => {
    const s = createSsrfGuard({ portPolicy: "strict", allowedPorts: [8080] });
    expect(reason(() => s.checkUrl("http://example.com/"))).toBeNull();
    expect(reason(() => s.checkUrl("https://example.com:443/"))).toBeNull();
    expect(reason(() => s.checkUrl("http://example.com:8080/"))).toBeNull();
    expect(reason(() => s.checkUrl("http://example.com:8081/"))).toBe("port");
  });
});

describe("operator allowlist", () => {
  it("parses entries", () => {
    const e = parseAllowlist("nas.lan, *.home.arpa, 192.168.1.5, 10.0.0.0/8, 192.168.2.2:8080, [fd00::1], nas.lan:5000");
    expect(e.map((x) => x.kind)).toEqual(["host", "suffix", "cidr", "cidr", "cidr", "cidr", "host"]);
    expect(e[4]!.port).toBe(8080);
    expect(e[6]!.port).toBe(5000);
  });
  it("allows listed private literals and CIDRs only", () => {
    const g = createSsrfGuard({ allow: "192.168.1.5, 10.0.0.0/8" });
    expect(reason(() => g.checkUrl("http://192.168.1.5/"))).toBeNull();
    expect(reason(() => g.checkUrl("http://10.9.9.9/"))).toBeNull();
    expect(reason(() => g.checkUrl("http://192.168.1.6/"))).toBe("ip_literal");
    expect(reason(() => g.checkUrl("http://127.0.0.1/"))).toBe("ip_literal");
    expect(reason(() => g.checkUrl("http://169.254.169.254/"))).toBe("ip_literal");
  });
  it("respects ports on entries", () => {
    const g = createSsrfGuard({ allow: "127.0.0.1:4000" });
    expect(reason(() => g.checkUrl("http://127.0.0.1:4000/"))).toBeNull();
    expect(reason(() => g.checkUrl("http://127.0.0.1:4001/"))).toBe("ip_literal");
  });
  it("allows a listed hostname (localhost) and its resolved address", () => {
    const g = createSsrfGuard({ allow: "localhost" });
    expect(reason(() => g.checkUrl("http://localhost:3000/"))).toBeNull();
    expect(g.isAddressAllowed("127.0.0.1", "localhost")).toBe(true);
    expect(g.isAddressAllowed("127.0.0.1", "other.example")).toBe(false);
  });
  it("a port-bound address entry does not admit hostnames resolving there (lookup is port-blind)", async () => {
    const resolver: Resolver = async () => [{ address: "127.0.0.1", family: 4 }];
    const g = createSsrfGuard({ allow: "127.0.0.1:4000", resolver });
    const r = await new Promise<unknown>((res) => g.lookup("alias.test", { all: true } as never, (err) => res(err)));
    expect(r).toBeInstanceOf(SsrfError);
    expect(g.isAddressAllowed("127.0.0.1", "alias.test")).toBe(false);
  });
  it("is empty by default", () => {
    expect(reason(() => createSsrfGuard().checkUrl("http://localhost/"))).toBe("hostname");
  });
});

describe("redirect revalidation", () => {
  const g = createSsrfGuard();
  it("resolves relative locations and validates each", () => {
    expect(g.checkRedirect("https://example.com/a/b", "../c").href).toBe("https://example.com/c");
    expect(reason(() => g.checkRedirect("https://example.com/a", "http://127.0.0.1/"))).toBe("ip_literal");
    expect(reason(() => g.checkRedirect("https://example.com/a", "file:///etc/passwd"))).toBe("scheme");
    expect(reason(() => g.checkRedirect("https://example.com/a", "http://2130706433/x"))).toBe("ip_literal");
  });
});

describe("validating lookup and DNS rebinding", () => {
  const lookupOnce = (g: ReturnType<typeof createSsrfGuard>, host: string, all = true) =>
    new Promise<{ err: unknown; res: unknown }>((resolve) => g.lookup(host, { all } as never, (err, res) => resolve({ err, res })));

  it("filters private answers and fails when none remain", async () => {
    const resolver: Resolver = async () => [{ address: "10.0.0.5", family: 4 }, { address: "93.184.216.34", family: 4 }];
    const g = createSsrfGuard({ resolver });
    const ok = await lookupOnce(g, "mixed.test");
    expect(ok.res).toEqual([{ address: "93.184.216.34", family: 4 }]);
    const single = await lookupOnce(g, "mixed.test", false);
    expect(single.res).toBe("93.184.216.34");
    const priv = createSsrfGuard({ resolver: async () => [{ address: "127.0.0.1", family: 4 }] });
    const bad = await lookupOnce(priv, "evil.test");
    expect((bad.err as SsrfError).reason).toBe("resolved_address");
    expect(bad.err).toBeInstanceOf(SsrfError);
  });

  it("re-validates on every connection, so an answer that changes to private is blocked", async () => {
    let n = 0;
    const g = createSsrfGuard({ resolver: async () => [{ address: n++ === 0 ? "93.184.216.34" : "127.0.0.1", family: 4 }] });
    expect((await lookupOnce(g, "rebind.test")).err).toBeNull();
    expect(((await lookupOnce(g, "rebind.test")).err as SsrfError).reason).toBe("resolved_address");
  });

  it("applies the allowlist to resolved addresses by hostname", async () => {
    const resolver: Resolver = async () => [{ address: "192.168.1.9", family: 4 }];
    expect((await lookupOnce(createSsrfGuard({ resolver }), "nas.lan")).err).toBeInstanceOf(SsrfError);
    expect((await lookupOnce(createSsrfGuard({ resolver, allow: "nas.lan" }), "nas.lan")).err).toBeNull();
    expect((await lookupOnce(createSsrfGuard({ resolver, allow: "192.168.1.0/24" }), "nas.lan")).err).toBeNull();
  });

  it("checks literal hosts too", async () => {
    expect(((await lookupOnce(createSsrfGuard(), "127.0.0.1")).err as SsrfError).reason).toBe("resolved_address");
  });
});
