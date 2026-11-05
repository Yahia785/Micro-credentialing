import type { OneEuroParams } from "./config";

const alpha = (dtS: number, cutoffHz: number) => {
  const tau = 1 / (2 * Math.PI * cutoffHz);
  return 1 / (1 + tau / dtS);
};

/** One Euro filter: steady when the signal is still, quick to follow when it moves. Time in ms. */
export class OneEuroFilter {
  private xPrev: number | null = null;
  private dxPrev = 0;
  private tPrev = 0;

  constructor(private p: OneEuroParams) {}

  reset(): void {
    this.xPrev = null;
    this.dxPrev = 0;
  }

  filter(x: number, tMs: number): number {
    if (this.xPrev === null) {
      this.xPrev = x;
      this.tPrev = tMs;
      return x;
    }
    const dt = (tMs - this.tPrev) / 1000;
    if (dt <= 0) return this.xPrev;
    const dx = (x - this.xPrev) / dt;
    const aD = alpha(dt, this.p.dCutoff);
    const dxHat = aD * dx + (1 - aD) * this.dxPrev;
    const cutoff = this.p.minCutoff + this.p.beta * Math.abs(dxHat);
    const a = alpha(dt, cutoff);
    const xHat = a * x + (1 - a) * this.xPrev;
    this.xPrev = xHat;
    this.dxPrev = dxHat;
    this.tPrev = tMs;
    return xHat;
  }
}
