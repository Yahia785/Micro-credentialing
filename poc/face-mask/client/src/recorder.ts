import { CAPTURE_FPS, type MaskOptions } from "./config";
import { summarize } from "./math";

export interface FrameRecord {
  t: number;
  faces: number;
  lost: boolean;
  /** Raw readings come straight from the tracker; the others are One Euro smoothed. */
  yawRaw: number | null;
  yaw: number | null;
  pitchRaw: number | null;
  pitch: number | null;
  roll: number | null;
  gazeHRaw: number | null;
  gazeH: number | null;
  gazeVRaw: number | null;
  gazeV: number | null;
  /** Horizontal gaze from the blendshapes (raw and smoothed). */
  blendHRaw: number | null;
  blendH: number | null;
  /** Vertical gaze from the blendshapes (+ = down), raw and smoothed. */
  blendVRaw: number | null;
  blendV: number | null;
  /** Blendshape scores: eyeLookInLeft ... eyeLookDownRight. */
  bs: Record<string, number | null>;
  /** Per-stage timing in ms. */
  snapMs: number;
  detectMs: number;
  drawMs: number;
  procMs: number;
  /** One [x, y, w, h] per masked face, in video pixels (after scaling and forehead lift). */
  maskBoxes: [number, number, number, number][];
}

export interface SessionInfo {
  laptop: string;
  scenario: string;
  width: number;
  height: number;
  delegate: string;
  detectLongSide: number;
  /** What was asked for: auto (GPU with CPU fallback), gpu or cpu. */
  delegateRequested: string;
  maskOptions: MaskOptions;
  /** Result of the setup check: which checks failed and whether the person continued anyway. */
  setup: unknown;
  /** Baseline, noise and edge readings from the calibration. */
  calibration: unknown;
  /** Scripted-session mode only: which script was run. Omitted when the script is "none". */
  script?: { id: string; split: string; kind: string; version: string };
}

export interface CueLine {
  /** ACTUAL session time in ms: same clock and zero point as the frame t. */
  t: number;
  planned_s: number;
  label: string;
  direction: string;
}

export interface StopExtras {
  /** Written into the summary line (script mode only). */
  scriptOutcome?: { complete: boolean; lastSegmentIndex: number };
  /** Content of sidecar-<id>.labels.csv, downloaded as an extra file (script mode only). */
  labelsCsv?: string;
}

function pickMime(): string {
  for (const m of ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"]) {
    if (MediaRecorder.isTypeSupported(m)) return m;
  }
  return "";
}

const round = (v: number | null, d = 3) => (v === null || Number.isNaN(v) ? null : Number(v.toFixed(d)));

function frameLine(f: FrameRecord) {
  return {
    type: "frame",
    t: round(f.t, 1),
    faces: f.faces,
    lost: f.lost,
    yawRaw: round(f.yawRaw, 2),
    yaw: round(f.yaw, 2),
    pitchRaw: round(f.pitchRaw, 2),
    pitch: round(f.pitch, 2),
    roll: round(f.roll, 2),
    gazeHRaw: round(f.gazeHRaw),
    gazeH: round(f.gazeH),
    gazeVRaw: round(f.gazeVRaw),
    gazeV: round(f.gazeV),
    blendHRaw: round(f.blendHRaw),
    blendH: round(f.blendH),
    blendVRaw: round(f.blendVRaw),
    blendV: round(f.blendV),
    ...Object.fromEntries(Object.entries(f.bs).map(([k, v]) => [k, round(v)])),
    snapMs: round(f.snapMs, 1),
    detectMs: round(f.detectMs, 1),
    drawMs: round(f.drawMs, 1),
    procMs: round(f.procMs, 1),
    maskBoxes: f.maskBoxes,
  };
}

const pad = (n: number) => String(n).padStart(2, "0");
export function timestamp(d: Date): string {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}
export const safe = (s: string) => s.trim().replace(/[^a-zA-Z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "laptop";

class OneRecorder {
  private chunks: Blob[] = [];
  startedAt = 0;
  private done: Promise<void>;
  private rec: MediaRecorder;

  constructor(stream: MediaStream, mime: string, t0: number) {
    this.rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    this.rec.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data);
    };
    this.rec.onstart = () => {
      this.startedAt = performance.now() - t0;
    };
    this.done = new Promise((res) => (this.rec.onstop = () => res()));
    this.rec.start(1000); // 1-second timeslices
  }

  async stop(): Promise<Blob> {
    if (this.rec.state !== "inactive") this.rec.stop();
    await this.done;
    return new Blob(this.chunks, { type: "video/webm" });
  }
}

export class RecordingSession {
  readonly id: string;
  private t0 = performance.now();
  private startedIso = new Date().toISOString();
  private masked: OneRecorder;
  private raw: OneRecorder | null = null;
  private frames: FrameRecord[] = [];
  private keys: { t: number; cat: string }[] = [];
  private cues: CueLine[] = [];
  private lost = 0;

  constructor(
    private info: SessionInfo,
    canvas: HTMLCanvasElement,
    cameraStream: MediaStream,
    saveRaw: boolean,
  ) {
    this.id = `${safe(info.laptop)}_${info.scenario}_${timestamp(new Date())}`;
    const mime = pickMime();
    const maskedStream = canvas.captureStream(CAPTURE_FPS);
    for (const a of cameraStream.getAudioTracks()) maskedStream.addTrack(a.clone());
    this.masked = new OneRecorder(maskedStream, mime, this.t0);
    if (saveRaw) this.raw = new OneRecorder(cameraStream, mime, this.t0);
  }

  /** ms since recording start. */
  now(): number {
    return performance.now() - this.t0;
  }

  addFrame(f: FrameRecord): void {
    this.frames.push(f);
    if (f.lost) this.lost++;
  }

  /** Only the TIME and the CATEGORY of a key press are stored (char, backspace, delete, enter, space, other). Never the key. */
  addKey(cat: string): void {
    this.keys.push({ t: this.now(), cat });
  }

  /** Scripted-session mode: a cue line is written at each segment start. */
  addCue(c: CueLine): void {
    this.cues.push(c);
  }

  async stopAndDownload(extras: StopExtras = {}): Promise<void> {
    const durationMs = this.now();
    const [maskedBlob, rawBlob] = await Promise.all([this.masked.stop(), this.raw ? this.raw.stop() : null]);

    const lines: string[] = [];
    lines.push(
      JSON.stringify({
        type: "header",
        id: this.id,
        laptop: this.info.laptop,
        scenario: this.info.scenario,
        start: this.startedIso,
        width: this.info.width,
        height: this.info.height,
        delegate: this.info.delegate,
        userAgent: navigator.userAgent,
        detectLongSide: this.info.detectLongSide,
        delegateRequested: this.info.delegateRequested,
        maskOptions: this.info.maskOptions,
        setup: this.info.setup,
        calibration: this.info.calibration,
        ...(this.info.script ? { script: this.info.script } : {}),
        recorderStartMs: { masked: round(this.masked.startedAt, 1), raw: this.raw ? round(this.raw.startedAt, 1) : null },
      }),
    );
    // Frames, key presses and cues are written in time order.
    const extra: { t: number; line: string }[] = [
      ...this.keys.map((k) => ({ t: k.t, line: JSON.stringify({ type: "key", t: round(k.t, 1), cat: k.cat }) })),
      ...this.cues.map((c) => ({
        t: c.t,
        line: JSON.stringify({ type: "cue", t: round(c.t, 1), planned_s: c.planned_s, label: c.label, direction: c.direction }),
      })),
    ].sort((a, b) => a.t - b.t);
    let ki = 0;
    for (const f of this.frames) {
      while (ki < extra.length && extra[ki].t <= f.t) lines.push(extra[ki++].line);
      lines.push(JSON.stringify(frameLine(f)));
    }
    while (ki < extra.length) lines.push(extra[ki++].line);
    const s = summarize(
      this.frames.map((f) => f.t),
      this.lost,
      durationMs,
    );
    lines.push(
      JSON.stringify({
        type: "summary",
        frames: s.frames,
        lostFrames: s.lostFrames,
        durationS: round(s.durationS, 2),
        avgFps: round(s.avgFps, 2),
        p10Fps: round(s.p10Fps, 2),
        ...(extras.scriptOutcome
          ? { script_complete: extras.scriptOutcome.complete, last_segment_index: extras.scriptOutcome.lastSegmentIndex }
          : {}),
      }),
    );

    const files: [string, Blob][] = [
      [`masked-${this.id}.webm`, maskedBlob],
      [`sidecar-${this.id}.jsonl`, new Blob([lines.join("\n") + "\n"], { type: "application/x-ndjson" })],
    ];
    if (rawBlob) files.push([`raw-${this.id}.webm`, rawBlob]);
    if (extras.labelsCsv !== undefined) files.push([`sidecar-${this.id}.labels.csv`, new Blob([extras.labelsCsv], { type: "text/csv" })]);
    for (const [name, blob] of files) {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
      await new Promise((r) => setTimeout(r, 400)); // Chrome drops back-to-back downloads
    }
  }
}
