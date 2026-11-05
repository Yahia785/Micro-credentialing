"""Make a SYNTHETIC 150-second session (video + sidecar) to try the analyzer end to end.

    python scripts\\make_synthetic_session.py out\\synthetic [--image out\\zidane.jpg]

    python scripts\\make_synthetic_session.py out\\pairs --pairs      (raw + masked video pairs for test 5)

The image (two people) is copied from the ultralytics assets by the README steps; it is not committed.
Planted events (all times in seconds):
   20-24   camera covered (dark)
   30-34   camera blurred
   50-70   second person in view (crosses the 60 s chunk boundary)
   57-63   student looks away (blendshape gaze), key presses at 58 and 62 -> looking_away_while_typing
   100-104 tracking lost
The data is fake: it only shows that the pipeline runs and finds what was planted.
"""
from __future__ import annotations

import json
import random
import sys
from pathlib import Path

import cv2
import numpy as np

SECONDS = 150
VIDEO_FPS = 5
SIDECAR_FPS = 20
SIZE = (640, 360)


def background(seed: int) -> np.ndarray:
    rng = np.random.default_rng(seed)
    small = rng.integers(60, 200, size=(SIZE[1] // 24, SIZE[0] // 24, 3), dtype=np.uint8)
    return cv2.resize(small, SIZE, interpolation=cv2.INTER_NEAREST)


def write_video(path: Path, people: np.ndarray, hide_people: bool = False) -> None:
    vw = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*"MJPG"), VIDEO_FPS, SIZE)
    for i in range(SECONDS * VIDEO_FPS):
        t = i / VIDEO_FPS
        if 20 <= t < 24:
            frame = np.full((SIZE[1], SIZE[0], 3), 5, np.uint8)
        elif 30 <= t < 34:
            frame = cv2.GaussianBlur(background(i), (0, 0), 20)
        elif 50 <= t < 70 and not hide_people:
            frame = people
        else:
            frame = background(i // 10)
        vw.write(frame)
    vw.release()


def main() -> int:
    args = sys.argv[1:]
    pairs = "--pairs" in args
    args = [a for a in args if a != "--pairs"]
    image = None
    if "--image" in args:
        image = Path(args[args.index("--image") + 1])
        args = [a for i, a in enumerate(args) if a != "--image" and (i == 0 or args[i - 1] != "--image")]
    if len(args) != 1:
        print(__doc__)
        return 1
    out = Path(args[0])
    out.mkdir(parents=True, exist_ok=True)
    image = image or Path(__file__).resolve().parent.parent / "out" / "zidane.jpg"
    if not image.exists():
        print(f"Image not found: {image}\nSee README: copy ultralytics/assets/zidane.jpg to server/out/zidane.jpg", file=sys.stderr)
        return 1
    people = cv2.resize(cv2.imread(str(image)), SIZE)

    if pairs:
        # A: the masked video shows everything the raw one does. B: the masked video lost the second person.
        write_video(out / "raw-pairA_20261105-120000.avi", people)
        write_video(out / "masked-pairA_20261105-120000.avi", people)
        write_video(out / "raw-pairB_20261105-120000.avi", people)
        write_video(out / "masked-pairB_20261105-120000.avi", people, hide_people=True)
        print(f"Wrote two raw/masked pairs to {out}")
        return 0

    rid = "synth_demo_20261105-120000"
    vp = out / f"masked-{rid}.avi"
    write_video(vp, people)

    rnd = random.Random(7)
    frames = []
    for i in range(SECONDS * SIDECAR_FPS):
        t = i / SIDECAR_FPS
        lost = 100 <= t < 104
        blend = 0.85 if 57 <= t < 63 else 0.0
        frames.append({"type": "frame", "t": round(t * 1000, 1), "faces": 0 if lost else 1, "lost": lost,
                       "yawRaw": None if lost else round(rnd.gauss(0, 1.5), 2), "yaw": None if lost else round(rnd.gauss(0, 0.5), 2),
                       "gazeHRaw": None if lost else 0.0, "gazeH": None if lost else 0.0,
                       "blendHRaw": None if lost else round(blend + rnd.gauss(0, 0.05), 3),
                       "blendH": None if lost else round(blend + rnd.gauss(0, 0.02), 3)})
    header = {"type": "header", "id": rid, "laptop": "synth", "scenario": "second-person", "width": SIZE[0], "height": SIZE[1],
              "delegate": "CPU", "recorderStartMs": {"masked": 0.0},
              "calibration": {"baseline": {"yaw": 0.0, "gazeH": 0.0, "blendH": 0.0}, "samples": 100}}
    lines = [header] + frames + [{"type": "key", "t": 58000.0}, {"type": "key", "t": 62000.0}]
    lines.append({"type": "summary", "frames": len(frames), "lostFrames": sum(f["lost"] for f in frames), "durationS": SECONDS})
    (out / f"sidecar-{rid}.jsonl").write_text("\n".join(json.dumps(x) for x in lines) + "\n", encoding="utf-8")
    print(f"Wrote {vp} and the sidecar")
    return 0


if __name__ == "__main__":
    sys.exit(main())
