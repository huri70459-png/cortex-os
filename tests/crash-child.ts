import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createCortexOS, MockLocalProvider } from "../src/index.js";
import type { MemoryProvider, ProviderHealth, ProviderRecord, SearchHit, WriteResultItem, ReadOptions } from "../src/providers/contract.js";
import type { ProviderCapabilities } from "../src/providers/capabilities.js";

/**
 * Crash fixture for Slice 3 acceptance:
 * "Kill the router during a queued write and recover it."
 *
 * Enqueues three durable writes through a provider that APPLIES records to
 * disk but never acknowledges (simulating a router killed after the provider
 * applied the write, before the ack reached the WAL). Then SIGKILLs itself.
 *
 * The parent test restarts against the same data dir and must show:
 * recovery replays all three, idempotency keys dedupe, zero duplicates.
 */

class NeverAckProvider implements MemoryProvider {
  readonly id = "mock-local";
  readonly label = "Local (never-ack crash fixture)";
  readonly kind = "local" as const;
  readonly capabilities: ProviderCapabilities = {
    exactWrite: true, asyncWrite: false, delete: true, graph: true,
    browse: true, semanticSearch: true, namespaces: true, offlineQueue: true,
  };

  constructor(private inner: MockLocalProvider) {}

  async health(): Promise<ProviderHealth> { return this.inner.health(); }

  write(space: string, records: ProviderRecord[], keys: string[]): Promise<WriteResultItem[]> {
    void this.inner.write(space, records, keys); // applies to disk...
    return new Promise<WriteResultItem[]>(() => { /* ...but never acks */ });
  }

  read(space: string, key: string, opts?: ReadOptions): Promise<ProviderRecord | null> { return this.inner.read(space, key, opts); }
  search(space: string, q: string, k: number): Promise<SearchHit[]> { return this.inner.search(space, q, k); }
  delete(space: string, key: string): Promise<void> { return this.inner.delete(space, key); }
  listNamespaces(): Promise<string[]> { return this.inner.listNamespaces(); }
}

async function main(): Promise<void> {
  const dataDir = process.argv[2];
  if (!dataDir) {
    console.error("usage: crash-child <dataDir>");
    process.exit(2);
  }
  const os = createCortexOS({ dataDir, queue: { backoffBaseMs: 5 } });
  os.registerProvider(new NeverAckProvider(new MockLocalProvider(join(dataDir, "local"))));

  for (const k of ["k1", "k2", "k3"]) {
    void os.queue.enqueue({
      op: "provider.write",
      payload: {
        providerId: "mock-local",
        items: [{ space: "crash-space", record: { key: k, content: `durable payload ${k}` }, idempotencyKey: `crash-test|${k}` }],
      },
    }, `crash-test|${k}`);
  }

  // Wait until the WAL holds all three queued records AND the provider has
  // applied them to disk — the exact worst-case crash window — then die hard.
  const walFile = join(dataDir, "wal.jsonl");
  const appliedFile = join(dataDir, "local", "applied-keys.jsonl");
  const deadline = Date.now() + 5000;
  for (;;) {
    const walLines = existsSync(walFile) ? readFileSync(walFile, "utf8").split("\n").filter((l) => l.includes('"queued"')).length : 0;
    const appliedLines = existsSync(appliedFile) ? readFileSync(appliedFile, "utf8").split("\n").filter((l) => l.trim()).length : 0;
    if (walLines >= 3 && appliedLines >= 3) break;
    if (Date.now() > deadline) { console.error("crash-child: timeout waiting for crash window"); process.exit(3); }
    await new Promise((r) => setTimeout(r, 5));
  }
  process.kill(process.pid, "SIGKILL");
}

void main();
