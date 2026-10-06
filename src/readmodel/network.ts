import type { SessionStore } from "../sessions/store.js";

/**
 * Agent Network read model (Slice 5). Node/edge interfaces are EXACTLY the
 * Tier-1 plan's models. Crucially, everything is derived from recorded
 * runtime events (spawned/delegated/memory-read/memory-write/context-shared)
 * — "Parent/child relationships come from runtime events, not UI
 * inference."
 */

export interface AgentNode {
  id: string;
  sessionId: string;
  parentId?: string;
  role: "main" | "subagent" | "task";
  status: "idle" | "running" | "completed" | "failed";
  tokens: number;
  turns: number;
  model: string;
}

export interface AgentEdge {
  from: string;
  to: string;
  type: "delegates" | "shares-context" | "reads-memory" | "writes-memory";
  tokens?: number;
  count?: number;
  /** extra render metadata (space id, item ids) — never inferred, always from events */
  meta?: Record<string, unknown>;
}

export interface AgentNetwork {
  nodes: AgentNode[];
  edges: AgentEdge[];
  stats: { nodeCount: number; edgeCount: number; failedBranches: number; maxDepth: number };
}

function mapStatus(state: string): AgentNode["status"] {
  switch (state) {
    case "active": case "committing": case "compacting": case "retrying": return "running";
    case "committed": case "archived": return "completed";
    case "failed": case "attention-required": return "failed";
    default: return "idle";
  }
}

export function buildAgentNetwork(sessions: SessionStore): AgentNetwork {
  const all = sessions.list();
  const nodes: AgentNode[] = all.map((s) => ({
    id: s.id,
    sessionId: s.id,
    parentId: s.parentId,
    role: s.role,
    status: mapStatus(s.state),
    tokens: s.metrics.tokens.prompt + s.metrics.tokens.completion,
    turns: s.metrics.turns,
    model: s.model,
  }));

  const edges: AgentEdge[] = [];
  const memReads = new Map<string, { count: number; meta: Record<string, unknown> }>();
  const memWrites = new Map<string, { count: number; meta: Record<string, unknown> }>();
  const shares = new Map<string, { sessions: Set<string>; count: number }>();

  for (const { sessionId, event } of sessions.allEvents()) {
    switch (event.type) {
      case "delegated":
        edges.push({ from: event.fromSession, to: event.toSession, type: "delegates", tokens: event.tokens ?? 0, count: 1, meta: { task: event.task } });
        break;
      case "memory-read": {
        const k = `${sessionId}|${event.spaceId}`;
        const e = memReads.get(k) ?? { count: 0, meta: { spaceId: event.spaceId, itemIds: [] as string[] } };
        e.count++;
        (e.meta.itemIds as string[]).push(...event.itemIds);
        memReads.set(k, e);
        break;
      }
      case "memory-write": {
        const k = `${sessionId}|${event.spaceId}`;
        const e = memWrites.get(k) ?? { count: 0, meta: { spaceId: event.spaceId, itemIds: [] as string[] } };
        e.count++;
        (e.meta.itemIds as string[]).push(...event.itemIds);
        memWrites.set(k, e);
        break;
      }
      case "context-shared": {
        const k = event.spaceId;
        const e = shares.get(k) ?? { sessions: new Set<string>(), count: 0 };
        for (const s of event.sessions) e.sessions.add(s);
        e.count++;
        shares.set(k, e);
        break;
      }
    }
  }

  for (const [k, v] of memReads) {
    const [sessionId, spaceId] = k.split("|");
    edges.push({ from: sessionId, to: `space:${spaceId}`, type: "reads-memory", count: v.count, meta: v.meta });
  }
  for (const [k, v] of memWrites) {
    const [sessionId, spaceId] = k.split("|");
    edges.push({ from: sessionId, to: `space:${spaceId}`, type: "writes-memory", count: v.count, meta: v.meta });
  }
  for (const [spaceId, v] of shares) {
    const arr = [...v.sessions];
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        edges.push({ from: arr[i], to: arr[j], type: "shares-context", count: v.count, meta: { spaceId } });
      }
    }
  }

  // depth via lineage
  const depthOf = (id: string): number => {
    let d = 0, cur = all.find((s) => s.id === id);
    while (cur?.parentId) { d++; cur = all.find((s) => s.id === cur!.parentId); if (d > 100) break; }
    return d;
  };

  return {
    nodes,
    edges,
    stats: {
      nodeCount: nodes.length,
      edgeCount: edges.length,
      failedBranches: nodes.filter((n) => n.status === "failed").length,
      maxDepth: Math.max(0, ...nodes.map((n) => depthOf(n.id))),
    },
  };
}

/** Collapse completed branches (UI helper from the plan's interactions). */
export function collapseCompleted(net: AgentNetwork): AgentNetwork {
  const completed = new Set(net.nodes.filter((n) => n.status === "completed" && n.role !== "main").map((n) => n.id));
  return {
    ...net,
    nodes: net.nodes.filter((n) => !completed.has(n.id) || n.role === "main"),
    edges: net.edges.filter((e) => !completed.has(e.from) && !completed.has(e.to)),
    stats: net.stats,
  };
}
