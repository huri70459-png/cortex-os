import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { RedactionVault } from "../core/redaction.js";
import type { ActorKind } from "../core/types.js";

/**
 * Memory action receipts (Slice 6). Every save/update/archive/delete/merge/
 * recall/placement action produces a durable, searchable receipt.
 *
 * Action states — exactly the Tier-1 plan list:
 *   proposed approved running saved updated submitted partly-saved
 *   skipped failed reverted
 */

export type MemoryActionState =
  | "proposed" | "approved" | "running" | "saved" | "updated"
  | "submitted" | "partly-saved" | "skipped" | "failed" | "reverted";

export type MemoryActionType =
  | "save" | "update" | "archive" | "delete" | "merge" | "recall" | "placement";

export interface ReceiptCandidate {
  content: string;
  title?: string;
  /** content hash used for duplicate detection */
  hash: string;
  editedFromHash?: string;    // set when the user edited before submission
}

export interface PolicyDecision {
  policy: string;             // e.g. "duplicate-detection", "placement", "retention"
  outcome: "allow" | "deny" | "rewrite" | "require-edit";
  reason: string;
}

export interface MemoryActionReceipt {
  receiptId: string;
  action: MemoryActionType;
  state: MemoryActionState;
  candidate: ReceiptCandidate;
  initiator: { kind: ActorKind; id: string; label?: string };
  policyDecisions: PolicyDecision[];
  providerId?: string;
  spaceId?: string;
  before?: { itemId?: string; hash?: string; retention?: string };
  after?: { itemId?: string; hash?: string; retention?: string; externalId?: string };
  result?: {
    /** per-record status for partial provider writes */
    perItem?: { key: string; status: string; error?: string }[];
    message?: string;
  };
  retry?: { attempts: number; retryable: boolean; nextAction: "retry" | "attention" | "none" };
  correlationId?: string;     // ties to request/turn
  links: { sessionId?: string; snapshotId?: string; itemId?: string; duplicateOf?: string; queueKey?: string };
  createdAt: string;
  updatedAt: string;
}

/** Durable JSONL receipt log, redacted on write, searchable by many keys. */
export class ReceiptLog {
  private file: string;
  constructor(file: string, private vault: RedactionVault, private now: () => string) {
    this.file = file;
    mkdirSync(dirname(this.file), { recursive: true });
  }

  append(receipt: MemoryActionReceipt): MemoryActionReceipt {
    const clean = this.vault.redactDeep(receipt);
    appendFileSync(this.file, JSON.stringify(clean) + "\n", "utf8");
    return clean;
  }

  /** All receipts, folded to latest per receiptId. */
  all(): MemoryActionReceipt[] {
    if (!existsSync(this.file)) return [];
    const latest = new Map<string, MemoryActionReceipt>();
    for (const line of readFileSync(this.file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as MemoryActionReceipt;
        const prev = latest.get(r.receiptId);
        if (!prev || r.updatedAt >= prev.updatedAt) latest.set(r.receiptId, r);
      } catch { /* torn */ }
    }
    return [...latest.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  bySession(sessionId: string): MemoryActionReceipt[] {
    return this.all().filter((r) => r.links.sessionId === sessionId);
  }

  byCorrelation(correlationId: string): MemoryActionReceipt[] {
    return this.all().filter((r) => r.correlationId === correlationId);
  }

  byId(receiptId: string): MemoryActionReceipt | undefined {
    return this.all().find((r) => r.receiptId === receiptId);
  }

  byItem(itemId: string): MemoryActionReceipt[] {
    return this.all().filter((r) => r.links.itemId === itemId || r.after?.itemId === itemId);
  }

  get nowIso(): string { return this.now(); }
}
