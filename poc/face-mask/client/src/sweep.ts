// Pure logic for the speed sweep (no DOM).
import { std } from "./calibration";
import { percentile } from "./math";

export const SWEEP_PLAN: { delegate: "GPU" | "CPU"; detect: number }[] = [
  { delegate: "GPU", detect: 640 },
  { delegate: "GPU", detect: 480 },
  { delegate: "GPU", detect: 320 },
  { delegate: "CPU", detect: 640 },
  { delegate: "CPU", detect: 480 },
  { delegate: "CPU", detect: 320 },
];

export interface SweepSample {
  /** ms, any origin */
  t: number;
  lost: boolean;
  detectMs: number;
  yawRaw: number | null;
  yaw: number | null;
  gazeHRaw: number | null;
  gazeH: number | null;
  blendHRaw: number | null;
  blendH: number | null;
}

export type StdKey = "yawRaw" | "yaw" | "gazeHRaw" | "gazeH" | "blendHRaw" | "blendH";
const STD_KEYS: StdKey[] = ["yawRaw", "yaw", "gazeHRaw", "gazeH", "blendHRaw", "blendH"];

export interface SweepResult {
  delegate: "GPU" | "CPU";
  detect: number;
  available: boolean;
  note?: string;
  frames: number;
  lostFrames: number;
  avgFps: number | null;
  p10Fps: number | null;
  meanDetectMs: number | null;
  std: Record<StdKey, number | null>;
}

const emptyStd = (): Record<StdKey, number | null> => ({ yawRaw: null, yaw: null, gazeHRaw: null, gazeH: null, blendHRaw: null, blendH: null });

export function unavailable(delegate: "GPU" | "CPU", detect: number, note: string): SweepResult {
  return { delegate, detect, available: false, note, frames: 0, lostFrames: 0, avgFps: null, p10Fps: null, meanDetectMs: null, std: emptyStd() };
}

/** Average fps, 10th-percentile fps, mean detect ms and std of the readings for one delegate/size combination. */
export function summarizeSweep(delegate: "GPU" | "CPU", detect: number, samples: SweepSample[]): SweepResult {
  const n = samples.length;
  if (n < 2) return unavailable(delegate, detect, "too few frames");
  const inst: number[] = [];
  for (let i = 1; i < n; i++) {
    const dt = samples[i].t - samples[i - 1].t;
    if (dt > 0) inst.push(1000 / dt);
  }
  const durS = (samples[n - 1].t - samples[0].t) / 1000;
  const tracked = samples.filter((s) => !s.lost);
  const out = emptyStd();
  for (const k of STD_KEYS) {
    out[k] = std(tracked.map((s) => s[k]).filter((v): v is number => v !== null));
  }
  return {
    delegate,
    detect,
    available: true,
    frames: n,
    lostFrames: n - tracked.length,
    avgFps: durS > 0 ? (n - 1) / durS : null,
    p10Fps: percentile(inst, 10),
    meanDetectMs: samples.reduce((a, s) => a + s.detectMs, 0) / n,
    std: out,
  };
}

/** Same rule as analysis/test1_speed.py. */
export function speedLabel(avgFps: number | null): "PASS" | "OK (minimum)" | "FAIL" {
  if (avgFps === null) return "FAIL";
  if (avgFps >= 15) return "PASS";
  if (avgFps >= 10) return "OK (minimum)";
  return "FAIL";
}
