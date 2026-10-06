import test from "node:test";
import assert from "node:assert/strict";
import { freshRig, USER } from "./helpers.js";
import { UnsupportedOperationError } from "../src/index.js";

/**
 * Slice 2 acceptance:
 * - Create a space against a mock local provider ✓ (also in memory tests)
 * - Create a space against a mock remote provider ✓
 * - Attempt unsupported graph/delete/exact-write operations → UI reports
 *   "unsupported" rather than fake success
 * - Provider failure leaves existing spaces and local metadata intact
 * - Credentials redacted from telemetry, logs, and rendered HTML
 * - Disabling a provider removes local catalog mapping but never remote data
 */

test("capability matrix reflects each provider honestly", () => {
  const { os } = freshRig();
  const desc = os.registry.describe();
  const byId = Object.fromEntries(desc.map((d) => [d.id, d]));

  assert.equal(byId["mock-local"].capabilities.graph, true);
  assert.equal(byId["mock-remote"].capabilities.graph, false);
  assert.equal(byId["mock-remote"].capabilities.exactWrite, false);
  assert.equal(byId["mock-limited"].capabilities.delete, false);
  assert.equal(byId["mock-limited"].capabilities.browse, false);
});

test("unsupported operations throw structured errors, never fake success", async () => {
  const { os, limited, remote } = freshRig();

  // delete on a provider without delete capability
  await assert.rejects(() => limited.delete("sp", "k"), (e: unknown) => {
    assert.ok(e instanceof UnsupportedOperationError);
    assert.equal(e.capability, "delete");
    assert.match(e.message, /does not support delete/);
    return true;
  });

  // browse/read on limited provider
  await assert.rejects(() => limited.read("sp", "k"), UnsupportedOperationError);

  // graph on remote provider: method not even present + capability false
  assert.equal(remote.capabilities.graph, false);
  assert.equal("graphNeighbors" in remote, false, "remote mock must not even expose graphNeighbors");
  assert.throws(() => os.registry.assertCapable("mock-remote", "graph", "graph query"), UnsupportedOperationError);

  // exactWrite gate for remote writes keyed deterministically
  assert.throws(() => os.registry.assertCapable("mock-remote", "exactWrite", "keyed write"), UnsupportedOperationError);
});

test("credentials never reach rendered/serialized surfaces", () => {
  const { os } = freshRig();
  const secret = "sk-test-secret-value-do-not-leak-1234";

  const rendered = JSON.stringify(os.registry.describe());
  assert.ok(!rendered.includes(secret), "registry describe must not contain the secret");
  assert.ok(rendered.includes("[redacted"), "credentials shown as redacted marker");

  // vault scrubs the secret from arbitrary telemetry strings
  const telemetry = `calling provider with Authorization: Bearer ${secret}`;
  assert.ok(!os.vault.redact(telemetry).includes(secret));
  assert.match(os.vault.redact(telemetry), /\[redacted:mock-remote\.apiKey\]/);

  // deep redaction of nested structures + generic key patterns as a second net
  const nested = os.vault.redactDeep({ a: { b: [`token ${secret}`] }, apikey: "whatever" });
  assert.ok(!JSON.stringify(nested).includes(secret));
  assert.equal((nested as { apikey: string }).apikey, "[redacted:field]");
  assert.ok(!os.vault.redact("key AKIA1234567890XYZ here").includes("AKIA1234567890XYZ"));
});

test("disabling a provider removes the local mapping but never remote data", async () => {
  const { os, remote } = freshRig();
  os.createSpace({ id: "sp_remote", title: "Cloud notes", providerId: "mock-remote", scope: "user", placement: "fixed" });

  // write something to the remote provider directly (simulating prior use)
  await remote.write("sp_remote", [{ key: "k1", content: "precious data" }], ["idem-1"]);
  assert.equal(remote.count("sp_remote"), 1);

  const ev = os.registry.disable("mock-remote");
  assert.equal(ev.event, "removed-mapping");
  assert.match(ev.detail, /remote data NOT deleted/);
  assert.equal(os.registry.listEnabled().some((p) => p.id === "mock-remote"), false);

  // remote data intact
  assert.equal(remote.count("sp_remote"), 1);
  // space metadata intact
  assert.equal(os.spaces.get("sp_remote").providerId, "mock-remote");

  os.registry.enable("mock-remote");
  assert.equal(os.registry.listEnabled().some((p) => p.id === "mock-remote"), true);
});

test("space against mock remote provider: inactive until a write is CONFIRMED", async () => {
  const { os, remote } = freshRig();
  os.createSpace({ id: "sp_remote", title: "Cloud notes", providerId: "mock-remote", scope: "user", placement: "fixed" });
  assert.equal(os.spaces.get("sp_remote").status, "inactive");

  // failed write → still inactive, local metadata intact
  remote.failNext(99, "auth", 401);
  const p1 = os.actions.proposeSave({
    content: "Remote memory attempt", initiator: USER,
    placement: { mode: "fixed", scope: "user", fixedProviderId: "mock-remote" },
  });
  const r1 = await os.actions.submit(p1.proposalId, USER);
  assert.equal(r1.receipt.state, "failed");
  assert.equal(os.spaces.get("sp_remote").status, "inactive");
  assert.ok(os.spaces.get("sp_remote").lastError, "failure recorded in space metadata");

  // successful write → active
  remote.clearFailures();
  const p2 = os.actions.proposeSave({
    content: "Remote memory that lands", initiator: USER,
    placement: { mode: "fixed", scope: "user", fixedProviderId: "mock-remote" },
  });
  const r2 = await os.actions.submit(p2.proposalId, USER);
  assert.equal(r2.receipt.state, "saved");
  assert.equal(os.spaces.get("sp_remote").status, "active");
  assert.ok(os.spaces.get("sp_remote").activatedAt);
  assert.equal(remote.count("sp_remote"), 1);
});
