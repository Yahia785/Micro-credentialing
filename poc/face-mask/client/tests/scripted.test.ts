import { describe, expect, it } from "vitest";
import {
  beepPlan,
  buildLabelsCsv,
  cueIndexAt,
  loadBundledScripts,
  parseScriptFile,
  validateSession,
  type ScriptSession,
  type Segment,
} from "../src/scripted";

const seg = (start_s: number, end_s: number, label: string, direction: Segment["direction"] = "", say = label): Segment => ({
  start_s, end_s, label, direction, say,
});

const session = (segments: Segment[], over: Partial<ScriptSession> = {}): ScriptSession => ({
  id: "C1", split: "tuning", kind: "copy", version: "1", segments, ...over,
});

const GOOD = [
  seg(0, 10, "honest-read", "", "Read the screen"),
  seg(10, 20, "look-away", "down", "Look down at your phone"),
  seg(20, 30, "honest-type", "", "Type"),
  seg(30, 40, "look-away", "right", "Look right"),
];

describe("loading the JSON", () => {
  it("reads a list, an object with a sessions list, and an object with a sessions map", () => {
    const raw = { id: "H1", split: "tuning", kind: "honest", segments: GOOD };
    expect(parseScriptFile([raw]).sessions[0].id).toBe("H1");
    const a = parseScriptFile({ version: "2", sessions: [raw] });
    expect(a.errors).toEqual([]);
    expect(a.sessions[0].version).toBe("2");
    const b = parseScriptFile({ version: 3, sessions: { C1: { split: "held-out", kind: "copy", segments: GOOD } } });
    expect(b.sessions[0]).toMatchObject({ id: "C1", split: "held-out", kind: "copy", version: "3" });
    const c = parseScriptFile({ H2: { segments: GOOD }, C2: { segments: GOOD } });
    expect(c.sessions.map((s) => s.id)).toEqual(["H2", "C2"]);
  });
  it("a missing direction means none", () => {
    const s = parseScriptFile([{ id: "X", segments: [{ start_s: 0, end_s: 5, label: "a", say: "a" }] }]).sessions[0];
    expect(s.segments[0].direction).toBe("");
  });
  it("reports structural problems", () => {
    expect(parseScriptFile("nope").errors.length).toBe(1);
    expect(parseScriptFile([]).errors[0]).toMatch(/no sessions/);
    expect(parseScriptFile([{ id: "A", segments: GOOD }, { id: "A", segments: GOOD }]).errors[0]).toMatch(/twice/);
  });
});

describe("validation", () => {
  it("accepts a good session", () => {
    expect(validateSession(session(GOOD))).toEqual([]);
  });
  it("rejects a gap", () => {
    const p = validateSession(session([seg(0, 10, "a"), seg(12, 20, "b")]));
    expect(p.length).toBe(1);
    expect(p[0]).toMatch(/gap of 2\.00 s/);
  });
  it("rejects an overlap", () => {
    const p = validateSession(session([seg(0, 10, "a"), seg(8, 20, "b")]));
    expect(p.join(" ")).toMatch(/overlaps/);
  });
  it("rejects a bad direction", () => {
    const p = validateSession(session([seg(0, 10, "a"), seg(10, 20, "b", "sideways" as Segment["direction"])]));
    expect(p.join(" ")).toMatch(/direction "sideways"/);
  });
  it("accepts every allowed direction", () => {
    for (const d of ["", "left", "right", "up", "down"] as const) expect(validateSession(session([seg(0, 5, "a", d)]))).toEqual([]);
  });
  it("rejects segments that are not sorted", () => {
    const p = validateSession(session([seg(0, 10, "a"), seg(20, 30, "c"), seg(10, 20, "b")]));
    expect(p.join(" ")).toMatch(/not sorted/);
  });
  it("rejects a first segment that does not start at 0", () => {
    expect(validateSession(session([seg(2, 10, "a")])).join(" ")).toMatch(/must start at 0/);
  });
  it("rejects end_s not after start_s, missing label and no segments", () => {
    expect(validateSession(session([seg(0, 0, "a")])).join(" ")).toMatch(/must be greater/);
    expect(validateSession(session([seg(0, 5, "")])).join(" ")).toMatch(/label is missing/);
    expect(validateSession(session([]))[0]).toMatch(/no segments/);
  });
  it("rejects non-numbers", () => {
    const bad = session([{ start_s: "0", end_s: 5, label: "a", direction: "", say: "a" } as unknown as Segment]);
    expect(validateSession(bad).join(" ")).toMatch(/start_s is not a number/);
  });
});

describe("timing", () => {
  it("finds the running segment", () => {
    expect(cueIndexAt(GOOD, -1)).toBe(-1);
    expect(cueIndexAt(GOOD, 0)).toBe(0);
    expect(cueIndexAt(GOOD, 9.99)).toBe(0);
    expect(cueIndexAt(GOOD, 10)).toBe(1);
    expect(cueIndexAt(GOOD, 39.9)).toBe(3);
    expect(cueIndexAt(GOOD, 40)).toBe(4); // finished
    expect(cueIndexAt(GOOD, 500)).toBe(4);
  });
  it("beeps: a long one at every start and short ones 3, 2 and 1 s before every change", () => {
    const plan = beepPlan([seg(0, 10, "a"), seg(10, 20, "b"), seg(20, 30, "c")]);
    expect(plan.filter((b) => b.kind === "long").map((b) => b.atS)).toEqual([0, 10, 20]);
    expect(plan.filter((b) => b.kind === "short").map((b) => b.atS)).toEqual([7, 8, 9, 17, 18, 19]);
  });
  it("beeps before the recording starts are dropped", () => {
    const plan = beepPlan([seg(0, 2, "a"), seg(2, 4, "b")]);
    expect(plan.filter((b) => b.kind === "short").map((b) => b.atS)).toEqual([0, 1]);
  });
});

describe("labels CSV", () => {
  const cues = (times: number[]) => times.map((tS, index) => ({ index, tS }));

  it("uses the ACTUAL cue times, drops honest-type and honest-keyboard, keeps direction", () => {
    const csv = buildLabelsCsv(GOOD, cues([0.03, 10.04, 20.02, 30.05]), 60, 40.06);
    expect(csv).toBe("start_s,end_s,label,direction\n" +
      "0.03,10.04,honest-read,\n" +
      "10.04,20.02,look-away,down\n" +
      "30.05,40.06,look-away,right\n");
  });
  it("an early stop cuts the running segment at the stop time and leaves out later segments", () => {
    const csv = buildLabelsCsv(GOOD, cues([0.03, 10.04]), 14.5, null);
    expect(csv).toBe("start_s,end_s,label,direction\n0.03,10.04,honest-read,\n10.04,14.50,look-away,down\n");
  });
  it("a stop during an honest-type segment gives rows only for the earlier segments", () => {
    const csv = buildLabelsCsv(GOOD, cues([0.03, 10.04, 20.02]), 25, null);
    expect(csv.trim().split("\n")).toEqual(["start_s,end_s,label,direction", "0.03,10.04,honest-read,", "10.04,20.02,look-away,down"]);
  });
  it("a cue logged after the stop is ignored, and stopping at the very start gives only the header", () => {
    expect(buildLabelsCsv(GOOD, cues([0.03, 10.04, 20.02]), 10.04, null)).toBe("start_s,end_s,label,direction\n0.03,10.04,honest-read,\n");
    expect(buildLabelsCsv(GOOD, [], 5, null)).toBe("start_s,end_s,label,direction\n");
    expect(buildLabelsCsv(GOOD, cues([0.03]), 0.03, null)).toBe("start_s,end_s,label,direction\n");
  });
  it("a late cue shifts the labels with it (actual times, not planned)", () => {
    const csv = buildLabelsCsv(GOOD, cues([0, 10.4, 20.4, 30.4]), 60, 40.4);
    expect(csv).toContain("10.40,20.40,look-away,down");
    expect(csv).not.toContain("10.00");
  });
  it("the finished script ends the last segment at the script end, not at the later stop", () => {
    const csv = buildLabelsCsv(GOOD, cues([0, 10, 20, 30]), 90, 40.1);
    expect(csv).toContain("30.00,40.10,look-away,right");
  });
});

describe("the bundled scripted-sessions.json", () => {
  const bundled = loadBundledScripts();
  it.skipIf(!bundled.found)("loads and every session is valid (a problem here is a problem in the file)", () => {
    expect(bundled.errors).toEqual([]);
    for (const s of bundled.sessions) expect(validateSession(s), `session ${s.id}`).toEqual([]);
  });
  it("is optional: the page builds without it", () => {
    expect(Array.isArray(bundled.sessions)).toBe(true);
  });
});
