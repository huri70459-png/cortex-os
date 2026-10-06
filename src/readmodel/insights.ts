import type { RequestSnapshot, ContextBucket } from "../snapshots/snapshot.js";
import type { SessionStore, SessionRecord } from "../sessions/store.js";

/**
 * Context Insights read model (Slice 4). All numbers are derived from
 * RequestSnapshot parts and session events — never re-estimated. The
 * composition invariant ("every composition number equals the sum of its
 * visible parts") holds by construction and is asserted in tests.
 */

export interface DateRange { from?: string; to?: string }

export interface Kpis {
  activeSessions: number;
  tokensUsed: number;        // ACTUAL prompt+completion (never estimates)
  estimatedTokens: number;   // shown separately, never conflated
  cost: number;
  cacheHitRate: number;      // cachedTokens / promptTokens
  toolCalls: number;
  activeTimeMs: number;
  requests: number;
}

export interface CompositionSlice { label: string; tokens: number; ms?: number }

export interface SessionCard {
  sessionId: string;
  agentId: string;
  model: string;
  state: SessionRecord["state"];
  extraction: SessionRecord["extraction"];
  turns: number;
  tokens: number;
  cost: number;
  requests: string[];
  parentId?: string;
  subagents: string[];
}

export interface Insights {
  range: DateRange;
  kpis: Kpis;
  tokenTrend: { bucket: string; tokens: number; cost: number }[];
  tokenComposition: CompositionSlice[];     // by context bucket
  timingComposition: CompositionSlice[];    // assembly vs provider
  budgetBurn?: { budget: number; spent: number; pct: number; projectedOver: boolean };
  sessionCards: SessionCard[];
  /** invariant self-check results, surfaced so the UI can show trust badges */
  invariants: { name: string; ok: boolean; detail: string }[];
}

function inRange(iso: string, r: DateRange): boolean {
  if (r.from && iso < r.from) return false;
  if (r.to && iso > r.to) return false;
  return true;
}

export function buildInsights(snapshots: RequestSnapshot[], sessions: SessionStore, range: DateRange = {}, budget?: number): Insights {
  const snaps = snapshots.filter((s) => inRange(s.createdAt, range));
  const all = sessions.list();

  const tokensUsed = snaps.reduce((t, s) => t + (s.actual ? s.actual.promptTokens + s.actual.completionTokens : 0), 0);
  const estimatedTokens = snaps.reduce((t, s) => t + s.estimatedTokens.input, 0);
  const cost = Number(snaps.reduce((t, s) => t + (s.cost ?? 0), 0).toFixed(6));
  const prompt = snaps.reduce((t, s) => t + (s.actual?.promptTokens ?? 0), 0);
  const cached = snaps.reduce((t, s) => t + (s.actual?.cachedTokens ?? 0), 0);
  const toolCalls = all.reduce((t, s) => t + s.metrics.toolCalls, 0);
  const activeTimeMs = all.reduce((t, s) => t + s.metrics.activeMs, 0);
  const activeSessions = all.filter((s) => s.state === "active" || s.state === "committing" || s.state === "compacting").length;

  // token trend by hour bucket
  const trendMap = new Map<string, { tokens: number; cost: number }>();
  for (const s of snaps) {
    const bucket = s.createdAt.slice(0, 13) + ":00";
    const e = trendMap.get(bucket) ?? { tokens: 0, cost: 0 };
    e.tokens += s.actual ? s.actual.promptTokens + s.actual.completionTokens : 0;
    e.cost += s.cost ?? 0;
    trendMap.set(bucket, e);
  }
  const tokenTrend = [...trendMap.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    .map(([bucket, v]) => ({ bucket, tokens: v.tokens, cost: Number(v.cost.toFixed(6)) }));

  // token composition by bucket — computed from PARTS so sums match exactly
  const compMap = new Map<ContextBucket, number>();
  for (const s of snaps) for (const p of s.parts) {
    if (p.pruned) continue;
    compMap.set(p.bucket, (compMap.get(p.bucket) ?? 0) + p.estimatedTokens);
  }
  const tokenComposition: CompositionSlice[] = [...compMap.entries()].map(([label, tokens]) => ({ label, tokens }));

  const assemblyMs = snaps.reduce((t, s) => t + s.timing.assemblyMs, 0);
  const providerMs = snaps.reduce((t, s) => t + s.timing.providerMs, 0);
  const timingComposition: CompositionSlice[] = [
    { label: "assembly", tokens: 0, ms: assemblyMs },
    { label: "provider", tokens: 0, ms: providerMs },
  ];

  const sessionCards: SessionCard[] = all
    .filter((s) => snaps.some((x) => x.sessionId === s.id) || range.from == null)
    .map((s) => ({
      sessionId: s.id, agentId: s.agentId, model: s.model, state: s.state, extraction: s.extraction,
      turns: s.metrics.turns,
      tokens: snaps.filter((x) => x.sessionId === s.id).reduce((t, x) => t + (x.actual ? x.actual.promptTokens + x.actual.completionTokens : 0), 0),
      cost: Number(snaps.filter((x) => x.sessionId === s.id).reduce((t, x) => t + (x.cost ?? 0), 0).toFixed(6)),
      requests: snaps.filter((x) => x.sessionId === s.id).map((x) => x.requestId),
      parentId: s.parentId,
      subagents: all.filter((c) => c.parentId === s.id).map((c) => c.id),
    }));

  const invariants: Insights["invariants"] = [];
  const compSum = tokenComposition.reduce((t, c) => t + c.tokens, 0);
  invariants.push({
    name: "composition-sum", ok: compSum === estimatedTokens,
    detail: `sum(parts)=${compSum} vs estimatedTokens=${estimatedTokens}`,
  });
  invariants.push({
    name: "actual-vs-estimated-separate", ok: true,
    detail: `tokensUsed(actual)=${tokensUsed} reported separately from estimated=${estimatedTokens}`,
  });

  return {
    range,
    kpis: { activeSessions, tokensUsed, estimatedTokens, cost, cacheHitRate: prompt ? Number((cached / prompt).toFixed(3)) : 0, toolCalls, activeTimeMs, requests: snaps.length },
    tokenTrend, tokenComposition, timingComposition,
    budgetBurn: budget != null ? { budget, spent: cost, pct: Number(((cost / budget) * 100).toFixed(1)), projectedOver: cost > budget } : undefined,
    sessionCards,
    invariants,
  };
}
