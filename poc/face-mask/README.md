# Face mask PoC (privacy-preserving proctoring)

A standalone web page that runs on one laptop, masks the student's face in the webcam video, and saves the masked video plus a per-frame data file. **Nothing is uploaded.** It exists to decide by Nov 9 whether a client-side face mask is good enough.

**Branch rules.** Work only on `feature/privacy-mask`. Everything lives in `poc/face-mask/`. Do not edit `frontend/`, `backend/`, the root `.gitignore` or any other `package.json`, because other branches (`feature/ai-agent`, `feature/cpp-runner`) change shared files and this must merge later without conflicts. Commit locally, do not push. Never commit recordings, models or WASM (the PoC's own `.gitignore` covers them).

## What it does

For every camera frame, in this order (the order is a safety requirement):

1. copy the frame into an offscreen snapshot canvas;
2. run MediaPipe FaceLandmarker (0.10.35, VIDEO mode, 2 faces) on the snapshot;
3. draw the output from the **same snapshot**, so the mask cannot lag the face.
   - No face found: the whole frame is pixelated into big blocks and a "TRACKING LOST" banner shows. The real face is never drawn unmasked. A tracker error is treated the same way.
   - Face found: solid face shape (hull of all landmarks, 1.3x, stretched up over the forehead), cartoon eyes with pupils at the real iris (gaze stays visible), nose dot, mouth that follows the lips.

Only the masked view is shown on the page. The raw camera element is hidden and only used as the source of the snapshot.

## Output files (saved to Downloads when you press "Stop and save")

`<id>` = `<laptop>_<scenario>_<timestamp>`

| File | Content |
| --- | --- |
| `masked-<id>.webm` | masked canvas video (vp9, else vp8) plus microphone audio |
| `raw-<id>.webm` | raw camera video plus audio. Research only. On by default, untick "Also save raw video" to skip |
| `sidecar-<id>.jsonl` | one JSON object per line: `header`, many `frame` lines, `key` lines, last line `summary` |

`header` line: id, laptop, scenario, start time, size, delegate (GPU/CPU), `detectLongSide`, user agent, mask options, recorder start offsets, `setup` (did the setup check pass, did the person continue anyway, which checks failed) and `calibration` (baseline, noise, and the left/right edge readings).

`frame` lines: `t` (ms since recording start), `faces`, `lost`; each of `yaw`, `pitch`, `gazeH`, `gazeV`, `blendH` twice: `...Raw` (straight from the tracker) and the plain name (One Euro smoothed); `roll` (raw); the eight blendshape scores `eyeLookInLeft`, `eyeLookOutLeft`, `eyeLookInRight`, `eyeLookOutRight`, `eyeLookUpLeft`, `eyeLookDownLeft`, `eyeLookUpRight`, `eyeLookDownRight`; timings `snapMs`, `detectMs`, `drawMs`, `procMs` (ms per stage); and `maskBoxes` (one `[x, y, w, h]` in video pixels per masked face, after scaling and forehead lift; empty when tracking is lost). `key` lines hold the **time only, never the key**. Readings are for the first face; `null` when tracking is lost.

Sign conventions: `yaw > 0` = face turns toward the right side of the image (your own left, the image is not mirrored); `pitch > 0` = looking down; `gazeH > 0` = iris toward image right; `gazeV > 0` = iris low; `blendH > 0` = blendshape gaze toward the image right (built from eyeLookOutLeft + eyeLookInRight - eyeLookInLeft - eyeLookOutRight, halved; check on screen that it has the same sign as `gazeH`).

Chrome may ask "Allow this site to download multiple files": click Allow, otherwise only the first file saves.

## Run it (PowerShell, from the repo root)

```powershell
git branch --show-current        # must print feature/privacy-mask
cd poc\face-mask\client
npm install                      # also copies the WASM runtime to public\wasm (no CDN)
npm run get-model                # downloads face_landmarker.task (float16) into public\models
npm run dev                      # http://localhost:5180
```

Open http://localhost:5180 in Chrome and allow camera and microphone. The page walks you through:

1. **Start camera.** The big badge shows the delegate (GPU or CPU) and the live fps (red below 15).
2. **Step 1, setup check.** Fit your face in the dashed guide box. A live checklist shows green or red for: face found, lighting (brightness and contrast of the face region), face size (at least 30% of frame height) and face centered. **Continue** unlocks when all are green. **Continue anyway** is for research recordings; the sidecar header then lists which checks failed.
3. **Step 2, calibration (about 9 s).** Press Start calibration. Look at the red dot in the middle of the screen for 5 s without moving your head, then at the left-edge dot and the right-edge dot (2 s each; the first 0.5 s of each is ignored, so each edge reading uses about 1.5 s of data). The median yaw, pitch and gaze become your **baseline**, their spread is the **noise**, and the edge readings show your range. All are stored in the header, and all look-away decisions use values minus this baseline. Use **Recalibrate** if you moved.
4. **Start recording**, then **Stop and save**.

The checkbox **Cover top of head and hair** (on by default) extends the mask upward over the hair.

**Pupils.** Each frame the iris offset inside each eye (in eye widths and heights) is smoothed, and the pupil is drawn at the current, unsmoothed eye centre plus that offset times the current eye size, clamped inside the eye. The pupil therefore moves with the eye in the same frame instead of floating behind it when the head moves.

**Tracking options (for worst-case tests).** `http://localhost:5180/?delegate=cpu&detect=320` (`delegate` = `cpu` or `gpu`, `detect` = 320, 480 or 640). The same choices are dropdowns on the setup screen. The default is GPU with CPU fallback and 640. Both the requested and the actual delegate and the tracking size are logged in the sidecar header (`delegateRequested`, `delegate`, `detectLongSide`). Forcing GPU on a machine without one shows an error and falls back to CPU.

**Speed test.** On the setup screen, sit still looking at the screen and press **Run speed test** (about 2 minutes). It runs 15 s (after a 1 s warm-up) for each of GPU and CPU at 640, 480 and 320, recreating the landmarker when the delegate changes. A table shows average fps, 10th-percentile fps, mean detect ms and the standard deviation of yaw, gazeH and blendH (raw and smoothed) for each. The results download as `speedtest-<laptop>-<time>.json`. Print them later with `python speed_report.py <file or folder>` in the `analysis` folder.

Other commands (in `poc\face-mask\client`): `npm run build` (type-check and bundle), `npm test` (unit tests for pose, gaze, mask geometry, fps stats).

### Analysis setup

```powershell
cd poc\face-mask\analysis
python -m venv ..\.venv
..\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python setup_models.py          # one time: downloads the YuNet face detector for test 2 (git-ignored)
python -m pytest tests -q        # unit tests of the look-away rule
```

Move the downloaded files for one test session into one folder, e.g. `poc\face-mask\recordings\laptopA` (that folder is git-ignored).

## Recording the 9 scenarios

On 3 laptops, one of them low-end. About 1 minute each. Type the laptop name, pick the scenario, Start recording, do the action, Stop and save. Keep typing in the typing box now and then so test 3 can report "looking away while typing".

| Scenario | What to do |
| --- | --- |
| normal | sit, look at the screen, talk a little, type |
| second-screen | glance at a second monitor to the side, several times |
| phone | look down at a phone in your lap or hand, several times |
| hand-over-face | cover part of the face with a hand, then the whole face |
| turn-away | turn head left and right, away from the camera, and back |
| leave-frame | stand up and leave the picture, then return |
| low-light | dim the room or turn your back to the window |
| fast-motion | shake and nod the head fast, move toward and away from the camera |
| second-person | a second person leans into the frame behind or beside you |

## Labelling look-aways (for test 3)

Open `raw-<id>.webm` in VLC. For each time the student looks away on purpose, note start and end seconds from the start of the video. Save `sidecar-<id>.labels.csv` next to the sidecar (same name, `.labels.csv` instead of `.jsonl`):

```
start_s,end_s,label
12.0,15.5,look-away
33.2,35.0,look-away
```

The raw and masked videos start within a few ms of each other; the sidecar header lists each recorder's start offset if you need to correct it.

## The tests

Run from `poc\face-mask\analysis` with the venv active, on a folder of recordings:

```powershell
python test1_speed.py ..\recordings\laptopA
python test2_leaks.py ..\recordings\laptopA
python test3_lookaway.py ..\recordings\laptopA
```

| Test | Measures | Passes when |
| --- | --- | --- |
| 1 speed | average fps, 10th-percentile fps, % lost frames, ms per frame, detect ms | average fps >= 15 = PASS, 10 to 15 = OK (minimum), below 10 = FAIL (check the low-end laptop especially) |
| 2 leaks | Face detectors (Haar frontal, Haar profile on the frame and its mirror, and YuNet) on every frame of `masked-*.webm`. Each hit is classed **OUTSIDE** (not covered by a mask box from the sidecar, so possibly a real face) or **INSIDE** (on the mask, usually just the cartoon fooling the detector). See below | **0 OUTSIDE hits that show a real face, and none of the reviewed INSIDE samples show a real face**, judged by eye |
| 3 look-away | sidecar events vs your labels: labels, found, extra events, events with a key press within 2 s. Options: `--gaze-source iris|blend`, `--raw`, `--thresholds fixed|calibrated` | 90% or more of all labels are found |
| 5 raw vs masked | object and camera checks on the raw and the masked video of the same session; are the flags the same? (needs the server venv, see "Server analysis") | 90% or more of the raw flags are also found in the masked video |
| 6 jitter | on `normal` clips: std of yaw and gaze (raw vs smoothed, iris vs blendshape) and look-away events per minute (all false flags) | 0 false look-aways per minute on every normal clip, with smoothing on |
| 4 identity (manual) | see below | people do no better than chance |

#### Test 2 in detail

```powershell
python setup_models.py                      # once
python test2_leaks.py ..
ecordings\laptopA   # add --every 2 to go faster, --no-yunet for Haar only (weaker)
```

- Each video frame is matched to the nearest sidecar frame by time (using the masked recorder's start offset from the header), which gives the mask boxes for that frame.
- A hit is INSIDE if at least 50% of its area is covered by one mask box (`INSIDE_MIN_FRACTION` in the script), otherwise OUTSIDE. This is slightly stricter than "no overlap at all" on purpose: a real face that only half-sticks out of a mask box must be reviewed, not waved through. Without a sidecar (or with an old one without `maskBoxes`) every hit counts as OUTSIDE.
- Saved to `analysis\out\leaks\<recording>\` with the class in the file name: every `OUTSIDE_*` frame; every frame with a hit within 0.5 s of a tracking-lost change (`*_lostedge_*`); and a random sample of 20 `INSIDE_sample_*` frames. Green boxes = INSIDE, red = OUTSIDE, thin white = mask box.
- The printout and `out\leaks\summary.csv` list per recording: frames, OUTSIDE hits, INSIDE hits, frames saved for review.
- **The script does not decide pass or fail.** You open the saved images. PASS = no OUTSIDE image and no INSIDE sample shows a real face. Detector misses prove nothing, so also scrub a few unflagged frames of hand-over-face, fast-motion and leave-frame.

Look-away rule (constants at the top of `analysis\common.py`). All values are taken **minus the calibration baseline** from the sidecar header:

- **Head:** `|yaw - baseline| > 25` degrees for at least 1.0 s.
- **Eyes:** `|gaze - baseline|` above the enter threshold 0.5 starts an event and it only ends below the exit threshold 0.35 (hysteresis: a value hovering near 0.5 is one event, not many). It must last at least 1.5 s.
- Either one makes a look-away event. Gaps under 0.5 s are merged. Tracking-lost frames never count as looking away (a lost gap under 0.5 s just bridges two runs); they are reported separately (`lost s`).
- **Eye thresholds, two options** (`--thresholds` in test 3 and test 6, `THRESHOLDS_MODE` in `common.py`; the output always says which was used):
  - `fixed` (default): enter 0.5, exit 0.35 for everyone.
  - `calibrated`: from each person's calibration edge readings. For each edge, `d = edge reading - baseline`; `enter = max(EDGE_FACTOR x |d|, MIN_ENTER)` (`EDGE_FACTOR` 1.2, `MIN_ENTER` 0.15, so jitter cannot trigger it), `exit = enter x 0.7`. The edge whose `d` is positive sets the positive side, the edge whose `d` is negative sets the negative side, so a person who looks far one way and little the other gets different limits per side (if only one side is usable the other copies it; with no usable edge it falls back to fixed and says so). Use this when the gaze range on screen is small (for example about +/-0.13 at the screen edges, where a fixed 0.5 would never fire).
- `GAZE_SOURCE` is `blend` (blendshapes, the default: in real tests it caught the most eye-only glances with no false flags) or `iris` (landmarks; with the fixed 0.5 threshold it missed every eye-only glance). `USE_SMOOTHED` switches to the raw fields. Both can be set per run in test 3 (`--gaze-source`) and are compared side by side in test 6.

Every script exits with a clear message when the folder has no matching files.

### Speed report

```powershell
python speed_report.py ..\recordings\laptopA\speedtest-dell-20261104-104000.json
```

Prints one row per delegate and tracking size with the speed verdict, and the largest tracking size that still reaches 15 fps on GPU and on CPU. Use it to pick the tracking size for students without a GPU.

### Test 6: jitter (record a clean `normal` clip first)

Record a 1-minute `normal` clip while sitting still, looking at the screen, typing and talking, never looking away on purpose. Then:

```powershell
python test6_jitter.py ..\recordings\laptopA
```

It prints, per clip, the standard deviation of yaw and gaze and the events per minute for iris raw, iris smoothed, blend raw, blend smoothed. Every event on a normal clip is a false flag. PASS = 0 per minute for the default source (blendshape gaze) with smoothing. If it fails: redo the setup check until green (face closer, more front light), recalibrate, then tune `ONE_EURO_*` in `config.ts` or `GAZE_ENTER`/`GAZE_EXIT`.

### Test 4: can people identify the student? (manual)

Pick 3 volunteers. From the normal/turn-away recordings cut 2 short masked clips of each (6 clips in total), and take one photo of each person. Show the 6 clips to people who do not know the volunteers and ask them to match each clip to one of the 3 photos. Guessing gets about 33% right. If the matching rate is clearly above 33%, the mask is not anonymising enough (try a larger mask scale). Record the number of raters and results.

### Trying the scripts without a camera

```powershell
python make_synthetic.py out\synthetic
python test1_speed.py out\synthetic
python test2_leaks.py out\synthetic
python test3_lookaway.py out\synthetic
```

The data is fake and only checks that the scripts run.

## Settings worth tuning

In `client\src\config.ts`:

- `MIN_FACE_DETECTION_CONFIDENCE`, `MIN_FACE_PRESENCE_CONFIDENCE`, `MIN_TRACKING_CONFIDENCE` (0.6): higher = fewer false faces but more pixelated frames.
- `DEFAULT_MASK_OPTIONS.maskScale` (1.3): bigger covers more during fast motion, looks less natural.
- `DEFAULT_MASK_OPTIONS.foreheadLift` (0.25): how far the shape extends above the landmarks.
- `DEFAULT_MASK_OPTIONS.pixelBlockSize` (40): bigger blocks = stronger pixelation when tracking is lost.
- `CAMERA_WIDTH`/`CAMERA_HEIGHT` (1280x720): lower this on a slow laptop to gain fps.
- `NUM_FACES` (2).
- `DETECT_SIZES` (640, 480, 320): choices on the setup screen. `SWEEP_S` (15) and `SWEEP_WARMUP_S` (1): speed test timing.
- `DETECT_LONG_SIDE` (640): tracking runs on a copy of the snapshot scaled to this long side; drawing still uses the full-size snapshot. Lower = faster tracking, less accurate landmarks.
- `ONE_EURO_POSE` / `ONE_EURO_GAZE` (`minCutoff`, `beta`, `dCutoff`): lower `minCutoff` = steadier but laggier; higher `beta` = less lag on fast moves.
- `MIN_FACE_HEIGHT_SHARE`, `CENTER_TOLERANCE`, `MIN_MEAN_LUMA`, `MAX_MEAN_LUMA`, `MIN_LUMA_STD`: setup check thresholds.
- `CALIB_CENTER_S`, `CALIB_EDGE_S`, `CALIB_SETTLE_S`, `CALIB_EDGE_SETTLE_S`: calibration timing.
- `DEFAULT_MASK_OPTIONS.headCover`, `headCoverHeight` (0.5 of face height), `headCoverWidth` (1.05): the hair cover.

In `analysis\common.py`: `EDGE_FACTOR`, `MIN_ENTER`, `EXIT_RATIO`, `THRESHOLDS_MODE`, `SPEED_PASS_FPS`, `SPEED_MIN_FPS`, head and eye thresholds and durations, hysteresis exit values, merge gap, gaze source, label matching slack, key window.

## Server analysis (integrity flags from one recorded session)

`poc\face-mask\server\` turns one session (masked video plus sidecar) into a list of integrity flags, `flags-<id>.json`. For now it runs on your laptop. It is written so it can later run as an AWS Lambda container image without a rewrite (no AWS code, Dockerfile or template exists yet).

### What it checks

| Flag | Source | How |
| --- | --- | --- |
| `phone_visible`, `book_visible`, `extra_laptop` | video | YOLO11 nano finds a cell phone, book or laptop box (confidence 0.40) in the masked video, sampled at 2 frames per second |
| `second_person` | video | more than one `person` box in a sampled frame |
| `camera_blocked` | video | no model: mean brightness below 25 or sharpness (variance of the Laplacian, frame scaled to 320 px wide) below 40 |
| `looking_away` | sidecar | the rule in `analysis\common.py` is imported, not copied: baseline-relative yaw or gaze, hysteresis, minimum durations (default gaze source blendshape, `fixed` thresholds) |
| `looking_away_while_typing` | sidecar | the main rule: a `looking_away` event with a key press during it or within 2 s |
| `tracking_lost` | sidecar | no face for at least 2 s. This is reported, not an accusation |

Every detection must last a minimum time (phone 1.5 s; book, extra laptop, second person, camera blocked, tracking lost 2.0 s; looking away 1.0 s for the head and 1.5 s for the eyes) and detections of the same type closer together than the join gap (1.5 s for objects, 1.0 s camera, 0.5 s sidecar types) are joined into one flag. All thresholds are constants in `server\analyzer\config.py`. The camera thresholds come from real clips: normal masked and raw frames measured brightness 84 to 158 and sharpness 400 to 800; a Gaussian blur of sigma 8 gives about 10 and flat noise about 7. **They have not been tried on a really covered or blurred camera yet.**

### Setup (PowerShell)

Two virtual environments, so the analyzer never needs torch:

```powershell
cd poc\face-mask\server
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements-dev.txt        # onnxruntime, numpy, opencv-headless, pytest

python -m venv .venv-export                                                 # only for the one-time model export
.\.venv-export\Scripts\python.exe -m pip install -r requirements-export.txt # ultralytics, torch (large download)
.\.venv-export\Scripts\python.exe scripts\export_model.py                   # downloads yolo11n.pt, writes models\yolo11n.onnx
```

`models\` is git-ignored (never commit model files). After the export you can delete `.venv-export`. The analyzer itself imports only `onnxruntime`, `numpy` and `opencv`, never `ultralytics` or `torch`, and runs on the CPU only.

**Licence warning:** YOLO11 and the Ultralytics package are licensed under **AGPL-3.0**. Check this with whoever owns the licence decision before the analyzer goes into a product (an Ultralytics enterprise licence or a permissively licensed detector are the usual ways out). The flags file records the model name, version, checksum and licence.

### Run the CLI

```powershell
cd poc\face-mask\server
.\.venv\Scripts\python.exe -m analyzer ..\recordings\masked-<id>.webm ..\recordings\sidecar-<id>.jsonl
```

It writes `flags-<id>.json` next to the sidecar (or into `--out <folder>`) and prints the flags and the timing. Options: `--no-objects` (camera and sidecar checks only, no model needed), `--thresholds fixed|calibrated` (default `fixed`), `--gaze-source iris|blend`, `--raw`, `--chunk-s 60`, `--model <path>`, `--threads N`.

The CLI decodes the video once and cuts it into 60-second chunks. For each chunk it writes only the sampled frames (2 per second, 640 px long side) to a lossless temp file, runs `analyze_chunk` on it, deletes the file, and at the end calls `merge_flags`. Tests: `.\.venv\Scripts\python.exe -m pytest tests -q`.

Try it without a camera (the example image is copied from the ultralytics package; it is not committed):

```powershell
Copy-Item .venv-export\Lib\site-packages\ultralytics\assets\zidane.jpg out\zidane.jpg    # create server\out first if missing
.\.venv\Scripts\python.exe scripts\make_synthetic_session.py out\synthetic
.\.venv\Scripts\python.exe -m analyzer out\synthetic\masked-synth_demo_20261105-120000.avi out\synthetic\sidecar-synth_demo_20261105-120000.jsonl
```

The synthetic session plants a covered camera (20-24 s), a blurred camera (30-34 s), a second person (50-70 s, across the chunk boundary at 60 s), a look-away with key presses (57-63 s) and a tracking-lost period (100-104 s). All are found.

### Test 5: raw versus masked

Does the mask hide things from the object and camera checks? Run it with the SERVER venv from `poc\face-mask`:

```powershell
server\.venv\Scripts\python.exe analysis\test5_raw_vs_masked.py recordings
```

For every session with both `raw-<id>` and `masked-<id>` videos (record with "Also save raw video" ticked) it runs the object and camera checks on both videos and compares the flags (same type, overlapping in time within 1 s). It prints, per session and overall, the flags found in both, only in raw and only in masked. **PASS if 90% or more of the raw flags are also found in the masked video.** If the raw videos give no flags at all it prints NO DATA and says it is not a pass: record the scenarios that should give flags (phone, second person, hand or paper over the camera). Videos whose names differ (for example `raw-<id>gpu.webm`) are not paired and are listed.

### Flag format (`flags-<id>.json`)

```json
{
  "session_id": "laptop_normal_20261105-092926",
  "analyzer_version": "0.1.0",
  "created": "2026-11-05T16:18:30+00:00",
  "model": {"name": "yolo11n", "version": "8.4.202", "file": "yolo11n.onnx", "sha256": "...", "runtime": "onnxruntime-cpu", "license": "AGPL-3.0", "classes_reported": ["person", "laptop", "cell phone", "book"]},
  "thresholds": {"sample_fps": 2.0, "object_confidence": 0.4, "min_duration_s": {}, "join_gap_s": {}, "camera_min_brightness": 25.0, "camera_min_sharpness": 40.0, "look_away": {}},
  "video": {"chunks": 3, "sample_fps": 2.0},
  "flags": [
    {"type": "second_person", "start_s": 50.0, "end_s": 70.0, "confidence": 0.85, "source": "video",
     "evidence": "more than one person box in 40 of 40 sampled frames"},
    {"type": "looking_away_while_typing", "start_s": 57.0, "end_s": 63.0, "confidence": 1.0, "source": "sidecar",
     "evidence": "key press during or within 2 s of the look-away"}
  ]
}
```

`confidence` is the mean detection score for objects, the share of sampled frames that were blocked for `camera_blocked`, and 1.0 for the rule-based sidecar flags (the rule was satisfied). Times are seconds on the session timeline (video time plus the recorder start offset from the sidecar header). The file holds numbers, labels and short texts only: no images and no faces, ever.

### How it fits Lambda later

- `analyze_chunk(video_path, sidecar_frames, chunk_start_s, keys_s=..., header=..., options=...)` analyzes ONE chunk: `video_path` is the clip of that chunk (time 0 of the clip = `chunk_start_s` of the session), `sidecar_frames` are the sidecar `frame` lines of the chunk, `keys_s` the key-press times (include presses up to 2 s outside the chunk). It returns flags in an intermediate format. A detection that is too short but touches the first or last sample of the chunk is kept, because it may continue in the neighbouring chunk.
- `merge_flags(list_of_chunk_flag_lists)` joins flags across chunk boundaries, sums the evidence counts, stretches a typing flag to the whole look-away, applies the minimum durations and returns the final flags. Always run it, even with one chunk.
- No global state: everything is passed in. The only cache is the loaded model (`load_detector`), reused across calls like a Lambda warm start. CPU only; `--threads` maps to onnxruntime threads.
- `analysis\common.py` must be next to the package or on `PYTHONPATH` in the image (it only uses the standard library). On the laptop it is found automatically.
- Timing measured on this laptop (12 cores, CPU only, no GPU), seconds of work per minute of video:

  | Recording | Settings | Decode and sample | analyze_chunk | Total |
  | --- | --- | --- | --- | --- |
  | real 54 s, 1280x720 webm | default threads | 7.0 | 8.0 | 15.1 |
  | real 54 s, 1280x720 webm | 1 onnxruntime thread | 7.1 | 14.4 | 21.5 |
  | synthetic 150 s, 3 chunks, 640x360 | default threads | 1.3 | 7.3 | 8.6 |

  YOLO11 nano takes about 65 ms per sampled frame here, so a 60 s chunk (120 frames) needs about 8 s of model time. Even with one thread a 60 s chunk takes well under a minute, so 15 minutes of Lambda time is far more than a one-chunk invocation needs. Lambda vCPUs are slower than this laptop and this was not run on Lambda, so measure again there before relying on the numbers.

### Debugging: why did a clip give no flags?

Run the debug script on the clip (raw or masked) before blaming the detector:

```powershell
cd poc\face-mask\server
.\.venv\Scripts\python.exe scripts\debug_detections.py ..\recordings\raw-<id>.webm
```

For every sampled frame it prints the time, brightness, sharpness and ALL YOLO boxes (every COCO class, score 0.10 or more), saves 10 frames with the boxes drawn to `server\out\debug\<video name>\`, and ends with a summary (best score per class, how many frames were dark or blurred). Look at the saved frames: if the phone is not in the image, or the paper is not on the lens (brightness stays near its normal value and sharpness stays in the hundreds), there is nothing to detect and zero flags is the right answer. When recording test clips: hold the phone clearly in front of the camera, upright and fully in view, for at least 3 s; press the paper flat against the lens for at least 3 s.

The detector path was checked against the reference Ultralytics PyTorch model on 49 public COCO images (`scripts\fetch_test_image.py` downloads the one phone image the tests use): identical person, laptop, phone and book counts on 43 of 49 images, and the other 6 differ by one borderline box. `tests\test_pipeline_regression.py` guards colour order, letterbox and scale maths, class ids, the sampling rate, and a real phone through the whole path.

### Settings worth tuning

`server\analyzer\config.py`: `OBJECT_CONF`, `SAMPLE_FPS`, `CAMERA_MIN_BRIGHTNESS`, `CAMERA_MIN_SHARPNESS`, `MIN_DURATION_S`, `JOIN_GAP_S`, `CLASSES`. The look-away rule stays in `analysis\common.py`.
