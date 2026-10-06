/**
 * RequestSnapshot (Slice 4: Context Browser data model).
 *
 * Rules from the plan:
 * - "Every composition number equals the sum of its visible parts" — the
 *   builder ASSERTS this invariant.
 * - "Actual and estimated usage are never conflated" — estimates live on
 *   parts and `estimatedTokens`; provider-reported usage lives on `actual`.
 * - "Every context part has a source label or explicit generated/aggregate
 *   marker" — `sourceLabel` is mandatory; generated parts say so.
 */

export type ContextBucket =
  | "system" | "tools" | "injected-context" | "user"
  | "assistant" | "tool-result" | "output" | "reasoning";

export interface SnapshotPart {
  partId: string;
  bucket: ContextBucket;
  /** context item that produced this part, when it exists */
  sourceItemId?: string;
  /** never anonymous: source title, or "generated"/"aggregate" marker */
  sourceLabel: string;
  estimatedTokens: number;
  /** only ever set from provider usage breakdown, never from estimation */
  actualTokens?: number;
  pruned?: boolean;
  compactionMarker?: boolean;
  layer?: "L0" | "L1" | "L2";
  timingMs?: number;
  cached?: boolean;
}

export interface RoutingDecision {
  policy: string;
  model: string;
  providerId: string;
  reason: string;
}

export interface RequestSnapshot {
  id: string;
  sessionId: string;
  requestId: string;
  correlationId: string;
  createdAt: string;
  decision: RoutingDecision;
  parts: SnapshotPart[];
  estimatedTokens: { input: number };
  actual?: { promptTokens: number; cachedTokens: number; completionTokens: number };
  timing: { assemblyMs: number; providerMs: number; totalMs: number };
  cost?: number;
  prunedCount: number;
}

export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export class SnapshotBuilder {
  private parts: SnapshotPart[] = [];
  private n = 0;

  constructor(private init: { sessionId: string; requestId: string; correlationId: string; createdAt: string }) {}

  add(bucket: ContextBucket, text: string, opts: Partial<SnapshotPart> = {}): SnapshotPart {
    const part: SnapshotPart = {
      partId: `part_${++this.n}`,
      bucket,
      sourceLabel: opts.sourceLabel ?? (opts.sourceItemId ? opts.sourceItemId : "generated"),
      estimatedTokens: opts.estimatedTokens ?? estimateTokens(text),
      ...opts,
    };
    this.parts.push(part);
    return part;
  }

  /** Estimated input tokens over all non-pruned parts (routing decisions). */
  estimatedInput(): number {
    return this.parts.filter((p) => !p.pruned).reduce((s, p) => s + p.estimatedTokens, 0);
  }

  /** Approximate assembled text for the mock provider (size-faithful). */
  assembledPreview(): string {
    return this.parts.filter((p) => !p.pruned).map((p) => "x".repeat(p.estimatedTokens * 4)).join("\n");
  }

  build(decision: RoutingDecision, timing: RequestSnapshot["timing"], actual?: RequestSnapshot["actual"], cost?: number): RequestSnapshot {
    const included = this.parts.filter((p) => !p.pruned);
    const input = included.reduce((s, p) => s + p.estimatedTokens, 0);
    return {
      id: `snap_${this.init.requestId}`,
      sessionId: this.init.sessionId,
      requestId: this.init.requestId,
      correlationId: this.init.correlationId,
      createdAt: this.init.createdAt,
      decision,
      parts: this.parts,
      estimatedTokens: { input },
      actual,
      timing,
      cost,
      prunedCount: this.parts.length - included.length,
    };
  }
}

/** Invariant check used by tests and the read model: sums must equal parts. */
export function assertCompositionInvariant(snap: RequestSnapshot): void {
  const sum = snap.parts.filter((p) => !p.pruned).reduce((s, p) => s + p.estimatedTokens, 0);
  if (sum !== snap.estimatedTokens.input) {
    throw new Error(`composition invariant violated: parts sum ${sum} != estimatedTokens.input ${snap.estimatedTokens.input}`);
  }
  for (const p of snap.parts) {
    if (!p.sourceLabel) throw new Error(`part ${p.partId} has no source label (anonymous parts are forbidden)`);
  }
}
