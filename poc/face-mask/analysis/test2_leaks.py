"""Test 2: does a face detector still find a face in the MASKED video?

Usage: python test2_leaks.py <folder> [--every N]
Runs OpenCV Haar frontal + profile (profile on the frame and its mirror) on every frame.
"""
from __future__ import annotations

import argparse
import csv
from pathlib import Path

import cv2

from common import find_masked_videos

OUT_ROOT = Path(__file__).resolve().parent / "out" / "leaks"
CASCADES = {
    "frontal": cv2.data.haarcascades + "haarcascade_frontalface_default.xml",
    "profile": cv2.data.haarcascades + "haarcascade_profileface.xml",
}


def load_detectors():
    det = {}
    for k, path in CASCADES.items():
        c = cv2.CascadeClassifier(path)
        if c.empty():
            raise SystemExit(f"Could not load cascade {path}")
        det[k] = c
    return det


def detect_all(gray, det):
    """Return list of (detector name, (x, y, w, h)) in ORIGINAL image coordinates."""
    kw = dict(scaleFactor=1.1, minNeighbors=5, minSize=(60, 60))
    hits = [("frontal", tuple(map(int, b))) for b in det["frontal"].detectMultiScale(gray, **kw)]
    hits += [("profile", tuple(map(int, b))) for b in det["profile"].detectMultiScale(gray, **kw)]
    W = gray.shape[1]
    flipped = cv2.flip(gray, 1)
    for x, y, w, h in det["profile"].detectMultiScale(flipped, **kw):
        hits.append(("profile-mirror", (int(W - x - w), int(y), int(w), int(h))))
    return hits


COLORS = {"frontal": (0, 0, 255), "profile": (0, 165, 255), "profile-mirror": (255, 0, 255)}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("folder")
    ap.add_argument("--every", type=int, default=1, help="check every Nth frame (default 1 = all)")
    args = ap.parse_args()
    videos = find_masked_videos(args.folder)
    det = load_detectors()
    OUT_ROOT.mkdir(parents=True, exist_ok=True)

    summary_rows = []
    for vp in videos:
        cap = cv2.VideoCapture(str(vp))
        if not cap.isOpened():
            print(f"Cannot open {vp.name}, skipped")
            continue
        name = vp.stem
        out_dir = OUT_ROOT / name
        idx = checked = flagged = 0
        by_det = {"frontal": 0, "profile": 0, "profile-mirror": 0}
        while True:
            ok, frame = cap.read()
            if not ok:
                break
            if idx % args.every == 0:
                checked += 1
                hits = detect_all(cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY), det)
                if hits:
                    flagged += 1
                    for kind in {h[0] for h in hits}:
                        by_det[kind] += 1
                    for kind, (x, y, w, h) in hits:
                        cv2.rectangle(frame, (x, y), (x + w, y + h), COLORS[kind], 3)
                        cv2.putText(frame, kind, (x, max(y - 6, 12)), cv2.FONT_HERSHEY_SIMPLEX, 0.7, COLORS[kind], 2)
                    out_dir.mkdir(parents=True, exist_ok=True)
                    cv2.imwrite(str(out_dir / f"frame_{idx:06d}.jpg"), frame)
            idx += 1
        cap.release()
        summary_rows.append([vp.name, idx, checked, flagged, by_det["frontal"], by_det["profile"], by_det["profile-mirror"]])
        print(f"{vp.name}: {idx} frames read, {checked} checked, {flagged} flagged")

    csv_path = OUT_ROOT / "summary.csv"
    with csv_path.open("w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(["recording", "frames_read", "frames_checked", "frames_flagged", "frontal", "profile", "profile_mirror"])
        w.writerows(summary_rows)

    print(f"\nSummary: {csv_path}\nFlagged frames (JPGs with boxes): {OUT_ROOT}")
    print("=" * 72)
    print("IMPORTANT: a flag is only a CANDIDATE, not a confirmed leak. The cartoon mask can")
    print("fool a detector (cartoon eyes, nose and mouth look like a face). Every flagged frame")
    print("MUST be checked by eye: is a REAL face visible, or just the mask?")
    print("Also open a few unflagged frames: a detector miss is not proof of no leak.")
    print("=" * 72)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
