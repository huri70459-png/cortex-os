/**
 * CortexOS — unified context operating system prototype for CortexRouter.
 *
 * Wires the Tier-1 foundation into one object graph:
 *   Slice 1: ContextStore (normalized ContextItem model + hierarchy)
 *   Slice 2: ProviderRegistry, capabilities, placement policies, spaces
 *   Slice 3: WAL + DurableWriteQueue + recovery, session lifecycle, commit,
 *            pre-compaction capture
 *   Slice 6: GovernedMemoryActions + durable receipts
 *   Read models (4/5): insights, context browser, agent network
 *
 * Standalone by design: zero runtime deps, injectable clock, file-backed
 * durability under a data directory — ready to be merged into CortexRouter
 * as the core package behind its existing UI routes.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { SystemClock, type Clock } from "./core/clock.js";
import { createIdFactory, type IdFactory } from "./core/ids.js";
import { RedactionVault } from "./core/redaction.js";
import { ContextStore } from "./context/store.js";
import { ProviderRegistry } from "./providers/registry.js";
import { WriteAheadLog } from "./durability/wal.js";
import { DurableWriteQueue, type QueueOptions } from "./durability/queue.js";
import { SpaceStore, type MemorySpace } from "./memory/spaces.js";
import { ReceiptLog } from "./memory/receipts.js";
import { GovernedMemoryActions } from "./memory/actions.js";
import { SessionStore } from "./sessions/store.js";
import { CommitEngine, heuristicDistiller, type Distiller } from "./sessions/commit.js";
import { CompactionEngine, naiveSummarizer, type Summarizer } from "./sessions/compaction.js";
import { TurnRouter, createMockModel, type MockModel } from "./router/turn.js";
import { buildInsights, type Insights, type DateRange } from "./readmodel/insights.js";
import { buildBrowserView, type BrowserView } from "./readmodel/browser.js";
import { buildAgentNetwork, collapseCompleted, type AgentNetwork } from "./readmodel/network.js";
import type { RequestSnapshot } from "./snapshots/snapshot.js";
import type { MemoryProvider } from "./providers/contract.js";
import type { PlacementMode } from "./providers/placement.js";

export * from "./core/types.js";
export * from "./core/clock.js";
export * from "./core/ids.js";
export * from "./core/redaction.js";
export * from "./context/store.js";
export * from "./providers/capabilities.js";
export * from "./providers/contract.js";
export * from "./providers/registry.js";
export * from "./providers/placement.js";
export * from "./providers/mocks/local.js";
export * from "./providers/mocks/remote.js";
export * from "./durability/wal.js";
export * from "./durability/queue.js";
export * from "./durability/retry.js";
export * from "./memory/spaces.js";
export * from "./memory/receipts.js";
export * from "./memory/dedupe.js";
export * from "./memory/actions.js";
export * from "./sessions/lifecycle.js";
export * from "./sessions/store.js";
export * from "./sessions/commit.js";
export * from "./sessions/compaction.js";
export * from "./snapshots/snapshot.js";
export * from "./router/turn.js";
export * from "./readmodel/insights.js";
export * from "./readmodel/browser.js";
export * from "./readmodel/network.js";

export interface CortexOSOptions {
  dataDir: string;
  clock?: Clock;
  ids?: IdFactory;
  queue?: QueueOptions;
  distiller?: Distiller;
  summarizer?: Summarizer;
  models?: MockModel[];
  archive?: { providerId: string; space: string };
}

export interface SpaceInit {
  id: string;
  title: string;
  providerId: string;
  scope: MemorySpace["scope"];
  placement: PlacementMode;
  kind?: MemorySpace["kind"];
  compliance?: MemorySpace["compliance"];
}

export class CortexOS {
  readonly clock: Clock;
  readonly ids: IdFactory;
  readonly vault: RedactionVault;
  readonly context: ContextStore;
  readonly registry: ProviderRegistry;
  readonly spaces: SpaceStore;
  readonly receipts: ReceiptLog;
  readonly wal: WriteAheadLog;
  readonly queue: DurableWriteQueue;
  readonly actions: GovernedMemoryActions;
  readonly sessions: SessionStore;
  readonly commit: CommitEngine;
  readonly compaction: CompactionEngine;
  readonly router: TurnRouter;
  readonly dataDir: string;

  private snapshots: RequestSnapshot[] = [];

  constructor(opts: CortexOSOptions) {
    this.dataDir = opts.dataDir;
    mkdirSync(this.dataDir, { recursive: true });
    this.clock = opts.clock ?? new SystemClock();
    this.ids = opts.ids ?? createIdFactory();
    this.vault = new RedactionVault();
    const now = () => this.clock.iso();

    this.context = new ContextStore(now);
    this.registry = new ProviderRegistry(this.vault, now);
    this.spaces = new SpaceStore();
    this.receipts = new ReceiptLog(join(this.dataDir, "receipts.jsonl"), this.vault, now);
    this.wal = new WriteAheadLog({ file: join(this.dataDir, "wal.jsonl") });
    this.queue = new DurableWriteQueue(this.wal, this.registry, opts.queue ?? { backoffBaseMs: 5, backoffCapMs: 200 });
    this.actions = new GovernedMemoryActions(this.ids, now, this.receipts, this.spaces, this.registry, this.queue, this.context);
    this.sessions = new SessionStore(now);
    this.commit = new CommitEngine(this.sessions, this.queue, this.actions, now, opts.distiller ?? heuristicDistiller, opts.archive ?? { providerId: "mock-local", space: "session-archives" });
    this.compaction = new CompactionEngine(this.sessions, this.queue, now, opts.summarizer ?? naiveSummarizer, opts.archive ?? { providerId: "mock-local", space: "session-archives" });
    this.router = new TurnRouter(this.ids, now, this.context, this.sessions, this.actions, opts.models ?? [createMockModel("cortex-small"), createMockModel("cortex-large", 7)]);
  }

  // ------------------------------------------------------------- providers

  registerProvider(provider: MemoryProvider, creds?: Record<string, string>): void {
    this.registry.register(provider, creds);
    this.context.put({
      id: `ctx_provider_${provider.id}`,
      uri: `cortex://provider/${provider.id}`,
      kind: "space",
      title: provider.label,
      summary: `provider ${provider.id} (${provider.kind})`,
      source: { provider: provider.id, kind: "provider-catalog", label: provider.label },
      scope: "provider",
      retention: "durable",
      meta: { providerDescriptor: true },
      provenance: [{ at: this.clock.iso(), actor: { kind: "system", id: "registry" }, action: "provider.register" }],
    });
  }

  createSpace(init: SpaceInit): MemorySpace {
    const provider = this.registry.get(init.providerId); // throws if unknown
    const space = this.spaces.create({
      id: init.id,
      title: init.title,
      kind: init.kind ?? (provider.kind === "local" ? "local" : "provider-backed"),
      scope: init.scope,
      providerId: init.providerId,
      placement: init.placement,
      status: "inactive", // activated ONLY on confirmed write
      compliance: init.compliance,
      createdAt: this.clock.iso(),
      itemIds: [],
    });
    this.context.put({
      id: space.id,
      uri: `cortex://${space.scope}/spaces/${space.id}`,
      kind: "space",
      title: space.title,
      summary: `${space.placement} placement on ${provider.label} — inactive until first confirmed write`,
      source: { provider: provider.id, kind: "memory-space", label: provider.label },
      scope: space.scope,
      retention: "durable",
      capabilities: {
        readable: provider.capabilities.browse || provider.capabilities.semanticSearch,
        writable: true,
        deletable: provider.capabilities.delete,
        archivable: true,
        linkable: true,
      },
      meta: { spaceKind: space.kind, placement: space.placement, status: space.status },
      provenance: [{ at: this.clock.iso(), actor: { kind: "system", id: "spaces" }, action: "space.create" }],
    });
    return space;
  }

  // -------------------------------------------------------------- sessions

  createSession(init: { role?: "main" | "subagent" | "task"; agentId: string; model: string; parentId?: string; task?: string }) {
    const id = this.ids.sessionId(init.role ?? "main");
    const rec = this.sessions.create({ id, role: init.role ?? "main", agentId: init.agentId, model: init.model, parentId: init.parentId, task: init.task });
    this.context.put({
      id,
      uri: `cortex://runtime/sessions/${id}`,
      kind: "session",
      title: `${init.agentId} · ${init.role ?? "main"}`,
      summary: init.task ?? `session ${id}`,
      source: { provider: "local", kind: "session", label: "CortexRouter runtime" },
      scope: "runtime",
      retention: "session",
      provenance: [{ at: this.clock.iso(), actor: { kind: "system", id: "sessions" }, action: "session.create" }],
      links: init.parentId ? [{ rel: "parent", target: init.parentId }] : [],
      meta: { role: rec.role, model: rec.model },
    });
    return rec;
  }

  // ------------------------------------------------------------ turn route

  async routeTurn(input: Parameters<TurnRouter["routeTurn"]>[0]) {
    const res = await this.router.routeTurn(input);
    this.snapshots.push(res.snapshot);
    return res;
  }

  getSnapshots(sessionId?: string): RequestSnapshot[] {
    return sessionId ? this.snapshots.filter((s) => s.sessionId === sessionId) : [...this.snapshots];
  }

  // ------------------------------------------------------------ read models

  insights(range: DateRange = {}, budget?: number): Insights {
    return buildInsights(this.snapshots, this.sessions, range, budget);
  }

  browser(requestId: string): BrowserView | undefined {
    const idx = this.snapshots.findIndex((s) => s.requestId === requestId);
    if (idx < 0) return undefined;
    const sessionSnaps = this.snapshots.filter((s) => s.sessionId === this.snapshots[idx].sessionId);
    const pos = sessionSnaps.indexOf(this.snapshots[idx]);
    return buildBrowserView(this.snapshots[idx], pos > 0 ? sessionSnaps[pos - 1] : undefined);
  }

  network(opts: { collapseCompleted?: boolean } = {}): AgentNetwork {
    const net = buildAgentNetwork(this.sessions);
    return opts.collapseCompleted ? collapseCompleted(net) : net;
  }

  // ------------------------------------------------------- recovery/shutdown

  /** Startup recovery sweep — call right after constructing CortexOS. */
  async recover() {
    const health = await this.registry.refreshHealth();
    const receipts = await this.queue.recover();
    return { health, receipts, stats: { ...this.queue.stats } };
  }

  /** Graceful shutdown: drain in-flight durable writes (commit-on-exit). */
  async shutdown() {
    await this.queue.flush();
  }

  /** Records needing operator attention (permanent failures). */
  attention() {
    return {
      queue: this.queue.needsAttention(),
      sessions: this.sessions.list().filter((s) => s.state === "attention-required" || s.state === "failed"),
      extractionFailed: this.sessions.list().filter((s) => s.extraction === "failed"),
    };
  }
}

export function createCortexOS(opts: CortexOSOptions): CortexOS {
  return new CortexOS(opts);
}
