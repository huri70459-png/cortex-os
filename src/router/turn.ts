import type { IdFactory } from "../core/ids.js";
import { cortexUri } from "../core/ids.js";
import type { ContextStore } from "../context/store.js";
import type { SessionStore } from "../sessions/store.js";
import type { GovernedMemoryActions } from "../memory/actions.js";
import { SnapshotBuilder, estimateTokens, type RequestSnapshot, type RoutingDecision } from "../snapshots/snapshot.js";

/**
 * Minimal turn router (Tier-1 success criterion 1–4: "Route a real turn.
 * See exactly what context was assembled. Trace every injected item to its
 * source. See which model, provider, and policy made the decision.")
 *
 * The model call is mocked but usage-shaped: it reports ACTUAL prompt/
 * cached/completion tokens that deliberately differ from assembly-time
 * estimates, so the read models can prove estimates and actuals are never
 * conflated.
 */

export interface ModelUsage {
  promptTokens: number;
  cachedTokens: number;
  completionTokens: number;
  latencyMs: number;
  toolCalls: number;
}

export interface MockModel {
  id: string;
  complete(assembledText: string, opts?: { forceToolCalls?: number }): Promise<{ text: string; usage: ModelUsage }>;
}

export const PRICING: Record<string, { inputPer1k: number; outputPer1k: number; cachedPer1k: number }> = {
  "cortex-small": { inputPer1k: 0.0005, outputPer1k: 0.0015, cachedPer1k: 0.0001 },
  "cortex-large": { inputPer1k: 0.005, outputPer1k: 0.015, cachedPer1k: 0.001 },
};

export function createMockModel(id: string, seed = 42): MockModel {
  return {
    id,
    async complete(assembledText, opts) {
      // Deterministic pseudo-usage: actual prompt tokens = true char/4 of the
      // assembled text (differs from per-part rounded estimates on purpose).
      const promptTokens = Math.max(1, Math.round(assembledText.length / 4));
      const cachedTokens = Math.floor(promptTokens * 0.4); // system+tools prefix cache
      const reply = `OK(${id},${seed}): processed ${assembledText.length} chars`;
      const completionTokens = estimateTokens(reply);
      const latencyMs = 20 + (promptTokens % 30);
      return { text: reply, usage: { promptTokens, cachedTokens, completionTokens, latencyMs, toolCalls: opts?.forceToolCalls ?? (promptTokens > 2000 ? 2 : 1) } };
    },
  };
}

export function computeCost(model: string, u: ModelUsage): number {
  const p = PRICING[model] ?? PRICING["cortex-small"];
  return Number((((u.promptTokens - u.cachedTokens) / 1000) * p.inputPer1k + (u.cachedTokens / 1000) * p.cachedPer1k + (u.completionTokens / 1000) * p.outputPer1k).toFixed(6));
}

export interface RouteTurnInput {
  sessionId: string;
  userMessage: string;
  initiator: { kind: "user" | "agent"; id: string };
  forceToolCalls?: number;
  models?: MockModel[];
}

export interface RouteTurnResult {
  snapshot: RequestSnapshot;
  reply: string;
  recalledItemIds: string[];
}

export class TurnRouter {
  private models: MockModel[];

  constructor(
    private ids: IdFactory,
    private now: () => string,
    private context: ContextStore,
    private sessions: SessionStore,
    private actions: GovernedMemoryActions,
    models?: MockModel[],
  ) {
    this.models = models ?? [createMockModel("cortex-small"), createMockModel("cortex-large", 7)];
  }

  async routeTurn(input: RouteTurnInput): Promise<RouteTurnResult> {
    const t0 = Date.now();
    const session = this.sessions.get(input.sessionId);
    const requestId = this.ids.requestId();
    const correlationId = `turn:${requestId}`;

    // --- recall (governed; produces a recall receipt + network edges) -----
    const recall = await this.actions.recall(input.userMessage, input.initiator, 3, session.id, correlationId);
    if (recall.hits.length) {
      const spaceIds = [...new Set(recall.hits.map((h) => h.spaceId).filter(Boolean))] as string[];
      for (const sid of spaceIds) {
        this.sessions.recordEvent(session.id, {
          type: "memory-read", at: this.now(), sessionId: session.id, spaceId: sid,
          itemIds: recall.hits.filter((h) => h.spaceId === sid).map((h) => h.itemId),
          correlationId,
        });
      }
    }

    // --- assembly ----------------------------------------------------------
    const b = new SnapshotBuilder({ sessionId: session.id, requestId, correlationId, createdAt: this.now() });
    const assemblyStart = Date.now();

    // runtime context item for the current user message (stable ID, created
    // BEFORE assembly so the snapshot part can cite its sourceItemId)
    const runtimeItem = this.context.put({
      id: this.ids.ctxId("runtime"),
      uri: cortexUri("runtime", `${session.id}/${requestId}/user`),
      kind: "runtime",
      title: input.userMessage.slice(0, 60),
      summary: input.userMessage,
      body: input.userMessage,
      source: { provider: "local", kind: "runtime-message", label: "runtime" },
      scope: "runtime",
      retention: "session",
      relatedSessions: [session.id],
      provenance: [{ at: this.now(), actor: input.initiator, action: "turn.user-message", correlationId }],
    });

    b.add("system", `You are ${session.agentId}, model-routed by CortexRouter. Be concise and cite memories by id.`, { sourceLabel: "generated:system-prompt", cached: true });
    b.add("tools", JSON.stringify({ tools: ["memory.save", "memory.recall", "session.commit", "context.ls"] }), { sourceLabel: "generated:tool-schemas", cached: true });

    for (const hit of recall.hits) {
      const item = this.context.tryGet(hit.itemId);
      b.add("injected-context", item?.body ?? item?.summary ?? hit.title, {
        sourceItemId: hit.itemId,
        sourceLabel: item ? `${item.source.label} · ${item.title}` : `memory:${hit.itemId}`,
        layer: item?.layer ?? "L2",
      });
      if (item) {
        item.relatedSessions = [...new Set([...item.relatedSessions, session.id])];
      }
    }

    // transcript (runtime parts), oldest first; newest user message last
    const transcriptWindow = session.messages.slice(-8);
    for (const m of transcriptWindow) {
      const bucket = m.role === "user" ? "user" : m.role === "tool" ? "tool-result" : "assistant";
      const isCompaction = m.content.startsWith("[compacted");
      b.add(bucket, m.content, {
        sourceLabel: `session:${session.id}:${m.role}`,
        compactionMarker: isCompaction || undefined,
      });
    }
    b.add("user", input.userMessage, { sourceItemId: runtimeItem.id, sourceLabel: `session:${session.id}:user(current)` });


    // --- routing decision (capability/budget aware, deterministic policy) --
    const estTokens = b.estimatedInput();
    const model = estTokens > 1800 ? this.models[1] ?? this.models[0] : this.models[0];
    const decision: RoutingDecision = {
      policy: "token-budget-v1",
      model: model.id,
      providerId: "mock-model-gateway",
      reason: estTokens > 1800
        ? `estimated ${estTokens} tokens > 1800 threshold → large model`
        : `estimated ${estTokens} tokens ≤ 1800 threshold → small model`,
    };

    // --- provider call ------------------------------------------------------
    const assembledText = b.assembledPreview();
    const providerStart = Date.now();
    const completion = await model.complete(assembledText + input.userMessage, { forceToolCalls: input.forceToolCalls });
    const providerMs = Date.now() - providerStart;
    const assemblyMs = providerStart - assemblyStart;

    const cost = computeCost(model.id, completion.usage);
    const snap = b.build(decision, { assemblyMs, providerMs, totalMs: Date.now() - t0 }, {
      promptTokens: completion.usage.promptTokens,
      cachedTokens: completion.usage.cachedTokens,
      completionTokens: completion.usage.completionTokens,
    }, cost);

    // output part carries ACTUAL completion tokens (never an estimate)
    const outPart = snap.parts.find((p) => p.bucket === "output");
    if (!outPart) {
      snap.parts.push({
        partId: `part_${snap.parts.length + 1}`, bucket: "output",
        sourceLabel: `generated:${model.id}`, estimatedTokens: 0,
        actualTokens: completion.usage.completionTokens,
      });
    }

    // --- persistence + links ------------------------------------------------
    const snapItem = this.context.put({
      id: snap.id,
      uri: cortexUri("runtime", `${session.id}/requests/${requestId}`),
      kind: "snapshot",
      title: `Request ${requestId}`,
      summary: `${snap.parts.length} parts · est ${snap.estimatedTokens.input} tok · actual ${snap.actual?.promptTokens ?? "?"} tok`,
      source: { provider: "local", kind: "request-snapshot", label: "CortexRouter audit log" },
      scope: "runtime",
      retention: "durable",
      relatedSessions: [session.id],
      provenance: [{ at: this.now(), actor: { kind: "system", id: "router" }, action: "turn.assemble", correlationId }],
      links: [{ rel: "session", target: session.id }],
      meta: { snapshot: snap, runtimeItemId: runtimeItem.id },
    });
    for (const p of snap.parts) {
      if (p.sourceItemId) this.context.link(snapItem.id, "cites", p.sourceItemId, p.sourceLabel);
    }

    // session bookkeeping
    this.sessions.addMessage(session.id, { role: "user", content: input.userMessage, at: this.now(), tokens: estimateTokens(input.userMessage) });
    this.sessions.addMessage(session.id, { role: "assistant", content: completion.text, at: this.now(), tokens: completion.usage.completionTokens });
    this.sessions.addTurn(session.id, {
      requestId,
      tokens: { prompt: completion.usage.promptTokens, completion: completion.usage.completionTokens, cached: completion.usage.cachedTokens },
      cost, latencyMs: completion.usage.latencyMs, toolCalls: completion.usage.toolCalls,
    });

    return { snapshot: snap, reply: completion.text, recalledItemIds: recall.hits.map((h) => h.itemId) };
  }
}
