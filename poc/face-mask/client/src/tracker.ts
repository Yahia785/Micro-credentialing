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
/** auto = GPU with CPU fallback (the default); gpu / cpu = force one, no fallback. */
export type DelegateRequest = "auto" | "gpu" | "cpu";

export class Tracker {
  private lastTs = 0;
  private constructor(
    private lm: FaceLandmarker,
    readonly delegate: Delegate,
    readonly requested: DelegateRequest,
  ) {}

  static async create(requested: DelegateRequest = "auto"): Promise<Tracker> {
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
    if (requested === "cpu") return new Tracker(await make("CPU"), "CPU", requested);

    // GPU can fail at creation OR at the first detect call, so warm it up inside the try.
    const warm = document.createElement("canvas");
    warm.width = 64;
    warm.height = 64;
    let gpu: FaceLandmarker | null = null;
    try {
      gpu = await make("GPU");
      const t = new Tracker(gpu, "GPU", requested);
      t.detect(warm);
      return t;
    } catch (e) {
      try {
        gpu?.close();
      } catch {
        /* ignore */
      }
      if (requested === "gpu") throw new Error("GPU delegate is not available on this machine: " + (e instanceof Error ? e.message : String(e)));
      console.warn("GPU delegate failed, falling back to CPU", e);
      return new Tracker(await make("CPU"), "CPU", requested);
    }
  }

  /** Release the landmarker (call before creating a new one with another delegate). */
  close(): void {
    try {
      this.lm.close();
    } catch (e) {
      console.warn("close failed", e);
    }
  }

  detect(source: HTMLCanvasElement): FaceLandmarkerResult {
    // MediaPipe needs strictly increasing timestamps in VIDEO mode.
    const ts = Math.max(performance.now(), this.lastTs + 1);
    this.lastTs = ts;
    return this.lm.detectForVideo(source, ts);
  }
}
