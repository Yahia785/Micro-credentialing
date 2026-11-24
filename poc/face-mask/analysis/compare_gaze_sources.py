"""Compare three gaze/head signal sources on the TUNING sessions: sidecar, raw-video reader, masked-video reader.

    python compare_gaze_sources.py <folder> [--rebuild]

Signal comparison only: no look-away or copy rule is run here. Only sessions whose sidecar HEADER says
split == "tuning" are used (held-out ones are skipped before any file besides the header is opened).
Derived files (numbers only) go to out/derived/<id>.masked.jsonl and <id>.raw.jsonl, tables and plots to out/.
The masked reader (server/analyzer/masked_gaze.py) is loaded by file path so the analyzer package (and its model
dependencies) is not imported. No frame of the raw video is written anywhere.
"""
from __future__ import annotations

import csv
import importlib.util
import json
import sys
import time
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402

import common  # noqa: E402
import raw_gaze  # noqa: E402
import scripted_common as sc_  # noqa: E402

OUT = sc_.OUT_DIR
DERIVED = raw_gaze.DERIVED_DIR
DEBUG_MASKED = OUT / "debug_masked"
MASKED_PY = Path(__file__).resolve().parent.parent / "server" / "analyzer" / "masked_gaze.py"
LAG_FIX_THRESHOLD_MS = 100.0
LAG_RANGE_MS = 1500
LAG_STEP_MS = 10
MATCH_TOL_S = 0.05
OKABE = {"side": "#222222", "raw": "#E69F00", "masked": "#0072B2", "grey": "#777777"}


def load_masked_module():
    spec = importlib.util.spec_from_file_location("masked_gaze", MASKED_PY)
    mod = importlib.util.module_from_spec(spec)
    sys.modules["masked_gaze"] = mod        # needed by dataclasses
    spec.loader.exec_module(mod)
    return mod


# ---------------------------------------------------------------------------------------------------------------
# derived files
def build_masked(sidecar: Path, rebuild: bool, debug: bool) -> Path:
    header = sc_.read_header(sidecar)
    if sc_.split_of(header) != "tuning":
        raise PermissionError(f"{sidecar.name}: split is not 'tuning'")
    out = raw_gaze.derived_path(sidecar, "masked")
    if out.exists() and not rebuild:
        return out
    mg = load_masked_module()
    import cv2
    video = sc_.sibling_files(sidecar)["masked"]
    offset = float((header.get("recorderStartMs") or {}).get("masked") or 0.0)
    colors = mg.MaskColors.from_options(header.get("maskOptions"))
    est_frames = None
    if debug:
        sc_frames = common.load_sidecar(sidecar).summary.get("frames") or 3000
        est_frames = int(sc_frames)
    DERIVED.mkdir(parents=True, exist_ok=True)
    t0 = time.time()
    frames = []
    for t, r in mg.analyze_video(video, offset, colors, debug_dir=DEBUG_MASKED if debug else None,
                                 debug_every=max(1, est_frames // 10) if est_frames else 0, debug_max=10):
        frames.append({"type": "frame", "t": round(t, 4), **{k: (round(v, 5) if isinstance(v, float) else v) for k, v in r.as_dict().items()}})
    wall = time.time() - t0
    video_s = frames[-1]["t"] - frames[0]["t"] if len(frames) > 1 else 0.0
    meta = {"type": "meta", "reader": "masked_gaze", "session": sc_.session_id(sidecar), "frames": len(frames), "video_s": round(video_s, 2),
            "wall_s": round(wall, 2), "wall_s_per_video_min": round(wall / (video_s / 60), 1) if video_s else None,
            "recorder_offset_ms": offset, "opencv": cv2.__version__, "note": "read from the masked video only"}
    with out.open("w", encoding="utf-8") as fh:
        for rec in [meta, *frames]:
            fh.write(json.dumps(rec) + "\n")
    return out


def load_derived(path: Path) -> tuple[dict, np.ndarray, dict[str, np.ndarray]]:
    meta, rows = {}, []
    with path.open(encoding="utf-8") as fh:
        for line in fh:
            rec = json.loads(line)
            (meta.update(rec) if rec["type"] == "meta" else rows.append(rec))
    t = np.array([r["t"] for r in rows], dtype=float)
    found = np.array([bool(r["found"]) for r in rows])
    keys = [k for k in rows[0] if k not in ("type", "t", "found", "reason", "lost_banner")]
    cols = {k: np.array([np.nan if r[k] is None else r[k] for r in rows], dtype=float) for k in keys}
    for k in cols:
        cols[k][~found] = np.nan
    return meta, found, {"t": t, **cols}


class Session:
    def __init__(self, sidecar: Path, rebuild: bool, debug: bool):
        self.sc = sc_.load_tuning_sidecar(sidecar)          # refuses anything but split == 'tuning'
        self.id = sc_.session_id(sidecar)
        self.kind = self.sc.header["script"]["kind"]
        self.scid = self.sc.header["script"]["id"]
        fr = self.sc.frames
        self.t = np.array([f["t"] / 1000.0 for f in fr])
        self.lost = np.array([bool(f.get("lost")) for f in fr])

        def col(name):
            return np.array([np.nan if (f.get("lost") or f.get(name) is None) else f[name] for f in fr], dtype=float)
        self.side = {n: col(n) for n in ("gazeH", "gazeV", "blendH", "blendV", "yaw", "pitch",
                                         "gazeHRaw", "gazeVRaw", "blendHRaw", "blendVRaw", "yawRaw", "pitchRaw")}
        self.m_meta, self.m_found, self.m = load_derived(build_masked(sidecar, rebuild, debug))
        self.r_meta, self.r_found, self.r = load_derived(raw_gaze.build_derived(sidecar, rebuild))
        self.labels = common.load_labels_ex(sidecar) or []
        cues = sorted(sc_.load_cues(sidecar), key=lambda c: c["t"])
        end = self.sc.duration_s
        self.honest = [(c["t"] / 1000.0, (cues[i + 1]["t"] / 1000.0 if i + 1 < len(cues) else end))
                       for i, c in enumerate(cues) if c["label"] == "honest-type"]
        self.shift = {"masked": 0.0, "raw": 0.0}
        self.lag = {}


# ---------------------------------------------------------------------------------------------------------------
def pearson(x: np.ndarray, y: np.ndarray) -> float:
    if len(x) < 3 or np.std(x) == 0 or np.std(y) == 0:
        return float("nan")
    return float(np.corrcoef(x, y)[0, 1])


def best_lag(t_ref, y_ref, t_src, y_src) -> tuple[float, float]:
    """Lag (ms) to ADD to the source timestamps so that it best lines up with the reference, and the correlation there."""
    ok = np.isfinite(y_src)
    ts, ys = t_src[ok], y_src[ok]
    rv = np.isfinite(y_ref)
    tr, yr = t_ref[rv], y_ref[rv]
    best = (float("nan"), -2.0)
    for lag in range(-LAG_RANGE_MS, LAG_RANGE_MS + 1, LAG_STEP_MS):
        q = tr - lag / 1000.0
        v = np.interp(q, ts, ys, left=np.nan, right=np.nan)
        i = np.clip(np.searchsorted(ts, q), 1, len(ts) - 1)
        near = np.minimum(np.abs(ts[i - 1] - q), np.abs(ts[i] - q))
        m = np.isfinite(v) & (near < 0.1)
        if m.sum() < 50:
            continue
        c = pearson(v[m], yr[m])
        if c == c and c > best[1]:
            best = (float(lag), c)
    return best


def match_index(t_ref: np.ndarray, t_src: np.ndarray) -> np.ndarray:
    """For each reference time the index of the nearest source frame within MATCH_TOL_S, else -1."""
    i = np.clip(np.searchsorted(t_src, t_ref), 1, len(t_src) - 1)
    left, right = t_src[i - 1], t_src[i]
    j = np.where(np.abs(t_ref - left) <= np.abs(t_ref - right), i - 1, i)
    return np.where(np.abs(t_src[j] - t_ref) <= MATCH_TOL_S, j, -1)


def aligned(s: Session, which: str) -> tuple[np.ndarray, dict[str, np.ndarray]]:
    """Source columns resampled onto the sidecar frame times (after the lag correction, if it was above the threshold)."""
    src = s.m if which == "masked" else s.r
    idx = match_index(s.t, src["t"] + s.shift[which] / 1000.0)
    out = {}
    for k, v in src.items():
        if k == "t":
            continue
        a = np.full(len(idx), np.nan)
        ok = idx >= 0
        a[ok] = v[idx[ok]]
        out[k] = a
    return idx, out


# ---------------------------------------------------------------------------------------------------------------
MASKED_PAIRS = [("pupil_h", "gazeH"), ("pupil_h", "blendH"), ("pupil_v", "gazeV"), ("pupil_v", "blendV"),
                ("nose_h", "yaw"), ("nose_v", "pitch"), ("openness", "blendV")]
RAW_PAIRS = [("gazeH", "gazeHRaw"), ("gazeV", "gazeVRaw"), ("blendH", "blendHRaw"), ("blendV", "blendVRaw"),
             ("yaw", "yawRaw"), ("pitch", "pitchRaw")]


def pair_stats(x: np.ndarray, y: np.ndarray) -> dict:
    ok = np.isfinite(x) & np.isfinite(y)
    x, y = x[ok], y[ok]
    if len(x) < 10 or np.std(x) == 0:
        return {"n": int(len(x)), "r": float("nan"), "slope": float("nan"), "intercept": float("nan"), "median_abs_diff": float("nan")}
    slope, icpt = np.polyfit(x, y, 1)                       # sidecar = slope * source + intercept
    return {"n": int(len(x)), "r": pearson(x, y), "slope": float(slope), "intercept": float(icpt),
            "median_abs_diff": float(np.median(np.abs(y - (slope * x + icpt))))}


FAMILIES = [  # name, sidecar field (smoothed), raw-reader field, masked field
    ("gaze_h_iris", "gazeH", "gazeH", "pupil_h"),
    ("gaze_v_iris", "gazeV", "gazeV", "pupil_v"),
    ("head_turn", "yaw", "yaw", "nose_h"),
    ("head_tilt", "pitch", "pitch", "nose_v"),
    ("blend_h", "blendH", "blendH", None),
    ("blend_v", "blendV", "blendV", None),
]


def window_values(t: np.ndarray, v: np.ndarray, spans) -> np.ndarray:
    m = np.zeros(len(t), bool)
    for a, b in spans:
        m |= (t >= a) & (t <= b)
    x = v[m]
    return x[np.isfinite(x)]


def series_of(s: Session, which: str, fam) -> tuple[np.ndarray, np.ndarray] | None:
    _, side, rawf, mf = fam
    if which == "side":
        return s.t, s.side[side]
    if which == "raw":
        return s.r["t"] + s.shift["raw"] / 1000.0, s.r[rawf]
    return (None if mf is None else (s.m["t"] + s.shift["masked"] / 1000.0, s.m[mf]))


def label_table(s: Session) -> list[dict]:
    rows = []
    for lab in s.labels:
        for fam in FAMILIES:
            row = {"session": s.id, "script": s.scid, "label": lab["label"], "direction": lab["direction"] or "-",
                   "start_s": round(lab["start"], 2), "end_s": round(lab["end"], 2), "family": fam[0]}
            for which in ("side", "raw", "masked"):
                ser = series_of(s, which, fam)
                if ser is None:
                    row[which + "_change"] = row[which + "_d"] = row[which + "_honest_sd"] = float("nan")
                    continue
                t, v = ser
                base = window_values(t, v, s.honest)
                inside = window_values(t, v, [(lab["start"], lab["end"])])
                if len(base) < 10 or len(inside) < 3:
                    row[which + "_change"] = row[which + "_d"] = row[which + "_honest_sd"] = float("nan")
                    continue
                sd = float(np.std(base))
                chg = float(np.mean(inside) - np.mean(base))
                row[which + "_change"], row[which + "_honest_sd"] = chg, sd
                row[which + "_d"] = chg / sd if sd > 0 else float("nan")
            rows.append(row)
    return rows


# ---------------------------------------------------------------------------------------------------------------
def plot_session(s: Session, path: Path) -> None:
    fig, axes = plt.subplots(4, 1, figsize=(22, 11), sharex=True)
    titles = ["horizontal gaze (+ = image right)", "vertical gaze (+ = down)", "head turn (+ = image right)", "head tilt (+ = down)"]
    sty = {"side": ("sidecar iris (smoothed)", OKABE["side"], 1.0, 1.0), "raw": ("raw-video reader (unsmoothed)", OKABE["raw"], 0.7, 0.8),
           "masked": ("masked-video reader", OKABE["masked"], 1.1, 0.9)}
    for ax, fam, title in zip(axes, FAMILIES[:4], titles):
        for which in ("side", "raw", "masked"):
            ser = series_of(s, which, fam)
            if ser is None:
                continue
            t, v = ser
            base = window_values(t, v, s.honest)
            if len(base) < 10 or np.std(base) == 0:
                continue
            z = (v - np.mean(base)) / np.std(base)
            lab, col, lw, al = sty[which]
            ax.plot(t, z, color=col, lw=lw, alpha=al, label=lab)
        ax.axhline(0, color=OKABE["grey"], lw=0.5)
        ax.set_ylabel(title + "\n(units of honest-type SD)", fontsize=8)
        ax.grid(alpha=0.2)
        ax.set_ylim(-8, 8)
    for lab in s.labels:
        col = "#E69F00" if lab["label"].startswith("copy-") else "#56B4E9"
        for ax in axes:
            ax.axvspan(lab["start"], lab["end"], color=col, alpha=0.15, lw=0)
        axes[0].text((lab["start"] + lab["end"]) / 2, 1.02, lab["label"], transform=axes[0].get_xaxis_transform(),
                     ha="center", va="bottom", fontsize=7, rotation=20)
    axes[0].legend(loc="upper right", fontsize=8, ncol=3)
    axes[-1].set_xlabel("time since recording start (s)")
    fig.suptitle(f"{s.id} ({s.scid}, {s.kind}): three sources, each shown as (value - its honest-type mean) / its honest-type SD; "
                 f"lag fixes applied: masked {s.shift['masked']:.0f} ms, raw {s.shift['raw']:.0f} ms", fontsize=10, y=0.995)
    fig.tight_layout(rect=(0, 0, 1, 0.97))
    fig.savefig(path, dpi=105)
    plt.close(fig)


# ---------------------------------------------------------------------------------------------------------------
def fmt(v, nd=3) -> str:
    return "nan" if v is None or v != v else f"{v:.{nd}f}"


def print_table(rows: list[dict], cols: list[str]) -> None:
    w = {c: max(len(c), *(len(str(r[c])) for r in rows)) if rows else len(c) for c in cols}
    print("  ".join(c.ljust(w[c]) for c in cols))
    for r in rows:
        print("  ".join(str(r[c]).ljust(w[c]) for c in cols))


def write_csv(path: Path, rows: list[dict]) -> None:
    if not rows:
        return
    with path.open("w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=list(rows[0]))
        w.writeheader()
        w.writerows(rows)


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print("usage: python compare_gaze_sources.py <folder> [--rebuild]", file=sys.stderr)
        return 2
    rebuild = "--rebuild" in argv
    OUT.mkdir(parents=True, exist_ok=True)
    sessions, skipped, first = [], 0, True
    for p in common.find_sidecars(argv[1]):
        if sc_.split_of(sc_.read_header(p)) != "tuning":     # header only
            skipped += 1
            continue
        t0 = time.time()
        sessions.append(Session(p, rebuild, debug=first))
        first = False
        print(f"loaded {sc_.session_id(p)} ({time.time() - t0:.0f} s)", flush=True)
    print(f"\n{len(sessions)} tuning session(s); {skipped} other session(s) skipped (split is not 'tuning').")
    if not sessions:
        return 1

    # timing -------------------------------------------------------------------------------------------------
    print("\n--- Time per minute of video (wall clock, one process, this laptop) ---")
    rows = []
    for s in sessions:
        rows.append({"session": s.id, "video_s": s.m_meta["video_s"], "masked_s_per_min": s.m_meta["wall_s_per_video_min"],
                     "raw_s_per_min": s.r_meta["wall_s_per_video_min"], "frames_masked": s.m_meta["frames"], "frames_raw": s.r_meta["frames"],
                     "sidecar_frames": len(s.t)})
    print_table(rows, list(rows[0]))
    r0 = sessions[0].r_meta
    print(f"raw reader: Python mediapipe {r0['python_mediapipe']} vs client {r0['client_mediapipe']} (@mediapipe/tasks-vision), "
          f"{r0['delegate']} delegate, tracking on {r0['detect_long_side']} px long side. Masked reader: opencv {sessions[0].m_meta['opencv']}.")

    # 3a lag -------------------------------------------------------------------------------------------------
    print("\n--- 3a. Time alignment: lag (ms) to ADD to the source timestamps (positive = source is early); "
          f"corrected only if |lag| > {LAG_FIX_THRESHOLD_MS:.0f} ms ---")
    rows = []
    for s in sessions:
        for which, src, ref_name, src_name in (("masked", s.m, "gazeH", "pupil_h"), ("raw", s.r, "gazeHRaw", "gazeH")):
            lag, c = best_lag(s.t, s.side[ref_name], src["t"], src[src_name])
            s.lag[which] = (lag, c)
            fixed = abs(lag) > LAG_FIX_THRESHOLD_MS
            s.shift[which] = lag if fixed else 0.0
            rows.append({"session": s.id, "source": which, "signal_pair": f"{src_name} vs sidecar {ref_name}", "best_lag_ms": f"{lag:.0f}",
                         "r_at_best_lag": fmt(c), "applied_ms": f"{s.shift[which]:.0f}"})
    print_table(rows, list(rows[0]))
    write_csv(OUT / "compare_lag.csv", rows)

    # 3b coverage --------------------------------------------------------------------------------------------
    print("\n--- 3b. Coverage: % of sidecar frames with a matching frame (within 50 ms, after lag correction) where found is true ---")
    rows = []
    for s in sessions:
        row = {"session": s.id, "sidecar_frames": len(s.t), "sidecar_lost_pct": f"{100 * s.lost.mean():.2f}"}
        for which, found in (("masked", s.m_found), ("raw", s.r_found)):
            src = s.m if which == "masked" else s.r
            idx = match_index(s.t, src["t"] + s.shift[which] / 1000.0)
            ok = idx >= 0
            hit = np.zeros(len(idx), bool)
            hit[ok] = found[idx[ok]]
            row[f"{which}_all_pct"] = f"{100 * hit.mean():.2f}"
            row[f"{which}_when_sidecar_tracked_pct"] = f"{100 * hit[~s.lost].mean():.2f}"
            row[f"{which}_no_frame_pct"] = f"{100 * (~ok).mean():.2f}"
        rows.append(row)
    print_table(rows, list(rows[0]))
    write_csv(OUT / "compare_coverage.csv", rows)

    # 3c pairs ------------------------------------------------------------------------------------------------
    print("\n--- 3c. Pairs: Pearson r and the linear fit sidecar = slope * source + intercept (frames where both are valid); "
          "median_abs_diff = median |sidecar - fit|, in sidecar units ---")
    rows = []
    for s in sessions:
        _, m = aligned(s, "masked")
        _, r = aligned(s, "raw")
        for src_name, side_name in MASKED_PAIRS:
            rows.append({"session": s.id, "source": "masked", "source_signal": src_name, "sidecar_signal": side_name,
                         **pair_stats(m[src_name], s.side[side_name])})
        for src_name, side_name in RAW_PAIRS:
            rows.append({"session": s.id, "source": "raw", "source_signal": src_name, "sidecar_signal": side_name,
                         **pair_stats(r[src_name], s.side[side_name])})
    show = [{**{k: v for k, v in r.items() if k in ("session", "source", "source_signal", "sidecar_signal", "n")},
             "r": fmt(r["r"]), "slope": fmt(r["slope"]), "intercept": fmt(r["intercept"]), "median_abs_diff": fmt(r["median_abs_diff"])} for r in rows]
    print_table(show, list(show[0]))
    write_csv(OUT / "compare_pairs.csv", rows)

    # 3d labels -----------------------------------------------------------------------------------------------
    print("\n--- 3d. Per label: mean change from this session's honest-type segments, [d = change / honest-type SD of that source] ---")
    all_rows = []
    for s in sessions:
        all_rows += label_table(s)
    write_csv(OUT / "compare_labels.csv", all_rows)
    for fam in FAMILIES:
        print(f"\n[{fam[0]}]  sidecar {fam[1]} | raw reader {fam[2]} | masked reader {fam[3] or '-'}")
        show = []
        for r in all_rows:
            if r["family"] != fam[0]:
                continue
            cell = lambda w: ("-" if r[w + "_change"] != r[w + "_change"] else f"{r[w + '_change']:+.3f} [d {r[w + '_d']:+.1f}]")  # noqa: E731
            show.append({"session": r["script"], "label": r["label"], "dir": r["direction"], "start_s": r["start_s"],
                         "sidecar": cell("side"), "raw": cell("raw"), "masked": cell("masked")})
        print_table(show, list(show[0]))

    # 3e plots --------------------------------------------------------------------------------------------------
    pngs = []
    for s in sessions:
        png = OUT / f"compare_{s.id}.png"
        plot_session(s, png)
        pngs.append(png)
    print("\nFiles written:")
    for f in [*(sorted(DERIVED.glob("*.jsonl"))), *pngs, *(OUT / n for n in ("compare_lag.csv", "compare_coverage.csv", "compare_pairs.csv", "compare_labels.csv"))]:
        print("  " + str(f))
    if DEBUG_MASKED.exists():
        print("  debug (masked frames only):", len(list(DEBUG_MASKED.glob("*.png"))), "files in", DEBUG_MASKED)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
