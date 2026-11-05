"""Flags that come from the sidecar file only (no video): looking away, looking away while typing, tracking lost."""
from __future__ import annotations

from pathlib import Path

from . import config
from .rules import common
from .spans import join_intervals


def _flag(ftype: str, start: float, end: float, meta: dict, touches_start: bool, touches_end: bool,
          evidence: str, min_dur: float) -> dict:
    return {
        "type": ftype, "start_s": start, "end_s": end, "confidence": 1.0, "source": "sidecar",
        "evidence": evidence, "touches_start": touches_start, "touches_end": touches_end, "_meta": meta,
        "_min": min_dur,
    }


def _median_dt(times: list[float]) -> float:
    d = sorted(b - a for a, b in zip(times, times[1:]) if b > a)
    return d[len(d) // 2] if d else 0.1


def sidecar_flags(frames: list[dict], keys_s: list[float], header: dict | None, *,
                  gaze_source: str | None = None, smoothed: bool | None = None,
                  thresholds_mode: str | None = None) -> list[dict]:
    """Flags for ONE chunk of sidecar frames (t in ms on the session timeline).

    The look-away rule is the one in analysis/common.py (baseline-relative, hysteresis, durations).
    Events shorter than the rule's minimum are kept only if they touch the first or last frame of the chunk
    (they may continue in the neighbouring chunk); merge_flags drops them if they stay short.
    """
    if not frames:
        return []
    gaze_source = gaze_source or common.GAZE_SOURCE
    smoothed = common.USE_SMOOTHED if smoothed is None else smoothed
    mode = thresholds_mode or common.THRESHOLDS_MODE
    sc = common.Sidecar(path=Path("chunk"), header=header or {}, frames=frames, keys=list(keys_s))
    base = common.baseline_of(sc, smoothed)
    gname = "gazeH" if gaze_source == "iris" else "blendH"
    th, _ = common.thresholds_for(sc, gaze_source, smoothed, mode)

    times = [f["t"] / 1000.0 for f in frames]
    t_first, t_last = times[0], times[-1]
    interval = _median_dt(times)

    def edges(s: float, e: float) -> tuple[bool, bool]:
        return s <= t_first + config.EDGE_TOL_S, e >= t_last - config.EDGE_TOL_S

    def keep(ev: tuple[float, float], min_dur: float) -> bool:
        ts, te = edges(*ev)
        return (ev[1] - ev[0]) >= min_dur or ts or te

    head_all = common.head_events(frames, base.get("yaw") or 0.0, smoothed, min_duration=0.0)
    eye_all = common.eye_events(frames, base.get(gname) or 0.0,
                                gaze_source, smoothed, th, min_duration=0.0)
    head = [e for e in head_all if keep(e, common.HEAD_MIN_DURATION_S)]
    eyes = [e for e in eye_all if keep(e, common.EYE_MIN_DURATION_S)]

    out: list[dict] = []
    for s, e in common.union_intervals(head, eyes):
        ts, te = edges(s, e)
        is_head = any(h[0] < e and h[1] > s for h in head)
        is_eyes = any(h[0] < e and h[1] > s for h in eyes)
        parts = []
        mins = []
        if is_head:
            mins.append(common.HEAD_MIN_DURATION_S)
        if is_eyes:
            mins.append(common.EYE_MIN_DURATION_S)
        if is_head:
            parts.append(f"head turned more than {common.YAW_ENTER_DEG:g} deg from the calibrated centre")
        if is_eyes:
            parts.append(f"{'blendshape' if gaze_source == 'blend' else 'iris'} gaze beyond the threshold")
        text = " and ".join(parts)
        out.append(_flag("looking_away", s, e, {"kind": "text", "text": text}, ts, te, text, min(mins)))

    # Main rule: a key press during the look-away or within KEY_WINDOW_S of it.
    for f in [f for f in out if f["type"] == "looking_away"]:
        w = common.KEY_WINDOW_S
        n = sum(1 for k in keys_s if f["start_s"] - w <= k <= f["end_s"] + w)
        if n:
            text = f"key press during or within {w:g} s of the look-away"
            out.append(_flag("looking_away_while_typing", f["start_s"], f["end_s"], {"kind": "text", "text": text},
                             f["touches_start"], f["touches_end"], text, f["_min"]))

    # Tracking lost (reported, not an accusation). Flicker is joined first, then the minimum duration applies.
    segs = common.lost_segments(frames)
    segs = join_intervals([(a, b + interval) for a, b in segs], config.JOIN_GAP_S["tracking_lost"])
    for s, e in segs:
        ts, te = edges(s, e)
        if (e - s) + 1e-6 >= config.MIN_DURATION_S["tracking_lost"] or ts or te:
            text = "face tracking lost (no face found); the masked video is pixelated meanwhile"
            out.append(_flag("tracking_lost", s, e, {"kind": "text", "text": text}, ts, te, text,
                            config.MIN_DURATION_S["tracking_lost"]))
    return out
