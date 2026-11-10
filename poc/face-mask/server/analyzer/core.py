"""analyze_chunk and merge_flags: the two functions a Lambda would call.

No global state: everything is passed in. The only cache is the loaded model (load_detector), which is meant to
survive between invocations (warm start).
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterator

import cv2
import numpy as np

from . import camera, config
from .model import Detection, load_detector
from .rules import common
from .sidecar_flags import sidecar_flags
from .spans import Span, spans_from_hits

INTERVAL = 1.0 / config.SAMPLE_FPS


@dataclass
class Options:
    """How to analyze. Every field has a default; nothing here is global."""
    use_objects: bool = True
    model_path: str | None = None          # default: server/models/yolo11n.onnx
    detector: Any = None                   # any object with .detect(bgr) -> list[Detection] (used by tests)
    threads: int = 0                       # onnxruntime threads, 0 = default
    conf: float = config.OBJECT_CONF
    min_brightness: float = config.CAMERA_MIN_BRIGHTNESS
    min_sharpness: float = config.CAMERA_MIN_SHARPNESS
    gaze_source: str | None = None         # default: analysis/common.py GAZE_SOURCE
    smoothed: bool | None = None
    thresholds_mode: str | None = None     # default: analysis/common.py THRESHOLDS_MODE ("fixed")
    sidecar_checks: bool = True

    def resolve_detector(self):
        if self.detector is not None:
            return self.detector
        if not self.use_objects:
            return None
        path = str(self.model_path or config.DEFAULT_MODEL_PATH)
        if not Path(path).exists():
            raise FileNotFoundError(
                f"Model not found: {path}\nCreate it once with scripts/export_model.py (see README, 'Server analysis'), "
                "or run without objects (--no-objects)."
            )
        return load_detector(path, self.threads)


# ---- chunk helpers ----------------------------------------------------------------------

def split_chunks(duration_s: float, chunk_s: float = config.CHUNK_S) -> list[tuple[float, float]]:
    """[(start, end), ...] covering 0..duration_s in pieces of chunk_s (the last one may be shorter)."""
    if duration_s <= 0:
        return []
    n = math.ceil(duration_s / chunk_s - 1e-9)
    return [(i * chunk_s, min((i + 1) * chunk_s, duration_s)) for i in range(n)]


def chunk_index(t_s: float, chunk_s: float = config.CHUNK_S) -> int:
    return max(0, int(t_s // chunk_s))


def slice_frames(frames: list[dict], start_s: float, end_s: float) -> list[dict]:
    """Sidecar frames whose t (ms) lies in [start_s, end_s)."""
    return [f for f in frames if start_s * 1000 <= f["t"] < end_s * 1000]


def slice_keys(keys_s: list[float], start_s: float, end_s: float, margin_s: float = 0.0) -> list[float]:
    return [k for k in keys_s if start_s - margin_s <= k < end_s + margin_s]


def iter_samples(video_path: str | Path, sample_fps: float = config.SAMPLE_FPS) -> Iterator[tuple[float, np.ndarray]]:
    """Yield (seconds since the start of this video, BGR frame) about `sample_fps` times per second.

    Uses the decoder's own timestamps (browser-recorded webm files report no frame count and a wrong fps).
    """
    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        raise OSError(f"Cannot open video: {video_path}")
    interval = 1.0 / sample_fps
    next_t = 0.0
    try:
        while True:
            ok, frame = cap.read()
            if not ok:
                break
            t = cap.get(cv2.CAP_PROP_POS_MSEC) / 1000.0
            if t + 1e-6 >= next_t:
                yield t, frame
                next_t = (math.floor(t / interval + 1e-6) + 1) * interval
    finally:
        cap.release()


# ---- video checks -----------------------------------------------------------------------

def _count_flag(ftype: str, span: Span, label: str, conf: float) -> dict:
    return {
        "type": ftype, "start_s": span.start, "end_s": span.end, "confidence": conf, "source": "video",
        "evidence": f"{label} in {span.hits} of {span.frames} sampled frames",
        "touches_start": span.touches_start, "touches_end": span.touches_end,
        "_meta": {"kind": "count", "label": label, "hits": span.hits, "frames": span.frames},
        "_min": config.MIN_DURATION_S[ftype],
    }


def video_flags(video_path: str | Path, chunk_start_s: float, opts: Options,
                lost_times: list[tuple[float, float]] | None = None) -> list[dict]:
    """Object and camera checks on the video of one chunk. Times are returned on the session timeline."""
    detector = opts.resolve_detector()
    times: list[float] = []
    per_type: dict[str, list[bool]] = {t: [] for t in ("phone_visible", "book_visible", "extra_laptop", "second_person")}
    best: dict[str, list[float]] = {t: [] for t in per_type}
    dark: list[bool] = []
    blur: list[bool] = []

    for t_rel, frame in iter_samples(video_path):
        times.append(chunk_start_s + t_rel)
        mean, sharp = camera.frame_stats(frame)
        d, b = camera.classify(mean, sharp, opts.min_brightness, opts.min_sharpness)
        dark.append(d)
        blur.append(b)
        dets: list[Detection] = detector.detect(frame, opts.conf) if detector is not None else []
        persons = [x for x in dets if x.label == "person"]
        found = {
            "phone_visible": [x for x in dets if x.label == "cell phone"],
            "book_visible": [x for x in dets if x.label == "book"],
            "extra_laptop": [x for x in dets if x.label == "laptop"],
            "second_person": persons if len(persons) > 1 else [],
        }
        for k, v in found.items():
            per_type[k].append(bool(v))
            best[k].append(max((x.score for x in v), default=0.0))

    if not times:
        return []
    out: list[dict] = []
    labels = {"phone_visible": "cell phone box", "book_visible": "book box", "extra_laptop": "laptop box",
              "second_person": "more than one person box"}
    for ftype, hits in per_type.items():
        for span in spans_from_hits(times, hits, INTERVAL, config.JOIN_GAP_S[ftype], config.MIN_DURATION_S[ftype]):
            scores = [s for t, h, s in zip(times, hits, best[ftype]) if h and span.start - 1e-6 <= t < span.end - 1e-6]
            out.append(_count_flag(ftype, span, labels[ftype], sum(scores) / len(scores) if scores else 0.0))

    blocked = [a or b for a, b in zip(dark, blur)]
    for span in spans_from_hits(times, blocked, INTERVAL, config.JOIN_GAP_S["camera_blocked"],
                                config.MIN_DURATION_S["camera_blocked"]):
        idx = [i for i, t in enumerate(times) if span.start - 1e-6 <= t < span.end - 1e-6]
        nd, nb = sum(dark[i] for i in idx), sum(blur[i] for i in idx)
        parts = []
        if nd:
            parts.append(f"brightness below {opts.min_brightness:g} in {nd} of {span.frames} sampled frames")
        if nb:
            parts.append(f"sharpness below {opts.min_sharpness:g} in {nb} of {span.frames} sampled frames")
        text = "; ".join(parts)
        out.append({
            "type": "camera_blocked", "start_s": span.start, "end_s": span.end,
            "confidence": span.hits / max(span.frames, 1), "source": "video", "evidence": text,
            "touches_start": span.touches_start, "touches_end": span.touches_end,
            "_meta": {"kind": "camera", "dark": nd, "blur": nb, "frames": span.frames,
                      "min_brightness": opts.min_brightness, "min_sharpness": opts.min_sharpness},
            "_min": config.MIN_DURATION_S["camera_blocked"],
        })
    return out


# ---- the two public functions ----------------------------------------------------------------

def analyze_chunk(video_path: str | Path | None, sidecar_frames: list[dict], chunk_start_s: float, *,
                  keys_s: list[float] | None = None, header: dict | None = None,
                  options: Options | None = None,
                  key_events: list[tuple[float, str]] | None = None) -> list[dict]:
    """Analyze ONE chunk and return its flags (intermediate format; pass the lists to merge_flags).

    video_path      the video of this chunk (time 0 of the file = chunk_start_s of the session). None = sidecar only.
    sidecar_frames  the sidecar `frame` lines of this chunk (t in ms on the session timeline).
    chunk_start_s   where this chunk starts on the session timeline, seconds.
    keys_s          key-press times (seconds, session timeline); include presses up to KEY_MARGIN_S outside the chunk.
    key_events      (time_s, category) of the key presses (category only: char, backspace, delete, enter, space, other).
                    Optional; without it the categories are 'unknown'.
    header          the sidecar header (baseline and calibration edges are read from it).
    """
    opts = options or Options()
    flags: list[dict] = []
    if video_path is not None:
        flags += video_flags(video_path, chunk_start_s, opts)
    if opts.sidecar_checks:
        flags += sidecar_flags(sidecar_frames, list(keys_s or []), header, key_events=key_events, gaze_source=opts.gaze_source,
                               smoothed=opts.smoothed, thresholds_mode=opts.thresholds_mode)
    return flags


def _merge_meta(a: dict, b: dict) -> dict:
    if a["kind"] == "offscreen" and b["kind"] == "offscreen":
        later = b if b["end"] >= a["end"] else a  # typing after the look belongs to the piece that holds its end
        merged = dict(later)
        for key in ("dirs", "mods"):
            tot = dict(a[key])
            for k, n in b[key].items():
                tot[k] = tot.get(k, 0) + n
            merged[key] = tot
        return merged
    if a["kind"] == "count" and b["kind"] == "count":
        return {**a, "hits": a["hits"] + b["hits"], "frames": a["frames"] + b["frames"]}
    if a["kind"] == "camera" and b["kind"] == "camera":
        return {**a, "dark": a["dark"] + b["dark"], "blur": a["blur"] + b["blur"], "frames": a["frames"] + b["frames"]}
    if a["kind"] == "text" and b["kind"] == "text" and a["text"] != b["text"]:
        return {"kind": "text", "text": a["text"] + "; " + b["text"]}
    return a


def _top(votes: dict) -> str:
    return max(votes, key=lambda k: votes[k])


def _evidence(meta: dict, fallback: str, flag: dict | None = None) -> str:
    if meta["kind"] == "offscreen":
        dur = (flag["end_s"] - flag["start_s"]) if flag else 0.0
        return f"looked {_top(meta['dirs'])} for {dur:.1f} s ({' and '.join(sorted(meta['mods']))} outside the screen and keyboard zones)"
    if meta["kind"] == "count":
        return f"{meta['label']} in {meta['hits']} of {meta['frames']} sampled frames"
    if meta["kind"] == "camera":
        parts = []
        if meta["dark"]:
            parts.append(f"brightness below {meta['min_brightness']:g} in {meta['dark']} of {meta['frames']} sampled frames")
        if meta["blur"]:
            parts.append(f"sharpness below {meta['min_sharpness']:g} in {meta['blur']} of {meta['frames']} sampled frames")
        return "; ".join(parts)
    if meta["kind"] == "text":
        return meta["text"]
    return fallback


def merge_flags(chunk_flag_lists: list[list[dict]]) -> list[dict]:
    """Join flags of the same type that touch or overlap across chunks, then apply the minimum duration.

    * Flags are joined when the gap between them is at most JOIN_GAP_S[type] (this also removes the duplicates
      that overlapping sidecar windows produce).
    * Detections that were kept short only because they touched a chunk edge are dropped now if they are still
      shorter than the minimum duration.
    * A looking_away_while_typing flag is stretched to the whole (merged) looking_away event it belongs to.
    * The returned flags are final: internal fields are removed and times are rounded.
    """
    by_type: dict[str, list[dict]] = {}
    for fl in chunk_flag_lists:
        for f in fl:
            by_type.setdefault(f["type"], []).append(dict(f))

    merged: list[dict] = []
    for ftype, flags in by_type.items():
        flags.sort(key=lambda f: f["start_s"])
        gap = config.JOIN_GAP_S.get(ftype, 0.5)
        cur: dict | None = None
        for f in flags:
            if cur is not None and f["start_s"] - cur["end_s"] <= gap + 1e-6:
                dur_a, dur_b = cur["end_s"] - cur["start_s"], f["end_s"] - f["start_s"]
                tot = (dur_a + dur_b) or 1.0
                cur["confidence"] = (cur["confidence"] * dur_a + f["confidence"] * dur_b) / tot
                cur["end_s"] = max(cur["end_s"], f["end_s"])
                cur["_min"] = min(cur["_min"], f["_min"])
                cur["_meta"] = _merge_meta(cur["_meta"], f["_meta"])
            else:
                if cur is not None:
                    merged.append(cur)
                cur = f
        if cur is not None:
            merged.append(cur)

    # drop short leftovers (only possible for flags that were kept because they touched a chunk edge)
    final = [f for f in merged if (f["end_s"] - f["start_s"]) + 1e-6 >= f["_min"]]

    # typing flag spans the whole looking_away event
    aways = [f for f in final if f["type"] == "looking_away"]
    for f in final:
        if f["type"] == "looking_away_while_typing":
            over = [a for a in aways if a["start_s"] < f["end_s"] and a["end_s"] > f["start_s"]]
            if over:
                f["start_s"] = min(a["start_s"] for a in over)
                f["end_s"] = max(a["end_s"] for a in over)
    # typing flags may now be duplicates of each other
    typing = sorted((f for f in final if f["type"] == "looking_away_while_typing"), key=lambda f: f["start_s"])
    dedup: list[dict] = []
    for f in typing:
        if dedup and f["start_s"] <= dedup[-1]["end_s"] + 1e-6:
            dedup[-1]["end_s"] = max(dedup[-1]["end_s"], f["end_s"])
        else:
            dedup.append(f)
    final = [f for f in final if f["type"] != "looking_away_while_typing"] + dedup

    # copy_pattern (the main flag): at least 3 cycles within 60 s of an off-screen look followed by typing within 3 s.
    # It is computed here, on the merged off-screen looks, because its window may span chunks.
    cycles = []
    for f in final:
        m = f["_meta"]
        if f["type"] == "off_screen_look" and m["kind"] == "offscreen" and m["typing_after"]:
            cycles.append({"start": f["start_s"], "end": f["end_s"], "direction": _top(m["dirs"]),
                           "typing_start": m["typing_start"], "features": m["features"]})
    for cp in common.copy_patterns(cycles):
        text = common.copy_pattern_text(cp)
        final.append({"type": "copy_pattern", "start_s": cp["start"], "end_s": cp["end"], "confidence": 1.0, "source": "sidecar",
                      "evidence": text, "_meta": {"kind": "text", "text": text}, "_min": 0.0, "_details": {
                          "cycles": [{"start_s": round(c["start"], 2), "end_s": round(c["end"], 2), "direction": c["direction"],
                                      "typing_start_s": round(c["typing_start"], 2), "typing_features_10s": c["features"]}
                                     for c in cp["cycles"]],
                          "directions": cp["directions"], "typing_features_mean": cp["features"]}})

    out = []
    for f in sorted(final, key=lambda f: (f["start_s"], f["type"])):
        item = {
            "type": f["type"],
            "severity": config.SEVERITY.get(f["type"], "minor"),
            "start_s": round(f["start_s"], 2),
            "end_s": round(f["end_s"], 2),
            "confidence": round(float(f["confidence"]), 3),
            "source": f["source"],
            "evidence": _evidence(f["_meta"], f.get("evidence", ""), f),
        }
        m = f["_meta"]
        if m["kind"] == "offscreen":
            item["details"] = {"direction": _top(m["dirs"]), "typing_after": m["typing_after"], "zones": m["zones"]}
            if m["typing_after"]:
                item["details"]["typing_features_10s"] = m["features"]
        if "_details" in f:
            item["details"] = f["_details"]
        out.append(item)
    return out
