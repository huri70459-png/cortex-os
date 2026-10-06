import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, fsyncSync, openSync, closeSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Append-only write-ahead log (Slice 3: "on-disk write queue",
 * "cursor-based replay", "partial-write receipts").
 *
 * Durability rules:
 * - Records are JSON lines; a torn last line (crash mid-append) is ignored
 *   on scan — it was never acknowledged.
 * - State transitions are APPENDED as new lines with the same key
 *   (last-line-wins fold), so we never rewrite history in place.
 * - Every append is fsync'd before the enqueue call returns, so
 *   "enqueued" means "on disk" even if the process dies next instruction.
 */

export type WalRecordState = "queued" | "acked" | "failed-retryable" | "failed-permanent" | "skipped";

export interface WalRecord<T = unknown> {
  seq: number;
  key: string;                 // idempotency key (stable across retries)
  batchId?: string;            // groups items written as one batch
  state: WalRecordState;
  op: string;                  // e.g. "memory.write", "session.archive", "session.extract"
  payload: T;
  attempts: number;
  enqueuedAt: string;
  updatedAt: string;
  lastError?: { class: string; message: string; status?: number };
  result?: unknown;            // provider ack (per-item results for batches)
}

export interface WalOptions {
  file: string;
}

export class WriteAheadLog {
  private seq = 0;
  readonly file: string;

  constructor(opts: WalOptions) {
    this.file = opts.file;
    mkdirSync(dirname(this.file), { recursive: true });
    if (!existsSync(this.file)) {
      const fd = openSync(this.file, "a");
      closeSync(fd);
    }
    // Initialize seq from existing content so restarts keep monotonic order.
    for (const r of this.scan().values()) this.seq = Math.max(this.seq, r.seq);
  }

  private appendLine(obj: unknown): void {
    appendFileSync(this.file, JSON.stringify(obj) + "\n", "utf8");
    const fd = openSync(this.file, "r");
    try { fsyncSync(fd); } finally { closeSync(fd); }
  }

  enqueue<T>(init: Omit<WalRecord<T>, "seq" | "state" | "attempts" | "enqueuedAt" | "updatedAt"> & { state?: WalRecordState }): WalRecord<T> {
    const now = new Date().toISOString();
    const rec: WalRecord<T> = {
      seq: ++this.seq,
      state: init.state ?? "queued",
      attempts: 0,
      enqueuedAt: now,
      updatedAt: now,
      key: init.key,
      batchId: init.batchId,
      op: init.op,
      payload: init.payload,
    };
    this.appendLine(rec);
    return rec;
  }

  /** Append a state transition for an existing key (never rewrites history). */
  transition<T>(prev: WalRecord<T>, state: WalRecordState, patch: { attempts?: number; lastError?: WalRecord<T>["lastError"]; result?: unknown } = {}): WalRecord<T> {
    const rec: WalRecord<T> = {
      ...prev,
      ...patch,
      attempts: patch.attempts ?? prev.attempts,
      seq: ++this.seq,
      state,
      updatedAt: new Date().toISOString(),
    };
    this.appendLine(rec);
    return rec;
  }

  /** Fold the log to latest-state-per-key. Torn trailing lines are ignored. */
  scan(): Map<string, WalRecord> {
    const out = new Map<string, WalRecord>();
    if (!existsSync(this.file)) return out;
    const raw = readFileSync(this.file, "utf8");
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        const rec = JSON.parse(t) as WalRecord;
        const prev = out.get(rec.key);
        if (!prev || rec.seq >= prev.seq) out.set(rec.key, rec);
      } catch {
        // torn write from a crash mid-append: not acknowledged, ignore.
      }
    }
    return out;
  }

  /** Records needing replay after a crash/restart, in enqueue order. */
  uncommitted(): WalRecord[] {
    return [...this.scan().values()]
      .filter((r) => r.state === "queued" || r.state === "failed-retryable")
      .sort((a, b) => a.seq - b.seq);
  }

  /** Rotate the log (e.g. after a full checkpoint), preserving a copy. */
  checkpoint(): void {
    if (existsSync(this.file)) renameSync(this.file, this.file + `.${Date.now()}.ckpt`);
    this.seq = 0;
    const fd = openSync(this.file, "a");
    closeSync(fd);
  }

  static join(dir: string, name = "wal.jsonl"): string { return join(dir, name); }
}
