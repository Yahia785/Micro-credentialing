"""Self-calibrated off-screen rule, run identically on three sources, scored on the TUNING sessions only.

    python self_calibrated.py <folder>

Rule (same code for every source, no calibration, no sidecar information for the raw and masked sources):
1. Four signals per source. sidecar and raw reader: blendH, blendV, yaw, pitch. masked reader: pupil_h, pupil_v, nose_h, nose_v.
   Frames where the source found no face are "not away" (they also end a run, like lost frames in common.py).
2. Per session and signal: centre = median over the whole session, spread = 1.4826 x MAD over the whole session,
   z = (value - centre) / spread. The labels are never used for this.
3. A frame is "away" if any |z| > k. A look = run of away frames of at least common.OFFSCREEN_MIN_DURATION_S, gaps shorter
   than common.MERGE_GAP_S joined (common.merge_and_filter). Direction = signal and sign with the largest |z| (reported only).
4. copy_pattern: common.find_cycles / common.copy_patterns with the common.py constants, from these looks and the key log.
5. k = 2.0, 2.5, 3.0, 3.5, 4.0 (nothing is tuned or chosen). Every source is run (a) with the lag from out/compare_lag.csv
   applied to its timestamps and (b) without. The sidecar is never shifted.
6. Reference: the existing calibrated rule on the sidecar (common.off_screen_events_of), one extra row.
Held-out sessions are skipped from the sidecar header (compare_gaze_sources.Session refuses anything but split 'tuning').
"""
from __future__ import annotations

import csv
import sys
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402

import common  # noqa: E402
import compare_gaze_sources as cg  # noqa: E402
import scripted_common as sc_  # noqa: E402

OUT = sc_.OUT_DIR
KS = (2.0, 2.5, 3.0, 3.5, 4.0)
SLACK = common.MATCH_TOLERANCE_S
SOURCES = ("sidecar", "raw reader", "masked reader")
SIGNALS = {"sidecar": ("blendH", "blendV", "yaw", "pitch"), "raw reader": ("blendH", "blendV", "yaw", "pitch"),
           "masked reader": ("pupil_h", "pupil_v", "nose_h", "nose_v")}
COPY_KINDS = ("phone-desk", "phone-lap", "screen", "screen-eyes")
REF_NAME = "sidecar, calibrated rule (reference)"


def is_copy(label: str) -> bool:
    return label.startswith("copy-")


def is_honest_look(label: str) -> bool:
    """Real looks away that are not cheating: honest-think (also honest-think-side) and honest-break."""
    return label.startswith("honest-think") or label == "honest-break"


def read_lags() -> dict[str, dict[str, float]]:
    out: dict[str, dict[str, float]] = {}
    with (OUT / "compare_lag.csv").open(encoding="utf-8") as fh:
        for row in csv.DictReader(fh):
            out.setdefault(row["session"], {})[row["source"]] = float(row["applied_ms"])
    return out


def source_data(s: "cg.Session", source: str) -> tuple[np.ndarray, dict[str, np.ndarray], np.ndarray]:
    """(times, {signal: values (NaN when not found)}, found) of one source, on its own clock."""
    if source == "sidecar":
        return s.t, {n: s.side[n] for n in SIGNALS[source]}, ~s.lost
    d, found = (s.r, s.r_found) if source == "raw reader" else (s.m, s.m_found)
    return d["t"], {n: d[n] for n in SIGNALS[source]}, found


def detect(t: np.ndarray, sigs: dict[str, np.ndarray], found: np.ndarray, k: float) -> list[dict]:
    """Off-screen looks of one source in one session with threshold k (self-calibrated, whole-session centre and spread)."""
    names = list(sigs)
    z = np.full((len(names), len(t)), np.nan)
    for i, n in enumerate(names):
        v = sigs[n]
        ok = np.isfinite(v)
        if ok.sum() < 10:
            continue
        centre = np.median(v[ok])
        spread = 1.4826 * np.median(np.abs(v[ok] - centre))
        if spread > 0:
            z[i] = (v - centre) / spread
    absz = np.where(np.isfinite(z), np.abs(z), -1.0)
    big = absz.max(axis=0)
    away = found & (big > k)
    runs: list[list[float]] = []
    start = last = None
    for j in range(len(t)):
        if away[j]:
            if start is None:
                start = j
            last = j
        elif start is not None:
            runs.append([t[start], t[last], start, last])
            start = last = None
    if start is not None:
        runs.append([t[start], t[last], start, last])
    merged: list[list[float]] = []
    for r in runs:                                    # same merge rule as common.merge_and_filter, keeping frame indices
        if merged and r[0] - merged[-1][1] < common.MERGE_GAP_S:
            merged[-1][1], merged[-1][3] = r[1], r[3]
        else:
            merged.append(list(r))
    kept = {(a, b) for a, b in common.merge_and_filter([[r[0], r[1]] for r in runs], common.OFFSCREEN_MIN_DURATION_S)}
    looks = []
    for a, b, ja, jb in merged:
        if (a, b) not in kept:
            continue
        seg = absz[:, int(ja): int(jb) + 1]
        si, fj = np.unravel_index(np.argmax(seg), seg.shape)
        sign = "+" if z[si, int(ja) + fj] > 0 else "-"
        looks.append({"start": float(a), "end": float(b), "direction": f"{names[si]}{sign}"})
    return looks


def score(sessions: list["cg.Session"], events: dict[str, list[dict]]) -> dict:
    caught = covered = 0
    kinds = {k: [0, 0, 0] for k in COPY_KINDS}        # attempts, caught, covered
    n_false = n_honest_look = 0
    honest_s = 0.0
    n_events = 0
    for s in sessions:
        ev = events[s.id]
        n_events += len(ev)
        cycles = common.find_cycles(ev, s.sc.key_events)
        patterns = common.copy_patterns(cycles)
        copies = [l for l in s.labels if is_copy(l["label"])]
        honest_labels = [l for l in s.labels if is_honest_look(l["label"])]
        for lab in copies:
            hit = any(sc_.overlaps(e["start"], e["end"], lab["start"], lab["end"], SLACK) for e in ev)
            cov = any(sc_.overlaps(p["start"], p["end"], lab["start"], lab["end"], SLACK) for p in patterns)
            caught += hit
            covered += cov
            kd = lab["label"][len("copy-"):]
            kinds[kd][0] += 1
            kinds[kd][1] += hit
            kinds[kd][2] += cov
        for e in ev:
            if any(sc_.overlaps(e["start"], e["end"], l["start"], l["end"], SLACK) for l in copies):
                continue
            n_false += 1
            if any(sc_.overlaps(e["start"], e["end"], l["start"], l["end"], SLACK) for l in honest_labels):
                n_honest_look += 1
        honest_s += s.sc.duration_s - sum(l["end"] - l["start"] for l in copies)
    mins = honest_s / 60.0
    return {"attempts": sum(v[0] for v in kinds.values()), "caught": caught, "covered": covered, "n_false": n_false,
            "false_per_min": n_false / mins, "honest_look_events": n_honest_look,
            "false_excl_honest_per_min": (n_false - n_honest_look) / mins, "n_looks": n_events, "honest_min": mins, "kinds": kinds}


def fmt_table(rows: list[dict], cols: list[str]) -> None:
    w = {c: max(len(c), *(len(str(r[c])) for r in rows)) for c in cols}
    print("  ".join(c.ljust(w[c]) for c in cols))
    for r in rows:
        print("  ".join(str(r[c]).ljust(w[c]) for c in cols))


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print("usage: python self_calibrated.py <folder>", file=sys.stderr)
        return 2
    lags = read_lags()
    sessions, skipped = [], 0
    for p in common.find_sidecars(argv[1]):
        if sc_.split_of(sc_.read_header(p)) != "tuning":
            skipped += 1
            continue
        sessions.append(cg.Session(p, rebuild=False, debug=False))
    print(f"{len(sessions)} tuning session(s): {', '.join(s.scid for s in sessions)}; {skipped} other session(s) skipped (split is not 'tuning').")
    n_attempts = sum(1 for s in sessions for l in s.labels if is_copy(l["label"]))
    print(f"copy attempts in these sessions: {n_attempts}")
    print("\nFrames where the source found no face (% of the source's own frames):")
    rows = []
    for s in sessions:
        rows.append({"session": s.scid, "sidecar_lost_pct": f"{100 * s.lost.mean():.2f}",
                     "raw_not_found_pct": f"{100 * (~s.r_found).mean():.2f}", "masked_not_found_pct": f"{100 * (~s.m_found).mean():.2f}"})
    fmt_table(rows, list(rows[0]))

    results: dict[tuple[str, float, bool], dict] = {}     # (source, k, lag_applied) -> score
    look_rows: list[dict] = []
    for lag_applied in (True, False):
        for source in SOURCES:
            for k in KS:
                events = {}
                for s in sessions:
                    t, sigs, found = source_data(s, source)
                    shift = lags[s.id][("masked" if source == "masked reader" else "raw")] / 1000.0 if (lag_applied and source != "sidecar") else 0.0
                    ev = detect(t + shift, sigs, found, k)
                    events[s.id] = ev
                    for e in ev:
                        look_rows.append({"lag_applied": lag_applied, "source": source, "k": k, "session": s.scid,
                                          "start_s": round(e["start"], 2), "end_s": round(e["end"], 2), "direction": e["direction"]})
                results[(source, k, lag_applied)] = score(sessions, events)
    ref_events = {s.id: common.off_screen_events_of(s.sc)[0] for s in sessions}
    ref = score(sessions, ref_events)
    for s in sessions:
        for e in ref_events[s.id]:
            look_rows.append({"lag_applied": "n/a", "source": REF_NAME, "k": "", "session": s.scid, "start_s": round(e["start"], 2),
                              "end_s": round(e["end"], 2), "direction": e["direction"]})
    print(f"\nhonest time (recording minus copy spans), pooled over the sessions: {ref['honest_min']:.2f} min")

    def main_rows(lag_applied: bool) -> list[dict]:
        rows = []
        for source in SOURCES:
            for k in KS:
                r = results[(source, k, lag_applied)]
                rows.append({"source": source, "k": f"{k:.1f}", "caught": f"{r['caught']}/{r['attempts']}", "copy_pattern_covered": f"{r['covered']}/{r['attempts']}",
                             "looks": r["n_looks"], "false_flags": r["n_false"], "false_per_min": f"{r['false_per_min']:.2f}",
                             "during_honest_think_or_break": r["honest_look_events"], "false_per_min_excl_those": f"{r['false_excl_honest_per_min']:.2f}"})
        rows.append({"source": REF_NAME, "k": "-", "caught": f"{ref['caught']}/{ref['attempts']}", "copy_pattern_covered": f"{ref['covered']}/{ref['attempts']}",
                     "looks": ref["n_looks"], "false_flags": ref["n_false"], "false_per_min": f"{ref['false_per_min']:.2f}",
                     "during_honest_think_or_break": ref["honest_look_events"], "false_per_min_excl_those": f"{ref['false_excl_honest_per_min']:.2f}"})
        return rows

    cols = ["source", "k", "caught", "copy_pattern_covered", "looks", "false_flags", "false_per_min", "during_honest_think_or_break", "false_per_min_excl_those"]
    print("\n=== 1. Main table, LAG-CORRECTED (raw and masked readers shifted by out/compare_lag.csv) ===")
    t1 = main_rows(True)
    fmt_table(t1, cols)
    print("\n=== 2. Same, NO lag correction (sidecar and the reference row are identical to table 1) ===")
    t2 = main_rows(False)
    fmt_table([r for r in t2 if r["source"] not in ("sidecar", REF_NAME)], cols)
    print("\n=== 3. Per copy kind at k = 3.0, lag-corrected: caught / copy_pattern-covered of attempts ===")
    rows = []
    for source in (*SOURCES, REF_NAME):
        r = ref if source == REF_NAME else results[(source, 3.0, True)]
        row = {"source": source}
        for kd in COPY_KINDS:
            a, c, cv = r["kinds"][kd]
            row[kd] = f"{c}/{a} caught, {cv}/{a} pattern"
        rows.append(row)
    fmt_table(rows, ["source", *COPY_KINDS])
    print("\n(same at k = 3.0 without lag correction)")
    rows = []
    for source in SOURCES[1:]:
        r = results[(source, 3.0, False)]
        row = {"source": source}
        for kd in COPY_KINDS:
            a, c, cv = r["kinds"][kd]
            row[kd] = f"{c}/{a} caught, {cv}/{a} pattern"
        rows.append(row)
    fmt_table(rows, ["source", *COPY_KINDS])

    # files
    def dump(path: Path, rows: list[dict]) -> None:
        with path.open("w", newline="", encoding="utf-8") as fh:
            w = csv.DictWriter(fh, fieldnames=list(rows[0]))
            w.writeheader()
            w.writerows(rows)
    dump(OUT / "selfcal_main_lag_corrected.csv", t1)
    dump(OUT / "selfcal_main_no_lag.csv", t2)
    kind_rows = []
    for (source, k, lag_applied), r in results.items():
        for kd in COPY_KINDS:
            kind_rows.append({"source": source, "k": k, "lag_applied": lag_applied, "kind": kd, "attempts": r["kinds"][kd][0],
                              "caught": r["kinds"][kd][1], "copy_pattern_covered": r["kinds"][kd][2]})
    for kd in COPY_KINDS:
        kind_rows.append({"source": REF_NAME, "k": "", "lag_applied": "n/a", "kind": kd, "attempts": ref["kinds"][kd][0],
                          "caught": ref["kinds"][kd][1], "copy_pattern_covered": ref["kinds"][kd][2]})
    dump(OUT / "selfcal_by_kind.csv", kind_rows)
    dump(OUT / "selfcal_looks.csv", look_rows)

    fig, ax = plt.subplots(figsize=(9, 6))
    colours = {"sidecar": "#222222", "raw reader": "#E69F00", "masked reader": "#0072B2"}
    for source in SOURCES:
        for lag_applied, ls, lw, al in ((True, "-", 1.8, 1.0), (False, ":", 1.0, 0.7)):
            xs = [results[(source, k, lag_applied)]["false_per_min"] for k in KS]
            ys = [results[(source, k, lag_applied)]["caught"] for k in KS]
            if source == "sidecar" and not lag_applied:
                continue
            ax.plot(xs, ys, ls, color=colours[source], lw=lw, alpha=al, marker="o" if lag_applied else None, ms=5,
                    label=f"{source}{'' if source == 'sidecar' else (', lag-corrected' if lag_applied else ', no lag correction')}")
            if lag_applied:
                for x, y, k in zip(xs, ys, KS):
                    ax.annotate(f"{k:g}", (x, y), textcoords="offset points", xytext=(4, 4), fontsize=7, color=colours[source])
    ax.plot([ref["false_per_min"]], [ref["caught"]], "D", color="#D55E00", ms=9, label="sidecar, calibrated rule (reference)")
    ax.set_xlabel("false flags per minute of honest time (looks outside every copy label)")
    ax.set_ylabel(f"copy attempts caught (of {n_attempts})")
    ax.set_ylim(-0.5, n_attempts + 0.5)
    ax.grid(alpha=0.25)
    ax.set_title("Self-calibrated rule, tuning sessions: numbers next to the points are k", fontsize=10)
    ax.legend(fontsize=8, loc="lower right")
    fig.tight_layout()
    fig.savefig(OUT / "selfcal_caught_vs_false.png", dpi=120)
    plt.close(fig)
    print("\nFiles written:")
    for n in ("selfcal_main_lag_corrected.csv", "selfcal_main_no_lag.csv", "selfcal_by_kind.csv", "selfcal_looks.csv", "selfcal_caught_vs_false.png"):
        print("  " + str(OUT / n))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
