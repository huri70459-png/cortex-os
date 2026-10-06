import type { WriteAheadLog, WalRecord } from "./wal.js";
import { backoffDelayMs, classifyError, isRetryable } from "./retry.js";
import type { MemoryProvider, ProviderRecord, WriteResultItem } from "../providers/contract.js";
import type { ProviderRegistry } from "../providers/registry.js";

/**
 * Durable write queue (Slice 3).
 *
 * Guarantees:
 * 1. enqueue() returns only after the intent is fsync'd to the WAL —
 *    a crash afterwards is recoverable ("Kill the router during a queued
 *    write and recover it").
 * 2. Every dispatch carries idempotency keys; providers dedupe, so replay
 *    never creates duplicates ("Verify duplicate messages are not created").
 * 3. Partial batch failures retry ONLY the missing items with their original
 *    keys ("Simulate partial batch failure and retry only the missing suffix").
 * 4. Retry classes: network/408/429/5xx retry with backoff; auth/validation
 *    failures go straight to failed-permanent → attention-required.
 * 5. recover() on startup replays every uncommitted record in seq order.
 * 6. flush() on graceful shutdown drains in-flight work and fsyncs.
 */

export interface WriteOpItem {
  space: string;
  record: ProviderRecord;
  idempotencyKey: string;
}

export interface WriteOpPayload {
  providerId: string;
  items: WriteOpItem[];
}

export type QueueOp =
  | { op: "provider.write"; payload: WriteOpPayload }
  | { op: "session.archive"; payload: { sessionId: string; providerId: string; items: WriteOpItem[] } }
  | { op: "session.extract"; payload: { sessionId: string; providerId: string; items: WriteOpItem[] } };

export interface QueueReceipt {
  key: string;
  op: string;
  state: WalRecord["state"];
  attempts: number;
  perItem: WriteResultItem[];
  error?: { class: string; message: string; status?: number };
  enqueuedAt: string;
  finishedAt?: string;
}

export interface QueueOptions {
  maxAttempts?: number;         // per record; default 5
  backoffBaseMs?: number;       // default 50 (tests keep this tiny)
  backoffCapMs?: number;        // default 30s
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class DurableWriteQueue {
  private inFlight = new Map<string, Promise<QueueReceipt>>();
  private maxAttempts: number;
  private backoffBaseMs: number;
  private backoffCapMs: number;
  private sleep: (ms: number) => Promise<void>;
  /** counters surfaced in the recovery UI */
  stats = { enqueued: 0, dispatched: 0, acked: 0, duplicates: 0, retried: 0, permanentFailures: 0, recovered: 0 };

  constructor(
    private wal: WriteAheadLog,
    private registry: ProviderRegistry,
    opts: QueueOptions = {},
  ) {
    this.maxAttempts = opts.maxAttempts ?? 5;
    this.backoffBaseMs = opts.backoffBaseMs ?? 50;
    this.backoffCapMs = opts.backoffCapMs ?? 30_000;
    this.sleep = opts.sleep ?? defaultSleep;
  }

  /** Persist intent to WAL, then dispatch. Safe to await or fire-and-forget. */
  enqueue(op: QueueOp, key: string): Promise<QueueReceipt> {
    const existing = this.inFlight.get(key);
    if (existing) return existing; // same logical write in progress — never double-dispatch
    const rec = this.wal.enqueue<QueueOp["payload"]>({ key, op: op.op, payload: op.payload });
    this.stats.enqueued++;
    const p = this.dispatchLoop(rec, op.op).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, p);
    return p;
  }

  /** Startup recovery sweep: replay every uncommitted record in order. */
  async recover(): Promise<QueueReceipt[]> {
    const pending = this.wal.uncommitted();
    const out: QueueReceipt[] = [];
    for (const rec of pending) {
      this.stats.recovered++;
      out.push(await this.dispatchLoop(rec, rec.op));
    }
    return out;
  }

  /** Graceful shutdown: drain in-flight dispatches (WAL is already durable). */
  async flush(): Promise<void> {
    await Promise.allSettled([...this.inFlight.values()]);
  }

  /** Records that exhausted retries or hit permanent errors. */
  needsAttention(): WalRecord[] {
    return [...this.wal.scan().values()].filter((r) => r.state === "failed-permanent");
  }

  private async dispatchLoop(rec: WalRecord, opName: string): Promise<QueueReceipt> {
    let current = rec;
    let attempt = current.attempts;
    let lastError: { class: string; message: string; status?: number } | undefined;

    while (attempt < this.maxAttempts) {
      attempt++;
      this.stats.dispatched++;
      try {
        const { perItem, remaining } = await this.executeOnce(opName, current.payload as WriteOpPayload);
        if (remaining.length === 0) {
          current = this.wal.transition(current, "acked", { attempts: attempt, result: perItem });
          this.stats.acked++;
          for (const it of perItem) if (it.status === "duplicate") this.stats.duplicates++;
          return this.receipt(current, perItem);
        }
        // Partial failure: narrow the record to the missing suffix and retry
        // with ORIGINAL idempotency keys (provider dedupes any that landed).
        lastError = { class: "server", message: `partial batch failure: ${remaining.length}/${perItem.length} items failed`, status: 500 };
        const narrowed: WalRecord = this.wal.transition(
          { ...current, payload: { ...(current.payload as WriteOpPayload), items: remaining } },
          "failed-retryable",
          { attempts: attempt, lastError, result: perItem },
        );
        current = narrowed;
        this.stats.retried++;
      } catch (err) {
        const c = classifyError(err);
        lastError = { class: c.class, message: c.message, status: c.status };
        if (!isRetryable(c.class)) {
          current = this.wal.transition(current, "failed-permanent", { attempts: attempt, lastError });
          this.stats.permanentFailures++;
          return this.receipt(current, [], lastError);
        }
        current = this.wal.transition(current, "failed-retryable", { attempts: attempt, lastError });
        this.stats.retried++;
      }
      if (attempt < this.maxAttempts) {
        await this.sleep(backoffDelayMs(attempt, { baseMs: this.backoffBaseMs, capMs: this.backoffCapMs, retryAfterMs: lastError?.class === "rate-limit" ? 10 : undefined }));
      }
    }
    // Exhausted retries → attention-required, never silently dropped.
    current = this.wal.transition(current, "failed-permanent", { attempts: attempt, lastError });
    this.stats.permanentFailures++;
    return this.receipt(current, [], lastError);
  }

  /**
   * One provider round-trip for the record's REMAINING items.
   * Returns per-item results and the still-missing suffix.
   */
  private async executeOnce(opName: string, payload: WriteOpPayload): Promise<{ perItem: WriteResultItem[]; remaining: WriteOpItem[] }> {
    const provider: MemoryProvider = this.registry.get(payload.providerId);
    if (!this.registry.isEnabled(payload.providerId)) {
      throw Object.assign(new Error(`provider disabled: ${payload.providerId}`), { class: "network" });
    }
    void opName; // archive/extract ride the same provider.write path in the prototype
    const results = await provider.write(
      payload.items[0]?.space ?? "",
      payload.items.map((i) => i.record),
      payload.items.map((i) => i.idempotencyKey),
    );
    const byKey = new Map(results.map((r) => [r.key, r]));
    const remaining: WriteOpItem[] = [];
    for (const item of payload.items) {
      const r = byKey.get(item.record.key);
      if (!r || r.status === "failed") remaining.push(item);
    }
    return { perItem: results, remaining };
  }

  private receipt(rec: WalRecord, perItem: WriteResultItem[], error?: { class: string; message: string; status?: number }): QueueReceipt {
    return {
      key: rec.key,
      op: rec.op,
      state: rec.state,
      attempts: rec.attempts,
      perItem,
      error: error ?? rec.lastError,
      enqueuedAt: rec.enqueuedAt,
      finishedAt: rec.updatedAt,
    };
  }
}
