import type { RequestSnapshot, SnapshotPart, ContextBucket } from "../snapshots/snapshot.js";

/**
 * Context Browser read model (Slice 4): per-request drilldown + diff versus
 * previous request. "A diff shows exactly what grew, changed, or was pruned."
 */

export interface BrowserPartView extends SnapshotPart {
  /** resolved at render time by the caller (context store lookup) */
  sourceUri?: string;
  sourceKind?: string;
}

export interface BucketGroup {
  bucket: ContextBucket;
  parts: BrowserPartView[];
  estimatedTokens: number;
  actualTokens?: number;
}

export interface BrowserView {
  snapshot: RequestSnapshot;
  groups: BucketGroup[];
  estimatedInput: number;
  actual?: RequestSnapshot["actual"];
  pruned: SnapshotPart[];
  compactionMarkers: SnapshotPart[];
  diff?: RequestDiff;
}

export interface DiffEntry {
  partId: string;
  matchKey: string;             // bucket|sourceItemId|sourceLabel
  change: "added" | "removed" | "grew" | "shrank" | "unchanged" | "pruned-now" | "unpruned-now";
  estimatedBefore?: number;
  estimatedAfter?: number;
}

export interface RequestDiff {
  previousRequestId?: string;
  entries: DiffEntry[];
  totals: { added: number; removed: number; grew: number; shrank: number; unchanged: number; deltaTokens: number };
}

function matchKey(p: SnapshotPart): string {
  return `${p.bucket}|${p.sourceItemId ?? ""}|${p.sourceLabel}`;
}

export function diffSnapshots(prev: RequestSnapshot | undefined, next: RequestSnapshot): RequestDiff | undefined {
  if (!prev) return undefined;
  const prevByKey = new Map(prev.parts.map((p) => [matchKey(p), p]));
  const nextByKey = new Map(next.parts.map((p) => [matchKey(p), p]));
  const entries: DiffEntry[] = [];

  for (const [key, p] of nextByKey) {
    const before = prevByKey.get(key);
    if (!before) {
      entries.push({ partId: p.partId, matchKey: key, change: "added", estimatedAfter: p.estimatedTokens });
    } else if (before.pruned && !p.pruned) {
      entries.push({ partId: p.partId, matchKey: key, change: "unpruned-now", estimatedBefore: before.estimatedTokens, estimatedAfter: p.estimatedTokens });
    } else if (p.estimatedTokens > before.estimatedTokens) {
      entries.push({ partId: p.partId, matchKey: key, change: "grew", estimatedBefore: before.estimatedTokens, estimatedAfter: p.estimatedTokens });
    } else if (p.estimatedTokens < before.estimatedTokens) {
      entries.push({ partId: p.partId, matchKey: key, change: "shrank", estimatedBefore: before.estimatedTokens, estimatedAfter: p.estimatedTokens });
    } else {
      entries.push({ partId: p.partId, matchKey: key, change: "unchanged", estimatedBefore: before.estimatedTokens, estimatedAfter: p.estimatedTokens });
    }
  }
  for (const [key, p] of prevByKey) {
    if (!nextByKey.has(key)) {
      entries.push({ partId: p.partId, matchKey: key, change: "removed", estimatedBefore: p.estimatedTokens });
    }
  }

  const count = (c: DiffEntry["change"]) => entries.filter((e) => e.change === c).length;
  return {
    previousRequestId: prev.requestId,
    entries,
    totals: {
      added: count("added"), removed: count("removed"), grew: count("grew"),
      shrank: count("shrank"), unchanged: count("unchanged"),
      deltaTokens: next.estimatedTokens.input - prev.estimatedTokens.input,
    },
  };
}

export function buildBrowserView(snapshot: RequestSnapshot, prev?: RequestSnapshot): BrowserView {
  const bucketOrder: ContextBucket[] = ["system", "tools", "injected-context", "user", "assistant", "tool-result", "reasoning", "output"];
  const groups: BucketGroup[] = [];
  for (const bucket of bucketOrder) {
    const parts = snapshot.parts.filter((p) => p.bucket === bucket);
    if (!parts.length) continue;
    groups.push({
      bucket,
      parts,
      estimatedTokens: parts.filter((p) => !p.pruned).reduce((s, p) => s + p.estimatedTokens, 0),
      actualTokens: parts.some((p) => p.actualTokens != null) ? parts.reduce((s, p) => s + (p.actualTokens ?? 0), 0) : undefined,
    });
  }
  return {
    snapshot,
    groups,
    estimatedInput: snapshot.estimatedTokens.input,
    actual: snapshot.actual,
    pruned: snapshot.parts.filter((p) => p.pruned),
    compactionMarkers: snapshot.parts.filter((p) => p.compactionMarker),
    diff: diffSnapshots(prev, snapshot),
  };
}
