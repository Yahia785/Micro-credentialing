"""Export YOLO11 nano to ONNX ONCE. Run this in the EXPORT venv (it needs ultralytics and torch).

    server\\.venv-export\\Scripts\\python.exe scripts\\export_model.py

Writes server/models/yolo11n.onnx and server/models/yolo11n.json (name, versions, sha256, classes).
The analyzer itself never imports ultralytics or torch: it only loads the ONNX file with onnxruntime.

NOTE: YOLO11 and the Ultralytics package are AGPL-3.0 licensed. See the README before shipping this.
"""
from __future__ import annotations

import hashlib
import json
import shutil
import sys
from pathlib import Path

MODELS = Path(__file__).resolve().parent.parent / "models"
NAME = "yolo11n"
IMGSZ = 640


def main() -> int:
    try:
        import ultralytics
        from ultralytics import YOLO
    except ImportError:
        print("ultralytics is not installed here. Use the export venv (see README, 'Server analysis').", file=sys.stderr)
        return 1

    MODELS.mkdir(parents=True, exist_ok=True)
    target = MODELS / f"{NAME}.onnx"
    if target.exists() and "--force" not in sys.argv:
        print(f"Already exported: {target} (use --force to redo)")
        return 0

    weights = MODELS / f"{NAME}.pt"
    print(f"Loading {NAME}.pt (downloads the official weights into {MODELS} if needed)")
    model = YOLO(str(weights))  # ultralytics downloads yolo11n.pt when the file is missing
    if not weights.exists():  # some versions download into the cwd instead
        cwd_copy = Path.cwd() / f"{NAME}.pt"
        if cwd_copy.exists():
            shutil.move(str(cwd_copy), str(weights))
    out = Path(model.export(format="onnx", imgsz=IMGSZ, opset=12, simplify=True, dynamic=False, half=False))
    if out.resolve() != target.resolve():
        shutil.move(str(out), str(target))

    sha = hashlib.sha256(target.read_bytes()).hexdigest()
    card = {
        "name": NAME,
        "file": target.name,
        "sha256": sha,
        "imgsz": IMGSZ,
        "ultralytics_version": ultralytics.__version__,
        "license": "AGPL-3.0",
        "classes_used": {"person": 0, "laptop": 63, "cell phone": 67, "book": 73},
    }
    (MODELS / f"{NAME}.json").write_text(json.dumps(card, indent=2), encoding="utf-8")
    print(f"Wrote {target} ({target.stat().st_size / 1e6:.1f} MB) and {NAME}.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
