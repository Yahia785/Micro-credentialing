import { LM, faceShape, type Landmark, type Pt } from "./math";
import type { MaskOptions } from "./config";

type Ctx = CanvasRenderingContext2D;

/** Draw the privacy mask for ONE face on top of an already-drawn frame. */
export function drawFaceMask(ctx: Ctx, lm: ArrayLike<Landmark>, w: number, h: number, o: MaskOptions): void {
  const px = (i: number): Pt => ({ x: lm[i].x * w, y: lm[i].y * h });

  // 1. Solid face shape (nothing of the real face is visible through it).
  const shape = faceShape(lm, w, h, o.maskScale, o.foreheadLift);
  if (shape.length < 3) return;
  ctx.beginPath();
  shape.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
  ctx.closePath();
  ctx.fillStyle = o.skinColor;
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = o.outlineColor;
  ctx.stroke();

  // 2. Cartoon eyes: ellipse from corners + lids, pupil at the real iris.
  for (const eye of [LM.rEye, LM.lEye]) {
    const c1 = px(eye.outer);
    const c2 = px(eye.inner);
    const top = px(eye.top);
    const bot = px(eye.bottom);
    const iris = px(eye.iris);
    const cx = (c1.x + c2.x) / 2;
    const cy = (c1.y + c2.y) / 2;
    const width = Math.hypot(c2.x - c1.x, c2.y - c1.y);
    const rx = width * 0.62;
    const ry = Math.max(Math.hypot(bot.x - top.x, bot.y - top.y) * 0.75, rx * 0.3);
    const rot = Math.atan2(c2.y - c1.y, c2.x - c1.x);
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, rot, 0, Math.PI * 2);
    ctx.fillStyle = "#ffffff";
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = o.outlineColor;
    ctx.stroke();

    let irisR = 0;
    for (const i of eye.irisRing) {
      const q = px(i);
      irisR += Math.hypot(q.x - iris.x, q.y - iris.y);
    }
    irisR = Math.max(irisR / eye.irisRing.length, width * 0.12);
    ctx.save();
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, rot, 0, Math.PI * 2);
    ctx.clip();
    ctx.beginPath();
    ctx.arc(iris.x, iris.y, irisR, 0, Math.PI * 2);
    ctx.fillStyle = "#1b1b1b";
    ctx.fill();
    ctx.restore();
  }

  // 3. Nose dot (shows head direction).
  const nose = px(LM.noseTip);
  const e1 = px(LM.rEye.outer);
  const e2 = px(LM.lEye.outer);
  const faceW = Math.hypot(e1.x - e2.x, e1.y - e2.y);
  ctx.beginPath();
  ctx.arc(nose.x, nose.y, Math.max(faceW * 0.05, 3), 0, Math.PI * 2);
  ctx.fillStyle = o.outlineColor;
  ctx.fill();

  // 4. Mouth: opening follows the real lips.
  const mt = px(LM.mouthTop);
  const mb = px(LM.mouthBottom);
  const ml = px(LM.mouthLeft);
  const mr = px(LM.mouthRight);
  const mcx = (ml.x + mr.x) / 2;
  const mcy = (mt.y + mb.y) / 2;
  const mw = Math.hypot(mr.x - ml.x, mr.y - ml.y);
  const open = Math.hypot(mb.x - mt.x, mb.y - mt.y);
  ctx.beginPath();
  ctx.ellipse(mcx, mcy, mw * 0.5, Math.max(open * 0.6, 2), Math.atan2(mr.y - ml.y, mr.x - ml.x), 0, Math.PI * 2);
  ctx.fillStyle = "#7a2b2b";
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = o.outlineColor;
  ctx.stroke();
}

/** Scratch canvas reused for pixelation. */
let tiny: HTMLCanvasElement | null = null;

/** Pixelate the WHOLE frame into big blocks. Used whenever no face is tracked. */
export function drawPixelated(ctx: Ctx, src: CanvasImageSource, w: number, h: number, blockSize: number): void {
  const tw = Math.max(1, Math.round(w / blockSize));
  const th = Math.max(1, Math.round(h / blockSize));
  tiny ??= document.createElement("canvas");
  tiny.width = tw;
  tiny.height = th;
  const tctx = tiny.getContext("2d")!;
  tctx.imageSmoothingEnabled = true; // average pixels on the way down
  tctx.drawImage(src, 0, 0, tw, th);
  ctx.imageSmoothingEnabled = false; // hard blocks on the way up
  ctx.drawImage(tiny, 0, 0, tw, th, 0, 0, w, h);
  ctx.imageSmoothingEnabled = true;
}

export function drawLostBanner(ctx: Ctx, w: number, h: number): void {
  const bh = Math.max(40, h * 0.09);
  ctx.fillStyle = "rgba(190, 30, 30, 0.9)";
  ctx.fillRect(0, 0, w, bh);
  ctx.fillStyle = "#fff";
  ctx.font = `bold ${Math.round(bh * 0.55)}px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("TRACKING LOST", w / 2, bh / 2);
}
