"""The cartoon's own geometric signals, computed from the RAW video (research only).

    python raw_geometry.py <folder> [--rebuild]     # tuning sessions only -> out/derived/<id>.rawgeom.jsonl

Same-signals check: the masked reader measures the cartoon (pupil position inside the eye ellipse, nose dot relative to
the eyes). Here the same quantities are computed straight from the MediaPipe landmarks of the raw video, with the same
definitions and units as server/analyzer/masked_gaze.py, so that "raw geometry" vs "masked reader" differs only in
real face vs cartoon drawn into pixels.

How the cartoon is drawn from the landmarks (client/src/mask.ts `drawFaceMask`, client/src/math.ts), full-size pixels
(landmark x, y are normalised, multiplied by the frame width and height, as the client does):
- eye geometry, `eyeGeometry` (math.ts:138): centre = midpoint of the two eye corners (image-left and image-right corner,
  `EYES`, math.ts:70); u = unit vector along the corners (image left -> right); v = (-u.y, u.x), pointing down;
  width = corner distance; height = max(lid distance top-bottom, EYE_MIN_HEIGHT_RATIO 0.3 x width) (math.ts:117).
- eye ellipse (mask.ts:38-41): rx = 0.62 x width (along u), ry = max(0.75 x height, 0.3 x rx) (across), rotated by atan2(u.y, u.x).
- iris offset, `irisOffset` / `irisOffsets` (math.ts:153, 161): iris centre landmark (468 / 473) minus the eye centre,
  projected on u and divided by width (x), projected on v and divided by height (y). Unsmoothed, from the CURRENT frame.
- smoothing, `IrisOffsetSmoother.smooth` (smoothing.ts:44): one One Euro filter per axis per eye (4 per face) with
  ONE_EURO_GAZE = minCutoff 1.0, beta 0.5, dCutoff 1.0 (config.ts:30; filter in oneEuro.ts); reset when no face is found.
- pupil placement, `pupilPlacement` (math.ts:169): a = offset.x x width, b = offset.y x height, then clamped inside the
  ellipse shrunk by the pupil radius: A = max(rx - R, 0), B = max(ry - R, 0); if A or B is 0 then a = b = 0, else
  k = (a/A)^2 + (b/B)^2 and if k > 1 both are divided by sqrt(k). Pupil centre = eye centre + a u + b v.
  R = iris radius = max(mean distance iris centre - 4 iris ring points, 0.12 x width) (mask.ts:50-55).
- nose dot (mask.ts:69-76): at the nose-tip landmark 1.

Signals (same definitions as the masked reader), both eyes averaged:
- pupil_h, pupil_v: pupil centre minus eye centre, along u and along v, divided by rx and by ry (the ellipse semi-axes);
- nose_h, nose_v: (nose tip - midpoint between the two eye centres) / distance between the eye centres, image axes
  (+ = image right, + = down); openness: ry / rx (mean of both eyes), reported only.
Variants: "plain" = unsmoothed offset, no clamping (pupil = centre + offset x size); "as drawn" = One Euro smoothed
offset and pupilPlacement clamping, i.e. what the cartoon should show before it is drawn into pixels.

Reuses raw_gaze.py for the MediaPipe setup (`make_landmarker`), the model, the detection size and the offset. The frame
loop and timestamp handling are the same as raw_gaze.analyze_video (it only returns the gaze fields, not landmarks);
the timestamps are checked against out/derived/<id>.raw.jsonl below. Frames stay in memory: nothing is written but numbers.
"""
from __future__ import annotations

import json
import math
import sys
import time
from pathlib import Path

import cv2
import numpy as np

import common
import raw_gaze
import scripted_common as sc_

ONE_EURO_GAZE = {"minCutoff": 1.0, "beta": 0.5, "dCutoff": 1.0}      # client/src/config.ts
EYE_MIN_HEIGHT_RATIO = 0.3
NOSE_TIP = 1
# image-left eye first (subject's right eye), as math.ts EYES / LM
EYES = (
    {"img_left": 33, "img_right": 133, "top": 159, "bottom": 145, "iris": 468, "ring": (469, 470, 471, 472)},
    {"img_left": 362, "img_right": 263, "top": 386, "bottom": 374, "iris": 473, "ring": (474, 475, 476, 477)},
)
FIELDS = ("plain_pupil_h", "plain_pupil_v", "drawn_pupil_h", "drawn_pupil_v", "nose_h", "nose_v", "openness", "eye_dist")


class OneEuro:
    """Port of client/src/oneEuro.ts (time in ms)."""

    def __init__(self, p: dict):
        self.p = p
        self.x_prev = None
        self.dx_prev = 0.0
        self.t_prev = 0.0

    def reset(self) -> None:
        self.x_prev = None
        self.dx_prev = 0.0

    @staticmethod
    def _alpha(dt_s: float, cutoff: float) -> float:
        tau = 1.0 / (2.0 * math.pi * cutoff)
        return 1.0 / (1.0 + tau / dt_s)

    def filter(self, x: float, t_ms: float) -> float:
        if self.x_prev is None:
            self.x_prev, self.t_prev = x, t_ms
            return x
        dt = (t_ms - self.t_prev) / 1000.0
        if dt <= 0:
            return self.x_prev
        dx = (x - self.x_prev) / dt
        a_d = self._alpha(dt, self.p["dCutoff"])
        dx_hat = a_d * dx + (1 - a_d) * self.dx_prev
        cutoff = self.p["minCutoff"] + self.p["beta"] * abs(dx_hat)
        a = self._alpha(dt, cutoff)
        x_hat = a * x + (1 - a) * self.x_prev
        self.x_prev, self.dx_prev, self.t_prev = x_hat, dx_hat, t_ms
        return x_hat


def eye_geometry(lm, e: dict, W: float, H: float) -> dict:
    """Port of eyeGeometry (math.ts:138) plus the ellipse of mask.ts:38-41 and the iris radius of mask.ts:50-55."""
    def px(i):
        return lm[i].x * W, lm[i].y * H
    a, b, t, u_ = px(e["img_left"]), px(e["img_right"]), px(e["top"]), px(e["bottom"])
    width = math.hypot(b[0] - a[0], b[1] - a[1]) or 1.0
    ux, uy = (b[0] - a[0]) / width, (b[1] - a[1]) / width
    vx, vy = -uy, ux
    lid = math.hypot(u_[0] - t[0], u_[1] - t[1])
    height = max(lid, EYE_MIN_HEIGHT_RATIO * width)
    cx, cy = (a[0] + b[0]) / 2, (a[1] + b[1]) / 2
    rx = width * 0.62
    ry = max(height * 0.75, rx * 0.3)
    iris = px(e["iris"])
    r = sum(math.hypot(px(k)[0] - iris[0], px(k)[1] - iris[1]) for k in e["ring"]) / len(e["ring"])
    irisR = max(r, width * 0.12)
    dx, dy = iris[0] - cx, iris[1] - cy
    return {"cx": cx, "cy": cy, "ux": ux, "uy": uy, "vx": vx, "vy": vy, "width": width, "height": height, "rx": rx, "ry": ry,
            "irisR": irisR, "off_x": (dx * ux + dy * uy) / width, "off_y": (dx * vx + dy * vy) / height}


def pupil_placement(width: float, height: float, off_x: float, off_y: float, rx: float, ry: float, R: float) -> tuple[float, float]:
    """Port of pupilPlacement (math.ts:169): (a, b) = pupil offset along u and v in pixels, clamped inside the ellipse."""
    a, b = off_x * width, off_y * height
    A, B = max(rx - R, 0.0), max(ry - R, 0.0)
    if A == 0 or B == 0:
        return 0.0, 0.0
    k = (a / A) ** 2 + (b / B) ** 2
    if k > 1:
        s = 1 / math.sqrt(k)
        a, b = a * s, b * s
    return a, b


class Geometry:
    """Per-video state: the four One Euro filters per eye of the client's IrisOffsetSmoother."""

    def __init__(self):
        self.filters = [[OneEuro(ONE_EURO_GAZE) for _ in range(2)] for _ in range(2)]

    def reset(self) -> None:
        for f in self.filters:
            for x in f:
                x.reset()

    def frame(self, lm, W: float, H: float, t_ms: float) -> dict:
        eyes = [eye_geometry(lm, e, W, H) for e in EYES]
        plain_h, plain_v, drawn_h, drawn_v, opens = [], [], [], [], []
        for i, g in enumerate(eyes):
            plain_h.append(g["off_x"] * g["width"] / g["rx"])
            plain_v.append(g["off_y"] * g["height"] / g["ry"])
            sx = self.filters[i][0].filter(g["off_x"], t_ms)
            sy = self.filters[i][1].filter(g["off_y"], t_ms)
            a, b = pupil_placement(g["width"], g["height"], sx, sy, g["rx"], g["ry"], g["irisR"])
            drawn_h.append(a / g["rx"])
            drawn_v.append(b / g["ry"])
            opens.append(g["ry"] / g["rx"])
        d = math.hypot(eyes[1]["cx"] - eyes[0]["cx"], eyes[1]["cy"] - eyes[0]["cy"])
        mid = ((eyes[0]["cx"] + eyes[1]["cx"]) / 2, (eyes[0]["cy"] + eyes[1]["cy"]) / 2)
        nose = (lm[NOSE_TIP].x * W, lm[NOSE_TIP].y * H)
        mean = lambda v: sum(v) / len(v)  # noqa: E731
        return {"plain_pupil_h": mean(plain_h), "plain_pupil_v": mean(plain_v), "drawn_pupil_h": mean(drawn_h), "drawn_pupil_v": mean(drawn_v),
                "nose_h": (nose[0] - mid[0]) / d if d > 0 else None, "nose_v": (nose[1] - mid[1]) / d if d > 0 else None,
                "openness": mean(opens), "eye_dist": d}


def analyze_video(path: str | Path, offset_ms: float, detect_long_side: int = 640):
    """Yield (session_time_s, found, record) per frame of the raw video. Same frame loop and timestamps as raw_gaze."""
    landmarker, mp = raw_gaze.make_landmarker()
    cap = cv2.VideoCapture(str(path))
    if not cap.isOpened():
        raise OSError(f"cannot open {path}")
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    geo = Geometry()
    idx, last_vt, last_ts = 0, -1e18, -1
    try:
        while True:
            ok, frame = cap.read()
            if not ok:
                break
            vt = cap.get(cv2.CAP_PROP_POS_MSEC)
            if not vt or vt < 0 or vt < last_vt:
                vt = idx * 1000.0 / fps
            last_vt = vt
            H, W = frame.shape[:2]
            scale = min(1.0, detect_long_side / max(W, H))
            small = frame if scale >= 1 else cv2.resize(frame, (round(W * scale), round(H * scale)), interpolation=cv2.INTER_LINEAR)
            rgb = np.ascontiguousarray(cv2.cvtColor(small, cv2.COLOR_BGR2RGB))
            ts = max(int(round(vt)), last_ts + 1)
            last_ts = ts
            res = landmarker.detect_for_video(mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb), ts)
            if res.face_landmarks:
                rec = geo.frame(res.face_landmarks[0], W, H, vt)
                found = True
            else:
                geo.reset()                         # the client resets the iris smoothers when tracking is lost
                rec = {k: None for k in FIELDS}
                found = False
            yield (vt + offset_ms) / 1000.0, found, rec
            idx += 1
    finally:
        cap.release()
        landmarker.close()


def build_derived(sidecar: Path, rebuild: bool = False) -> Path:
    header = sc_.read_header(sidecar)
    if sc_.split_of(header) != "tuning":
        raise PermissionError(f"{sidecar.name}: split is not 'tuning'")
    out = raw_gaze.derived_path(sidecar, "rawgeom")
    if out.exists() and not rebuild:
        return out
    video = sc_.sibling_files(sidecar)["raw"]
    offset = float((header.get("recorderStartMs") or {}).get("raw") or 0.0)
    raw_gaze.DERIVED_DIR.mkdir(parents=True, exist_ok=True)
    t0 = time.time()
    frames = []
    for t, found, rec in analyze_video(video, offset, int(header.get("detectLongSide") or 640)):
        frames.append({"type": "frame", "t": round(t, 4), "found": found,
                       **{k: (None if v is None else round(v, 5)) for k, v in rec.items()}})
    wall = time.time() - t0
    video_s = frames[-1]["t"] - frames[0]["t"] if len(frames) > 1 else 0.0
    meta = {"type": "meta", "reader": "raw_geometry", "session": sc_.session_id(sidecar), "frames": len(frames), "video_s": round(video_s, 2),
            "wall_s": round(wall, 2), "wall_s_per_video_min": round(wall / (video_s / 60), 1) if video_s else None, "recorder_offset_ms": offset,
            "one_euro": ONE_EURO_GAZE, "note": "same definitions as masked_gaze.py; plain = unsmoothed, no clamping; drawn = smoothed + pupilPlacement"}
    with out.open("w", encoding="utf-8") as fh:
        for rec in [meta, *frames]:
            fh.write(json.dumps(rec) + "\n")
    return out


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print("usage: python raw_geometry.py <folder> [--rebuild]", file=sys.stderr)
        return 2
    import compare_gaze_sources as cg
    import self_calibrated as sc
    lags = sc.read_lags()
    paths = []
    for p in common.find_sidecars(argv[1]):
        if sc_.split_of(sc_.read_header(p)) != "tuning":
            continue
        paths.append(build_derived(p, "--rebuild" in argv))
        print("raw geometry:", paths[-1], flush=True)
    print("\nSanity check 1: timestamps identical to out/derived/<id>.raw.jsonl")
    for p in common.find_sidecars(argv[1]):
        if sc_.split_of(sc_.read_header(p)) != "tuning":
            continue
        _, _, g = cg.load_derived(raw_gaze.derived_path(p, "rawgeom"))
        _, _, r = cg.load_derived(raw_gaze.derived_path(p, "raw"))
        same = len(g["t"]) == len(r["t"]) and float(np.max(np.abs(g["t"] - r["t"]))) < 1e-3
        print(f"  {sc_.session_id(p)}: frames {len(g['t'])} vs {len(r['t'])}, identical timestamps: {same}")
    print("\nSanity check 2: Pearson r between raw geometry and the masked reader (both lag-corrected, matched within 50 ms)")
    rows = []
    pairs = [("pupil_h", "plain_pupil_h", "drawn_pupil_h"), ("pupil_v", "plain_pupil_v", "drawn_pupil_v"), ("nose_h", "nose_h", "nose_h"),
             ("nose_v", "nose_v", "nose_v")]
    for p in common.find_sidecars(argv[1]):
        if sc_.split_of(sc_.read_header(p)) != "tuning":
            continue
        sid = sc_.session_id(p)
        _, _, m = cg.load_derived(raw_gaze.derived_path(p, "masked"))
        _, _, g = cg.load_derived(raw_gaze.derived_path(p, "rawgeom"))
        tm = m["t"] + lags[sid]["masked"] / 1000.0
        tg = g["t"] + lags[sid]["raw"] / 1000.0
        idx = cg.match_index(tm, tg)
        ok = idx >= 0
        for name, plain, drawn in pairs:
            row = {"session": sid.split("_")[1]}
            row["signal"] = name
            for label, col in (("r_plain", plain), ("r_as_drawn", drawn)):
                a = m[name][ok]
                b = g[col][idx[ok]]
                f = np.isfinite(a) & np.isfinite(b)
                row[label] = f"{cg.pearson(b[f], a[f]):.3f}"
                row["n"] = int(f.sum())
            rows.append(row)
    cg.print_table(rows, ["session", "signal", "r_plain", "r_as_drawn", "n"])
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
