import test from "node:test";
import assert from "node:assert/strict";
import { freshRig, USER, AGENT } from "./helpers.js";

/**
 * Slice 6 acceptance:
 * - A saved reply shows a receipt and links to the exact memory
 * - Duplicate saves show "updated" with the existing ID
 * - Partial provider writes show per-item status
 * - Failed writes can be retried safely
 * - Receipts remain searchable from the session detail page
 * - Save-to-memory allows editing before submission
 * - Sending again requires a changed candidate
 * - Archive preserves a cold searchable reference; delete is soft by default
 */

test("save produces a receipt linked to the exact memory item", async () => {
  const { os } = freshRig();
  os.createSpace({ id: "sp_local", title: "Local", providerId: "mock-local", scope: "user", placement: "local-first" });

  const p = os.actions.proposeSave({ content: "User prefers tabs over spaces.", title: "Indent preference", initiator: USER, sessionId: "ses_x", correlationId: "req_1" });
  const res = await os.actions.submit(p.proposalId, USER);

  assert.equal(res.receipt.state, "saved");
  assert.equal(res.receipt.action, "save");
  assert.equal(res.receipt.initiator.id, "u-test");
  assert.equal(res.receipt.after?.itemId, res.item?.id);
  assert.equal(res.receipt.correlationId, "req_1");
  assert.ok(res.receipt.links.queueKey, "receipt links the durable queue key");
  assert.ok(res.item);

  // receipt searchable from the session detail page
  assert.ok(os.receipts.byCorrelation("req_1").length >= 1);
  assert.ok(os.receipts.byItem(res.item.id).length >= 1);
});

test("editing before submission is allowed and recorded", async () => {
  const { os } = freshRig();
  os.createSpace({ id: "sp_local", title: "Local", providerId: "mock-local", scope: "user", placement: "local-first" });

  const p = os.actions.proposeSave({ content: "draft with typo", initiator: USER });
  const edited = os.actions.editProposal(p.proposalId, "draft without typo", "Fixed title");
  assert.equal(edited.candidate.content, "draft without typo");
  assert.ok(edited.candidate.editedFromHash, "edit lineage recorded");

  const res = await os.actions.submit(p.proposalId, USER);
  assert.equal(res.receipt.state, "saved");
  assert.equal(res.item?.body, "draft without typo");
  assert.ok(res.receipt.policyDecisions.some((d) => d.policy === "edit-before-submit"));
});

test("resubmitting an unchanged candidate is skipped, not re-saved", async () => {
  const { os } = freshRig();
  os.createSpace({ id: "sp_local", title: "Local", providerId: "mock-local", scope: "user", placement: "local-first" });

  const p = os.actions.proposeSave({ content: "stable content", initiator: USER });
  const first = await os.actions.submit(p.proposalId, USER);
  assert.equal(first.receipt.state, "saved");

  const second = await os.actions.submit(p.proposalId, USER);
  assert.equal(second.receipt.state, "skipped");
  assert.ok(second.receipt.policyDecisions.some((d) => d.policy === "resubmit-guard" && d.outcome === "deny"));
});

test("duplicate save becomes 'updated' with the existing item ID", async () => {
  const { os } = freshRig();
  os.createSpace({ id: "sp_local", title: "Local", providerId: "mock-local", scope: "user", placement: "local-first" });

  const p1 = os.actions.proposeSave({ content: "The deploy key rotates every 90 days.", initiator: USER });
  const r1 = await os.actions.submit(p1.proposalId, USER);
  assert.equal(r1.receipt.state, "saved");
  const existingId = r1.item!.id;

  // exact same content proposed again → duplicate detection explains the match
  const p2 = os.actions.proposeSave({ content: "The deploy key rotates every 90 days.", initiator: USER });
  assert.ok(p2.duplicate);
  assert.equal(p2.duplicate.kind, "exact");
  assert.match(p2.duplicate.explanation, /Exact content match/);
  assert.equal(p2.duplicate.itemId, existingId);

  const r2 = await os.actions.submit(p2.proposalId, USER);
  assert.equal(r2.receipt.state === "updated" || os.receipts.byId(p2.receiptId)!.state === "updated", true);
  assert.equal(r2.receipt.links.duplicateOf, existingId);
  assert.equal(r2.item?.id, existingId, "points at the EXISTING id, not a new item");
  assert.equal(os.context.list({ kind: "memory" }).length, 1, "no duplicate memory created");
});

test("partial provider failure → partly-saved with exact per-item status", async () => {
  const { os, remote } = freshRig();
  os.createSpace({ id: "sp_local", title: "Local", providerId: "mock-local", scope: "user", placement: "local-first" });
  os.createSpace({ id: "sp_remote", title: "Cloud", providerId: "mock-remote", scope: "user", placement: "fixed" });

  // batch: one to local (succeeds), one to remote with persistent failure
  remote.failNext(99, "auth", 401);
  const pa = os.actions.proposeSave({ content: "local record", initiator: AGENT, placement: { mode: "fixed", scope: "user", fixedProviderId: "mock-local" } });
  const pb = os.actions.proposeSave({ content: "remote record", initiator: AGENT, placement: { mode: "fixed", scope: "user", fixedProviderId: "mock-remote" } });

  const batch = await os.actions.submitBatch([pa.proposalId, pb.proposalId], AGENT);
  assert.equal(batch.overall, "partly-saved");
  const statuses = Object.fromEntries(batch.perItem.map((i) => [i.key, i.status]));
  assert.equal(statuses[pa.proposalId], "saved");
  assert.equal(statuses[pb.proposalId], "failed");

  // the failed receipt identifies the provider error class and is not retryable (auth)
  const failedReceipt = batch.receipts.find((r) => r.state === "failed")!;
  assert.equal(failedReceipt.retry?.retryable, false);
  assert.equal(failedReceipt.retry?.nextAction, "attention");
  assert.match(failedReceipt.result?.message ?? "", /auth|401|remote write failed/i);

  // space metadata intact; remote space never activated
  assert.equal(os.spaces.get("sp_remote").status, "inactive");
  assert.equal(os.spaces.get("sp_local").status, "active");
});

test("failed writes can be retried safely (idempotent, no duplicates)", async () => {
  const { os, remote } = freshRig();
  os.createSpace({ id: "sp_remote", title: "Cloud", providerId: "mock-remote", scope: "user", placement: "fixed" });

  remote.failNext(99, "auth", 401); // permanent → fails fast, no retry storm
  const p = os.actions.proposeSave({ content: "retry me", initiator: USER, placement: { mode: "fixed", scope: "user", fixedProviderId: "mock-remote" } });
  const r1 = await os.actions.submit(p.proposalId, USER);
  assert.equal(r1.receipt.state, "failed");

  remote.clearFailures();
  const r2 = await os.actions.submit(p.proposalId, USER);
  assert.equal(r2.receipt.state, "saved");
  assert.equal(remote.count("sp_remote"), 1, "exactly one record after retry");
});

test("archive preserves a cold searchable reference", async () => {
  const { os } = freshRig();
  os.createSpace({ id: "sp_local", title: "Local", providerId: "mock-local", scope: "user", placement: "local-first" });
  const p = os.actions.proposeSave({ content: "Quarterly OKR notes with a lot of detail ".repeat(10), title: "OKR notes", initiator: USER });
  const r = await os.actions.submit(p.proposalId, USER);
  const id = r.item!.id;

  const arch = await os.actions.archive(id, USER);
  assert.equal(arch.state, "saved");
  assert.equal(arch.action, "archive");

  const item = os.context.get(id);
  assert.equal(item.retention, "archived");
  assert.equal(item.body, undefined, "cold: full body dropped");
  assert.ok(item.summary, "searchable reference preserved");
  assert.equal(item.capabilities.writable, false);
  assert.equal(item.layer, "L1");
  assert.ok(os.context.find("OKR").length >= 1, "still findable");
});

test("delete is soft by default; hard delete reports 'unsupported' honestly", async () => {
  const { os, limited } = freshRig();
  os.createSpace({ id: "sp_local", title: "Local", providerId: "mock-local", scope: "user", placement: "local-first" });

  const p = os.actions.proposeSave({ content: "temp note", initiator: USER });
  const r = await os.actions.submit(p.proposalId, USER);
  const id = r.item!.id;

  // soft delete: tombstone, provider data retained
  const soft = await os.actions.delete(id, USER, "soft");
  assert.equal(soft.state, "saved");
  assert.equal(os.context.get(id).retention, "deleted");
  assert.equal(os.context.get(id).capabilities.readable, false);
  assert.match(soft.policyDecisions[0].reason, /soft delete/);

  // hard delete against a provider WITHOUT delete capability → visible "unsupported"
  const ghostItem = os.context.put({
    id: "ctx_memory_vault1", uri: "cortex://user/memories/vault1", kind: "memory",
    title: "Vault memory", body: "x", source: { provider: "mock-limited", kind: "memory", label: limited.label },
    scope: "user",
  });
  const hard = await os.actions.delete(ghostItem.id, USER, "hard");
  assert.equal(hard.state, "failed", "must NOT fake success");
  assert.match(hard.result?.message ?? "", /^unsupported:/);
  assert.match(hard.policyDecisions[0].reason, /does not support delete/);
  assert.equal(os.context.get(ghostItem.id).retention, "durable", "item untouched after unsupported attempt");
});

test("recall produces a receipt with source links for every hit", async () => {
  const { os } = freshRig();
  os.createSpace({ id: "sp_local", title: "Local", providerId: "mock-local", scope: "user", placement: "local-first" });
  const p = os.actions.proposeSave({ content: "Retry logic uses exponential backoff capped at 30s.", title: "Backoff convention", initiator: USER });
  await os.actions.submit(p.proposalId, USER);

  const { receipt, hits } = await os.actions.recall("exponential backoff", USER, 5, "ses_1", "req_9");
  assert.ok(hits.length >= 1);
  for (const h of hits) {
    assert.ok(h.itemId && h.uri && h.providerId, "every hit carries a source link");
  }
  assert.equal(receipt.action, "recall");
  assert.equal(receipt.correlationId, "req_9");
  assert.ok(os.receipts.byCorrelation("req_9").length >= 1);
});

test("merge links sources, archives them, and records a receipt", async () => {
  const { os } = freshRig();
  os.createSpace({ id: "sp_local", title: "Local", providerId: "mock-local", scope: "user", placement: "local-first" });
  const a = await os.actions.submit(os.actions.proposeSave({ content: "convention A: backoff exponentially", initiator: USER }).proposalId, USER);
  const b = await os.actions.submit(os.actions.proposeSave({ content: "convention B: cap backoff at 30s", initiator: USER }).proposalId, USER);

  const merged = await os.actions.merge([a.item!.id, b.item!.id], "Backoff exponentially, capped at 30s.", USER, "Backoff convention (merged)");
  assert.equal(merged.state, "saved");
  assert.equal(os.context.get(a.item!.id).retention, "archived");
  assert.ok(os.context.get(a.item!.id).links.some((l) => l.rel === "merged-into"));
});
