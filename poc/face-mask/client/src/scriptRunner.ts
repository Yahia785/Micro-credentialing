// Cue panel, beeps and the cue clock for a scripted session. Pure logic is in scripted.ts.
import { beepPlan, cueIndexAt, type ActualCue, type ScriptSession } from "./scripted";

export interface CueEvent {
  index: number;
  /** ACTUAL session time in ms (same clock and zero point as the sidecar frame t). */
  t: number;
  planned_s: number;
  label: string;
  direction: string;
}

export interface ScriptOutcome {
  complete: boolean;
  lastSegmentIndex: number;
  /** Session time (s) when the script ran out, or null if it had not. */
  endS: number | null;
  cues: ActualCue[];
}

const $ = (id: string) => document.getElementById(id) as HTMLElement;

/**
 * nowMs() must return the SESSION clock: ms since the recording started (RecordingSession.now).
 * The panel never takes focus: it is plain text with no focusable element.
 */
export class ScriptRunner {
  private timer = 0;
  private ctx: AudioContext | null = null;
  private logged = -1;
  private endS: number | null = null;
  private cues: ActualCue[] = [];

  constructor(
    private script: ScriptSession,
    private nowMs: () => number,
    private onCue: (c: CueEvent) => void,
  ) {}

  start(): void {
    $("cuePanel").hidden = false;
    this.scheduleBeeps();
    this.tick();
    this.timer = window.setInterval(() => this.tick(), 40);
  }

  /** Beeps are scheduled ahead on the audio clock, tied to the session clock, so a busy page cannot delay them. */
  private scheduleBeeps(): void {
    try {
      const ctx = new AudioContext(); // created inside the Start recording click, so the browser allows sound
      void ctx.resume();
      this.ctx = ctx;
      const base = ctx.currentTime - this.nowMs() / 1000; // audio time of session time 0
      for (const b of beepPlan(this.script.segments)) {
        const at = base + b.atS;
        if (at < ctx.currentTime + 0.02) continue;
        const dur = b.kind === "long" ? 0.7 : 0.12;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.frequency.value = b.kind === "long" ? 660 : 1040;
        gain.gain.setValueAtTime(0.0001, at);
        gain.gain.exponentialRampToValueAtTime(0.35, at + 0.01);
        gain.gain.setValueAtTime(0.35, at + dur - 0.03);
        gain.gain.exponentialRampToValueAtTime(0.0001, at + dur);
        osc.connect(gain).connect(ctx.destination);
        osc.start(at);
        osc.stop(at + dur + 0.02);
      }
    } catch (e) {
      console.warn("beeps unavailable", e);
    }
  }

  private tick(): void {
    const t = this.nowMs() / 1000;
    const segs = this.script.segments;
    const idx = cueIndexAt(segs, t);
    const upTo = Math.min(idx, segs.length - 1);
    for (let i = this.logged + 1; i <= upTo; i++) {
      this.logged = i;
      this.cues.push({ index: i, tS: t });
      const g = segs[i];
      this.onCue({ index: i, t: t * 1000, planned_s: g.start_s, label: g.label, direction: g.direction });
    }
    if (idx >= segs.length && this.endS === null) this.endS = t;
    this.render(idx, t);
  }

  private render(idx: number, t: number): void {
    const segs = this.script.segments;
    const now = $("cueNow");
    const left = $("cueLeft");
    const next = $("cueNext");
    if (idx >= segs.length) {
      now.textContent = "Script finished: press Stop and save";
      left.textContent = "";
      next.textContent = "";
      $("cuePanel").classList.add("done");
      return;
    }
    if (idx < 0) {
      now.textContent = "Starting...";
      left.textContent = "";
      next.textContent = "";
      return;
    }
    const g = segs[idx];
    now.textContent = g.say;
    left.textContent = `${Math.max(0, Math.ceil(g.end_s - t))} s left in this segment`;
    const n = segs[idx + 1];
    next.textContent = n ? `Next: ${n.say} in ${Math.max(0, Math.ceil(n.start_s - t))} s` : `Last segment: the script ends in ${Math.max(0, Math.ceil(g.end_s - t))} s`;
    $("cuePanel").classList.remove("done");
  }

  outcome(): ScriptOutcome {
    return { complete: this.endS !== null, lastSegmentIndex: this.logged, endS: this.endS, cues: [...this.cues] };
  }

  stop(): void {
    window.clearInterval(this.timer);
    void this.ctx?.close();
    this.ctx = null;
    $("cuePanel").hidden = true;
    $("cuePanel").classList.remove("done");
  }
}
