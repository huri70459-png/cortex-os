import type { MemoryProvider, ProviderHealth, ProviderRecord, SearchHit, WriteResultItem, ReadOptions } from "../contract.js";
import type { ProviderCapabilities } from "../capabilities.js";
import { assertCapable, providerError } from "../capabilities.js";
import type { ErrorClass } from "../../durability/retry.js";

/**
 * Mock REMOTE HTTP provider (acceptance: "Create a space against a mock
 * remote provider", "Simulate partial batch failure and retry only the
 * missing suffix", "Verify provider failure leaves existing spaces and
 * local metadata intact").
 *
 * Capability profile deliberately differs from local:
 * - exactWrite FALSE  (writes land asynchronously; keys assigned server-side)
 * - graph FALSE       (no relation queries)
 * - asyncWrite TRUE, delete TRUE, browse TRUE, semanticSearch TRUE,
 *   namespaces TRUE, offlineQueue TRUE
 *
 * Failure injection:
 * - failNext(n, class, status)      → next n calls throw a classified error
 * - failKeys                          → per-item partial-batch failures
 */
export interface RemoteMockOptions {
  latencyMs?: number;
  failKeys?: Set<string>;
  /** deterministic per-key failure counts: fail this key N times, then succeed */
  failKeyTimes?: Record<string, number>;
  /** override provider id/label (e.g. to register several remote mocks) */
  id?: string;
  label?: string;
}

export class MockRemoteProvider implements MemoryProvider {
  readonly id: string;
  readonly label: string;
  readonly kind = "remote-http" as const;
  readonly capabilities: ProviderCapabilities = {
    exactWrite: false, asyncWrite: true, delete: true, graph: false,
    browse: true, semanticSearch: true, namespaces: true, offlineQueue: true,
  };

  private store = new Map<string, Map<string, ProviderRecord>>(); // space -> key -> rec
  private applied = new Set<string>();
  private failQueue: { class: ErrorClass; status?: number; retryAfterMs?: number }[] = [];
  private failKeyCountdown = new Map<string, number>();
  private latency: number;
  private failKeys: Set<string>;
  calls = { write: 0, read: 0, search: 0, delete: 0, health: 0 };
  /** keys sent per write call — proves retries carry only the missing suffix */
  writeLog: string[][] = [];

  constructor(opts: RemoteMockOptions = {}) {
    this.id = opts.id ?? "mock-remote";
    this.label = opts.label ?? "Remote Memory Cloud (mock)";
    this.latency = opts.latencyMs ?? 2;
    this.failKeys = opts.failKeys ?? new Set();
    for (const [k, n] of Object.entries(opts.failKeyTimes ?? {})) this.failKeyCountdown.set(k, n);
  }

  failNext(n: number, class_: ErrorClass, status?: number, retryAfterMs?: number): void {
    for (let i = 0; i < n; i++) this.failQueue.push({ class: class_, status, retryAfterMs });
  }

  /** test helper: clear all injected failures */
  clearFailures(): void {
    this.failQueue = [];
    this.failKeys.clear();
    this.failKeyCountdown.clear();
  }

  private async delay(): Promise<void> {
    return new Promise((res) => setTimeout(res, this.latency));
  }

  private takeFailure(): { class: ErrorClass; status?: number; retryAfterMs?: number } | undefined {
    return this.failQueue.shift();
  }

  async health(): Promise<ProviderHealth> {
    this.calls.health++;
    await this.delay();
    const f = this.failQueue[0];
    if (f && (f.class === "network" || f.class === "server")) {
      return { status: "down", latencyMs: this.latency, checkedAt: new Date().toISOString(), detail: `injected ${f.class}` };
    }
    return { status: "ok", latencyMs: this.latency, checkedAt: new Date().toISOString() };
  }

  async write(space: string, records: ProviderRecord[], idempotencyKeys: string[]): Promise<WriteResultItem[]> {
    this.calls.write++;
    await this.delay();
    const f = this.takeFailure();
    if (f) {
      throw providerError(f.class, `remote write failed (injected ${f.class})`, { status: f.status, retryAfterMs: f.retryAfterMs });
    }
    const sp = this.store.get(space) ?? new Map<string, ProviderRecord>();
    this.store.set(space, sp);
    this.writeLog.push(records.map((r) => r.key));
    const results: WriteResultItem[] = [];
    for (let i = 0; i < records.length; i++) {
      const rec = records[i];
      const idem = idempotencyKeys[i];
      if (this.applied.has(idem)) { results.push({ key: rec.key, status: "duplicate", externalId: idem }); continue; }
      const countdown = this.failKeyCountdown.get(rec.key) ?? 0;
      if (countdown > 0) {
        this.failKeyCountdown.set(rec.key, countdown - 1);
        results.push({ key: rec.key, status: "failed", error: { class: "server", message: `per-item injected failure for ${rec.key} (${countdown - 1} retries left)`, status: 500 } });
        continue;
      }
      if (this.failKeys.has(rec.key)) {
        results.push({ key: rec.key, status: "failed", error: { class: "server", message: `per-item injected failure for ${rec.key}`, status: 500 } });
        continue;
      }
      sp.set(rec.key, rec);
      this.applied.add(idem);
      results.push({ key: rec.key, status: "written", externalId: `remote:${space}:${rec.key}` });
    }
    // If ANY item failed, the batch as a whole did not fully commit —
    // the queue above must retry only the missing suffix.
    return results;
  }

  async read(space: string, key: string, _opts?: ReadOptions): Promise<ProviderRecord | null> {
    assertCapable(this.capabilities, this.id, "browse", `read ${space}/${key}`);
    this.calls.read++;
    await this.delay();
    const f = this.takeFailure();
    if (f) throw providerError(f.class, `remote read failed (injected ${f.class})`, { status: f.status });
    return this.store.get(space)?.get(key) ?? null;
  }

  async search(space: string, query: string, k: number): Promise<SearchHit[]> {
    assertCapable(this.capabilities, this.id, "semanticSearch", `search ${space}`);
    this.calls.search++;
    await this.delay();
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const hits: SearchHit[] = [];
    for (const rec of this.store.get(space)?.values() ?? []) {
      const hay = `${rec.key} ${rec.content}`.toLowerCase();
      let score = 0;
      for (const t of terms) if (hay.includes(t)) score += 1;
      if (score > 0) hits.push({ key: rec.key, score: score / terms.length, snippet: rec.content.slice(0, 80) });
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, k);
  }

  async delete(space: string, key: string): Promise<void> {
    assertCapable(this.capabilities, this.id, "delete", `delete ${space}/${key}`);
    this.calls.delete++;
    await this.delay();
    this.store.get(space)?.delete(key);
  }

  async listNamespaces(): Promise<string[]> {
    assertCapable(this.capabilities, this.id, "namespaces", "listNamespaces");
    return [...this.store.keys()];
  }

  // graphNeighbors intentionally NOT implemented: capabilities.graph === false.

  /** test helper */
  count(space: string): number { return this.store.get(space)?.size ?? 0; }
}

/**
 * Mock LIMITED provider (acceptance: "Attempt unsupported graph/delete/
 * exact-write operations. Verify the UI reports 'unsupported' rather than
 * returning fake success"). Read-mostly append-only store.
 */
export class MockLimitedProvider implements MemoryProvider {
  readonly id = "mock-limited";
  readonly label = "Append-Only Vault (mock)";
  readonly kind = "remote-http" as const;
  readonly capabilities: ProviderCapabilities = {
    exactWrite: false, asyncWrite: true, delete: false, graph: false,
    browse: false, semanticSearch: true, namespaces: false, offlineQueue: false,
  };

  private store = new Map<string, ProviderRecord[]>();
  private applied = new Set<string>();

  async health(): Promise<ProviderHealth> {
    return { status: "degraded", latencyMs: 40, checkedAt: new Date().toISOString(), detail: "write-only endpoint; no browse/delete" };
  }

  async write(space: string, records: ProviderRecord[], idempotencyKeys: string[]): Promise<WriteResultItem[]> {
    const arr = this.store.get(space) ?? [];
    this.store.set(space, arr);
    const results: WriteResultItem[] = [];
    for (let i = 0; i < records.length; i++) {
      if (this.applied.has(idempotencyKeys[i])) { results.push({ key: records[i].key, status: "duplicate" }); continue; }
      arr.push(records[i]);
      this.applied.add(idempotencyKeys[i]);
      results.push({ key: records[i].key, status: "written", externalId: `vault:${arr.length - 1}` });
    }
    return results;
  }

  async read(space: string, key: string): Promise<ProviderRecord | null> {
    assertCapable(this.capabilities, this.id, "browse", `read ${space}/${key}`);
    return null; // unreachable
  }
  async search(space: string, query: string, k: number): Promise<SearchHit[]> {
    assertCapable(this.capabilities, this.id, "semanticSearch", `search ${space}`);
    const q = query.toLowerCase();
    return (this.store.get(space) ?? [])
      .filter((r) => r.content.toLowerCase().includes(q))
      .slice(0, k)
      .map((r) => ({ key: r.key, score: 1, snippet: r.content.slice(0, 80) }));
  }
  async delete(space: string, key: string): Promise<void> {
    assertCapable(this.capabilities, this.id, "delete", `delete ${space}/${key}`);
  }
  async listNamespaces(): Promise<string[]> {
    assertCapable(this.capabilities, this.id, "namespaces", "listNamespaces");
    return [];
  }
}
