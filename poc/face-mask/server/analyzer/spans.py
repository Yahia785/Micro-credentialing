"""Pure logic: turn per-frame hits into spans with a minimum duration and joining of nearby hits."""
from __future__ import annotations

from dataclasses import dataclass

EPS = 1e-6


@dataclass
class Span:
    start: float
    end: float
    hits: int           # sampled frames with a hit inside the span
    frames: int         # sampled frames inside the span
    touches_start: bool  # the span begins at the first sample of the chunk (it may continue from the previous chunk)
    touches_end: bool    # the span reaches the last sample of the chunk (it may continue in the next chunk)

    @property
    def duration(self) -> float:
        return self.end - self.start


def join_intervals(intervals: list[tuple[float, float]], gap: float) -> list[tuple[float, float]]:
    """Join intervals that are closer together than `gap` seconds (sorted by start)."""
    out: list[list[float]] = []
    for s, e in sorted(intervals):
        if out and s - out[-1][1] < gap:
            out[-1][1] = max(out[-1][1], e)
        else:
            out.append([s, e])
    return [(s, e) for s, e in out]


def spans_from_hits(frame_times: list[float], hit_flags: list[bool], interval: float, join_gap: float,
                    min_duration: float) -> list[Span]:
    """Spans from per-sample hits.

    frame_times: time of every sampled frame (ascending); hit_flags: whether each one was a hit.
    Hits whose times are at most `join_gap` apart belong to the same span. A span runs from its first hit to
    its last hit plus one sample interval (a sample stands for the interval after it).
    A span shorter than `min_duration` is dropped, UNLESS it touches the first or last sample of the chunk:
    it may be the piece of a longer detection that continues in the neighbouring chunk. merge_flags makes the
    final decision.
    """
    hit_times = [t for t, h in zip(frame_times, hit_flags) if h]
    if not hit_times:
        return []
    groups: list[list[float]] = [[hit_times[0]]]
    for t in hit_times[1:]:
        if t - groups[-1][-1] <= join_gap + EPS:
            groups[-1].append(t)
        else:
            groups.append([t])
    first, last = frame_times[0], frame_times[-1]
    out = []
    for g in groups:
        start, end = g[0], g[-1] + interval
        inside = [(t, h) for t, h in zip(frame_times, hit_flags) if start - EPS <= t < end - EPS]
        span = Span(start, end, sum(1 for _, h in inside if h), len(inside),
                    touches_start=g[0] <= first + EPS, touches_end=g[-1] >= last - EPS)
        if span.duration + EPS >= min_duration or span.touches_start or span.touches_end:
            out.append(span)
    return out
