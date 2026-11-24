"""Masked-video gaze reader: draw synthetic masks with OpenCV in the client's colours (known pupil offset, nose position,
eye shape), degrade them like webm compression does (blur, noise, JPEG), and check that the reader recovers the truth."""
import math

import cv2
import numpy as np
import pytest

from analyzer import masked_gaze as mg

SKIN = (156, 180, 201)      # BGR of #c9b49c
OUTLINE = (58, 74, 90)      # BGR of #5a4a3a
PUPIL = (27, 27, 27)
MOUTH = (43, 43, 122)
W, H = 1280, 720


def background(seed=0) -> np.ndarray:
    rng = np.random.default_rng(seed)
    base = np.linspace(200, 120, W, dtype=np.float32)[None, :, None] * np.ones((H, 1, 3), np.float32)
    base += rng.normal(0, 6, (H, W, 3)).astype(np.float32)
    img = np.clip(base, 0, 255).astype(np.uint8)
    img = cv2.GaussianBlur(img, (0, 0), 3)
    cv2.rectangle(img, (300, 520), (980, 720), (110, 150, 190), -1)    # a tan "shirt", not the skin colour
    return img


def draw_mask(img, *, c=(640, 300), hx=(0.0, 0.0), vy=(0.0, 0.0), roll=0.0, eye_w=62.0, eye_open=0.34, eye_dist=105.0,
              nose_rel=(0.0, 0.62), skin=SKIN, outline=OUTLINE, face_axes=(165, 215)):
    """hx / vy: pupil offsets (image-left eye, image-right eye) in SEMI-AXES of the eye ellipse (+ = image right / down).
    nose_rel: nose centre relative to the eye midpoint, in eye distances (image axes)."""
    img = img.copy()
    cv2.ellipse(img, c, face_axes, 0, 0, 360, skin, -1, cv2.LINE_AA)
    cv2.ellipse(img, c, face_axes, 0, 0, 360, outline, 3, cv2.LINE_AA)
    th = math.radians(roll)
    u = np.array([math.cos(th), math.sin(th)])
    v = np.array([-u[1], u[0]])
    mid = np.array([c[0], c[1] - 40.0])
    centres = [mid - u * eye_dist / 2, mid + u * eye_dist / 2]
    rx = 0.62 * eye_w
    ry = max(0.75 * eye_open * eye_w, 0.3 * rx)
    for k, ec in enumerate(centres):
        ang = math.degrees(th)
        cv2.ellipse(img, (int(round(ec[0] * 16)), int(round(ec[1] * 16))), (0, 0), 0, 0, 0, 0)  # no-op, keeps style
        _ellipse(img, ec, rx, ry, ang, (255, 255, 255), -1)
        _ellipse(img, ec, rx, ry, ang, outline, 2)
        p = ec + u * hx[k] * rx + v * vy[k] * ry
        layer = img.copy()
        cv2.circle(layer, (int(round(p[0] * 16)), int(round(p[1] * 16))), 8 * 16, PUPIL, -1, cv2.LINE_AA, 4)
        clip = np.zeros((H, W), np.uint8)
        cv2.ellipse(clip, (int(round(ec[0] * 16)), int(round(ec[1] * 16))), (int(rx * 16), int(ry * 16)), ang, 0, 360, 255, -1,
                    cv2.LINE_AA, 4)
        a = (clip.astype(np.float32) / 255.0)[..., None]
        img = (layer * a + img * (1 - a)).astype(np.uint8)
    nose = mid + np.array(nose_rel) * eye_dist
    cv2.circle(img, (int(round(nose[0] * 16)), int(round(nose[1] * 16))), int(7.5 * 16), outline, -1, cv2.LINE_AA, 4)
    cv2.ellipse(img, (int(c[0]), int(c[1] + 95)), (38, 6), 0, 0, 360, MOUTH, -1, cv2.LINE_AA)
    cv2.ellipse(img, (int(c[0]), int(c[1] + 95)), (38, 6), 0, 0, 360, outline, 2, cv2.LINE_AA)
    return img


def _ellipse(img, centre, rx, ry, ang, colour, thick):
    cv2.ellipse(img, (int(round(centre[0] * 16)), int(round(centre[1] * 16))), (int(round(rx * 16)), int(round(ry * 16))), ang, 0, 360,
                colour, thick, cv2.LINE_AA, 4)


def compress(img, seed=1, jpeg=45, blur=0.8, noise=3.0) -> np.ndarray:
    """Imitate webm compression: blur, noise, JPEG round trip."""
    rng = np.random.default_rng(seed)
    out = cv2.GaussianBlur(img, (0, 0), blur)
    out = np.clip(out.astype(np.float32) + rng.normal(0, noise, out.shape), 0, 255).astype(np.uint8)
    ok, buf = cv2.imencode(".jpg", out, [cv2.IMWRITE_JPEG_QUALITY, jpeg])
    assert ok
    return cv2.imdecode(buf, cv2.IMREAD_COLOR)


OFFSETS = [(0.0, 0.0), (-0.5, 0.0), (0.5, 0.0), (0.0, 0.4), (0.3, -0.3), (-0.4, 0.3)]


@pytest.mark.parametrize("h,v", OFFSETS)
def test_clean_pupil_offset(h, v):
    r, _ = mg.read_mask(draw_mask(background(), hx=(h, h), vy=(v, v)))
    assert r.found, r.reason
    assert r.pupil_h == pytest.approx(h, abs=0.05)
    assert r.pupil_v == pytest.approx(v, abs=0.07)
    assert r.pupil_h_l == pytest.approx(h, abs=0.06) and r.pupil_h_r == pytest.approx(h, abs=0.06)


@pytest.mark.parametrize("h,v", OFFSETS)
def test_compressed_pupil_offset(h, v):
    r, _ = mg.read_mask(compress(draw_mask(background(), hx=(h, h), vy=(v, v))))
    assert r.found, r.reason
    assert r.pupil_h == pytest.approx(h, abs=0.08)
    assert r.pupil_v == pytest.approx(v, abs=0.10)


def test_eyes_have_different_offsets_and_image_left_is_first():
    r, _ = mg.read_mask(compress(draw_mask(background(), hx=(-0.4, 0.4), vy=(0.2, -0.2))))
    assert r.found
    assert r.pupil_h_l == pytest.approx(-0.4, abs=0.08) and r.pupil_h_r == pytest.approx(0.4, abs=0.08)
    assert r.pupil_v_l == pytest.approx(0.2, abs=0.1) and r.pupil_v_r == pytest.approx(-0.2, abs=0.1)
    assert r.pupil_h == pytest.approx(0.0, abs=0.08)


def test_rotated_eyes_offsets_in_the_eye_axes():
    r, _ = mg.read_mask(compress(draw_mask(background(), hx=(0.4, 0.4), vy=(0.2, 0.2), roll=9.0)))
    assert r.found
    assert r.pupil_h == pytest.approx(0.4, abs=0.09)
    assert r.pupil_v == pytest.approx(0.2, abs=0.11)
    assert r.roll_deg == pytest.approx(9.0, abs=1.5)


@pytest.mark.parametrize("nose", [(0.0, 0.62), (0.12, 0.62), (-0.15, 0.55), (0.05, 0.75)])
def test_nose_position_relative_to_eyes(nose):
    for img in (draw_mask(background(), nose_rel=nose), compress(draw_mask(background(), nose_rel=nose))):
        r, _ = mg.read_mask(img)
        assert r.found
        assert r.nose_h == pytest.approx(nose[0], abs=0.03)
        assert r.nose_v == pytest.approx(nose[1], abs=0.03)
        assert r.eye_dist == pytest.approx(105.0, abs=2.0)


@pytest.mark.parametrize("eye_open", [0.18, 0.28, 0.38])
def test_eye_openness_follows_the_ellipse_height(eye_open):
    rx = 0.62 * 62.0
    ry = max(0.75 * eye_open * 62.0, 0.3 * rx)
    r, _ = mg.read_mask(compress(draw_mask(background(), eye_open=eye_open)))
    assert r.found
    assert r.openness == pytest.approx(ry / rx, abs=0.05)


def test_openness_floor_is_0_3():
    r, _ = mg.read_mask(draw_mask(background(), eye_open=0.05))
    assert r.found and r.openness == pytest.approx(0.3, abs=0.05)


def test_face_width():
    r, _ = mg.read_mask(draw_mask(background()))
    assert r.found
    assert r.face_w == pytest.approx(2 * 165, abs=10)     # skin fill width: the outline is not skin coloured


def test_pixelated_frame_with_banner_is_not_found():
    scene = draw_mask(background())
    tiny = cv2.resize(scene, (W // 40, H // 40), interpolation=cv2.INTER_AREA)
    pix = cv2.resize(tiny, (W, H), interpolation=cv2.INTER_NEAREST)
    bh = max(40, int(H * 0.09))
    ov = pix.copy()
    cv2.rectangle(ov, (0, 0), (W, bh), (30, 30, 190), -1)
    pix = cv2.addWeighted(ov, 0.9, pix, 0.1, 0)
    r, _ = mg.read_mask(compress(pix))
    assert not r.found
    assert r.lost_banner


def test_scene_without_a_mask_is_not_found():
    r, _ = mg.read_mask(background())
    assert not r.found and r.reason


def test_normal_frame_has_no_banner():
    r, _ = mg.read_mask(draw_mask(background()))
    assert not r.lost_banner


def test_custom_mask_colours_from_header_options():
    skin, outline = (140, 160, 120), (40, 60, 50)       # BGR of #78a08c and #323c28
    opts = {"skinColor": "#78a08c", "outlineColor": "#323c28"}
    img = draw_mask(background(), skin=skin, outline=outline, hx=(0.3, 0.3))
    assert not mg.read_mask(img)[0].found                 # default colours do not match
    r, _ = mg.read_mask(img, mg.MaskColors.from_options(opts))
    assert r.found and r.pupil_h == pytest.approx(0.3, abs=0.07)


def test_as_dict_has_no_nan():
    r, _ = mg.read_mask(background())
    d = r.as_dict()
    assert d["found"] is False and d["pupil_h"] is None


def test_video_roundtrip_with_time_offset(tmp_path):
    frames = [draw_mask(background(), hx=(h, h)) for h in (-0.4, 0.0, 0.4)]
    path = tmp_path / "synthetic.avi"
    vw = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*"MJPG"), 10.0, (W, H))
    for f in frames:
        vw.write(f)
    vw.release()
    got = list(mg.analyze_video(path, offset_ms=500.0))
    assert len(got) == 3
    assert [round(t, 2) for t, _ in got] == pytest.approx([0.5, 0.6, 0.7], abs=0.02)
    assert [r.pupil_h for _, r in got] == pytest.approx([-0.4, 0.0, 0.4], abs=0.1)
