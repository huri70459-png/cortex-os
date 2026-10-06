import test from "node:test";
import assert from "node:assert/strict";
import { freshRig, USER } from "./helpers.js";
import { uiPath, cortexUri } from "../src/index.js";

/**
 * Slice 1 acceptance:
 * - Navigable hierarchy: Context > Runtime / Documents(Active|Archived) /
 *   Memory spaces(Local|Project|Provider-backed) / Skills / Sessions(Main|Subagents)
 * - Stable links: /context/runtime/:id, /context/documents/:id, /context/spaces/:id, /context/sessions/:id
 * - No anonymous IDs where a source label is available
 */

test("context tree exposes the full Slice-1 hierarchy", () => {
  const { os } = freshRig();
  os.createSpace({ id: "sp_local", title: "Local notes", providerId: "mock-local", scope: "user", placement: "local-first" });
  os.createSpace({ id: "sp_proj", title: "Project knowledge", providerId: "mock-remote", scope: "project", placement: "project-scoped" });

  os.context.put({
    id: "ctx_document_doc1", uri: cortexUri("project", "docs/arch.md"), kind: "document",
    title: "Architecture", source: { provider: "local", kind: "document", label: "Project docs" }, scope: "project",
  });
  os.context.put({
    id: "ctx_document_doc2", uri: cortexUri("project", "docs/old.md"), kind: "document",
    title: "Legacy notes", source: { provider: "local", kind: "document", label: "Project docs" }, scope: "project", retention: "archived",
  });
  os.context.put({
    id: "ctx_skill_s1", uri: cortexUri("agent", "skills/reviewer/SKILL.md"), kind: "skill",
    title: "Code reviewer", source: { provider: "local", kind: "skill", label: "Skills" }, scope: "agent",
  });
  const main = os.createSession({ agentId: "agent-main", model: "cortex-small" });
  os.createSession({ role: "subagent", agentId: "agent-search", model: "cortex-small", parentId: main.id, task: "find docs" });

  const tree = os.context.tree();
  const titles = (n: { title: string }) => n.title;
  assert.equal(titles(tree), "Context");
  const groups = tree.children.map(titles);
  assert.deepEqual(groups, ["Runtime", "Documents", "Memory spaces", "Skills", "Sessions"]);

  const docs = tree.children[1];
  assert.deepEqual(docs.children.map(titles), ["Active", "Archived"]);
  assert.equal(docs.children[0].children.length, 1);
  assert.equal(docs.children[1].children.length, 1);

  const spaces = tree.children[2];
  assert.deepEqual(spaces.children.map(titles), ["Local", "Project", "Provider-backed"]);
  assert.equal(spaces.children[0].children.length, 1, "local space present");
  assert.equal(spaces.children[1].children.length, 1, "project space present");

  const sessions = tree.children[4];
  assert.deepEqual(sessions.children.map(titles), ["Main agent", "Subagents"]);
  assert.equal(sessions.children[0].children.length, 1, "main session");
  assert.equal(sessions.children[0].children[0].children.length, 1, "subagent nested under parent");
});

test("stable UI links exist for every kind", () => {
  assert.equal(uiPath({ kind: "runtime", id: "ctx_runtime_x" }), "/context/runtime/ctx_runtime_x");
  assert.equal(uiPath({ kind: "document", id: "ctx_document_x" }), "/context/documents/ctx_document_x");
  assert.equal(uiPath({ kind: "space", id: "sp_x" }), "/context/spaces/sp_x");
  assert.equal(uiPath({ kind: "session", id: "ses_x" }), "/context/sessions/ses_x");
});

test("items carry source, scope, tier, provenance, capabilities and resolve with labels", async () => {
  const { os } = freshRig();
  os.createSpace({ id: "sp_local", title: "Local notes", providerId: "mock-local", scope: "user", placement: "local-first" });
  const p = os.actions.proposeSave({ content: "Always run tests before commit.", title: "Testing rule", initiator: USER });
  const res = await os.actions.submit(p.proposalId, USER);
  assert.ok(res.item);
  const item = res.item!;

  // every required Slice-1 field is populated
  assert.ok(item.id && item.title && item.uri);
  assert.equal(item.source.label, "Local Store (mock)"); // source label, not anonymous
  assert.equal(item.scope, "user");
  assert.ok(item.layer);
  assert.ok(item.createdAt && item.updatedAt);
  assert.ok(item.confidence > 0 && item.confidence <= 1);
  assert.ok(item.capabilities.readable && item.capabilities.writable);
  assert.ok(item.provenance.length >= 1);
  assert.equal(item.provenance[0].action, "memory.save");
  assert.ok(item.links.some((l) => l.rel === "space" && l.target === "sp_local"));

  const resolved = os.context.resolve(item.id);
  assert.equal(resolved.uiPath, `/context/spaces/${item.id}`);
  for (const l of resolved.links) {
    // no unexplained anonymous IDs: linked items resolve or carry a label
    assert.ok(l.item || l.label, `link ${l.rel} -> ${l.target ?? "?"} must resolve or be labeled`);
  }
});

test("ls/find navigation over cortex:// URIs is deterministic", () => {
  const { os } = freshRig();
  os.context.put({ id: "ctx_document_a", uri: cortexUri("project", "docs/a.md"), kind: "document", title: "Alpha doc", source: { provider: "local", kind: "document", label: "docs" }, scope: "project" });
  os.context.put({ id: "ctx_document_b", uri: cortexUri("project", "docs/b.md"), kind: "document", title: "Beta doc", source: { provider: "local", kind: "document", label: "docs" }, scope: "project" });
  os.context.put({ id: "ctx_document_c", uri: cortexUri("project", "other/c.md"), kind: "document", title: "Gamma", source: { provider: "local", kind: "document", label: "docs" }, scope: "project" });

  assert.equal(os.context.ls("cortex://project/docs").length, 2);
  assert.equal(os.context.find("alpha").length, 1);
  assert.equal(os.context.findByUri("cortex://project/docs/b.md")?.id, "ctx_document_b");
});
