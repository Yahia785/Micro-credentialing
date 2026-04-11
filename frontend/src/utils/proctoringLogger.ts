/**
 * Client-side proctoring telemetry logger.
 *
 * Buffers structured events in memory during a recording session, then flushes
 * them in a single POST to /proctoring/client-logs after the upload completes
 * (whether it succeeded or failed). Stored server-side on the submission record
 * so they can be retrieved when debugging missing recordings.
 *
 * Usage:
 *   proctoringLogger.init(submissionId);
 *   proctoringLogger.log('recording_started', 'info', { mimeType });
 *   await proctoringLogger.flush(sendClientLogs);
 */

export interface LogEntry {
  timestamp: string;
  event: string;
  level: 'info' | 'warn' | 'error';
  data?: Record<string, unknown>;
}

class ProctoringLogger {
  private logs: LogEntry[] = [];
  private submissionId: string | null = null;

  /** Call once per submission, before recording starts. */
  init(submissionId: string) {
    this.logs = [];
    this.submissionId = submissionId;

    // Capture browser environment at session start — critical for diagnosing
    // mimeType failures or missing MediaRecorder support
    const mediaSupport: Record<string, boolean> = {};
    if (typeof MediaRecorder !== 'undefined') {
      mediaSupport['video/webm;codecs=vp9'] = MediaRecorder.isTypeSupported('video/webm;codecs=vp9');
      mediaSupport['video/webm;codecs=vp8'] = MediaRecorder.isTypeSupported('video/webm;codecs=vp8');
      mediaSupport['video/webm'] = MediaRecorder.isTypeSupported('video/webm');
    }

    this.log('session_init', 'info', {
      submissionId,
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      mediaRecorderAvailable: typeof MediaRecorder !== 'undefined',
      mediaSupport,
      connectionType: (navigator as any).connection?.effectiveType ?? 'unknown',
    });
  }

  /**
   * Record a single event. Also mirrors to console so it shows in DevTools
   * without needing to open the network panel.
   */
  log(event: string, level: 'info' | 'warn' | 'error' = 'info', data?: Record<string, unknown>) {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      event,
      level,
      data,
    };
    this.logs.push(entry);

    const msg = `[proctoring] ${event}`;
    if (level === 'error') {
      console.error(msg, data);
    } else if (level === 'warn') {
      console.warn(msg, data);
    } else {
      console.log(msg, data);
    }
  }

  getSubmissionId() {
    return this.submissionId;
  }

  getLogs(): LogEntry[] {
    return [...this.logs];
  }

  /**
   * Send buffered logs to the backend and reset state.
   * Accepts the `sendClientLogs` API function as a parameter to avoid a
   * circular import between this utility and the API layer.
   *
   * This intentionally never throws — telemetry must not affect the user-visible
   * submission flow.
   */
  async flush(
    sendFn: (payload: { submissionId: string; logs: LogEntry[] }) => Promise<void>
  ): Promise<void> {
    if (!this.submissionId || this.logs.length === 0) return;

    const payload = {
      submissionId: this.submissionId,
      logs: this.getLogs(),
    };

    try {
      await sendFn(payload);
      console.log('[proctoring] client logs flushed to server');
    } catch (err) {
      // Non-critical — telemetry failure must not surface to the user
      console.error('[proctoring] failed to flush client logs (non-critical):', err);
    }

    this.logs = [];
    this.submissionId = null;
  }
}

// Singleton — one logger shared across the recording session
export const proctoringLogger = new ProctoringLogger();
