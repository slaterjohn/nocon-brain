export type ResourceProfileName = "pi-lite" | "standard";
export type CpuThrottleLevel = "off" | "low" | "medium";

export interface ResourcePreset {
  maxFetchConcurrency: number;
  perHostConcurrency: number;
  perHostDelayMs: number;
  extractWorkers: number;
  workerMemoryMb: number;
  renderConcurrency: number;
  cpuThrottle: CpuThrottleLevel;
}

/**
 * The profile presets of docs/architecture.md section 10. `pi-lite` is the conservative one: two fetches at a time, one per
 * host with a pause between requests, one extraction worker in a 256 MB heap, one render at a time, and CPU throttling that
 * reacts early. Applied by `POST /api/setup/profile`.
 */
export const RESOURCE_PRESETS: Record<ResourceProfileName, ResourcePreset> = {
  "pi-lite": {
    maxFetchConcurrency: 2, perHostConcurrency: 1, perHostDelayMs: 1500, extractWorkers: 1, workerMemoryMb: 256, renderConcurrency: 1, cpuThrottle: "medium",
  },
  standard: {
    maxFetchConcurrency: 6, perHostConcurrency: 1, perHostDelayMs: 1000, extractWorkers: 2, workerMemoryMb: 512, renderConcurrency: 1, cpuThrottle: "low",
  },
};

/** When the CPU guard steps in. `medium` reacts earlier than `low`; both release at about half the lag and 80% of the load. */
export const THROTTLE_THRESHOLDS: Record<Exclude<CpuThrottleLevel, "off">, { lagMs: number; loadPerCore: number }> = {
  low: { lagMs: 250, loadPerCore: 2 },
  medium: { lagMs: 100, loadPerCore: 1.25 },
};
