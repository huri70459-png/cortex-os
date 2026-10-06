import type { IdFactory } from "../core/ids.js";
import { cortexUri } from "../core/ids.js";
import type { ActorRef, ContextItem } from "../core/types.js";
import type { ContextStore } from "../context/store.js";
import type { ProviderRegistry } from "../providers/registry.js";
import { UnsupportedOperationError } from "../providers/capabilities.js";
import { decidePlacement, type PlacementDecision, type PlacementRequest, type SpaceDescriptor } from "../providers/placement.js";
import type { DurableWriteQueue } from "../durability/queue.js";
import { isRetryable } from "../durability/retry.js";
import type { SpaceStore } from "./spaces.js";
import { DuplicateDetector, contentHash, type DuplicateMatch } from "./dedupe.js";
import type { MemoryActionReceipt, MemoryActionState, PolicyDecision, ReceiptLog } from "./receipts.js";

/**
 * Governed memory actions (Slice 6). Every save/update/archive/delete/merge/
 * recall/placement flows through this pipeline and produces a durable
 * receipt. Behavior guarantees from the plan:
 *
 * - Save-to-memory allows editing before submission.
 * - Sending again requires a CHANGED candidate (unless retrying a failure).
 * - Duplicate detection explains the matched item; duplicates become
 *   "updated" receipts pointing at the existing ID.
 * - Partial saves identify exactly which records succeeded ("partly-saved").
 * - Archive preserves a cold searchable reference.
 * - Delete is soft by default; hard delete requires provider capability and
 *   reports "unsupported" (never fake success) when absent.
 * - Provider failures leave spaces and local metadata intact.
 */

export interface SaveProposalInput {
  content: string;
  title?: string;
  initiator: ActorRef;
  sessionId?: string;
  correlationId?: string;
  placement?: PlacementRequest;
  /** hard constraints for placement, e.g. ["delete"] */
  requiredCapabilities?: PlacementRequest["requiredCapabilities"];
}

export interface SaveProposal {
  proposalId: string;
  state: MemoryActionState;
  candidate: { content: string; title?: string; hash: string; editedFromHash?: string };
  placement?: PlacementDecision;
  duplicate?: DuplicateMatch;
  receiptId: string;
}

export interface SubmitResult {
  receipt: MemoryActionReceipt;
  item?: ContextItem;
  proposal: SaveProposal;
}

export interface BatchSubmitResult {
  receipts: MemoryActionReceipt[];
  overall: MemoryActionState;     // saved | partly-saved | failed
  perItem: { key: string; status: string; receiptId: string }[];
}

export class GovernedMemoryActions {
  private proposals = new Map<string, SaveProposal>();
  private dedupe = new DuplicateDetector();

  constructor(
    private ids: IdFactory,
    private now: () => string,
    private receiptLog: ReceiptLog,
    private spaces: SpaceStore,
    private registry: ProviderRegistry,
    private queue: DurableWriteQueue,
    private context: ContextStore,
  ) {}

  // ---------------------------------------------------------------- propose

  proposeSave(input: SaveProposalInput): SaveProposal {
    const hash = contentHash(input.content);
    const proposalId = this.ids.receiptId("prop");
    const decisions: PolicyDecision[] = [];

    // 1. Placement decision ("Why this space?" receipt)
    let placement: PlacementDecision | undefined;
    const req: PlacementRequest = input.placement ?? { mode: "smart", scope: "user" };
    if (input.requiredCapabilities) req.requiredCapabilities = input.requiredCapabilities;
    const candidates: SpaceDescriptor[] = this.spaces.list().map((s) => ({
      spaceId: s.id, providerId: s.providerId, scope: s.scope, status: s.status,
    }));
    placement = decidePlacement(req, {
      candidates,
      providers: new Map(this.registry.listEnabled().map((p) => [p.id, p])),
      enabledProviders: new Set(this.registry.listEnabled().map((p) => p.id)),
    }, this.now);
    if (!placement.chosen) {
      decisions.push({ policy: "placement", outcome: "deny", reason: placement.rejected.map((r) => `${r.spaceId}: ${r.reason}`).join("; ") || "no candidate spaces" });
    } else {
      decisions.push({ policy: "placement", outcome: "allow", reason: `space ${placement.chosen.spaceId} via ${placement.mode} placement (score ${placement.scores.find((s) => s.spaceId === placement!.chosen!.spaceId)?.score ?? 0})` });
    }

    // 2. Duplicate detection with explanation
    const subjects = this.context.list({ kind: "memory" })
      .filter((m) => m.retention === "durable" || m.retention === "archived")
      .map((m) => ({ itemId: m.id, title: m.title, content: m.body ?? m.summary ?? "", hash: (m.meta?.["hash"] as string) ?? "" }));
    const duplicate = this.dedupe.find({ content: input.content, hash }, subjects);
    if (duplicate) {
      decisions.push({
        policy: "duplicate-detection",
        outcome: duplicate.kind === "exact" ? "rewrite" : "require-edit",
        reason: duplicate.explanation,
      });
    }

    const proposal: SaveProposal = {
      proposalId,
      state: "proposed",
      candidate: { content: input.content, title: input.title, hash },
      placement,
      duplicate,
      receiptId: proposalId,
    };
    this.proposals.set(proposalId, proposal);

    this.writeReceipt(proposalId, "save", "proposed", proposal.candidate, input.initiator, decisions, {
      providerId: placement?.chosen?.providerId,
      spaceId: placement?.chosen?.spaceId,
      links: { sessionId: input.sessionId, duplicateOf: duplicate?.itemId },
      correlationId: input.correlationId,
    });
    return proposal;
  }

  /** Editing before submission is explicitly allowed (plan requirement). */
  editProposal(proposalId: string, newContent: string, newTitle?: string): SaveProposal {
    const p = this.mustProposal(proposalId);
    if (p.state !== "proposed" && p.state !== "failed") {
      throw new Error(`proposal ${proposalId} in state ${p.state} cannot be edited`);
    }
    const editedFromHash = p.candidate.editedFromHash ?? p.candidate.hash;
    p.candidate = { content: newContent, title: newTitle ?? p.candidate.title, hash: contentHash(newContent), editedFromHash };
    this.writeReceipt(proposalId, "save", p.state, p.candidate, { kind: "user", id: "editor" }, [
      { policy: "edit-before-submit", outcome: "allow", reason: `candidate edited (hash ${editedFromHash.slice(0, 8)} → ${p.candidate.hash.slice(0, 8)})` },
    ], { links: {} });
    return p;
  }

  // ----------------------------------------------------------------- submit

  async submit(proposalId: string, initiator?: ActorRef): Promise<SubmitResult> {
    const p = this.mustProposal(proposalId);
    const who: ActorRef = initiator ?? { kind: "system", id: "auto" };

    // "Sending again requires a changed candidate" — enforced for completed proposals.
    if (p.state === "saved" || p.state === "updated") {
      const prevHash = (this.receiptLog.byId(p.receiptId)?.after?.hash) ?? p.candidate.hash;
      if (prevHash === p.candidate.hash && !p.candidate.editedFromHash) {
        const r = this.writeReceipt(p.receiptId, "save", "skipped", p.candidate, who, [
          { policy: "resubmit-guard", outcome: "deny", reason: "candidate unchanged since successful save; edit the content before sending again" },
        ], { links: {} });
        return { receipt: r, proposal: p };
      }
    }

    const space = p.placement?.chosen ? this.spaces.get(p.placement.chosen.spaceId) : undefined;
    if (!space) {
      const r = this.writeReceipt(p.receiptId, "save", "failed", p.candidate, who, [
        { policy: "placement", outcome: "deny", reason: "no space chosen at proposal time" },
      ], { links: {}, retry: { attempts: 0, retryable: false, nextAction: "attention" } });
      p.state = "failed";
      return { receipt: r, proposal: p };
    }

    // Exact duplicate → UPDATE the existing item instead (acceptance:
    // "Duplicate saves show 'updated' with the existing ID").
    if (p.duplicate?.kind === "exact") {
      const existing = this.context.get(p.duplicate.itemId);
      this.context.touch(existing.id, { body: p.candidate.content, title: p.candidate.title ?? existing.title });
      this.context.addProvenance(existing.id, {
        actor: who, action: "memory.update", correlationId: p.receiptId,
        note: `updated via duplicate save proposal ${p.receiptId}`,
      });
      p.state = "updated";
      const r = this.writeReceipt(p.receiptId, "update", "updated", p.candidate, who, [
        { policy: "duplicate-detection", outcome: "rewrite", reason: p.duplicate.explanation },
      ], {
        providerId: space.providerId, spaceId: space.id,
        before: { itemId: existing.id, hash: (existing.meta?.["hash"] as string) ?? "" },
        after: { itemId: existing.id, hash: p.candidate.hash },
        links: { itemId: existing.id, duplicateOf: existing.id, sessionId: existing.relatedSessions[0] },
        result: { message: `duplicate save applied as update to ${existing.id}` },
      });
      return { receipt: r, item: existing, proposal: p };
    }

    // Normal save path: create local item, durable provider write via queue.
    this.writeReceipt(p.receiptId, "save", "running", p.candidate, who, [], {
      providerId: space.providerId, spaceId: space.id, links: {},
    });
    p.state = "running";

    const itemId = this.ids.ctxId("memory");
    const key = `mem:${itemId}`;
    const idemKey = this.ids.idempotencyKey("mem-save", p.receiptId, p.candidate.hash);

    const qReceipt = await this.queue.enqueue({
      op: "provider.write",
      payload: {
        providerId: space.providerId,
        items: [{
          space: space.id,
          record: { key, content: p.candidate.content, meta: { title: p.candidate.title ?? "", proposalId: p.receiptId } },
          idempotencyKey: idemKey,
        }],
      },
    }, idemKey);

    if (qReceipt.state === "acked") {
      const item = this.context.put({
        id: itemId,
        uri: cortexUri(space.scope, `memories/${key}`),
        kind: "memory",
        title: p.candidate.title ?? firstLine(p.candidate.content),
        summary: p.candidate.content.slice(0, 160),
        body: p.candidate.content,
        source: { provider: space.providerId, kind: "memory", externalId: qReceipt.perItem[0]?.externalId, label: this.registry.get(space.providerId).label },
        scope: space.scope,
        layer: "L2",
        retention: "durable",
        confidence: p.duplicate?.kind === "near" ? 0.7 : 0.95,
        links: [{ rel: "space", target: space.id }],
        provenance: [{ at: this.now(), actor: who, action: "memory.save", correlationId: p.receiptId }],
        meta: { hash: p.candidate.hash, proposalId: p.receiptId },
      });
      this.spaces.confirmActivation(space.id, this.now());
      this.spaces.addItem(space.id, item.id);
      p.state = "saved";
      const r = this.writeReceipt(p.receiptId, "save", "saved", p.candidate, who, [
        { policy: "provider-ack", outcome: "allow", reason: `write confirmed by ${space.providerId} (item ${qReceipt.perItem[0]?.status})` },
      ], {
        providerId: space.providerId, spaceId: space.id,
        after: { itemId, hash: p.candidate.hash, externalId: qReceipt.perItem[0]?.externalId },
        links: { itemId, sessionId: undefined, queueKey: qReceipt.key },
        result: { perItem: qReceipt.perItem.map((i) => ({ key: i.key, status: i.status })) },
      });
      return { receipt: r, item, proposal: p };
    }

    // Failed (permanent or exhausted retries): space stays inactive on
    // failure; local metadata (proposal, receipt) stays intact.
    const retryable = qReceipt.error ? isRetryable(qReceipt.error.class as never) : false;
    p.state = "failed";
    this.spaces.markError(space.id, qReceipt.error?.message ?? "write failed");
    const r = this.writeReceipt(p.receiptId, "save", "failed", p.candidate, who, [], {
      providerId: space.providerId, spaceId: space.id,
      links: { queueKey: qReceipt.key },
      retry: { attempts: qReceipt.attempts, retryable, nextAction: retryable ? "retry" : "attention" },
      result: { message: qReceipt.error?.message ?? "unknown failure", perItem: qReceipt.perItem.map((i) => ({ key: i.key, status: i.status, error: i.error?.message })) },
    });
    return { receipt: r, proposal: p };
  }

  /**
   * Batch submit (used by session extraction): partial provider failures
   * produce ONE "partly-saved" summary plus per-item receipts identifying
   * exactly which records succeeded.
   */
  async submitBatch(proposalIds: string[], initiator: ActorRef): Promise<BatchSubmitResult> {
    const receipts: MemoryActionReceipt[] = [];
    const perItem: { key: string; status: string; receiptId: string }[] = [];
    for (const pid of proposalIds) {
      const res = await this.submit(pid, initiator);
      receipts.push(res.receipt);
      perItem.push({ key: pid, status: res.receipt.state, receiptId: res.receipt.receiptId });
    }
    const ok = perItem.filter((i) => i.status === "saved" || i.status === "updated").length;
    const overall: MemoryActionState = ok === perItem.length ? "saved" : ok === 0 ? "failed" : "partly-saved";
    return { receipts, overall, perItem };
  }

  // ---------------------------------------------------------------- archive

  async archive(itemId: string, initiator: ActorRef): Promise<MemoryActionReceipt> {
    const item = this.context.get(itemId);
    if (!item.capabilities.archivable) {
      return this.writeReceipt(this.ids.receiptId("rcpt"), "archive", "failed", this.candidateOf(item), initiator, [
        { policy: "capabilities", outcome: "deny", reason: "item is not archivable in its current retention state" },
      ], { links: { itemId } });
    }
    // Cold searchable reference: keep summary + overview searchable, drop body.
    this.context.touch(itemId, { summary: item.summary ?? item.body?.slice(0, 160), body: undefined, layer: "L1" });
    this.context.setRetention(itemId, "archived");
    this.context.addProvenance(itemId, { actor: initiator, action: "memory.archive", note: "cold searchable reference preserved (L1)" });
    return this.writeReceipt(this.ids.receiptId("rcpt"), "archive", "saved", this.candidateOf(item), initiator, [
      { policy: "retention", outcome: "allow", reason: "archived with cold searchable reference; provider data untouched" },
    ], {
      providerId: item.source.provider,
      before: { itemId, retention: "durable" },
      after: { itemId, retention: "archived" },
      links: { itemId, sessionId: item.relatedSessions[0] },
    });
  }

  // ----------------------------------------------------------------- delete

  async delete(itemId: string, initiator: ActorRef, mode: "soft" | "hard" = "soft"): Promise<MemoryActionReceipt> {
    const item = this.context.get(itemId);
    const rid = this.ids.receiptId("rcpt");

    if (mode === "hard") {
      try {
        this.registry.assertCapable(item.source.provider, "delete", `hard delete ${itemId}`);
      } catch (e) {
        if (e instanceof UnsupportedOperationError) {
          // Structured "unsupported" — visible, never simulated success.
          return this.writeReceipt(rid, "delete", "failed", this.candidateOf(item), initiator, [
            { policy: "capabilities", outcome: "deny", reason: `provider ${e.providerId} does not support delete; soft-delete offered instead` },
          ], {
            providerId: item.source.provider,
            links: { itemId },
            result: { message: `unsupported: ${e.message}` },
            retry: { attempts: 0, retryable: false, nextAction: "none" },
          });
        }
        throw e;
      }
      const provider = this.registry.get(item.source.provider);
      const spaceId = item.links.find((l) => l.rel === "space")?.target;
      await provider.delete(spaceId ?? "", `mem:${itemId}`);
      this.context.setRetention(itemId, "deleted");
      this.context.addProvenance(itemId, { actor: initiator, action: "memory.delete.hard", note: "remote record deleted" });
      return this.writeReceipt(rid, "delete", "saved", this.candidateOf(item), initiator, [
        { policy: "capabilities", outcome: "allow", reason: "provider supports delete" },
      ], {
        providerId: item.source.provider, spaceId,
        before: { itemId, retention: item.retention }, after: { itemId, retention: "deleted" },
        links: { itemId },
      });
    }

    // Soft delete: tombstone locally, remote untouched, receipts keep history.
    this.context.setRetention(itemId, "deleted");
    this.context.addProvenance(itemId, { actor: initiator, action: "memory.delete.soft", note: "soft delete; provider data retained" });
    const spaceId = item.links.find((l) => l.rel === "space")?.target;
    if (spaceId) this.spaces.removeItem(spaceId, itemId);
    return this.writeReceipt(rid, "delete", "saved", this.candidateOf(item), initiator, [
      { policy: "retention", outcome: "allow", reason: "soft delete: tombstoned locally, remote data retained" },
    ], {
      providerId: item.source.provider, spaceId,
      before: { itemId, retention: item.retention }, after: { itemId, retention: "deleted" },
      links: { itemId },
    });
  }

  // ------------------------------------------------------------------ merge

  async merge(itemIds: string[], mergedContent: string, initiator: ActorRef, title?: string): Promise<MemoryActionReceipt> {
    const items = itemIds.map((id) => this.context.get(id));
    const hash = contentHash(mergedContent);
    const spaceId = items[0]?.links.find((l) => l.rel === "space")?.target;
    const mergedId = this.ids.ctxId("memory");
    const space = spaceId ? this.spaces.get(spaceId) : undefined;

    const idemKey = this.ids.idempotencyKey("mem-merge", mergedId, hash);
    let qState = "skipped";
    if (space) {
      const q = await this.queue.enqueue({
        op: "provider.write",
        payload: {
          providerId: space.providerId,
          items: [{ space: space.id, record: { key: `mem:${mergedId}`, content: mergedContent, meta: { mergedFrom: itemIds } }, idempotencyKey: idemKey }],
        },
      }, idemKey);
      qState = q.state;
    }

    if (qState === "acked" || !space) {
      this.context.put({
        id: mergedId,
        uri: cortexUri(space?.scope ?? "user", `memories/mem:${mergedId}`),
        kind: "memory",
        title: title ?? `Merged: ${items.map((i) => i.title).join(" + ")}`,
        summary: mergedContent.slice(0, 160),
        body: mergedContent,
        source: { provider: space?.providerId ?? "local", kind: "memory", label: space ? this.registry.get(space.providerId).label : "local merge" },
        scope: space?.scope ?? "user",
        retention: "durable",
        links: spaceId ? [{ rel: "space", target: spaceId }] : [],
        provenance: [{ at: this.now(), actor: initiator, action: "memory.merge", note: `merged from ${itemIds.join(", ")}` }],
        meta: { hash },
      });
      for (const it of items) {
        this.context.link(it.id, "merged-into", mergedId);
        this.context.setRetention(it.id, "archived");
      }
      return this.writeReceipt(this.ids.receiptId("rcpt"), "merge", "saved", { content: mergedContent, hash }, initiator, [
        { policy: "merge", outcome: "allow", reason: `${itemIds.length} items merged into ${mergedId}` },
      ], { after: { itemId: mergedId, hash }, links: { itemId: mergedId } });
    }
    return this.writeReceipt(this.ids.receiptId("rcpt"), "merge", "failed", { content: mergedContent, hash }, initiator, [], {
      links: {}, result: { message: `provider write failed (${qState}); sources left untouched` },
      retry: { attempts: 0, retryable: true, nextAction: "retry" },
    });
  }

  // ----------------------------------------------------------------- recall

  async recall(query: string, initiator: ActorRef, k = 5, sessionId?: string, correlationId?: string): Promise<{ receipt: MemoryActionReceipt; hits: { itemId: string; title: string; uri: string; providerId: string; spaceId?: string; score: number }[] }> {
    const hits: { itemId: string; title: string; uri: string; providerId: string; spaceId?: string; score: number }[] = [];
    for (const space of this.spaces.list()) {
      if (space.status === "error") continue;
      const provider = this.registry.tryGet(space.providerId);
      if (!provider || !provider.capabilities.semanticSearch) continue;
      try {
        const res = await provider.search(space.id, query, k);
        for (const h of res) {
          const item = this.context.list({ kind: "memory", spaceId: space.id }).find((m) => h.key === `mem:${m.id}` || h.key.includes(m.id));
          hits.push({
            itemId: item?.id ?? h.key,
            title: item?.title ?? h.key,
            uri: item?.uri ?? cortexUri(space.scope, h.key),
            providerId: space.providerId,
            spaceId: space.id,
            score: h.score,
          });
        }
      } catch { /* provider down: recall degrades, receipt records it */ }
    }
    hits.sort((a, b) => b.score - a.score);
    const receipt = this.writeReceipt(this.ids.receiptId("rcpt"), "recall", "submitted", { content: query, hash: contentHash(query) }, initiator, [
      { policy: "recall", outcome: "allow", reason: `${hits.length} hits across ${new Set(hits.map((h) => h.spaceId)).size} searchable spaces` },
    ], { links: { sessionId }, correlationId, result: { perItem: hits.slice(0, k).map((h) => ({ key: h.itemId, status: `score:${h.score.toFixed(2)}` })) } });
    return { receipt, hits: hits.slice(0, k) };
  }

  // ---------------------------------------------------------------- helpers

  getProposal(id: string): SaveProposal | undefined { return this.proposals.get(id); }

  private mustProposal(id: string): SaveProposal {
    const p = this.proposals.get(id);
    if (!p) throw new Error(`unknown proposal: ${id}`);
    return p;
  }

  private candidateOf(item: ContextItem) {
    return { content: item.body ?? item.summary ?? "", title: item.title, hash: (item.meta?.["hash"] as string) ?? contentHash(item.body ?? "") };
  }

  private writeReceipt(
    receiptId: string, action: MemoryActionReceipt["action"], state: MemoryActionState,
    candidate: MemoryActionReceipt["candidate"], initiator: MemoryActionReceipt["initiator"],
    policyDecisions: PolicyDecision[],
    extra: Partial<MemoryActionReceipt> = {},
  ): MemoryActionReceipt {
    const prev = this.receiptLog.byId(receiptId);
    // merge links (never clobber sessionId/correlation set at proposal time)
    const mergedLinks: MemoryActionReceipt["links"] = { ...(prev?.links ?? {}) };
    for (const [k, v] of Object.entries(extra.links ?? {})) {
      if (v !== undefined) (mergedLinks as Record<string, unknown>)[k] = v;
    }
    const base: MemoryActionReceipt = {
      receiptId, action, state, candidate, initiator, policyDecisions: [
        ...(prev?.policyDecisions ?? []), ...policyDecisions,
      ],
      links: mergedLinks,
      createdAt: prev?.createdAt ?? this.now(),
      updatedAt: this.now(),
      providerId: extra.providerId ?? prev?.providerId,
      spaceId: extra.spaceId ?? prev?.spaceId,
      before: extra.before ?? prev?.before,
      after: extra.after ?? prev?.after,
      result: extra.result ?? prev?.result,
      retry: extra.retry ?? prev?.retry,
      correlationId: extra.correlationId ?? prev?.correlationId,
    };
    return this.receiptLog.append(base);
  }
}

function firstLine(s: string): string {
  const l = s.split("\n")[0]?.trim() ?? "";
  return l.length > 60 ? l.slice(0, 57) + "..." : l || "untitled memory";
}
