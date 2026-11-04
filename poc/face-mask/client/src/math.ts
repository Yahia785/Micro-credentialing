// Pure math: no DOM, no MediaPipe imports, so it can be unit-tested.

export interface Pt {
  x: number;
  y: number;
}
export interface Landmark extends Pt {
  z?: number;
}

const DEG = 180 / Math.PI;

/** MediaPipe landmark indices used by the mask and the gaze estimate. */
export const LM = {
  noseTip: 1,
  mouthTop: 13,
  mouthBottom: 14,
  mouthLeft: 61,
  mouthRight: 291,
  // Subject's right eye = image left. 468..472 are its iris points (468 = center).
  rEye: { outer: 33, inner: 133, top: 159, bottom: 145, iris: 468, irisRing: [469, 470, 471, 472] },
  // Subject's left eye = image right. 473..477 are its iris points (473 = center).
  lEye: { inner: 362, outer: 263, top: 386, bottom: 374, iris: 473, irisRing: [474, 475, 476, 477] },
} as const;

export interface HeadPose {
  yaw: number;
  pitch: number;
  roll: number;
}

/**
 * Head pose in degrees from MediaPipe's 4x4 facial transformation matrix (column-major,
 * so element (row r, col c) = m[c*4 + r]). Convention (camera frame: x right in the
 * un-mirrored image, y up, z toward the camera), R = Ry(yaw) * Rx(pitch) * Rz(roll):
 *   yaw   > 0  face turns toward the RIGHT side of the image (the student's own left)
 *   pitch > 0  face tilts DOWN
 *   roll  > 0  head tilts counter-clockwise in the image
 * Columns are normalised so a scaled matrix still works.
 */
export function headPoseFromMatrix(m: ArrayLike<number>): HeadPose {
  const s0 = Math.hypot(m[0], m[1], m[2]) || 1;
  const s1 = Math.hypot(m[4], m[5], m[6]) || 1;
  const s2 = Math.hypot(m[8], m[9], m[10]) || 1;
  const r10 = m[1] / s0;
  const r11 = m[5] / s1;
  const r02 = m[8] / s2;
  const r12 = m[9] / s2;
  const r22 = m[10] / s2;
  const yaw = Math.atan2(r02, r22) * DEG;
  const pitch = Math.asin(Math.max(-1, Math.min(1, -r12))) * DEG;
  const roll = Math.atan2(r10, r11) * DEG;
  return { yaw, pitch, roll };
}

const clamp1 = (v: number) => Math.max(-1, Math.min(1, v));

export interface EyeIdx {
  readonly top: number;
  readonly bottom: number;
  readonly iris: number;
  /** Left and right corner as seen in the IMAGE (smaller x first). */
  readonly imgLeft: number;
  readonly imgRight: number;
}

// The two eyes are mirror images: the subject's right eye has its OUTER corner on the
// image left, the subject's left eye has its INNER corner there. Listing the corners in
// image order makes "+1 = iris toward image right" true for both eyes.
export const EYES: readonly EyeIdx[] = [
  { top: LM.rEye.top, bottom: LM.rEye.bottom, iris: LM.rEye.iris, imgLeft: LM.rEye.outer, imgRight: LM.rEye.inner },
  { top: LM.lEye.top, bottom: LM.lEye.bottom, iris: LM.lEye.iris, imgLeft: LM.lEye.inner, imgRight: LM.lEye.outer },
];

export interface Gaze {
  h: number;
  v: number;
}

/**
 * Iris position inside one eye, each axis in [-1, 1].
 * h: -1 = iris at image-left corner, +1 = image-right corner.
 * v: -1 = iris at upper lid, +1 = lower lid (so + = looking down).
 * Landmarks are normalised (0..1); w/h convert to pixels so the geometry is not skewed.
 * Returns null when the lids are (almost) closed.
 */
export function eyeGaze(lm: ArrayLike<Landmark>, e: EyeIdx, w: number, h: number): Gaze | null {
  const px = (i: number): Pt => ({ x: lm[i].x * w, y: lm[i].y * h });
  const a = px(e.imgLeft);
  const b = px(e.imgRight);
  const t = px(e.top);
  const u = px(e.bottom);
  const p = px(e.iris);
  const hx = b.x - a.x;
  const hy = b.y - a.y;
  const vx = u.x - t.x;
  const vy = u.y - t.y;
  const hLen2 = hx * hx + hy * hy;
  const vLen2 = vx * vx + vy * vy;
  if (hLen2 < 1e-6 || vLen2 < 1) return null;
  const th = ((p.x - a.x) * hx + (p.y - a.y) * hy) / hLen2;
  const tv = ((p.x - t.x) * vx + (p.y - t.y) * vy) / vLen2;
  return { h: clamp1(2 * th - 1), v: clamp1(2 * tv - 1) };
}

/** Average of both eyes (eyes with closed lids are skipped). null if neither is usable. */
export function gazeFromLandmarks(lm: ArrayLike<Landmark>, w: number, h: number): Gaze | null {
  const gs = EYES.map((e) => eyeGaze(lm, e, w, h)).filter((g): g is Gaze => g !== null);
  if (gs.length === 0) return null;
  return {
    h: gs.reduce((s, g) => s + g.h, 0) / gs.length,
    v: gs.reduce((s, g) => s + g.v, 0) / gs.length,
  };
}

/** Convex hull (Andrew's monotone chain). */
export function convexHull(points: Pt[]): Pt[] {
  const pts = [...points].sort((p, q) => p.x - q.x || p.y - q.y);
  if (pts.length < 3) return pts;
  const cross = (o: Pt, a: Pt, b: Pt) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Pt[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Pt[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/**
 * The solid face shape: hull of all landmarks (pixels), scaled around its center, with the
 * upper half pushed up by foreheadLift * faceHeight (full push at the top, fading to zero
 * at the center line).
 */
export function faceShape(lm: ArrayLike<Landmark>, w: number, h: number, scale: number, foreheadLift: number): Pt[] {
  const pts: Pt[] = [];
  for (let i = 0; i < lm.length; i++) pts.push({ x: lm[i].x * w, y: lm[i].y * h });
  const hull = convexHull(pts);
  if (hull.length === 0) return [];
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of hull) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  }
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const faceH = maxY - minY;
  const halfH = faceH / 2 || 1;
  return hull.map((p) => {
    const sx = cx + (p.x - cx) * scale;
    let sy = cy + (p.y - cy) * scale;
    const above = (cy - p.y) / halfH; // 1 at top of hull, 0 at center, negative below
    if (above > 0) sy -= foreheadLift * faceH * Math.min(1, above);
    return { x: sx, y: sy };
  });
}

/** Percentile (0..100) with linear interpolation. */
export function percentile(values: number[], pct: number): number {
  if (values.length === 0) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const idx = (pct / 100) * (s.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return s[lo] + (s[hi] - s[lo]) * (idx - lo);
}

export interface Summary {
  frames: number;
  lostFrames: number;
  durationS: number;
  avgFps: number;
  p10Fps: number;
}

/** frameTimes: t in ms of each processed frame (ascending). */
export function summarize(frameTimes: number[], lostFrames: number, durationMs: number): Summary {
  const inst: number[] = [];
  for (let i = 1; i < frameTimes.length; i++) {
    const dt = frameTimes[i] - frameTimes[i - 1];
    if (dt > 0) inst.push(1000 / dt);
  }
  const durationS = durationMs / 1000;
  return {
    frames: frameTimes.length,
    lostFrames,
    durationS,
    avgFps: durationS > 0 ? frameTimes.length / durationS : 0,
    p10Fps: percentile(inst, 10),
  };
}
