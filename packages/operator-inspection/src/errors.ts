import { z } from "zod";

export const INSPECTION_ERROR_CODES = [
  "INSPECTION_INVALID_REQUEST",
  "INSPECTION_NOT_FOUND",
  "INSPECTION_SOURCE_UNAVAILABLE",
  "INSPECTION_EVIDENCE_INVALID",
  "INSPECTION_TRACE_CORRUPT",
  "INSPECTION_LIMIT_EXCEEDED",
] as const;

export const InspectionErrorCodeSchema = z.enum(INSPECTION_ERROR_CODES);
export type InspectionErrorCode = z.infer<typeof InspectionErrorCodeSchema>;

export const InspectionErrorResponseSchema = z
  .object({
    error: z
      .object({
        code: InspectionErrorCodeSchema,
        message: z.string().min(1).max(512),
        details: z.record(z.string(), z.unknown()).optional(),
      })
      .strict(),
  })
  .strict();

export type InspectionErrorResponse = z.infer<typeof InspectionErrorResponseSchema>;

const FORBIDDEN_ERROR_DETAIL_KEYS = new Set([
  "stack",
  "prompt",
  "systemPrompt",
  "messages",
  "completion",
  "rawText",
  "outputText",
  "input",
  "output",
  "arguments",
  "result",
  "state",
  "patch",
  "workingOutput",
  "rationale",
  "reasoning",
  "subject",
  "proposedPayload",
  "headers",
  "apiKey",
  "authorization",
  "secret",
  "token",
  "password",
  "credential",
  "privateKey",
]);

function sanitizeErrorDetails(
  details?: Record<string, unknown>
): Readonly<Record<string, unknown>> | undefined {
  if (!details) {
    return undefined;
  }
  const clean: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(details)) {
    if (FORBIDDEN_ERROR_DETAIL_KEYS.has(key)) {
      continue;
    }
    if (
      val === null ||
      typeof val === "string" ||
      typeof val === "number" ||
      typeof val === "boolean"
    ) {
      clean[key] = typeof val === "string" ? val.slice(0, 256) : val;
    } else if (Array.isArray(val)) {
      clean[key] = val
        .slice(0, 32)
        .filter(
          (item) =>
            item === null ||
            typeof item === "string" ||
            typeof item === "number" ||
            typeof item === "boolean"
        );
    }
  }
  return Object.freeze(clean);
}

export class OperatorInspectionError extends Error {
  public readonly code: InspectionErrorCode;
  public readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    code: InspectionErrorCode,
    message: string,
    options?: { details?: Record<string, unknown>; cause?: unknown }
  ) {
    const boundedMessage = message.trim().slice(0, 512) || code;
    super(boundedMessage, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "OperatorInspectionError";
    this.code = code;
    this.details = sanitizeErrorDetails(options?.details);
    Object.setPrototypeOf(this, new.target.prototype);
  }

  public httpStatus(): number {
    switch (this.code) {
      case "INSPECTION_INVALID_REQUEST":
        return 400;
      case "INSPECTION_NOT_FOUND":
        return 404;
      case "INSPECTION_LIMIT_EXCEEDED":
        return 413;
      case "INSPECTION_EVIDENCE_INVALID":
      case "INSPECTION_TRACE_CORRUPT":
        return 422;
      case "INSPECTION_SOURCE_UNAVAILABLE":
        return 503;
    }
  }

  public toResponse(): InspectionErrorResponse {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details && Object.keys(this.details).length > 0
          ? { details: { ...this.details } }
          : {}),
      },
    };
  }
}

export function normalizeInspectionError(err: unknown): OperatorInspectionError {
  if (err instanceof OperatorInspectionError) {
    return err;
  }
  return new OperatorInspectionError(
    "INSPECTION_EVIDENCE_INVALID",
    "Inspection source returned invalid or unexpected evidence."
  );
}
