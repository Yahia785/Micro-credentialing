import { describe, expect, it } from "vitest";
import { KEY_LOG_VERSION, KeyTracker, keyCategory } from "../src/keys";

const k = (key: string, mods: { ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean } = {}) => keyCategory({ key, ...mods });

describe("keyCategory", () => {
  it("keeps the existing categories", () => {
    expect(k("a")).toBe("char");
    expect(k("7")).toBe("char");
    expect(k(".")).toBe("char");
    expect(k("Backspace")).toBe("backspace");
    expect(k("Delete")).toBe("delete");
    expect(k("Enter")).toBe("enter");
    expect(k(" ")).toBe("space");
    expect(k("Spacebar")).toBe("space");
  });
  it("splits navigation keys into move", () => {
    for (const key of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"]) expect(k(key)).toBe("move");
  });
  it("leaves everything else as other", () => {
    for (const key of ["Shift", "Tab", "Escape", "F5", "Control", "CapsLock"]) expect(k(key)).toBe("other");
  });
  it("counts every Ctrl/Cmd/Alt shortcut as other, including moves", () => {
    expect(k("v", { ctrlKey: true })).toBe("other");
    expect(k("c", { metaKey: true })).toBe("other");
    expect(k("a", { altKey: true })).toBe("other");
    expect(k("ArrowLeft", { ctrlKey: true })).toBe("other");
    expect(k("Home", { altKey: true })).toBe("other");
  });
  it("version is 2", () => expect(KEY_LOG_VERSION).toBe(2));
});

describe("KeyTracker press/release pairing", () => {
  it("pairs a simple press and release and keeps the press category", () => {
    const t = new KeyTracker();
    const id = t.press("KeyA", "char");
    expect(t.release("KeyA", "other")).toEqual({ id, category: "char" });
  });
  it("gives every press a distinct id", () => {
    const t = new KeyTracker();
    const ids = [t.press("KeyA", "char"), t.press("KeyA", "char"), t.press("KeyB", "char")];
    expect(new Set(ids).size).toBe(3);
  });
  it("pairs overlapping presses released in any order", () => {
    const t = new KeyTracker();
    const a = t.press("KeyA", "char");
    const b = t.press("KeyB", "char");
    expect(t.release("KeyA", "char").id).toBe(a); // first down, first up
    expect(t.release("KeyB", "char").id).toBe(b);
    const c = t.press("KeyC", "char");
    const d = t.press("KeyD", "backspace");
    expect(t.release("KeyD", "backspace").id).toBe(d); // first down, last up
    expect(t.release("KeyC", "char").id).toBe(c);
  });
  it("uses the press category when a modifier was released first (Ctrl+V)", () => {
    const t = new KeyTracker();
    const v = t.press("KeyV", "other"); // pressed with Ctrl held
    expect(t.release("KeyV", "char")).toEqual({ id: v, category: "other" }); // keyup arrives after Ctrl was let go
  });
  it("key repeat: each repeat is a new press id, the release pairs with the first press of the hold", () => {
    const t = new KeyTracker();
    const first = t.press("KeyA", "char", false);
    const r1 = t.press("KeyA", "char", true);
    const r2 = t.press("KeyA", "char", true);
    expect(new Set([first, r1, r2]).size).toBe(3);
    expect(t.release("KeyA", "char").id).toBe(first);
    expect(t.release("KeyA", "char").id).toBeNull(); // already released
  });
  it("a repeat with no earlier press seen is treated as the start of the hold", () => {
    const t = new KeyTracker();
    const r = t.press("KeyA", "char", true);
    expect(t.release("KeyA", "char").id).toBe(r);
  });
  it("a release whose press was not seen has id null and the fallback category", () => {
    const t = new KeyTracker();
    expect(t.release("KeyZ", "move")).toEqual({ id: null, category: "move" });
  });
  it("a new press after a missed release replaces the stale one", () => {
    const t = new KeyTracker();
    t.press("KeyA", "char");
    const again = t.press("KeyA", "char");
    expect(t.release("KeyA", "char").id).toBe(again);
  });
  it("clear forgets held keys, ids keep counting", () => {
    const t = new KeyTracker();
    const a = t.press("KeyA", "char");
    t.clear();
    expect(t.release("KeyA", "char").id).toBeNull();
    expect(t.press("KeyB", "char")).toBeGreaterThan(a);
  });
});
