/**
 * Core domain model for the unified Context Operating System (Slice 1).
 *
 * Design grounding:
 * - OpenViking filesystem context: stable URIs (`viking://{scope}/{path}`),
 *   three progressive layers (L0 abstract / L1 overview / L2 detail), scopes
 *   resources|user|agent. We mirror this with `cortex://` URIs and layers.
 * - VikingMem: memories are stateful, evolving records with provenance and
 *   retention semantics; short-term (session) vs long-term (distilled).
 * - Tier-1 plan: every item has stable ID, title, source/provider, scope,
 *   tier, timestamps, confidence, capabilities, provenance, related sessions,
 *   relationship links, and deletion/archive policy.
 */

/** Position in the navigable context hierarchy. */
export type ContextKind =
  | "runtime"    // ephemeral in-flight context for the current turn
  | "document"   // project documents (active or archived)
  | "space"      // memory space (a container backed by a provider)
  | "memory"     // an individual memory record inside a space
  | "skill"      // agent skill / instruction package
  | "session"    // main-agent or subagent session
  | "snapshot"   // request-level audit record (RequestSnapshot)
  | "receipt";   // durable action receipt

/** Ownership / visibility scope, mirroring viking:// scopes. */
export type ContextScope = "runtime" | "project" | "user" | "agent" | "provider";

/**
 * Progressive-loading layer (OpenViking-style):
 * L0 = one-line abstract (~100 tokens), L1 = overview (~2k tokens),
 * L2 = full detail, fetched on demand.
 */
export type Layer = "L0" | "L1" | "L2";

/** Retention / deletion-archive policy state. */
export type Retention = "ephemeral" | "session" | "durable" | "archived" | "deleted";

export type ActorKind = "user" | "agent" | "subagent" | "system" | "provider";

export interface ActorRef {
  kind: ActorKind;
  id: string;
  label?: string;
}

/** Where an item came from. `provider` is a registered provider id or "local". */
export interface SourceRef {
  provider: string;
  /** provider-native record type, e.g. "memory", "document", "session-archive" */
  kind: string;
  /** provider-side identifier, if the item is mirrored from a remote store */
  externalId?: string;
  /** human-readable source label; UI must never show an anonymous ID when this exists */
  label: string;
}

/** One provenance event in an item's history. */
export interface ProvenanceEntry {
  at: string;                 // ISO timestamp
  actor: ActorRef;
  action: string;             // e.g. "memory.save", "session.commit", "turn.assemble", "document.ingest"
  sourceRef?: string;         // URI of the originating item (for derived content)
  correlationId?: string;     // ties the entry to a receipt / request
  note?: string;
}

/** Typed relationship links between context items. */
export type LinkRel =
  | "parent"          // session lineage / hierarchy
  | "child"
  | "derived-from"    // e.g. distilled memory from a committed session
  | "cites"           // snapshot part cites a source item
  | "used-by"         // item was injected into a request
  | "session"         // item relates to a session
  | "snapshot"
  | "duplicate-of"
  | "merged-into"
  | "space";          // memory lives in this space

export interface ContextLink {
  rel: LinkRel;
  target: string;     // context item id
  label?: string;
}

/** What the current actor may do with this item (drives UI enable/disable). */
export interface ItemCapabilities {
  readable: boolean;
  writable: boolean;
  deletable: boolean;
  archivable: boolean;
  linkable: boolean;
}

export interface LayerTokens {
  l0: number;
  l1: number;
  l2: number;
}

/**
 * The normalized context item. Every UI surface renders from this model;
 * pages must not infer semantics independently (Slice 1 read-model rule).
 */
export interface ContextItem {
  id: string;                    // stable id: ctx_<kind>_<entropy>
  uri: string;                   // cortex://{scope}/{path}
  kind: ContextKind;
  title: string;
  /** L0 abstract (~one line). */
  summary?: string;
  /** L1 overview (planning/rerank detail). */
  overview?: string;
  /** L2 full content, loaded on demand. */
  body?: string;
  source: SourceRef;
  scope: ContextScope;
  layer: Layer;                  // deepest layer currently materialized
  retention: Retention;
  createdAt: string;
  updatedAt: string;
  confidence: number;            // 0..1
  capabilities: ItemCapabilities;
  provenance: ProvenanceEntry[];
  links: ContextLink[];
  relatedSessions: string[];
  tokens?: LayerTokens;
  meta?: Record<string, unknown>;
}

/** Stable UI routes required by Slice 1. */
export function uiPath(item: Pick<ContextItem, "kind" | "id">): string {
  const seg: Record<ContextKind, string> = {
    runtime: "runtime",
    document: "documents",
    space: "spaces",
    memory: "spaces",   // memories open inside their space view: /context/spaces/:id#mem=:memId
    skill: "skills",
    session: "sessions",
    snapshot: "sessions", // snapshots open inside session request view
    receipt: "receipts",
  };
  return `/context/${seg[item.kind]}/${item.id}`;
}

/** Minimal constructor with sane defaults; callers override what they own. */
export function makeContextItem(init: Partial<ContextItem> & Pick<ContextItem, "id" | "uri" | "kind" | "title" | "source" | "scope">, now: string): ContextItem {
  return {
    layer: "L2",
    retention: "durable",
    createdAt: now,
    updatedAt: now,
    confidence: 1,
    capabilities: { readable: true, writable: true, deletable: true, archivable: true, linkable: true },
    provenance: [],
    links: [],
    relatedSessions: [],
    ...init,
  };
}
