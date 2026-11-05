// Pure calibration math (no DOM).
import type { Readings } from "./smoothing";

export type Key = keyof Readings;
export const CAL_KEYS: Key[] = ["yaw", "pitch", "gazeH", "gazeV", "blendH"];
export type Stats = Record<Key, number | null>;

export function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Sample standard deviation (n - 1). null for fewer than 2 values. */
export function std(xs: number[]): number | null {
  if (xs.length < 2) return null;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1));
}

const col = (rs: Readings[], k: Key) => rs.map((r) => r[k]).filter((v): v is number => v !== null && !Number.isNaN(v));

/** Baseline = median of each reading, noise = its standard deviation. */
export function summarizeReadings(rs: Readings[]): { baseline: Stats; noise: Stats; n: number } {
  const baseline = {} as Stats;
  const noise = {} as Stats;
  for (const k of CAL_KEYS) {
    const c = col(rs, k);
    baseline[k] = median(c);
    noise[k] = std(c);
  }
  return { baseline, noise, n: rs.length };
}

export interface CalibrationSample {
  /** smoothed values (these feed the look-away decisions) */
  s: Readings;
  /** raw values */
  r: Readings;
}

export interface CalibrationResult {
  baseline: Stats;
  noise: Stats;
  baselineRaw: Stats;
  noiseRaw: Stats;
  samples: number;
  edges: { left: Stats; right: Stats; leftRaw: Stats; rightRaw: Stats };
}

export function buildCalibration(
  center: CalibrationSample[],
  left: CalibrationSample[],
  right: CalibrationSample[],
): CalibrationResult {
  const c = summarizeReadings(center.map((x) => x.s));
  const cr = summarizeReadings(center.map((x) => x.r));
  return {
    baseline: c.baseline,
    noise: c.noise,
    baselineRaw: cr.baseline,
    noiseRaw: cr.noise,
    samples: center.length,
    edges: {
      left: summarizeReadings(left.map((x) => x.s)).baseline,
      right: summarizeReadings(right.map((x) => x.s)).baseline,
      leftRaw: summarizeReadings(left.map((x) => x.r)).baseline,
      rightRaw: summarizeReadings(right.map((x) => x.r)).baseline,
    },
  };
}
