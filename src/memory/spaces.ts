import type { PlacementMode } from "../providers/placement.js";

/**
 * Memory spaces (Slice 2). A space binds a scope + placement policy to a
 * provider. Critical activation rule from the plan:
 *
 *   "A write to an inactive space activates it only when the provider
 *    confirms success."
 *
 * So `status` starts "inactive" and only `confirmActivation()` — called by
 * the governed action layer after an acked provider write — flips it to
 * "active". Failed writes leave it inactive and local metadata intact.
 */

export type SpaceKind = "local" | "project" | "provider-backed";

export interface MemorySpace {
  id: string;
  title: string;
  kind: SpaceKind;
  scope: "project" | "user" | "agent";
  providerId: string;
  placement: PlacementMode;
  status: "inactive" | "active" | "error";
  compliance?: { allowedProviders?: string[]; dataResidency?: string };
  createdAt: string;
  activatedAt?: string;
  lastError?: string;
  itemIds: string[];           // context items (memories) living here
}

export class SpaceStore {
  private spaces = new Map<string, MemorySpace>();

  create(space: MemorySpace): MemorySpace {
    if (this.spaces.has(space.id)) throw new Error(`space exists: ${space.id}`);
    this.spaces.set(space.id, space);
    return space;
  }

  get(id: string): MemorySpace {
    const s = this.spaces.get(id);
    if (!s) throw new Error(`unknown space: ${id}`);
    return s;
  }

  list(): MemorySpace[] { return [...this.spaces.values()]; }

  byProvider(providerId: string): MemorySpace[] {
    return this.list().filter((s) => s.providerId === providerId);
  }

  /** Only called after the provider CONFIRMED a write. */
  confirmActivation(id: string, at: string): void {
    const s = this.get(id);
    if (s.status !== "active") { s.status = "active"; s.activatedAt = at; }
  }

  markError(id: string, message: string): void {
    const s = this.get(id);
    s.status = s.activatedAt ? "error" : "inactive"; // never fake-activate
    s.lastError = message;
  }

  addItem(id: string, itemId: string): void {
    const s = this.get(id);
    if (!s.itemIds.includes(itemId)) s.itemIds.push(itemId);
  }

  removeItem(id: string, itemId: string): void {
    const s = this.get(id);
    s.itemIds = s.itemIds.filter((x) => x !== itemId);
  }
}
