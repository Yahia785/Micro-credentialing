// Everything worth tuning lives here.

/** Confidence thresholds for MediaPipe FaceLandmarker. Raise = fewer false faces, more "lost" frames. */
export const MIN_FACE_DETECTION_CONFIDENCE = 0.6;
export const MIN_FACE_PRESENCE_CONFIDENCE = 0.6;
export const MIN_TRACKING_CONFIDENCE = 0.6;
export const NUM_FACES = 2;

/** Tracking runs on a downscaled copy of the snapshot (long side, px). Drawing always uses the full snapshot. */
export const DETECT_LONG_SIDE = 640;
/** Choices offered on the setup screen (and in ?detect=). */
export const DETECT_SIZES = [640, 480, 320];

// ---- Speed sweep ----------------------------------------------------------------------
export const SWEEP_S = 15; // measured seconds per delegate/size combination
export const SWEEP_WARMUP_S = 1; // discarded after each switch (GPU shader compile etc.)

// ---- One Euro filter (Casiez et al. 2012) -------------------------------------------
// minCutoff (Hz): smoothing when still. Lower = steadier but laggier.
// beta: how fast the cutoff opens up when the signal moves quickly. Higher = less lag on fast moves.
// dCutoff (Hz): smoothing of the speed estimate.
export interface OneEuroParams {
  minCutoff: number;
  beta: number;
  dCutoff: number;
}
/** Standard values; used for head angles (degrees) and iris landmarks (pixels). */
export const ONE_EURO_POSE: OneEuroParams = { minCutoff: 1.0, beta: 0.007, dCutoff: 1.0 };
/** Gaze values live in [-1, 1], so speeds are small: beta is scaled up to match. */
export const ONE_EURO_GAZE: OneEuroParams = { minCutoff: 1.0, beta: 0.5, dCutoff: 1.0 };

// ---- Setup check ---------------------------------------------------------------------
export const MIN_FACE_HEIGHT_SHARE = 0.3; // face box height / frame height
export const CENTER_TOLERANCE = 0.2; // face-box center may be this far (share of frame) from the middle
export const MIN_MEAN_LUMA = 70; // 0..255, mean brightness of the face region
export const MAX_MEAN_LUMA = 200;
export const MIN_LUMA_STD = 22; // contrast = std dev of brightness in the face region
export const GUIDE_HEIGHT_SHARE = 0.45; // size of the drawn guide box
export const SETUP_CHECK_INTERVAL_MS = 250;

// ---- Calibration ---------------------------------------------------------------------
export const CALIB_CENTER_S = 5;
export const CALIB_EDGE_S = 2; // per edge (left, then right) = 4 s total
export const CALIB_SETTLE_S = 0.4; // centre stage: ignore the first part while the eyes settle on the dot
export const CALIB_EDGE_SETTLE_S = 0.5; // edge stages: ignore the first part (eyes travel to the edge); 2.0 - 0.5 = 1.5 s of data
export const CALIB_KEYBOARD_S = 3; // "Look at your keyboard" stage (the first CALIB_EDGE_SETTLE_S is ignored too)
export const CALIB_MIN_SAMPLES = 8; // center stage
export const CALIB_MIN_EDGE_SAMPLES = 3;

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
  /** Extend the mask upward to cover the top of the head and hair. */
  headCover: boolean;
  /** How far the head cover rises above the (forehead-lifted) shape, as a fraction of face height. */
  headCoverHeight: number;
  /** Width of the head cover relative to the widest part of the shape. */
  headCoverWidth: number;
  /** Solid fill of the face shape. */
  skinColor: string;
  outlineColor: string;
}

export const DEFAULT_MASK_OPTIONS: MaskOptions = {
  maskScale: 1.3,
  foreheadLift: 0.25,
  pixelBlockSize: 40,
  headCover: true,
  headCoverHeight: 0.5,
  headCoverWidth: 1.05,
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
  "code-own",
  "code-copy",
  "essay-own",
  "essay-copy",
] as const;
