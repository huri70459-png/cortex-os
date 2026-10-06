import type { SessionStore, SessionMessage } from "./store.js";
import type { DurableWriteQueue } from "../durability/queue.js";
import type { GovernedMemoryActions } from "../memory/actions.js";
import type { ActorRef } from "../core/types.js";
import { contentHash } from "../memory/dedupe.js";
import { classifyError } from "../durability/retry.js";
import type { MemoryActionReceipt } from "../memory/receipts.js";

/**
 * Commit engine (Slice 3). Grounded in the OpenViking session semantics:
 *
 *   "Commit a session and OpenViking archives it synchronously, then
 *    distills long-term memory asynchronously."
 *
 * Therefore:
 * - Phase 1 (archive) is synchronous and rides the durable queue: the
 *   session only reaches `committed` after the provider CONFIRMS the raw
 *   message archive.
 * - Phase 2 (extraction) is tracked separately (`extraction` field):
 *   pending → running → done | failed. A committed session with failed
 *   extraction is a distinct, visible state — never conflated.
 * - Extraction writes memories through the governed action pipeline, so
 *   every distilled memory has a receipt and partial failures surface as
 *   "partly-saved" with exact per-item status.
 */

export interface ExtractedMemory {
  title: string;
  content: string;
}

export type Distiller = (messages: SessionMessage[], sessionId: string) => ExtractedMemory[];

/** Default deterministic distiller: preferences + a session summary memory. */
export const heuristicDistiller: Distiller = (messages, sessionId) => {
  const out: ExtractedMemory[] = [];
  for (const m of messages) {
    if (m.role !== "user") continue;
    const pref = /\b(i (prefer|always|never|want)|convention|rule:)/i.exec(m.content);
    if (pref) {
      out.push({ title: `Preference: ${m.content.slice(0, 48)}`, content: m.content });
    }
  }
  const userTurns = messages.filter((m) => m.role === "user").length;
  out.push({
    title: `Session ${sessionId} summary`,
    content: `Session ${sessionId} covered ${userTurns} user turns. Topics: ${messages.filter((m) => m.role === "user").slice(0, 3).map((m) => m.content.slice(0, 40)).join(" | ")}`,
  });
  return out;
};

export interface CommitResult {
  sessionId: string;
  state: "committed" | "failed" | "attention-required";
  archiveQueueKey: string;
  archiveAttempts: number;
  extraction: "pending" | "running" | "done" | "failed" | "skipped";
  extractionReceipts?: MemoryActionReceipt[];
  extractionOverall?: string;
  error?: { class: string; message: string };
}

export class CommitEngine {
  constructor(
    private sessions: SessionStore,
    private queue: DurableWriteQueue,
    private actions: GovernedMemoryActions,
    private now: () => string,
    private distiller: Distiller = heuristicDistiller,
    private opts: { providerId: string; space: string } = { providerId: "mock-local", space: "session-archives" },
  ) {}

  /** Phase 1: synchronous, durable archive. Phase 2 optional via runExtraction. */
  async commit(sessionId: string): Promise<CommitResult> {
    const s = this.sessions.get(sessionId);
    this.sessions.transition(sessionId, "committing", "commit requested");

    const payloadBlob = JSON.stringify(s.messages);
    const archiveKey = this.queueKey(sessionId, payloadBlob);
    const q = await this.queue.enqueue({
      op: "session.archive",
      payload: {
        sessionId,
        providerId: this.opts.providerId,
        items: [{
          space: this.opts.space,
          record: { key: `archive:${sessionId}`, content: payloadBlob, meta: { turns: s.metrics.turns, messages: s.messages.length } },
          idempotencyKey: archiveKey,
        }],
      },
    }, archiveKey);

    if (q.state !== "acked") {
      const c = classifyError(Object.assign(new Error(q.error?.message ?? "archive failed"), { class: q.error?.class ?? "unknown" }));
      const next = c.retryable ? "failed" : "attention-required";
      this.sessions.transition(sessionId, "failed", q.error?.message);
      if (!c.retryable) this.sessions.transition(sessionId, "attention-required", `permanent failure: ${c.class}`);
      s.lastError = q.error?.message;
      s.extraction = "none";
      return { sessionId, state: next, archiveQueueKey: archiveKey, archiveAttempts: q.attempts, extraction: "skipped", error: { class: c.class, message: c.message } };
    }

    this.sessions.transition(sessionId, "committed", "phase-1 archive confirmed by provider");
    s.extraction = "pending";
    return { sessionId, state: "committed", archiveQueueKey: archiveKey, archiveAttempts: q.attempts, extraction: "pending" };
  }

  /**
   * Phase 2: asynchronous distillation. Runs AFTER commit; its failure never
   * un-commits the session (phase-1 archive is already durable).
   */
  async runExtraction(sessionId: string, initiator: ActorRef, spaceHint?: { placement?: Parameters<GovernedMemoryActions["proposeSave"]>[0]["placement"] }): Promise<CommitResult> {
    const s = this.sessions.get(sessionId);
    if (s.state !== "committed" && s.state !== "archived") {
      throw new Error(`extraction requires committed session (state=${s.state})`);
    }
    s.extraction = "running";
    const extracted = this.distiller(s.messages, sessionId);
    const proposalIds = extracted.map((e) =>
      this.actions.proposeSave({
        content: e.content,
        title: e.title,
        initiator,
        sessionId,
        correlationId: `extract:${sessionId}`,
        placement: spaceHint?.placement ?? { mode: "local-first", scope: "user" },
      }).proposalId,
    );
    const batch = await this.actions.submitBatch(proposalIds, initiator);

    const madeIds = batch.receipts.map((r) => r.after?.itemId).filter(Boolean) as string[];
    if (madeIds.length) {
      this.sessions.recordEvent(sessionId, {
        type: "memory-write", at: this.now(), sessionId,
        spaceId: batch.receipts.find((r) => r.spaceId)?.spaceId ?? "?",
        itemIds: madeIds, correlationId: `extract:${sessionId}`,
      });
    }

    s.extraction = batch.overall === "failed" ? "failed" : "done";
    return {
      sessionId,
      state: s.state === "archived" ? "committed" : "committed",
      archiveQueueKey: "",
      archiveAttempts: 0,
      extraction: s.extraction,
      extractionReceipts: batch.receipts,
      extractionOverall: batch.overall,
    };
  }

  /** committed → archived (cold, after extraction has been attempted). */
  archive(sessionId: string): void {
    this.sessions.transition(sessionId, "archived", "cold archive");
  }

  /** failed → retrying → active (retryable classes only), then re-commit. */
  async retryCommit(sessionId: string): Promise<CommitResult> {
    const s = this.sessions.get(sessionId);
    if (s.state === "attention-required") this.sessions.transition(sessionId, "retrying", "operator retry");
    else if (s.state === "failed") this.sessions.transition(sessionId, "retrying", "automatic retry");
    else throw new Error(`retryCommit requires failed/attention-required session (state=${s.state})`);
    this.sessions.transition(sessionId, "active", "retry armed");
    return this.commit(sessionId);
  }

  private queueKey(sessionId: string, blob: string): string {
    return `archive|${sessionId}|${contentHash(blob)}`;
  }
}
