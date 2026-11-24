// Key categories. The page logs the CATEGORY of each key press and its time, never the key itself.

export type KeyCategory = "char" | "backspace" | "delete" | "enter" | "space" | "move" | "other";

/** Version of the key logging. 1 (no field in the header) = press only; 2 = press with id, release lines and the "move" category. */
export const KEY_LOG_VERSION = 2;

const MOVE_KEYS = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"]);

export interface KeyLike {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
}

/**
 * Category of a key press. The key value is read only here, to pick a category, and is never stored or sent anywhere.
 * Shortcuts (Ctrl/Cmd/Alt + a key, for example copy and paste) count as "other".
 */
export function keyCategory(e: KeyLike): KeyCategory {
  if (e.ctrlKey || e.metaKey || e.altKey) return "other";
  const k = e.key;
  if (k === "Backspace") return "backspace";
  if (k === "Delete") return "delete";
  if (k === "Enter") return "enter";
  if (k === " " || k === "Spacebar") return "space";
  if (MOVE_KEYS.has(k)) return "move";
  if (k.length === 1) return "char"; // one printable character (letters, digits, punctuation)
  return "other"; // Shift, Tab, Escape, F-keys, ...
}

/**
 * Pairs each key release with its press. `code` (the physical key) is used only in memory to match the two events and is
 * never stored or sent; the lines written to the sidecar hold only an id, a time and a category.
 *
 * - Overlapping presses: each physical key has its own entry, so releases pair in any order.
 * - Key repeat (keydown with repeat=true while held): every repeat gets its own id (so it is still logged as a press, as
 *   before), but the release pairs with the FIRST press of the hold.
 * - A release with no press seen (for example the key went down before recording started, or in another element):
 *   id is null and the category is the fallback one computed from the keyup event.
 * - The press category is reused for the release, so Ctrl+V released as V-then-Ctrl is still "other".
 */
export class KeyTracker {
  private nextId = 0;
  private held = new Map<string, { id: number; category: KeyCategory }>();

  press(code: string, category: KeyCategory, repeat = false): number {
    const id = this.nextId++;
    if (!repeat || !this.held.has(code)) this.held.set(code, { id, category });
    return id;
  }

  release(code: string, fallback: KeyCategory): { id: number | null; category: KeyCategory } {
    const h = this.held.get(code);
    if (!h) return { id: null, category: fallback };
    this.held.delete(code);
    return { id: h.id, category: h.category };
  }

  /** Forget all held keys (for example when the typing box loses focus: those releases will not be seen). */
  clear(): void {
    this.held.clear();
  }
}
