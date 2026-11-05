"""Shared helpers: load sidecars, the look-away rule, hand labels."""
from __future__ import annotations

import csv
import json
import sys
from dataclasses import dataclass, field
from pathlib import Path

# ---- Look-away rule (change here) -------------------------------------------------
# All values are taken MINUS the person's calibration baseline (sidecar header).
# Head: |yaw - baseline| above YAW_ENTER_DEG for at least HEAD_MIN_DURATION_S.
YAW_ENTER_DEG = 25.0
YAW_EXIT_DEG = 25.0         # equal to enter = no hysteresis for the head; lower it to add some
HEAD_MIN_DURATION_S = 1.0
# Eyes: |gaze - baseline| above GAZE_ENTER starts an event, it only ends below GAZE_EXIT
# (hysteresis, so a value hovering near 0.5 gives ONE event, not many). Must last EYE_MIN_DURATION_S.
GAZE_ENTER = 0.5
GAZE_EXIT = 0.35
EYE_MIN_DURATION_S = 1.5
MERGE_GAP_S = 0.5           # gaps shorter than this between two runs are merged
GAZE_SOURCE = "iris"        # "iris" (landmark based, gazeH) or "blend" (blendshape based, blendH)
USE_SMOOTHED = True         # False = use the *Raw fields (to compare raw against smoothed)
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


def reading(f: dict, name: str, smoothed: bool = True):
    """Value of a reading in a frame. smoothed=False uses <name>Raw. Old sidecars without Raw fields fall back to <name>."""
    if not smoothed and (name + "Raw") in f:
        return f[name + "Raw"]
    return f.get(name)


def _gaze_name(source: str) -> str:
    if source not in ("iris", "blend"):
        raise ValueError("gaze source must be 'iris' or 'blend'")
    return "gazeH" if source == "iris" else "blendH"


def hysteresis_runs(times: list[float], values: list[float | None], enter: float, exit_: float) -> list[list[float]]:
    """[[start, end], ...] of runs where |value| goes above `enter` and stays above `exit_`.

    A missing value (None, e.g. tracking lost) ends the run: it never counts as looking away.
    A run lasts from its first to its last active frame.
    """
    runs: list[list[float]] = []
    start = last = None
    for t, v in zip(times, values):
        mag = None if v is None else abs(v)
        active = start is not None
        if mag is not None and (mag > exit_ if active else mag > enter):
            if start is None:
                start = t
            last = t
        elif start is not None:
            runs.append([start, last])
            start = last = None
    if start is not None:
        runs.append([start, last])
    return runs


def merge_and_filter(runs: list[list[float]], min_duration: float) -> list[Interval]:
    merged: list[list[float]] = []
    for r in runs:
        if merged and r[0] - merged[-1][1] < MERGE_GAP_S:
            merged[-1][1] = r[1]
        else:
            merged.append(list(r))
    return [(a, b) for a, b in merged if b - a >= min_duration]


def _union(a: list[Interval], b: list[Interval]) -> list[Interval]:
    out: list[list[float]] = []
    for s, e in sorted(a + b):
        if out and s - out[-1][1] < MERGE_GAP_S:
            out[-1][1] = max(out[-1][1], e)
        else:
            out.append([s, e])
    return [(s, e) for s, e in out]


def head_events(frames: list[dict], yaw_base: float = 0.0, smoothed: bool = USE_SMOOTHED) -> list[Interval]:
    times, vals = [], []
    for f in frames:
        y = None if f.get("lost") else reading(f, "yaw", smoothed)
        times.append(f["t"] / 1000.0)
        vals.append(None if y is None else y - yaw_base)
    return merge_and_filter(hysteresis_runs(times, vals, YAW_ENTER_DEG, YAW_EXIT_DEG), HEAD_MIN_DURATION_S)


def eye_events(frames: list[dict], gaze_base: float = 0.0, source: str = GAZE_SOURCE, smoothed: bool = USE_SMOOTHED) -> list[Interval]:
    name = _gaze_name(source)
    times, vals = [], []
    for f in frames:
        g = None if f.get("lost") else reading(f, name, smoothed)
        times.append(f["t"] / 1000.0)
        vals.append(None if g is None else g - gaze_base)
    return merge_and_filter(hysteresis_runs(times, vals, GAZE_ENTER, GAZE_EXIT), EYE_MIN_DURATION_S)


def look_away_events(frames: list[dict], yaw_base: float = 0.0, gaze_base: float = 0.0,
                     gaze_source: str = GAZE_SOURCE, smoothed: bool = USE_SMOOTHED) -> list[Interval]:
    """Head events OR eye events, as [(start_s, end_s)]. Lost frames never count as looking away
    (but a lost gap shorter than MERGE_GAP_S between two runs is bridged)."""
    return _union(head_events(frames, yaw_base, smoothed), eye_events(frames, gaze_base, gaze_source, smoothed))


def baseline_of(sc: "Sidecar", smoothed: bool = USE_SMOOTHED) -> dict:
    """Calibration baseline from the sidecar header ({} if the recording has none)."""
    cal = sc.header.get("calibration") or {}
    return cal.get("baseline" if smoothed else "baselineRaw") or cal.get("baseline") or {}


def sidecar_events(sc: "Sidecar", gaze_source: str = GAZE_SOURCE, smoothed: bool = USE_SMOOTHED) -> list[Interval]:
    """Look-away events of a recording, using its own calibration baseline."""
    b = baseline_of(sc, smoothed)
    gname = _gaze_name(gaze_source)
    return look_away_events(sc.frames, b.get("yaw") or 0.0, b.get(gname) or 0.0, gaze_source, smoothed)


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
