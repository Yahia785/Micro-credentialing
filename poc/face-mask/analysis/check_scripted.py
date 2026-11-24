"""Part A: completeness and correctness check of scripted sessions.

    python check_scripted.py <folder>

One row per session (every sidecar-*.jsonl in the folder, whatever its split). Reads files only; writes
out/check_scripted.csv. Never computes any detection result.
"""
from __future__ import annotations

import csv
import sys
from pathlib import Path

import common
import scripted_common as sc_

CUE_DELAY_FLAG_MS = 200.0
LOST_FLAG_PCT = 5.0
POINTS = ("left", "right", "top", "bottom", "keyboard")
NEEDED = ("blendH", "blendV", "yaw", "pitch")     # default gaze source in common.py is blend
TOL_S = 0.015                                      # label csv is rounded to 0.01 s


def calibration_points(header: dict) -> tuple[list[str], list[str]]:
    """(points present and complete, points missing or incomplete)."""
    edges = ((header.get("calibration") or {}).get("edges")) or {}
    ok, bad = [], []
    for p in POINTS:
        e = edges.get(p)
        (ok if e and all(e.get(k) is not None for k in NEEDED) else bad).append(p)
    return ok, bad


def check_labels(labels: list[dict] | None, cues: list[dict], duration_s: float) -> tuple[int | str, str, list[str]]:
    """(rows, 'yes'/'NO'/'-', problems). Every row must start at a cue with the same label and direction, end at the
    next cue (or at the stop time for the last one), and every look-away cue must have a row."""
    if labels is None:
        return "-", "-", []
    problems = []
    cs = sorted(cues, key=lambda c: c["t"])
    expect = [c for c in cs if c["label"] not in sc_.NO_LABEL_ROW and c["t"] / 1000.0 < duration_s - TOL_S]
    unmatched = 0
    for row in labels:
        hit = None
        for i, c in enumerate(cs):
            if abs(c["t"] / 1000.0 - row["start"]) <= TOL_S and c["label"] == row["label"] \
                    and (c.get("direction") or "") == row["direction"]:
                hit = i
                break
        if hit is None:
            unmatched += 1
            problems.append(f"label row {row['label']}@{row['start']:.2f} has no cue")
            continue
        nxt = cs[hit + 1]["t"] / 1000.0 if hit + 1 < len(cs) else duration_s
        if abs(row["end"] - nxt) > TOL_S and not (hit + 1 >= len(cs) and row["end"] <= duration_s + TOL_S):
            unmatched += 1
            problems.append(f"label row {row['label']}@{row['start']:.2f} ends {row['end']:.2f}, next cue {nxt:.2f}")
    if len(expect) != len(labels):
        problems.append(f"{len(labels)} label rows but {len(expect)} look-away cues")
    return len(labels), ("yes" if not problems else "NO"), problems


def check_session(path: Path, plan: dict) -> dict:
    files = sc_.sibling_files(path)
    exists = {k: p.exists() and p.stat().st_size > 0 for k, p in files.items()}
    flags: list[str] = []
    for k, ok in exists.items():
        if not ok:
            flags.append(f"missing/empty {k}")
    sc = common.load_sidecar(path)
    h = sc.header
    script = h.get("script") or {}
    sid = script.get("id", "")
    cues = sc_.load_cues(path)
    planned = (plan["sessions"].get(sid) or {}).get("segments") or []
    row: dict = {"session": sc_.session_id(path), "script": sid or "-", "split": script.get("split") or "-",
                 "kind": script.get("kind") or "-", "version": script.get("version") or "-"}
    if not script:
        flags.append("no script block")
    elif sid not in plan["sessions"]:
        flags.append(f"script {sid} not in plan")
    else:
        if script.get("split") != plan["sessions"][sid]["split"]:
            flags.append("split differs from plan")
        if str(script.get("version")) != str(plan["version"]):
            flags.append(f"version {script.get('version')} != plan {plan['version']}")
        if f"script-{sid}" != h.get("scenario"):
            flags.append("scenario does not match script id")
    row["files"] = "".join(c if exists[k] else "-" for c, k in (("M", "masked"), ("R", "raw"), ("S", "sidecar"), ("L", "labels")))
    row["length_s"] = round(sc.duration_s, 1)
    complete = sc.summary.get("script_complete")
    row["script_complete"] = "-" if complete is None else str(bool(complete)).lower()
    if not sc.summary:
        flags.append("no summary line (recording cut off?)")
    elif complete is not True:
        flags.append(f"script incomplete (last segment index {sc.summary.get('last_segment_index')})")
    row["cues"] = len(cues)
    row["planned"] = len(planned)
    if planned and len(cues) != len(planned):
        flags.append(f"{len(cues)} cue lines vs {len(planned)} planned segments")
    # cue delay: actual t minus planned_s, per cue
    delays = [c["t"] - float(c["planned_s"]) * 1000.0 for c in cues]
    row["cue_delay_max_ms"] = round(max(delays), 1) if delays else "-"
    row["cue_delay_mean_ms"] = round(sum(delays) / len(delays), 1) if delays else "-"
    if delays and max(abs(d) for d in delays) > CUE_DELAY_FLAG_MS:
        flags.append(f"cue delay above {CUE_DELAY_FLAG_MS:.0f} ms")
    if planned:
        for c, seg in zip(sorted(cues, key=lambda c: c["t"]), planned):
            if c["label"] != seg["label"] or abs(float(c["planned_s"]) - seg["start_s"]) > 1e-6:
                flags.append(f"cue {c['label']}@{c['planned_s']} differs from plan")
                break
    avg, p10 = common.fps_stats(sc.frames)
    row["fps_avg"], row["fps_p10"] = round(avg, 2), round(p10, 2)
    lost = common.lost_percent(sc.frames)
    row["lost_pct"] = round(lost, 2)
    if lost > LOST_FLAG_PCT:
        flags.append(f"tracking lost {lost:.1f}% (> {LOST_FLAG_PCT:g}%)")
    row["keys"] = len(sc.keys)
    if not sc.keys:
        flags.append("no key presses")
    ok_pts, bad_pts = calibration_points(h)
    row["calibration"] = "all 5" if not bad_pts else "missing " + ",".join(bad_pts)
    if not (h.get("calibration") or {}).get("baseline"):
        flags.append("no calibration")
    elif bad_pts:
        flags.append("calibration lacks " + ",".join(bad_pts))
    labels = common.load_labels_ex(path)
    n_rows, match, problems = check_labels(labels, cues, sc.duration_s)
    row["label_rows"] = n_rows
    row["labels_match_cues"] = match
    flags += problems
    row["flags"] = "; ".join(flags) if flags else "OK"
    return row


COLUMNS = ["session", "script", "split", "kind", "version", "files", "length_s", "script_complete", "cues", "planned",
           "cue_delay_max_ms", "cue_delay_mean_ms", "fps_avg", "fps_p10", "lost_pct", "keys", "calibration",
           "label_rows", "labels_match_cues", "flags"]


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print("usage: python check_scripted.py <folder>", file=sys.stderr)
        return 2
    plan = sc_.load_plan()
    rows = [check_session(p, plan) for p in common.find_sidecars(argv[1])]
    widths = {c: max(len(c), *(len(str(r[c])) for r in rows)) for c in COLUMNS if c != "flags"}
    print("files: M = masked webm, R = raw webm, S = sidecar, L = labels csv ('-' = missing)")
    print("  ".join(c.ljust(widths[c]) for c in COLUMNS if c != "flags") + "  flags")
    for r in rows:
        print("  ".join(str(r[c]).ljust(widths[c]) for c in COLUMNS if c != "flags") + "  " + r["flags"])
    sc_.OUT_DIR.mkdir(parents=True, exist_ok=True)
    out = sc_.OUT_DIR / "check_scripted.csv"
    with out.open("w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=COLUMNS)
        w.writeheader()
        w.writerows(rows)
    ids = sorted({r["script"] for r in rows})
    expected = sorted(plan["sessions"])
    missing = [s for s in expected if s not in ids]
    print(f"\n{len(rows)} session(s) found: {', '.join(ids)}. Planned sessions not in this folder: {', '.join(missing) or 'none'}.")
    print(f"Table written to {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
