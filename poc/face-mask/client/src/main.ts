import { buildCalibration, type CalibrationResult, type CalibrationSample } from "./calibration";
import {
  CALIB_CENTER_S,
  CALIB_EDGE_S,
  CALIB_MIN_EDGE_SAMPLES,
  CALIB_MIN_SAMPLES,
  CALIB_EDGE_SETTLE_S,
  CALIB_SETTLE_S,
  CAMERA_HEIGHT,
  CAMERA_WIDTH,
  DEFAULT_MASK_OPTIONS,
  DETECT_LONG_SIDE,
  DETECT_SIZES,
  SWEEP_S,
  SWEEP_WARMUP_S,
  GUIDE_HEIGHT_SHARE,
  SCENARIOS,
  SETUP_CHECK_INTERVAL_MS,
  type MaskOptions,
} from "./config";
import { drawFaceMask, drawLostBanner, drawPixelated } from "./mask";
import { BLENDSHAPE_KEYS, blendshapeGazeH, gazeFromLandmarks, headPoseFromMatrix, irisOffsets } from "./math";
import { RecordingSession, safe, timestamp, type FrameRecord } from "./recorder";
import { evaluateSetup, faceBoxFromLandmarks, lumaStats, type Check } from "./setup";
import { IrisOffsetSmoother, ReadingSmoother, type Readings } from "./smoothing";
import { SWEEP_PLAN, speedLabel, summarizeSweep, unavailable, type SweepResult, type SweepSample } from "./sweep";
import { Tracker, type DelegateRequest } from "./tracker";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const out = $<HTMLCanvasElement>("out");
const outCtx = out.getContext("2d")!;
const laptopEl = $<HTMLInputElement>("laptop");
const scenarioEl = $<HTMLSelectElement>("scenario");
const saveRawEl = $<HTMLInputElement>("saveRaw");
const headCoverEl = $<HTMLInputElement>("headCover");
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
headCoverEl.checked = maskOptions.headCover;
headCoverEl.addEventListener("change", () => {
  if (!session) maskOptions.headCover = headCoverEl.checked;
  else headCoverEl.checked = maskOptions.headCover; // fixed while recording
});

// The raw camera element is hidden (see CSS) and its pixels are only ever copied to the snapshot canvas.
const video = document.createElement("video");
video.id = "rawVideo";
video.muted = true;
video.playsInline = true;
document.body.appendChild(video);

const snap = document.createElement("canvas"); // full-size snapshot: the single source for tracking AND drawing
const snapCtx = snap.getContext("2d")!;
const detectCanvas = document.createElement("canvas"); // downscaled copy of the snapshot, tracking only
const detectCtx = detectCanvas.getContext("2d")!;
const lumaCanvas = document.createElement("canvas");
lumaCanvas.width = lumaCanvas.height = 48;
const lumaCtx = lumaCanvas.getContext("2d", { willReadFrequently: true })!;

type Phase = "idle" | "setup" | "calibrate" | "ready" | "recording";
let phase: Phase = "idle";
let tracker: Tracker | null = null;
let stream: MediaStream | null = null;
let session: RecordingSession | null = null;
let stopping = false;

// Tracking options: URL parameters ?delegate=cpu|gpu&detect=320|480|640, also dropdowns on the setup screen.
const params = new URLSearchParams(location.search);
const delegateParam = params.get("delegate")?.toLowerCase();
let requestedDelegate: DelegateRequest = delegateParam === "cpu" || delegateParam === "gpu" ? delegateParam : "auto";
const detectParam = Number(params.get("detect"));
let detectLongSide = DETECT_SIZES.includes(detectParam) ? detectParam : DETECT_LONG_SIDE;
let busy = false; // true while the speed test runs
let sweepBuf: SweepSample[] | null = null;
let sweepStart = 0;

const smoother = new ReadingSmoother();
const irisSmoother = new IrisOffsetSmoother();

// setup + calibration state
let latestChecks: Check[] = [];
let lastSetupAt = 0;
let setupInfo: unknown = null;
let calibration: CalibrationResult | null = null;
let calibActive = false;
let calibStart = 0;
let calibSettleS = CALIB_SETTLE_S;
let calibBuf: CalibrationSample[] = [];

// live stats
const recentTimes: number[] = [];
let totalFrames = 0;
let lostFrames = 0;
let lastUi = 0;
const live = { faces: 0, lost: false, yaw: NaN, pitch: NaN, gazeH: NaN, gazeV: NaN, blendH: NaN, fps: 0 };

function setText(id: string, text: string, cls = "") {
  const el = $(id);
  el.textContent = text;
  el.className = cls;
}

const nz = (v: number | null) => (v === null ? NaN : v);

function setPhase(p: Phase) {
  phase = p;
  $("setupBox").hidden = p !== "setup";
  $("calibBox").hidden = p !== "calibrate";
  $("btnRecal").hidden = p !== "ready";
  btnCamera.disabled = p !== "idle";
  btnRecord.disabled = p !== "ready";
  btnStop.disabled = p !== "recording";
  const names: Record<Phase, string> = {
    idle: "Press Start camera",
    setup: "Step 1: setup check",
    calibrate: "Step 2: calibration",
    ready: "Ready to record",
    recording: "Recording",
  };
  setText("vPhase", names[p]);
}

function lumaOf(box: { x: number; y: number; w: number; h: number }, w: number, h: number) {
  const sx = Math.max(0, box.x * w);
  const sy = Math.max(0, box.y * h);
  const sw = Math.max(1, Math.min(w - sx, box.w * w));
  const sh = Math.max(1, Math.min(h - sy, box.h * h));
  lumaCtx.drawImage(snap, sx, sy, sw, sh, 0, 0, 48, 48);
  return lumaStats(lumaCtx.getImageData(0, 0, 48, 48).data);
}

function renderChecklist(checks: Check[]) {
  const ul = $("checklist");
  ul.replaceChildren(
    ...checks.map((c) => {
      const li = document.createElement("li");
      li.className = c.ok ? "ok" : "bad";
      li.textContent = `${c.ok ? "✔" : "✖"} ${c.label}: ${c.detail}`;
      return li;
    }),
  );
  $<HTMLButtonElement>("btnContinue").disabled = busy || !checks.every((c) => c.ok);
}

function drawGuide(w: number, h: number) {
  const gh = GUIDE_HEIGHT_SHARE * h;
  const gw = gh * 0.8;
  outCtx.save();
  outCtx.setLineDash([12, 8]);
  outCtx.lineWidth = 3;
  outCtx.strokeStyle = latestChecks.length && latestChecks.every((c) => c.ok) ? "#2ecc71" : "#f1c40f";
  outCtx.strokeRect((w - gw) / 2, (h - gh) / 2, gw, gh);
  outCtx.restore();
}

function processFrame(): void {
  if (!tracker || video.readyState < 2) return;
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (w === 0 || h === 0) return;
  const t0 = performance.now();

  // 1. Snapshot: freeze this exact camera frame at full size.
  if (snap.width !== w || snap.height !== h) {
    snap.width = w;
    snap.height = h;
  }
  if (out.width !== w || out.height !== h) {
    out.width = w;
    out.height = h;
  }
  snapCtx.drawImage(video, 0, 0, w, h);
  const t1 = performance.now();

  // 2. Track on a DOWNSCALED copy of the same snapshot (landmarks are normalised, so they map straight back).
  //    Any error counts as "no face" (fail closed).
  let src: HTMLCanvasElement = snap;
  const scale = Math.min(1, detectLongSide / Math.max(w, h));
  if (scale < 1) {
    const dw = Math.round(w * scale);
    const dh = Math.round(h * scale);
    if (detectCanvas.width !== dw || detectCanvas.height !== dh) {
      detectCanvas.width = dw;
      detectCanvas.height = dh;
    }
    detectCtx.drawImage(snap, 0, 0, dw, dh);
    src = detectCanvas;
  }
  let faces: { x: number; y: number; z: number }[][] = [];
  let matrices: ArrayLike<number>[] = [];
  let blendshapes: Record<string, number> | null = null;
  try {
    const res = tracker.detect(src);
    faces = res.faceLandmarks;
    matrices = res.facialTransformationMatrixes.map((m) => m.data);
    const cats = res.faceBlendshapes?.[0]?.categories;
    if (cats) blendshapes = Object.fromEntries(cats.map((c) => [c.categoryName, c.score]));
  } catch (e) {
    console.warn("detect failed", e);
  }
  const t2 = performance.now();

  // 3. Draw at full size from the SAME full snapshot, so the mask cannot lag the face.
  const lost = faces.length === 0;
  const maskBoxes: [number, number, number, number][] = [];
  if (lost) {
    drawPixelated(outCtx, snap, w, h, maskOptions.pixelBlockSize);
    drawLostBanner(outCtx, w, h);
    smoother.reset();
    for (let i = 0; i < 2; i++) irisSmoother.resetFace(i);
  } else {
    outCtx.drawImage(snap, 0, 0, w, h);
    faces.forEach((lm, i) => {
      const box = drawFaceMask(outCtx, lm, w, h, maskOptions, irisSmoother.smooth(i, irisOffsets(lm, w, h), t0));
      if (box) maskBoxes.push(box);
    });
    for (let i = faces.length; i < 2; i++) irisSmoother.resetFace(i);
  }
  if (phase === "setup") drawGuide(w, h);
  const t3 = performance.now();

  // Readings (first face only): raw, then smoothed.
  const raw: Readings = { yaw: null, pitch: null, gazeH: null, gazeV: null, blendH: null };
  let roll: number | null = null;
  if (!lost) {
    if (matrices[0]) {
      const p = headPoseFromMatrix(matrices[0]);
      raw.yaw = p.yaw;
      raw.pitch = p.pitch;
      roll = p.roll;
    }
    const g = gazeFromLandmarks(faces[0], w, h);
    if (g) {
      raw.gazeH = g.h;
      raw.gazeV = g.v;
    }
    if (blendshapes) raw.blendH = blendshapeGazeH(blendshapes);
  }
  const sm = lost ? raw : smoother.apply(raw, t0);

  const now = performance.now();
  totalFrames++;
  if (lost) lostFrames++;
  recentTimes.push(now);
  if (recentTimes.length > 30) recentTimes.shift();
  if (recentTimes.length > 1) {
    live.fps = ((recentTimes.length - 1) * 1000) / (recentTimes[recentTimes.length - 1] - recentTimes[0]);
  }
  Object.assign(live, {
    faces: faces.length, lost,
    yaw: nz(sm.yaw), pitch: nz(sm.pitch), gazeH: nz(sm.gazeH), gazeV: nz(sm.gazeV), blendH: nz(sm.blendH),
  });

  // Setup check (a few times per second, only before calibration).
  if (phase === "setup" && now - lastSetupAt > SETUP_CHECK_INTERVAL_MS) {
    lastSetupAt = now;
    const box = faces[0] ? faceBoxFromLandmarks(faces[0]) : null;
    latestChecks = evaluateSetup(box, box ? lumaOf(box, w, h) : null);
    renderChecklist(latestChecks);
  }

  // Calibration samples.
  if (sweepBuf && now >= sweepStart) {
    sweepBuf.push({
      t: now, lost, detectMs: t2 - t1,
      yawRaw: raw.yaw, yaw: sm.yaw, gazeHRaw: raw.gazeH, gazeH: sm.gazeH, blendHRaw: raw.blendH, blendH: sm.blendH,
    });
  }
  if (calibActive && !lost && now - calibStart >= calibSettleS * 1000) {
    calibBuf.push({ s: sm, r: raw });
  }

  if (session && !stopping) {
    const bs: Record<string, number | null> = {};
    for (const k of BLENDSHAPE_KEYS) bs[k] = lost || !blendshapes ? null : (blendshapes[k] ?? null);
    const rec: FrameRecord = {
      t: session.now(), faces: faces.length, lost,
      yawRaw: raw.yaw, yaw: sm.yaw, pitchRaw: raw.pitch, pitch: sm.pitch, roll,
      gazeHRaw: raw.gazeH, gazeH: sm.gazeH, gazeVRaw: raw.gazeV, gazeV: sm.gazeV,
      blendHRaw: raw.blendH, blendH: sm.blendH, bs,
      snapMs: t1 - t0, detectMs: t2 - t1, drawMs: t3 - t2, procMs: now - t0, maskBoxes,
    };
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
  setText("vBlend", f(live.blendH, 2));
  if (live.lost) setText("vStatus", "TRACKING LOST", "warn");
  else setText("vStatus", session ? "recording" : "tracking", "ok");
  const badge = $("badge");
  const slow = live.fps > 0 && live.fps < 15;
  badge.textContent = `${tracker?.delegate ?? "-"}  ·  ${f(live.fps)} fps${slow ? "  (slow: below 15)" : ""}`;
  badge.className = slow ? "badge slow" : "badge";
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
    tracker ??= await Tracker.create(requestedDelegate);
    showDelegate();
    setText("vStatus", "starting camera...");
    stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: CAMERA_WIDTH }, height: { ideal: CAMERA_HEIGHT } },
      audio: true,
    });
    video.srcObject = stream;
    await video.play();
    setPhase("setup");
    pump();
  } catch (e) {
    console.error(e);
    setText("vStatus", "error: " + (e instanceof Error ? e.message : String(e)) + " (did you run npm run get-model?)", "warn");
    setPhase("idle");
  }
});

// ---- Step 1: setup check --------------------------------------------------------------
function continueFromSetup(anyway: boolean) {
  const failed = latestChecks.filter((c) => !c.ok).map((c) => c.id);
  setupInfo = {
    passed: failed.length === 0 && latestChecks.length > 0,
    continuedAnyway: anyway,
    failedChecks: failed.length === 0 && latestChecks.length === 0 ? ["not-checked"] : failed,
    checks: latestChecks.map((c) => ({ id: c.id, ok: c.ok, detail: c.detail })),
  };
  setText("calibMsg", "");
  setPhase("calibrate");
}
$("btnContinue").addEventListener("click", () => continueFromSetup(false));
$("btnContinueAnyway").addEventListener("click", () => continueFromSetup(true));

// ---- Step 2: calibration --------------------------------------------------------------
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function runCalibration() {
  $<HTMLButtonElement>("btnCalibrate").disabled = true;
  const overlay = $("overlay");
  const dot = $("dot");
  overlay.hidden = false;
  const stages = [
    { name: "center", s: CALIB_CENTER_S, settle: CALIB_SETTLE_S, x: 50, text: "Look at the dot in the middle of the screen" },
    { name: "left", s: CALIB_EDGE_S, settle: CALIB_EDGE_SETTLE_S, x: 3, text: "Now look at the dot at the LEFT edge" },
    { name: "right", s: CALIB_EDGE_S, settle: CALIB_EDGE_SETTLE_S, x: 97, text: "Now look at the dot at the RIGHT edge" },
  ];
  const bufs: Record<string, CalibrationSample[]> = { center: [], left: [], right: [] };
  for (const st of stages) {
    dot.style.left = st.x + "%";
    $("overlayText").textContent = st.text;
    calibBuf = bufs[st.name];
    calibStart = performance.now();
    calibSettleS = st.settle;
    calibActive = true;
    await sleep(st.s * 1000);
    calibActive = false;
  }
  overlay.hidden = true;
  $<HTMLButtonElement>("btnCalibrate").disabled = false;
  if (bufs.center.length < CALIB_MIN_SAMPLES || bufs.left.length < CALIB_MIN_EDGE_SAMPLES || bufs.right.length < CALIB_MIN_EDGE_SAMPLES) {
    setText(
      "calibMsg",
      `Not enough face data (${bufs.center.length}/${bufs.left.length}/${bufs.right.length} samples). Keep your face in view and try again.`,
      "warn",
    );
    return;
  }
  calibration = buildCalibration(bufs.center, bufs.left, bufs.right);
  const b = calibration.baseline;
  const fx = (v: number | null, d = 2) => (v === null ? "-" : v.toFixed(d));
  setText(
    "vCal",
    `yaw ${fx(b.yaw, 1)}°, gaze ${fx(b.gazeH)} (noise ${fx(calibration.noise.gazeH)}); edges L ${fx(calibration.edges.left.gazeH)} / R ${fx(calibration.edges.right.gazeH)}`,
  );
  setPhase("ready");
}
$("btnCalibrate").addEventListener("click", () => void runCalibration());
$("btnRecal").addEventListener("click", () => {
  calibration = null;
  setText("calibMsg", "");
  setPhase("calibrate");
});

// ---- Recording --------------------------------------------------------------------------
btnRecord.addEventListener("click", () => {
  if (!stream || !tracker || !calibration) return;
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
      detectLongSide,
      delegateRequested: requestedDelegate,
      maskOptions: { ...maskOptions },
      setup: setupInfo,
      calibration,
    },
    out,
    stream,
    saveRawEl.checked,
  );
  setPhase("recording");
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
  setPhase("ready");
  laptopEl.disabled = scenarioEl.disabled = saveRawEl.disabled = false;
});

// Key presses: only the TIME is recorded, and only while recording. The key itself is never read.
typingEl.addEventListener("keydown", () => {
  if (session && !stopping) session.addKey();
});


// ---- Tracking options (dropdowns) and speed test ------------------------------------------
const selDelegate = $<HTMLSelectElement>("selDelegate");
const selDetect = $<HTMLSelectElement>("selDetect");
for (const d of DETECT_SIZES) selDetect.add(new Option(`${d} px`, String(d)));
selDelegate.value = requestedDelegate;
selDetect.value = String(detectLongSide);

function showDelegate() {
  if (!tracker) return;
  setText("vDelegate", `${tracker.delegate} (asked: ${requestedDelegate}), detect ${detectLongSide} px`, tracker.delegate === "CPU" ? "warn" : "ok");
}

/** Recreate the landmarker with another delegate (the old one is closed first). */
async function switchDelegate(req: DelegateRequest): Promise<void> {
  const old = tracker;
  tracker = null; // processFrame idles while there is no tracker
  old?.close();
  requestedDelegate = req;
  try {
    tracker = await Tracker.create(req);
  } catch (e) {
    requestedDelegate = "cpu";
    tracker = await Tracker.create("cpu"); // always leave a working tracker behind
    showDelegate();
    throw e;
  }
  showDelegate();
}

selDelegate.addEventListener("change", async () => {
  if (!tracker || busy) return;
  selDelegate.disabled = true;
  try {
    await switchDelegate(selDelegate.value as DelegateRequest);
  } catch (e) {
    setText("speedMsg", e instanceof Error ? e.message : String(e), "warn");
    selDelegate.value = "cpu";
  }
  selDelegate.disabled = false;
});
selDetect.addEventListener("change", () => {
  detectLongSide = Number(selDetect.value);
  showDelegate();
});

let cancelSweep = false;
const fx = (v: number | null, d = 1) => (v === null || Number.isNaN(v) ? "-" : v.toFixed(d));

function renderSweep(results: SweepResult[]) {
  const table = $<HTMLTableElement>("speedTable");
  table.hidden = false;
  const head = ["Delegate", "Detect", "Avg fps", "p10 fps", "Detect ms", "Lost", "std yaw raw/sm", "std gazeH raw/sm", "std blendH raw/sm", "Speed"];
  const rows = results.map((r) => {
    const label = r.available ? speedLabel(r.avgFps) : "n/a";
    return [
      r.delegate, `${r.detect}`, fx(r.avgFps), fx(r.p10Fps), fx(r.meanDetectMs), r.available ? String(r.lostFrames) : "-",
      `${fx(r.std.yawRaw, 2)} / ${fx(r.std.yaw, 2)}`, `${fx(r.std.gazeHRaw, 3)} / ${fx(r.std.gazeH, 3)}`,
      `${fx(r.std.blendHRaw, 3)} / ${fx(r.std.blendH, 3)}`, r.available ? label : (r.note ?? "n/a"),
    ];
  });
  const mk = (cells: string[], tag: "th" | "td") => {
    const tr = document.createElement("tr");
    for (const c of cells) {
      const td = document.createElement(tag);
      td.textContent = c;
      if (c === "PASS") td.className = "ok";
      else if (c === "FAIL") td.className = "warn";
      tr.appendChild(td);
    }
    return tr;
  };
  table.replaceChildren(mk(head, "th"), ...rows.map((r) => mk(r, "td")));
}

function downloadJson(name: string, data: unknown) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

async function runSpeedTest() {
  if (!tracker || busy) return;
  busy = true;
  cancelSweep = false;
  const ctrl = ["btnSpeed", "btnContinue", "btnContinueAnyway"].map((id) => $<HTMLButtonElement>(id));
  ctrl.forEach((b) => (b.disabled = true));
  selDelegate.disabled = selDetect.disabled = true;
  $("btnCancelSpeed").hidden = false;
  const origReq = requestedDelegate;
  const origDetect = detectLongSide;
  const results: SweepResult[] = [];
  for (const [i, combo] of SWEEP_PLAN.entries()) {
    if (cancelSweep) break;
    setText("speedMsg", `Speed test ${i + 1}/${SWEEP_PLAN.length}: ${combo.delegate}, ${combo.detect} px. Sit still and look at the screen.`);
    try {
      await switchDelegate(combo.delegate === "GPU" ? "gpu" : "cpu");
    } catch (e) {
      results.push(unavailable(combo.delegate, combo.detect, "GPU not available"));
      renderSweep(results);
      console.warn(e);
      continue;
    }
    detectLongSide = combo.detect;
    smoother.reset();
    for (let k = 0; k < 2; k++) irisSmoother.resetFace(k);
    sweepBuf = [];
    sweepStart = performance.now() + SWEEP_WARMUP_S * 1000;
    const end = sweepStart + SWEEP_S * 1000;
    while (performance.now() < end && !cancelSweep) await sleep(200);
    const samples = sweepBuf;
    sweepBuf = null;
    if (cancelSweep) break;
    results.push(summarizeSweep(combo.delegate, combo.detect, samples));
    renderSweep(results);
  }
  // put the original choice back
  try {
    await switchDelegate(origReq);
  } catch (e) {
    console.warn(e);
  }
  detectLongSide = origDetect;
  selDelegate.value = requestedDelegate;
  selDetect.value = String(detectLongSide);
  showDelegate();
  const laptop = safe(laptopEl.value || "laptop");
  if (results.length > 0) {
    downloadJson(`speedtest-${laptop}-${timestamp(new Date())}.json`, {
      laptop: laptopEl.value || "laptop",
      time: new Date().toISOString(),
      userAgent: navigator.userAgent,
      width: video.videoWidth,
      height: video.videoHeight,
      measuredSeconds: SWEEP_S,
      cancelled: cancelSweep,
      results,
    });
  }
  setText("speedMsg", cancelSweep ? "Speed test cancelled (partial results saved)." : "Speed test done. Results saved to Downloads as speedtest-*.json.", cancelSweep ? "warn" : "ok");
  busy = false;
  $("btnCancelSpeed").hidden = true;
  $<HTMLButtonElement>("btnSpeed").disabled = false;
  $<HTMLButtonElement>("btnContinueAnyway").disabled = false;
  selDelegate.disabled = selDetect.disabled = false;
  renderChecklist(latestChecks);
}
$("btnSpeed").addEventListener("click", () => void runSpeedTest());
$("btnCancelSpeed").addEventListener("click", () => (cancelSweep = true));

setPhase("idle");
