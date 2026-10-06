import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, appendFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshRig } from "./helpers.js";
import { createCortexOS, MockLocalProvider, MockRemoteProvider, WriteAheadLog, DurableWriteQueue, ProviderRegistry, RedactionVault } from "../src/index.js";

/**
 * Slice 3 acceptance:
 * - Kill the router during a queued write and recover it
 * - Restart the process and replay only uncommitted records
 * - Verify duplicate messages are not created
 * - Simulate partial batch failure and retry only the missing suffix
 * - Retry classes: network/408/429/5xx retry; auth/validation never retry
 */

const CRASH_CHILD = fileURLToPath(new URL("./crash-child.js", import.meta.url));

test("SIGKILL during queued writes → recovery sweep replays with zero duplicates", () => {
  const dir = mkdtempSync(join(tmpdir(), "cortex-crash-"));

  // 1. run the child; it kills itself mid-write (applied-but-unacked window)
  const child = spawnSync(process.execPath, [CRASH_CHILD, dir], { encoding: "utf8", timeout: 30_000 });
  assert.equal(child.signal, "SIGKILL", `child should have been SIGKILLed (stderr: ${child.stderr})`);

  // the WAL holds unacked queued records
  const walText = readFileSync(join(dir, "wal.jsonl"), "utf8");
  assert.ok(walText.includes('"queued"'), "WAL must contain queued records at crash time");

  // 2. "restart the router": fresh instance on the same data dir
  const os = createCortexOS({ dataDir: dir, queue: { backoffBaseMs: 2 } });
  const local = new MockLocalProvider(join(dir, "local"));
  os.registerProvider(local);

  return os.recover().then((rec) => {
    // 3. all three replayed and acked
    assert.equal(rec.stats.recovered, 3);
    assert.equal(rec.receipts.length, 3);
    for (const r of rec.receipts) assert.equal(r.state, "acked");

    // 4. NO duplicates: provider applied each record exactly once;
    //    replays were deduped by idempotency key
    assert.equal(local.count("crash-space"), 3);
    assert.equal(rec.stats.duplicates, 3, "replayed writes must be reported as duplicates, not re-applied");

    // 5. WAL folded state: everything acked, nothing pending
    const wal = new WriteAheadLog({ file: join(dir, "wal.jsonl") });
    assert.equal(wal.uncommitted().length, 0);
  }).finally(() => void os.shutdown());
});

test("restart replays ONLY uncommitted records", async () => {
  const { os, local } = freshRig();

  // seed: one already-acked record + one still queued
  const done = os.wal.enqueue({
    key: "done-1", op: "provider.write",
    payload: { providerId: "mock-local", items: [{ space: "s1", record: { key: "r-done", content: "already acked" }, idempotencyKey: "ik-done" }] },
  });
  os.wal.transition(done, "acked", { result: [] });
  os.wal.enqueue({
    key: "pending-1", op: "provider.write",
    payload: { providerId: "mock-local", items: [{ space: "s1", record: { key: "r-pending", content: "needs replay" }, idempotencyKey: "ik-pending" }] },
  });
  // apply the acked one to the provider out-of-band (as if before the crash)
  await local.write("s1", [{ key: "r-done", content: "already acked" }], ["ik-done"]);

  const receipts = await os.queue.recover();
  assert.equal(receipts.length, 1, "only the uncommitted record is replayed");
  assert.equal(receipts[0].key, "pending-1");
  assert.equal(receipts[0].state, "acked");
  assert.equal(local.count("s1"), 2, "both records present exactly once");
});

test("partial batch failure retries ONLY the missing suffix", async () => {
  const { os, remote } = freshRig();
  os.createSpace({ id: "sp_remote", title: "Cloud", providerId: "mock-remote", scope: "user", placement: "fixed" });

  // item "b" fails once, then succeeds — a,c succeed on first attempt
  const flaky = new MockRemoteProvider({ latencyMs: 1, failKeyTimes: { b: 1 }, id: "mock-flaky", label: "Flaky (mock)" });
  os.registerProvider(flaky);

  const receipt = await os.queue.enqueue({
    op: "provider.write",
    payload: {
      providerId: "mock-flaky",
      items: ["a", "b", "c"].map((k) => ({ space: "batch-space", record: { key: k, content: `payload ${k}` }, idempotencyKey: `batch|${k}` })),
    },
  }, "batch-op-1");

  assert.equal(receipt.state, "acked");
  // first call carried all three; the retry carried ONLY the missing item "b"
  assert.deepEqual(flaky.writeLog, [["a", "b", "c"], ["b"]]);
  assert.equal(flaky.count("batch-space"), 3);
  void remote;
});

test("permanent auth failure is never retried and surfaces for attention", async () => {
  const { os, remote } = freshRig();
  remote.failNext(1, "auth", 401);

  const receipt = await os.queue.enqueue({
    op: "provider.write",
    payload: { providerId: "mock-remote", items: [{ space: "s", record: { key: "k", content: "x" }, idempotencyKey: "auth|k" }] },
  }, "auth-op");

  assert.equal(receipt.state, "failed-permanent");
  assert.equal(receipt.attempts, 1, "auth errors get exactly one attempt");
  assert.equal(receipt.error?.class, "auth");
  assert.equal(os.queue.needsAttention().length, 1);
});

test("validation failure (422) is permanent; 429/5xx/network are retried", async () => {
  const { os, remote } = freshRig();

  remote.failNext(1, "validation", 422);
  const perm = await os.queue.enqueue({ op: "provider.write", payload: { providerId: "mock-remote", items: [{ space: "s", record: { key: "v", content: "x" }, idempotencyKey: "val|v" }] } }, "val-op");
  assert.equal(perm.state, "failed-permanent");
  assert.equal(perm.attempts, 1);

  remote.clearFailures();
  remote.failNext(2, "rate-limit", 429, 2);
  const rl = await os.queue.enqueue({ op: "provider.write", payload: { providerId: "mock-remote", items: [{ space: "s", record: { key: "r", content: "x" }, idempotencyKey: "rl|r" }] } }, "rl-op");
  assert.equal(rl.state, "acked");
  assert.equal(rl.attempts, 3, "two 429s then success");

  remote.failNext(1, "server", 503);
  const srv = await os.queue.enqueue({ op: "provider.write", payload: { providerId: "mock-remote", items: [{ space: "s", record: { key: "s5", content: "x" }, idempotencyKey: "srv|s5" }] } }, "srv-op");
  assert.equal(srv.state, "acked");
  assert.equal(srv.attempts, 2);

  remote.failNext(1, "network");
  const net = await os.queue.enqueue({ op: "provider.write", payload: { providerId: "mock-remote", items: [{ space: "s", record: { key: "n", content: "x" }, idempotencyKey: "net|n" }] } }, "net-op");
  assert.equal(net.state, "acked");
  assert.equal(net.attempts, 2);
});

test("torn WAL line from a crash mid-append is ignored, not fatal", () => {
  const dir = mkdtempSync(join(tmpdir(), "cortex-torn-"));
  const walFile = join(dir, "wal.jsonl");
  const vault = new RedactionVault();
  const registry = new ProviderRegistry(vault);
  registry.register(new MockLocalProvider(join(dir, "local")));

  const wal = new WriteAheadLog({ file: walFile });
  wal.enqueue({ key: "good-1", op: "provider.write", payload: { providerId: "mock-local", items: [] } });
  appendFileSync(walFile, '{"seq":99,"key":"tor'); // crash mid-append

  const wal2 = new WriteAheadLog({ file: walFile });
  const scan = wal2.scan();
  assert.equal(scan.size, 1, "torn line ignored");
  assert.equal(scan.get("good-1")?.state, "queued");
  const queue = new DurableWriteQueue(wal2, registry);
  assert.equal(queue.needsAttention().length, 0);
});

test("graceful shutdown flushes in-flight writes (commit on exit)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cortex-flush-"));
  const os = createCortexOS({ dataDir: dir });
  const local = new MockLocalProvider(join(dir, "local"));
  os.registerProvider(local);
  os.createSpace({ id: "sp_local", title: "L", providerId: "mock-local", scope: "user", placement: "local-first" });

  const p = os.actions.proposeSave({ content: "shutdown-safe", initiator: { kind: "user", id: "u" } });
  const submitPromise = os.actions.submit(p.proposalId);
  await os.shutdown();               // drain in-flight
  const res = await submitPromise;
  assert.equal(res.receipt.state, "saved");
  assert.equal(local.count("sp_local"), 1);
  assert.equal(os.wal.uncommitted().length, 0);
  assert.ok(existsSync(join(dir, "receipts.jsonl")));
});
