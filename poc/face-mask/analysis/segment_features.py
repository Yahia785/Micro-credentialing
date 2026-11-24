"""M2 first look: do typing features, gaze features, or both separate copying from honest typing? (segment level)

    python segment_features.py <folder>

TUNING sessions only (split read from the sidecar header; compare_gaze_sources.Session refuses anything else, and
held-out sidecars are never opened beyond their header line). No rule, no threshold choice, no training: features per
segment, then an AUC between groups. Numbers only.

Segments: copy = each copy label as labelled; honest typing = honest-type time (contiguous honest-type segments joined)
cut into non-overlapping 15 s windows from the start of each span, pieces shorter than 10 s dropped; keyboard =
honest-keyboard segments (from the cue lines); thinking = honest-think, honest-think-side, honest-break (labels file).
Gaze features use the self-calibrated z of self_calibrated.py at k = 3.0 (whole-session median and 1.4826 x MAD, any of
the four |z| above k = away), lag-corrected for the masked reader. The away arithmetic is repeated here because
self_calibrated.detect() only returns looks of 1.5 s or more; a check below confirms it gives the same looks.
Glances = runs of consecutive away frames (not-found frames end a run, no gap merging) of at least 0.2 s, inside the segment.
"""
from __future__ import annotations

import csv
import sys

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402

import common  # noqa: E402
import compare_gaze_sources as cg  # noqa: E402
import scripted_common as sc_  # noqa: E402
import self_calibrated as sc  # noqa: E402

OUT = sc_.OUT_DIR
K = 3.0
GLANCE_MIN_S = 0.2
FOLLOW_KEY_S = 1.0
WINDOW_S = 15.0
MIN_WINDOW_S = 10.0
GAZE_SOURCES = ("sidecar", "masked reader")
GROUPS = ("copy", "honest typing", "keyboard", "thinking")
COLOURS = {"copy": "#D55E00", "honest typing": "#555555", "keyboard": "#009E73", "thinking": "#CC79A7"}


def is_think(label: str) -> bool:
    return sc.is_honest_look(label)


# ---------------------------------------------------------------------------------------------------------------
def build_segments(s: "cg.Session") -> list[dict]:
    segs = []
    dur = s.sc.duration_s
    for lab in s.labels:
        if sc.is_copy(lab["label"]):
            segs.append({"session": s.scid, "group": "copy", "label": lab["label"], "a": lab["start"], "b": lab["end"]})
        elif is_think(lab["label"]):
            segs.append({"session": s.scid, "group": "thinking", "label": lab["label"], "a": lab["start"], "b": lab["end"]})
    cues = sorted(sc_.load_cues(s.sc.path), key=lambda c: c["t"])
    spans = [[c["t"] / 1000.0, (cues[i + 1]["t"] / 1000.0 if i + 1 < len(cues) else dur), c["label"]] for i, c in enumerate(cues)]
    honest_spans: list[list[float]] = []
    for a, b, label in spans:
        if label == "honest-keyboard":
            segs.append({"session": s.scid, "group": "keyboard", "label": label, "a": a, "b": b})
        elif label == "honest-type":
            if honest_spans and abs(honest_spans[-1][1] - a) < 1e-6:
                honest_spans[-1][1] = b
            else:
                honest_spans.append([a, b])
    for a, b in honest_spans:
        t0 = a
        while t0 < b - 1e-9:
            t1 = min(t0 + WINDOW_S, b)
            if t1 - t0 >= MIN_WINDOW_S:
                segs.append({"session": s.scid, "group": "honest typing", "label": "honest-type", "a": t0, "b": t1})
            t0 += WINDOW_S
    return segs


# ---------------------------------------------------------------------------------------------------------------
def away_arrays(s: "cg.Session", source: str, lags: dict) -> tuple[np.ndarray, np.ndarray]:
    """(times on the session clock, away flag per frame) with the self-calibrated rule at k = 3.0."""
    t, sigs, found = sc.source_data(s, source)
    shift = lags[s.id]["masked"] / 1000.0 if source == "masked reader" else 0.0
    t = t + shift
    z = []
    for v in sigs.values():
        ok = np.isfinite(v)
        if ok.sum() < 10:
            continue
        centre = np.median(v[ok])
        spread = 1.4826 * np.median(np.abs(v[ok] - centre))
        if spread > 0:
            z.append(np.where(ok, np.abs((v - centre) / spread), -1.0))
    big = np.max(z, axis=0)
    return t, found & (big > K)


def runs_of(t: np.ndarray, away: np.ndarray) -> list[tuple[float, float]]:
    out, start, last = [], None, None
    for j in range(len(t)):
        if away[j]:
            if start is None:
                start = j
            last = j
        elif start is not None:
            out.append((t[start], t[last]))
            start = None
    if start is not None:
        out.append((t[start], t[last]))
    return out


def check_same_as_self_calibrated(s: "cg.Session", source: str, t, away, lags) -> None:
    """The looks (>= 1.5 s, gaps < merge gap joined) from my away mask must equal self_calibrated.detect()."""
    mine = common.merge_and_filter([list(r) for r in runs_of(t, away)], common.OFFSCREEN_MIN_DURATION_S)
    tt, sigs, found = sc.source_data(s, source)
    shift = lags[s.id]["masked"] / 1000.0 if source == "masked reader" else 0.0
    theirs = [(e["start"], e["end"]) for e in sc.detect(tt + shift, sigs, found, K)]
    assert len(mine) == len(theirs) and all(abs(a[0] - b[0]) < 1e-9 and abs(a[1] - b[1]) < 1e-9 for a, b in zip(mine, theirs)), \
        f"away mask differs from self_calibrated.detect for {s.scid} / {source}"


# ---------------------------------------------------------------------------------------------------------------
def key_features(s: "cg.Session", a: float, b: float) -> dict:
    dur = b - a
    kt = np.array([t for t in s.sc.keys if a <= t < b])
    f = {"keys_per_s": len(kt) / dur}
    gaps = np.diff(kt)
    f["median_interkey_s"] = float(np.median(gaps)) if len(gaps) >= 1 else float("nan")
    f["interkey_cv"] = float(np.std(gaps) / np.mean(gaps)) if len(gaps) >= 2 and np.mean(gaps) > 0 else float("nan")
    tf = common.typing_features(s.sc.key_events, a, dur)               # pauses and backspace share as defined in common.py
    f["pauses_per_10s"] = tf["pauses"] / (dur / 10.0)
    edges = np.concatenate([[a], kt, [b]])
    f["longest_pause_s"] = float(np.max(np.diff(edges)))
    f["backspace_share"] = float("nan") if tf["backspace_ratio"] is None else tf["backspace_ratio"]
    return f


def gaze_features(s: "cg.Session", a: float, b: float, t: np.ndarray, away: np.ndarray) -> dict:
    dur = b - a
    idx = np.nonzero((t >= a) & (t < b))[0]
    f = {"away_share": float(away[idx].mean()) if len(idx) else float("nan")}
    glances = [(x, y) for x, y in runs_of(t[idx], away[idx]) if y - x >= GLANCE_MIN_S]
    f["glances_per_10s"] = len(glances) / (dur / 10.0)
    f["median_glance_s"] = float(np.median([y - x for x, y in glances])) if glances else float("nan")
    keys = np.array(s.sc.keys)
    followed = sum(1 for _, y in glances if np.any((keys > y) & (keys <= y + FOLLOW_KEY_S)))
    f["glances_followed_by_key_share"] = followed / len(glances) if glances else float("nan")
    f["keys_while_away_per_10s"] = sum(int(np.sum((keys >= x) & (keys <= y))) for x, y in glances) / (dur / 10.0)
    return f


# ---------------------------------------------------------------------------------------------------------------
def auc(x: np.ndarray, y: np.ndarray) -> float:
    """P(random x > random y), ties count half. NaN if either group is empty."""
    if len(x) == 0 or len(y) == 0:
        return float("nan")
    gt = (x[:, None] > y[None, :]).mean()
    eq = (x[:, None] == y[None, :]).mean()
    return float(gt + 0.5 * eq)


def flipped(a: float) -> tuple[float, str]:
    if a != a:
        return float("nan"), "-"
    return (a, "copy higher") if a >= 0.5 else (1 - a, "copy lower")


def finite(v) -> np.ndarray:
    v = np.asarray(v, dtype=float)
    return v[np.isfinite(v)]


def fmt(v, nd=2) -> str:
    return "nan" if v is None or v != v else f"{v:.{nd}f}"


FEATURES = [  # key, label, group, source ('keys' or gaze source)
    ("keys_per_s", "keys per second", "keys"), ("median_interkey_s", "median time between keys (s)", "keys"),
    ("interkey_cv", "variation of time between keys (sd/mean)", "keys"), ("pauses_per_10s", "pauses over 1 s per 10 s", "keys"),
    ("longest_pause_s", "longest pause (s)", "keys"), ("backspace_share", "backspace share of keys", "keys"),
    ("away_share", "share of frames away", "gaze"), ("glances_per_10s", "glances (>= 0.2 s) per 10 s", "gaze"),
    ("median_glance_s", "median glance length (s)", "gaze"),
    ("glances_followed_by_key_share", "share of glances followed by a key within 1 s", "both"),
    ("keys_while_away_per_10s", "keys typed while away per 10 s", "both"),
]


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print("usage: python segment_features.py <folder>", file=sys.stderr)
        return 2
    lags = sc.read_lags()
    sessions, skipped = [], 0
    for p in common.find_sidecars(argv[1]):
        if sc_.split_of(sc_.read_header(p)) != "tuning":
            skipped += 1
            continue
        sessions.append(cg.Session(p, rebuild=False, debug=False))
    print(f"{len(sessions)} tuning session(s): {', '.join(s.scid for s in sessions)}; {skipped} other session(s) skipped (split is not 'tuning').")

    rows = []      # one row per segment and feature-set
    for s in sessions:
        gz = {src: away_arrays(s, src, lags) for src in GAZE_SOURCES}
        for src, (t, away) in gz.items():
            check_same_as_self_calibrated(s, src, t, away, lags)
        for seg in build_segments(s):
            row = {**seg, "dur_s": seg["b"] - seg["a"], **{f"keys|{k}": v for k, v in key_features(s, seg["a"], seg["b"]).items()}}
            for src, (t, away) in gz.items():
                for k, v in gaze_features(s, seg["a"], seg["b"], t, away).items():
                    row[f"{src}|{k}"] = v
            rows.append(row)
    print("check passed: the away mask reproduces the looks of self_calibrated.detect() at k = 3.0 for every session and source.")

    # segment counts
    print("\nSegments per group (per session, total, mean duration):")
    cnt = []
    for g in GROUPS:
        per = {s.scid: sum(1 for r in rows if r["group"] == g and r["session"] == s.scid) for s in sessions}
        dd = [r["dur_s"] for r in rows if r["group"] == g]
        cnt.append({"group": g, **per, "total": len(dd), "mean_dur_s": fmt(np.mean(dd), 1)})
    kinds = {}
    for r in rows:
        if r["group"] == "copy":
            kinds[r["label"]] = kinds.get(r["label"], 0) + 1
    cg.print_table(cnt, list(cnt[0]))
    print("copy by kind:", ", ".join(f"{k} {v}" for k, v in sorted(kinds.items())))

    def values(group_filter, key):
        return finite([r.get(key) for r in rows if group_filter(r)])

    is_copy = lambda r: r["group"] == "copy"  # noqa: E731
    is_phone = lambda r: r["group"] == "copy" and r["label"] in ("copy-phone-desk", "copy-phone-lap")  # noqa: E731
    is_screen = lambda r: r["group"] == "copy" and r["label"] in ("copy-screen", "copy-screen-eyes")  # noqa: E731
    grp = lambda g: (lambda r: r["group"] == g)  # noqa: E731
    table = []
    for key, label, kind in FEATURES:
        for src in (("keys",) if kind == "keys" else GAZE_SOURCES):
            col = f"{src}|{key}"
            c, h, kb, th = (values(f, col) for f in (is_copy, grp("honest typing"), grp("keyboard"), grp("thinking")))
            a, direction = flipped(auc(c, h))
            ap, dp = flipped(auc(values(is_phone, col), kb))
            asr, ds = flipped(auc(values(is_screen, col), h))
            table.append({"feature": label, "group": kind, "source": src, "col": col,
                          "auc_copy_vs_honest_typing": a, "direction": direction, "median_copy": float(np.median(c)) if len(c) else float("nan"),
                          "median_honest_typing": float(np.median(h)) if len(h) else float("nan"),
                          "median_keyboard": float(np.median(kb)) if len(kb) else float("nan"),
                          "median_thinking": float(np.median(th)) if len(th) else float("nan"),
                          "auc_phone_vs_keyboard": ap, "dir_phone_vs_keyboard": dp, "auc_screen_vs_honest_typing": asr, "dir_screen_vs_honest_typing": ds,
                          "n_copy": len(c), "n_honest": len(h), "n_keyboard": len(kb), "n_phone": len(values(is_phone, col)),
                          "n_screen": len(values(is_screen, col))})
    show = [{"feature": r["feature"], "group": r["group"], "source": r["source"], "AUC": fmt(r["auc_copy_vs_honest_typing"]), "copy goes": r["direction"],
             "median copy": fmt(r["median_copy"], 3), "median honest": fmt(r["median_honest_typing"], 3),
             "n copy/honest": f"{r['n_copy']}/{r['n_honest']}"} for r in table]
    print("\n=== 1. AUC copy vs honest typing (flipped: 0.5 = no separation, 1.0 = perfect) ===")
    cg.print_table(show, list(show[0]))
    show2 = [{"feature": r["feature"], "source": r["source"], "median keyboard": fmt(r["median_keyboard"], 3), "median thinking": fmt(r["median_thinking"], 3),
              "AUC phone vs keyboard": f"{fmt(r['auc_phone_vs_keyboard'])} ({r['dir_phone_vs_keyboard']})", "n phone/keyboard": f"{r['n_phone']}/{r['n_keyboard']}",
              "AUC screen vs honest typing": f"{fmt(r['auc_screen_vs_honest_typing'])} ({r['dir_screen_vs_honest_typing']})", "n screen/honest": f"{r['n_screen']}/{r['n_honest']}"}
             for r in table]
    print("\n=== 2. Extra comparisons (and the other two groups' medians) ===")
    cg.print_table(show2, list(show2[0]))

    for name, data, cols in (("segment_features_auc.csv", table, list(table[0])),
                             ("segment_features_values.csv", rows, sorted({k for r in rows for k in r}, key=lambda k: (k.count("|"), k)))):
        with (OUT / name).open("w", newline="", encoding="utf-8") as fh:
            w = csv.DictWriter(fh, fieldnames=cols, extrasaction="ignore")
            w.writeheader()
            w.writerows(data)

    # PNG: dots per group, one panel per feature (and source)
    panels = [r for r in table]
    ncol = 4
    nrow = -(-len(panels) // ncol)
    fig, axes = plt.subplots(nrow, ncol, figsize=(4.4 * ncol, 3.6 * nrow))
    rng = np.random.default_rng(0)
    for ax, r in zip(axes.flat, panels):
        for i, g in enumerate(GROUPS):
            v = values(grp(g), r["col"])
            ax.scatter(i + rng.uniform(-0.18, 0.18, len(v)), v, s=9, color=COLOURS[g], alpha=0.75, lw=0)
            if len(v):
                ax.hlines(np.median(v), i - 0.3, i + 0.3, color="black", lw=1.4)
        ax.set_xticks(range(len(GROUPS)))
        ax.set_xticklabels(["copy", "honest\ntyping", "keyboard", "thinking"], fontsize=7)
        src = "" if r["source"] == "keys" else f" [{r['source']}]"
        ax.set_title(f"{r['feature']}{src}\nAUC {fmt(r['auc_copy_vs_honest_typing'])} ({r['direction']})", fontsize=7.5)
        ax.grid(alpha=0.2)
        ax.tick_params(axis="y", labelsize=7)
    for ax in list(axes.flat)[len(panels):]:
        ax.axis("off")
    fig.suptitle("Segment features, tuning sessions: one dot per segment, black bar = median. Gaze: self-calibrated z, k = 3.0", fontsize=10)
    fig.tight_layout(rect=(0, 0, 1, 0.98))
    fig.savefig(OUT / "segment_features.png", dpi=110)
    plt.close(fig)
    print("\nFiles written:", *(str(OUT / n) for n in ("segment_features_auc.csv", "segment_features_values.csv", "segment_features.png")), sep="\n  ")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
