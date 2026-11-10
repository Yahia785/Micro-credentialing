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
    key_events: list[tuple[float, str]] = field(default_factory=list)   # (seconds, category); the key itself is never stored
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
                sc.key_events.append((rec["t"] / 1000.0, rec.get("cat") or "unknown"))
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


# =====================================================================================================
# Vertical gaze, screen and keyboard zones, off-screen looks, copy pattern, typing features
# =====================================================================================================
# Real cheating is reading from a phone below the camera or a second screen at the side or up. The rule above
# only sees horizontal gaze and yaw. These rules add vertical gaze (blendV) and head pitch, and ask one question:
# is the person looking at the SCREEN or at the KEYBOARD, or somewhere else?
#
# Zones come from the calibration points in the sidecar header: centre, left, right, top, bottom (the screen) and
# keyboard. A zone is a box in (gaze horizontal, gaze vertical) and a box in (yaw, pitch).
ZONE_GAZE_MARGIN = 0.15          # added around the box spanned by the screen readings (gaze units)
ZONE_HEAD_MARGIN_DEG = 8.0       # same for yaw and pitch (degrees)
KEYBOARD_GAZE_MARGIN = 0.25      # box around the keyboard reading
KEYBOARD_HEAD_MARGIN_DEG = 10.0
# Fallback half-ranges, used ONLY for an axis whose calibration readings are missing (recordings made before the
# vertical calibration existed). Results from fallback zones are guesses: see Zones.note.
FALLBACK_GAZE_H_HALF = 0.30
FALLBACK_GAZE_V_HALF = 0.30
FALLBACK_YAW_HALF_DEG = 15.0
FALLBACK_PITCH_HALF_DEG = 10.0
DERIVED_V_TAU_S = 0.16           # smoothing of blendV derived from the eyeLook* scores (old sidecars have no blendV)
OFFSCREEN_MIN_DURATION_S = 1.5   # off-screen look: outside both zones for at least this long
COPY_MIN_CYCLES = 3              # copy_pattern: at least this many (off-screen look, then typing) cycles ...
COPY_WINDOW_S = 60.0             # ... within this many seconds
COPY_TYPING_WINDOW_S = 3.0       # typing must start within this long after the look ends
TYPING_FEATURE_WINDOW_S = 10.0   # typing features are computed over this window (starting where the look ended)
TYPING_PAUSE_S = 1.0             # a gap without a key press longer than this is a pause
DEFAULT_LEFT_IS_POSITIVE = True  # image-right = student's left: yaw, blendH and gazeH are + when the student looks LEFT
DEFAULT_UP_IS_POSITIVE = False   # pitch, gazeV and blendV are + when looking DOWN
_MIN_H_DIFF, _MIN_YAW_DIFF = 0.02, 1.0


def gaze_names(source: str) -> tuple[str, str]:
    if source not in ("iris", "blend"):
        raise ValueError("gaze source must be 'iris' or 'blend'")
    return ("gazeH", "gazeV") if source == "iris" else ("blendH", "blendV")


def blend_v_from_scores(f: dict) -> float | None:
    """Vertical blendshape gaze from the eyeLook* scores of a frame (+ = down). None if a score is missing."""
    dl, dr, ul, ur = (f.get(k) for k in ("eyeLookDownLeft", "eyeLookDownRight", "eyeLookUpLeft", "eyeLookUpRight"))
    if None in (dl, dr, ul, ur):
        return None
    return (dl + dr - ul - ur) / 2


def smooth_series(times_s: list[float], values: list[float | None], tau: float = DERIVED_V_TAU_S) -> list[float | None]:
    """Time-based exponential smoothing; a missing value restarts it."""
    import math
    out: list[float | None] = []
    prev = prev_t = None
    for t, v in zip(times_s, values):
        if v is None:
            prev = prev_t = None
            out.append(None)
            continue
        if prev is None:
            prev = v
        else:
            a = 1 - math.exp(-max(t - prev_t, 1e-6) / tau)
            prev = prev + a * (v - prev)
        prev_t = t
        out.append(prev)
    return out


def gaze_series(frames: list[dict], source: str = GAZE_SOURCE, smoothed: bool = USE_SMOOTHED):
    """([h per frame], [v per frame], v_was_derived). None for lost frames or missing values.

    Sidecars recorded before vertical gaze existed have no blendV: it is derived from the eyeLook* scores (and
    smoothed here, because the saved scores are raw)."""
    hn, vn = gaze_names(source)
    hs = [None if f.get("lost") else reading(f, hn, smoothed) for f in frames]
    has_v = any(f.get(vn) is not None or f.get(vn + "Raw") is not None for f in frames)
    if source == "blend" and not has_v:
        raw = [None if f.get("lost") else blend_v_from_scores(f) for f in frames]
        times = [f["t"] / 1000.0 for f in frames]
        return hs, (smooth_series(times, raw) if smoothed else raw), True
    return hs, [None if f.get("lost") else reading(f, vn, smoothed) for f in frames], False


@dataclass(frozen=True)
class Box:
    """Axis-aligned box in two readings: a (horizontal-like) and b (vertical-like)."""
    lo_a: float
    hi_a: float
    lo_b: float
    hi_b: float

    def contains(self, a: float, b: float) -> bool:
        return self.lo_a <= a <= self.hi_a and self.lo_b <= b <= self.hi_b

    def worst(self, a: float, b: float) -> tuple[str, int, float]:
        """(axis 'a' or 'b', side -1 below / +1 above the box, how far outside as a share of the box size)."""
        span_a = max(self.hi_a - self.lo_a, 1e-6)
        span_b = max(self.hi_b - self.lo_b, 1e-6)
        cands = [("a", 0, 0.0)]
        if a < self.lo_a:
            cands.append(("a", -1, (self.lo_a - a) / span_a))
        if a > self.hi_a:
            cands.append(("a", 1, (a - self.hi_a) / span_a))
        if b < self.lo_b:
            cands.append(("b", -1, (self.lo_b - b) / span_b))
        if b > self.hi_b:
            cands.append(("b", 1, (b - self.hi_b) / span_b))
        return max(cands, key=lambda c: c[2])


@dataclass(frozen=True)
class Zones:
    gaze: Box                       # screen zone in (gaze h, gaze v)
    head: Box                       # screen zone in (yaw, pitch)
    kb_gaze: Box | None             # keyboard zone (None if the calibration had no keyboard reading)
    kb_head: Box | None
    h_left_positive: bool           # gaze h grows when looking LEFT (from the student's point of view)
    v_up_positive: bool
    yaw_left_positive: bool
    pitch_up_positive: bool
    note: str                       # "calibrated" or what had to be guessed


def _cal_point(header: dict, name: str, smoothed: bool) -> dict | None:
    cal = header.get("calibration") or {}
    if name == "center":
        return cal.get("baseline" if smoothed else "baselineRaw") or cal.get("baseline") or None
    edges = cal.get("edges") or {}
    return edges.get(name + ("" if smoothed else "Raw")) or edges.get(name) or None


def build_zones(header: dict, source: str = GAZE_SOURCE, smoothed: bool = USE_SMOOTHED) -> Zones | None:
    """Screen and keyboard zones from the calibration in the sidecar header. None if there is no calibration."""
    hn, vn = gaze_names(source)
    pts = {n: _cal_point(header, n, smoothed) for n in ("center", "left", "right", "top", "bottom", "keyboard")}
    c = pts["center"]
    if not c or any(c.get(k) is None for k in (hn, "yaw", "pitch")):
        return None
    cv = c.get(vn)
    if cv is None:
        cv = 0.0
    guessed: list[str] = []

    def vals(key: str, names: tuple[str, ...]) -> list[float]:
        return [pts[n][key] for n in names if pts[n] and pts[n].get(key) is not None]

    screen = ("center", "left", "right", "top", "bottom")
    side_pts = ("left", "right")
    ud_pts = ("top", "bottom")

    def span(key: str, edge_names: tuple[str, ...], center: float, fallback: float, margin: float, label: str):
        if vals(key, edge_names):
            v = vals(key, screen)
            return min(v) - margin, max(v) + margin
        guessed.append(label)
        return center - fallback - margin, center + fallback + margin

    gh = span(hn, side_pts, c[hn], FALLBACK_GAZE_H_HALF, ZONE_GAZE_MARGIN, "horizontal gaze")
    gv = span(vn, ud_pts, cv, FALLBACK_GAZE_V_HALF, ZONE_GAZE_MARGIN, "vertical gaze (no top/bottom reading)")
    hy = span("yaw", side_pts, c["yaw"], FALLBACK_YAW_HALF_DEG, ZONE_HEAD_MARGIN_DEG, "yaw")
    hp = span("pitch", ud_pts, c["pitch"], FALLBACK_PITCH_HALF_DEG, ZONE_HEAD_MARGIN_DEG, "pitch (no top/bottom reading)")

    kb = pts["keyboard"]
    kb_gaze = kb_head = None
    if kb and kb.get(hn) is not None and kb.get(vn) is not None:
        m = KEYBOARD_GAZE_MARGIN
        kb_gaze = Box(kb[hn] - m, kb[hn] + m, kb[vn] - m, kb[vn] + m)
    if kb and kb.get("yaw") is not None and kb.get("pitch") is not None:
        m = KEYBOARD_HEAD_MARGIN_DEG
        kb_head = Box(kb["yaw"] - m, kb["yaw"] + m, kb["pitch"] - m, kb["pitch"] + m)
    if kb_gaze is None and kb_head is None:
        guessed.append("no keyboard zone")

    def sign(key: str, a: str, b: str, min_diff: float, default: bool) -> bool:
        pa, pb = pts[a], pts[b]
        if pa and pb and pa.get(key) is not None and pb.get(key) is not None and abs(pa[key] - pb[key]) >= min_diff:
            return pa[key] > pb[key]
        return default

    return Zones(
        gaze=Box(gh[0], gh[1], gv[0], gv[1]), head=Box(hy[0], hy[1], hp[0], hp[1]), kb_gaze=kb_gaze, kb_head=kb_head,
        h_left_positive=sign(hn, "left", "right", _MIN_H_DIFF, DEFAULT_LEFT_IS_POSITIVE),
        v_up_positive=sign(vn, "top", "bottom", _MIN_H_DIFF, DEFAULT_UP_IS_POSITIVE),
        yaw_left_positive=sign("yaw", "left", "right", _MIN_YAW_DIFF, DEFAULT_LEFT_IS_POSITIVE),
        pitch_up_positive=sign("pitch", "top", "bottom", _MIN_YAW_DIFF, DEFAULT_UP_IS_POSITIVE),
        note="calibrated" if not guessed else "partly guessed: " + ", ".join(guessed),
    )


def _direction(axis: str, side: int, left_positive: bool, up_positive: bool) -> str:
    if axis == "a":  # horizontal: side +1 = value above the box
        return ("left" if left_positive else "right") if side > 0 else ("right" if left_positive else "left")
    return ("up" if up_positive else "down") if side > 0 else ("down" if up_positive else "up")


def offscreen_direction(h, v, yaw, pitch, z: Zones) -> tuple[str, str] | None:
    """(direction, 'gaze' or 'head') if gaze OR head is outside BOTH the screen zone and the keyboard zone, else None.

    direction is left, right, up or down as seen by the student (decided from the calibration, not from sign
    conventions). If both gaze and head are outside, the one that is further outside names the direction."""
    cands = []
    if h is not None and v is not None and not z.gaze.contains(h, v) and not (z.kb_gaze and z.kb_gaze.contains(h, v)):
        axis, side, ex = z.gaze.worst(h, v)
        cands.append((ex, _direction(axis, side, z.h_left_positive, z.v_up_positive), "gaze"))
    if yaw is not None and pitch is not None and not z.head.contains(yaw, pitch) and not (z.kb_head and z.kb_head.contains(yaw, pitch)):
        axis, side, ex = z.head.worst(yaw, pitch)
        cands.append((ex, _direction(axis, side, z.yaw_left_positive, z.pitch_up_positive), "head"))
    if not cands:
        return None
    _, d, m = max(cands, key=lambda c: c[0])
    return d, m


def offscreen_events(frames: list[dict], z: Zones, source: str = GAZE_SOURCE, smoothed: bool = USE_SMOOTHED,
                     min_duration: float | None = None) -> list[dict]:
    """Off-screen looks: [{start, end, direction, dirs (frames per direction), mods (frames per gaze/head)}].

    Runs of off-screen frames, gaps shorter than MERGE_GAP_S merged, at least `min_duration`
    (default OFFSCREEN_MIN_DURATION_S). Lost frames are never off-screen."""
    hs, vs, _ = gaze_series(frames, source, smoothed)
    runs: list[dict] = []
    cur = None
    for f, h, v in zip(frames, hs, vs):
        d = None if f.get("lost") else offscreen_direction(h, v, reading(f, "yaw", smoothed), reading(f, "pitch", smoothed), z)
        t = f["t"] / 1000.0
        if d is None:
            if cur:
                runs.append(cur)
                cur = None
            continue
        if cur is None:
            cur = {"start": t, "end": t, "dirs": {}, "mods": {}}
        cur["end"] = t
        cur["dirs"][d[0]] = cur["dirs"].get(d[0], 0) + 1
        cur["mods"][d[1]] = cur["mods"].get(d[1], 0) + 1
    if cur:
        runs.append(cur)
    merged: list[dict] = []
    for r in runs:
        if merged and r["start"] - merged[-1]["end"] < MERGE_GAP_S:
            m = merged[-1]
            m["end"] = r["end"]
            for key in ("dirs", "mods"):
                for k, n in r[key].items():
                    m[key][k] = m[key].get(k, 0) + n
        else:
            merged.append(r)
    need = OFFSCREEN_MIN_DURATION_S if min_duration is None else min_duration
    out = []
    for m in merged:
        if m["end"] - m["start"] >= need:
            m["direction"] = max(m["dirs"], key=lambda k: m["dirs"][k])
            out.append(m)
    return out


# ---- typing: key categories, features per window, cycles, copy pattern ---------------------------------

def typing_features(key_events: list[tuple[float, str]], t0: float, window: float = TYPING_FEATURE_WINDOW_S) -> dict:
    """Typing features of the window [t0, t0 + window): keys, keys per second, pauses (gaps without a key longer
    than TYPING_PAUSE_S, counting the silence before the first and after the last key), and the share of
    backspace presses. key_events holds (time_s, category): never the keys themselves."""
    ks = [(t, c) for t, c in key_events if t0 <= t < t0 + window]
    n = len(ks)
    edges = [t0] + [t for t, _ in ks] + [t0 + window]
    pauses = sum(1 for a, b in zip(edges, edges[1:]) if b - a > TYPING_PAUSE_S)
    backs = sum(1 for _, c in ks if c == "backspace")
    return {"t0": round(t0, 2), "keys": n, "keys_per_s": round(n / window, 2), "pauses": pauses,
            "backspace_ratio": round(backs / n, 3) if n else None}


def find_cycles(events: list[dict], key_events: list[tuple[float, str]],
                typing_window: float = COPY_TYPING_WINDOW_S) -> list[dict]:
    """A cycle = an off-screen look followed by typing within `typing_window` seconds after it ended."""
    cycles = []
    for ev in events:
        typed = [t for t, _ in key_events if ev["end"] <= t <= ev["end"] + typing_window]
        if typed:
            cycles.append({"start": ev["start"], "end": ev["end"], "direction": ev["direction"], "typing_start": typed[0],
                           "features": typing_features(key_events, ev["end"])})
    return cycles


def directions_text(directions: dict[str, int]) -> str:
    return ", ".join(f"{d} x{n}" for d, n in sorted(directions.items(), key=lambda kv: (-kv[1], kv[0])))


def copy_patterns(cycles: list[dict], min_cycles: int = COPY_MIN_CYCLES, window: float = COPY_WINDOW_S) -> list[dict]:
    """copy_pattern: at least `min_cycles` cycles whose starts lie within `window` seconds.

    Returns [{start, end, cycles, directions, features, n_cycles}] (one per cluster of qualifying cycles)."""
    cs = sorted(cycles, key=lambda c: c["start"])
    n = len(cs)
    marked = [False] * n
    for i in range(n):
        j = i
        while j + 1 < n and cs[j + 1]["start"] - cs[i]["start"] <= window:
            j += 1
        if j - i + 1 >= min_cycles:
            for k in range(i, j + 1):
                marked[k] = True
    clusters: list[list[dict]] = []
    for k in range(n):
        if not marked[k]:
            continue
        if clusters and cs[k]["start"] - clusters[-1][-1]["start"] <= window:
            clusters[-1].append(cs[k])
        else:
            clusters.append([cs[k]])
    out = []
    for cl in clusters:
        dirs: dict[str, int] = {}
        for c in cl:
            dirs[c["direction"]] = dirs.get(c["direction"], 0) + 1
        feats = [c["features"] for c in cl]
        brs = [f["backspace_ratio"] for f in feats if f["backspace_ratio"] is not None]
        out.append({
            "start": cl[0]["start"], "end": cl[-1]["end"], "cycles": cl, "n_cycles": len(cl), "directions": dirs,
            "features": {"keys_per_s": round(sum(f["keys_per_s"] for f in feats) / len(feats), 2),
                         "pauses": round(sum(f["pauses"] for f in feats) / len(feats), 1),
                         "backspace_ratio": round(sum(brs) / len(brs), 3) if brs else None},
        })
    return out


def copy_pattern_text(cp: dict) -> str:
    f = cp["features"]
    br = "no backspace data" if f["backspace_ratio"] is None else f"{100 * f['backspace_ratio']:.0f}% backspace"
    return (f"{cp['n_cycles']} cycles in {cp['end'] - cp['start']:.0f} s ({directions_text(cp['directions'])}); "
            f"typing after the looks: {f['keys_per_s']:.1f} keys/s, {f['pauses']:.1f} pauses over {TYPING_PAUSE_S:g} s per {TYPING_FEATURE_WINDOW_S:g} s window, {br}")


def off_screen_events_of(sc: "Sidecar", gaze_source: str = GAZE_SOURCE, smoothed: bool = USE_SMOOTHED,
                         min_duration: float | None = None) -> tuple[list[dict], Zones | None]:
    z = build_zones(sc.header, gaze_source, smoothed)
    return (offscreen_events(sc.frames, z, gaze_source, smoothed, min_duration) if z else []), z


def all_look_events(sc: "Sidecar", gaze_source: str = GAZE_SOURCE, smoothed: bool = USE_SMOOTHED,
                    thresholds_mode: str = THRESHOLDS_MODE) -> list[dict]:
    """Every look-away or off-screen event of a recording: [{start, end, kind ('look_away' or 'off_screen'), direction or None}]."""
    ev = [{"start": a, "end": b, "kind": "look_away", "direction": None}
          for a, b in sidecar_events(sc, gaze_source, smoothed, thresholds_mode)]
    off, _ = off_screen_events_of(sc, gaze_source, smoothed)
    ev += [{"start": e["start"], "end": e["end"], "kind": "off_screen", "direction": e["direction"]} for e in off]
    return sorted(ev, key=lambda e: e["start"])


def load_labels_ex(sidecar_path: str | Path) -> list[dict] | None:
    """Hand labels with the optional 'direction' column (left, right, up, down; empty = any)."""
    p = labels_path(sidecar_path)
    if not p.exists():
        return None
    out = []
    with p.open(newline="", encoding="utf-8") as fh:
        for row in csv.DictReader(fh):
            out.append({"start": float(row["start_s"]), "end": float(row["end_s"]),
                        "label": (row.get("label") or "").strip(), "direction": (row.get("direction") or "").strip().lower()})
    return out
