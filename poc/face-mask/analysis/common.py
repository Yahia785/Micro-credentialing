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
# Calibrated eye thresholds (option): enter = EDGE_FACTOR x (that side's edge reading - baseline), but at least
# MIN_ENTER (so jitter cannot trigger it); exit = enter x EXIT_RATIO.
EDGE_FACTOR = 1.2
MIN_ENTER = 0.15
EXIT_RATIO = 0.7
THRESHOLDS_MODE = "fixed"  # "fixed" (GAZE_ENTER / GAZE_EXIT) or "calibrated" (from the sidecar header)
# Speed rule (test 1)
SPEED_PASS_FPS = 15.0
SPEED_MIN_FPS = 10.0
GAZE_SOURCE = "blend"       # "blend" (blendshape based, blendH; default) or "iris" (landmark based, gazeH)
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


@dataclass(frozen=True)
class Thresholds:
    """Eye-gaze thresholds on the value MINUS the baseline. Positive and negative side are separate."""
    enter_pos: float
    exit_pos: float
    enter_neg: float
    exit_neg: float

    @staticmethod
    def symmetric(enter: float, exit_: float) -> "Thresholds":
        return Thresholds(enter, exit_, enter, exit_)

    def text(self) -> str:
        return (f"enter +{self.enter_pos:.2f} / -{self.enter_neg:.2f}, "
                f"exit +{self.exit_pos:.2f} / -{self.exit_neg:.2f}")


FIXED_THRESHOLDS = Thresholds.symmetric(GAZE_ENTER, GAZE_EXIT)


def thresholds_from_edges(base, left, right, factor: float = EDGE_FACTOR, min_enter: float = MIN_ENTER,
                          ratio: float = EXIT_RATIO) -> Thresholds | None:
    """Per-person eye thresholds from the calibration.

    For each edge: d = edge reading - baseline.  enter = max(factor * |d|, min_enter), exit = enter * ratio.
    The edge whose d is positive sets the positive side, the edge whose d is negative sets the negative side.
    If only one side is usable the other side copies it (people are roughly symmetric).
    Returns None if neither edge gives a usable reading.
    """
    if base is None:
        return None
    deltas = [x - base for x in (left, right) if x is not None]
    pos = [d for d in deltas if d > 0]
    neg = [-d for d in deltas if d < 0]
    if not pos and not neg:
        return None
    mp = max(pos) if pos else max(neg)
    mn = max(neg) if neg else max(pos)
    ep, en = max(factor * mp, min_enter), max(factor * mn, min_enter)
    return Thresholds(ep, ep * ratio, en, en * ratio)


def hysteresis_runs(times: list[float], values: list[float | None], enter, exit_=None) -> list[list[float]]:
    """[[start, end], ...] of runs where the value goes above +enter (or below -enter) and stays beyond the exit level.

    `enter`/`exit_` are numbers (same on both sides) or `enter` is a Thresholds object.
    A missing value (None, e.g. tracking lost) ends the run: it never counts as looking away.
    A run lasts from its first to its last active frame. A direct flip from one side to the other starts a new run.
    """
    th = enter if isinstance(enter, Thresholds) else Thresholds.symmetric(enter, exit_)
    runs: list[list[float]] = []
    start = last = None
    side = 0
    for t, v in zip(times, values):
        if side == 1 and v is not None and v > th.exit_pos:
            last = t
            continue
        if side == -1 and v is not None and v < -th.exit_neg:
            last = t
            continue
        if side != 0:
            runs.append([start, last])
            start = last = None
            side = 0
        if v is not None and v > th.enter_pos:
            side, start, last = 1, t, t
        elif v is not None and v < -th.enter_neg:
            side, start, last = -1, t, t
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


union_intervals = _union  # public name (used by the server analyzer)


def head_events(frames: list[dict], yaw_base: float = 0.0, smoothed: bool = USE_SMOOTHED,
                min_duration: float | None = None) -> list[Interval]:
    times, vals = [], []
    for f in frames:
        y = None if f.get("lost") else reading(f, "yaw", smoothed)
        times.append(f["t"] / 1000.0)
        vals.append(None if y is None else y - yaw_base)
    return merge_and_filter(hysteresis_runs(times, vals, YAW_ENTER_DEG, YAW_EXIT_DEG),
                            HEAD_MIN_DURATION_S if min_duration is None else min_duration)


def eye_events(frames: list[dict], gaze_base: float = 0.0, source: str = GAZE_SOURCE, smoothed: bool = USE_SMOOTHED,
               thresholds: Thresholds | None = None, min_duration: float | None = None) -> list[Interval]:
    name = _gaze_name(source)
    th = thresholds or FIXED_THRESHOLDS
    times, vals = [], []
    for f in frames:
        g = None if f.get("lost") else reading(f, name, smoothed)
        times.append(f["t"] / 1000.0)
        vals.append(None if g is None else g - gaze_base)
    return merge_and_filter(hysteresis_runs(times, vals, th),
                            EYE_MIN_DURATION_S if min_duration is None else min_duration)


def look_away_events(frames: list[dict], yaw_base: float = 0.0, gaze_base: float = 0.0,
                     gaze_source: str = GAZE_SOURCE, smoothed: bool = USE_SMOOTHED,
                     thresholds: Thresholds | None = None) -> list[Interval]:
    """Head events OR eye events, as [(start_s, end_s)]. Lost frames never count as looking away
    (but a lost gap shorter than MERGE_GAP_S between two runs is bridged)."""
    return _union(head_events(frames, yaw_base, smoothed),
                  eye_events(frames, gaze_base, gaze_source, smoothed, thresholds))


def baseline_of(sc: "Sidecar", smoothed: bool = USE_SMOOTHED) -> dict:
    """Calibration baseline from the sidecar header ({} if the recording has none)."""
    cal = sc.header.get("calibration") or {}
    return cal.get("baseline" if smoothed else "baselineRaw") or cal.get("baseline") or {}


def thresholds_for(sc: "Sidecar", gaze_source: str = GAZE_SOURCE, smoothed: bool = USE_SMOOTHED,
                   mode: str = THRESHOLDS_MODE) -> tuple[Thresholds, str]:
    """Eye thresholds to use for this recording and a one-line description of what was used."""
    if mode not in ("fixed", "calibrated"):
        raise ValueError("thresholds mode must be 'fixed' or 'calibrated'")
    fixed = (FIXED_THRESHOLDS, f"fixed ({FIXED_THRESHOLDS.text()})")
    if mode == "fixed":
        return fixed
    name = _gaze_name(gaze_source)
    cal = sc.header.get("calibration") or {}
    edges = cal.get("edges") or {}
    suffix = "" if smoothed else "Raw"
    left = (edges.get("left" + suffix) or edges.get("left") or {}).get(name)
    right = (edges.get("right" + suffix) or edges.get("right") or {}).get(name)
    base = baseline_of(sc, smoothed).get(name)
    th = thresholds_from_edges(base, left, right)
    if th is None:
        return FIXED_THRESHOLDS, f"fixed ({FIXED_THRESHOLDS.text()}); calibrated thresholds unavailable, no usable edge readings"
    shown = lambda v: "-" if v is None else f"{v:+.2f}"  # noqa: E731
    return th, f"calibrated ({th.text()}; edges L {shown(left)}, R {shown(right)}, baseline {shown(base)})"


def sidecar_events(sc: "Sidecar", gaze_source: str = GAZE_SOURCE, smoothed: bool = USE_SMOOTHED,
                   thresholds_mode: str = THRESHOLDS_MODE) -> list[Interval]:
    """Look-away events of a recording, using its own calibration baseline (and edges, if calibrated)."""
    b = baseline_of(sc, smoothed)
    gname = _gaze_name(gaze_source)
    th, _ = thresholds_for(sc, gaze_source, smoothed, thresholds_mode)
    return look_away_events(sc.frames, b.get("yaw") or 0.0, b.get(gname) or 0.0, gaze_source, smoothed, th)


def speed_label(avg_fps: float) -> str:
    """Test 1 rule: PASS at 15 fps or more, 'OK (minimum)' at 10 to 15, FAIL below 10."""
    if avg_fps >= SPEED_PASS_FPS:
        return "PASS"
    if avg_fps >= SPEED_MIN_FPS:
        return "OK (minimum)"
    return "FAIL"


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
