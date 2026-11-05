// Pure setup-check logic (no DOM). Thresholds live in config.ts.
import {
  CENTER_TOLERANCE,
  MAX_MEAN_LUMA,
  MIN_FACE_HEIGHT_SHARE,
  MIN_LUMA_STD,
  MIN_MEAN_LUMA,
} from "./config";
import type { Landmark } from "./math";

/** Normalised (0..1) box. */
export interface FaceBox {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface LumaStats {
  mean: number;
  std: number;
}
export interface Check {
  id: "face" | "lighting" | "size" | "centered";
  label: string;
  ok: boolean;
  detail: string;
}

export function faceBoxFromLandmarks(lm: ArrayLike<Landmark>): FaceBox {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < lm.length; i++) {
    x0 = Math.min(x0, lm[i].x); x1 = Math.max(x1, lm[i].x);
    y0 = Math.min(y0, lm[i].y); y1 = Math.max(y1, lm[i].y);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Mean and standard deviation of brightness (Rec. 601 luma) from RGBA pixel data. */
export function lumaStats(rgba: ArrayLike<number>): LumaStats {
  const n = Math.floor(rgba.length / 4);
  if (n === 0) return { mean: 0, std: 0 };
  let sum = 0, sum2 = 0;
  for (let i = 0; i < n; i++) {
    const y = 0.299 * rgba[4 * i] + 0.587 * rgba[4 * i + 1] + 0.114 * rgba[4 * i + 2];
    sum += y;
    sum2 += y * y;
  }
  const mean = sum / n;
  return { mean, std: Math.sqrt(Math.max(0, sum2 / n - mean * mean)) };
}

export function evaluateSetup(box: FaceBox | null, luma: LumaStats | null): Check[] {
  if (!box) {
    return [
      { id: "face", label: "Face found", ok: false, detail: "No face. Look at the camera." },
      { id: "lighting", label: "Lighting", ok: false, detail: "-" },
      { id: "size", label: "Face size", ok: false, detail: "-" },
      { id: "centered", label: "Face centered", ok: false, detail: "-" },
    ];
  }
  let lighting: Check;
  if (!luma) lighting = { id: "lighting", label: "Lighting", ok: false, detail: "-" };
  else if (luma.mean < MIN_MEAN_LUMA)
    lighting = { id: "lighting", label: "Lighting", ok: false, detail: `Too dark, adjust your light (brightness ${luma.mean.toFixed(0)})` };
  else if (luma.mean > MAX_MEAN_LUMA)
    lighting = { id: "lighting", label: "Lighting", ok: false, detail: `Too bright, adjust your light (brightness ${luma.mean.toFixed(0)})` };
  else if (luma.std < MIN_LUMA_STD)
    lighting = { id: "lighting", label: "Lighting", ok: false, detail: `Too flat, add light from the front (contrast ${luma.std.toFixed(0)})` };
  else lighting = { id: "lighting", label: "Lighting", ok: true, detail: `OK (brightness ${luma.mean.toFixed(0)}, contrast ${luma.std.toFixed(0)})` };

  const share = box.h;
  const size: Check = {
    id: "size",
    label: "Face size",
    ok: share >= MIN_FACE_HEIGHT_SHARE,
    detail: `${(share * 100).toFixed(0)}% of frame height (need ${(MIN_FACE_HEIGHT_SHARE * 100).toFixed(0)}%+)${share >= MIN_FACE_HEIGHT_SHARE ? "" : ", move closer"}`,
  };
  const dx = box.x + box.w / 2 - 0.5;
  const dy = box.y + box.h / 2 - 0.5;
  const centered: Check = {
    id: "centered",
    label: "Face centered",
    ok: Math.abs(dx) <= CENTER_TOLERANCE && Math.abs(dy) <= CENTER_TOLERANCE,
    detail:
      Math.abs(dx) <= CENTER_TOLERANCE && Math.abs(dy) <= CENTER_TOLERANCE
        ? "OK"
        : "Move into the middle of the frame (use the guide box)",
  };
  return [{ id: "face", label: "Face found", ok: true, detail: "OK" }, lighting, size, centered];
}
