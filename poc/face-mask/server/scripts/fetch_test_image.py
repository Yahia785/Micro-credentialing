"""Download ONE public COCO validation image that contains a cell phone, for the real-model positive control tests.

    server\\.venv\\Scripts\\python.exe scripts\\fetch_test_image.py

Saved to server/out/coco/ (git-ignored; the image is never committed). The tests that use it are skipped when it is absent.
"""
from __future__ import annotations

import sys
import urllib.request
from pathlib import Path

URL = "http://images.cocodataset.org/val2017/000000001296.jpg"
DEST = Path(__file__).resolve().parent.parent / "out" / "coco" / "000000001296.jpg"


def main() -> int:
    DEST.parent.mkdir(parents=True, exist_ok=True)
    if DEST.exists() and DEST.stat().st_size > 10_000:
        print(f"Already present: {DEST}")
        return 0
    try:
        urllib.request.urlretrieve(URL, DEST)
    except Exception as e:  # noqa: BLE001
        print(f"Download failed: {e}", file=sys.stderr)
        return 1
    print(f"Saved {DEST} ({DEST.stat().st_size / 1e3:.0f} KB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
