import { describe, expect, it } from "vitest";
import { buildCalibration, type CalibrationSample } from "../src/calibration";
import { keyCategory } from "../src/keys";
import { blendshapeGazeV } from "../src/math";
import { ReadingSmoother } from "../src/smoothing";

describe("blendshape vertical gaze", () => {
  it("looking down is positive, looking up negative", () => {
    expect(blendshapeGazeV({ eyeLookDownLeft: 0.6, eyeLookDownRight: 0.4, eyeLookUpLeft: 0, eyeLookUpRight: 0 })).toBeCloseTo(0.5);
    expect(blendshapeGazeV({ eyeLookDownLeft: 0, eyeLookDownRight: 0, eyeLookUpLeft: 0.3, eyeLookUpRight: 0.5 })).toBeCloseTo(-0.4);
  });
  it("uses both eyes and cancels opposite movements", () => {
    expect(blendshapeGazeV({ eyeLookDownLeft: 0.5, eyeLookDownRight: 0.5, eyeLookUpLeft: 0.5, eyeLookUpRight: 0.5 })).toBeCloseTo(0);
  });
  it("null when a score is missing", () => {
    expect(blendshapeGazeV({ eyeLookDownLeft: 0.5 })).toBeNull();
    expect(blendshapeGazeV({})).toBeNull();
  });
  it("is smoothed like the other readings", () => {
    const s = new ReadingSmoother();
    const base = { yaw: 0, pitch: 0, gazeH: 0, gazeV: 0, blendH: 0, blendV: 0 };
    s.apply(base, 0);
    const out = s.apply({ ...base, blendV: 0.8 }, 33);
    expect(out.blendV!).toBeGreaterThan(0);
    expect(out.blendV!).toBeLessThan(0.8);
  });
});

describe("calibration with top, bottom and keyboard", () => {
  const mk = (pitch: number, blendV: number): CalibrationSample => ({
    s: { yaw: 0, pitch, gazeH: 0, gazeV: 0, blendH: 0, blendV },
    r: { yaw: 0, pitch: pitch + 1, gazeH: 0, gazeV: 0, blendH: 0, blendV: blendV + 0.1 },
  });
  it("stores every point, raw and smoothed, including the new blendV", () => {
    const c = buildCalibration([mk(10, 0.1), mk(10, 0.1)], [mk(10, 0.1)], [mk(10, 0.1)], {
      top: [mk(4, -0.3), mk(6, -0.3)],
      bottom: [mk(16, 0.5)],
      keyboard: [mk(25, 0.7)],
    });
    expect(c.baseline.blendV).toBeCloseTo(0.1);
    expect(c.edges.top?.pitch).toBe(5);
    expect(c.edges.top?.blendV).toBeCloseTo(-0.3);
    expect(c.edges.bottom?.blendV).toBeCloseTo(0.5);
    expect(c.edges.keyboard?.pitch).toBe(25);
    expect(c.edges.keyboardRaw?.pitch).toBe(26);
    expect(c.edges.keyboardRaw?.blendV).toBeCloseTo(0.8);
    expect(c.edges.left.pitch).toBe(10);
  });
  it("older callers without the new stages still work", () => {
    const c = buildCalibration([mk(10, 0.1)], [mk(10, 0.1)], [mk(10, 0.1)]);
    expect(c.edges.top).toBeUndefined();
    expect(c.edges.keyboard).toBeUndefined();
  });
});

describe("key categories (never the key itself)", () => {
  it("maps keys to the six categories", () => {
    expect(keyCategory({ key: "a" })).toBe("char");
    expect(keyCategory({ key: "A" })).toBe("char");
    expect(keyCategory({ key: "7" })).toBe("char");
    expect(keyCategory({ key: "." })).toBe("char");
    expect(keyCategory({ key: " " })).toBe("space");
    expect(keyCategory({ key: "Backspace" })).toBe("backspace");
    expect(keyCategory({ key: "Delete" })).toBe("delete");
    expect(keyCategory({ key: "Enter" })).toBe("enter");
    expect(keyCategory({ key: "Shift" })).toBe("other");
    expect(keyCategory({ key: "ArrowLeft" })).toBe("move");
    expect(keyCategory({ key: "Tab" })).toBe("other");
  });
  it("shortcuts such as copy and paste are 'other'", () => {
    expect(keyCategory({ key: "v", ctrlKey: true })).toBe("other");
    expect(keyCategory({ key: "c", metaKey: true })).toBe("other");
    expect(keyCategory({ key: "a", altKey: true })).toBe("other");
  });
  it("the category carries no information about which character was typed", () => {
    expect(keyCategory({ key: "p" })).toBe(keyCategory({ key: "q" }));
  });
});
