"""Shared helpers: load sidecars, the look-away rule, hand labels."""
from __future__ import annotations

import csv
import json
import sys
from dataclasses import dataclass, field
from pathlib import Path

# ---- Look-away rule (change here) -------------------------------------------------
YAW_LIMIT_DEG = 25.0      # |yaw| above this counts as looking away ...
GAZE_H_LIMIT = 0.5        # ... or |gazeH| above this
MIN_DURATION_S = 1.0      # an event must last at least this long
MERGE_GAP_S = 0.5         # gaps shorter than this between two runs are merged
# ---- Matching with hand labels ------------------------------------------------------
MATCH_TOLERANCE_S = 0.5   # an event "finds" a label if they overlap within this slack
KEY_WINDOW_S = 2.0        # a key press this close to an event means "typing while looking away"


@dataclass
class Sidecar:
    path: Path
    header: dict = field(default_factory=dict)
    frames: list[dict] = field(default_factory=list)
    keys: list[float] = field(default_factory=list)   # seconds
    summary: dict = field(default_factory=dict)

    @property
    def name(self) -> str:
        return self.path.name

    @property
    def duration_s(self) -> float:
        if self.summary.get("durationS"):
            return float(self.summary["durationS"])
        return self.frames[-1]["t"] / 1000.0 if self.frames else 0.0


def fail(msg: str) -> None:
    print(msg, file=sys.stderr)
    sys.exit(1)


def load_sidecar(path: str | Path) -> Sidecar:
    path = Path(path)
    sc = Sidecar(path=path)
    with path.open(encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            rec = json.loads(line)
            kind = rec.get("type")
            if kind == "header":
                sc.header = rec
            elif kind == "frame":
                sc.frames.append(rec)
            elif kind == "key":
                sc.keys.append(rec["t"] / 1000.0)
            elif kind == "summary":
                sc.summary = rec
    return sc


def find_sidecars(folder: str | Path) -> list[Path]:
    folder = Path(folder)
    if not folder.is_dir():
        fail(f"Folder not found: {folder}")
    found = sorted(folder.glob("sidecar-*.jsonl"))
    if not found:
        fail(f"No sidecar-*.jsonl files in {folder}. Record something first (see README).")
    return found


def find_masked_videos(folder: str | Path) -> list[Path]:
    folder = Path(folder)
    if not folder.is_dir():
        fail(f"Folder not found: {folder}")
    found = sorted(folder.glob("masked-*.webm"))
    if not found:
        fail(f"No masked-*.webm files in {folder}. Record something first (see README).")
    return found


Interval = tuple[float, float]


def _is_away(f: dict) -> bool:
    if f.get("lost"):
        return False  # lost frames never count as looking away
    yaw, gaze = f.get("yaw"), f.get("gazeH")
    return (yaw is not None and abs(yaw) > YAW_LIMIT_DEG) or (gaze is not None and abs(gaze) > GAZE_H_LIMIT)


def look_away_events(frames: list[dict]) -> list[Interval]:
    """Return [(start_s, end_s)] of look-away events.

    Runs of consecutive away-frames are built first, then runs separated by less than
    MERGE_GAP_S are merged (this also bridges short tracking-lost gaps), then runs shorter
    than MIN_DURATION_S are dropped. A run lasts from its first to its last away-frame.
    """
    runs: list[list[float]] = []
    start = last = None
    for f in frames:
        t = f["t"] / 1000.0
        if _is_away(f):
            if start is None:
                start = t
            last = t
        elif start is not None:
            runs.append([start, last])
            start = last = None
    if start is not None:
        runs.append([start, last])

    merged: list[list[float]] = []
    for r in runs:
        if merged and r[0] - merged[-1][1] < MERGE_GAP_S:
            merged[-1][1] = r[1]
        else:
            merged.append(r)
    return [(a, b) for a, b in merged if b - a >= MIN_DURATION_S]


def lost_segments(frames: list[dict]) -> list[Interval]:
    """Intervals (s) where tracking was lost. Reported separately from look-aways."""
    segs: list[Interval] = []
    start = last = None
    for f in frames:
        t = f["t"] / 1000.0
        if f.get("lost"):
            if start is None:
                start = t
            last = t
        elif start is not None:
            segs.append((start, last))
            start = last = None
    if start is not None:
        segs.append((start, last))
    return segs


def lost_percent(frames: list[dict]) -> float:
    return 100.0 * sum(1 for f in frames if f.get("lost")) / len(frames) if frames else 0.0


def labels_path(sidecar_path: str | Path) -> Path:
    """sidecar-<id>.jsonl -> sidecar-<id>.labels.csv (same folder)."""
    p = Path(sidecar_path)
    return p.with_name(p.stem + ".labels.csv")


def load_labels(sidecar_path: str | Path) -> list[tuple[float, float, str]] | None:
    """Hand labels (start_s, end_s, label). None if the labels file does not exist."""
    p = labels_path(sidecar_path)
    if not p.exists():
        return None
    out = []
    with p.open(newline="", encoding="utf-8") as fh:
        for row in csv.DictReader(fh):
            out.append((float(row["start_s"]), float(row["end_s"]), (row.get("label") or "").strip()))
    return out


def percentile(values: list[float], pct: float) -> float:
    if not values:
        return float("nan")
    s = sorted(values)
    idx = pct / 100 * (len(s) - 1)
    lo, hi = int(idx), min(int(idx) + 1, len(s) - 1)
    return s[lo] + (s[hi] - s[lo]) * (idx - lo)


def fps_stats(frames: list[dict]) -> tuple[float, float]:
    """(average fps, 10th-percentile of instantaneous fps) from frame timestamps."""
    if len(frames) < 2:
        return 0.0, float("nan")
    ts = [f["t"] for f in frames]
    inst = [1000.0 / (b - a) for a, b in zip(ts, ts[1:]) if b > a]
    dur = (ts[-1] - ts[0]) / 1000.0
    return (len(ts) - 1) / dur if dur > 0 else 0.0, percentile(inst, 10)
