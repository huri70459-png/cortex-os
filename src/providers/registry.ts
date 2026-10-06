import type { MemoryProvider, ProviderHealth } from "./contract.js";
import type { Capability } from "./capabilities.js";
import { ALL_CAPABILITIES, assertCapable } from "./capabilities.js";
import type { RedactionVault } from "../core/redaction.js";

/**
 * Provider registry (Slice 2 UI surface: "Provider registry", "Provider
 * health cards", "Capability matrix").
 *
 * Key behaviors from the plan:
 * - Credentials are held out-of-band in the RedactionVault and never appear
 *   in `describe()` output, receipts, telemetry, or rendered HTML.
 * - Disabling a provider removes its local catalog mapping but NEVER
 *   deletes remote data — `disable()` records that promise in the receipt.
 */

export interface ProviderDescriptor {
  id: string;
  label: string;
  kind: MemoryProvider["kind"];
  enabled: boolean;
  capabilities: Record<Capability, boolean>;
  health?: ProviderHealth;
  credentials: "[redacted]" | "none";
  /** set when disable() removed only the local catalog mapping */
  localCatalogOnly?: boolean;
}

export interface RegistryEvent {
  at: string;
  event: "registered" | "disabled" | "enabled" | "removed-mapping" | "health";
  providerId: string;
  detail: string;
}

export class ProviderRegistry {
  private providers = new Map<string, MemoryProvider>();
  private credentials = new Map<string, Record<string, string>>();
  private enabled = new Set<string>();
  readonly events: RegistryEvent[] = [];

  constructor(private vault: RedactionVault, private now: () => string = () => new Date().toISOString()) {}

  register(provider: MemoryProvider, creds?: Record<string, string>): void {
    if (this.providers.has(provider.id)) throw new Error(`provider already registered: ${provider.id}`);
    this.providers.set(provider.id, provider);
    this.enabled.add(provider.id);
    if (creds) {
      this.credentials.set(provider.id, creds);
      for (const [k, v] of Object.entries(creds)) this.vault.register(`${provider.id}.${k}`, v);
    }
    this.events.push({ at: this.now(), event: "registered", providerId: provider.id, detail: `kind=${provider.kind}` });
  }

  get(id: string): MemoryProvider {
    const p = this.providers.get(id);
    if (!p) throw new Error(`unknown provider: ${id}`);
    return p;
  }

  tryGet(id: string): MemoryProvider | undefined { return this.providers.get(id); }

  isEnabled(id: string): boolean { return this.enabled.has(id); }

  /**
   * Disabling removes the local catalog mapping only. Remote data is never
   * touched — the event log records this explicitly for audit.
   */
  disable(id: string): RegistryEvent {
    this.enabled.delete(id);
    const ev: RegistryEvent = {
      at: this.now(), event: "removed-mapping", providerId: id,
      detail: "local catalog mapping removed; remote data NOT deleted",
    };
    this.events.push(ev);
    return ev;
  }

  enable(id: string): void {
    if (!this.providers.has(id)) throw new Error(`unknown provider: ${id}`);
    this.enabled.add(id);
    this.events.push({ at: this.now(), event: "enabled", providerId: id, detail: "" });
  }

  listEnabled(): MemoryProvider[] {
    return [...this.providers.values()].filter((p) => this.enabled.has(p.id));
  }

  /** Capability gate: throws structured UnsupportedOperationError. */
  assertCapable(id: string, cap: Capability, attempted: string): void {
    assertCapable(this.get(id).capabilities, id, cap, attempted);
  }

  async refreshHealth(): Promise<Map<string, ProviderHealth>> {
    const out = new Map<string, ProviderHealth>();
    for (const p of this.providers.values()) {
      try {
        const h = await p.health();
        out.set(p.id, h);
        this.events.push({ at: this.now(), event: "health", providerId: p.id, detail: `${h.status} ${h.latencyMs}ms` });
      } catch (e) {
        const h: ProviderHealth = { status: "down", latencyMs: -1, checkedAt: this.now(), detail: (e as Error).message };
        out.set(p.id, h);
      }
    }
    return out;
  }

  /**
   * Browser-safe description: capability matrix + health cards.
   * Credentials field is a literal constant — no secret can leak here,
   * and every string passes through the vault as a second net.
   */
  describe(health?: Map<string, ProviderHealth>): ProviderDescriptor[] {
    const rows = [...this.providers.values()].map((p) => ({
      id: p.id,
      label: p.label,
      kind: p.kind,
      enabled: this.enabled.has(p.id),
      capabilities: Object.fromEntries(ALL_CAPABILITIES.map((c) => [c, p.capabilities[c]])) as Record<Capability, boolean>,
      health: health?.get(p.id),
      credentials: (this.credentials.has(p.id) ? "[redacted]" : "none") as "[redacted]" | "none",
    }));
    return this.vault.redactDeep(rows);
  }
}
