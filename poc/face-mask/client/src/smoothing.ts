import { NUM_FACES, ONE_EURO_GAZE, ONE_EURO_POSE } from "./config";
import { LM, type Landmark } from "./math";
import { OneEuroFilter } from "./oneEuro";

export interface Readings {
  yaw: number | null;
  pitch: number | null;
  gazeH: number | null;
  gazeV: number | null;
  blendH: number | null;
}

const KEYS = ["yaw", "pitch", "gazeH", "gazeV", "blendH"] as const;

/** One filter per reading. A null input leaves the filter state alone and gives null back. */
export class ReadingSmoother {
  private f = {
    yaw: new OneEuroFilter(ONE_EURO_POSE),
    pitch: new OneEuroFilter(ONE_EURO_POSE),
    gazeH: new OneEuroFilter(ONE_EURO_GAZE),
    gazeV: new OneEuroFilter(ONE_EURO_GAZE),
    blendH: new OneEuroFilter(ONE_EURO_GAZE),
  };

  apply(raw: Readings, tMs: number): Readings {
    const out = {} as Readings;
    for (const k of KEYS) out[k] = raw[k] === null ? null : this.f[k].filter(raw[k], tMs);
    return out;
  }

  reset(): void {
    for (const k of KEYS) this.f[k].reset();
  }
}

const IRIS_IDX = [LM.rEye.iris, ...LM.rEye.irisRing, LM.lEye.iris, ...LM.lEye.irisRing];

/** Smooths the iris landmarks (in pixels) that are used to draw the pupils. */
export class IrisSmoother {
  private filters: OneEuroFilter[][] = Array.from({ length: NUM_FACES }, () =>
    IRIS_IDX.flatMap(() => [new OneEuroFilter(ONE_EURO_POSE), new OneEuroFilter(ONE_EURO_POSE)]),
  );

  /** Returns a copy of the landmarks with smoothed iris points. */
  smooth(faceIdx: number, lm: ArrayLike<Landmark>, w: number, h: number, tMs: number): Landmark[] {
    const out = Array.from(lm);
    const fl = this.filters[faceIdx];
    if (!fl) return out;
    IRIS_IDX.forEach((idx, i) => {
      out[idx] = {
        x: fl[2 * i].filter(lm[idx].x * w, tMs) / w,
        y: fl[2 * i + 1].filter(lm[idx].y * h, tMs) / h,
        z: lm[idx].z,
      };
    });
    return out;
  }

  /** Call for every face slot that had no face this frame. */
  resetFace(faceIdx: number): void {
    this.filters[faceIdx]?.forEach((f) => f.reset());
  }
}
