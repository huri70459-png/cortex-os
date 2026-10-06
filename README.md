# CortexOS — Unified Context Operating System (prototype)

Reference implementation of the **Tier 1 foundation** for CortexRouter: one durable,
attributable, capability-aware, inspectable model for every context operation.

> Highest-leverage principle: *make every context operation durable, attributable,
> capability-aware, and inspectable. Then the dashboards and graphs become trustworthy
> read models instead of decorative UI.*

Standalone by design (zero runtime deps, injectable clock, file-backed durability) so it
can be merged into CortexRouter as the core package behind the existing UI routes.

```
npm install     # typescript + @types/node only
npm run build   # tsc → dist/
npm test        # 47 acceptance tests (node:test), incl. a real SIGKILL crash/recovery test
npm run demo    # end-to-end walkthrough of the 10-point Tier-1 success definition
```

---

## What is implemented, by slice

### Slice 1 — Unified context model (`src/core`, `src/context`)

- `ContextItem` — the normalized record behind every UI surface: stable id, title,
  `source` (provider + label + externalId), `scope`, `layer` (L0/L1/L2 progressive
  loading), retention policy, timestamps, confidence, per-item `capabilities`,
  append-only `provenance`, typed `links`, related sessions.
- `cortex://{scope}/{path}` URIs (mirrors OpenViking's `viking://` stable addressing)
  and deterministic `ls` / `tree` / `find` navigation.
- `ContextStore.tree()` renders exactly the plan's hierarchy:
  `Context > Runtime | Documents(Active|Archived) | Memory spaces(Local|Project|Provider-backed) | Skills | Sessions(Main|Subagents)`.
- Stable UI links via `uiPath()`: `/context/runtime/:id`, `/context/documents/:id`,
  `/context/spaces/:id`, `/context/sessions/:id`.
- `RequestSnapshot` is preserved as the request-level audit record (`src/snapshots`).

### Slice 2 — Provider federation (`src/providers`)

- `ProviderCapabilities` — the exact interface from the plan (exactWrite, asyncWrite,
  delete, graph, browse, semanticSearch, namespaces, offlineQueue).
- `MemoryProvider` contract (the Phase-3 "remote HTTP provider contract" surface):
  batch `write` with parallel idempotency keys, `read`, `search`, `delete`,
  `listNamespaces`, optional `graphNeighbors`, `health`.
- Three mock providers: **local** (full capabilities, disk-backed), **remote**
  (async-write, no graph/exactWrite, failure injection: network/408/429/5xx/auth/
  validation + per-key partial-batch failures), **limited** (append-only vault:
  no delete/browse/graph — for "unsupported" honesty tests).
- `ProviderRegistry`: health cards, capability matrix (`describe()` is browser-safe —
  credentials are a literal `"[redacted]"` constant and every string passes the
  `RedactionVault`), disable = *remove local catalog mapping, never remote data*.
- `decidePlacement`: hard constraints (compliance allowlist, required capabilities,
  scope, fixed pin, enabled) evaluated **before** scoring; returns a full
  "Why this space?" decision (constraints, rejections with reasons, scores).
- Spaces activate **only on provider-confirmed writes** (`SpaceStore.confirmActivation`);
  failed writes leave the space inactive and local metadata intact.

### Slice 3 — Durable session, commit & recovery (`src/durability`, `src/sessions`)

- `WriteAheadLog`: append-only JSONL, fsync per append, state transitions appended
  (never rewritten), torn trailing lines ignored, cursor-free fold-to-latest scan.
- `DurableWriteQueue`: idempotency keys end-to-end, in-flight dedupe, **partial batch
  failure retries only the missing suffix with original keys**, retry classes
  (network/408/429/5xx retried with capped exponential backoff + Retry-After;
  auth/validation → `failed-permanent` → attention surface), `recover()` startup
  sweep replaying only uncommitted records, `flush()` for commit-on-graceful-shutdown.
- Session state machine exactly as specced: `active → committing → committed →
  archived`, `active → compacting → active`, `active → failed → retrying →
  active | attention-required`; invalid transitions throw `InvalidTransitionError`.
- `CommitEngine` implements the OpenViking two-phase semantics: **phase 1 = synchronous
  durable archive** (session reaches `committed` only after provider ack), **phase 2 =
  asynchronous distillation** tracked separately (`extraction: pending|running|done|failed`).
  Extraction failure never un-commits; distilled memories flow through the governed
  action pipeline, so they arrive with receipts (or `partly-saved` per-item status).
- `CompactionEngine`: pre-compaction capture must be **acked before** the transcript is
  replaced; failed capture ⇒ `failed` state, transcript untouched.
- Parent/subagent lineage recorded as runtime events (`spawned`, `delegated`) — never
  inferred by UI.

### Slice 6 — Governed memory actions & receipts (`src/memory`)

- Full action-state vocabulary: `proposed approved running saved updated submitted
  partly-saved skipped failed reverted`.
- `proposeSave → editProposal → submit`: editing before submission is first-class;
  resubmitting an unchanged candidate is **skipped** (resubmit guard); exact
  duplicates become `updated` receipts pointing at the existing item id; near
  duplicates carry a rendered explanation (token-overlap evidence).
- Receipts contain: action, candidate (+hash + edit lineage), initiator, policy
  decisions, provider, space, before/after, per-item results, retry state,
  correlation id, links to session/snapshot/queue key. Durable JSONL, redacted on
  write, searchable by session/correlation/item/receipt id.
- Archive = cold searchable reference (body dropped, summary kept, L1); delete =
  soft by default; hard delete gated on provider capability and reports
  `unsupported: …` honestly when absent. Merge links sources (`merged-into`) and
  archives them. Recall produces a receipt with source links for every hit.

### Read models for Slices 4 & 5 (`src/readmodel`, `src/router`)

- `TurnRouter.routeTurn` assembles a real turn: recall (governed, receipted) →
  parts with `sourceItemId`/`sourceLabel` (generated parts explicitly marked) →
  budget-policy routing decision (policy/model/provider/reason) → mock provider
  reports **actual** prompt/cached/completion tokens (never conflated with
  estimates) → snapshot persisted as a context item citing every source.
- `buildInsights`: KPIs (active sessions, actual vs estimated tokens, cost, cache
  hit, tool calls, active time), trend, token/timing composition computed **from
  parts** so sums match by construction, session cards with state+extraction,
  budget burn, self-checked invariants.
- `buildBrowserView` + `diffSnapshots`: bucket groups, pruned parts, compaction
  markers, per-part provenance, and a diff showing exactly what was added/removed/
  grew/shrank/unpruned with token deltas.
- `buildAgentNetwork`: `AgentNode`/`AgentEdge` exactly as specced, derived **only**
  from recorded events (delegates / shares-context / reads-memory / writes-memory),
  with `collapseCompleted` for the UI. 100 nodes build in <10 ms.

---

## Acceptance-criteria map (plan → test)

| Plan acceptance criterion | Test |
|---|---|
| Kill router during queued write, recover it | `durability.test.ts` → *SIGKILL during queued writes…* (spawns `crash-child`, real SIGKILL) |
| Restart replays only uncommitted records | *restart replays ONLY uncommitted records* |
| Duplicate messages are not created | *SIGKILL…* (duplicates suppressed via idempotency keys) + *failed writes can be retried safely* |
| Partial batch failure retries only missing suffix | *partial batch failure retries ONLY the missing suffix* (asserts provider `writeLog == [[a,b,c],[b]]`) |
| Compaction commits data first | *compaction commits pre-compaction data BEFORE replacing…* + failure variant |
| Recovery state visible in UI | `os.attention()` (queue + sessions + extraction) asserted in commit tests |
| Unsupported ops reported, not simulated | *unsupported operations throw structured errors…* + *hard delete reports "unsupported" honestly* |
| Provider failure leaves spaces/metadata intact | *space against mock remote provider…* + *partial provider failure…* |
| Credentials redacted everywhere | *credentials never reach rendered/serialized surfaces* + demo security check |
| Space activates only on confirmed write | *space … inactive until a write is CONFIRMED* |
| Duplicate saves → "updated" with existing ID | *duplicate save becomes 'updated'…* |
| Partial saves show per-item status | *partial provider failure → partly-saved…* |
| Receipts searchable from session detail | *save produces a receipt…* + *recall produces a receipt…* |
| Edit before submit / changed-candidate rule | *editing before submission…* + *resubmitting an unchanged candidate is skipped* |
| Composition numbers equal sum of parts | *KPIs and compositions…* + per-turn invariant in *100-turn benchmark* |
| Every part has a source label | *Context Browser: every part has a source label…* |
| Actual vs estimated never conflated | asserted in insights/browser tests |
| Diff shows exactly what grew/changed/pruned | *diff versus previous request…* + *pruned parts and compaction markers…* |
| Lineage from runtime events, failed subagents inspectable | *Agent Network is built ONLY from runtime events* + *parent/subagent lineage…* |
| Graph usable at 100+ nodes | *100-node Agent Network builds fast…* |
| 100-turn context benchmark | *100-turn benchmark: invariants hold on every request* |

## Grounding in the reference material

- **OpenViking product docs** — filesystem context (`viking://` → `cortex://`),
  L0/L1/L2 progressive layers, deterministic ops (ls/tree/find), scopes
  (resources/user/agent → project/user/agent), snapshot versioning intent, and the
  session-commit semantics: *"archives it synchronously, then distills long-term
  memory asynchronously"* — implemented literally as commit phase 1 / phase 2.
- **OpenViking integrations** — per-turn async upload, commit-on-threshold, hooks
  lifecycle (SessionStart inject / recall per prompt / Stop capture / SessionEnd
  commit) inform the router-turn and commit-engine seams.
- **VikingMem paper (2605.29640)** — Memory Base principles (selective extraction,
  stateful evolution, short-term session vs long-term distilled memory, hybrid
  recall) shape the memory classes, dedupe/evolution receipts, and extraction
  pipeline (the distiller is injectable; the default is a deterministic heuristic).
- **VikingRAG paper (2609.11390)** — directory-aware retrieval that keeps
  surrounding context motivates URI-scoped `ls/find` read models and per-part
  provenance rather than flat vector hits.

Per your instruction, operational commands/URLs in the references were treated as
reference content only — nothing was executed or adopted against external services;
all providers here are local mocks.

## Layout

```
src/
  core/        types (ContextItem…), ids/URIs, clock, redaction vault
  context/     ContextStore: normalized items, hierarchy, ls/tree/find, resolve
  providers/   capabilities, contract, registry, placement, mocks/{local,remote,limited}
  durability/  WAL, DurableWriteQueue, retry classification/backoff
  memory/      spaces, dedupe, governed actions, receipt log
  sessions/    lifecycle state machine, store+lineage events, commit engine, compaction
  router/      turn assembly → snapshot → usage/cost
  snapshots/   RequestSnapshot + composition invariant
  readmodel/   insights, browser+diff, agent network
tests/         47 acceptance tests + crash-child fixture (real SIGKILL)
demo/          scenario.ts — 10-point Tier-1 success walkthrough
```

## Merging into CortexRouter (Phase 2+ seams)

1. **Replace mock providers** with the real adapters (local store, OpenViking-style
   filesystem provider, remote HTTP) — they implement `MemoryProvider` unchanged.
2. **Bind UI routes** to read models: `/context/*` pages render `ContextStore.tree()`
   / `resolve()`; Insights renders `buildInsights`; the request drilldown renders
   `buildBrowserView`; Agent Network renders `buildAgentNetwork`.
3. **Wire lifecycle hooks**: call `os.recover()` on router startup, `os.shutdown()`
   on graceful exit, surface `os.attention()` in the recovery/attention UI.
4. **Swap the mock model gateway** in `TurnRouter` for the real provider call; the
   snapshot contract (`actual` vs `estimated`) already matches usage reporting.
5. Keep `RequestSnapshot` as-is for existing telemetry consumers; snapshots are also
   stored as context items so the browser can cite them.

## Known prototype boundaries

- The distiller is a deterministic heuristic (VikingMem-style learned extraction is
  out of scope for Tier 1); the seam is the injectable `Distiller`.
- `MockRemoteProvider` keeps its idempotency set in memory — a real remote provider
  dedupes server-side; the local mock persists applied keys to disk, which is what
  the crash test relies on.
- Reverted state exists in the vocabulary; an undo pipeline (compensating writes)
  is Phase 2 work.
- Snapshots live in memory + context store; persisting them through the WAL for
  cross-restart browser history is a small follow-up (same queue, new op).
# cortex-os
# cortex-os
# cortex-os
