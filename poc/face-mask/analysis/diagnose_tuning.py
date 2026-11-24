"""Part B: what do the current sidecar rules catch and miss on the TUNING sessions?

    python diagnose_tuning.py <folder>

Only sessions whose sidecar HEADER says split == "tuning" are analysed (scripted_common.load_tuning_sidecar refuses
everything else; file names are never used). Held-out sessions are skipped before any frame is read: no rule is run,
nothing is plotted and nothing about them is printed except that they were skipped.

No threshold is changed here: every rule is the one in common.py, with its current constants.
Outputs (numbers only, no video frames) go to out/: one timeline PNG per session and CSV tables.
"""
from __future__ import annotations

import csv
import math
import sys
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402

import common  # noqa: E402
import scripted_common as sc_  # noqa: E402

SLACK = common.MATCH_TOLERANCE_S               # 0.5 s, same as test 3
COPY_KINDS = ("phone-desk", "phone-lap", "screen", "screen-eyes")
OKABE = {"orange": "#E69F00", "sky": "#56B4E9", "green": "#009E73", "blue": "#0072B2", "verm": "#D55E00",
         "purple": "#CC79A7", "grey": "#555555"}


def is_copy(label: str) -> bool:
    return label.startswith("copy-")


def copy_kind(label: str) -> str:
    return label[len("copy-"):]


# ---------------------------------------------------------------------------------------------------------------
def analyse_session(sc: common.Sidecar) -> dict:
    """Run the current rules (common.py, default gaze source, smoothed, current constants) on one tuning session."""
    assert sc_.split_of(sc.header) == "tuning"
    off, zones = common.off_screen_events_of(sc)
    if zones is None:
        raise RuntimeError(f"{sc.name}: no calibration, zones cannot be built")
    cycles = common.find_cycles(off, sc.key_events)
    patterns = common.copy_patterns(cycles)
    hs, vs, v_derived = common.gaze_series(sc.frames)
    off_dir, lost = [], []
    for f, h, v in zip(sc.frames, hs, vs):
        is_lost = bool(f.get("lost"))
        lost.append(is_lost)
        off_dir.append(None if is_lost else common.offscreen_direction(
            h, v, common.reading(f, "yaw"), common.reading(f, "pitch"), zones))
    # off-screen runs with NO minimum duration (to see "too short" looks): same code, min_duration = 0
    short_runs = common.offscreen_events(sc.frames, zones, min_duration=0.0)
    return {"sc": sc, "zones": zones, "events": off, "cycles": cycles, "patterns": patterns, "hs": hs, "vs": vs,
            "off_dir": off_dir, "lost": lost, "runs": short_runs, "labels": common.load_labels_ex(sc.path) or []}


def label_row(res: dict, lab: dict) -> dict:
    sc, z = res["sc"], res["zones"]
    a, b = lab["start"], lab["end"]
    hits = [e for e in res["events"] if sc_.overlaps(e["start"], e["end"], a, b, SLACK)]
    pats = [p for p in res["patterns"] if sc_.overlaps(p["start"], p["end"], a, b, SLACK)]
    idx = [i for i, f in enumerate(sc.frames) if a <= f["t"] / 1000.0 <= b]
    tracked = [i for i in idx if not res["lost"][i]]
    n_off = sum(1 for i in tracked if res["off_dir"][i] is not None)
    share = 100.0 * n_off / len(tracked) if tracked else float("nan")
    keys = sum(1 for k in sc.keys if a <= k <= b)
    row = {"session": sc_.session_id(sc.path), "label": lab["label"], "direction": lab["direction"] or "-",
           "start_s": round(a, 2), "end_s": round(b, 2), "dur_s": round(b - a, 2),
           "n_offscreen_events": len(hits), "event_directions": ",".join(e["direction"] for e in hits) or "-",
           "copy_pattern_covers": "yes" if pats else "no", "keys_typed": keys,
           "offscreen_frames_pct": round(share, 1) if share == share else "nan", "why_missed": ""}
    if is_copy(lab["label"]) and not hits:
        row["why_missed"] = why_missed(res, tracked, idx, a, b, lab, z)
    return row


def why_missed(res: dict, tracked: list[int], idx: list[int], a: float, b: float, lab: dict, z: common.Zones) -> str:
    sc = res["sc"]
    if not idx:
        return f"other: no sidecar frames in {a:.1f}-{b:.1f} s (recording ended at {sc.duration_s:.1f} s)"
    lost_share = 100.0 * (len(idx) - len(tracked)) / len(idx)
    if lost_share > 50:
        return f"other: tracking lost for {lost_share:.0f}% of the attempt"
    off_idx = [i for i in tracked if res["off_dir"][i] is not None]
    if off_idx:
        runs = [r for r in res["runs"] if sc_.overlaps(r["start"], r["end"], a, b, SLACK)]
        longest = max((r["end"] - r["start"] for r in runs), default=0.0)
        if longest < common.OFFSCREEN_MIN_DURATION_S:
            return (f"too short: left both zones, longest off-screen run {longest:.2f} s "
                    f"(minimum {common.OFFSCREEN_MIN_DURATION_S:g} s)")
        return f"other: off-screen run of {longest:.2f} s overlaps but no event was produced"
    # never off-screen: did gaze or head ever leave the SCREEN zone (so it was in the keyboard zone)?
    left_screen = 0
    for i in tracked:
        f = sc.frames[i]
        h, v = res["hs"][i], res["vs"][i]
        yaw, pitch = common.reading(f, "yaw"), common.reading(f, "pitch")
        gaze_out = h is not None and v is not None and not z.gaze.contains(h, v)
        head_out = yaw is not None and pitch is not None and not z.head.contains(yaw, pitch)
        if gaze_out or head_out:
            left_screen += 1
    if left_screen:
        return (f"inside keyboard zone: left the screen zone in {100.0 * left_screen / len(tracked):.0f}% of the tracked "
                "frames but stayed in the keyboard zone")
    return "never left zones: gaze and head inside the screen zone the whole time"


# ---------------------------------------------------------------------------------------------------------------
def false_flags(res: dict) -> tuple[list[dict], float]:
    """Off-screen events that do not overlap a copy label (0.5 s slack) and the honest time in seconds
    (recording length minus the copy-label spans). Honest look-away labels (honest-think ...) count as honest time."""
    sc = res["sc"]
    copies = [l for l in res["labels"] if is_copy(l["label"])]
    flagged = []
    for e in res["events"]:
        if any(sc_.overlaps(e["start"], e["end"], l["start"], l["end"], SLACK) for l in copies):
            continue
        inside = [l["label"] for l in res["labels"] if not is_copy(l["label"]) and sc_.overlaps(e["start"], e["end"], l["start"], l["end"], 0.0)]
        flagged.append({"session": sc_.session_id(sc.path), "start_s": round(e["start"], 2), "end_s": round(e["end"], 2),
                        "dur_s": round(e["end"] - e["start"], 2), "direction": e["direction"],
                        "during": inside[0] if inside else "(unlabelled honest time)"})
    honest_s = sc.duration_s - sum(l["end"] - l["start"] for l in copies)
    return flagged, honest_s


# ---------------------------------------------------------------------------------------------------------------
def plot_session(res: dict, out: Path) -> None:
    sc, z = res["sc"], res["zones"]
    base = common.baseline_of(sc)
    hn, vn = common.gaze_names(common.GAZE_SOURCE)
    bh, bv, by, bp = (base.get(hn) or 0.0, base.get(vn) or 0.0, base.get("yaw") or 0.0, base.get("pitch") or 0.0)
    t = [f["t"] / 1000.0 for f in sc.frames]
    nan = float("nan")

    def rel(vals, b):
        return [nan if v is None else v - b for v in vals]
    yaw = rel([None if f.get("lost") else common.reading(f, "yaw") for f in sc.frames], by)
    pitch = rel([None if f.get("lost") else common.reading(f, "pitch") for f in sc.frames], bp)
    gh, gv = rel(res["hs"], bh), rel(res["vs"], bv)

    fig, axes = plt.subplots(5, 1, figsize=(22, 12), sharex=True, gridspec_kw={"height_ratios": [3, 3, 3, 3, 1.6]})
    series = [
        (axes[0], gh, f"gaze horizontal ({hn} - baseline)", [(z.gaze.lo_a - bh, z.gaze.hi_a - bh, "screen"),
                                                          *( [(z.kb_gaze.lo_a - bh, z.kb_gaze.hi_a - bh, "keyboard")] if z.kb_gaze else [])]),
        (axes[1], gv, f"gaze vertical ({vn} - baseline, + = down)", [(z.gaze.lo_b - bv, z.gaze.hi_b - bv, "screen"),
                                                                  *( [(z.kb_gaze.lo_b - bv, z.kb_gaze.hi_b - bv, "keyboard")] if z.kb_gaze else [])]),
        (axes[2], yaw, "head yaw - baseline (deg)", [(z.head.lo_a - by, z.head.hi_a - by, "screen"),
                                                    *( [(z.kb_head.lo_a - by, z.kb_head.hi_a - by, "keyboard")] if z.kb_head else [])]),
        (axes[3], pitch, "head pitch - baseline (deg, + = down)", [(z.head.lo_b - bp, z.head.hi_b - bp, "screen"),
                                                                  *( [(z.kb_head.lo_b - bp, z.kb_head.hi_b - bp, "keyboard")] if z.kb_head else [])]),
    ]
    for ax, y, title, limits in series:
        ax.plot(t, y, color=OKABE["blue"], lw=0.8)
        ax.set_ylabel(title, fontsize=8)
        for lo, hi, name in limits:
            style = dict(color=OKABE["green"] if name == "screen" else OKABE["purple"], lw=1.1, ls="-" if name == "screen" else "--")
            ax.axhline(lo, **style, label=f"{name} zone limit")
            ax.axhline(hi, **style)
        ax.axhline(0, color=OKABE["grey"], lw=0.5)
        ax.grid(alpha=0.2)
        h_, l_ = ax.get_legend_handles_labels()
        uniq = dict(zip(l_, h_))
        ax.legend(uniq.values(), uniq.keys(), loc="upper right", fontsize=7, ncol=2)
    # label spans on all panels, names on the top one
    for lab in res["labels"]:
        col = OKABE["orange"] if is_copy(lab["label"]) else OKABE["sky"]
        for ax in axes:
            ax.axvspan(lab["start"], lab["end"], color=col, alpha=0.18, lw=0)
        axes[0].text((lab["start"] + lab["end"]) / 2, 1.02, lab["label"] + (f" ({lab['direction']})" if lab["direction"] else ""),
                     transform=axes[0].get_xaxis_transform(), ha="center", va="bottom", fontsize=7, rotation=20, color=col if False else "black")
    # event strip: keys as ticks, off_screen_look events and copy_pattern windows as bars
    ax = axes[4]
    ax.vlines(sc.keys, 0.0, 0.25, color=OKABE["grey"], lw=0.5, label="key press")
    for e in res["events"]:
        ax.broken_barh([(e["start"], e["end"] - e["start"])], (0.35, 0.3), color=OKABE["verm"])
        ax.text(e["start"], 0.67, e["direction"], fontsize=7, va="bottom")
    for p in res["patterns"]:
        ax.broken_barh([(p["start"], p["end"] - p["start"])], (0.8, 0.2), color=OKABE["purple"])
    ax.plot([], [], color=OKABE["verm"], lw=6, label="off_screen_look event")
    ax.plot([], [], color=OKABE["purple"], lw=6, label="copy_pattern window")
    ax.set_yticks([])
    ax.set_ylim(0, 1.1)
    ax.set_xlabel("time since recording start (s)")
    ax.legend(loc="upper right", fontsize=7, ncol=3)
    sid = sc_.session_id(sc.path)
    fig.suptitle(f"{sid}: script {sc.header['script']['id']} (tuning). Orange = copy attempt, blue = honest look-away label. "
                 f"Zones: {z.note}", fontsize=10, y=0.995)
    fig.tight_layout(rect=(0, 0, 1, 0.97))
    fig.savefig(out, dpi=110)
    plt.close(fig)


# ---------------------------------------------------------------------------------------------------------------
def print_table(rows: list[dict], cols: list[str]) -> None:
    w = {c: max(len(c), *(len(str(r[c])) for r in rows)) if rows else len(c) for c in cols}
    print("  ".join(c.ljust(w[c]) for c in cols))
    for r in rows:
        print("  ".join(str(r[c]).ljust(w[c]) for c in cols))


def write_csv(path: Path, rows: list[dict], cols: list[str]) -> None:
    with path.open("w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=cols, extrasaction="ignore")
        w.writeheader()
        w.writerows(rows)


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print("usage: python diagnose_tuning.py <folder>", file=sys.stderr)
        return 2
    sc_.OUT_DIR.mkdir(parents=True, exist_ok=True)
    results, skipped = [], 0
    for p in common.find_sidecars(argv[1]):
        if sc_.split_of(sc_.read_header(p)) != "tuning":      # header only: no frame is read for other splits
            skipped += 1
            continue
        results.append(analyse_session(sc_.load_tuning_sidecar(p)))
    print(f"{len(results)} tuning session(s) analysed; {skipped} other session(s) skipped (split is not 'tuning').")
    if not results:
        return 1

    pngs, label_rows = [], []
    for res in results:
        sid = sc_.session_id(res["sc"].path)
        png = sc_.OUT_DIR / f"timeline_{sid}.png"
        plot_session(res, png)
        pngs.append(png)
        z = res["zones"]
        print(f"\n=== {sid} (script {res['sc'].header['script']['id']}, {res['sc'].duration_s:.1f} s) ===")
        print(f"zones: {z.note}; off_screen_look events: {len(res['events'])}; cycles: {len(res['cycles'])}; copy_pattern windows: {len(res['patterns'])}")
        for e in res["events"]:
            print(f"  off_screen_look {e['start']:.2f}-{e['end']:.2f} s  {e['direction']}  (frames by cause {e['mods']})")
        for pt in res["patterns"]:
            print(f"  copy_pattern {pt['start']:.2f}-{pt['end']:.2f} s  {common.copy_pattern_text(pt)}")
        label_rows += [label_row(res, lab) for lab in res["labels"]]

    cols = ["session", "label", "direction", "start_s", "end_s", "n_offscreen_events", "event_directions",
            "copy_pattern_covers", "keys_typed", "offscreen_frames_pct", "why_missed"]
    print("\n--- Table 2: one row per label (copy attempts and honest look-aways) ---")
    print_table(label_rows, cols)
    write_csv(sc_.OUT_DIR / "diagnose_labels.csv", label_rows, cols)

    print("\n--- Table 3: false off_screen_look events (outside any copy label, 0.5 s slack) in honest time ---")
    ff_rows, tot_ff, tot_min = [], 0, 0.0
    for res in results:
        flagged, honest_s = false_flags(res)
        kind = res["sc"].header["script"]["kind"]
        print(f"{sc_.session_id(res['sc'].path)} ({kind}): honest time {honest_s:.1f} s, false flags {len(flagged)}, "
              f"{len(flagged) / (honest_s / 60):.2f} per minute")
        ff_rows += flagged
        tot_ff += len(flagged)
        tot_min += honest_s / 60
    if ff_rows:
        print_table(ff_rows, ["session", "start_s", "end_s", "dur_s", "direction", "during"])
    else:
        print("(no false flags)")
    print(f"pooled over the analysed tuning sessions: {tot_ff} false flags in {tot_min:.2f} honest minutes = {tot_ff / tot_min:.2f} per minute")
    write_csv(sc_.OUT_DIR / "diagnose_false_flags.csv", ff_rows, ["session", "start_s", "end_s", "dur_s", "direction", "during"])

    print("\n--- Table 4: per copy kind ---")
    kind_rows = []
    for k in COPY_KINDS:
        rows = [r for r in label_rows if r["label"] == f"copy-{k}"]
        caught = [r for r in rows if r["n_offscreen_events"] > 0]
        right_dir = [r for r in caught if r["direction"] in r["event_directions"].split(",")]
        kind_rows.append({"kind": k, "attempts": len(rows), "caught_by_off_screen_look": len(caught),
                          "caught_with_right_direction": len(right_dir),
                          "covered_by_copy_pattern": sum(1 for r in rows if r["copy_pattern_covers"] == "yes")})
    kcols = ["kind", "attempts", "caught_by_off_screen_look", "caught_with_right_direction", "covered_by_copy_pattern"]
    print_table(kind_rows, kcols)
    write_csv(sc_.OUT_DIR / "diagnose_by_kind.csv", kind_rows, kcols)

    print("\nFiles written:")
    for f in [*pngs, *(sc_.OUT_DIR / n for n in ("diagnose_labels.csv", "diagnose_false_flags.csv", "diagnose_by_kind.csv"))]:
        print("  " + str(f))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
