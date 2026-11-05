"""YOLO11 nano through onnxruntime (CPU only). Imports onnxruntime, numpy and opencv: never ultralytics or torch."""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

import cv2
import numpy as np

from . import config


@dataclass
class Detection:
    label: str
    score: float
    box: tuple[float, float, float, float]  # x, y, w, h in the ORIGINAL frame's pixels


def letterbox(bgr: np.ndarray, size: int = config.MODEL_INPUT) -> tuple[np.ndarray, float, tuple[float, float]]:
    """Resize keeping the aspect ratio and pad with grey to size x size. Returns (NCHW float32 RGB, ratio, (padx, pady))."""
    h, w = bgr.shape[:2]
    r = min(size / h, size / w)
    nw, nh = round(w * r), round(h * r)
    img = cv2.resize(bgr, (nw, nh), interpolation=cv2.INTER_LINEAR) if (nw, nh) != (w, h) else bgr
    padx, pady = (size - nw) / 2, (size - nh) / 2
    top, bottom = round(pady - 0.1), round(pady + 0.1)
    left, right = round(padx - 0.1), round(padx + 0.1)
    img = cv2.copyMakeBorder(img, top, bottom, left, right, cv2.BORDER_CONSTANT, value=(114, 114, 114))
    blob = img[:, :, ::-1].astype(np.float32).transpose(2, 0, 1)[None] / 255.0
    return np.ascontiguousarray(blob), r, (padx, pady)


def decode(output: np.ndarray, ratio: float, pad: tuple[float, float], frame_shape: tuple[int, int],
           conf: float = config.OBJECT_CONF, iou: float = config.NMS_IOU,
           classes: dict[int, str] = config.CLASSES) -> list[Detection]:
    """YOLO11 output (1, 4 + n_classes, n_anchors): cx, cy, w, h then class scores. Keeps only `classes`."""
    pred = output[0].T  # (n_anchors, 4 + n_classes)
    h, w = frame_shape
    result: list[Detection] = []
    for cid, name in classes.items():
        scores = pred[:, 4 + cid]
        keep = scores >= conf
        if not keep.any():
            continue
        sel = pred[keep]
        sc = scores[keep]
        cx, cy, bw, bh = sel[:, 0], sel[:, 1], sel[:, 2], sel[:, 3]
        x = (cx - bw / 2 - pad[0]) / ratio
        y = (cy - bh / 2 - pad[1]) / ratio
        boxes = np.stack([x, y, bw / ratio, bh / ratio], axis=1)
        idx = cv2.dnn.NMSBoxes(boxes.tolist(), sc.tolist(), conf, iou)
        for i in np.array(idx).flatten():
            bx, by, bww, bhh = boxes[i]
            x0, y0 = max(0.0, bx), max(0.0, by)
            x1, y1 = min(float(w), bx + bww), min(float(h), by + bhh)
            result.append(Detection(name, float(sc[i]), (float(x0), float(y0), float(x1 - x0), float(y1 - y0))))
    return result


class YoloOnnx:
    def __init__(self, path: str | Path, threads: int = 0):
        import onnxruntime as ort  # imported here so tests of the pure logic do not need it

        self.path = Path(path)
        opts = ort.SessionOptions()
        if threads:
            opts.intra_op_num_threads = threads
        self.session = ort.InferenceSession(str(self.path), opts, providers=["CPUExecutionProvider"])
        self.input_name = self.session.get_inputs()[0].name
        shape = self.session.get_inputs()[0].shape
        self.size = int(shape[2]) if isinstance(shape[2], int) else config.MODEL_INPUT
        self._info: dict | None = None

    def detect(self, bgr: np.ndarray, conf: float = config.OBJECT_CONF) -> list[Detection]:
        blob, ratio, pad = letterbox(bgr, self.size)
        out = self.session.run(None, {self.input_name: blob})[0]
        return decode(out, ratio, pad, bgr.shape[:2], conf)

    def info(self) -> dict:
        """Model name, version and checksum for the flags file."""
        if self._info is None:
            card_path = self.path.with_suffix(".json")
            card = json.loads(card_path.read_text(encoding="utf-8")) if card_path.exists() else {}
            meta = self.session.get_modelmeta().custom_metadata_map
            self._info = {
                "name": card.get("name") or self.path.stem,
                "version": card.get("ultralytics_version") or meta.get("version") or "unknown",
                "file": self.path.name,
                "sha256": card.get("sha256") or hashlib.sha256(self.path.read_bytes()).hexdigest(),
                "runtime": "onnxruntime-cpu",
                "license": card.get("license", "AGPL-3.0"),
                "classes_reported": list(config.CLASSES.values()),
            }
        return self._info


@lru_cache(maxsize=4)
def load_detector(path: str, threads: int = 0) -> YoloOnnx:
    """Load once per process and reuse (a Lambda warm start keeps it between invocations)."""
    return YoloOnnx(path, threads)
