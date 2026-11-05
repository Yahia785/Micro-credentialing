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


BASE_YAW, BASE_GAZE, BASE_BLEND = 3.0, 0.2, 0.05   # the "calibration baseline" of the fake person
EMA = 0.25                                           # stand-in smoothing: smoothed = EMA of raw


def build_frames(fps: float, seconds: float, away: list[tuple[float, float, str]], lost: list[tuple[float, float]], seed: int,
                 noise: tuple[float, float, float] = (1.5, 0.08, 0.05)):
    """away: (start, end, 'yaw'|'gaze'); lost: (start, end); noise = (yaw sd, iris-gaze sd, blend-gaze sd).
    Raw values = truth + noise; smoothed values = exponential moving average of raw."""
    rnd = random.Random(seed)
    frames, n = [], int(fps * seconds)
    prev = None
    for i in range(n):
        t = i / fps
        yaw, gaze, blend = BASE_YAW, BASE_GAZE, BASE_BLEND
        for a, b, kind in away:
            if a <= t <= b:
                if kind == "yaw":
                    yaw = 40.0
                else:
                    gaze, blend = 0.9, 0.8
        is_lost = any(a <= t <= b for a, b in lost)
        raw = (yaw + rnd.gauss(0, noise[0]), gaze + rnd.gauss(0, noise[1]), blend + rnd.gauss(0, noise[2]))
        if is_lost:
            prev = None
            vals = [None] * 6
        else:
            prev = raw if prev is None else tuple(EMA * r + (1 - EMA) * p for r, p in zip(raw, prev))
            vals = [round(raw[0], 2), round(prev[0], 2), round(raw[1], 3), round(prev[1], 3), round(raw[2], 3), round(prev[2], 3)]
        slow = fps <= 15
        proc = rnd.uniform(60, 90) if slow else rnd.uniform(8, 14)
        frames.append({
            "type": "frame", "t": round(t * 1000 + rnd.uniform(-3, 3), 1), "faces": 0 if is_lost else 1, "lost": is_lost,
            "yawRaw": vals[0], "yaw": vals[1], "pitchRaw": None if is_lost else 0.0, "pitch": None if is_lost else 0.0,
            "roll": None if is_lost else 0.0,
            "gazeHRaw": vals[2], "gazeH": vals[3], "gazeVRaw": None if is_lost else 0.0, "gazeV": None if is_lost else 0.0,
            "blendHRaw": vals[4], "blendH": vals[5],
            "snapMs": round(proc * 0.1, 1), "detectMs": round(proc * 0.6, 1), "drawMs": round(proc * 0.3, 1), "procMs": round(proc, 1),
            "maskBoxes": [] if is_lost else [mask_box(round(t * fps))],
        })
    return frames


FAST_EDGES = (0.07, 0.33)    # gazeH at the left / right screen edge: about +/-0.13 from the baseline 0.2 (as seen on the real test)
LOW_EDGES = (0.12, 0.45)     # an asymmetric person: -0.08 on one side, +0.25 on the other


def write_sidecar(folder: Path, rec_id: str, fps: float, frames, keys, labels, edges=FAST_EDGES):
    dur = frames[-1]["t"] / 1000
    lines = [{"type": "header", "id": rec_id, "laptop": rec_id.split("_")[0], "scenario": rec_id.split("_")[1],
              "start": "2026-11-04T10:00:00.000Z", "width": 320, "height": 240, "delegate": "GPU" if fps > 15 else "CPU",
              "userAgent": "synthetic", "maskOptions": {}, "detectLongSide": 640, "recorderStartMs": {"masked": 5.0, "raw": 6.0},
              "setup": {"passed": True, "continuedAnyway": False, "failedChecks": []},
              "calibration": {"baseline": {"yaw": BASE_YAW, "pitch": 0.0, "gazeH": BASE_GAZE, "gazeV": 0.0, "blendH": BASE_BLEND},
                              "baselineRaw": {"yaw": BASE_YAW, "pitch": 0.0, "gazeH": BASE_GAZE, "gazeV": 0.0, "blendH": BASE_BLEND},
                              "samples": 100,
                              "edges": {"left": {"yaw": -18.0, "gazeH": edges[0], "blendH": BASE_BLEND - (BASE_GAZE - edges[0]) / 2},
                                        "right": {"yaw": 18.0, "gazeH": edges[1], "blendH": BASE_BLEND + (edges[1] - BASE_GAZE) / 2},
                                        "leftRaw": {"yaw": -18.0, "gazeH": edges[0], "blendH": BASE_BLEND - (BASE_GAZE - edges[0]) / 2},
                                        "rightRaw": {"yaw": 18.0, "gazeH": edges[1], "blendH": BASE_BLEND + (edges[1] - BASE_GAZE) / 2}}}}]
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
    write_sidecar(out, "lowend_second-screen_20261104-101000", 10, fb, keys=[], labels=[(10, 12, "look-away")], edges=LOW_EDGES)
    write_video(out, "lowend_second-screen_20261104-101000", 10, 6, lost=[(5, 9)])
    # C and D: "normal" clips (D runs at 12 fps = "OK (minimum)"), the person sits still. C is a good setup. D is a dim, noisy low-end setup:
    # raw gaze jitters a lot, smoothing calms it down.
    fc = build_frames(25, 60, [], [], 3, noise=(1.5, 0.08, 0.05))
    write_sidecar(out, "fastlaptop_normal_20261104-102000", 25, fc, keys=[5.0, 6.0], labels=[])
    fd = build_frames(12, 60, [], [], 4, noise=(4.0, 0.30, 0.22))
    write_sidecar(out, "lowend_normal_20261104-103000", 12, fd, keys=[], labels=[], edges=LOW_EDGES)
    # A fake speed-test file in the format the page downloads, so speed_report.py can be tried.
    def res(delegate, detect, fps, p10, det, lost, sr):
        ok = fps is not None
        return {"delegate": delegate, "detect": detect, "available": ok, "frames": int(fps * 15) if ok else 0,
                "lostFrames": lost, "avgFps": fps, "p10Fps": p10, "meanDetectMs": det,
                "std": {"yawRaw": sr[0], "yaw": sr[1], "gazeHRaw": sr[2], "gazeH": sr[3], "blendHRaw": sr[4], "blendH": sr[5]}
                if ok else {}, **({} if ok else {"note": "GPU not available"})}
    speed = {"laptop": "lowend", "time": "2026-11-04T10:40:00.000Z", "userAgent": "synthetic", "width": 1280, "height": 720,
             "measuredSeconds": 15, "cancelled": False, "results": [
                 res("GPU", 640, 16.2, 13.1, 49.0, 0, (1.2, 0.5, 0.09, 0.03, 0.06, 0.02)),
                 res("GPU", 480, 21.0, 17.5, 33.0, 0, (1.3, 0.5, 0.10, 0.03, 0.07, 0.02)),
                 res("GPU", 320, 27.4, 24.0, 20.0, 2, (1.9, 0.7, 0.14, 0.05, 0.10, 0.04)),
                 res("CPU", 640, 7.9, 6.0, 118.0, 0, (1.1, 0.5, 0.08, 0.03, 0.05, 0.02)),
                 res("CPU", 480, 11.6, 9.0, 82.0, 0, (1.3, 0.5, 0.10, 0.03, 0.07, 0.02)),
                 res("CPU", 320, 16.8, 13.5, 55.0, 1, (1.8, 0.7, 0.13, 0.05, 0.10, 0.04))]}
    (out / "speedtest-lowend-20261104-104000.json").write_text(json.dumps(speed, indent=2), encoding="utf-8")
    print(f"Wrote synthetic recordings to {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
