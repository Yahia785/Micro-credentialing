import { describe, expect, it } from "vitest";
import { boundingBox, convexHull, eyeGaze, EYES, faceShape, gazeFromLandmarks, headPoseFromMatrix, LM, percentile, summarize, type Landmark } from "../src/math";

const rad = (d: number) => (d * Math.PI) / 180;

/** Column-major 4x4 from yaw/pitch/roll degrees, R = Ry * Rx * Rz, optional uniform scale and translation. */
function matrix(yaw: number, pitch: number, roll: number, scale = 1): number[] {
  const [cy, sy, cp, sp, cr, sr] = [Math.cos(rad(yaw)), Math.sin(rad(yaw)), Math.cos(rad(pitch)), Math.sin(rad(pitch)), Math.cos(rad(roll)), Math.sin(rad(roll))];
  const R = [
    [cy * cr + sy * sp * sr, -cy * sr + sy * sp * cr, sy * cp],
    [cp * sr, cp * cr, -sp],
    [-sy * cr + cy * sp * sr, sy * sr + cy * sp * cr, cy * cp],
  ];
  const m = new Array(16).fill(0);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) m[c * 4 + r] = R[r][c] * scale;
  m[12] = 1.5; m[13] = -2; m[14] = -30; m[15] = 1; // translation sits in the last COLUMN
  return m;
}

describe("headPoseFromMatrix", () => {
  it("identity is zero", () => {
    const p = headPoseFromMatrix(matrix(0, 0, 0));
    expect(p.yaw).toBeCloseTo(0);
    expect(p.pitch).toBeCloseTo(0);
    expect(p.roll).toBeCloseTo(0);
  });
  it("pure yaw 30: m[8] = sin30 (column-major layout)", () => {
    const m = matrix(30, 0, 0);
    expect(m[8]).toBeCloseTo(0.5);
    const p = headPoseFromMatrix(m);
    expect(p.yaw).toBeCloseTo(30);
    expect(p.pitch).toBeCloseTo(0);
  });
  it("negative yaw and pitch and roll keep their signs", () => {
    const p = headPoseFromMatrix(matrix(-40, 15, -10));
    expect(p.yaw).toBeCloseTo(-40);
    expect(p.pitch).toBeCloseTo(15);
    expect(p.roll).toBeCloseTo(-10);
  });
  it("round trips many angles", () => {
    for (const [y, p, r] of [[10, 5, 2], [-60, 20, 30], [75, -25, -45], [0, 40, 0]]) {
      const got = headPoseFromMatrix(matrix(y, p, r));
      expect(got.yaw).toBeCloseTo(y, 4);
      expect(got.pitch).toBeCloseTo(p, 4);
      expect(got.roll).toBeCloseTo(r, 4);
    }
  });
  it("ignores uniform scale", () => {
    const p = headPoseFromMatrix(matrix(20, 10, 5, 7.5));
    expect(p.yaw).toBeCloseTo(20);
    expect(p.pitch).toBeCloseTo(10);
    expect(p.roll).toBeCloseTo(5);
  });
});

/** Build a 478-landmark array with a flat, simple face; override what the test needs. */
function blankFace(): Landmark[] {
  return Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
}
const set = (lm: Landmark[], i: number, x: number, y: number) => (lm[i] = { x, y, z: 0 });

/** Place both eyes. irisH / irisV in [-1,1] describe where the iris sits inside each eye. */
function faceWithGaze(irisH: number, irisV: number): Landmark[] {
  const lm = blankFace();
  // Subject's right eye = image left: outer corner left of inner corner.
  const place = (imgLeft: number, imgRight: number, top: number, bottom: number, iris: number, x0: number) => {
    const x1 = x0 + 0.1;
    const yc = 0.4;
    set(lm, imgLeft, x0, yc);
    set(lm, imgRight, x1, yc);
    set(lm, top, (x0 + x1) / 2, yc - 0.02);
    set(lm, bottom, (x0 + x1) / 2, yc + 0.02);
    set(lm, iris, (x0 + x1) / 2 + irisH * 0.05, yc + irisV * 0.02);
  };
  place(LM.rEye.outer, LM.rEye.inner, LM.rEye.top, LM.rEye.bottom, LM.rEye.iris, 0.3);
  place(LM.lEye.inner, LM.lEye.outer, LM.lEye.top, LM.lEye.bottom, LM.lEye.iris, 0.6);
  return lm;
}

describe("gaze", () => {
  it("centered iris is 0,0", () => {
    const g = gazeFromLandmarks(faceWithGaze(0, 0), 1280, 720)!;
    expect(g.h).toBeCloseTo(0);
    expect(g.v).toBeCloseTo(0);
  });
  it("iris at image-right corner of both eyes gives +1 horizontally (mirrored eyes agree)", () => {
    const lm = faceWithGaze(1, 0);
    for (const e of EYES) expect(eyeGaze(lm, e, 1280, 720)!.h).toBeCloseTo(1);
    expect(gazeFromLandmarks(lm, 1280, 720)!.h).toBeCloseTo(1);
  });
  it("iris at image-left corner gives -1", () => {
    expect(gazeFromLandmarks(faceWithGaze(-1, 0), 1280, 720)!.h).toBeCloseTo(-1);
  });
  it("half way to the right corner gives +0.5", () => {
    expect(gazeFromLandmarks(faceWithGaze(0.5, 0), 1280, 720)!.h).toBeCloseTo(0.5);
  });
  it("vertical: low iris is positive (looking down)", () => {
    expect(gazeFromLandmarks(faceWithGaze(0, 0.5), 1280, 720)!.v).toBeCloseTo(0.5);
    expect(gazeFromLandmarks(faceWithGaze(0, -1), 1280, 720)!.v).toBeCloseTo(-1);
  });
  it("is clamped to [-1, 1]", () => {
    expect(gazeFromLandmarks(faceWithGaze(3, 0), 1280, 720)!.h).toBe(1);
  });
  it("averages the two eyes", () => {
    const lm = faceWithGaze(0, 0);
    // move only the right-image eye's iris to +1
    lm[LM.lEye.iris] = { x: lm[LM.lEye.iris].x + 0.05, y: lm[LM.lEye.iris].y, z: 0 };
    expect(gazeFromLandmarks(lm, 1280, 720)!.h).toBeCloseTo(0.5);
  });
  it("returns null when lids are closed", () => {
    const lm = faceWithGaze(0, 0);
    for (const e of EYES) lm[e.bottom] = { ...lm[e.top] };
    expect(gazeFromLandmarks(lm, 1280, 720)).toBeNull();
  });
});

describe("face shape", () => {
  it("hull of a square with an inner point is the 4 corners", () => {
    const h = convexHull([{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 2 }, { x: 0, y: 2 }, { x: 1, y: 1 }]);
    expect(h).toHaveLength(4);
  });
  it("scales 1.3x around the center and lifts the top by 25% of face height", () => {
    const lm: Landmark[] = [
      { x: 0.4, y: 0.4 }, { x: 0.6, y: 0.4 }, { x: 0.6, y: 0.6 }, { x: 0.4, y: 0.6 }, { x: 0.5, y: 0.5 },
    ];
    const shape = faceShape(lm, 100, 100, 1.3, 0.25);
    const ys = shape.map((p) => p.y);
    const xs = shape.map((p) => p.x);
    // face is 20 px wide/high, centered at (50,50). Width 20*1.3 = 26.
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(26);
    // bottom: 50 + 10*1.3 = 63. top: 50 - 13 - 0.25*20 = 32.
    expect(Math.max(...ys)).toBeCloseTo(63);
    expect(Math.min(...ys)).toBeCloseTo(32);
  });
});

describe("boundingBox", () => {
  it("matches the scaled and lifted shape", () => {
    const lm: Landmark[] = [{ x: 0.4, y: 0.4 }, { x: 0.6, y: 0.4 }, { x: 0.6, y: 0.6 }, { x: 0.4, y: 0.6 }, { x: 0.5, y: 0.5 }];
    // x: 50 +/- 13 -> 37..63 ; y: 32..63
    expect(boundingBox(faceShape(lm, 100, 100, 1.3, 0.25))).toEqual([37, 32, 26, 31]);
  });
  it("is empty for no shape", () => {
    expect(boundingBox([])).toEqual([0, 0, 0, 0]);
  });
});

describe("stats", () => {
  it("percentile interpolates", () => {
    expect(percentile([1, 2, 3, 4, 5], 50)).toBe(3);
    expect(percentile([1, 2, 3, 4, 5], 0)).toBe(1);
    expect(percentile([10, 20], 10)).toBeCloseTo(11);
  });
  it("summarize: steady 20 fps", () => {
    const times = Array.from({ length: 101 }, (_, i) => i * 50);
    const s = summarize(times, 10, 5000);
    expect(s.frames).toBe(101);
    expect(s.lostFrames).toBe(10);
    expect(s.avgFps).toBeCloseTo(101 / 5);
    expect(s.p10Fps).toBeCloseTo(20);
  });
});
