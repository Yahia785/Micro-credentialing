import { describe, expect, it } from "vitest";
import { buildCalibration, median, std, summarizeReadings, type CalibrationSample } from "../src/calibration";
import { ONE_EURO_GAZE, ONE_EURO_POSE } from "../src/config";
import { blendshapeGazeH, faceShape, type Landmark } from "../src/math";
import { OneEuroFilter } from "../src/oneEuro";
import { evaluateSetup, faceBoxFromLandmarks, lumaStats } from "../src/setup";
import { ReadingSmoother, type Readings } from "../src/smoothing";

/** Small deterministic noise source in [-1, 1]. */
function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return (s / 4294967296) * 2 - 1;
  };
}
const sd = (xs: number[]) => std(xs) as number;

describe("OneEuroFilter", () => {
  it("steadies a noisy constant signal", () => {
    const r = rng(1);
    const f = new OneEuroFilter(ONE_EURO_POSE);
    const input: number[] = [];
    const output: number[] = [];
    for (let i = 0; i < 300; i++) {
      const x = 10 + 2 * r(); // yaw degrees of jitter around 10
      input.push(x);
      output.push(f.filter(x, i * 33));
    }
    expect(sd(output.slice(60))).toBeLessThan(sd(input.slice(60)) * 0.4);
    expect(Math.abs(median(output.slice(60))! - 10)).toBeLessThan(0.3);
  });

  it("follows a step within a short delay", () => {
    const f = new OneEuroFilter(ONE_EURO_POSE);
    for (let i = 0; i < 30; i++) f.filter(0, i * 33);
    let out = 0;
    let framesTo90 = -1;
    for (let i = 0; i < 60; i++) {
      out = f.filter(30, (30 + i) * 33);
      if (framesTo90 < 0 && out >= 27) framesTo90 = i + 1;
    }
    expect(framesTo90).toBeGreaterThan(0);
    expect(framesTo90 * 33).toBeLessThan(500); // within half a second
    expect(out).toBeGreaterThan(29.5);
  });

  it("gaze parameters follow a gaze step quickly too", () => {
    const f = new OneEuroFilter(ONE_EURO_GAZE);
    for (let i = 0; i < 30; i++) f.filter(0, i * 33);
    let out = 0;
    for (let i = 0; i < 10; i++) out = f.filter(1, (30 + i) * 33); // 330 ms
    expect(out).toBeGreaterThan(0.85);
  });

  it("first sample passes through and reset forgets the past", () => {
    const f = new OneEuroFilter(ONE_EURO_POSE);
    expect(f.filter(5, 0)).toBe(5);
    f.filter(6, 33);
    f.reset();
    expect(f.filter(50, 66)).toBe(50);
  });
});

describe("ReadingSmoother", () => {
  it("passes null through without disturbing the state", () => {
    const s = new ReadingSmoother();
    const base: Readings = { yaw: 1, pitch: 2, gazeH: 0.1, gazeV: 0, blendH: 0 };
    s.apply(base, 0);
    const out = s.apply({ ...base, gazeH: null }, 33);
    expect(out.gazeH).toBeNull();
    expect(out.yaw).not.toBeNull();
  });
});

describe("calibration math", () => {
  it("median and std", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([])).toBeNull();
    expect(std([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2.138, 3); // sample std
    expect(std([1])).toBeNull();
  });
  it("median baseline ignores outliers; std is the noise", () => {
    const rs: Readings[] = [0, 1, 2, 3, 100].map((v) => ({ yaw: v, pitch: 5, gazeH: 0.2, gazeV: null, blendH: 0 }));
    const { baseline, noise, n } = summarizeReadings(rs);
    expect(n).toBe(5);
    expect(baseline.yaw).toBe(2);
    expect(baseline.pitch).toBe(5);
    expect(noise.pitch).toBe(0);
    expect(baseline.gazeV).toBeNull(); // all null
  });
  it("buildCalibration keeps raw and smoothed apart and stores both edges", () => {
    const mk = (yaw: number, gazeH: number): CalibrationSample => ({
      s: { yaw, pitch: 0, gazeH, gazeV: 0, blendH: gazeH },
      r: { yaw: yaw + 1, pitch: 0, gazeH: gazeH + 0.1, gazeV: 0, blendH: gazeH },
    });
    const c = buildCalibration([mk(2, 0.1), mk(4, 0.1), mk(3, 0.1)], [mk(-20, -0.8)], [mk(22, 0.9)]);
    expect(c.baseline.yaw).toBe(3);
    expect(c.baselineRaw.yaw).toBe(4);
    expect(c.noise.yaw).toBeCloseTo(1);
    expect(c.samples).toBe(3);
    expect(c.edges.left.gazeH).toBeCloseTo(-0.8);
    expect(c.edges.right.yaw).toBe(22);
    expect(c.edges.rightRaw.yaw).toBe(23);
  });
});

describe("setup checks", () => {
  const goodBox = { x: 0.35, y: 0.25, w: 0.3, h: 0.5 };
  const ok = { mean: 120, std: 40 };
  const get = (cs: ReturnType<typeof evaluateSetup>, id: string) => cs.find((c) => c.id === id)!;

  it("all green for a good setup", () => {
    expect(evaluateSetup(goodBox, ok).every((c) => c.ok)).toBe(true);
  });
  it("too dark / too bright / flat", () => {
    expect(get(evaluateSetup(goodBox, { mean: 40, std: 40 }), "lighting").detail).toMatch(/Too dark/);
    expect(get(evaluateSetup(goodBox, { mean: 230, std: 40 }), "lighting").detail).toMatch(/Too bright/);
    expect(get(evaluateSetup(goodBox, { mean: 120, std: 5 }), "lighting").ok).toBe(false);
  });
  it("face too small, not centered, not found", () => {
    expect(get(evaluateSetup({ ...goodBox, h: 0.2 }, ok), "size").ok).toBe(false);
    expect(get(evaluateSetup({ ...goodBox, x: 0.7 }, ok), "centered").ok).toBe(false);
    expect(evaluateSetup(null, null).every((c) => !c.ok)).toBe(true);
  });
  it("luma stats from RGBA", () => {
    const px = [255, 255, 255, 255, 0, 0, 0, 255];
    const s = lumaStats(px);
    expect(s.mean).toBeCloseTo(127.5);
    expect(s.std).toBeCloseTo(127.5);
  });
  it("face box from landmarks", () => {
    const b = faceBoxFromLandmarks([{ x: 0.2, y: 0.1 }, { x: 0.6, y: 0.7 }]);
    expect(b.h).toBeCloseTo(0.6);
    expect(b.x).toBeCloseTo(0.2);
  });
});

describe("blendshape gaze", () => {
  it("toward the image right is positive", () => {
    // subject's left eye (image right) looks out, subject's right eye (image left) looks in
    expect(blendshapeGazeH({ eyeLookOutLeft: 0.6, eyeLookInRight: 0.6, eyeLookInLeft: 0, eyeLookOutRight: 0 })).toBeCloseTo(0.6);
    expect(blendshapeGazeH({ eyeLookOutLeft: 0, eyeLookInRight: 0, eyeLookInLeft: 0.4, eyeLookOutRight: 0.4 })).toBeCloseTo(-0.4);
  });
  it("null when scores are missing", () => {
    expect(blendshapeGazeH({})).toBeNull();
  });
});

describe("head cover", () => {
  const lm: Landmark[] = [{ x: 0.4, y: 0.4 }, { x: 0.6, y: 0.4 }, { x: 0.6, y: 0.6 }, { x: 0.4, y: 0.6 }, { x: 0.5, y: 0.5 }];
  const top = (pts: { y: number }[]) => Math.min(...pts.map((p) => p.y));
  it("off: unchanged; on: extends upward, bottom and width stay", () => {
    const base = faceShape(lm, 100, 100, 1.3, 0.25);
    const cover = faceShape(lm, 100, 100, 1.3, 0.25, 0.5, 1.05);
    expect(top(cover)).toBeLessThan(top(base) - 5);
    expect(Math.max(...cover.map((p) => p.y))).toBeCloseTo(Math.max(...base.map((p) => p.y)));
    expect(faceShape(lm, 100, 100, 1.3, 0.25, 0)).toEqual(base);
  });
});
