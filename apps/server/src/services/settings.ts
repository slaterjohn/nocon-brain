import { z } from "zod";
import type { Clock, ResolvedConfig } from "@ncb/shared";
import type { Db } from "@ncb/db";
import { AppError } from "@ncb/shared";
import { decryptSecret, encryptSecret } from "../lib/secrets.js";
import { RequestValidationError, type FieldIssue } from "../lib/zod.js";
import { buildDiscoverySchema, validateDiscoverySettings } from "../discovery/settings.js";

export const DISCLOSURE_TEXT =
  "Online search sends the words you type to the search providers you enable. Those providers can see the query and your server's IP address. " +
  "Nothing is sent while online search is switched off or while the server is working offline.";

export const P2_PERMIT_WARNING =
  "With this on, when space runs short NoConBrain may delete Important (P2) content after all Standard and Opportunistic content has gone. " +
  "Protected (P1) content is never deleted automatically. Deleted copies can be downloaded again only while the original sites still have them.";

/** `true` where a group field is a secret: stored encrypted, never returned (a `has<Field>` flag is returned instead). */
export type SecretFields = Record<string, string[]>;

const bool = (d: boolean) => z.boolean().default(d);
const intIn = (d: number, min: number, max: number) => z.number().int().min(min).max(max).default(d);

/** The settings groups of docs/api.md section 12. The schemas hold the documented defaults. */
export function buildGroupSchemas(config: ResolvedConfig) {
  return {
    general: z.object({
      appName: z.string().trim().min(1, "Enter a name").max(60).default("NoConBrain"),
      locale: z.literal("en-GB").default("en-GB"),
    }),
    resources: z.object({
      profile: z.enum(["pi-lite", "standard"]).default(config.resourceProfile),
      maxFetchConcurrency: intIn(config.NCB_MAX_FETCH_CONCURRENCY, 1, 64),
      perHostConcurrency: intIn(config.NCB_PER_HOST_CONCURRENCY, 1, 16),
      /** A floor for the pause between two requests to one host (0 leaves it to each crawl's own politeness). The profile step sets 1500 (pi-lite) or 1000 (standard). */
      perHostDelayMs: intIn(0, 0, 60_000),
      extractWorkers: intIn(config.NCB_EXTRACT_WORKERS, 0, 16),
      workerMemoryMb: intIn(config.NCB_WORKER_MEMORY_MB, 16, 16384),
      /** Pages rendered at once, read live by the renderer (C-16). `NCB_RENDER_CONCURRENCY` is only the default. */
      renderConcurrency: intIn(config.NCB_RENDER_CONCURRENCY, 0, 8),
      /** Kilobits per second for all response bodies together. 0 means no limit. */
      bandwidthLimitKbps: intIn(0, 0, 10_000_000).describe("0 means no limit"),
      /** Slows background work while the event loop lags or the machine is loaded. */
      cpuThrottle: z.enum(["off", "low", "medium"]).default("low"),
    }),
    privacy: z.object({
      history: z.object({ enabled: bool(true) }).default({ enabled: true }),
      searchHistory: z.object({ enabled: bool(true) }).default({ enabled: true }),
      onlineSearch: z
        .object({
          enabled: bool(false),
          acknowledgedAt: z.iso.datetime().nullable().default(null),
        })
        .default({ enabled: false, acknowledgedAt: null }),
    }),
    offline: z.object({
      forced: bool(false),
      probeUrl: z.union([z.literal(""), z.url({ protocol: /^https?$/, error: "Enter an http or https address, or leave this empty" })]).default(config.NCB_CONNECTIVITY_PROBE_URL),
      probeIntervalSeconds: intIn(60, 10, 3600),
      probeToken: z.string().max(512).nullable().default(null).meta({ writeOnly: true, description: "Optional bearer token sent with the probe. Never returned." }),
    }),
    browser: z.object({
      showLinkStates: bool(true),
      liveFrames: bool(false),
      bookmarkPriority: intIn(2, 1, 4),
      autoCacheOpened: bool(false),
      /** When a page is both saved and reachable live: open the saved copy (true) or the live site (false). */
      preferCached: bool(true),
      /** Priority of pages saved from the address bar ("Quick saves", P3 by default). */
      quickSavePriority: intIn(3, 1, 4),
    }),
    search: z.object({
      rrfK: intIn(60, 1, 1000),
      rrfLocalWeight: z.number().min(0).max(10).default(1.5),
      rrfProviderWeight: z.number().min(0).max(10).default(1),
      /** Weight of each ZIM list (Phase 8 supplies the lists). */
      rrfZimWeight: z.number().min(0).max(10).default(1),
      /** Multiplier for a provider whose results overlap an earlier provider's by at least half. */
      rrfSecondaryProviderWeight: z.number().min(0).max(10).default(0.7),
      /** How many results of each list take part in the fusion. */
      onlineTopN: intIn(30, 5, 100),
      /** Hard stop for one round of provider requests in a search session. */
      onlineDeadlineMs: intIn(10_000, 1000, 60_000),
      zimSearchBudgetMs: intIn(config.NCB_ZIM_SEARCH_BUDGET_MS, 100, 10_000),
      /** Most knowledge packages queried for one search (task Z-05). */
      zimMaxPackagesPerSearch: intIn(5, 1, 20),
      /** Hits taken from each package for fusion. */
      zimHitsPerPackage: intIn(20, 1, 50),
    }),
    /** Phase 7 (docs/api.md "Discovery (Phase 7, as built)"). Everything is off by default. */
    discovery: buildDiscoverySchema(),
    storage: z.object({
      /** Lets automatic eviction reclaim Important (P2) content, last. Protected (P1) content is never evicted, whatever this says. */
      permitImportantEviction: bool(false),
      /** When the Human turned the permit on (the confirmation they gave). Set by the server. */
      permitAcknowledgedAt: z.iso.datetime().nullable().default(null),
      /** Slow Opportunistic (P4) downloads while a volume is above its soft threshold. */
      throttleOpportunistic: bool(true),
      /** Remove copies that no source's retention rule keeps any more when tidying up. */
      pruneSurplusVersions: bool(true),
      /** How long an unused file is kept before it is deleted. */
      orphanGraceSeconds: intIn(86_400, 0, 31_536_000),
      /** Free space automatically when a volume passes its eviction-start threshold. Off means eviction only runs when asked. */
      autoEviction: bool(true),
      /** Most bytes one tidy-up (not a space-pressure run) removes. Empty means no limit. */
      maxEvictionBatchBytes: z.number().int().min(1).nullable().default(null),
      /** How far ahead the forecast looks. */
      forecastHorizonDays: intIn(30, 7, 365),
      /** Hash check ("scrub") budget per maintenance pass, in megabytes. 0 turns the scrub off. */
      scrubMegabytesPerRun: intIn(64, 0, 4096),
    }),
    logging: z.object({
      level: z.enum(["debug", "info", "warn", "error"]).default("info"),
      retentionDays: intIn(config.NCB_ACTIVITY_LOG_RETENTION_DAYS, 1, 3650),
    }),
    appearance: z.object({
      theme: z.enum(["system", "light", "dark"]).default("system"),
      accentHue: intIn(220, 0, 360),
    }),
  };
}

export type GroupSchemas = ReturnType<typeof buildGroupSchemas>;
export type GroupName = keyof GroupSchemas;
export const GROUP_NAMES = [
  "general", "resources", "privacy", "offline", "browser", "search", "discovery", "storage", "logging", "appearance",
] as const satisfies readonly GroupName[];

const SECRETS: SecretFields = { offline: ["probeToken"] };

export const userSettingsSchema = z.object({
  theme: z.enum(["system", "light", "dark"]).default("system"),
  density: z.enum(["comfortable", "compact"]).default("comfortable"),
  tabRestore: z.boolean().default(true),
  shortcuts: z.record(z.string().max(40), z.string().max(40)).default({}),
  search: z.object({
    homepageSections: z.object({
      recentSearches: z.boolean().default(false), bookmarks: z.boolean().default(false), favourites: z.boolean().default(false), libraryStats: z.boolean().default(false),
    }).default({ recentSearches: false, bookmarks: false, favourites: false, libraryStats: false }),
    resultsPerPage: z.number().int().min(1).max(50).default(10),
    /** How knowledge-package hits join search results: mixed into the list, in their own groups, or not asked at all (Phase 8 interface). */
    zimResults: z.enum(["unified", "federated", "off"]).default("unified"),
  }).default({ homepageSections: { recentSearches: false, bookmarks: false, favourites: false, libraryStats: false }, resultsPerPage: 10, zimResults: "unified" }),
});

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

function deepMerge(base: unknown, patch: unknown): unknown {
  if (!isObj(base) || !isObj(patch)) return patch;
  const out: Json = { ...base };
  for (const [k, v] of Object.entries(patch)) out[k] = k in base ? deepMerge(base[k], v) : v;
  return out;
}

export type SettingsListener = (group: GroupName, next: Json, previous: Json) => void;

export interface SettingsServiceOptions {
  db: Db;
  clock: Clock;
  config: ResolvedConfig;
  secretKey: Buffer;
}

/**
 * Settings groups stored one row each in `settings` (key = group name, value = the validated group as JSON).
 * Secrets are encrypted at rest and never returned. A patch merges into the current group, is validated
 * against the whole group, and the response paths name the exact field (`offline.probeUrl`).
 */
export class SettingsService {
  readonly schemas: GroupSchemas;
  private readonly listeners = new Set<SettingsListener>();
  private cache = new Map<GroupName, Json>();

  constructor(private readonly o: SettingsServiceOptions) {
    this.schemas = buildGroupSchemas(o.config);
  }

  onChange(fn: SettingsListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Raw stored group merged over defaults. Secrets are decrypted only by `secret()`. */
  private load(group: GroupName): Json {
    const cached = this.cache.get(group);
    if (cached) return cached;
    const row = this.o.db.get<{ value_json: string }>("SELECT value_json FROM settings WHERE key = ?", [group]);
    let stored: unknown = {};
    if (row) {
      try {
        stored = JSON.parse(row.value_json);
      } catch {
        stored = {};
      }
    }
    const parsed = this.schemas[group].safeParse(stored);
    const value = (parsed.success ? parsed.data : this.schemas[group].parse({})) as Json;
    this.cache.set(group, value);
    return value;
  }

  /** Public view of one group: secret fields removed and replaced with a `has<Field>` flag. */
  get(group: GroupName): Json {
    const value = structuredClone(this.load(group));
    for (const f of SECRETS[group] ?? []) {
      const has = typeof value[f] === "string" && value[f] !== "";
      delete value[f];
      value[`has${f[0]!.toUpperCase()}${f.slice(1)}`] = has;
    }
    return value;
  }

  getAll(): Record<GroupName, Json> {
    return Object.fromEntries(GROUP_NAMES.map((g) => [g, this.get(g)])) as Record<GroupName, Json>;
  }

  /** Unredacted value for server-side use. Never put the result in a response. */
  internal<G extends GroupName>(group: G): z.output<GroupSchemas[G]> {
    return this.load(group) as z.output<GroupSchemas[G]>;
  }

  /** A decrypted secret, or undefined. */
  secret(group: GroupName, field: string): string | undefined {
    const v = this.load(group)[field];
    if (typeof v !== "string" || v === "") return undefined;
    try {
      return decryptSecret(this.o.secretKey, v);
    } catch {
      return undefined;
    }
  }

  /**
   * Applies a partial update to one or more groups. Unknown groups are ignored. Throws a 400 with field
   * errors if any value is invalid; nothing is written in that case.
   */
  patch(body: unknown, userId?: number): { applied: GroupName[]; disclosure?: string; warning?: string } {
    if (!isObj(body)) throw new RequestValidationError([{ in: "body", path: "", message: "Send an object of settings groups." }]);
    const fields: FieldIssue[] = [];
    const next = new Map<GroupName, Json>();
    let disclosure: string | undefined;
    let warning: string | undefined;

    for (const g of GROUP_NAMES) {
      const patch = body[g];
      if (patch === undefined) continue;
      if (!isObj(patch)) {
        fields.push({ in: "body", path: g, message: "Expected an object." });
        continue;
      }
      const previous = this.load(g);
      const merged = deepMerge(previous, patch);
      const parsed = this.schemas[g].safeParse(this.withEncryptedPlaceholders(g, merged, patch));
      if (!parsed.success) {
        for (const i of parsed.error.issues) fields.push({ in: "body", path: [g, ...i.path.map(String)].join("."), message: i.message });
        continue;
      }
      const value = parsed.data as Json;

      if (g === "privacy") {
        const online = value.onlineSearch as { enabled: boolean; acknowledgedAt: string | null };
        const was = (previous.onlineSearch as { enabled: boolean }).enabled;
        const ack = isObj(patch.onlineSearch) ? patch.onlineSearch.acknowledged : undefined;
        if (online.enabled && !was) {
          disclosure = DISCLOSURE_TEXT;
          if (ack !== true && !online.acknowledgedAt) {
            fields.push({ in: "body", path: "privacy.onlineSearch.acknowledged", message: "Read the disclosure and confirm before turning on online search." });
            continue;
          }
          if (ack === true) online.acknowledgedAt = new Date(this.o.clock.now()).toISOString();
        }
      }

      if (g === "discovery") {
        const profile = ((next.get("resources") ?? this.load("resources")).profile as "pi-lite" | "standard") ?? "standard";
        const d = value as unknown as ReturnType<typeof buildDiscoverySchema>["_output"];
        for (const i of validateDiscoverySettings(d, profile)) fields.push({ in: "body", path: `discovery.${i.path}`, message: i.message });
        const prev = previous.active as { mode: string; automaticAcknowledgedAt?: string | null };
        // The confirmation time is the server's to set: a request cannot supply it.
        d.active.automaticAcknowledgedAt = prev.automaticAcknowledgedAt ?? null;
        if (d.active.mode === "automatic" && prev.mode !== "automatic") {
          if (patch.acknowledged !== true) {
            fields.push({ in: "body", path: "discovery.acknowledged", message: "Automatic mode downloads pages without asking each time. Confirm that before turning it on." });
            continue;
          }
          if (patch.acknowledged === true) d.active.automaticAcknowledgedAt = new Date(this.o.clock.now()).toISOString();
        }
        if (d.active.mode !== "automatic") d.active.automaticAcknowledgedAt = null;
        if (fields.length) continue;
      }

      if (g === "storage") {
        const turnedOn = value.permitImportantEviction === true && previous.permitImportantEviction !== true;
        if (turnedOn) {
          warning = P2_PERMIT_WARNING;
          if (patch.acknowledged !== true) {
            fields.push({ in: "body", path: "storage.acknowledged", message: "Read the warning and confirm before letting Important content be removed automatically." });
            continue;
          }
          value.permitAcknowledgedAt = new Date(this.o.clock.now()).toISOString();
        }
        if (value.permitImportantEviction === false) value.permitAcknowledgedAt = null;
      }

      // Secrets: encrypt whatever the patch supplied (null clears).
      for (const f of SECRETS[g] ?? []) {
        if (f in patch) {
          const plain = patch[f];
          value[f] = typeof plain === "string" && plain !== "" ? encryptSecret(this.o.secretKey, plain) : null;
        } else {
          value[f] = previous[f] ?? null;
        }
      }
      next.set(g, value);
    }

    if (fields.length) throw new RequestValidationError(fields);
    if (next.size === 0) throw new AppError("bad_request", "Nothing to change. Send at least one known settings group.");

    const now = this.o.clock.now();
    const previousValues = new Map<GroupName, Json>();
    this.o.db.transaction(
      () => {
        for (const [g, value] of next) {
          previousValues.set(g, this.load(g));
          this.o.db.run(
            `INSERT INTO settings (key, value_json, updated_at, updated_by) VALUES (?, ?, ?, ?)
             ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
            [g, JSON.stringify(value), now, userId ?? null],
          );
        }
      },
      { durable: true },
    );
    for (const [g, value] of next) {
      this.cache.set(g, value);
      for (const l of this.listeners) l(g, value, previousValues.get(g)!);
    }
    return { applied: [...next.keys()], ...(disclosure ? { disclosure } : {}), ...(warning ? { warning } : {}) };
  }

  /**
   * Secret fields in a merged group still hold the stored ciphertext (or the plain text the patch
   * supplied). Validation checks the shape only, so swap a ciphertext for a placeholder of valid type.
   */
  private withEncryptedPlaceholders(group: GroupName, merged: unknown, patch: Json): unknown {
    const fields = SECRETS[group];
    if (!fields || !isObj(merged)) return merged;
    const out: Json = { ...merged };
    for (const f of fields) if (!(f in patch) && typeof out[f] === "string") out[f] = "stored";
    return out;
  }

  // ---- per-user settings ---------------------------------------------------------------------

  getUser(userId: number): z.output<typeof userSettingsSchema> {
    const rows = this.o.db.all<{ key: string; value_json: string }>("SELECT key, value_json FROM user_settings WHERE user_id = ?", [userId]);
    const raw: Json = {};
    for (const r of rows) {
      try {
        raw[r.key] = JSON.parse(r.value_json);
      } catch {
        /* ignore a corrupt row */
      }
    }
    const parsed = userSettingsSchema.safeParse(raw);
    return parsed.success ? parsed.data : userSettingsSchema.parse({});
  }

  patchUser(userId: number, patch: unknown): z.output<typeof userSettingsSchema> {
    const merged = deepMerge(this.getUser(userId), patch);
    const parsed = userSettingsSchema.safeParse(merged);
    if (!parsed.success) {
      throw new RequestValidationError(parsed.error.issues.map((i) => ({ in: "body" as const, path: i.path.map(String).join("."), message: i.message })));
    }
    const now = this.o.clock.now();
    this.o.db.transaction(() => {
      for (const [k, v] of Object.entries(parsed.data)) {
        this.o.db.run(
          `INSERT INTO user_settings (user_id, key, value_json, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(user_id, key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
          [userId, k, JSON.stringify(v), now],
        );
      }
    }, { durable: true });
    return parsed.data;
  }

  /** JSON Schema for the settings UI. Secret fields are marked `writeOnly`. */
  jsonSchema(): unknown {
    return z.toJSONSchema(z.object(this.schemas), { io: "input", unrepresentable: "any" });
  }
}
