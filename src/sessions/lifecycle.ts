/**
 * Session lifecycle state machine (Slice 3) — exactly the plan's machine:
 *
 *   active → committing → committed → archived
 *   active → compacting → active
 *   active → failed → retrying → active | attention-required
 *
 * Plus the minimal recovery edges needed for crash handling
 * (committing → failed when phase-1 archival fails; attention-required →
 * retrying when an operator/sweep retries).
 */

export type SessionState =
  | "active"
  | "committing"
  | "committed"
  | "archived"
  | "compacting"
  | "failed"
  | "retrying"
  | "attention-required";

const TRANSITIONS: Record<SessionState, SessionState[]> = {
  "active":             ["committing", "compacting", "failed", "archived"],
  "committing":         ["committed", "failed"],
  "committed":          ["archived", "failed"],       // extraction can still fail after commit
  "archived":           [],
  "compacting":         ["active", "failed"],
  "failed":             ["retrying", "attention-required"],
  "retrying":           ["active", "failed", "attention-required"],
  "attention-required": ["retrying", "active"],
};

export class InvalidTransitionError extends Error {
  constructor(readonly from: SessionState, readonly to: SessionState) {
    super(`invalid session transition: ${from} → ${to} (allowed: ${TRANSITIONS[from].join(", ") || "none"})`);
    this.name = "InvalidTransitionError";
  }
}

export function canTransition(from: SessionState, to: SessionState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: SessionState, to: SessionState): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}

export function allowedNext(from: SessionState): SessionState[] {
  return TRANSITIONS[from];
}
