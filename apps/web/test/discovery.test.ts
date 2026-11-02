import { describe, expect, it } from "vitest";
import { ApiError } from "../lib/api";
import {
  DEFAULTS, MIB, allOffByDefault, bytesText, bytesToMib, defaultText, draftToSettings, filtersActive, filtersToQuery, groupOfField,
  DEFAULT_FILTERS, limitRows, mapServerErrors, mibToBytes, parseField, passLaneSummary, percentUsed, requestsText, runnerHeadline, sameDraft, scoreTable,
  shouldPoll, signed, toDraft, trim6, ALL_NUM_FIELDS, WEIGHT_FIELDS,
  type DiscoverySettings, type EffectiveLimits, type ProfileMaximums, type RunnerStatus, type ScoreComponent,
} from "../lib/discovery";

const PROFILE_MAX: ProfileMaximums = { maxDepth: 10, maxQueued: 50_000, maxCandidates: 50_000, maxRequestsPerDay: 10_000, maxBytesPerDay: 2 * 1024 * MIB };
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const comp = (name: ScoreComponent["name"], raw: number, weight: number): ScoreComponent => ({
  name, label: name, raw, weight, contribution: Math.round(raw * weight * 1e6) / 1e6, explanation: "",
});
const apiError = (fields: { path: string; message: string }[]) => new ApiError(400, "bad_request", "Invalid", { fields: fields.map((f) => ({ in: "body", ...f })) });

describe("formatting", () => {
  it("trims trailing zeros without losing the six decimals the server rounds to", () => {
    expect(trim6(12)).toBe("12");
    expect(trim6(0.5)).toBe("0.5");
    expect(trim6(0.142857)).toBe("0.142857");
    expect(trim6(-0)).toBe("0");
    expect(trim6(-2.5)).toBe("-2.5");
    expect(trim6(Number.NaN)).toBe("0");
  });
  it("signs positive numbers only", () => {
    expect(signed(3)).toBe("+3");
    expect(signed(-3)).toBe("-3");
    expect(signed(0)).toBe("0");
  });
  it("words a budget as text", () => {
    expect(requestsText(12, 50)).toBe("12 of 50 requests used, 38 left");
    expect(requestsText(1, 1)).toBe("1 of 1 request used, 0 left");
    expect(requestsText(0, 0)).toContain("limit 0");
    expect(bytesText(50 * MIB, 100 * MIB, (n) => `${n / MIB} MiB`)).toBe("50 MiB of 100 MiB used, 50 MiB left");
    expect(bytesText(0, 0, (n) => `${n} B`)).toContain("limit 0");
  });
  it("never divides by zero in a meter", () => {
    expect(percentUsed(0, 0)).toBe(0);
    expect(percentUsed(5, 0)).toBe(100);
    expect(percentUsed(25, 50)).toBe(50);
    expect(percentUsed(80, 50)).toBe(100);
    expect(percentUsed(-1, 50)).toBe(0);
  });
  it("converts between bytes and the MiB people type", () => {
    expect(bytesToMib(100 * MIB)).toBe(100);
    expect(mibToBytes(0.5)).toBe(MIB / 2);
    expect(mibToBytes(bytesToMib(123_456_789))).toBeCloseTo(123_456_789, -3);
  });
});

describe("the score table", () => {
  it("adds up: the contributions sum to the score", () => {
    const comps = [comp("inboundArchivedLinks", 0.571429, 30), comp("bookmarks", 0.5, 25), comp("estimatedCost", 0.25, -10), comp("storageHeadroom", 0.3333, -15)];
    const score = Math.round(comps.reduce((t, c) => t + c.contribution, 0) * 1e6) / 1e6;
    const t = scoreTable(comps, score);
    expect(t.addsUp).toBe(true);
    expect(t.rows).toHaveLength(4);
    expect(Number(t.sumText)).toBe(Number(t.scoreText));
    expect(t.rows.map((r) => r.contribution)).toEqual(["+17.14287", "+12.5", "-2.5", "-4.9995"]);
    expect(t.equation).toBe("17.14287 + 12.5 - 2.5 - 4.9995");
  });
  it("says so when the figures do not add up, instead of hiding it", () => {
    const t = scoreTable([comp("bookmarks", 1, 25)], 24);
    expect(t.addsUp).toBe(false);
  });
  it("handles a candidate with no components", () => {
    const t = scoreTable([], 0);
    expect(t.addsUp).toBe(true);
    expect(t.equation).toBe("0");
  });
  it("keeps the order the server sent", () => {
    const t = scoreTable([comp("recentActivity", 1, 10), comp("bookmarks", 1, 25)], 35);
    expect(t.rows.map((r) => r.name)).toEqual(["recentActivity", "bookmarks"]);
  });
});

describe("settings defaults", () => {
  it("has everything off by default, and approval required for search-driven pages", () => {
    expect(allOffByDefault(DEFAULTS)).toBe(true);
    expect(DEFAULTS.searchDriven.requireApproval).toBe(true);
    expect(DEFAULTS.active.mode).toBe("off");
    const on = clone(DEFAULTS);
    on.passive.fromLinks = true;
    expect(allOffByDefault(on)).toBe(false);
  });
  it("describes a default beside each setting", () => {
    expect(defaultText("enabled")).toBe("Default: off");
    expect(defaultText("searchDriven.requireApproval")).toBe("Default: on");
    expect(defaultText("active.maxRequestsPerDay")).toBe("Default: 50");
    expect(defaultText("active.maxBytesPerDay")).toBe("Default: 100 MiB");
    expect(defaultText("ceilings.maxBytesPerDay")).toBe("Default: 512 MiB");
    expect(defaultText("weights.estimatedCost")).toBe("Default: -10");
    expect(defaultText("nonsense")).toBe("");
  });
  it("lists every weight the server has", () => {
    expect(WEIGHT_FIELDS.map((w) => w.name).sort()).toEqual(Object.keys(DEFAULTS.weights).sort());
  });
  it("groups advanced fields so an error can open the right section", () => {
    expect(groupOfField("ceilings.maxBytesPerDay")).toBe("ceilings");
    expect(groupOfField("active.maxDepth")).toBe("limits");
    expect(groupOfField("searchDriven.backgroundBudget.maxRequestsPerDay")).toBe("limits");
    expect(groupOfField("weights.bookmarks")).toBe("weights");
    expect(groupOfField("pool.maxCandidates")).toBe("pool");
    expect(groupOfField("passive.fromLinks")).toBeNull();
    expect(groupOfField("active.mode")).toBeNull();
  });
});

describe("the draft", () => {
  it("round-trips the settings", () => {
    const d = toDraft(DEFAULTS);
    expect(d.nums["active.maxBytesPerDay"]).toBe("100");
    expect(d.bools["passive.fromLinks"]).toBe(false);
    const { settings, errors } = draftToSettings(d, DEFAULTS);
    expect(errors).toEqual({});
    expect(settings).toEqual(DEFAULTS);
  });
  it("notices a change", () => {
    const a = toDraft(DEFAULTS);
    const b = toDraft(DEFAULTS);
    expect(sameDraft(a, b)).toBe(true);
    b.nums["active.maxDepth"] = "2";
    expect(sameDraft(a, b)).toBe(false);
  });
  it("turns MiB into bytes", () => {
    const d = toDraft(DEFAULTS);
    d.nums["active.maxBytesPerDay"] = "50";
    expect(draftToSettings(d, DEFAULTS).settings.active.maxBytesPerDay).toBe(50 * MIB);
  });
  it("reports boxes that are empty, not numbers, fractional or out of range, each at its own path", () => {
    const d = toDraft(DEFAULTS);
    d.nums["active.maxDepth"] = "";
    d.nums["pool.maxCandidates"] = "abc";
    d.nums["active.maxQueued"] = "2.5";
    d.nums["weights.bookmarks"] = "150";
    d.nums["pool.expireAfterDays"] = "0";
    const { errors } = draftToSettings(d, DEFAULTS);
    expect(Object.keys(errors).sort()).toEqual(["active.maxDepth", "active.maxQueued", "pool.expireAfterDays", "pool.maxCandidates", "weights.bookmarks"]);
    expect(errors["active.maxQueued"]).toMatch(/whole number/);
    expect(errors["weights.bookmarks"]).toMatch(/more than 100/);
  });
  it("accepts a decimal weight and a negative score", () => {
    const d = toDraft(DEFAULTS);
    d.nums["weights.bookmarks"] = "12.5";
    d.nums["active.minScore"] = "-5";
    const { settings, errors } = draftToSettings(d, DEFAULTS);
    expect(errors).toEqual({});
    expect(settings.weights.bookmarks).toBe(12.5);
    expect(settings.active.minScore).toBe(-5);
  });
  it("parses a box", () => {
    const bytes = ALL_NUM_FIELDS.find((f) => f.path === "active.maxBytesPerDay")!;
    expect(parseField(bytes, "1.5")).toBe(1.5 * MIB);
    expect(parseField(bytes, " 3 ")).toBe(3 * MIB);
    expect(parseField(bytes, "1e3")).toBeNull();
    expect(parseField(bytes, "")).toBeNull();
  });
});

describe("mapping server validation errors to fields", () => {
  it("maps paths from the discovery route as they are", () => {
    const r = mapServerErrors(apiError([{ path: "ceilings.maxBytesPerDay", message: "The bytes-a-day ceiling cannot be more than 2,147,483,648 on the pi-lite profile." }]));
    expect(r.fields).toEqual({ "ceilings.maxBytesPerDay": expect.stringContaining("cannot be more than") });
    expect(r.general).toEqual([]);
  });
  it("strips the discovery. prefix used by the general settings route", () => {
    const r = mapServerErrors(apiError([{ path: "discovery.active.maxDepth", message: "Depth cannot be more than 3." }]));
    expect(Object.keys(r.fields)).toEqual(["active.maxDepth"]);
  });
  it("shows the missing acknowledgement on the active mode", () => {
    const r = mapServerErrors(apiError([{ path: "discovery.acknowledged", message: "Confirm that before turning it on." }]));
    expect(Object.keys(r.fields)).toEqual(["active.mode"]);
  });
  it("maps a list item to the list", () => {
    const r = mapServerErrors(apiError([{ path: "active.allowedSourceIds", message: "These sources do not exist: src_x." }]));
    expect(Object.keys(r.fields)).toEqual(["active.allowedSourceIds"]);
    const item = mapServerErrors(apiError([{ path: "active.allowedSourceIds.2", message: "Too long." }]));
    expect(Object.keys(item.fields)).toEqual(["active.allowedSourceIds"]);
  });
  it("keeps what matches no field, so it is not lost", () => {
    const r = mapServerErrors(apiError([{ path: "mystery.field", message: "Odd." }, { path: "", message: "Send an object." }]));
    expect(r.fields).toEqual({});
    expect(r.general).toEqual(["Odd."]);
  });
  it("falls back to the message when the error has no details", () => {
    const r = mapServerErrors(new ApiError(409, "conflict", "That conflicts."));
    expect(r.general).toEqual(["That conflicts."]);
    expect(mapServerErrors(new Error("x"))).toEqual({ fields: {}, general: [] });
  });
});

describe("limits in force", () => {
  const effective = (o: Partial<EffectiveLimits> = {}): EffectiveLimits => ({
    maxDepth: 1, maxQueued: 20, maxCandidatesPerRun: 10, maxCandidates: 500, active: { maxRequestsPerDay: 50, maxBytesPerDay: 100 * MIB },
    background: { maxRequestsPerDay: 50, maxBytesPerDay: 100 * MIB }, perSiteDailyCap: 10, ...o,
  });
  it("shows no cap when the settings are in force", () => {
    const rows = limitRows(DEFAULTS, effective(), PROFILE_MAX, "standard");
    expect(rows.every((r) => !r.capped && r.reason === undefined)).toBe(true);
    expect(rows.find((r) => r.key === "activeBytes")?.effective).toBe("100 MiB");
  });
  it("explains a cap by the profile maximum after the profile was lowered", () => {
    const s = clone(DEFAULTS);
    s.active.maxDepth = 3;
    s.ceilings.maxDepth = 3;
    const low = { ...PROFILE_MAX, maxDepth: 2 };
    const rows = limitRows(s, effective({ maxDepth: 2 }), low, "pi-lite");
    const depth = rows.find((r) => r.key === "maxDepth")!;
    expect(depth.capped).toBe(true);
    expect(depth.reason).toBe("Capped by the pi-lite profile maximum (2).");
  });
  it("explains a cap by the global ceiling", () => {
    const s = clone(DEFAULTS);
    s.active.maxRequestsPerDay = 300;
    const rows = limitRows(s, effective({ active: { maxRequestsPerDay: 200, maxBytesPerDay: 100 * MIB } }), PROFILE_MAX, "standard");
    expect(rows.find((r) => r.key === "activeRequests")!.reason).toBe("Capped by the global ceiling (200).");
  });
});

describe("runner words and polling", () => {
  const runner = (o: Partial<RunnerStatus>): RunnerStatus => ({
    state: "idle", mode: "approval", blockedBy: [], killSwitch: { paused: false }, inFlight: 0, timerSeconds: 30,
    gates: { enabled: true, online: true, windowOpen: true, resourcesOk: true, storageRoomBytes: 0 }, ...o,
  });
  it("says what is happening in plain words", () => {
    expect(runnerHeadline(runner({ state: "off" }))).toMatch(/off/);
    expect(runnerHeadline(runner({ state: "paused" }))).toMatch(/kill switch/);
    expect(runnerHeadline(runner({ state: "blocked" }))).toMatch(/held back/);
    expect(runnerHeadline(runner({ mode: "approval" }))).toMatch(/every 30 seconds/);
    expect(runnerHeadline(runner({ mode: "off" }))).toMatch(/nothing is downloaded/);
  });
  it("summarises a pass, with the reasons for skipping", () => {
    const s = passLaneSummary("Active", { eligible: 3, started: 1, skipped: { site_cap: 2, bytes: 0 }, blockedBy: [] });
    expect(s).toBe("Active: 1 of 3 eligible pages started. skipped: 2 (the limit for one site today was reached).");
    expect(passLaneSummary("Background", { eligible: 0, started: 0, skipped: {}, blockedBy: ["search_driven_off", "kill_switch"] })).toContain("held back: search-driven downloads are switched off; the kill switch is on");
  });
  it("polls only while there is work", () => {
    expect(shouldPoll(undefined, false)).toBe(false);
    expect(shouldPoll(undefined, true)).toBe(true);
    expect(shouldPoll(runner({ inFlight: 2 }), false)).toBe(true);
    expect(shouldPoll(runner({ inFlight: 0 }), false)).toBe(false);
    expect(shouldPoll(runner({ inFlight: 2, state: "off" }), false)).toBe(false);
  });
});

describe("candidate filters", () => {
  it("builds the query for the defaults", () => {
    expect(filtersToQuery(DEFAULT_FILTERS)).toBe("state=new&sort=score&limit=25");
  });
  it("leaves out empty filters, asks for every state with all, and carries the cursor", () => {
    const q = new URLSearchParams(filtersToQuery({ ...DEFAULT_FILTERS, state: "all", q: " bread ", host: "example.org", provenance: "link", minScore: "5", maxScore: "x" }, "40"));
    expect(q.get("state")).toBeNull();
    expect(q.get("q")).toBe("bread");
    expect(q.get("host")).toBe("example.org");
    expect(q.get("provenance")).toBe("link");
    expect(q.get("minScore")).toBe("5");
    expect(q.get("maxScore")).toBeNull();
    expect(q.get("cursor")).toBe("40");
  });
  it("knows when a filter is in use", () => {
    expect(filtersActive(DEFAULT_FILTERS)).toBe(false);
    expect(filtersActive({ ...DEFAULT_FILTERS, host: "a.b" })).toBe(true);
    expect(filtersActive({ ...DEFAULT_FILTERS, state: "approved", sort: "recent" })).toBe(false);
  });
});
