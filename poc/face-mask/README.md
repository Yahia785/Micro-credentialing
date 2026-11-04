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

`frame` lines: `t` (ms since recording start), `faces`, `lost`, `yaw`, `pitch`, `roll` (deg), `gazeH`, `gazeV` ([-1,1]), `procMs`. `key` lines hold the **time only, never the key**. Readings are for the first face; `null` when tracking is lost.

Sign conventions: `yaw > 0` = face turns toward the right side of the image (your own left, the image is not mirrored); `pitch > 0` = looking down; `gazeH > 0` = iris toward image right; `gazeV > 0` = iris low.

Chrome may ask "Allow this site to download multiple files": click Allow, otherwise only the first file saves.

## Run it (PowerShell, from the repo root)

```powershell
git branch --show-current        # must print feature/privacy-mask
cd poc\face-mask\client
npm install                      # also copies the WASM runtime to public\wasm (no CDN)
npm run get-model                # downloads face_landmarker.task (float16) into public\models
npm run dev                      # http://localhost:5180
```

Open http://localhost:5180 in Chrome and allow camera and microphone. Press **Start camera**, then **Start recording**, then **Stop and save**.

Other commands (in `poc\face-mask\client`): `npm run build` (type-check and bundle), `npm test` (unit tests for pose, gaze, mask geometry, fps stats).

### Analysis setup

```powershell
cd poc\face-mask\analysis
python -m venv ..\.venv
..\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
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
| 1 speed | average fps, 10th-percentile fps, % lost frames, ms per frame | average fps >= 15 on every recording (check the low-end laptop especially) |
| 2 leaks | OpenCV Haar frontal and profile (profile also on the mirrored frame) on every frame of `masked-*.webm`. Flagged frames go to `analysis\out\leaks\<recording>\` plus `summary.csv` | **No real face visible in any flagged frame, checked by eye.** A flag is only a candidate: the cartoon mask can fool a detector (the synthetic demo flags every frame). Also glance through unflagged frames of hand-over-face, fast-motion and leave-frame |
| 3 look-away | sidecar events vs your labels: labels, found, extra events, events with a key press within 2 s | 90% or more of all labels are found |
| 4 identity (manual) | see below | people do no better than chance |

Look-away rule (constants at the top of `analysis\common.py`): `|yaw| > 25` degrees or `|gazeH| > 0.5`, lasting at least 1.0 s, merging gaps under 0.5 s. Tracking-lost frames never count as looking away; they are reported separately (`lost s`).

Every script exits with a clear message when the folder has no matching files.

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

In `analysis\common.py`: look-away thresholds, minimum duration, merge gap, label matching slack, key window.
