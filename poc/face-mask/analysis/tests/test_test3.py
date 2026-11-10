import json

import test3_lookaway as t3
from common import load_labels_ex, load_sidecar

HDR_POINT = lambda h, v, yaw, pitch: {"yaw": yaw, "pitch": pitch, "gazeH": h, "gazeV": v, "blendH": h, "blendV": v}  # noqa: E731
HEADER = {"type": "header", "calibration": {
    "baseline": HDR_POINT(0.05, 0.1, 0, 10),
    "edges": {"left": HDR_POINT(0.5, 0.1, 12, 10), "right": HDR_POINT(-0.35, 0.1, -12, 10), "top": HDR_POINT(0.05, -0.3, 0, 3),
              "bottom": HDR_POINT(0.05, 0.5, 0, 17), "keyboard": HDR_POINT(0.05, 0.8, 0, 28)}}}


def write(tmp_path, looks, keys=(), labels_csv=None):
    frames = []
    for i in range(20 * 60):
        t = i / 20
        h, v = 0.05, 0.1
        for a, b, hh, vv in looks:
            if a <= t < b:
                h, v = hh, vv
        frames.append({"type": "frame", "t": t * 1000, "lost": False, "yaw": 0.0, "pitch": 10.0, "blendH": h, "blendV": v})
    p = tmp_path / "sidecar-s_normal_1.jsonl"
    lines = [HEADER] + frames + [{"type": "key", "t": k * 1000, "cat": "char"} for k in keys]
    p.write_text("\n".join(json.dumps(x) for x in lines))
    if labels_csv is not None:
        (tmp_path / "sidecar-s_normal_1.labels.csv").write_text(labels_csv)
    return p


def run(p):
    return t3.analyse(load_sidecar(p), load_labels_ex(p), "blend", True, "fixed")


def test_label_found_and_direction_checked(tmp_path):
    p = write(tmp_path, [(10, 13, 0.05, 1.6), (30, 33, -0.9, 0.1)],
              labels_csv="start_s,end_s,label,direction\n10,13,look-away,down\n30,33,look-away,right\n")
    r = run(p)
    assert (r["found"], r["dir_total"], r["dir_ok"]) == (2, 2, 2) and r["extra"] == []


def test_wrong_direction_is_counted(tmp_path):
    p = write(tmp_path, [(10, 13, 0.05, 1.6)], labels_csv="start_s,end_s,label,direction\n10,13,look-away,up\n")
    r = run(p)
    assert (r["found"], r["dir_total"], r["dir_ok"]) == (1, 1, 0)


def test_no_direction_in_the_label_means_any(tmp_path):
    p = write(tmp_path, [(10, 13, 0.05, 1.6)], labels_csv="start_s,end_s,label\n10,13,look-away\n")
    r = run(p)
    assert (r["found"], r["dir_total"]) == (1, 0)


def test_unlabelled_look_is_extra_and_cycles_are_counted(tmp_path):
    looks = [(10, 13, 0.05, 1.6), (25, 28, 0.05, 1.6), (40, 43, -0.9, 0.1)]
    keys = [14.0, 14.3, 29.0, 29.2, 44.0, 44.5]
    p = write(tmp_path, looks, keys=keys, labels_csv="start_s,end_s,label,direction\n10,13,look-away,down\n")
    r = run(p)
    assert r["found"] == 1 and len(r["extra"]) == 2
    assert len(r["cycles"]) == 3 and len(r["patterns"]) == 1
