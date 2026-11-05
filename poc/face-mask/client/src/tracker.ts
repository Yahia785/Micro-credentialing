import { FaceLandmarker, FilesetResolver, type FaceLandmarkerResult } from "@mediapipe/tasks-vision";
import {
  MIN_FACE_DETECTION_CONFIDENCE,
  MIN_FACE_PRESENCE_CONFIDENCE,
  MIN_TRACKING_CONFIDENCE,
  MODEL_PATH,
  NUM_FACES,
  WASM_PATH,
} from "./config";

export type Delegate = "GPU" | "CPU";

export class Tracker {
  private lastTs = 0;
  private constructor(
    private lm: FaceLandmarker,
    readonly delegate: Delegate,
  ) {}

  static async create(): Promise<Tracker> {
    const fileset = await FilesetResolver.forVisionTasks(WASM_PATH);
    const make = (delegate: Delegate) =>
      FaceLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODEL_PATH, delegate },
        runningMode: "VIDEO",
        numFaces: NUM_FACES,
        minFaceDetectionConfidence: MIN_FACE_DETECTION_CONFIDENCE,
        minFacePresenceConfidence: MIN_FACE_PRESENCE_CONFIDENCE,
        minTrackingConfidence: MIN_TRACKING_CONFIDENCE,
        outputFaceBlendshapes: true,
        outputFacialTransformationMatrixes: true,
      });
    // GPU can fail at creation OR at the first detect call, so warm it up inside the try.
    const warm = document.createElement("canvas");
    warm.width = 64;
    warm.height = 64;
    try {
      const t = new Tracker(await make("GPU"), "GPU");
      t.detect(warm);
      return t;
    } catch (e) {
      console.warn("GPU delegate failed, falling back to CPU", e);
      return new Tracker(await make("CPU"), "CPU");
    }
  }

  detect(source: HTMLCanvasElement): FaceLandmarkerResult {
    // MediaPipe needs strictly increasing timestamps in VIDEO mode.
    const ts = Math.max(performance.now(), this.lastTs + 1);
    this.lastTs = ts;
    return this.lm.detectForVideo(source, ts);
  }
}
