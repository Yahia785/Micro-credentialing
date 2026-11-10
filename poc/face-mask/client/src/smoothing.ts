import { NUM_FACES, ONE_EURO_GAZE, ONE_EURO_POSE } from "./config";
import type { Offset } from "./math";
import { OneEuroFilter } from "./oneEuro";

export interface Readings {
  yaw: number | null;
  pitch: number | null;
  gazeH: number | null;
  gazeV: number | null;
  blendH: number | null;
  blendV: number | null;
}

const KEYS = ["yaw", "pitch", "gazeH", "gazeV", "blendH", "blendV"] as const;

/** One filter per reading. A null input leaves the filter state alone and gives null back. */
export class ReadingSmoother {
  private f = {
    yaw: new OneEuroFilter(ONE_EURO_POSE),
    pitch: new OneEuroFilter(ONE_EURO_POSE),
    gazeH: new OneEuroFilter(ONE_EURO_GAZE),
    gazeV: new OneEuroFilter(ONE_EURO_GAZE),
    blendH: new OneEuroFilter(ONE_EURO_GAZE),
    blendV: new OneEuroFilter(ONE_EURO_GAZE),
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

/**
 * Smooths the iris OFFSET inside each eye (not the absolute iris pixels), so that when the head moves
 * the pupil keeps up with the eye. The eye centre is never smoothed.
 */
export class IrisOffsetSmoother {
  private filters: OneEuroFilter[][] = Array.from({ length: NUM_FACES }, () =>
    Array.from({ length: 4 }, () => new OneEuroFilter(ONE_EURO_GAZE)),
  );

  /** offsets: [image-left eye, image-right eye]. Returns the smoothed offsets. */
  smooth(faceIdx: number, offsets: [Offset, Offset], tMs: number): [Offset, Offset] {
    const f = this.filters[faceIdx];
    if (!f) return offsets;
    return [
      { x: f[0].filter(offsets[0].x, tMs), y: f[1].filter(offsets[0].y, tMs) },
      { x: f[2].filter(offsets[1].x, tMs), y: f[3].filter(offsets[1].y, tMs) },
    ];
  }

  /** Call for every face slot that had no face this frame. */
  resetFace(faceIdx: number): void {
    this.filters[faceIdx]?.forEach((x) => x.reset());
  }
}
