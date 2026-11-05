"""Run a whole local recording through analyze_chunk / merge_flags (what the CLI and test 5 use).

The recording is decoded once. For every 60-second chunk the sampled frames (2 per second, scaled to a 640 px
long side) are written LOSSLESSLY to a temp file, analyze_chunk runs on that file, then the file is deleted.
In Lambda the same analyze_chunk would be given a real 60-second clip instead.
"""
from __future__ import annotations

import json
import shutil
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

import cv2

from . import config
from .core import Options, analyze_chunk, chunk_index, merge_flags, slice_frames, slice_keys
from .rules import common


def _fourcc_for_lossless() -> int:
    return cv2.VideoWriter_fourcc(*"FFV1")


class _ChunkWriter:
    def __init__(self, path: Path, size: tuple[int, int]):
        self.path = path
        self.w = cv2.VideoWriter(str(path), _fourcc_for_lossless(), config.SAMPLE_FPS, size)
        if not self.w.isOpened():
            raise OSError("OpenCV could not open a lossless (FFV1) video writer for the temp chunk files")
        self.size = size
        self.n = 0

    def write(self, frame) -> None:
        self.w.write(frame)
        self.n += 1

    def close(self) -> None:
        self.w.release()


def _scale(frame, long_side: int):
    h, w = frame.shape[:2]
    r = long_side / max(h, w)
    if r >= 1:
        return frame
    return cv2.resize(frame, (round(w * r), round(h * r)), interpolation=cv2.INTER_AREA)


def iter_video_chunks(video_path: str | Path, offset_s: float, chunk_s: float, tmp_dir: Path):
    """Decode the video once. Yields (chunk_index, chunk_start_s, temp_path) as soon as a chunk is complete.

    offset_s: session time of the video's first frame (the recorder start offset in the sidecar header).
    """
    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        raise OSError(f"Cannot open video: {video_path}")
    interval = 1.0 / config.SAMPLE_FPS
    cur_idx = None
    writer: _ChunkWriter | None = None
    next_t = 0.0
    try:
        while True:
            ok, frame = cap.read()
            if not ok:
                break
            st = cap.get(cv2.CAP_PROP_POS_MSEC) / 1000.0 + offset_s  # session time of this frame
            idx = chunk_index(st, chunk_s)
            if idx != cur_idx:
                if writer is not None and writer.n:
                    writer.close()
                    yield cur_idx, cur_idx * chunk_s, writer.path
                elif writer is not None:
                    writer.close()
                cur_idx, writer = idx, None
                next_t = idx * chunk_s
            if st + 1e-6 < next_t:
                continue
            small = _scale(frame, config.CHUNK_FRAME_LONG_SIDE)
            if writer is None:
                writer = _ChunkWriter(tmp_dir / f"chunk_{idx:04d}.avi", (small.shape[1], small.shape[0]))
            writer.write(small)
            rel = st - idx * chunk_s
            next_t = idx * chunk_s + (int(rel / interval + 1e-6) + 1) * interval
        if writer is not None:
            writer.close()
            if writer.n:
                yield cur_idx, cur_idx * chunk_s, writer.path
    finally:
        cap.release()


def analyze_recording(video_path: str | Path | None, header: dict, frames: list[dict], keys_s: list[float],
                      options: Options | None = None, chunk_s: float = config.CHUNK_S,
                      offset_s: float | None = None, which: str = "masked") -> tuple[list[dict], dict]:
    """Analyze a whole recording chunk by chunk. Returns (final flags, info with timings and chunk count)."""
    opts = options or Options()
    if offset_s is None:
        offset_s = float(((header.get("recorderStartMs") or {}).get(which)) or 0.0) / 1000.0
    tmp = Path(tempfile.mkdtemp(prefix="facemask_chunks_"))
    chunk_flags: list[list[dict]] = []
    done: set[int] = set()
    t_split = t_analyze = 0.0
    video_duration = 0.0
    key_margin = common.KEY_WINDOW_S
    try:
        if video_path is not None:
            gen = iter_video_chunks(video_path, offset_s, chunk_s, tmp)
            while True:
                t0 = time.perf_counter()
                try:
                    idx, start, path = next(gen)
                except StopIteration:
                    t_split += time.perf_counter() - t0
                    break
                t_split += time.perf_counter() - t0
                cap = cv2.VideoCapture(str(path))
                n = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
                cap.release()
                video_duration = max(video_duration, start + max(n, 0) / config.SAMPLE_FPS)
                t1 = time.perf_counter()
                end = start + chunk_s
                chunk_flags.append(analyze_chunk(
                    path, slice_frames(frames, start, end), start,
                    keys_s=slice_keys(keys_s, start, end, key_margin), header=header, options=opts))
                t_analyze += time.perf_counter() - t1
                done.add(idx)
                path.unlink(missing_ok=True)
        # chunks that exist only in the sidecar (video shorter than the sidecar, or no video at all)
        if frames:
            last = chunk_index(frames[-1]["t"] / 1000.0, chunk_s)
            for idx in range(chunk_index(frames[0]["t"] / 1000.0, chunk_s), last + 1):
                if idx in done:
                    continue
                start, end = idx * chunk_s, (idx + 1) * chunk_s
                t1 = time.perf_counter()
                chunk_flags.append(analyze_chunk(
                    None, slice_frames(frames, start, end), start,
                    keys_s=slice_keys(keys_s, start, end, key_margin), header=header, options=opts))
                t_analyze += time.perf_counter() - t1
        t2 = time.perf_counter()
        flags = merge_flags(chunk_flags)
        t_merge = time.perf_counter() - t2
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    info = {"chunks": len(chunk_flags), "video_duration_s": video_duration, "split_s": t_split,
            "analyze_s": t_analyze, "merge_s": t_merge}
    return flags, info


def thresholds_used(opts: Options) -> dict:
    """Every constant that influences the result, for the flags file."""
    return {
        "sample_fps": config.SAMPLE_FPS,
        "chunk_s": config.CHUNK_S,
        "object_confidence": opts.conf,
        "nms_iou": config.NMS_IOU,
        "classes": list(config.CLASSES.values()),
        "min_duration_s": dict(config.MIN_DURATION_S),
        "join_gap_s": dict(config.JOIN_GAP_S),
        "camera_min_brightness": opts.min_brightness,
        "camera_min_sharpness": opts.min_sharpness,
        "camera_analysis_width": config.CAMERA_ANALYSIS_WIDTH,
        "look_away": {
            "source": opts.gaze_source or common.GAZE_SOURCE,
            "smoothed": common.USE_SMOOTHED if opts.smoothed is None else opts.smoothed,
            "eye_thresholds": opts.thresholds_mode or common.THRESHOLDS_MODE,
            "yaw_enter_deg": common.YAW_ENTER_DEG,
            "yaw_exit_deg": common.YAW_EXIT_DEG,
            "head_min_duration_s": common.HEAD_MIN_DURATION_S,
            "gaze_enter": common.GAZE_ENTER,
            "gaze_exit": common.GAZE_EXIT,
            "eye_min_duration_s": common.EYE_MIN_DURATION_S,
            "merge_gap_s": common.MERGE_GAP_S,
            "key_window_s": common.KEY_WINDOW_S,
            "edge_factor": common.EDGE_FACTOR,
            "min_enter": common.MIN_ENTER,
            "exit_ratio": common.EXIT_RATIO,
        },
    }


def flags_document(session_id: str, flags: list[dict], opts: Options, info: dict) -> dict:
    """The content of flags-<id>.json. Only numbers, labels and short texts: no images, no faces."""
    detector = opts.resolve_detector() if (opts.use_objects or opts.detector is not None) else None
    return {
        "session_id": session_id,
        "analyzer_version": config.ANALYZER_VERSION,
        "created": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "model": detector.info() if detector is not None and hasattr(detector, "info") else None,
        "thresholds": thresholds_used(opts),
        "video": {"chunks": info["chunks"], "sample_fps": config.SAMPLE_FPS},
        "flags": flags,
    }


def write_flags(path: str | Path, doc: dict) -> None:
    Path(path).write_text(json.dumps(doc, indent=2), encoding="utf-8")
