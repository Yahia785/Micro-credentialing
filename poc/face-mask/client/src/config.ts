// Everything worth tuning lives here.

/** Confidence thresholds for MediaPipe FaceLandmarker. Raise = fewer false faces, more "lost" frames. */
export const MIN_FACE_DETECTION_CONFIDENCE = 0.6;
export const MIN_FACE_PRESENCE_CONFIDENCE = 0.6;
export const MIN_TRACKING_CONFIDENCE = 0.6;
export const NUM_FACES = 2;

export const WASM_PATH = "/wasm";
export const MODEL_PATH = "/models/face_landmarker.task";

export const CAMERA_WIDTH = 1280;
export const CAMERA_HEIGHT = 720;
export const CAPTURE_FPS = 30;

export interface MaskOptions {
  /** Hull is scaled by this factor around its center (1.3 = 30% bigger). */
  maskScale: number;
  /** Extra height added above the face, as a fraction of face height (covers the forehead). */
  foreheadLift: number;
  /** When tracking is lost the frame is downscaled to width/blockSize, then upscaled. */
  pixelBlockSize: number;
  /** Solid fill of the face shape. */
  skinColor: string;
  outlineColor: string;
}

export const DEFAULT_MASK_OPTIONS: MaskOptions = {
  maskScale: 1.3,
  foreheadLift: 0.25,
  pixelBlockSize: 40,
  skinColor: "#c9b49c",
  outlineColor: "#5a4a3a",
};

export const SCENARIOS = [
  "normal",
  "second-screen",
  "phone",
  "hand-over-face",
  "turn-away",
  "leave-frame",
  "low-light",
  "fast-motion",
  "second-person",
] as const;
