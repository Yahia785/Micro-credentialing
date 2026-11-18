// Scripted sessions: pure logic (no DOM, no audio). The cue panel, beeps and timers are in scriptRunner.ts.
//
// Time base: every time in this file is on the SESSION timeline: seconds since the "Start recording" click, the same
// zero point as the sidecar `frame` lines (t in ms), the `key` lines and the `cue` lines. analysis/common.py divides
// those t values by 1000 and test3_lookaway.py compares the label start_s/end_s with them, so labels written here
// can be used as they are.

export type Direction = "" | "left" | "right" | "up" | "down";
export const DIRECTIONS: Direction[] = ["", "left", "right", "up", "down"];

export interface Segment {
  start_s: number;
  end_s: number;
  label: string;
  direction: Direction;
  say: string;
}

export interface ScriptSession {
  id: string;
  split: string; // for example tuning / held-out, as written in the JSON
  kind: string; // for example honest / copy / visible
  version: string; // the JSON "version"
  segments: Segment[];
}

/** Segments with these labels are normal on-screen or keyboard behaviour, not look-aways: they get no row in the labels CSV. */
export const UNLABELLED = ["honest-type", "honest-keyboard"];

const EPS = 1e-6;

// ---- loading and validation ------------------------------------------------------------------------------------

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");

function toSegment(raw: unknown): Segment {
  const o = isObj(raw) ? raw : {};
  return {
    start_s: o.start_s as number,
    end_s: o.end_s as number,
    label: o.label as string,
    direction: (o.direction === undefined || o.direction === null ? "" : o.direction) as Direction,
    say: o.say as string,
  };
}

function toSession(raw: unknown, fallbackId: string, rootVersion: string): ScriptSession {
  const o = isObj(raw) ? raw : {};
  return {
    id: str(o.id) || fallbackId,
    split: str(o.split),
    kind: str(o.kind),
    version: str(o.version) || rootVersion,
    segments: Array.isArray(o.segments) ? o.segments.map(toSegment) : [],
  };
}

/**
 * Reads the scripted-sessions JSON. Accepted shapes: a list of sessions, or an object whose `sessions` is a list or a
 * map id -> session, or an object that is itself a map id -> session. `version` may be at the top or in each session.
 * Returns the sessions (not yet validated) and structural errors.
 */
export function parseScriptFile(raw: unknown): { sessions: ScriptSession[]; errors: string[] } {
  const errors: string[] = [];
  let list: unknown[] = [];
  let ids: string[] = [];
  let rootVersion = "";
  if (Array.isArray(raw)) {
    list = raw;
  } else if (isObj(raw)) {
    rootVersion = str(raw.version);
    const s = raw.sessions;
    if (Array.isArray(s)) list = s;
    else if (isObj(s)) {
      ids = Object.keys(s);
      list = Object.values(s);
    } else {
      const keys = Object.keys(raw).filter((k) => isObj(raw[k]) && Array.isArray((raw[k] as Obj).segments));
      ids = keys;
      list = keys.map((k) => raw[k]);
    }
  } else {
    errors.push("The scripted-sessions file is not a list or an object.");
  }
  if (errors.length === 0 && list.length === 0) errors.push("The scripted-sessions file contains no sessions.");
  const sessions = list.map((s, i) => toSession(s, ids[i] ?? `session${i + 1}`, rootVersion));
  const seen = new Set<string>();
  for (const s of sessions) {
    if (seen.has(s.id)) errors.push(`Session id "${s.id}" appears twice.`);
    seen.add(s.id);
  }
  return { sessions, errors };
}

/** Problems with one session's segments. Empty list = valid. */
export function validateSession(s: ScriptSession): string[] {
  const p: string[] = [];
  const name = `Script ${s.id}`;
  if (!s.id) p.push("A session has no id.");
  const seg = s.segments;
  if (!Array.isArray(seg) || seg.length === 0) return [...p, `${name}: no segments.`];
  seg.forEach((g, i) => {
    const at = `${name}, segment ${i + 1}`;
    if (typeof g.start_s !== "number" || !Number.isFinite(g.start_s)) p.push(`${at}: start_s is not a number.`);
    if (typeof g.end_s !== "number" || !Number.isFinite(g.end_s)) p.push(`${at}: end_s is not a number.`);
    if (typeof g.label !== "string" || g.label === "") p.push(`${at}: label is missing.`);
    if (typeof g.say !== "string") p.push(`${at}: say is missing.`);
    if (!DIRECTIONS.includes(g.direction)) p.push(`${at}: direction "${String(g.direction)}" is not one of "", left, right, up, down.`);
  });
  if (p.length > 0) return p; // the timing checks need numbers
  if (seg[0].start_s !== 0) p.push(`${name}: the first segment must start at 0 (it starts at ${seg[0].start_s}).`);
  seg.forEach((g, i) => {
    const at = `${name}, segment ${i + 1} (${g.label})`;
    if (g.end_s <= g.start_s) p.push(`${at}: end_s (${g.end_s}) must be greater than start_s (${g.start_s}).`);
    if (i > 0) {
      const prev = seg[i - 1];
      if (g.start_s < prev.start_s) p.push(`${at}: segments are not sorted (start_s ${g.start_s} is before the previous start_s ${prev.start_s}).`);
      else if (g.start_s > prev.end_s + EPS) p.push(`${at}: gap of ${(g.start_s - prev.end_s).toFixed(2)} s after the previous segment (start_s ${g.start_s}, previous end_s ${prev.end_s}).`);
      else if (g.start_s < prev.end_s - EPS) p.push(`${at}: overlaps the previous segment (start_s ${g.start_s}, previous end_s ${prev.end_s}).`);
    }
  });
  return p;
}

// ---- timing ---------------------------------------------------------------------------------------------------------

/** Index of the segment running at session time tS: -1 before the script, segments.length after its end. */
export function cueIndexAt(segments: Segment[], tS: number): number {
  if (segments.length === 0 || tS < segments[0].start_s) return -1;
  if (tS >= segments[segments.length - 1].end_s) return segments.length;
  for (let i = segments.length - 1; i >= 0; i--) if (tS >= segments[i].start_s) return i;
  return -1;
}

export interface Beep {
  atS: number; // session time
  kind: "short" | "long";
}

/**
 * One long beep when every segment starts; one short beep 3, 2 and 1 s before every segment change (every segment
 * except the first, which starts with the recording). Beeps that would fall before the recording starts are dropped.
 */
export function beepPlan(segments: Segment[]): Beep[] {
  const out: Beep[] = [];
  segments.forEach((g, i) => {
    out.push({ atS: g.start_s, kind: "long" });
    if (i > 0) for (const before of [3, 2, 1]) if (g.start_s - before >= 0) out.push({ atS: g.start_s - before, kind: "short" });
  });
  return out.sort((a, b) => a.atS - b.atS || (a.kind === "long" ? 1 : -1));
}

// ---- labels CSV --------------------------------------------------------------------------------------------------------

export interface ActualCue {
  index: number;
  /** ACTUAL session time of the cue, seconds. */
  tS: number;
}

const fmt = (x: number) => x.toFixed(2);

/**
 * Labels file sidecar-<id>.labels.csv (start_s,end_s,label,direction) built from the ACTUAL cue times.
 * A segment runs from its actual cue to the next actual cue; the last one that started ends when the script ended
 * (scriptEndS) or, if Stop was pressed earlier, at the stop time. Everything is cut off at stopS, segments that had not
 * started are left out, and honest-type / honest-keyboard segments get no row.
 */
export function buildLabelsCsv(segments: Segment[], cues: ActualCue[], stopS: number, scriptEndS: number | null): string {
  const byIndex = new Map(cues.map((c) => [c.index, c.tS]));
  const rows = ["start_s,end_s,label,direction"];
  for (let i = 0; i < segments.length; i++) {
    const start = byIndex.get(i);
    if (start === undefined || start >= stopS) continue;
    const next = byIndex.get(i + 1);
    let end = next ?? (i === segments.length - 1 && scriptEndS !== null ? scriptEndS : stopS);
    end = Math.min(end, stopS);
    if (end <= start || UNLABELLED.includes(segments[i].label)) continue;
    rows.push(`${fmt(start)},${fmt(end)},${segments[i].label},${segments[i].direction}`);
  }
  return rows.join("\n") + "\n";
}

// ---- bundled file --------------------------------------------------------------------------------------------------------

/**
 * The scripts bundled with the page: client/src/scripted-sessions.json. Loaded with a glob, so the page and the tests
 * still build when the file is absent (then there are no scripts and only "none" is offered).
 */
export function loadBundledScripts(): { sessions: ScriptSession[]; errors: string[]; found: boolean } {
  const files = import.meta.glob("./scripted-sessions.json", { eager: true, import: "default" });
  const raw = Object.values(files)[0];
  if (raw === undefined) return { sessions: [], errors: [], found: false };
  return { ...parseScriptFile(raw), found: true };
}
