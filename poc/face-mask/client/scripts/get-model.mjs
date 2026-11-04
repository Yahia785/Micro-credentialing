// Downloads the official face_landmarker.task (float16) into public/models.
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const URL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, "public", "models");
const file = join(dir, "face_landmarker.task");
if (existsSync(file) && !process.argv.includes("--force")) {
  console.log("get-model: already present at " + file + " (use --force to re-download)");
  process.exit(0);
}
mkdirSync(dir, { recursive: true });
console.log("get-model: downloading " + URL);
const res = await fetch(URL);
if (!res.ok) {
  console.error("get-model: download failed with HTTP " + res.status);
  process.exit(1);
}
const buf = Buffer.from(await res.arrayBuffer());
writeFileSync(file, buf);
console.log("get-model: saved " + (buf.length / 1e6).toFixed(1) + " MB to " + file);
