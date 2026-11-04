// Copies the MediaPipe WASM runtime into public/wasm so nothing is loaded from a CDN.
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "node_modules", "@mediapipe", "tasks-vision", "wasm");
const dst = join(root, "public", "wasm");
if (!existsSync(src)) {
  console.error("copy-wasm: " + src + " not found. Run npm install first.");
  process.exit(1);
}
mkdirSync(dst, { recursive: true });
cpSync(src, dst, { recursive: true });
console.log("copy-wasm: copied WASM files to public/wasm");
