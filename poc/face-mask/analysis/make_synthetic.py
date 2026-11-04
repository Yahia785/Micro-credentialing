"""Generate SYNTHETIC recordings (sidecars, labels, tiny masked videos) to try the scripts without a camera.

Usage: python make_synthetic.py <out folder>
The data is fake. It only checks that the analysis scripts run and give the expected answers.
"""
from __future__ import annotations

import json
import random
import sys
from pathlib import Path

import cv2
import numpy as np


def mask_box(i: int) -> list[int]:
    """Where the synthetic mask is drawn in video frame i (see write_video), padded by 4 px."""
    cx = 160 + int(40 * np.sin(i / 15))
    return [cx - 59, 41, 118, 158]


def build_frames(fps: float, seconds: float, away: list[tuple[float, float, str]], lost: list[tuple[float, float]], seed: int):
    """away: (start, end, 'yaw'|'gaze'); lost: (start, end). Returns list of frame dicts."""
    rnd = random.Random(seed)
    frames, n = [], int(fps * seconds)
    for i in range(n):
        t = i / fps
        yaw, gaze = rnd.uniform(-5, 5), rnd.uniform(-0.15, 0.15)
        for a, b, kind in away:
            if a <= t <= b:
                if kind == "yaw":
                    yaw = 40.0
                else:
                    gaze = 0.8
        is_lost = any(a <= t <= b for a, b in lost)
        frames.append({
            "type": "frame", "t": round(t * 1000 + rnd.uniform(-3, 3), 1), "faces": 0 if is_lost else 1, "lost": is_lost,
            "yaw": None if is_lost else round(yaw, 2), "pitch": None if is_lost else 0.0, "roll": None if is_lost else 0.0,
            "gazeH": None if is_lost else round(gaze, 3), "gazeV": None if is_lost else 0.0,
            "maskBoxes": [] if is_lost else [mask_box(round(t * fps))],
            "procMs": round(rnd.uniform(8, 14) if fps > 15 else rnd.uniform(60, 90), 1),
        })
    return frames


def write_sidecar(folder: Path, rec_id: str, fps: float, frames, keys, labels):
    dur = frames[-1]["t"] / 1000
    lines = [{"type": "header", "id": rec_id, "laptop": rec_id.split("_")[0], "scenario": rec_id.split("_")[1],
              "start": "2026-11-04T10:00:00.000Z", "width": 320, "height": 240, "delegate": "GPU" if fps > 15 else "CPU",
              "userAgent": "synthetic", "maskOptions": {}, "recorderStartMs": {"masked": 5.0, "raw": 6.0}}]
    ki = 0
    for f in frames:
        while ki < len(keys) and keys[ki] * 1000 <= f["t"]:
            lines.append({"type": "key", "t": keys[ki] * 1000})
            ki += 1
        lines.append(f)
    lost = sum(1 for f in frames if f["lost"])
    lines.append({"type": "summary", "frames": len(frames), "lostFrames": lost, "durationS": round(dur, 2),
                  "avgFps": round(len(frames) / dur, 2), "p10Fps": round(fps * 0.9, 2)})
    (folder / f"sidecar-{rec_id}.jsonl").write_text("\n".join(json.dumps(x) for x in lines) + "\n", encoding="utf-8")
    (folder / f"sidecar-{rec_id}.labels.csv").write_text(
        "start_s,end_s,label\n" + "".join(f"{a},{b},{lab}\n" for a, b, lab in labels), encoding="utf-8")


def draw_face(img, cx: int, cy: int, skin):
    cv2.ellipse(img, (cx, cy), (55, 75), 0, 0, 360, skin, -1)
    for dx in (-22, 22):
        cv2.ellipse(img, (cx + dx, cy - 20), (14, 9), 0, 0, 360, (255, 255, 255), -1)
        cv2.circle(img, (cx + dx, cy - 20), 5, (27, 27, 27), -1)
    cv2.circle(img, (cx, cy + 5), 4, (58, 74, 90), -1)
    cv2.ellipse(img, (cx, cy + 30), (18, 5), 0, 0, 360, (43, 43, 122), -1)


def write_video(folder: Path, rec_id: str, fps: float, seconds: float, lost=(), leak=()):
    """lost: (start,end) s drawn pixelated with no face; leak: (start,end) s with a second unmasked face OUTSIDE the mask box."""
    path = folder / f"masked-{rec_id}.webm"
    vw = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*"VP80"), fps, (320, 240))
    if not vw.isOpened():
        print("  (could not create webm writer; skipping video)")
        return
    for i in range(int(fps * seconds)):
        t = i / fps
        img = np.full((240, 320, 3), (90, 80, 70), np.uint8)
        if any(a <= t <= b for a, b in lost):
            img = cv2.resize(cv2.resize(img, (8, 6)), (320, 240), interpolation=cv2.INTER_NEAREST)
        else:
            cx = 160 + int(40 * np.sin(i / 15))
            draw_face(img, cx, 120, (156, 180, 201))      # the cartoon mask, inside its mask box
            if any(a <= t <= b for a, b in leak):
                draw_face(img, 60, 120, (170, 190, 225))  # "real face" OUTSIDE every mask box
        vw.write(img)
    vw.release()


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__)
        return 1
    out = Path(sys.argv[1])
    out.mkdir(parents=True, exist_ok=True)

    # A: fast laptop, 25 fps, 20 s. Events: yaw 3-5 s, gaze 12-14.5 s with a 0.3 s lost gap (must merge),
    #    glance of 0.6 s at 8 s (must NOT count), one unlabeled event 16-18 s (extra).
    away = [(3, 5, "yaw"), (8, 8.6, "yaw"), (12, 14.5, "gaze"), (16, 18, "yaw")]
    lost = [(13.0, 13.3), (19.0, 19.4), (4.2, 4.6)]
    fa = build_frames(25, 20, away, lost, 1)
    write_sidecar(out, "fastlaptop_turn-away_20261104-100000", 25, fa, keys=[1.0, 2.5, 4.0, 11.0],
                  labels=[(3, 5, "look-away"), (12, 14.5, "look-away")])
    write_video(out, "fastlaptop_turn-away_20261104-100000", 25, 6, lost=[(4.2, 4.6)], leak=[(1.6, 2.8)])

    # B: low-end laptop, ~10 fps, 20 s, 20% of frames lost around 5-9 s. One label found.
    fb = build_frames(10, 20, [(10, 12, "yaw")], [(5, 9)], 2)
    write_sidecar(out, "lowend_second-screen_20261104-101000", 10, fb, keys=[], labels=[(10, 12, "look-away")])
    write_video(out, "lowend_second-screen_20261104-101000", 10, 6, lost=[(5, 9)])
    print(f"Wrote synthetic recordings to {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
