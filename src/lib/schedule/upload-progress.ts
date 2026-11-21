/**
 * Pure, dependency-free derivation of real-time upload progress for Weekly Schedule UI.
 *
 * Strict accuracy guarantees:
 *  - Never generates fake percentages, timers, or interpolated values.
 *  - Reports an integer percentage ONLY when backed by real byte counters
 *    (`uploadedBytes` / `totalBytes`), a live platform-reported upload percentage,
 *    or a genuinely completed upload.
 *  - Uses `"indeterminate"` mode whenever an upload is active without an exact percentage.
 *  - Shows `100%` ONLY after upload bytes have actually finished arriving.
 *  - Keeps `awaitingScheduleConfirmation = true` ("Scheduling" / "Confirming schedule")
 *    until the platform confirms the scheduled post.
 */

export type UploadProgressMode = "determinate" | "indeterminate" | "complete" | "idle" | "halted";

export interface UploadProgressInput {
  /** Mapped JobView status ("SCHEDULED" | "PUBLISHING" | "PLATFORM_SCHEDULED" | "POSTED" | "FAILED" | "AWAITING_HUMAN" | "DRAFT" | "CANCELLED") */
  status: string;
  /** Underlying PublishJob.status ("QUEUED" | "PREPARING" | "UPLOADING" | "SCHEDULING" | "SCHEDULED" | "PUBLISHED" | ...) */
  sourceStatus?: string | null;
  /** Validated persisted platform receipt ("scheduled" | "posted" | null) */
  confirmation?: "scheduled" | "posted" | null;
  /** Actual bytes acknowledged by the upload transport */
  uploadedBytes?: number | null;
  /** Actual total media size in bytes */
  totalBytes?: number | null;
  /** Real-time progress log written by the active publisher */
  progressText?: string | null;
  /** True when the platform holds a native future schedule */
  nativeSchedule?: boolean;
  /** True when no remote upload/draft/session exists yet */
  preUpload?: boolean;
}

export interface UploadProgressReading {
  mode: UploadProgressMode;
  /** Exact 0..100 integer when known from real upload events; null when indeterminate or unknown */
  percent: number | null;
  /** Concise human-readable upload/scheduling stage */
  stage: string | null;
  /** True when upload is underway/finished for a native schedule that is still awaiting platform confirmation */
  awaitingScheduleConfirmation: boolean;
  /** Which chip label a running job should show ("Publishing" | "Scheduling" | "Confirming schedule") */
  activeLabel: "Publishing" | "Scheduling" | "Confirming schedule" | null;
}

const STUDIO_UPLOAD_PCT =
  /(?:Uploading(?:\s+the\s+video)?\s*\((\d{1,3})%\)|\bUploading\s+(\d{1,3})\s*%|\b(\d{1,3})\s*%\s*uploaded\b)/i;

const UPLOAD_BYTES_FINISHED =
  /(The video is uploaded|YouTube is processing the video|YouTube is checking the video|YouTube has finished its checks|checks are still running; the upload itself is done|^6\.\s*Pressing\b|^7\.\s*Reading the saved video|^Pressing\s+(?:Publish|Save|Schedule)\b|^Instagram 6\.\s*Pressing Schedule\b)/i;

const CONFIRMING_SCHEDULE_TEXT =
  /(^6\.\s*Pressing\s+Schedule\b|^7\.\s*Reading the saved video|^Instagram 6\.\s*Pressing Schedule\b)/i;

function validBytePair(uploadedBytes: number | null | undefined, totalBytes: number | null | undefined): boolean {
  return (
    typeof uploadedBytes === "number" &&
    Number.isFinite(uploadedBytes) &&
    uploadedBytes >= 0 &&
    typeof totalBytes === "number" &&
    Number.isFinite(totalBytes) &&
    totalBytes > 0
  );
}

export function deriveUploadProgress(input: UploadProgressInput): UploadProgressReading {
  const {
    status,
    sourceStatus,
    confirmation,
    uploadedBytes,
    totalBytes,
    progressText,
    nativeSchedule = false,
    preUpload,
  } = input;

  // 1. Platform-confirmed scheduled or posted outcome: upload and confirmation are 100% complete.
  if (
    (status === "PLATFORM_SCHEDULED" && confirmation === "scheduled") ||
    (status === "POSTED" && confirmation === "posted")
  ) {
    return {
      mode: "complete",
      percent: 100,
      stage: null,
      awaitingScheduleConfirmation: false,
      activeLabel: null,
    };
  }

  // 2. Platform status recorded without a verified receipt: never claim 100% or Scheduled.
  if (status === "PLATFORM_SCHEDULED" || status === "POSTED") {
    return {
      mode: "halted",
      percent: null,
      stage: null,
      awaitingScheduleConfirmation: false,
      activeLabel: null,
    };
  }

  // 3. Active in-flight upload / scheduling pass.
  const isRunning =
    status === "PUBLISHING" ||
    sourceStatus === "PREPARING" ||
    sourceStatus === "UPLOADING" ||
    sourceStatus === "SCHEDULING";

  if (isRunning) {
    const text = (progressText ?? "").trim();
    const hasBytes = validBytePair(uploadedBytes, totalBytes);
    const bytesComplete = hasBytes && (uploadedBytes as number) >= (totalBytes as number);
    const textShowsUploadComplete = UPLOAD_BYTES_FINISHED.test(text);
    const uploadComplete = bytesComplete || textShowsUploadComplete;

    let percent: number | null = null;
    if (uploadComplete) {
      percent = 100;
    } else if (hasBytes) {
      const ratio = Math.max(0, Math.min(uploadedBytes as number, totalBytes as number)) / (totalBytes as number);
      // Never round up to 100% while bytes are still in flight.
      percent = Math.min(99, Math.floor(ratio * 100));
    } else {
      const match = STUDIO_UPLOAD_PCT.exec(text);
      if (match) {
        const raw = Number(match[1] ?? match[2] ?? match[3]);
        if (Number.isFinite(raw)) {
          // Hold at <= 99% during active "Uploading" lines; 100% appears once upload finishes.
          percent = Math.max(0, Math.min(99, Math.floor(raw)));
        }
      }
    }

    let stage: string;
    let confirming = false;

    if (sourceStatus === "SCHEDULING" || CONFIRMING_SCHEDULE_TEXT.test(text)) {
      stage = "Confirming schedule";
      confirming = true;
    } else if (/^6\.\s*Pressing\b|^Pressing\s+(?:Publish|Save)\b/i.test(text)) {
      stage = "Confirming publication";
    } else if (/^5\.\s*Setting\s+scheduled\b|^Instagram 5\.\s*Selecting\b/i.test(text)) {
      stage = uploadComplete ? "Confirming schedule" : "Scheduling";
      confirming = uploadComplete;
    } else if (/^5\.\s*Setting\b/i.test(text)) {
      stage = "Setting visibility";
    } else if (/YouTube has finished its checks/i.test(text)) {
      stage = nativeSchedule ? "Confirming schedule" : "Checks complete";
      confirming = nativeSchedule;
    } else if (/YouTube is checking|checks are still running/i.test(text)) {
      stage = "Running platform checks";
      confirming = nativeSchedule;
    } else if (/The video is uploaded|YouTube is processing/i.test(text)) {
      stage = "Processing uploaded video";
      confirming = nativeSchedule;
    } else if (bytesComplete) {
      stage = nativeSchedule ? "Confirming schedule" : "Finalizing upload";
      confirming = nativeSchedule;
    } else if (/^4\.\s*Filling\b|^Instagram 4\.\s*Filling\b/i.test(text)) {
      stage = "Applying video details";
    } else if (/^3\.\s*Reading existing video|Resuming the verified Studio draft/i.test(text)) {
      stage = "Inspecting existing draft";
    } else if (
      /Uploading the video|3\.\s*Uploading\b|^Instagram 3\.\s*Opening Create and uploading\b/i.test(text) ||
      sourceStatus === "UPLOADING"
    ) {
      stage = "Uploading video";
    } else if (/3\.\s*Opening Create\b/i.test(text)) {
      stage = "Opening upload dialog";
    } else if (/Reviewing the stored video script|Audience review/i.test(text)) {
      stage = "Reviewing audience & tags";
    } else if (/2\.\s*Verifying\b|Channel verified|^Instagram 2\.\s*Inspecting\b/i.test(text)) {
      stage = "Verifying account";
    } else if (/1\.\s*Opening Studio\b|^Instagram 1\.\s*Opening\b/i.test(text)) {
      stage = "Opening platform";
    } else if (sourceStatus === "PREPARING") {
      stage = "Preparing upload";
    } else {
      stage = nativeSchedule ? "Scheduling" : "Publishing";
    }

    const activeLabel: UploadProgressReading["activeLabel"] = confirming
      ? "Confirming schedule"
      : nativeSchedule
        ? "Scheduling"
        : "Publishing";

    return {
      mode: percent !== null ? "determinate" : "indeterminate",
      percent,
      stage,
      awaitingScheduleConfirmation: nativeSchedule && (confirming || uploadComplete),
      activeLabel,
    };
  }

  // 4. Queued and waiting to start: zero bytes sent yet.
  if (status === "SCHEDULED") {
    return {
      mode: "idle",
      percent: preUpload === false ? null : 0,
      stage: nativeSchedule ? "Queued for upload" : "Waiting for scheduled time",
      awaitingScheduleConfirmation: false,
      activeLabel: null,
    };
  }

  // 5. Failed, held, paused, cancelled, or awaiting human review.
  let haltedPercent: number | null = null;
  if (validBytePair(uploadedBytes, totalBytes) && (uploadedBytes as number) > 0) {
    const ratio = Math.min(uploadedBytes as number, totalBytes as number) / (totalBytes as number);
    haltedPercent = (uploadedBytes as number) >= (totalBytes as number) ? 100 : Math.min(99, Math.floor(ratio * 100));
  } else if (preUpload === true && status === "FAILED") {
    haltedPercent = 0;
  }

  return {
    mode: "halted",
    percent: haltedPercent,
    stage: null,
    awaitingScheduleConfirmation: false,
    activeLabel: null,
  };
}
