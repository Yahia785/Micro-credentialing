"""Keystroke measurements from two published methods, NO model and NO training (no calibration needed).

    python keys_literature.py <folder> [--copy-scenarios a,b] [--honest-scenarios c,d]
    python keys_literature.py --selftest

(1) Duolingo, Niu et al. 2025 (AIME-Con), content-agnostic features, adapted: key categories per 10 s, press-to-press
    timing statistics, pauses above 200 / 500 / 1000 / 2000 / 3000 ms, and, only if the recording has key-release lines,
    dwell, release-to-next-press and release-to-release with the same statistics.
(2) Hellas, Leinonen, Ihantola 2017 (ITiCSE): copying looks linear, with no missteps: deletion share, deletions per minute,
    longest run of input keys without a deletion, deletion bursts per minute and mean burst length.

Segments (scripted sessions, as in segment_features.py, which supplies build_segments): copy labels (per kind), honest-type
cut into 15 s windows (pieces under 10 s dropped), honest-keyboard, thinking. Scripted sessions: split read from the sidecar
header, only "tuning" is read. Unscripted recordings (no script block in the header): the whole recording is one condition
taken from the scenario name and is cut into 15 s windows (pieces under 10 s dropped); the condition maps to a group with
--copy-scenarios / --honest-scenarios (defaults: names starting with "copy" -> copy; "normal" and names starting with
"honest" -> honest typing; any other scenario is its own group, reported in the raw table only).

Key lines. Old recordings (no keyLogVersion in the header): {"type": "key", "t": ms, "cat": "char|space|enter|backspace|delete|other"}.
Version 2 (client/src/recorder.ts, keyLogVersion 2): key lines also have "id" and the category "move"; each release is
{"type": "keyup", "t": ms, "id": id of its press or null, "category": ...}; during key repeat the release pairs with the first
press of the hold. The reader below also accepts a few other spellings: a key-release line is any of
type keyup / key_up / keyrelease / release, or a "key" line with phase / dir / ev / action / state / kind in
{up, keyup, release, released} or "up" / "release" true; presses and releases are paired by the first of the fields
id / kid / key_id / seq / n that is present (a release whose id is null is never paired), otherwise first-in-first-out;
a "move" category is read as such. Without
release lines the dwell and release features are reported as not available. Note: the client logs every keydown, so a
held key (auto-repeat) appears as many presses.
Everything printed is "(no calibration needed)".
"""
from __future__ import annotations

import csv
import json
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402

import common  # noqa: E402
import scripted_common as sc_  # noqa: E402
import segment_features as sf  # noqa: E402

OUT = sc_.OUT_DIR
INPUT_CATS = ("char", "space", "enter")
DELETE_CATS = ("backspace", "delete")
PAUSE_MS = (200, 500, 1000, 2000, 3000)
PCTS = (1, 25, 50, 75, 99)
RELEASE_TYPES = {"keyup", "key_up", "keyrelease", "key_release", "release"}
RELEASE_VALUES = {"up", "keyup", "release", "released"}
PHASE_FIELDS = ("phase", "dir", "ev", "action", "state", "kind")
ID_FIELDS = ("id", "kid", "key_id", "seq", "n")
GROUPS = ("copy", "phone-desk", "phone-lap", "screen", "screen-eyes", "honest typing", "keyboard", "thinking")
PLOT_GROUPS = ("copy", "honest typing", "keyboard", "thinking")
COLOURS = {"copy": "#D55E00", "honest typing": "#555555", "keyboard": "#009E73", "thinking": "#CC79A7"}
TAG = "(no calibration needed)"


# ---------------------------------------------------------------------------------------------------------------
def read_keys(path: Path) -> tuple[list[dict], list[dict], bool]:
    """(presses, releases, has_release_lines). press = {t (s), cat, id}, release = {t (s), id}. Only times and categories."""
    presses, releases = [], []
    with Path(path).open(encoding="utf-8") as fh:
        for line in fh:
            if '"key' not in line and '"release' not in line:
                continue
            rec = json.loads(line)
            typ = str(rec.get("type", ""))
            if typ not in RELEASE_TYPES and typ != "key":
                continue
            kid = next((rec[f] for f in ID_FIELDS if f in rec), None)
            is_rel = typ in RELEASE_TYPES or any(str(rec.get(f, "")).lower() in RELEASE_VALUES for f in PHASE_FIELDS) \
                or rec.get("up") is True or rec.get("release") is True
            t = float(rec["t"]) / 1000.0
            if is_rel:
                # a release that carries an id field with value null = its press was not seen (client keyLogVersion 2): never paired
                releases.append({"t": t, "id": kid, "orphan": kid is None and any(f in rec for f in ID_FIELDS)})
            else:
                presses.append({"t": t, "cat": rec.get("cat") or "unknown", "id": kid})
    presses.sort(key=lambda r: r["t"])
    releases.sort(key=lambda r: r["t"])
    return presses, releases, bool(releases)


def pair_releases(presses: list[dict], releases: list[dict]) -> None:
    """Adds p['release'] (time in s or None). By id when both carry one, else first-in-first-out."""
    for p in presses:
        p["release"] = None
    open_by_id: dict = {}
    fifo: list[dict] = []
    events = sorted([(p["t"], 0, p) for p in presses] + [(r["t"], 1, r) for r in releases], key=lambda e: (e[0], e[1]))
    for _, kind, obj in events:
        if kind == 0:
            if obj["id"] is not None:
                open_by_id.setdefault(obj["id"], []).append(obj)
            fifo.append(obj)
        elif obj.get("orphan"):
            continue
        else:
            target = None
            if obj["id"] is not None and open_by_id.get(obj["id"]):
                target = open_by_id[obj["id"]].pop(0)
                fifo.remove(target)
            elif fifo:
                target = fifo.pop(0)
                if target["id"] is not None and target in open_by_id.get(target["id"], []):
                    open_by_id[target["id"]].remove(target)
            if target is not None:
                target["release"] = obj["t"]


# ---------------------------------------------------------------------------------------------------------------
def stats(prefix: str, x_ms: np.ndarray) -> dict:
    nan = float("nan")
    out = {f"{prefix}_mean_ms": nan, f"{prefix}_sd_ms": nan, f"{prefix}_skew": nan, **{f"{prefix}_p{q}_ms": nan for q in PCTS}}
    if len(x_ms) >= 1:
        for q in PCTS:
            out[f"{prefix}_p{q}_ms"] = float(np.percentile(x_ms, q))
    if len(x_ms) >= 2:
        out[f"{prefix}_mean_ms"] = float(np.mean(x_ms))
        out[f"{prefix}_sd_ms"] = float(np.std(x_ms))
    if len(x_ms) >= 3 and np.std(x_ms) > 0:
        out[f"{prefix}_skew"] = float(np.mean(((x_ms - np.mean(x_ms)) / np.std(x_ms)) ** 3))
    return out


def segment_features(presses: list[dict], a: float, b: float, has_move: bool, has_release: bool) -> dict:
    dur = b - a
    per10 = 10.0 / dur
    ps = [p for p in presses if a <= p["t"] < b]
    cats = [p["cat"] for p in ps]
    n_in = sum(c in INPUT_CATS for c in cats)
    n_del = sum(c in DELETE_CATS for c in cats)
    n_move = sum(c == "move" for c in cats)
    n_other = len(cats) - n_in - n_del - n_move
    f: dict = {"input_per_10s": n_in * per10, "delete_per_10s": n_del * per10, "other_per_10s": n_other * per10}
    if has_move:
        f["move_per_10s"] = n_move * per10
    gaps = np.diff([p["t"] for p in ps]) * 1000.0
    f.update(stats("press_to_press", gaps))
    for th in PAUSE_MS:
        big = gaps[gaps > th]
        f[f"pauses_over_{th}ms_per_10s"] = len(big) * per10
        f[f"paused_share_over_{th}ms"] = float(big.sum() / 1000.0 / dur)
        f[f"mean_pause_over_{th}ms_ms"] = float(big.mean()) if len(big) else float("nan")
    if has_release:
        rel = [p["release"] for p in ps if p["release"] is not None]
        dwell = np.array([(p["release"] - p["t"]) * 1000.0 for p in ps if p["release"] is not None])
        r2p = np.array([(q["t"] - p["release"]) * 1000.0 for p, q in zip(ps, ps[1:]) if p["release"] is not None])
        r2r = np.diff(sorted(rel)) * 1000.0
        f.update(stats("dwell", dwell))
        f.update(stats("release_to_next_press", r2p))
        f.update(stats("release_to_release", r2r))
    # Hellas-style: linear, no missteps
    f["deletion_share_of_keys"] = n_del / len(ps) if ps else float("nan")
    f["deletions_per_min"] = n_del * 60.0 / dur
    longest = run = 0
    bursts, burst = [], 0
    for c in cats:
        if c in DELETE_CATS:
            run = 0
            burst += 1
        else:
            if burst:
                bursts.append(burst)
                burst = 0
            if c in INPUT_CATS:
                run += 1
                longest = max(longest, run)
    if burst:
        bursts.append(burst)
    f["longest_input_run_without_deletion"] = float(longest)
    f["deletion_bursts_per_min"] = len(bursts) * 60.0 / dur
    f["mean_deletion_burst_length"] = float(np.mean(bursts)) if bursts else float("nan")
    return f


# ---------------------------------------------------------------------------------------------------------------
def condition_group(scenario: str, copy_sc: set, honest_sc: set) -> str:
    if scenario in copy_sc or scenario.startswith("copy"):
        return "copy"
    if scenario in honest_sc or scenario == "normal" or scenario.startswith("honest"):
        return "honest typing"
    return scenario


def collect(folder: Path, copy_sc: set, honest_sc: set) -> tuple[list[dict], dict]:
    """One row per segment with its group, kind and features. Held-out sessions are skipped from the header alone."""
    sidecars = common.find_sidecars(folder)
    info = {"sessions": [], "skipped": 0, "has_release": False, "has_move": False}
    raw = []
    for p in sidecars:
        header = sc_.read_header(p)
        scripted = bool(header.get("script"))
        if scripted and sc_.split_of(header) != "tuning":
            info["skipped"] += 1
            continue
        presses, releases, has_rel = read_keys(p)
        pair_releases(presses, releases)
        info["has_release"] |= has_rel
        info["has_move"] |= any(q["cat"] == "move" for q in presses)
        if scripted:
            sc = sc_.load_tuning_sidecar(p)
            ns = SimpleNamespace(scid=header["script"]["id"], labels=common.load_labels_ex(p) or [], sc=sc)
            segs = sf.build_segments(ns)
            dur = sc.duration_s
            info["sessions"].append(header["script"]["id"])
        else:
            sc = common.load_sidecar(p)
            dur = sc.duration_s or (presses[-1]["t"] if presses else 0.0)
            scen = str(header.get("scenario") or "unknown")
            group = condition_group(scen, copy_sc, honest_sc)
            segs = []
            t0 = 0.0
            while t0 < dur - 1e-9:
                t1 = min(t0 + 15.0, dur)
                if t1 - t0 >= 10.0:
                    segs.append({"session": scen, "group": group, "label": scen, "a": t0, "b": t1})
                t0 += 15.0
            info["sessions"].append(scen)
        raw.append((presses, segs))
    rows = []
    for presses, segs in raw:
        for seg in segs:
            rows.append({**seg, "_presses": presses})
    for r in rows:
        r.update(segment_features(r.pop("_presses"), r["a"], r["b"], info["has_move"], info["has_release"]))
        r["dur_s"] = r["b"] - r["a"]
        r["kind"] = r["label"][len("copy-"):] if r["group"] == "copy" and r["label"].startswith("copy-") else ""
    return rows, info


def group_values(rows: list[dict], key: str, group: str) -> np.ndarray:
    if group in ("phone-desk", "phone-lap", "screen", "screen-eyes"):
        sel = [r[key] for r in rows if r["group"] == "copy" and r["kind"] == group]
    else:
        sel = [r[key] for r in rows if r["group"] == group]
    return sf.finite(sel)


def group_size(rows: list[dict], group: str) -> int:
    if group in ("phone-desk", "phone-lap", "screen", "screen-eyes"):
        return sum(1 for r in rows if r["group"] == "copy" and r["kind"] == group)
    return sum(1 for r in rows if r["group"] == group)


def feature_names(rows: list[dict]) -> list[str]:
    skip = {"session", "group", "label", "a", "b", "dur_s", "kind"}
    return [k for k in rows[0] if k not in skip]


def operating_point(copy: np.ndarray, honest: np.ndarray, higher: bool, n_copy: int, n_honest: int) -> dict:
    """Threshold flagging at most 1 honest-typing window (maximum catches under that limit). Chosen on the same data."""
    h = np.sort(honest if higher else -honest)
    c = copy if higher else -copy
    thr = h[-2] if len(h) >= 2 else -np.inf               # flag value > thr: only values above the 2nd highest honest value
    flagged_h = int(np.sum(h > thr))
    caught = int(np.sum(c > thr))
    return {"threshold": float(thr if higher else -thr) if np.isfinite(thr) else float("nan"), "rule": "value > t" if higher else "value < t",
            "honest_flagged": flagged_h, "n_honest": n_honest, "copy_caught": caught, "n_copy": n_copy}


# ---------------------------------------------------------------------------------------------------------------
def analyse(rows: list[dict], info: dict) -> dict:
    feats = feature_names(rows)
    raw_rows, auc_rows, op_rows = [], [], []
    for k in feats:
        row = {"feature": k}
        for g in GROUPS:
            v = group_values(rows, k, g)
            row[g] = (float(np.median(v)), float(np.percentile(v, 25)), float(np.percentile(v, 75)), len(v)) if len(v) else (float("nan"),) * 3 + (0,)
        raw_rows.append(row)
        c, h = group_values(rows, k, "copy"), group_values(rows, k, "honest typing")
        a1, d1 = sf.flipped(sf.auc(c, h))
        phone = np.concatenate([group_values(rows, k, "phone-desk"), group_values(rows, k, "phone-lap")])
        a2, d2 = sf.flipped(sf.auc(phone, group_values(rows, k, "keyboard")))
        a3, d3 = sf.flipped(sf.auc(c, group_values(rows, k, "thinking")))
        auc_rows.append({"feature": k, "auc_copy_vs_honest_typing": a1, "dir_copy_vs_honest": d1, "n_copy_honest": f"{len(c)}/{len(h)}",
                         "auc_phone_vs_keyboard": a2, "dir_phone_vs_keyboard": d2, "auc_copy_vs_thinking": a3, "dir_copy_vs_thinking": d3})
        if len(c) and len(h) and a1 == a1:
            op = operating_point(c, h, d1 == "copy higher", group_size(rows, "copy"), group_size(rows, "honest typing"))
            op_rows.append({"feature": k, "auc": a1, **op})
    auc_rows.sort(key=lambda r: -(r["auc_copy_vs_honest_typing"] if r["auc_copy_vs_honest_typing"] == r["auc_copy_vs_honest_typing"] else -1))
    return {"features": feats, "raw": raw_rows, "auc": auc_rows, "op": op_rows}


def fm(v, nd=3) -> str:
    return "nan" if v != v else f"{v:.{nd}f}"


def report(rows: list[dict], info: dict, res: dict) -> None:
    print(f"{len(info['sessions'])} session(s): {', '.join(info['sessions'])}; {info['skipped']} held-out session(s) skipped (header split). {TAG}")
    print(f"key-release lines in these recordings: {'yes' if info['has_release'] else 'NO: dwell, release-to-next-press and release-to-release are NOT AVAILABLE'}; "
          f"'move' category: {'yes' if info['has_move'] else 'no (not in these recordings)'}")
    print("\nSegments per group:", ", ".join(f"{g} {group_size(rows, g)}" for g in GROUPS if group_size(rows, g)),
          "| other groups:", ", ".join(sorted({r['group'] for r in rows} - set(GROUPS))) or "none")
    print(f"\n=== 1. Raw measurements {TAG}: median [Q1, Q3] per group; (n) only when fewer segments than the group size ===")
    cols = ["feature", *GROUPS]
    table = []
    for r in res["raw"]:
        row = {"feature": r["feature"]}
        for g in GROUPS:
            med, q1, q3, n = r[g]
            size = group_size(rows, g)
            row[g] = ("-" if n == 0 else f"{fm(med)} [{fm(q1)}, {fm(q3)}]") + ("" if n == size else f" ({n})")
        table.append(row)
    print("group sizes: " + ", ".join(f"{g} {group_size(rows, g)}" for g in GROUPS))
    sf.cg.print_table(table, cols)
    print(f"\n=== 2. Separation {TAG}: AUC flipped (0.5 = none, 1.0 = perfect), sorted by copy vs honest typing ===")
    show = [{"feature": r["feature"], "copy vs honest typing": f"{fm(r['auc_copy_vs_honest_typing'], 2)} ({r['dir_copy_vs_honest']})", "n copy/honest": r["n_copy_honest"],
             "phone copy vs keyboard": f"{fm(r['auc_phone_vs_keyboard'], 2)} ({r['dir_phone_vs_keyboard']})",
             "copy vs thinking": f"{fm(r['auc_copy_vs_thinking'], 2)} ({r['dir_copy_vs_thinking']})"} for r in res["auc"]]
    sf.cg.print_table(show, list(show[0]))
    print(f"\n=== 3. Operating point per single feature {TAG}: threshold flagging at most 1 honest-typing window. "
          "CHOSEN ON THE SAME DATA: optimistic. ===")
    show = [{"feature": r["feature"], "AUC": fm(r["auc"], 2), "flag if": f"{r['rule']}", "t": fm(r["threshold"], 3),
             "honest flagged": f"{r['honest_flagged']}/{r['n_honest']}", "copy caught": f"{r['copy_caught']}/{r['n_copy']}"}
            for r in sorted(res["op"], key=lambda r: (-r["copy_caught"], r["honest_flagged"], -r["auc"]))]
    sf.cg.print_table(show, list(show[0]))


def write_outputs(rows: list[dict], res: dict) -> list[Path]:
    OUT.mkdir(parents=True, exist_ok=True)
    paths = []

    def dump(name: str, data: list[dict], cols: list[str]) -> None:
        p = OUT / name
        with p.open("w", newline="", encoding="utf-8") as fh:
            w = csv.DictWriter(fh, fieldnames=cols, extrasaction="ignore")
            w.writeheader()
            w.writerows(data)
        paths.append(p)
    flat = []
    for r in res["raw"]:
        row = {"feature": r["feature"]}
        for g in GROUPS:
            row[f"{g}_median"], row[f"{g}_q1"], row[f"{g}_q3"], row[f"{g}_n"] = r[g]
        flat.append(row)
    dump("keys_literature_raw.csv", flat, list(flat[0]))
    dump("keys_literature_auc.csv", res["auc"], list(res["auc"][0]))
    if res["op"]:
        dump("keys_literature_operating.csv", res["op"], list(res["op"][0]))
    dump("keys_literature_values.csv", rows, ["session", "group", "kind", "label", "a", "b", "dur_s", *res["features"]])
    best = [r["feature"] for r in res["auc"] if r["auc_copy_vs_honest_typing"] == r["auc_copy_vs_honest_typing"]][:8]
    if best:
        fig, axes = plt.subplots(2, 4, figsize=(18, 8))
        rng = np.random.default_rng(0)
        for ax, k in zip(axes.flat, best):
            for i, g in enumerate(PLOT_GROUPS):
                v = group_values(rows, k, g)
                ax.scatter(i + rng.uniform(-0.18, 0.18, len(v)), v, s=14, color=COLOURS[g], alpha=0.8, lw=0)
                if len(v):
                    ax.hlines(np.median(v), i - 0.3, i + 0.3, color="black", lw=1.4)
            a = next(r for r in res["auc"] if r["feature"] == k)
            ax.set_title(f"{k}\nAUC {fm(a['auc_copy_vs_honest_typing'], 2)} ({a['dir_copy_vs_honest']})", fontsize=8)
            ax.set_xticks(range(len(PLOT_GROUPS)))
            ax.set_xticklabels(["copy", "honest\ntyping", "keyboard", "thinking"], fontsize=8)
            ax.grid(alpha=0.2)
        fig.suptitle(f"Best 8 keystroke features by AUC, copy vs honest typing {TAG}; one dot per segment, black bar = median", fontsize=10)
        fig.tight_layout(rect=(0, 0, 1, 0.96))
        p = OUT / "keys_literature.png"
        fig.savefig(p, dpi=110)
        plt.close(fig)
        paths.append(p)
    return paths


# ---------------------------------------------------------------------------------------------------------------
def selftest() -> int:
    """Synthetic unscripted recordings with release lines (several formats) and a 'move' category: the pipeline must use them."""
    rng = np.random.default_rng(3)
    with tempfile.TemporaryDirectory() as tmp:
        for name, fast in (("copy-test", True), ("normal", False)):
            lines = [{"type": "header", "id": f"x_{name}", "scenario": name}]
            t = 1000.0
            for i in range(300):
                t += rng.exponential(120 if fast else 200) + (900 if (not fast and i % 40 == 0) else 0)
                cat = rng.choice(["char", "char", "char", "space", "backspace", "move", "other"])
                kid = i
                lines.append({"type": "key", "t": round(t, 1), "cat": str(cat), "id": kid})
                rel = {"type": "keyup", "t": round(t + 80 + rng.normal(0, 10), 1), "id": kid} if i % 2 else \
                      {"type": "key", "t": round(t + 80 + rng.normal(0, 10), 1), "phase": "up", "id": kid}
                lines.append(rel)
            lines.append({"type": "summary", "durationS": round(t / 1000.0 + 1, 2)})
            lines.sort(key=lambda r: r.get("t", 0))
            with (Path(tmp) / f"sidecar-x_{name}.jsonl").open("w", encoding="utf-8") as fh:
                for r in lines:
                    fh.write(json.dumps(r) + "\n")
        rows, info = collect(Path(tmp), set(), set())
        res = analyse(rows, info)
        feats = set(res["features"])
        assert info["has_release"] and info["has_move"], info
        assert {"move_per_10s", "dwell_mean_ms", "release_to_next_press_p50_ms", "release_to_release_sd_ms"} <= feats, feats
        d = group_values(rows, "dwell_mean_ms", "honest typing")
        assert len(d) and 60 < float(np.median(d)) < 100, d
        assert {r["group"] for r in rows} == {"copy", "honest typing"}
        print("selftest ok:", len(rows), "segments,", len(feats), "features; release and move features present, dwell median", fm(float(np.median(d)), 1), "ms")
    return 0


def main(argv: list[str]) -> int:
    if "--selftest" in argv:
        return selftest()
    args = [a for a in argv[1:] if not a.startswith("--")]
    opt = {argv[i]: argv[i + 1] for i in range(1, len(argv) - 1) if argv[i] in ("--copy-scenarios", "--honest-scenarios")}
    args = [a for a in args if a not in opt.values()]
    if len(args) != 1:
        print("usage: python keys_literature.py <folder> [--copy-scenarios a,b] [--honest-scenarios c,d] | --selftest", file=sys.stderr)
        return 2
    split = lambda s: {x for x in s.split(",") if x}  # noqa: E731
    rows, info = collect(Path(args[0]), split(opt.get("--copy-scenarios", "")), split(opt.get("--honest-scenarios", "")))
    if not rows:
        print("no segments found", file=sys.stderr)
        return 1
    res = analyse(rows, info)
    report(rows, info, res)
    print("\nFiles written:")
    for p in write_outputs(rows, res):
        print("  " + str(p))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
