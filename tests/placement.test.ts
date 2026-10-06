import test from "node:test";
import assert from "node:assert/strict";
import { freshRig, USER } from "./helpers.js";
import { decidePlacement } from "../src/index.js";

/**
 * Slice 2 acceptance:
 * - Smart placement applies HARD CONSTRAINTS before scoring
 * - "Why this space?" decision receipt explains the choice and rejections
 */

test("hard constraints eliminate candidates before scoring", async () => {
  const { os } = freshRig();
  os.createSpace({ id: "sp_local", title: "Local", providerId: "mock-local", scope: "user", placement: "local-first" });
  os.createSpace({ id: "sp_remote", title: "Cloud", providerId: "mock-remote", scope: "user", placement: "smart" });
  os.createSpace({ id: "sp_vault", title: "Vault", providerId: "mock-limited", scope: "user", placement: "smart" });

  // require delete capability → limited vault is rejected by HARD constraint
  const d = decidePlacement(
    { mode: "smart", scope: "user", requiredCapabilities: ["delete"] },
    {
      candidates: os.spaces.list().map((s) => ({ spaceId: s.id, providerId: s.providerId, scope: s.scope, status: s.status })),
      providers: new Map(os.registry.listEnabled().map((p) => [p.id, p])),
      enabledProviders: new Set(os.registry.listEnabled().map((p) => p.id)),
    },
    () => new Date().toISOString(),
  );
  assert.ok(d.chosen);
  assert.notEqual(d.chosen.spaceId, "sp_vault");
  const vaultRejection = d.rejected.find((r) => r.spaceId === "sp_vault");
  assert.ok(vaultRejection);
  assert.match(vaultRejection.reason, /lacks capabilities: delete/);
});

test("compliance allowlist overrides preference scoring", () => {
  const { os } = freshRig();
  os.createSpace({ id: "sp_local", title: "Local", providerId: "mock-local", scope: "user", placement: "local-first" });
  os.createSpace({ id: "sp_remote", title: "Cloud", providerId: "mock-remote", scope: "user", placement: "smart", compliance: { allowedProviders: ["mock-remote"] } });

  const d = decidePlacement(
    { mode: "compliance", scope: "user", compliance: { allowedProviders: ["mock-remote"] } },
    {
      candidates: os.spaces.list().map((s) => ({ spaceId: s.id, providerId: s.providerId, scope: s.scope, status: s.status })),
      providers: new Map(os.registry.listEnabled().map((p) => [p.id, p])),
      enabledProviders: new Set(os.registry.listEnabled().map((p) => p.id)),
    },
    () => new Date().toISOString(),
  );
  // local would win on score, but the allowlist is a hard constraint
  assert.equal(d.chosen?.spaceId, "sp_remote");
  assert.ok(d.rejected.some((r) => r.spaceId === "sp_local" && /allowlist/.test(r.reason)));
});

test("'Why this space?' receipt: every proposal records its placement decision", async () => {
  const { os } = freshRig();
  os.createSpace({ id: "sp_local", title: "Local", providerId: "mock-local", scope: "user", placement: "local-first" });
  os.createSpace({ id: "sp_remote", title: "Cloud", providerId: "mock-remote", scope: "user", placement: "smart" });

  const p = os.actions.proposeSave({ content: "Prefer local-first placement", initiator: USER, placement: { mode: "local-first", scope: "user" } });
  assert.ok(p.placement);
  assert.equal(p.placement.mode, "local-first");
  assert.equal(p.placement.chosen?.spaceId, "sp_local");
  // the decision receipt explains WHY: constraints + scores + rejections
  const receipt = os.receipts.byId(p.receiptId)!;
  const placementPolicy = receipt.policyDecisions.find((d) => d.policy === "placement");
  assert.ok(placementPolicy);
  assert.equal(placementPolicy.outcome, "allow");
  assert.match(placementPolicy.reason, /local-first placement/);
  assert.ok(p.placement.scores.length >= 1);
});

test("disabled providers are excluded from placement", () => {
  const { os } = freshRig();
  os.createSpace({ id: "sp_remote", title: "Cloud", providerId: "mock-remote", scope: "user", placement: "smart" });
  os.registry.disable("mock-remote");

  const d = decidePlacement(
    { mode: "smart", scope: "user" },
    {
      candidates: os.spaces.list().map((s) => ({ spaceId: s.id, providerId: s.providerId, scope: s.scope, status: s.status })),
      providers: new Map([...os.registry.listEnabled(), os.registry.get("mock-remote")].map((p) => [p.id, p])),
      enabledProviders: new Set(os.registry.listEnabled().map((p) => p.id)),
    },
    () => new Date().toISOString(),
  );
  assert.equal(d.chosen, undefined);
  assert.match(d.rejected[0].reason, /provider disabled/);
});
