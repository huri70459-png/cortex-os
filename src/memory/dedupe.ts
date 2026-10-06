import { createHash } from "node:crypto";

/**
 * Duplicate detection with explanation (Slice 6: "Duplicate detection
 * should explain the matched item"). Exact-hash matches are definitive;
 * near-duplicates use token overlap and always carry an explanation the UI
 * can render verbatim.
 */

export interface DuplicateMatch {
  itemId: string;
  title: string;
  kind: "exact" | "near";
  similarity: number;        // 1.0 for exact hash match
  explanation: string;       // human-readable "why this is a duplicate"
}

export interface DedupeCandidate {
  content: string;
  hash: string;
}

export interface DedupeSubject {
  itemId: string;
  title: string;
  content: string;
  hash: string;
}

export function contentHash(content: string): string {
  return createHash("sha256").update(normalize(content)).digest("hex").slice(0, 16);
}

export function normalize(content: string): string {
  return content.trim().replace(/\s+/g, " ").toLowerCase();
}

function tokens(s: string): Set<string> {
  return new Set(normalize(s).split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 2));
}

export function jaccard(a: string, b: string): number {
  const ta = tokens(a), tb = tokens(b);
  if (ta.size === 0 && tb.size === 0) return 1;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

export class DuplicateDetector {
  constructor(private nearThreshold = 0.85) {}

  find(candidate: DedupeCandidate, subjects: DedupeSubject[]): DuplicateMatch | undefined {
    // 1. exact hash match is definitive
    const exact = subjects.find((s) => s.hash === candidate.hash);
    if (exact) {
      return {
        itemId: exact.itemId,
        title: exact.title,
        kind: "exact",
        similarity: 1,
        explanation: `Exact content match (sha256:${candidate.hash}) with existing memory "${exact.title}" (${exact.itemId}). Saving would duplicate it — the existing record will be updated instead.`,
      };
    }
    // 2. near-duplicate by token overlap
    let best: { subject: DedupeSubject; sim: number } | undefined;
    for (const s of subjects) {
      const sim = jaccard(candidate.content, s.content);
      if (sim >= this.nearThreshold && (!best || sim > best.sim)) best = { subject: s, sim };
    }
    if (best) {
      return {
        itemId: best.subject.itemId,
        title: best.subject.title,
        kind: "near",
        similarity: Number(best.sim.toFixed(3)),
        explanation: `Near-duplicate (${(best.sim * 100).toFixed(0)}% token overlap) of "${best.subject.title}" (${best.subject.itemId}). Review before saving; submitting unchanged content again requires an edit.`,
      };
    }
    return undefined;
  }
}
