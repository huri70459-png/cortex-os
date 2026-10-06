import { existsSync, mkdirSync, readFileSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import type { MemoryProvider, ProviderHealth, ProviderRecord, SearchHit, WriteResultItem, ReadOptions } from "../contract.js";
import type { ProviderCapabilities } from "../capabilities.js";
import { assertCapable } from "../capabilities.js";

/**
 * Mock LOCAL provider (Phase 3 item 11: "Local provider adapter").
 * Full capabilities, durable JSONL-per-space storage under a data directory.
 * Maintains an applied-idempotency-key set so replayed writes return
 * "duplicate" instead of creating second copies.
 */
export class MockLocalProvider implements MemoryProvider {
  readonly id = "mock-local";
  readonly label = "Local Store (mock)";
  readonly kind = "local" as const;
  readonly capabilities: ProviderCapabilities = {
    exactWrite: true, asyncWrite: false, delete: true, graph: true,
    browse: true, semanticSearch: true, namespaces: true, offlineQueue: true,
  };

  private applied = new Set<string>();     // idempotency keys already applied
  private relations = new Map<string, { key: string; rel: string }[]>();

  constructor(private dir: string) {
    mkdirSync(dir, { recursive: true });
    // rehydrate idempotency set so duplicates stay duplicates across restarts
    const f = this.metaFile();
    if (existsSync(f)) {
      for (const line of readFileSync(f, "utf8").split("\n")) {
        if (line.trim()) {
          try { this.applied.add((JSON.parse(line) as { key: string }).key); } catch { /* torn */ }
        }
      }
    }
  }

  private spaceFile(space: string) { return join(this.dir, `space_${space.replace(/[^a-z0-9_-]/gi, "_")}.jsonl`); }
  private metaFile() { return join(this.dir, "applied-keys.jsonl"); }

  private readAll(space: string): ProviderRecord[] {
    const f = this.spaceFile(space);
    if (!existsSync(f)) return [];
    const out: ProviderRecord[] = [];
    const latest = new Map<string, ProviderRecord>();
    for (const line of readFileSync(f, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line) as ProviderRecord & { tombstone?: boolean };
        if (rec.tombstone) latest.delete(rec.key); else latest.set(rec.key, rec);
      } catch { /* torn line */ }
    }
    out.push(...latest.values());
    return out;
  }

  async health(): Promise<ProviderHealth> {
    return { status: "ok", latencyMs: 1, checkedAt: new Date().toISOString() };
  }

  async write(space: string, records: ProviderRecord[], idempotencyKeys: string[]): Promise<WriteResultItem[]> {
    assertCapable(this.capabilities, this.id, "exactWrite", `write to ${space}`);
    if (records.length !== idempotencyKeys.length) throw new Error("idempotencyKeys must be parallel to records");
    const results: WriteResultItem[] = [];
    for (let i = 0; i < records.length; i++) {
      const rec = records[i];
      const idem = idempotencyKeys[i];
      if (this.applied.has(idem)) {
        results.push({ key: rec.key, status: "duplicate", externalId: idem });
        continue;
      }
      appendFileSync(this.spaceFile(space), JSON.stringify(rec) + "\n");
      appendFileSync(this.metaFile(), JSON.stringify({ key: idem }) + "\n");
      this.applied.add(idem);
      results.push({ key: rec.key, status: "written", externalId: `local:${space}:${rec.key}` });
    }
    return results;
  }

  async read(space: string, key: string, _opts?: ReadOptions): Promise<ProviderRecord | null> {
    assertCapable(this.capabilities, this.id, "browse", `read ${space}/${key}`);
    return this.readAll(space).find((r) => r.key === key) ?? null;
  }

  async search(space: string, query: string, k: number): Promise<SearchHit[]> {
    assertCapable(this.capabilities, this.id, "semanticSearch", `search ${space}`);
    const q = query.toLowerCase();
    const terms = q.split(/\s+/).filter(Boolean);
    return this.readAll(space)
      .map((r) => {
        const hay = `${r.key} ${r.content} ${JSON.stringify(r.meta ?? {})}`.toLowerCase();
        let score = 0;
        for (const t of terms) if (hay.includes(t)) score += 1;
        return { key: r.key, score: score / Math.max(1, terms.length), snippet: r.content.slice(0, 80) };
      })
      .filter((h) => h.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }

  async delete(space: string, key: string): Promise<void> {
    assertCapable(this.capabilities, this.id, "delete", `delete ${space}/${key}`);
    appendFileSync(this.spaceFile(space), JSON.stringify({ key, content: "", tombstone: true }) + "\n");
  }

  async listNamespaces(): Promise<string[]> {
    assertCapable(this.capabilities, this.id, "namespaces", "listNamespaces");
    return [];
  }

  async graphNeighbors(space: string, key: string, depth: number): Promise<{ key: string; rel: string }[]> {
    assertCapable(this.capabilities, this.id, "graph", `graph ${space}/${key}`);
    void depth;
    return this.relations.get(`${space}/${key}`) ?? [];
  }

  addRelation(space: string, key: string, rel: { key: string; rel: string }): void {
    const k = `${space}/${key}`;
    this.relations.set(k, [...(this.relations.get(k) ?? []), rel]);
  }

  /** test helper: raw record count including nothing tombstoned */
  count(space: string): number { return this.readAll(space).length; }
}

export function createLocalMockProvider(dir: string): MockLocalProvider {
  mkdirSync(dirname(dir), { recursive: true });
  return new MockLocalProvider(dir);
}
