import type { ProviderCapabilities } from "./capabilities.js";

/**
 * The provider contract (Slice 2, Phase 3 item 13: "Remote HTTP provider
 * contract"). Local, filesystem-style, and remote HTTP providers all
 * implement this same surface; mock providers implement it for tests.
 */

export interface ProviderRecord {
  key: string;                       // space-relative stable key
  content: string;
  meta?: Record<string, unknown>;    // must never contain credentials
}

export type WriteItemStatus = "written" | "duplicate" | "failed";

export interface WriteResultItem {
  key: string;
  status: WriteItemStatus;
  externalId?: string;               // provider-side id
  error?: { class: string; message: string; status?: number };
}

export interface SearchHit {
  key: string;
  score: number;
  snippet?: string;
}

export type ProviderHealthStatus = "ok" | "degraded" | "down";

export interface ProviderHealth {
  status: ProviderHealthStatus;
  latencyMs: number;
  checkedAt: string;
  detail?: string;
}

export interface ReadOptions {
  layer?: "L0" | "L1" | "L2";        // progressive loading hint
}

export interface MemoryProvider {
  readonly id: string;
  readonly label: string;
  readonly kind: "local" | "filesystem" | "remote-http";
  readonly capabilities: ProviderCapabilities;

  health(): Promise<ProviderHealth>;

  /**
   * Batch write. `idempotencyKeys` is parallel to `records` — a record whose
   * key was already applied must return status "duplicate", never a second
   * copy (Slice 3: "duplicate messages are not created").
   * Partial failure is expressed per item; the queue retries only the
   * missing suffix.
   */
  write(space: string, records: ProviderRecord[], idempotencyKeys: string[]): Promise<WriteResultItem[]>;

  /** Exact read; requires `browse`. */
  read(space: string, key: string, opts?: ReadOptions): Promise<ProviderRecord | null>;

  /** Semantic search; requires `semanticSearch`. */
  search(space: string, query: string, k: number): Promise<SearchHit[]>;

  /** Remote delete; requires `delete`. Soft-delete semantics live above this. */
  delete(space: string, key: string): Promise<void>;

  /** Namespace listing; requires `namespaces`. */
  listNamespaces(): Promise<string[]>;

  /** Graph query; requires `graph`. */
  graphNeighbors?(space: string, key: string, depth: number): Promise<{ key: string; rel: string }[]>;
}
