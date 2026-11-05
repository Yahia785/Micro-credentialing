"""Print the speed-test JSON(s) written by the page's "Run speed test" button as a table.

Usage: python speed_report.py <speedtest-*.json | folder>
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

from common import SPEED_PASS_FPS, fail, speed_label

HEAD = ["delegate", "detect", "avg fps", "p10 fps", "detect ms", "lost", "std yaw raw/sm", "std gazeH raw/sm", "std blendH raw/sm", "speed"]


def _f(v, d=1) -> str:
    return "-" if v is None else f"{v:.{d}f}"


def _pair(std: dict, a: str, b: str, d: int) -> str:
    return f"{_f(std.get(a), d)} / {_f(std.get(b), d)}"


def rows_of(data: dict) -> list[list[str]]:
    rows = []
    for r in data.get("results", []):
        if not r.get("available", True):
            rows.append([r["delegate"], str(r["detect"])] + ["-"] * 7 + [r.get("note") or "n/a"])
            continue
        s = r.get("std", {})
        rows.append([
            r["delegate"], str(r["detect"]), _f(r.get("avgFps")), _f(r.get("p10Fps")), _f(r.get("meanDetectMs")),
            str(r.get("lostFrames", "-")), _pair(s, "yawRaw", "yaw", 2), _pair(s, "gazeHRaw", "gazeH", 3),
            _pair(s, "blendHRaw", "blendH", 3), speed_label(r["avgFps"]) if r.get("avgFps") is not None else "FAIL",
        ])
    return rows


def format_table(data: dict) -> str:
    rows = rows_of(data)
    widths = [max(len(HEAD[i]), *(len(r[i]) for r in rows)) if rows else len(HEAD[i]) for i in range(len(HEAD))]
    line = lambda cells: "  ".join(c.rjust(w) for c, w in zip(cells, widths))  # noqa: E731
    out = [f"{data.get('laptop', '?')}  {data.get('time', '')}  ({data.get('measuredSeconds', '?')} s per setting"
           f"{', CANCELLED' if data.get('cancelled') else ''})", line(HEAD), line(["-" * w for w in widths])]
    out += [line(r) for r in rows]
    best = {}
    for r in data.get("results", []):
        if r.get("available", True) and r.get("avgFps") is not None and r["avgFps"] >= SPEED_PASS_FPS:
            if r["delegate"] not in best or r["detect"] > best[r["delegate"]]["detect"]:
                best[r["delegate"]] = r
    for d in ("GPU", "CPU"):
        out.append(f"Largest tracking size reaching {SPEED_PASS_FPS:g} fps on {d}: "
                   + (f"{best[d]['detect']} px ({_f(best[d]['avgFps'])} fps)" if d in best else "none"))
    return "\n".join(out)


def main() -> int:
    if len(sys.argv) != 2:
        fail("Usage: python speed_report.py <speedtest-*.json or a folder containing them>")
    p = Path(sys.argv[1])
    files = sorted(p.glob("speedtest-*.json")) if p.is_dir() else [p]
    if not files or not all(f.exists() for f in files):
        fail(f"No speedtest-*.json found at {p}. Press 'Run speed test' on the setup screen first (see README).")
    for f in files:
        print(format_table(json.loads(f.read_text(encoding="utf-8"))))
        print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
