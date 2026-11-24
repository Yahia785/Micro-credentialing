"""Raw-video gaze reader (research only): the client's own formulas on MediaPipe FaceLandmarker run in Python.

    python raw_gaze.py <folder> [--rebuild]      # tuning sessions only -> out/derived/<id>.raw.jsonl

Runs on the RAW video of a session, in memory only: no frame or image is ever written anywhere. The output is
numbers: the same fields as the sidecar's unsmoothed ("...Raw") readings, so the two can be compared directly.

Formula sources (all in poc/face-mask/client/src/math.ts, called from client/src/main.ts around line 238):
- yaw, pitch, roll: `headPoseFromMatrix` (math.ts:41) on the facial transformation matrix of the first face.
- iris gazeH, gazeV: `gazeFromLandmarks` (math.ts:107) = mean of `eyeGaze` (math.ts:87) over both eyes, with the eye
  index sets `EYES` / `LM` (math.ts:14, 70). h: -1 = iris at the image-left corner, +1 = image-right corner;
  v: -1 = upper lid, +1 = lower lid. Lids (almost) closed -> that eye is skipped.
- blendH: `blendshapeGazeH` (math.ts:262) = (eyeLookOutLeft + eyeLookInRight - eyeLookInLeft - eyeLookOutRight) / 2.
- blendV: `blendshapeGazeV` (math.ts:274) = (eyeLookDownLeft + eyeLookDownRight - eyeLookUpLeft - eyeLookUpRight) / 2.
Tracker settings: client/src/tracker.ts and client/src/config.ts (VIDEO mode, 2 faces, confidences 0.6, blendshapes and
transformation matrixes on, tracking on a copy scaled to DETECT_LONG_SIDE = 640 px long side, header `detectLongSide`).
Differences from the client that cannot be removed here: Python MediaPipe runs on the CPU (the client ran the GPU
delegate), the downscale is OpenCV bilinear (the browser's canvas scaling), and the frames come from the recorded
raw webm (compressed), not from the live camera.
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
import scripted_common as sc_

CLIENT_MEDIAPIPE_VERSION = "0.10.35"       # @mediapipe/tasks-vision in client/package.json
MODEL_PATH = Path(__file__).resolve().parent.parent / "client" / "public" / "models" / "face_landmarker.task"
DERIVED_DIR = sc_.OUT_DIR / "derived"
DEG = 180.0 / math.pi
BLENDSHAPE_KEYS = ("eyeLookInLeft", "eyeLookOutLeft", "eyeLookInRight", "eyeLookOutRight",
                   "eyeLookUpLeft", "eyeLookDownLeft", "eyeLookUpRight", "eyeLookDownRight")

# landmark indices, math.ts LM / EYES (image-left eye first: subject's right eye)
_EYES = (
    {"top": 159, "bottom": 145, "iris": 468, "img_left": 33, "img_right": 133},    # subject's right eye = image left
    {"top": 386, "bottom": 374, "iris": 473, "img_left": 362, "img_right": 263},   # subject's left eye = image right
)


def _clamp1(v: float) -> float:
    return max(-1.0, min(1.0, v))


def head_pose_from_matrix(m) -> tuple[float, float, float]:
    """Port of headPoseFromMatrix (math.ts:41). m = 16 numbers, COLUMN-major: element (row r, col c) = m[c*4 + r]."""
    s0 = math.hypot(m[0], m[1], m[2]) or 1.0
    s1 = math.hypot(m[4], m[5], m[6]) or 1.0
    s2 = math.hypot(m[8], m[9], m[10]) or 1.0
    r10, r11 = m[1] / s0, m[5] / s1
    r02, r12, r22 = m[8] / s2, m[9] / s2, m[10] / s2
    yaw = math.atan2(r02, r22) * DEG
    pitch = math.asin(max(-1.0, min(1.0, -r12))) * DEG
    roll = math.atan2(r10, r11) * DEG
    return yaw, pitch, roll


def eye_gaze(lm, e: dict, w: float, h: float):
    """Port of eyeGaze (math.ts:87). lm[i].x / .y are normalised; returns (h, v) in [-1, 1] or None."""
    def px(i):
        return lm[i].x * w, lm[i].y * h
    a, b, t, u, p = px(e["img_left"]), px(e["img_right"]), px(e["top"]), px(e["bottom"]), px(e["iris"])
    hx, hy = b[0] - a[0], b[1] - a[1]
    vx, vy = u[0] - t[0], u[1] - t[1]
    h_len2, v_len2 = hx * hx + hy * hy, vx * vx + vy * vy
    if h_len2 < 1e-6 or v_len2 < 1:
        return None
    th = ((p[0] - a[0]) * hx + (p[1] - a[1]) * hy) / h_len2
    tv = ((p[0] - t[0]) * vx + (p[1] - t[1]) * vy) / v_len2
    return _clamp1(2 * th - 1), _clamp1(2 * tv - 1)


def gaze_from_landmarks(lm, w: float, h: float):
    """Port of gazeFromLandmarks (math.ts:107): mean over the usable eyes, None if neither is usable."""
    gs = [g for g in (eye_gaze(lm, e, w, h) for e in _EYES) if g is not None]
    if not gs:
        return None
    return sum(g[0] for g in gs) / len(gs), sum(g[1] for g in gs) / len(gs)


def blendshape_gaze_h(bs: dict):
    """Port of blendshapeGazeH (math.ts:262)."""
    try:
        return (bs["eyeLookOutLeft"] + bs["eyeLookInRight"] - bs["eyeLookInLeft"] - bs["eyeLookOutRight"]) / 2
    except KeyError:
        return None


def blendshape_gaze_v(bs: dict):
    """Port of blendshapeGazeV (math.ts:274)."""
    try:
        return (bs["eyeLookDownLeft"] + bs["eyeLookDownRight"] - bs["eyeLookUpLeft"] - bs["eyeLookUpRight"]) / 2
    except KeyError:
        return None


def make_landmarker():
    """FaceLandmarker with the client's options (tracker.ts), CPU delegate."""
    import mediapipe as mp
    from mediapipe.tasks import python as mp_python
    from mediapipe.tasks.python import vision
    opts = vision.FaceLandmarkerOptions(
        base_options=mp_python.BaseOptions(model_asset_path=str(MODEL_PATH), delegate=mp_python.BaseOptions.Delegate.CPU),
        running_mode=vision.RunningMode.VIDEO, num_faces=2,
        min_face_detection_confidence=0.6, min_face_presence_confidence=0.6, min_tracking_confidence=0.6,
        output_face_blendshapes=True, output_facial_transformation_matrixes=True)
    return vision.FaceLandmarker.create_from_options(opts), mp


def analyze_video(path: str | Path, offset_ms: float = 0.0, detect_long_side: int = 640):
    """Yield (session_time_s, record) per frame of the RAW video. record: found, yaw, pitch, roll, gazeH, gazeV, blendH,
    blendV and the eight blendshape scores (None when not available). Frames stay in memory."""
    landmarker, mp = make_landmarker()
    cap = cv2.VideoCapture(str(path))
    if not cap.isOpened():
        raise OSError(f"cannot open {path}")
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
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
            rec = {"found": False, "yaw": None, "pitch": None, "roll": None, "gazeH": None, "gazeV": None,
                   "blendH": None, "blendV": None, **{k: None for k in BLENDSHAPE_KEYS}}
            if res.face_landmarks:
                rec["found"] = True
                if res.facial_transformation_matrixes:
                    M = np.asarray(res.facial_transformation_matrixes[0], dtype=np.float64)
                    rec["yaw"], rec["pitch"], rec["roll"] = head_pose_from_matrix(M.flatten(order="F"))   # column-major, as in JS
                g = gaze_from_landmarks(res.face_landmarks[0], W, H)    # full-size w, h: the landmarks are normalised
                if g:
                    rec["gazeH"], rec["gazeV"] = g
                if res.face_blendshapes:
                    bs = {c.category_name: c.score for c in res.face_blendshapes[0]}
                    rec["blendH"], rec["blendV"] = blendshape_gaze_h(bs), blendshape_gaze_v(bs)
                    for k in BLENDSHAPE_KEYS:
                        rec[k] = bs.get(k)
            yield (vt + offset_ms) / 1000.0, rec
            idx += 1
    finally:
        cap.release()
        landmarker.close()


def derived_path(sidecar: Path, kind: str) -> Path:
    return DERIVED_DIR / f"{sc_.session_id(sidecar)}.{kind}.jsonl"


def build_derived(sidecar: Path, rebuild: bool = False) -> Path:
    """Write out/derived/<id>.raw.jsonl for a TUNING session (refuses any other split). Returns the path."""
    header = sc_.read_header(sidecar)
    if sc_.split_of(header) != "tuning":
        raise PermissionError(f"{sidecar.name}: split is not 'tuning'")
    out = derived_path(sidecar, "raw")
    if out.exists() and not rebuild:
        return out
    video = sc_.sibling_files(sidecar)["raw"]
    offset = float((header.get("recorderStartMs") or {}).get("raw") or 0.0)
    import mediapipe
    DERIVED_DIR.mkdir(parents=True, exist_ok=True)
    t0 = time.time()
    frames = []
    for t, rec in analyze_video(video, offset, int(header.get("detectLongSide") or 640)):
        frames.append({"type": "frame", "t": round(t, 4), **{k: (round(v, 5) if isinstance(v, float) else v) for k, v in rec.items()}})
    wall = time.time() - t0
    video_s = frames[-1]["t"] - frames[0]["t"] if len(frames) > 1 else 0.0
    meta = {"type": "meta", "reader": "raw_gaze", "session": sc_.session_id(sidecar), "frames": len(frames), "video_s": round(video_s, 2),
            "wall_s": round(wall, 2), "wall_s_per_video_min": round(wall / (video_s / 60), 1) if video_s else None,
            "recorder_offset_ms": offset, "python_mediapipe": mediapipe.__version__, "client_mediapipe": CLIENT_MEDIAPIPE_VERSION,
            "delegate": "CPU", "detect_long_side": int(header.get("detectLongSide") or 640),
            "note": "unsmoothed values; same formulas as client/src/math.ts"}
    with out.open("w", encoding="utf-8") as fh:
        for rec in [meta, *frames]:
            fh.write(json.dumps(rec) + "\n")
    return out


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print("usage: python raw_gaze.py <folder> [--rebuild]", file=sys.stderr)
        return 2
    for p in common.find_sidecars(argv[1]):
        if sc_.split_of(sc_.read_header(p)) != "tuning":
            continue
        print("raw reader:", build_derived(p, "--rebuild" in argv))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
