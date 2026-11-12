/**
 * Upload of a big recording to S3 in parts. This file has no network code of its own: the four API calls and the
 * "send one part" function are passed in, so the slicing, the retries and the URL refresh can be tested with fakes.
 */

/** Recordings smaller than this are sent in one PUT, as before. Also the part size the server announces. */
export const PART_SIZE = 8 * 1024 * 1024;
/** The server signs at most this many part URLs per call. */
export const MAX_URLS_PER_CALL = 20;

const DEFAULT_CONCURRENCY = 3;
/** Wait before retry 1, 2, 3, 4, 5. */
const DEFAULT_BACKOFF_MS = [1000, 2000, 4000, 8000, 16000];

export interface CompletedPart {
  partNumber: number;
  etag: string;
}

export interface MultipartApi {
  create(): Promise<{ uploadId: string; key: string; partSize?: number }>;
  presign(uploadId: string, partNumbers: number[]): Promise<Array<{ partNumber: number; url: string }>>;
  complete(uploadId: string, parts: CompletedPart[]): Promise<{ key: string; size?: number }>;
  abort(uploadId: string): Promise<void>;
}

/** Sends one part. Resolves with the HTTP status and the ETag header (null when the browser cannot read it). */
export type PutPart = (
  url: string,
  body: Blob,
  onProgress: (loadedBytes: number) => void
) => Promise<{ status: number; etag: string | null }>;

export interface MultipartOptions {
  concurrency?: number;
  backoffMs?: number[];
  /** Replaceable so tests do not wait. */
  sleep?: (ms: number) => Promise<void>;
  /** 0 to 1, over the whole file. Retried parts count from zero again. */
  onProgress?: (fraction: number) => void;
  /** Called after each failed attempt of a part, before the wait. */
  onRetry?: (info: { partNumber: number; attempt: number; reason: string }) => void;
}

/** A failure that another attempt cannot fix. */
class FatalPartError extends Error {}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function uploadInParts(
  blob: Blob,
  api: MultipartApi,
  putPart: PutPart,
  options: MultipartOptions = {}
): Promise<{ key: string }> {
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
  const backoff = options.backoffMs ?? DEFAULT_BACKOFF_MS;
  const sleep = options.sleep ?? defaultSleep;

  const { uploadId, key, partSize: serverPartSize } = await api.create();

  try {
    const partSize = serverPartSize && serverPartSize > 0 ? serverPartSize : PART_SIZE;
    const partCount = Math.ceil(blob.size / partSize);

    const urls = new Map<number, string>();
    const pendingUrls = new Map<number, Promise<void>>();
    const etags = new Map<number, string>();
    const loaded = new Array<number>(partCount + 1).fill(0);
    let nextPart = 1;
    let failure: unknown = null;

    const reportProgress = () => {
      if (!options.onProgress) return;
      const total = loaded.reduce((sum, bytes) => sum + bytes, 0);
      options.onProgress(Math.min(1, total / blob.size));
    };

    /** Asks for the URL of `partNumber` and the next parts that still need one, in one call. */
    const fetchUrls = (partNumber: number): Promise<void> => {
      const batch = [partNumber];
      for (let n = partNumber + 1; n <= partCount && batch.length < MAX_URLS_PER_CALL; n++) {
        if (!urls.has(n) && !pendingUrls.has(n) && !etags.has(n)) batch.push(n);
      }
      const request = api
        .presign(uploadId, batch)
        .then((signed) => {
          for (const { partNumber: n, url } of signed) urls.set(n, url);
        })
        .finally(() => {
          for (const n of batch) pendingUrls.delete(n);
        });
      for (const n of batch) pendingUrls.set(n, request);
      return request;
    };

    const urlFor = async (partNumber: number, forceFresh: boolean): Promise<string> => {
      if (forceFresh) urls.delete(partNumber);
      if (!urls.has(partNumber)) {
        // Another worker may already be asking for this part's URL.
        await (pendingUrls.get(partNumber) ?? fetchUrls(partNumber));
      }
      const url = urls.get(partNumber);
      if (!url) throw new Error(`The server did not return a URL for part ${partNumber}`);
      return url;
    };

    const uploadPart = async (partNumber: number): Promise<void> => {
      const start = (partNumber - 1) * partSize;
      const body = blob.slice(start, Math.min(start + partSize, blob.size));
      let forceFresh = false;

      for (let attempt = 0; ; attempt++) {
        let reason: string;
        let expired = false;
        try {
          const url = await urlFor(partNumber, forceFresh);
          forceFresh = false;
          const result = await putPart(url, body, (bytes) => {
            loaded[partNumber] = bytes;
            reportProgress();
          });
          if (result.status >= 200 && result.status < 300) {
            if (!result.etag) {
              throw new FatalPartError('S3 did not return an ETag the browser can read. Check the bucket CORS ExposeHeaders.');
            }
            etags.set(partNumber, result.etag);
            loaded[partNumber] = body.size;
            reportProgress();
            return;
          }
          expired = result.status === 403;
          reason = `S3 answered ${result.status}`;
        } catch (error) {
          if (error instanceof FatalPartError) throw error;
          reason = error instanceof Error ? error.message : String(error);
        }

        loaded[partNumber] = 0;
        reportProgress();
        if (attempt >= backoff.length) {
          throw new Error(`Part ${partNumber} failed after ${attempt + 1} attempts: ${reason}`);
        }
        options.onRetry?.({ partNumber, attempt: attempt + 1, reason });
        // A 403 usually means the URL expired: take a fresh one straight away.
        if (expired) forceFresh = true;
        else await sleep(backoff[attempt]);
      }
    };

    const worker = async () => {
      while (failure === null) {
        const partNumber = nextPart++;
        if (partNumber > partCount) return;
        try {
          await uploadPart(partNumber);
        } catch (error) {
          failure = failure ?? error;
          return;
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(concurrency, partCount) }, worker));
    if (failure !== null) throw failure;

    const parts: CompletedPart[] = [...etags.entries()]
      .map(([partNumber, etag]) => ({ partNumber, etag }))
      .sort((a, b) => a.partNumber - b.partNumber);
    const done = await api.complete(uploadId, parts);
    return { key: done.key || key };
  } catch (error) {
    // Free the parts already stored; a failure here must not hide the real error.
    try {
      await api.abort(uploadId);
    } catch {
      // ignored
    }
    throw error;
  }
}
