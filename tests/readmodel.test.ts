import test from "node:test";
import assert from "node:assert/strict";
import { freshRig, USER, AGENT } from "./helpers.js";
import { assertCompositionInvariant, buildBrowserView, diffSnapshots, buildAgentNetwork, collapseCompleted, type RequestSnapshot } from "../src/index.js";

/**
 * Slice 4 acceptance:
 * - Every composition number equals the sum of its visible parts
 * - Every recalled memory has a source link
 * - Every context part has a source label or explicit "generated/aggregate"
 * - Actual and estimated usage are never conflated
 * - Range changes update KPIs consistently
 * - A diff shows exactly what grew, changed, or was pruned
 *
 * Slice 5 acceptance:
 * - Parent/child relationships come from runtime events
 * - Shared-memory reads visibly distinguished from private context
 * - Failed subagents remain inspectable
 * - Graph usable with 100+ nodes
 */

async function routedFixture() {
  const rig = freshRig();
  const { os } = rig;
  os.createSpace({ id: "sp_local", title: "Local notes", providerId: "mock-local", scope: "user", placement: "local-first" });
  await os.actions.submit(os.actions.proposeSave({
    content: "Retries use exponential backoff capped at 30 seconds.", title: "Backoff convention", initiator: USER,
  }).proposalId, USER);

  const s = os.createSession({ agentId: "agent-main", model: "cortex-small" });
  const t1 = await os.routeTurn({ sessionId: s.id, userMessage: "How do we handle retries and backoff?", initiator: USER });
  const t2 = await os.routeTurn({ sessionId: s.id, userMessage: "And what is the cap for backoff retries?", initiator: USER });
  return { rig, session: s, t1, t2 };
}

test("KPIs and compositions: every number equals the sum of its visible parts", async () => {
  const { rig, t1, t2 } = await routedFixture();
  const { os } = rig;
  const ins = os.insights();

  assert.ok(ins.invariants.every((i) => i.ok), JSON.stringify(ins.invariants));
  const compSum = ins.tokenComposition.reduce((s, c) => s + c.tokens, 0);
  assert.equal(compSum, ins.kpis.estimatedTokens, "composition sums to the estimated total");
  assert.equal(ins.kpis.requests, 2);

  // ACTUAL usage comes from the provider and is reported separately
  const actualSum = [t1, t2].reduce((s, t) => s + (t.snapshot.actual?.promptTokens ?? 0) + (t.snapshot.actual?.completionTokens ?? 0), 0);
  assert.equal(ins.kpis.tokensUsed, actualSum);
  assert.notEqual(ins.kpis.tokensUsed, ins.kpis.estimatedTokens, "actual vs estimated never conflated");
  assert.ok(ins.kpis.cacheHitRate >= 0 && ins.kpis.cacheHitRate <= 1);

  // per-snapshot invariant
  assertCompositionInvariant(t1.snapshot);
  assertCompositionInvariant(t2.snapshot);

  // timing composition mirrors snapshot timings exactly
  const assembly = ins.timingComposition.find((c) => c.label === "assembly")!.ms!;
  assert.equal(assembly, t1.snapshot.timing.assemblyMs + t2.snapshot.timing.assemblyMs);

  // range filtering updates KPIs consistently
  const empty = os.insights({ from: "2030-01-01T00:00:00.000Z" });
  assert.equal(empty.kpis.requests, 0);
  assert.equal(empty.tokenComposition.length, 0);
});

test("Context Browser: every part has a source label; recalled memories carry source links", async () => {
  const { rig, t2 } = await routedFixture();
  const { os } = rig;
  const view = os.browser(t2.snapshot.requestId)!;

  assert.ok(view.groups.length >= 3, "system, tools, injected-context, user...");
  for (const g of view.groups) {
    for (const p of g.parts) {
      // no anonymous parts: label always present
      assert.ok(p.sourceLabel && p.sourceLabel.length > 0, `part ${p.partId} lacks source label`);
      if (p.bucket === "injected-context") {
        assert.ok(p.sourceItemId, "injected memory must link its source item");
        const item = os.context.get(p.sourceItemId);
        assert.ok(item.source.label, "source item has a provider label");
      }
      if (p.sourceLabel.startsWith("generated")) assert.ok(!p.sourceItemId || p.bucket === "user");
    }
    // bucket totals equal sum of non-pruned parts (visible parts)
    assert.equal(g.estimatedTokens, g.parts.filter((p) => !p.pruned).reduce((s, p) => s + p.estimatedTokens, 0));
  }
  // actual usage present but distinct from estimate
  assert.ok(view.actual);
  assert.notEqual(view.estimatedInput, view.actual!.promptTokens + view.actual!.completionTokens);
});

test("diff versus previous request shows exactly what grew/changed/was added", async () => {
  const { rig, t2 } = await routedFixture();
  const view = rig.os.browser(t2.snapshot.requestId)!;
  assert.ok(view.diff, "second request has a diff");
  assert.ok(view.diff.totals.added >= 2, "turn-1 user+assistant messages added to the transcript");
  const grew = view.diff.entries.filter((e) => e.change === "grew");
  const added = view.diff.entries.filter((e) => e.change === "added");
  for (const e of [...grew, ...added]) {
    if (e.change === "grew") assert.ok((e.estimatedAfter ?? 0) > (e.estimatedBefore ?? 0));
  }
  // delta matches snapshot totals exactly
  const snaps = rig.os.getSnapshots();
  assert.equal(view.diff.totals.deltaTokens, snaps[1].estimatedTokens.input - snaps[0].estimatedTokens.input);
});

test("pruned parts and compaction markers are visible in the browser view", async () => {
  // synthetic snapshots exercise pruned/marker rendering deterministically
  const base: RequestSnapshot = {
    id: "snap_r1", sessionId: "s1", requestId: "r1", correlationId: "c1", createdAt: "2026-10-06T09:00:00Z",
    decision: { policy: "p", model: "m", providerId: "pv", reason: "r" },
    parts: [
      { partId: "p1", bucket: "system", sourceLabel: "generated:system-prompt", estimatedTokens: 100 },
      { partId: "p2", bucket: "injected-context", sourceItemId: "ctx_memory_x", sourceLabel: "Local Store · old memory", estimatedTokens: 50, pruned: true },
      { partId: "p3", bucket: "assistant", sourceLabel: "session:s1:assistant", estimatedTokens: 20, compactionMarker: true },
    ],
    estimatedTokens: { input: 120 },
    timing: { assemblyMs: 5, providerMs: 10, totalMs: 15 },
    prunedCount: 1,
  };
  const view = buildBrowserView(base);
  assert.equal(view.pruned.length, 1);
  assert.equal(view.pruned[0].partId, "p2");
  assert.equal(view.compactionMarkers.length, 1);
  assert.equal(view.estimatedInput, 120, "pruned part excluded from the sum");
  assertCompositionInvariant(base);

  // diff marks pruned-now / unpruned-now transitions
  const next: RequestSnapshot = { ...base, requestId: "r2", id: "snap_r2", parts: [base.parts[0], { ...base.parts[1], pruned: false }], estimatedTokens: { input: 150 }, prunedCount: 0 };
  const d = diffSnapshots(base, next)!;
  assert.ok(d.entries.some((e) => e.change === "unpruned-now"));
  assert.ok(d.entries.some((e) => e.change === "removed"), "compaction marker part removed in next request");
});

test("compaction marker flows through a real turn after compaction", async () => {
  const { rig } = await routedFixture();
  const { os } = rig;
  const s = os.sessions.list()[0];
  await os.compaction.compact(s.id);
  const t3 = await os.routeTurn({ sessionId: s.id, userMessage: "continue after compaction", initiator: USER });
  const view = os.browser(t3.snapshot.requestId)!;
  assert.ok(view.compactionMarkers.length >= 1, "compaction visible in the assembled context");
});

test("Agent Network is built ONLY from runtime events", async () => {
  const { rig } = await routedFixture();
  const { os } = rig;
  const main = os.sessions.list().find((s) => s.role === "main")!;
  const sub = os.createSession({ role: "subagent", agentId: "agent-search", model: "cortex-small", parentId: main.id, task: "deep search" });

  // a turn inside the subagent that recalls shared memory
  await os.routeTurn({ sessionId: sub.id, userMessage: "find the backoff cap convention", initiator: AGENT });

  const net = os.network();
  assert.ok(net.nodes.length >= 2);
  const delegates = net.edges.filter((e) => e.type === "delegates");
  assert.ok(delegates.some((e) => e.from === main.id && e.to === sub.id), "delegation edge from runtime event");
  const reads = net.edges.filter((e) => e.type === "reads-memory");
  assert.ok(reads.length >= 1, "memory reads are event-sourced");
  assert.ok(reads.every((e) => (e.to as string).startsWith("space:")), "reads point at spaces (shared), distinct from private session context");

  // failed subagents remain inspectable
  const sub2 = os.createSession({ role: "subagent", agentId: "agent-coder", model: "cortex-small", parentId: main.id, task: "patch" });
  os.sessions.transition(sub2.id, "failed", "provider 500");
  const net2 = os.network();
  const failedNode = net2.nodes.find((n) => n.id === sub2.id)!;
  assert.equal(failedNode.status, "failed");
  assert.equal(net2.stats.failedBranches, 1);
  assert.ok(os.sessions.tryGet(sub2.id), "failed subagent session still openable");

  // collapse completed branches keeps mains, drops completed subs
  os.sessions.transition(sub.id, "committing"); os.sessions.transition(sub.id, "committed");
  const collapsed = os.network({ collapseCompleted: true });
  assert.ok(!collapsed.nodes.some((n) => n.id === sub.id));
  assert.ok(collapsed.nodes.some((n) => n.id === main.id));
});

test("shares-context edges distinguish shared memory from private context", () => {
  const { os } = freshRig();
  const a = os.createSession({ agentId: "agent-a", model: "m" });
  const b = os.createSession({ agentId: "agent-b", model: "m" });
  os.sessions.recordEvent(a.id, { type: "context-shared", at: os.clock.iso(), sessions: [a.id, b.id], spaceId: "sp_shared" });
  const net = buildAgentNetwork(os.sessions);
  const share = net.edges.find((e) => e.type === "shares-context");
  assert.ok(share);
  assert.deepEqual([share.from, share.to].sort(), [a.id, b.id].sort());
  assert.equal(share.meta?.["spaceId"], "sp_shared");
});

test("100-node Agent Network builds fast and stays consistent", () => {
  const { os } = freshRig();
  const main = os.createSession({ agentId: "orchestrator", model: "cortex-large" });
  for (let i = 0; i < 99; i++) {
    const sub = os.createSession({ role: i % 10 === 0 ? "task" : "subagent", agentId: `agent-${i}`, model: "cortex-small", parentId: main.id, task: `task ${i}` });
    os.sessions.addTurn(sub.id, { requestId: `r${i}`, tokens: { prompt: 100 + i, completion: 50, cached: 20 }, cost: 0.001, latencyMs: 10, toolCalls: 1 });
    if (i % 3 === 0) os.sessions.recordEvent(sub.id, { type: "memory-read", at: os.clock.iso(), sessionId: sub.id, spaceId: "sp_shared", itemIds: [`m${i}`] });
    if (i % 7 === 0) { os.sessions.transition(sub.id, "failed", "injected failure"); }
  }
  const t0 = performance.now();
  const net = os.network();
  const elapsed = performance.now() - t0;

  assert.equal(net.nodes.length, 100);
  assert.ok(net.edges.filter((e) => e.type === "delegates").length === 99);
  assert.ok(net.edges.filter((e) => e.type === "reads-memory").length >= 30);
  assert.ok(elapsed < 1000, `network build should stay interactive: ${elapsed.toFixed(1)}ms`);
  assert.ok(net.stats.maxDepth >= 1);
});

test("100-turn benchmark: invariants hold on every request", async (t) => {
  const { os } = freshRig();
  os.createSpace({ id: "sp_local", title: "Local", providerId: "mock-local", scope: "user", placement: "local-first" });
  await os.actions.submit(os.actions.proposeSave({ content: "Always cite memory ids in answers about backoff.", initiator: USER }).proposalId, USER);
  const s = os.createSession({ agentId: "agent-main", model: "cortex-small" });

  const t0 = performance.now();
  for (let i = 0; i < 100; i++) {
    const r = await os.routeTurn({ sessionId: i % 20 === 0 ? s.id : s.id, userMessage: `turn ${i}: question about backoff cap policy`, initiator: USER });
    assertCompositionInvariant(r.snapshot);
    assert.ok(r.snapshot.parts.every((p) => p.sourceLabel));
  }
  const elapsed = performance.now() - t0;
  const ins = os.insights();
  assert.equal(ins.kpis.requests, 100);
  assert.ok(ins.invariants.every((i) => i.ok));
  assert.ok(elapsed < 60_000, `100 turns in ${elapsed.toFixed(0)}ms`);
  t.diagnostic(`100 turns in ${elapsed.toFixed(0)}ms; tokens(actual)=${ins.kpis.tokensUsed}, cost=$${ins.kpis.cost}`);
});
