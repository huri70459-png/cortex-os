import { randomBytes } from "node:crypto";
import type { ContextKind, ContextScope } from "./types.js";

/**
 * Stable ID generation. IDs are opaque but kind-prefixed so logs and UI can
 * never mistake one class of object for another:
 *   ctx_memory_k3j9x2..., ses_main_..., req_..., rcpt_...
 */

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz"; // no i/l/o/u — readable in terminals

export interface IdFactory {
  ctxId(kind: ContextKind): string;
  sessionId(role: "main" | "subagent" | "task"): string;
  requestId(): string;
  receiptId(prefix: string): string;
  idempotencyKey(...parts: string[]): string;
}

function entropy(n = 10): string {
  const b = randomBytes(n);
  let s = "";
  for (let i = 0; i < n; i++) s += ALPHABET[b[i] % ALPHABET.length];
  return s;
}

export function createIdFactory(): IdFactory {
  return {
    ctxId: (kind) => `ctx_${kind}_${entropy()}`,
    sessionId: (role) => `ses_${role}_${entropy(8)}`,
    requestId: () => `req_${entropy(10)}`,
    receiptId: (prefix) => `${prefix}_${entropy(8)}`,
    /** Deterministic key so the same logical write never duplicates. */
    idempotencyKey: (...parts) => parts.join("|"),
  };
}

/** cortex://{scope}/{path} — mirrors viking:// stable addressing. */
export function cortexUri(scope: ContextScope | string, path: string): string {
  const clean = path.replace(/^\/+/, "");
  return `cortex://${scope}/${clean}`;
}

export function parseCortexUri(uri: string): { scope: string; path: string } | null {
  const m = /^cortex:\/\/([^/]+)\/(.*)$/.exec(uri);
  return m ? { scope: m[1], path: m[2] } : null;
}
