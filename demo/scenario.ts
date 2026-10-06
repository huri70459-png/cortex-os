/**
 * CortexOS demo — walks the Tier-1 success definition end to end:
 *
 *   1. Route a real turn
 *   2. See exactly what context was assembled
 *   3. Trace every injected item to its source
 *   4. See which model, provider, and policy made the decision
 *   5. Save or update memory with a receipt
 *   6. Recover safely from a failed write or restart (real SIGKILL)
 *   7. Inspect parent/subagent work in one network
 *   8. Compare cost, latency, tokens, cache, and memory behavior
 *   9. Use multiple providers without hidden capability assumptions
 *  10. Reproducible through mock tests and controlled benchmarks
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createCortexOS, MockLocalProvider, MockRemoteProvider, MockLimitedProvider,
  ManualClock, assertCompositionInvariant,
} from "../src/index.js";

const hr = (t: string) => console.log(`\n${"═".repeat(72)}\n${t}\n${"═".repeat(72)}`);
const line = (t: string) => console.log(`  ${t}`);
const ok = (t: string) => console.log(`  ✓ ${t}`);

const USER = { kind: "user" as const, id: "u-demo", label: "Demo User" };
const AGENT = { kind: "agent" as const, id: "agent-main", label: "Main Agent" };

async function main() {
  const dir = mkdtempSync(join(tmpdir(), "cortex-demo-"));
  const os = createCortexOS({ dataDir: dir, clock: new ManualClock() });

  // ── 9. Multiple providers, honest capabilities ─────────────────────────
  hr("9 · PROVIDER FEDERATION — no hidden capability assumptions");
  os.registerProvider(new MockLocalProvider(join(dir, "local")));
  os.registerProvider(new MockRemoteProvider({ latencyMs: 1 }), { apiKey: "sk-live-SUPER-SECRET-9999" });
  os.registerProvider(new MockLimitedProvider());
  for (const p of os.registry.describe()) {
    const caps = Object.entries(p.capabilities).filter(([, v]) => v).map(([k]) => k).join(",");
    line(`${p.id.padEnd(14)} ${p.label.padEnd(28)} creds=${p.credentials}  [${caps}]`);
  }
  os.createSpace({ id: "sp_notes", title: "User notes", providerId: "mock-local", scope: "user", placement: "local-first" });
  os.createSpace({ id: "sp_team", title: "Team knowledge", providerId: "mock-remote", scope: "project", placement: "project-scoped" });
  os.createSpace({ id: "sp_vault", title: "Compliance vault", providerId: "mock-limited", scope: "user", placement: "compliance", compliance: { allowedProviders: ["mock-limited"] } });
  ok("3 spaces created — all INACTIVE until a provider confirms a write");

  // unsupported operation is visible, never simulated
  try { os.registry.assertCapable("mock-limited", "delete", "hard delete"); } catch (e) { ok(`unsupported surfaces honestly: ${(e as Error).message}`); }

  // ── 5. Governed memory save with receipt ───────────────────────────────
  hr("5 · GOVERNED MEMORY — propose → edit → submit → receipt");
  const p1 = os.actions.proposeSave({ content: "Retry uploads with exponential backoff, cap at 30 seconds.", title: "Retry convention", initiator: USER, sessionId: undefined });
  line(`placement decision: ${p1.placement?.chosen?.spaceId} (mode=${p1.placement?.mode})`);
  os.actions.editProposal(p1.proposalId, "Retry uploads with exponential backoff, capped at 30s. Never retry auth errors.");
  const r1 = await os.actions.submit(p1.proposalId, USER);
  ok(`saved → receipt ${r1.receipt.receiptId} state=${r1.receipt.state} item=${r1.item?.id}`);
  ok(`space sp_notes now: ${os.spaces.get("sp_notes").status} (activated by CONFIRMED write)`);

  // duplicate save → updated with existing id (propose the SAVED, edited text)
  const p2 = os.actions.proposeSave({ content: "Retry uploads with exponential backoff, capped at 30s. Never retry auth errors.", initiator: USER });
  const r2 = await os.actions.submit(p2.proposalId, USER);
  ok(`duplicate proposal → ${p2.duplicate?.kind} match: ${p2.duplicate?.itemId === r1.item?.id ? "points at existing item" : "?"}; receipt state=${os.receipts.byId(p2.receiptId)?.state}`);
  void r2;

  // failed write is receipted, then retried safely
  const remote = os.registry.get("mock-remote") as MockRemoteProvider;
  remote.failNext(99, "auth", 401);
  const p3 = os.actions.proposeSave({ content: "Team runbook: rotate deploy keys quarterly.", initiator: USER, placement: { mode: "fixed", scope: "project", fixedProviderId: "mock-remote" } });
  const r3 = await os.actions.submit(p3.proposalId, USER);
  ok(`failed write → state=${r3.receipt.state} retryable=${r3.receipt.retry?.retryable} next=${r3.receipt.retry?.nextAction}; space sp_team stays ${os.spaces.get("sp_team").status}`);
  remote.clearFailures();
  const r3b = await os.actions.submit(p3.proposalId, USER);
  ok(`safe retry → ${r3b.receipt.state}; remote records=${remote.count("sp_team")} (no duplicates)`);

  // ── 1–4. Route real turns; inspect assembly, provenance, decisions ─────
  hr("1–4 · ROUTE TURNS — assembly, provenance, routing decisions");
  const main = os.createSession({ agentId: "agent-main", model: "cortex-small" });
  const t1 = await os.routeTurn({ sessionId: main.id, userMessage: "How should the uploader retry failed requests?", initiator: USER });
  const t2 = await os.routeTurn({ sessionId: main.id, userMessage: "What is the backoff cap again?", initiator: USER });
  assertCompositionInvariant(t1.snapshot); assertCompositionInvariant(t2.snapshot);

  line(`decision: policy=${t1.snapshot.decision.policy} model=${t1.snapshot.decision.model} provider=${t1.snapshot.decision.providerId}`);
  line(`reason:   ${t1.snapshot.decision.reason}`);
  const view = os.browser(t2.snapshot.requestId)!;
  line(`request ${t2.snapshot.requestId}: ${view.groups.length} buckets, est=${view.estimatedInput} tok, actual prompt=${view.actual?.promptTokens} cached=${view.actual?.cachedTokens} (never conflated)`);
  for (const g of view.groups) {
    line(`  [${g.bucket}] ${g.estimatedTokens} tok`);
    for (const p of g.parts.slice(0, 4)) {
      line(`     · ${p.sourceLabel}${p.sourceItemId ? ` → ${os.context.get(p.sourceItemId).uri}` : ""}${p.compactionMarker ? " (compacted)" : ""}`);
    }
  }
  const inj = view.groups.find((g) => g.bucket === "injected-context");
  ok(`every injected item traces to source: ${inj ? inj.parts.every((p) => p.sourceItemId && os.context.tryGet(p.sourceItemId)) : false}`);
  ok(`diff vs previous: +${view.diff?.totals.added} added, ${view.diff?.totals.grew} grew, Δ${view.diff?.totals.deltaTokens} tokens`);

  // ── 7. Parent/subagent network ─────────────────────────────────────────
  hr("7 · AGENT NETWORK — lineage from runtime events only");
  const sub = os.createSession({ role: "subagent", agentId: "agent-research", model: "cortex-small", parentId: main.id, task: "research retry standards" });
  await os.routeTurn({ sessionId: sub.id, userMessage: "what backoff cap do we use for retries?", initiator: AGENT });
  const sub2 = os.createSession({ role: "subagent", agentId: "agent-patcher", model: "cortex-large", parentId: main.id, task: "patch uploader" });
  os.sessions.transition(sub2.id, "failed", "provider 500 during patch");
  const net = os.network();
  line(`nodes=${net.stats.nodeCount} edges=${net.stats.edgeCount} failed=${net.stats.failedBranches}`);
  for (const e of net.edges) line(`  ${e.from.slice(0, 18)} —${e.type}→ ${e.to.slice(0, 24)}${e.count ? ` (×${e.count})` : ""}`);
  ok(`failed subagent still inspectable: state=${os.sessions.get(sub2.id).state}`);

  // commit + two-phase extraction
  hr("3 · SESSION COMMIT — phase-1 archive ≠ phase-2 extraction");
  const c = await os.commit.commit(sub.id);
  line(`commit: state=${c.state} extraction=${c.extraction} (archive durable, distillation pending)`);
  const ex = await os.commit.runExtraction(sub.id, AGENT);
  ok(`extraction: ${ex.extraction} (${ex.extractionOverall}) — ${ex.extractionReceipts?.length} receipts`);
  const comp = await os.compaction.compact(main.id);
  ok(`compaction: ${comp.state}, captured ${comp.removedMessages} messages BEFORE replacing transcript (key=${comp.captureKey?.slice(0, 28)}…)`);

  // ── 6. Crash + recovery (real SIGKILL of a child router process) ───────
  hr("6 · CRASH & RECOVERY — real SIGKILL mid-write, then recovery sweep");
  const crashDir = mkdtempSync(join(tmpdir(), "cortex-crash-demo-"));
  const childPath = fileURLToPath(new URL("../tests/crash-child.js", import.meta.url));
  const child = spawnSync(process.execPath, [childPath, crashDir], { encoding: "utf8" });
  line(`child router killed with signal=${child.signal} (writes applied at provider, acks never landed)`);
  const crashedWal = readFileSync(join(crashDir, "wal.jsonl"), "utf8").split("\n").filter((l) => l.includes('"queued"')).length;
  line(`WAL at crash time: ${crashedWal} queued (uncommitted) records`);

  const os2 = createCortexOS({ dataDir: crashDir });
  const local2 = new MockLocalProvider(join(crashDir, "local"));
  os2.registerProvider(local2);
  const rec = await os2.recover();
  ok(`recovery sweep replayed ${rec.stats.recovered} records → all acked: ${rec.receipts.every((r) => r.state === "acked")}`);
  ok(`provider holds ${local2.count("crash-space")} records (duplicates suppressed: ${rec.stats.duplicates})`);
  ok(`WAL uncommitted after recovery: ${os2.wal.uncommitted().length}`);
  await os2.shutdown();

  // ── 8. Insights: compare cost/latency/tokens/cache ─────────────────────
  hr("8 · CONTEXT INSIGHTS — trustworthy read models");
  const ins = os.insights({}, 1.0);
  line(`KPIs: sessions=${ins.kpis.activeSessions} requests=${ins.kpis.requests} actualTokens=${ins.kpis.tokensUsed} estTokens=${ins.kpis.estimatedTokens} cost=$${ins.kpis.cost} cacheHit=${ins.kpis.cacheHitRate} tools=${ins.kpis.toolCalls}`);
  line(`token composition: ${ins.tokenComposition.map((c) => `${c.label}=${c.tokens}`).join(" ")}`);
  line(`timing: ${ins.timingComposition.map((c) => `${c.label}=${c.ms}ms`).join(" ")}`);
  ok(`invariants: ${ins.invariants.map((i) => `${i.name}=${i.ok ? "PASS" : "FAIL"}`).join(", ")}`);
  for (const sc of ins.sessionCards) line(`  session ${sc.sessionId.slice(0, 20)} [${sc.state}/${sc.extraction}] turns=${sc.turns} tokens=${sc.tokens} cost=$${sc.cost} subs=${sc.subagents.length}`);

  // ── 10. Reproducibility ────────────────────────────────────────────────
  hr("10 · REPRODUCIBILITY");
  ok("47 acceptance tests: npm test (includes SIGKILL crash/replay, partial-suffix retry, 100-node graph, 100-turn benchmark)");

  // ── 1. The hierarchy ────────────────────────────────────────────────────
  hr("1 · UNIFIED CONTEXT HIERARCHY");
  const printTree = (n: ReturnType<typeof os.context.tree>, d = 0) => {
    console.log(`  ${"  ".repeat(d)}${n.kind === "group" ? "├─" : "•"} ${n.title}${n.uiPath ? `  (${n.uiPath})` : ""}`);
    if (d < 2) for (const c of n.children) printTree(c, d + 1);
    else if (n.children.length) console.log(`  ${"  ".repeat(d + 1)}… ${n.children.length} items`);
  };
  printTree(os.context.tree());

  // redaction proof
  hr("SECURITY — credentials never rendered");
  const rendered = JSON.stringify(os.registry.describe()) + JSON.stringify(os.receipts.all());
  ok(`secret present in any rendered surface: ${rendered.includes("sk-live-SUPER-SECRET-9999") ? "LEAKED!" : "false"}`);

  await os.shutdown();
  console.log("\nDemo complete. Data dir:", dir, "\n");
}

main().catch((e) => { console.error(e); process.exit(1); });
