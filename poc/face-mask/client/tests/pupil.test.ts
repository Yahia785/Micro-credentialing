import { describe, expect, it } from "vitest";
import { EYES, eyeGeometry, irisOffset, irisOffsets, LM, pupilPlacement, type Landmark } from "../src/math";
import { IrisOffsetSmoother } from "../src/smoothing";

const W = 1280;
const H = 720;

/**
 * 478 landmarks with both eyes placed in pixels. leftEyeCx/ rightEyeCx are the eye centres; the iris sits at
 * centre + (offX * eyeWidth, offY * eyeHeight). Eye width 60 px, lid gap 24 px.
 */
function face(shiftX: number, offX: number, offY: number, eyeW = 60, lid = 24): Landmark[] {
  const lm: Landmark[] = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
  const put = (i: number, x: number, y: number) => (lm[i] = { x: x / W, y: y / H, z: 0 });
  const eye = (e: (typeof EYES)[number], cx: number, cy: number) => {
    put(e.imgLeft, cx - eyeW / 2, cy);
    put(e.imgRight, cx + eyeW / 2, cy);
    put(e.top, cx, cy - lid / 2);
    put(e.bottom, cx, cy + lid / 2);
    put(e.iris, cx + offX * eyeW, cy + offY * lid);
  };
  eye(EYES[0], 500 + shiftX, 300);
  eye(EYES[1], 700 + shiftX, 300);
  return lm;
}

const ELLIPSE = (g: ReturnType<typeof eyeGeometry>) => ({ rx: g.width * 0.62, ry: Math.max(g.height * 0.75, g.width * 0.62 * 0.3) });

describe("iris offset", () => {
  it("is relative to the eye centre in eye widths and heights", () => {
    const lm = face(0, 0.2, -0.25);
    const o = irisOffset(lm, EYES[0], W, H);
    expect(o.x).toBeCloseTo(0.2);
    expect(o.y).toBeCloseTo(-0.25);
    const both = irisOffsets(lm, W, H);
    expect(both[1].x).toBeCloseTo(0.2);
  });
  it("does not depend on where the eye is", () => {
    const a = irisOffset(face(0, 0.1, 0.1), EYES[1], W, H);
    const b = irisOffset(face(200, 0.1, 0.1), EYES[1], W, H);
    expect(b.x).toBeCloseTo(a.x);
    expect(b.y).toBeCloseTo(a.y);
  });
  it("a blink (tiny lid gap) cannot blow the offset up", () => {
    const o = irisOffset(face(0, 0, 0.5, 60, 0.5), EYES[0], W, H);
    expect(Math.abs(o.y)).toBeLessThan(2);
  });
});

describe("pupil follows the eye in the same frame (no lag)", () => {
  it("eye centre jumps 50 px, constant iris offset: pupil moves 50 px in that frame", () => {
    const smoother = new IrisOffsetSmoother();
    const place = (shift: number, t: number) => {
      const lm = face(shift, 0.15, 0.1);
      const smoothed = smoother.smooth(0, irisOffsets(lm, W, H), t);
      const g = eyeGeometry(lm, EYES[0], W, H);
      const { rx, ry } = ELLIPSE(g);
      return pupilPlacement(g, smoothed[0], rx, ry, 5);
    };
    let before = { x: 0, y: 0 };
    for (let i = 0; i < 20; i++) before = place(0, i * 33); // settled
    const after = place(50, 20 * 33); // the jump frame
    expect(after.x - before.x).toBeCloseTo(50, 6);
    expect(after.y - before.y).toBeCloseTo(0, 6);
  });

  it("keeps following a moving head frame by frame", () => {
    const smoother = new IrisOffsetSmoother();
    for (let i = 0; i < 30; i++) {
      const lm = face(i * 12, 0.1, 0);
      const sm = smoother.smooth(0, irisOffsets(lm, W, H), i * 33);
      const g = eyeGeometry(lm, EYES[0], W, H);
      const { rx, ry } = ELLIPSE(g);
      const p = pupilPlacement(g, sm[0], rx, ry, 5);
      expect(p.x).toBeCloseTo(500 + i * 12 + 0.1 * 60, 4);
    }
  });

  it("smoothing steadies a jittering offset but never touches the eye centre", () => {
    const smoother = new IrisOffsetSmoother();
    const xs: number[] = [];
    for (let i = 0; i < 60; i++) {
      const jitter = i % 2 ? 0.08 : -0.08;
      const lm = face(0, jitter, 0);
      xs.push(smoother.smooth(0, irisOffsets(lm, W, H), i * 33)[0].x);
    }
    const tail = xs.slice(30);
    expect(Math.max(...tail) - Math.min(...tail)).toBeLessThan(0.08);
  });
});

describe("pupil clamp", () => {
  it("stays inside the eye ellipse even for a huge offset", () => {
    const g = eyeGeometry(face(0, 0, 0), EYES[0], W, H);
    const { rx, ry } = ELLIPSE(g);
    const r = 5;
    for (const off of [{ x: 2, y: 0 }, { x: -2, y: 3 }, { x: 0.1, y: -5 }]) {
      const p = pupilPlacement(g, off, rx, ry, r);
      const a = p.x - g.cx;
      const b = p.y - g.cy;
      expect((a / (rx - r)) ** 2 + (b / (ry - r)) ** 2).toBeLessThanOrEqual(1 + 1e-9);
    }
  });
  it("a small offset is not changed by the clamp", () => {
    const g = eyeGeometry(face(0, 0, 0), EYES[0], W, H);
    const { rx, ry } = ELLIPSE(g);
    const p = pupilPlacement(g, { x: 0.05, y: 0 }, rx, ry, 5);
    expect(p.x - g.cx).toBeCloseTo(0.05 * g.width);
  });
  it("uses the landmark constants for both eyes", () => {
    expect(EYES[0].iris).toBe(LM.rEye.iris);
    expect(EYES[1].iris).toBe(LM.lEye.iris);
  });
});
