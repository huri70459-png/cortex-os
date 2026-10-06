import test from "node:test";
import assert from "node:assert/strict";
import { freshRig, USER, AGENT } from "./helpers.js";
import { InvalidTransitionError, canTransition, createCortexOS, MockLocalProvider, MockRemoteProvider, ManualClock } from "../src/index.js";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

/**
 * Slice 3 acceptance:
 * - Required state machine enforced (invalid transitions rejected)
 * - Commit ≠ extraction: phase-1 archival and phase-2 distillation tracked
 *   separately ("successful phase-one archival is not the same as completed
 *   extraction")
 * - Simulate compaction and verify pre-compaction data is committed first
 * - Recovery/retry paths: failed → retrying → active | attention-required
 * - Parent/subagent session lineage from runtime events
 */

function seededSession(os: ReturnType<typeof freshRig>["os"], msgs = 4) {
  const s = os.createSession({ agentId: "agent-main", model: "cortex-small" });
  for (let i = 0; i < msgs; i++) {
    os.sessions.addMessage(s.id, { role: i % 2 === 0 ? "user" : "assistant", content: `message ${i} about deploy conventions`, at: os.clock.iso() });
  }
  return s;
}

test("state machine allows the plan's transitions and rejects shortcuts", () => {
  assert.ok(canTransition("active", "committing"));
  assert.ok(canTransition("committing", "committed"));
  assert.ok(canTransition("committed", "archived"));
  assert.ok(canTransition("active", "compacting"));
  assert.ok(canTransition("compacting", "active"));
  assert.ok(canTransition("active", "failed"));
  assert.ok(canTransition("failed", "retrying"));
  assert.ok(canTransition("retrying", "active"));
  assert.ok(canTransition("retrying", "attention-required"));

  assert.ok(!canTransition("active", "committed"), "cannot skip committing");
  assert.ok(!canTransition("archived", "active"), "archived is terminal");
  assert.ok(!canTransition("committed", "active"), "no silent un-commit");

  const { os } = freshRig();
  const s = os.createSession({ agentId: "a", model: "m" });
  assert.throws(() => os.sessions.transition(s.id, "committed"), InvalidTransitionError);
});

test("commit is two-phase: phase-1 archive confirmed ≠ extraction complete", async () => {
  const { os, local } = freshRig();
  os.createSpace({ id: "sp_local", title: "Local notes", providerId: "mock-local", scope: "user", placement: "local-first" });
  const s = seededSession(os);

  const c = await os.commit.commit(s.id);
  assert.equal(c.state, "committed");
  assert.equal(os.sessions.get(s.id).state, "committed");
  // Phase-1 durable archive exists at the provider under the archive space
  const archived = await local.read("session-archives", `archive:${s.id}`);
  assert.ok(archived, "raw messages archived durably in phase 1");
  const parsed = JSON.parse(archived.content);
  assert.equal(parsed.length, 4, "full transcript archived");

  // CRITICAL: committed, but extraction has NOT happened yet
  assert.equal(os.sessions.get(s.id).extraction, "pending");
  assert.equal(os.context.list({ kind: "memory" }).length, 0, "no distilled memories yet");

  const ex = await os.commit.runExtraction(s.id, AGENT);
  assert.equal(ex.extraction, "done");
  assert.equal(os.sessions.get(s.id).extraction, "done");
  assert.ok(os.context.list({ kind: "memory" }).length >= 1, "distilled memories exist after phase 2");
  // extraction receipts searchable from the session
  assert.ok(os.receipts.bySession(s.id).length >= 1);
  assert.ok(os.receipts.byCorrelation(`extract:${s.id}`).length >= 1);

  os.commit.archive(s.id);
  assert.equal(os.sessions.get(s.id).state, "archived");
});

test("extraction failure never un-commits the session", async () => {
  const { os, remote } = freshRig();
  os.createSpace({ id: "sp_remote", title: "Cloud", providerId: "mock-remote", scope: "user", placement: "fixed" });
  const s = seededSession(os);
  const c = await os.commit.commit(s.id);
  assert.equal(c.state, "committed");

  remote.failNext(99, "auth", 401); // distillation target is broken
  const ex = await os.commit.runExtraction(s.id, AGENT, {
    placement: { mode: "fixed", scope: "user", fixedProviderId: "mock-remote" },
  });
  assert.equal(ex.extraction, "failed");
  assert.equal(ex.extractionOverall, "failed");
  // the commit itself stands — phase-1 archive is durable
  assert.equal(os.sessions.get(s.id).state, "committed");
  assert.equal(os.sessions.get(s.id).extraction, "failed");
  assert.ok(os.attention().extractionFailed.length === 1, "failed extraction surfaces in attention list");
});

test("permanent commit failure → attention-required; operator retry recovers", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cortex-commit-"));
  const os = createCortexOS({ dataDir: dir, clock: new ManualClock(), archive: { providerId: "mock-remote", space: "session-archives" } });
  const remote = new MockRemoteProvider({ latencyMs: 1 });
  os.registerProvider(remote);
  const s = os.createSession({ agentId: "a", model: "m" });
  os.sessions.addMessage(s.id, { role: "user", content: "hello", at: os.clock.iso() });

  remote.failNext(99, "auth", 401);
  const c = await os.commit.commit(s.id);
  assert.equal(c.state, "attention-required");
  assert.equal(os.sessions.get(s.id).state, "attention-required");
  assert.ok(os.attention().sessions.length === 1, "recovery state visible (attention surface)");

  remote.clearFailures();
  const r = await os.commit.retryCommit(s.id);
  assert.equal(r.state, "committed");
  assert.equal(os.sessions.get(s.id).state, "committed");
});

test("retryable commit failure → failed; retryCommit restores", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cortex-commit2-"));
  const os = createCortexOS({ dataDir: dir, clock: new ManualClock(), queue: { maxAttempts: 2, backoffBaseMs: 1 }, archive: { providerId: "mock-remote", space: "session-archives" } });
  const remote = new MockRemoteProvider({ latencyMs: 1 });
  os.registerProvider(remote);
  const s = os.createSession({ agentId: "a", model: "m" });
  os.sessions.addMessage(s.id, { role: "user", content: "hello", at: os.clock.iso() });

  remote.failNext(99, "network");
  const c = await os.commit.commit(s.id);
  assert.equal(c.state, "failed");
  assert.equal(os.sessions.get(s.id).state, "failed");

  remote.clearFailures();
  const r = await os.commit.retryCommit(s.id);
  assert.equal(r.state, "committed");
});

test("compaction commits pre-compaction data BEFORE replacing the transcript", async () => {
  const { os, local } = freshRig();
  const s = seededSession(os, 6);
  const before = os.sessions.get(s.id).messages.length;

  const res = await os.compaction.compact(s.id);
  assert.equal(res.state, "active");
  assert.equal(res.removedMessages, before);
  assert.equal(os.sessions.get(s.id).messages.length, 1, "transcript replaced by summary");
  assert.match(os.sessions.get(s.id).messages[0].content, /^\[compacted/);

  // the pre-compaction capture is durable at the provider
  const capture = await local.read("session-archives", `precompact:${s.id}`);
  assert.ok(capture, "pre-compaction capture committed first");
  assert.equal(JSON.parse(capture.content).length, before);
});

test("failed pre-compaction capture leaves the transcript untouched", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cortex-compact-"));
  const os = createCortexOS({ dataDir: dir, clock: new ManualClock(), queue: { maxAttempts: 2, backoffBaseMs: 1 }, archive: { providerId: "mock-remote", space: "session-archives" } });
  const remote = new MockRemoteProvider({ latencyMs: 1 });
  os.registerProvider(remote);
  const s = os.createSession({ agentId: "a", model: "m" });
  for (let i = 0; i < 5; i++) os.sessions.addMessage(s.id, { role: "user", content: `m${i}`, at: os.clock.iso() });

  remote.failNext(99, "auth", 401);
  const res = await os.compaction.compact(s.id);
  assert.equal(res.state, "failed");
  assert.equal(os.sessions.get(s.id).messages.length, 5, "transcript intact — no data loss");
  assert.equal(os.sessions.get(s.id).state, "failed");
  assert.match(res.error ?? "", /capture/i);
});

test("parent/subagent lineage comes from recorded runtime events", () => {
  const { os } = freshRig();
  const main = os.createSession({ agentId: "agent-main", model: "cortex-small" });
  const sub1 = os.createSession({ role: "subagent", agentId: "agent-search", model: "cortex-small", parentId: main.id, task: "search docs" });
  const sub2 = os.createSession({ role: "subagent", agentId: "agent-coder", model: "cortex-large", parentId: main.id, task: "write patch" });

  assert.equal(os.sessions.children(main.id).length, 2);
  assert.equal(os.sessions.get(sub1.id).parentId, main.id);

  // delegation recorded as an event on the PARENT (runtime evidence, not inference)
  const delegations = os.sessions.get(main.id).events.filter((e) => e.type === "delegated");
  assert.equal(delegations.length, 2);
  assert.ok(delegations.every((e) => e.type === "delegated" && (sub1.id === e.toSession || sub2.id === e.toSession)));

  // subagent sessions open independently
  assert.ok(os.sessions.tryGet(sub2.id));
  assert.equal(os.context.get(sub2.id).kind, "session");
});
