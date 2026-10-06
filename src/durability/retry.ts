/**
 * Error classification for the durable queue (Slice 3):
 * "Retry classes for network, 408, 429, and 5xx. No retry for permanent
 * authorization or validation errors."
 */

export type ErrorClass =
  | "network"       // connection reset, DNS, socket hang up
  | "timeout"       // HTTP 408 / request timeout
  | "rate-limit"    // HTTP 429
  | "server"        // HTTP 5xx
  | "auth"          // HTTP 401/403 — permanent
  | "validation"    // HTTP 400/422 — permanent
  | "unsupported"   // capability gate — permanent, must surface as "unsupported"
  | "conflict"      // HTTP 409 — permanent for our purposes (idempotency handled separately)
  | "unknown";

export interface ProviderError extends Error {
  class: ErrorClass;
  status?: number;
  retryAfterMs?: number;
  /** provider-side detail for structured receipts */
  detail?: Record<string, unknown>;
}

export function providerError(class_: ErrorClass, message: string, opts: { status?: number; retryAfterMs?: number; detail?: Record<string, unknown> } = {}): ProviderError {
  const e = new Error(message) as ProviderError;
  e.class = class_;
  e.status = opts.status;
  e.retryAfterMs = opts.retryAfterMs;
  e.detail = opts.detail;
  return e;
}

export function isRetryable(class_: ErrorClass): boolean {
  return class_ === "network" || class_ === "timeout" || class_ === "rate-limit" || class_ === "server";
}

export function classifyError(err: unknown): { class: ErrorClass; retryable: boolean; status?: number; retryAfterMs?: number; message: string } {
  const e = err as Partial<ProviderError> & { message?: string };
  const cls: ErrorClass = e?.class ?? "unknown";
  return {
    class: cls,
    retryable: isRetryable(cls),
    status: e?.status,
    retryAfterMs: e?.retryAfterMs,
    message: e?.message ?? String(err),
  };
}

/** Exponential backoff with jitter, capped; honors Retry-After when present. */
export function backoffDelayMs(attempt: number, opts: { baseMs?: number; capMs?: number; retryAfterMs?: number } = {}): number {
  const base = opts.baseMs ?? 50;
  const cap = opts.capMs ?? 30_000;
  if (opts.retryAfterMs != null) return Math.min(cap, Math.max(opts.retryAfterMs, base));
  const exp = Math.min(cap, base * 2 ** Math.max(0, attempt - 1));
  const jitter = exp * 0.2 * Math.random();
  return Math.floor(exp + jitter);
}
