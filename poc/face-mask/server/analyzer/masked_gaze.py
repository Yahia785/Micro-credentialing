"""Gaze and head-turn signals read from the MASKED video only (numpy and opencv only).

This is the part that would belong to the real system: it sees only what the server sees, the cartoon mask, never
the real face and never the sidecar. It does NOT decide anything (no look-away or copy rule); it only turns every
masked frame into numbers.

How the client draws the mask (client/src/mask.ts `drawFaceMask`, client/src/math.ts, client/src/config.ts):

1. Face shape: the convex hull of all 478 landmarks, scaled 1.3x around its centre, with the upper half pushed up
   by 0.25 x face height, plus a head-cover dome (0.5 x face height, 1.05 x width); filled with ONE flat colour
   `skinColor` #c9b49c and stroked 3 px with `outlineColor` #5a4a3a.
2. Eyes (one per eye): a WHITE (#ffffff) ellipse centred on the midpoint of the two eye corners, rotated along the
   corner line, semi-axis along the eye rx = 0.62 x eye width, across the eye ry = max(0.75 x lid opening,
   0.3 x rx); stroked 2 px with the outline colour. So ry / rx follows the lids (floor 0.3).
3. Pupil: a DARK (#1b1b1b) disc (radius = mean iris radius, at least 0.12 x eye width) clipped to the eye ellipse,
   at the eye centre plus the One-Euro-SMOOTHED iris offset (x in eye widths along the eye, y in eye heights across
   it, + = image right / down), clamped inside the ellipse (`pupilPlacement`).
4. Nose dot: a filled disc in the OUTLINE colour (#5a4a3a) at the nose-tip landmark, radius max(0.05 x distance
   between the outer eye corners, 3 px).
5. Mouth: #7a2b2b ellipse with outline stroke (not used here).
6. Tracking lost: the WHOLE frame is pixelated into 40 px blocks and a red banner "TRACKING LOST" (rgba 190,30,30,
   0.9) covers the top 9% (no mask is drawn).

What is read, per frame, with colour tolerances that survive webm compression:
- skin-coloured flat region -> the face shape (largest component, holes filled): face width in px (the width of the
  skin fill, a few px less than the drawn width because the 3 px outline is not skin coloured);
- low-saturation pixels (white, grey, dark) inside it -> the two eye ellipses (centre, axes and angle from second
  moments of the region, plus the outline stroke width that the stroke eats from the inside);
- dark pixels inside an eye -> pupil centre; offset from the ellipse centre in that ellipse's own axes, divided by
  the semi-axes (h + = toward image right, v + = down), both eyes and their mean;
- openness = minor / major semi-axis (the client's ry / rx);
- outline-coloured blob (after removing the thin strokes by opening) between and below the eyes -> nose dot;
  its position relative to the midpoint between the eye centres, divided by the eye distance (nose_h + = image
  right, nose_v + = down). These are head turn (yaw) and head tilt (pitch) proxies.

`found` is False for pixelated frames and for anything that does not look like a mask. The reader is only valid for
the default colours unless the colours of the session (sidecar header `maskOptions`) are passed in.
"""
from __future__ import annotations

import math
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Iterator

import cv2
import numpy as np

# ---- tolerances (change here) -----------------------------------------------------------------------------------
SKIN_TOL = 22               # per channel, around the skin colour (BGR)
OUTLINE_TOL = 30            # per channel, around the outline colour
LOW_SAT_MAX = 24            # eye interior: max(channel) - min(channel) at most this (white, grey and dark pupil all pass)
PUPIL_MAX = 75              # pupil: brightest channel at most this (the pupil is #1b1b1b = 27)
MIN_FACE_AREA_SHARE = 0.01  # skin region must cover at least this share of the frame
MIN_FILL_RATIO = 0.5        # skin pixels / filled shape: a real mask has only small holes
EYE_MIN_AREA_SHARE = 0.003  # eye region area as a share of the filled face shape
EYE_MAX_SIZE_RATIO = 3.0    # the two eye areas may differ at most by this factor
EYE_STROKE_PAD_PX = 1.0     # the 2 px outline eats about 1 px from the inside of the drawn ellipse
NOSE_RADIUS_PER_EYE_DIST = 0.075   # nose radius ~ 0.05 x (outer-corner distance ~ 1.5 x centre distance)
MIN_PUPIL_PIXELS = 6
BANNER_BGR = (30, 30, 190)  # "TRACKING LOST" banner (BGR of rgba 190,30,30)


def hex_to_bgr(h: str) -> np.ndarray:
    h = h.lstrip("#")
    return np.array([int(h[4:6], 16), int(h[2:4], 16), int(h[0:2], 16)], dtype=np.int16)


@dataclass(frozen=True)
class MaskColors:
    skin: np.ndarray
    outline: np.ndarray

    @staticmethod
    def from_options(opts: dict | None) -> "MaskColors":
        """From the sidecar header `maskOptions` ({skinColor, outlineColor}); defaults = client config.ts."""
        o = opts or {}
        return MaskColors(hex_to_bgr(o.get("skinColor", "#c9b49c")), hex_to_bgr(o.get("outlineColor", "#5a4a3a")))


DEFAULT_COLORS = MaskColors.from_options(None)

NAN = float("nan")


@dataclass
class MaskReading:
    found: bool = False
    reason: str = ""                      # why not found (or "")
    lost_banner: bool = False             # the red "TRACKING LOST" banner is visible
    pupil_h: float = NAN                  # mean of both eyes, in semi-axes of the eye ellipse; + = image right
    pupil_v: float = NAN                  # + = down
    pupil_h_l: float = NAN                # image-left eye
    pupil_v_l: float = NAN
    pupil_h_r: float = NAN                # image-right eye
    pupil_v_r: float = NAN
    openness: float = NAN                 # mean of minor / major semi-axis
    openness_l: float = NAN
    openness_r: float = NAN
    nose_h: float = NAN                   # (nose - eye midpoint) / eye distance, image x (+ = right)
    nose_v: float = NAN                   # image y (+ = down)
    eye_dist: float = NAN                 # px between the eye centres
    roll_deg: float = NAN                 # angle of the eye line in the image (+ = right eye lower)
    face_w: float = NAN                   # px, width of the face shape (with the head cover)
    extra: dict = field(default_factory=dict)

    def as_dict(self) -> dict:
        d = asdict(self)
        d.pop("extra")
        return {k: (None if isinstance(v, float) and math.isnan(v) else v) for k, v in d.items()}


def _banner_visible(frame: np.ndarray) -> bool:
    h = frame.shape[0]
    bh = max(40, int(h * 0.09))
    strip = frame[: bh // 2, frame.shape[1] // 8: frame.shape[1] // 4].reshape(-1, 3).astype(np.int16)
    return bool(np.mean(np.abs(strip - np.array(BANNER_BGR, dtype=np.int16)).max(axis=1) < 45) > 0.6)


def _largest_component(mask: np.ndarray, min_area: int = 1) -> tuple[np.ndarray, tuple] | None:
    n, lab, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    if n < 2:
        return None
    k = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    if stats[k, cv2.CC_STAT_AREA] < min_area:
        return None
    return (lab == k).astype(np.uint8), tuple(int(v) for v in stats[k, :4])


def _eye_from_region(region: np.ndarray, dark: np.ndarray) -> dict | None:
    """Ellipse (centre, axes, direction) from second moments of the eye region, and the pupil centre."""
    ys, xs = np.nonzero(region)
    if len(xs) < 20:
        return None
    pts = np.stack([xs, ys], axis=1).astype(np.float64)
    c = pts.mean(axis=0)
    cov = np.cov((pts - c).T) - np.eye(2) / 12.0          # remove the pixel-size variance
    vals, vecs = np.linalg.eigh(cov)
    vals = np.maximum(vals, 1e-6)
    semi = 2.0 * np.sqrt(vals) + EYE_STROKE_PAD_PX         # [minor, major]
    u = vecs[:, 1]
    if u[0] < 0:
        u = -u
    v = np.array([-u[1], u[0]])                            # across the eye, pointing down
    pys, pxs = np.nonzero(dark & (region > 0))
    pupil = None
    if len(pxs) >= MIN_PUPIL_PIXELS:
        pupil = np.array([pxs.mean(), pys.mean()])
    out = {"c": c, "u": u, "v": v, "a": float(semi[1]), "b": float(semi[0]), "pupil": pupil}
    if pupil is not None:
        d = pupil - c
        out["h"] = float(d @ u) / out["a"]
        out["v_off"] = float(d @ v) / out["b"]
    return out


def read_mask(frame_bgr: np.ndarray, colors: MaskColors = DEFAULT_COLORS) -> tuple[MaskReading, dict]:
    """Read one masked frame (BGR uint8). Returns (reading, geometry); geometry holds pixel positions for annotation."""
    r = MaskReading()
    geo: dict = {}
    H, W = frame_bgr.shape[:2]
    r.lost_banner = _banner_visible(frame_bgr)
    # 1. coarse: the skin-coloured flat region at half resolution
    small = cv2.resize(frame_bgr, (max(1, W // 2), max(1, H // 2)), interpolation=cv2.INTER_AREA)
    skin_s = cv2.inRange(small, np.clip(colors.skin - SKIN_TOL, 0, 255).astype(np.uint8),
                         np.clip(colors.skin + SKIN_TOL, 0, 255).astype(np.uint8))
    skin_s = cv2.morphologyEx(skin_s, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    comp = _largest_component(skin_s, int(MIN_FACE_AREA_SHARE * small.shape[0] * small.shape[1]))
    if comp is None:
        r.reason = "no skin-coloured region"
        return r, geo
    _, (bx, by, bw, bh) = comp
    pad = 6
    x0, y0 = max(0, 2 * bx - pad), max(0, 2 * by - pad)
    x1, y1 = min(W, 2 * (bx + bw) + pad), min(H, 2 * (by + bh) + pad)
    roi = frame_bgr[y0:y1, x0:x1]
    # 2. full resolution inside the box: face shape with holes filled
    skin = cv2.inRange(roi, np.clip(colors.skin - SKIN_TOL, 0, 255).astype(np.uint8),
                       np.clip(colors.skin + SKIN_TOL, 0, 255).astype(np.uint8))
    skin = cv2.morphologyEx(skin, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    comp_full = _largest_component(skin)
    if comp_full is None:
        r.reason = "no skin-coloured region"
        return r, geo
    face_mask, _ = comp_full
    cnts, _ = cv2.findContours(face_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    filled = np.zeros_like(face_mask)
    cv2.drawContours(filled, cnts, -1, 1, thickness=cv2.FILLED)
    filled_area = int(filled.sum())
    if filled_area == 0 or face_mask.sum() / filled_area < MIN_FILL_RATIO:
        r.reason = "skin region is not mask-like"
        return r, geo
    fx, fy, fw, fh = cv2.boundingRect(max(cnts, key=cv2.contourArea))
    r.face_w = float(fw)
    inner = cv2.erode(filled, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5)))
    # 3. eyes: low-saturation regions inside the face shape
    mx = roi.max(axis=2).astype(np.int16)
    mn = roi.min(axis=2).astype(np.int16)
    outl_raw = cv2.inRange(roi, np.clip(colors.outline - OUTLINE_TOL, 0, 255).astype(np.uint8),
                           np.clip(colors.outline + OUTLINE_TOL, 0, 255).astype(np.uint8))
    low = ((mx - mn) <= LOW_SAT_MAX) & (inner > 0) & (outl_raw == 0)    # a dark, grey outline colour must not count as eye
    low_u8 = cv2.morphologyEx(low.astype(np.uint8), cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    n, lab, stats, _ = cv2.connectedComponentsWithStats(low_u8, connectivity=8)
    areas = [(int(stats[k, cv2.CC_STAT_AREA]), k) for k in range(1, n) if stats[k, cv2.CC_STAT_AREA] >= EYE_MIN_AREA_SHARE * filled_area]
    areas.sort(reverse=True)
    if len(areas) < 2:
        r.reason = "fewer than two eye regions"
        return r, geo
    (a1, k1), (a2, k2) = areas[0], areas[1]
    if a1 / max(a2, 1) > EYE_MAX_SIZE_RATIO:
        r.reason = "eye regions differ too much in size"
        return r, geo
    dark = (mx <= PUPIL_MAX) & ((mx - mn) <= LOW_SAT_MAX) & (outl_raw == 0)
    eyes = [_eye_from_region((lab == k).astype(np.uint8), dark) for k in (k1, k2)]
    if any(e is None for e in eyes):
        r.reason = "eye region too small"
        return r, geo
    if all(e["pupil"] is None for e in eyes):
        r.reason = "no dark pupil in the eye regions"      # e.g. pixelated blocks of a similar colour
        return r, geo
    eyes.sort(key=lambda e: e["c"][0])                    # image-left eye first
    el, er = eyes
    D = float(np.linalg.norm(er["c"] - el["c"]))
    if D < 8:
        r.reason = "eyes too close together"
        return r, geo
    r.found = True
    r.eye_dist = D
    r.roll_deg = math.degrees(math.atan2(er["c"][1] - el["c"][1], er["c"][0] - el["c"][0]))
    r.openness_l, r.openness_r = el["b"] / el["a"], er["b"] / er["a"]
    r.openness = (r.openness_l + r.openness_r) / 2
    for side, e in (("l", el), ("r", er)):
        if "h" in e:
            setattr(r, f"pupil_h_{side}", e["h"])
            setattr(r, f"pupil_v_{side}", e["v_off"])
    hs = [x for x in (r.pupil_h_l, r.pupil_h_r) if not math.isnan(x)]
    vs = [x for x in (r.pupil_v_l, r.pupil_v_r) if not math.isnan(x)]
    if hs:
        r.pupil_h = sum(hs) / len(hs)
        r.pupil_v = sum(vs) / len(vs)
    # 4. nose dot: outline-coloured blob that survives an opening that removes the 2-3 px strokes
    mid = (el["c"] + er["c"]) / 2
    r_est = NOSE_RADIUS_PER_EYE_DIST * D
    k = max(5, int(round(1.2 * r_est)) | 1)
    outl = cv2.bitwise_and(outl_raw, outl_raw, mask=inner)
    outl = cv2.morphologyEx(outl, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k)))
    n2, lab2, st2, cen2 = cv2.connectedComponentsWithStats(outl, connectivity=8)
    best, best_err = None, 1e18
    target = math.pi * r_est ** 2
    for j in range(1, n2):
        cx, cy = cen2[j]
        relx, rely = (cx - mid[0]) / D, (cy - mid[1]) / D
        if abs(relx) < 0.9 and 0.05 < rely < 1.4:
            err = abs(math.log(max(st2[j, cv2.CC_STAT_AREA], 1) / target))
            if err < best_err:
                best, best_err = (cx, cy), err
    nose = None
    if best is not None:
        r.nose_h = float((best[0] - mid[0]) / D)
        r.nose_v = float((best[1] - mid[1]) / D)
        nose = (best[0] + x0, best[1] + y0)
    geo = {"origin": (x0, y0), "eyes": [{"c": (e["c"][0] + x0, e["c"][1] + y0), "a": e["a"], "b": e["b"], "u": tuple(e["u"]),
                                          "pupil": None if e["pupil"] is None else (e["pupil"][0] + x0, e["pupil"][1] + y0)} for e in eyes],
           "nose": nose, "face_box": (fx + x0, fy + y0, fw, fh)}
    return r, geo


def annotate(frame_bgr: np.ndarray, r: MaskReading, geo: dict) -> np.ndarray:
    """Copy of a MASKED frame with what the reader found drawn on it (for a visual check)."""
    img = frame_bgr.copy()
    if geo:
        x, y, w, h = geo["face_box"]
        cv2.rectangle(img, (x, y), (x + w, y + h), (0, 200, 0), 1)
        for e in geo["eyes"]:
            ang = math.degrees(math.atan2(e["u"][1], e["u"][0]))
            cv2.ellipse(img, (int(e["c"][0]), int(e["c"][1])), (int(e["a"]), int(e["b"])), ang, 0, 360, (255, 0, 0), 1)
            if e["pupil"] is not None:
                cv2.circle(img, (int(e["pupil"][0]), int(e["pupil"][1])), 3, (0, 0, 255), -1)
        if geo.get("nose"):
            cv2.circle(img, (int(geo["nose"][0]), int(geo["nose"][1])), 6, (0, 255, 255), 1)
    txt = ("found " if r.found else f"NOT found ({r.reason}) ") + \
          f"pupil h {r.pupil_h:+.2f} v {r.pupil_v:+.2f}  open {r.openness:.2f}  nose h {r.nose_h:+.2f} v {r.nose_v:+.2f}"
    cv2.putText(img, txt, (10, img.shape[0] - 12), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 0, 0), 3)
    cv2.putText(img, txt, (10, img.shape[0] - 12), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 1)
    return img


def analyze_video(path: str | Path, offset_ms: float = 0.0, colors: MaskColors = DEFAULT_COLORS,
                  debug_dir: str | Path | None = None, debug_every: int = 0, debug_max: int = 10
                  ) -> Iterator[tuple[float, MaskReading]]:
    """Yield (session_time_s, reading) for every frame of a masked video.

    Time = container frame time + `offset_ms` (the masked recorder's start offset from the sidecar header
    `recorderStartMs.masked`; this is the same correction test2_leaks.py makes). debug_dir/debug_every: save at most
    `debug_max` annotated MASKED frames (every `debug_every`-th frame); nothing is saved otherwise."""
    cap = cv2.VideoCapture(str(path))
    if not cap.isOpened():
        raise OSError(f"cannot open {path}")
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    saved = idx = 0
    last_t = -1e18
    try:
        while True:
            ok, frame = cap.read()
            if not ok:
                break
            vt = cap.get(cv2.CAP_PROP_POS_MSEC)
            if not vt or vt < 0 or vt < last_t:
                vt = idx * 1000.0 / fps
            last_t = vt
            reading, geo = read_mask(frame, colors)
            if debug_dir and debug_every and idx % debug_every == 0 and saved < debug_max:
                Path(debug_dir).mkdir(parents=True, exist_ok=True)
                cv2.imwrite(str(Path(debug_dir) / f"masked_debug_{saved:02d}_f{idx}.png"), annotate(frame, reading, geo))
                saved += 1
            yield (vt + offset_ms) / 1000.0, reading
            idx += 1
    finally:
        cap.release()
