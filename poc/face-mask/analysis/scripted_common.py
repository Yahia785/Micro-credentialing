"""Helpers for the scripted-session checks (check_scripted.py, diagnose_tuning.py).

New file only: it imports the existing helpers from common.py and changes nothing there.
The split (tuning / heldout) is ALWAYS read from the sidecar header, never from a file name.
"""
from __future__ import annotations

import json
from pathlib import Path

import common

PLAN_PATH = Path(__file__).resolve().parent.parent / "client" / "src" / "scripted-sessions.json"
OUT_DIR = Path(__file__).resolve().parent / "out"
NO_LABEL_ROW = ("honest-type", "honest-keyboard")      # README: these segments get no row in the labels file


def load_plan() -> dict:
    """The planned schedule (read only): {"version": n, "sessions": {id: {split, kind, segments: [...]}}}."""
    with PLAN_PATH.open(encoding="utf-8") as fh:
        return json.load(fh)


def read_header(path: Path) -> dict:
    """Only the first line of a sidecar (the header), so the split is known before any frame is read."""
    with Path(path).open(encoding="utf-8") as fh:
        rec = json.loads(fh.readline())
    if rec.get("type") != "header":
        raise ValueError(f"{path.name}: first line is not a header")
    return rec


def split_of(header: dict) -> str:
    """'tuning', 'heldout' or '' (no script block). Read from the header only."""
    return str((header.get("script") or {}).get("split") or "")


def load_cues(path: Path) -> list[dict]:
    cues = []
    with Path(path).open(encoding="utf-8") as fh:
        for line in fh:
            if '"type":"cue"' in line.replace(" ", ""):
                rec = json.loads(line)
                if rec.get("type") == "cue":
                    cues.append(rec)
    return cues


def session_id(sidecar_path: Path) -> str:
    """<id> in sidecar-<id>.jsonl (the file-name stem, used only to find the sibling files)."""
    return Path(sidecar_path).stem[len("sidecar-"):]


def sibling_files(sidecar_path: Path) -> dict[str, Path]:
    p = Path(sidecar_path)
    sid = session_id(p)
    return {"masked": p.with_name(f"masked-{sid}.webm"), "raw": p.with_name(f"raw-{sid}.webm"),
            "sidecar": p, "labels": common.labels_path(p)}


def load_tuning_sidecar(path: Path) -> common.Sidecar:
    """Load a sidecar for the detection diagnosis. Refuses anything whose HEADER does not say split == 'tuning'."""
    header = read_header(path)
    if split_of(header) != "tuning":
        raise PermissionError(f"{Path(path).name}: split is {split_of(header) or 'unknown'!r}, not 'tuning'; "
                              "detection results are never computed for it")
    sc = common.load_sidecar(path)
    if split_of(sc.header) != "tuning":   # belt and braces
        raise PermissionError(f"{Path(path).name}: split is not 'tuning'")
    return sc


def overlaps(a0: float, a1: float, b0: float, b1: float, slack: float) -> bool:
    """Same rule as test 3."""
    return a0 <= b1 + slack and b0 <= a1 + slack
