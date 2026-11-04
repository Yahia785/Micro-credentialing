"""Test 2: does a REAL face show in the MASKED video?

Usage:  python setup_models.py            (once: downloads the YuNet model)
        python test2_leaks.py <folder> [--every N] [--no-yunet]

The cartoon mask can fool a face detector, so a plain "face found" count is useless. Instead the
sidecar's maskBoxes (where the client drew the mask in each frame) split every detector hit into:
  INSIDE   the hit is (mostly) covered by a mask box   -> normally just the cartoon itself
  OUTSIDE  the hit is not covered by any mask box       -> candidate for a real face leak
Detectors: OpenCV Haar frontal, Haar profile (on the frame and its mirror), and YuNet (FaceDetectorYN).
Every flagged image must be looked at by a human.
"""
from __future__ import annotations

import argparse
import bisect
import csv
import random
from pathlib import Path

import cv2

from common import fail, find_masked_videos, load_sidecar

HERE = Path(__file__).resolve().parent
OUT_ROOT = HERE / "out" / "leaks"
YUNET_PATH = HERE / "models" / "face_detection_yunet_2023mar.onnx"

# ---- tunable constants ---------------------------------------------------------------
INSIDE_MIN_FRACTION = 0.5   # a hit is INSIDE if at least this share of its area is covered by one mask box
LOST_EDGE_S = 0.5           # save hits within this many seconds of a tracking-lost change
INSIDE_SAMPLE = 20          # random INSIDE frames saved per recording
YUNET_SCORE = 0.6
RANDOM_SEED = 1234

HAAR = {
    "haar-frontal": cv2.data.haarcascades + "haarcascade_frontalface_default.xml",
    "haar-profile": cv2.data.haarcascades + "haarcascade_profileface.xml",
}
COLORS = {"OUTSIDE": (0, 0, 255), "INSIDE": (0, 200, 0)}

Box = tuple[int, int, int, int]


# ---- pure helpers (unit-tested) -------------------------------------------------------
def covered_fraction(hit: Box, mask_boxes: list) -> float:
    """Largest share of the hit's area that lies inside ONE mask box (0..1)."""
    hx, hy, hw, hh = hit
    area = max(hw * hh, 1)
    best = 0.0
    for mx, my, mw, mh in mask_boxes:
        iw = min(hx + hw, mx + mw) - max(hx, mx)
        ih = min(hy + hh, my + mh) - max(hy, my)
        if iw > 0 and ih > 0:
            best = max(best, iw * ih / area)
    return best


def classify(hit: Box, mask_boxes: list) -> str:
    return "INSIDE" if covered_fraction(hit, mask_boxes) >= INSIDE_MIN_FRACTION else "OUTSIDE"


def nearest_frame(times: list[float], t: float) -> int:
    """Index of the sidecar frame time (sorted list, seconds) nearest to t."""
    i = bisect.bisect_left(times, t)
    if i == 0:
        return 0
    if i == len(times):
        return len(times) - 1
    return i if times[i] - t < t - times[i - 1] else i - 1


def lost_change_times(frames: list[dict]) -> list[float]:
    """Seconds at which `lost` flips (either direction)."""
    out, prev = [], None
    for f in frames:
        lost = bool(f.get("lost"))
        if prev is not None and lost != prev:
            out.append(f["t"] / 1000.0)
        prev = lost
    return out


def near_any(t: float, points: list[float], radius: float) -> bool:
    return any(abs(t - p) <= radius for p in points)


# ---- detectors ----------------------------------------------------------------------
class Detectors:
    def __init__(self, use_yunet: bool):
        self.haar = {}
        for k, path in HAAR.items():
            c = cv2.CascadeClassifier(path)
            if c.empty():
                fail(f"Could not load cascade {path}")
            self.haar[k] = c
        self.yunet = None
        if use_yunet:
            if not YUNET_PATH.exists():
                fail(f"YuNet model not found at {YUNET_PATH}.\nRun once:  python setup_models.py\n"
                     "(or add --no-yunet to run with the Haar detectors only; this is a weaker test)")
            self.yunet = cv2.FaceDetectorYN.create(str(YUNET_PATH), "", (320, 320), YUNET_SCORE)

    def detect(self, frame) -> list[tuple[str, Box]]:
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        kw = dict(scaleFactor=1.1, minNeighbors=5, minSize=(40, 40))
        hits = [("haar-frontal", tuple(map(int, b))) for b in self.haar["haar-frontal"].detectMultiScale(gray, **kw)]
        hits += [("haar-profile", tuple(map(int, b))) for b in self.haar["haar-profile"].detectMultiScale(gray, **kw)]
        W = gray.shape[1]
        for x, y, w, h in self.haar["haar-profile"].detectMultiScale(cv2.flip(gray, 1), **kw):
            hits.append(("haar-profile-mirror", (int(W - x - w), int(y), int(w), int(h))))
        if self.yunet is not None:
            self.yunet.setInputSize((frame.shape[1], frame.shape[0]))
            _, faces = self.yunet.detect(frame)
            for r in faces if faces is not None else []:
                hits.append(("yunet", (int(r[0]), int(r[1]), int(r[2]), int(r[3]))))
        return hits


def annotate(frame, hits: list[tuple[str, Box, str]], mask_boxes: list):
    img = frame.copy()
    for mx, my, mw, mh in mask_boxes:  # mask boxes in thin white
        cv2.rectangle(img, (int(mx), int(my)), (int(mx + mw), int(my + mh)), (255, 255, 255), 1)
    for det, (x, y, w, h), cls in hits:
        cv2.rectangle(img, (x, y), (x + w, y + h), COLORS[cls], 2)
        cv2.putText(img, f"{cls} {det}", (x, max(y - 6, 12)), cv2.FONT_HERSHEY_SIMPLEX, 0.5, COLORS[cls], 1)
    return img


# ---- main ---------------------------------------------------------------------------
def process_video(vp: Path, det: Detectors, every: int):
    name = vp.stem  # masked-<id>
    sc_path = vp.with_name(vp.name.replace("masked-", "sidecar-", 1).rsplit(".", 1)[0] + ".jsonl")
    sc = load_sidecar(sc_path) if sc_path.exists() else None
    if sc is None or not sc.frames:
        print(f"  WARNING: no sidecar for {vp.name}: every hit is treated as OUTSIDE (cannot tell mask from face)")
        times, frames, offset_ms, changes = [], [], 0.0, []
    else:
        frames = sc.frames
        times = [f["t"] / 1000.0 for f in frames]
        offset_ms = float((sc.header.get("recorderStartMs") or {}).get("masked") or 0.0)
        changes = lost_change_times(frames)
        if not any("maskBoxes" in f for f in frames):
            print("  WARNING: sidecar has no maskBoxes (recorded with an older client): every hit is OUTSIDE")

    cap = cv2.VideoCapture(str(vp))
    if not cap.isOpened():
        print(f"  cannot open {vp.name}, skipped")
        return None
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    out_dir = OUT_ROOT / name
    rnd = random.Random(RANDOM_SEED)
    reservoir: list[tuple[int, object]] = []  # (frame idx, annotated image) for INSIDE sampling
    inside_seen = 0
    idx = checked = n_out = n_in = saved = 0
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        if idx % every == 0:
            checked += 1
            vt_ms = cap.get(cv2.CAP_PROP_POS_MSEC)
            if not vt_ms or vt_ms < 0:
                vt_ms = idx * 1000.0 / fps
            t = (vt_ms + offset_ms) / 1000.0  # video time -> sidecar time
            boxes = []
            if times:
                boxes = frames[nearest_frame(times, t)].get("maskBoxes") or []
            hits = [(d, b, classify(b, boxes)) for d, b in det.detect(frame)]
            if hits:
                outs = [h for h in hits if h[2] == "OUTSIDE"]
                n_out += len(outs)
                n_in += len(hits) - len(outs)
                edge = near_any(t, changes, LOST_EDGE_S)
                if outs or edge:
                    cls = "OUTSIDE" if outs else "INSIDE"
                    out_dir.mkdir(parents=True, exist_ok=True)
                    tag = "_lostedge" if edge else ""
                    cv2.imwrite(str(out_dir / f"{cls}{tag}_frame_{idx:06d}.jpg"), annotate(frame, hits, boxes))
                    saved += 1
                elif len(outs) == 0:
                    inside_seen += 1
                    img = annotate(frame, hits, boxes)
                    if len(reservoir) < INSIDE_SAMPLE:
                        reservoir.append((idx, img))
                    else:  # reservoir sampling keeps a uniform random sample
                        j = rnd.randrange(inside_seen)
                        if j < INSIDE_SAMPLE:
                            reservoir[j] = (idx, img)
        idx += 1
    cap.release()
    for i, img in reservoir:
        out_dir.mkdir(parents=True, exist_ok=True)
        cv2.imwrite(str(out_dir / f"INSIDE_sample_frame_{i:06d}.jpg"), img)
        saved += 1
    return [vp.name, idx, checked, n_out, n_in, saved]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("folder")
    ap.add_argument("--every", type=int, default=1, help="check every Nth frame (default 1 = all)")
    ap.add_argument("--no-yunet", action="store_true", help="skip YuNet (weaker test)")
    args = ap.parse_args()
    videos = find_masked_videos(args.folder)
    det = Detectors(not args.no_yunet)
    OUT_ROOT.mkdir(parents=True, exist_ok=True)

    rows = []
    for vp in videos:
        print(f"Checking {vp.name} ...")
        r = process_video(vp, det, args.every)
        if r:
            rows.append(r)
            print(f"  frames {r[1]}, checked {r[2]}, OUTSIDE hits {r[3]}, INSIDE hits {r[4]}, frames saved for review {r[5]}")

    csv_path = OUT_ROOT / "summary.csv"
    with csv_path.open("w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(["recording", "frames", "frames_checked", "outside_hits", "inside_hits", "frames_saved_for_review"])
        w.writerows(rows)

    print(f"\nSummary CSV: {csv_path}\nImages to review: {OUT_ROOT}\\<recording>\\  (class is in the file name)")
    if args.no_yunet:
        print("NOTE: YuNet was skipped, so this run used the weaker Haar detectors only.")
    print("=" * 78)
    print("PASS RULE (decided by YOU looking at the saved images, not by this script):")
    print("  PASS only if  (1) none of the OUTSIDE_* images shows a real face, AND")
    print("                (2) none of the INSIDE_sample_* images shows a real face.")
    print("  OUTSIDE = detector hit not covered by a mask box: possible leak.")
    print("  *_lostedge_* = near a tracking-lost change, the riskiest moments.")
    print("  INSIDE  = hit on the mask itself: usually the cartoon fooling the detector.")
    print("A detector miss is not proof of no leak: also scrub a few unflagged frames of")
    print("hand-over-face, fast-motion and leave-frame by eye.")
    print("=" * 78)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
