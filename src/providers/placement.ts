import type { Capability, ProviderCapabilities } from "./capabilities.js";
import type { ProviderHealth, MemoryProvider } from "./contract.js";

/**
 * Placement policy engine (Slice 2): "Smart placement applies hard
 * constraints before model selection" and every decision produces a
 * "Why this space?" receipt.
 */

export type PlacementMode =
  | "fixed"               // pinned to one provider
  | "smart"               // constraints, then scoring
  | "local-first"         // prefer local providers when able
  | "project-scoped"      // must live in project scope
  | "user-scoped"         // must live in user scope
  | "agent-peer"          // shared across agents
  | "compliance";         // restricted allowlist / residency

export interface SpaceDescriptor {
  spaceId: string;
  providerId: string;
  scope: "project" | "user" | "agent";
  status: "inactive" | "active" | "error";
}

export interface PlacementRequest {
  mode: PlacementMode;
  scope?: "project" | "user" | "agent";
  /** capabilities the write path requires, e.g. ["delete"] for governed spaces */
  requiredCapabilities?: Capability[];
  fixedProviderId?: string;
  compliance?: {
    allowedProviders?: string[];
    dataResidency?: string;
  };
}

export interface ConstraintCheck {
  name: string;
  passed: boolean;
  detail: string;
}

export interface RejectedCandidate {
  spaceId: string;
  providerId: string;
  reason: string;
}

export interface PlacementDecision {
  chosen?: { spaceId: string; providerId: string };
  mode: PlacementMode;
  hardConstraints: ConstraintCheck[];
  rejected: RejectedCandidate[];
  scores: { spaceId: string; score: number }[];
  decidedAt: string;
}

export interface PlacementInputs {
  candidates: SpaceDescriptor[];
  providers: Map<string, MemoryProvider>;
  health?: Map<string, ProviderHealth>;
  enabledProviders: Set<string>;
}

/**
 * Resolve a placement decision. Hard constraints (compliance allowlist,
 * provider enabled, required capabilities, scope match, fixed pin) are
 * evaluated FIRST; only surviving candidates are scored (health + local
 * bonus + active-space bonus). The full decision is returned so the UI can
 * render the "Why this space?" receipt.
 */
export function decidePlacement(req: PlacementRequest, inputs: PlacementInputs, now: () => string): PlacementDecision {
  const hardConstraints: ConstraintCheck[] = [];
  const rejected: RejectedCandidate[] = [];

  const addConstraint = (name: string, passed: boolean, detail: string) => hardConstraints.push({ name, passed, detail });

  if (req.mode === "compliance") {
    const allow = req.compliance?.allowedProviders ?? [];
    addConstraint("compliance-allowlist", allow.length > 0, `allowed providers: [${allow.join(", ")}]`);
  }
  if (req.requiredCapabilities?.length) {
    addConstraint("required-capabilities", true, `requires: ${req.requiredCapabilities.join(", ")}`);
  }
  if (req.mode === "fixed" && req.fixedProviderId) {
    addConstraint("fixed-provider", true, `pinned to ${req.fixedProviderId}`);
  }
  if (req.scope) addConstraint("scope-match", true, `scope must be ${req.scope}`);

  const survivors: { space: SpaceDescriptor; provider: MemoryProvider; score: number }[] = [];

  for (const space of inputs.candidates) {
    const provider = inputs.providers.get(space.providerId);
    if (!provider) { rejected.push({ spaceId: space.spaceId, providerId: space.providerId, reason: "provider not in catalog" }); continue; }
    if (!inputs.enabledProviders.has(space.providerId)) { rejected.push({ spaceId: space.spaceId, providerId: space.providerId, reason: "provider disabled (local mapping removed)" }); continue; }
    if (req.mode === "fixed" && space.providerId !== req.fixedProviderId) { rejected.push({ spaceId: space.spaceId, providerId: space.providerId, reason: `not the fixed provider (${req.fixedProviderId})` }); continue; }
    if (req.mode === "compliance") {
      const allow = req.compliance?.allowedProviders;
      if (allow && !allow.includes(space.providerId)) { rejected.push({ spaceId: space.spaceId, providerId: space.providerId, reason: "not on compliance allowlist" }); continue; }
    }
    if (req.scope && space.scope !== req.scope) { rejected.push({ spaceId: space.spaceId, providerId: space.providerId, reason: `scope ${space.scope} != required ${req.scope}` }); continue; }
    if (req.requiredCapabilities) {
      const missing = req.requiredCapabilities.filter((c) => !provider.capabilities[c]);
      if (missing.length) { rejected.push({ spaceId: space.spaceId, providerId: space.providerId, reason: `provider lacks capabilities: ${missing.join(", ")}` }); continue; }
    }

    // Scoring (soft): health, locality, activation state.
    let score = 0;
    const h = inputs.health?.get(space.providerId);
    if (h) score += h.status === "ok" ? 40 : h.status === "degraded" ? 20 : 0;
    if (req.mode === "local-first" && provider.kind === "local") score += 30;
    if (provider.kind === "local") score += 10; // mild local bonus in smart mode too
    if (space.status === "active") score += 5;
    survivors.push({ space, provider, score });
  }

  survivors.sort((a, b) => b.score - a.score);
  const scores = survivors.map((s) => ({ spaceId: s.space.spaceId, score: s.score }));

  return {
    chosen: survivors[0] ? { spaceId: survivors[0].space.spaceId, providerId: survivors[0].space.providerId } : undefined,
    mode: req.mode,
    hardConstraints,
    rejected,
    scores,
    decidedAt: now(),
  };
}
