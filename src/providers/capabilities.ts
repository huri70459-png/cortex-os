/**
 * Provider capabilities (Slice 2) — exact interface from the Tier-1 plan.
 * "A provider cannot advertise operations it does not support."
 */
export { providerError } from "../durability/retry.js";
export type { ProviderError } from "../durability/retry.js";
export interface ProviderCapabilities {
  exactWrite: boolean;      // can write a specific key deterministically
  asyncWrite: boolean;      // accepts writes and acknowledges later
  delete: boolean;          // supports remote delete
  graph: boolean;           // supports graph queries / relations
  browse: boolean;          // supports ls/tree/read style navigation
  semanticSearch: boolean;  // supports vector/hybrid search
  namespaces: boolean;      // supports multiple named spaces
  offlineQueue: boolean;    // tolerates being written to while offline (queues)
}

export const ALL_CAPABILITIES: (keyof ProviderCapabilities)[] = [
  "exactWrite", "asyncWrite", "delete", "graph", "browse", "semanticSearch", "namespaces", "offlineQueue",
];

export type Capability = keyof ProviderCapabilities;

/** Structured "unsupported" — never a fake success (Slice 2 acceptance). */
export class UnsupportedOperationError extends Error {
  readonly providerId: string;
  readonly capability: Capability;
  readonly attempted: string;
  constructor(providerId: string, capability: Capability, attempted: string) {
    super(`provider "${providerId}" does not support ${capability} (attempted: ${attempted})`);
    this.name = "UnsupportedOperationError";
    this.providerId = providerId;
    this.capability = capability;
    this.attempted = attempted;
  }
}

export function assertCapable(caps: ProviderCapabilities, providerId: string, cap: Capability, attempted: string): void {
  if (!caps[cap]) throw new UnsupportedOperationError(providerId, cap, attempted);
}
