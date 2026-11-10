// Key categories. The page logs the CATEGORY of each key press and its time, never the key itself.

export type KeyCategory = "char" | "backspace" | "delete" | "enter" | "space" | "other";

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
  if (k.length === 1) return "char"; // one printable character (letters, digits, punctuation)
  return "other"; // Shift, Arrow keys, Tab, Escape, F-keys, ...
}
