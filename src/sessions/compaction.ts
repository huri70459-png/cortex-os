import type { SessionStore, SessionMessage } from "./store.js";
import type { DurableWriteQueue } from "../durability/queue.js";
import { contentHash } from "../memory/dedupe.js";

/**
 * Compaction with pre-compaction capture (Slice 3):
 * "Simulate compaction and verify pre-compaction data is committed first."
 *
 * Rule: the raw messages are written through the durable queue and must be
 * ACKED before the in-memory transcript is replaced by the summary. If the
 * capture fails, the session goes to `failed` and the transcript is left
 * untouched — compaction never destroys uncommitted data.
 */

export type Summarizer = (messages: SessionMessage[]) => string;

export const naiveSummarizer: Summarizer = (messages) => {
  const users = messages.filter((m) => m.role === "user").map((m) => m.content.slice(0, 60));
  return `[compacted ${messages.length} messages] Topics: ${users.slice(0, 5).join(" | ")}`;
};

export interface CompactionResult {
  sessionId: string;
  state: "active" | "failed";
  captureKey?: string;
  removedMessages: number;
  summary?: string;
  error?: string;
}

export class CompactionEngine {
  constructor(
    private sessions: SessionStore,
    private queue: DurableWriteQueue,
    private now: () => string,
    private summarizer: Summarizer = naiveSummarizer,
    private opts: { providerId: string; space: string } = { providerId: "mock-local", space: "session-archives" },
  ) {}

  async compact(sessionId: string): Promise<CompactionResult> {
    const s = this.sessions.get(sessionId);
    this.sessions.transition(sessionId, "compacting", "compaction requested");

    const blob = JSON.stringify(s.messages);
    const captureKey = `precompact|${sessionId}|${contentHash(blob)}`;

    // 1. Pre-compaction capture MUST be durable first.
    const q = await this.queue.enqueue({
      op: "session.archive",
      payload: {
        providerId: this.opts.providerId,
        sessionId,
        items: [{
          space: this.opts.space,
          record: { key: `precompact:${sessionId}`, content: blob, meta: { kind: "pre-compaction-capture", messages: s.messages.length } },
          idempotencyKey: captureKey,
        }],
      },
    }, captureKey);

    if (q.state !== "acked") {
      this.sessions.transition(sessionId, "failed", `pre-compaction capture failed: ${q.error?.message ?? q.state}`);
      return { sessionId, state: "failed", captureKey, removedMessages: 0, error: `pre-compaction capture failed: ${q.error?.message ?? "not acked"}; transcript untouched` };
    }

    // 2. Only now replace the transcript with the summary + marker.
    const summary = this.summarizer(s.messages);
    const removed = s.messages.length;
    s.messages = [{ role: "assistant", content: summary, at: this.now(), tokens: Math.ceil(summary.length / 4) }];
    this.sessions.transition(sessionId, "active", `compacted ${removed} messages (capture ${captureKey})`);
    return { sessionId, state: "active", captureKey, removedMessages: removed, summary };
  }
}
