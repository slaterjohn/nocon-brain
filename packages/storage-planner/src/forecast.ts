const DAY_MS = 86_400_000;
/** Used when nothing has been saved yet: half a MiB per page is a rough figure for an HTML page with its assets. */
export const DEFAULT_BYTES_PER_PAGE = 512 * 1024;

export interface ForecastSource {
  id: string;
  name: string;
  /** Pages saved so far and the bytes they use (stored bytes, counted once). */
  observedPages: number;
  observedBytes: number;
  /** Pages the source is still expected to add (for example the remainder of a crawl limit). */
  plannedPages: number;
}

export interface ForecastInput {
  now: number;
  horizonDays: number;
  usedBytes: number;
  /** Room left before the hard floor: free space above the reserve, capped by the quota. */
  availableBytes: number;
  /** Bytes added per day for the most recent days that have data, oldest first. Days with no activity are 0 entries. */
  history: readonly { dayStart: number; bytesAdded: number }[];
  sources: readonly ForecastSource[];
}

export interface Band {
  low: number;
  high: number;
}

export interface StorageForecast {
  /** Always true: this is an estimate, never a measurement. The UI must label it as one. */
  estimate: true;
  horizonDays: number;
  /** Used bytes at the end of the horizon, as a low and a high estimate. There is no single-point figure. */
  projectedUsedBytes: Band;
  projectedFullAt?: { earliest: string; latest?: string };
  growthBytesPerDay: Band;
  perSource: { sourceId: string; name: string; observedPages: number; bytesPerPage: Band; plannedPages: number; plannedBytes: Band }[];
  confidence: "low" | "medium";
  assumptions: string[];
}

const round = (n: number): number => Math.max(0, Math.round(n));

function stats(xs: number[]): { mean: number; sd: number } {
  if (xs.length === 0) return { mean: 0, sd: 0 };
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length);
  return { mean, sd };
}

/**
 * Forecast storage use (task T-08). Pure and deterministic for a fixed input. Everything it returns is an estimate: the result
 * carries `estimate: true`, every figure is a low/high band, and `assumptions` says in words what the bands rest on.
 *
 * Method: the recent daily growth gives a mean and a spread (low = mean - 1 sd, high = mean + 1 sd); each source's planned pages are
 * priced at its observed bytes per page (low 0.7x, high 1.5x; the archive-wide average, or a stated default, where the source has no
 * pages yet); planned pages are added on top of the trend and spread evenly over the horizon.
 */
export function forecastStorage(input: ForecastInput): StorageForecast {
  const h = Math.max(1, Math.floor(input.horizonDays));
  const assumptions: string[] = [];
  const days = input.history.map((d) => d.bytesAdded);
  let { mean, sd } = stats(days);
  const sparse = days.length < 3;
  if (sparse) {
    sd = Math.max(sd, mean); // not enough days to know the spread: widen the band to 0..2x the average
    assumptions.push(days.length === 0 ? "There is no saving history yet, so no trend is assumed." : `Only ${days.length} day${days.length === 1 ? "" : "s"} of history exist, so the band is wide.`);
  } else {
    assumptions.push(`Growth follows the average of the last ${days.length} days (${Math.round(mean).toLocaleString("en-GB")} bytes a day), plus or minus one standard deviation.`);
  }
  const rate: Band = { low: Math.max(0, mean - sd), high: mean + sd };

  const totalPages = input.sources.reduce((n, s) => n + s.observedPages, 0);
  const totalBytes = input.sources.reduce((n, s) => n + s.observedBytes, 0);
  const archiveAvg = totalPages > 0 ? totalBytes / totalPages : DEFAULT_BYTES_PER_PAGE;
  let usedDefault = false;
  const perSource = [...input.sources]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((s) => {
      const bpp = s.observedPages > 0 ? s.observedBytes / s.observedPages : archiveAvg;
      if (s.observedPages === 0 && totalPages === 0 && s.plannedPages > 0) usedDefault = true;
      const band: Band = { low: round(bpp * 0.7), high: round(bpp * 1.5) };
      return {
        sourceId: s.id, name: s.name, observedPages: s.observedPages, bytesPerPage: band, plannedPages: s.plannedPages,
        plannedBytes: { low: round(band.low * s.plannedPages), high: round(band.high * s.plannedPages) },
      };
    });
  const planned: Band = {
    low: perSource.reduce((n, s) => n + s.plannedBytes.low, 0), high: perSource.reduce((n, s) => n + s.plannedBytes.high, 0),
  };
  if (planned.high > 0) {
    assumptions.push("Planned pages are priced at each source's observed size per page (70% to 150%) and arrive evenly over the period, in addition to the trend.");
    if (usedDefault) assumptions.push(`Sources with no saved pages use a default of ${DEFAULT_BYTES_PER_PAGE.toLocaleString("en-GB")} bytes a page.`);
  }
  assumptions.push("Content that is evicted or deleted in the meantime is not subtracted, and new sources that do not exist yet are not included.");

  const projectedUsedBytes: Band = { low: round(input.usedBytes + rate.low * h + planned.low), high: round(input.usedBytes + rate.high * h + planned.high) };
  const daily: Band = { low: rate.low + planned.low / h, high: rate.high + planned.high / h };
  const out: StorageForecast = {
    estimate: true, horizonDays: h, projectedUsedBytes, growthBytesPerDay: { low: round(daily.low), high: round(daily.high) }, perSource,
    confidence: sparse ? "low" : "medium", assumptions,
  };
  if (daily.high > 0 && input.availableBytes >= 0) {
    const earliestDays = input.availableBytes / daily.high;
    if (earliestDays <= 3650) {
      out.projectedFullAt = { earliest: new Date(input.now + earliestDays * DAY_MS).toISOString() };
      if (daily.low > 0 && input.availableBytes / daily.low <= 3650) out.projectedFullAt.latest = new Date(input.now + (input.availableBytes / daily.low) * DAY_MS).toISOString();
    }
  }
  return out;
}
