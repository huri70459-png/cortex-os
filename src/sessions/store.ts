import type { SessionState } from "./lifecycle.js";
import { assertTransition } from "./lifecycle.js";

/**
 * Session store with real lineage (Slice 3 + Slice 5):
 * "Parent/child relationships come from runtime events, not UI inference."
 *
 * Every lifecycle change and every delegation/memory interaction is recorded
 * as a typed event; the Agent Network read model is built ONLY from these
 * events.
 */

export type SessionRole = "main" | "subagent" | "task";

export interface SessionMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  at: string;
  tokens?: number;
  toolName?: string;
}

export type SessionEvent =
  | { type: "spawned"; at: string; parentId?: string; task?: string }
  | { type: "state"; at: string; from: SessionState; to: SessionState; reason?: string }
  | { type: "delegated"; at: string; fromSession: string; toSession: string; task: string; tokens?: number }
  | { type: "memory-read"; at: string; sessionId: string; spaceId: string; itemIds: string[]; correlationId?: string }
  | { type: "memory-write"; at: string; sessionId: string; spaceId: string; itemIds: string[]; correlationId?: string }
  | { type: "context-shared"; at: string; sessions: string[]; spaceId: string }
  | { type: "turn"; at: string; requestId: string; tokens: { prompt: number; completion: number; cached: number }; cost: number; latencyMs: number; toolCalls: number };

export interface SessionMetrics {
  tokens: { prompt: number; completion: number; cached: number };
  cost: number;
  turns: number;
  toolCalls: number;
  activeMs: number;
}

export interface SessionRecord {
  id: string;
  role: SessionRole;
  agentId: string;
  model: string;
  parentId?: string;
  state: SessionState;
  /** phase-2 distillation state — distinct from commit state on purpose:
   *  "successful phase-one archival is not the same as completed extraction" */
  extraction: "none" | "pending" | "running" | "done" | "failed";
  startedAt: string;
  updatedAt: string;
  messages: SessionMessage[];
  metrics: SessionMetrics;
  events: SessionEvent[];
  lastError?: string;
}

export class SessionStore {
  private sessions = new Map<string, SessionRecord>();

  constructor(private now: () => string) {}

  create(init: { id: string; role: SessionRole; agentId: string; model: string; parentId?: string; task?: string }): SessionRecord {
    const rec: SessionRecord = {
      id: init.id,
      role: init.role,
      agentId: init.agentId,
      model: init.model,
      parentId: init.parentId,
      state: "active",
      extraction: "none",
      startedAt: this.now(),
      updatedAt: this.now(),
      messages: [],
      metrics: { tokens: { prompt: 0, completion: 0, cached: 0 }, cost: 0, turns: 0, toolCalls: 0, activeMs: 0 },
      events: [{ type: "spawned", at: this.now(), parentId: init.parentId, task: init.task }],
    };
    this.sessions.set(rec.id, rec);
    if (init.parentId) {
      const parent = this.sessions.get(init.parentId);
      if (parent) {
        this.recordEvent(parent.id, { type: "delegated", at: this.now(), fromSession: parent.id, toSession: rec.id, task: init.task ?? "" });
      }
    }
    return rec;
  }

  get(id: string): SessionRecord {
    const s = this.sessions.get(id);
    if (!s) throw new Error(`unknown session: ${id}`);
    return s;
  }

  tryGet(id: string): SessionRecord | undefined { return this.sessions.get(id); }

  list(): SessionRecord[] { return [...this.sessions.values()]; }

  children(parentId: string): SessionRecord[] {
    return this.list().filter((s) => s.parentId === parentId);
  }

  /** Guarded state transition; every transition is an event. */
  transition(id: string, to: SessionState, reason?: string): SessionRecord {
    const s = this.get(id);
    assertTransition(s.state, to);
    const from = s.state;
    s.state = to;
    s.updatedAt = this.now();
    this.recordEvent(id, { type: "state", at: this.now(), from, to, reason });
    return s;
  }

  recordEvent(sessionId: string, event: SessionEvent): void {
    const s = this.get(sessionId);
    s.events.push(event);
    s.updatedAt = this.now();
  }

  addMessage(sessionId: string, msg: SessionMessage): void {
    const s = this.get(sessionId);
    s.messages.push(msg);
  }

  addTurn(sessionId: string, t: { requestId: string; tokens: { prompt: number; completion: number; cached: number }; cost: number; latencyMs: number; toolCalls: number }): void {
    const s = this.get(sessionId);
    s.metrics.tokens.prompt += t.tokens.prompt;
    s.metrics.tokens.completion += t.tokens.completion;
    s.metrics.tokens.cached += t.tokens.cached;
    s.metrics.cost += t.cost;
    s.metrics.turns += 1;
    s.metrics.toolCalls += t.toolCalls;
    s.metrics.activeMs += t.latencyMs;
    this.recordEvent(sessionId, { type: "turn", at: this.now(), ...t });
  }

  /** All events across all sessions, in time order (network read-model input). */
  allEvents(): { sessionId: string; event: SessionEvent }[] {
    const out: { sessionId: string; event: SessionEvent }[] = [];
    for (const s of this.sessions.values()) for (const e of s.events) out.push({ sessionId: s.id, event: e });
    return out.sort((a, b) => a.event.at.localeCompare(b.event.at));
  }
}
