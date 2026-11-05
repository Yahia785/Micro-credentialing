import { describe, expect, it } from "vitest";
import { speedLabel, summarizeSweep, SWEEP_PLAN, unavailable, type SweepSample } from "../src/sweep";

function samples(fps: number, seconds: number, over: Partial<SweepSample> = {}): SweepSample[] {
  const n = Math.round(fps * seconds) + 1;
  return Array.from({ length: n }, (_, i) => ({
    t: 5000 + (i * 1000) / fps,
    lost: false,
    detectMs: 40,
    yawRaw: i % 2 ? 1 : -1,
    yaw: 0.1,
    gazeHRaw: 0.1,
    gazeH: 0.1,
    blendHRaw: null,
    blendH: null,
    ...over,
  }));
}

describe("speed sweep", () => {
  it("plan is GPU then CPU, 640/480/320", () => {
    expect(SWEEP_PLAN.map((p) => `${p.delegate}${p.detect}`)).toEqual(["GPU640", "GPU480", "GPU320", "CPU640", "CPU480", "CPU320"]);
  });
  it("average fps, mean detect ms, std", () => {
    const r = summarizeSweep("GPU", 640, samples(16, 15));
    expect(r.available).toBe(true);
    expect(r.avgFps).toBeCloseTo(16, 1);
    expect(r.p10Fps).toBeCloseTo(16, 1);
    expect(r.meanDetectMs).toBeCloseTo(40);
    expect(r.std.yawRaw).toBeCloseTo(1.0, 1);
    expect(r.std.yaw).toBeCloseTo(0, 6);
    expect(r.std.blendH).toBeNull();
    expect(r.frames).toBe(241);
  });
  it("p10 reflects slow frames", () => {
    const s = samples(20, 10);
    for (let i = 100; i < s.length; i++) s[i].t += 500; // one 0.5 s stall
    const r = summarizeSweep("CPU", 320, s);
    expect(r.p10Fps!).toBeLessThanOrEqual(20);
    expect(r.avgFps!).toBeLessThan(20);
  });
  it("lost frames are counted and left out of the std", () => {
    const s = samples(10, 10);
    s[5] = { ...s[5], lost: true, yawRaw: 500 };
    const r = summarizeSweep("CPU", 480, s);
    expect(r.lostFrames).toBe(1);
    expect(r.std.yawRaw).toBeLessThan(5);
  });
  it("too few frames or unavailable", () => {
    expect(summarizeSweep("GPU", 640, samples(1, 0)).available).toBe(false);
    expect(unavailable("GPU", 640, "no gpu").note).toBe("no gpu");
  });
  it("speed labels", () => {
    expect(speedLabel(15)).toBe("PASS");
    expect(speedLabel(14.9)).toBe("OK (minimum)");
    expect(speedLabel(10)).toBe("OK (minimum)");
    expect(speedLabel(9.9)).toBe("FAIL");
    expect(speedLabel(null)).toBe("FAIL");
  });
});
