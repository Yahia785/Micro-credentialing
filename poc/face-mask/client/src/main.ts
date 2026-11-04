import { CAMERA_HEIGHT, CAMERA_WIDTH, DEFAULT_MASK_OPTIONS, SCENARIOS, type MaskOptions } from "./config";
import { drawFaceMask, drawLostBanner, drawPixelated } from "./mask";
import { gazeFromLandmarks, headPoseFromMatrix } from "./math";
import { RecordingSession, type FrameRecord } from "./recorder";
import { Tracker } from "./tracker";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const out = $<HTMLCanvasElement>("out");
const outCtx = out.getContext("2d")!;
const laptopEl = $<HTMLInputElement>("laptop");
const scenarioEl = $<HTMLSelectElement>("scenario");
const saveRawEl = $<HTMLInputElement>("saveRaw");
const btnCamera = $<HTMLButtonElement>("btnCamera");
const btnRecord = $<HTMLButtonElement>("btnRecord");
const btnStop = $<HTMLButtonElement>("btnStop");
const typingEl = $<HTMLTextAreaElement>("typing");

for (const s of SCENARIOS) scenarioEl.add(new Option(s, s));
try {
  laptopEl.value = localStorage.getItem("laptop") ?? "";
} catch {
  /* storage may be blocked: ignore */
}

const maskOptions: MaskOptions = { ...DEFAULT_MASK_OPTIONS };

// The raw camera element is hidden (see CSS) and its pixels are only ever copied to the snapshot canvas.
const video = document.createElement("video");
video.id = "rawVideo";
video.muted = true;
video.playsInline = true;
document.body.appendChild(video);

const snap = document.createElement("canvas");
const snapCtx = snap.getContext("2d", { willReadFrequently: false })!;

let tracker: Tracker | null = null;
let stream: MediaStream | null = null;
let session: RecordingSession | null = null;
let stopping = false;

// live stats
const recentTimes: number[] = [];
let totalFrames = 0;
let lostFrames = 0;
let lastUi = 0;
const live = { faces: 0, lost: false, yaw: NaN, pitch: NaN, gazeH: NaN, gazeV: NaN, fps: 0 };

function setText(id: string, text: string, cls = "") {
  const el = $(id);
  el.textContent = text;
  el.className = cls;
}

function processFrame(): void {
  if (!tracker || video.readyState < 2) return;
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (w === 0 || h === 0) return;
  const t0 = performance.now();

  // 1. Snapshot: freeze this exact camera frame.
  if (snap.width !== w || snap.height !== h) {
    snap.width = w;
    snap.height = h;
  }
  if (out.width !== w || out.height !== h) {
    out.width = w;
    out.height = h;
  }
  snapCtx.drawImage(video, 0, 0, w, h);

  // 2. Track on the snapshot. Any error counts as "no face" (fail closed).
  let faces: { x: number; y: number; z: number }[][] = [];
  let matrices: ArrayLike<number>[] = [];
  try {
    const res = tracker.detect(snap);
    faces = res.faceLandmarks;
    matrices = res.facialTransformationMatrixes.map((m) => m.data);
  } catch (e) {
    console.warn("detect failed", e);
  }

  // 3. Draw from the SAME snapshot, so the mask cannot lag the face.
  const lost = faces.length === 0;
  const maskBoxes: [number, number, number, number][] = [];
  if (lost) {
    drawPixelated(outCtx, snap, w, h, maskOptions.pixelBlockSize);
    drawLostBanner(outCtx, w, h);
  } else {
    outCtx.drawImage(snap, 0, 0, w, h);
    for (const lm of faces) {
      const box = drawFaceMask(outCtx, lm, w, h, maskOptions);
      if (box) maskBoxes.push(box);
    }
  }

  // Readings (first face only).
  let yaw: number | null = null;
  let pitch: number | null = null;
  let roll: number | null = null;
  let gazeH: number | null = null;
  let gazeV: number | null = null;
  if (!lost) {
    if (matrices[0]) {
      const p = headPoseFromMatrix(matrices[0]);
      yaw = p.yaw;
      pitch = p.pitch;
      roll = p.roll;
    }
    const g = gazeFromLandmarks(faces[0], w, h);
    if (g) {
      gazeH = g.h;
      gazeV = g.v;
    }
  }
  const now = performance.now();
  const procMs = now - t0;

  totalFrames++;
  if (lost) lostFrames++;
  recentTimes.push(now);
  if (recentTimes.length > 30) recentTimes.shift();
  if (recentTimes.length > 1) {
    live.fps = ((recentTimes.length - 1) * 1000) / (recentTimes[recentTimes.length - 1] - recentTimes[0]);
  }
  Object.assign(live, { faces: faces.length, lost, yaw: yaw ?? NaN, pitch: pitch ?? NaN, gazeH: gazeH ?? NaN, gazeV: gazeV ?? NaN });

  if (session && !stopping) {
    const rec: FrameRecord = { t: session.now(), faces: faces.length, lost, yaw, pitch, roll, gazeH, gazeV, procMs, maskBoxes };
    session.addFrame(rec);
  }

  if (now - lastUi > 250) {
    lastUi = now;
    updatePanel();
  }
}

function updatePanel() {
  const f = (v: number, d = 1) => (Number.isNaN(v) ? "-" : v.toFixed(d));
  setText("vFps", f(live.fps));
  setText("vLost", totalFrames ? ((100 * lostFrames) / totalFrames).toFixed(1) + " %" : "-");
  setText("vFaces", String(live.faces));
  setText("vPose", `${f(live.yaw, 0)}° / ${f(live.pitch, 0)}°`);
  setText("vGaze", `${f(live.gazeH, 2)} / ${f(live.gazeV, 2)}`);
  if (live.lost) setText("vStatus", "TRACKING LOST", "warn");
  else setText("vStatus", session ? "recording" : "tracking", "ok");
}

// Frame pump: requestVideoFrameCallback when available, else requestAnimationFrame.
function pump() {
  const next = () => {
    try {
      processFrame();
    } catch (e) {
      console.error(e);
    }
    schedule();
  };
  const schedule = () => {
    if (!stream) return;
    if ("requestVideoFrameCallback" in video) video.requestVideoFrameCallback(next);
    else requestAnimationFrame(next);
  };
  schedule();
}

btnCamera.addEventListener("click", async () => {
  btnCamera.disabled = true;
  try {
    setText("vStatus", "loading model...");
    tracker ??= await Tracker.create();
    setText("vDelegate", tracker.delegate);
    setText("vStatus", "starting camera...");
    stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: CAMERA_WIDTH }, height: { ideal: CAMERA_HEIGHT } },
      audio: true,
    });
    video.srcObject = stream;
    await video.play();
    btnRecord.disabled = false;
    pump();
  } catch (e) {
    console.error(e);
    setText("vStatus", "error: " + (e instanceof Error ? e.message : String(e)) + " (did you run npm run get-model?)", "warn");
    btnCamera.disabled = false;
  }
});

btnRecord.addEventListener("click", () => {
  if (!stream || !tracker) return;
  try {
    localStorage.setItem("laptop", laptopEl.value);
  } catch {
    /* ignore */
  }
  session = new RecordingSession(
    {
      laptop: laptopEl.value || "laptop",
      scenario: scenarioEl.value,
      width: video.videoWidth,
      height: video.videoHeight,
      delegate: tracker.delegate,
      maskOptions,
    },
    out,
    stream,
    saveRawEl.checked,
  );
  btnRecord.disabled = true;
  btnStop.disabled = false;
  laptopEl.disabled = scenarioEl.disabled = saveRawEl.disabled = true;
  setText("vRec", session.id);
});

btnStop.addEventListener("click", async () => {
  if (!session) return;
  stopping = true;
  btnStop.disabled = true;
  setText("vStatus", "saving...");
  const s = session;
  try {
    await s.stopAndDownload();
    setText("vRec", "saved " + s.id);
  } catch (e) {
    console.error(e);
    setText("vRec", "save failed: " + (e instanceof Error ? e.message : String(e)), "warn");
  }
  session = null;
  stopping = false;
  btnRecord.disabled = false;
  laptopEl.disabled = scenarioEl.disabled = saveRawEl.disabled = false;
});

// Key presses: only the TIME is recorded, and only while recording. The key itself is never read.
typingEl.addEventListener("keydown", () => {
  if (session && !stopping) session.addKey();
});
