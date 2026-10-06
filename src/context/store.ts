import type { ContextItem, ContextKind, ContextLink, LinkRel, ProvenanceEntry, Retention } from "../core/types.js";
import { makeContextItem, uiPath } from "../core/types.js";
import { parseCortexUri } from "../core/ids.js";

/**
 * The normalized context store (Slice 1). One first-class model unifying
 * runtime memory, documents, memory spaces, skills, sessions, snapshots,
 * and receipts — with filesystem-style navigation (OpenViking: ls/tree/find)
 * over cortex:// URIs, provenance on every mutation, and typed links.
 *
 * This is the single write model; UI pages consume read models built on top
 * of it instead of inferring semantics independently.
 */

export interface ContextTreeNode {
  id: string;
  title: string;
  kind: ContextKind | "group";
  uri?: string;
  uiPath?: string;
  retention?: Retention;
  children: ContextTreeNode[];
  count?: number;
}

export class ContextStore {
  private items = new Map<string, ContextItem>();
  private byUri = new Map<string, string>();

  constructor(private now: () => string) {}

  put(init: Parameters<typeof makeContextItem>[0]): ContextItem {
    const item = makeContextItem(init, this.now());
    this.items.set(item.id, item);
    this.byUri.set(item.uri, item.id);
    return item;
  }

  get(id: string): ContextItem {
    const it = this.items.get(id);
    if (!it) throw new Error(`unknown context item: ${id}`);
    return it;
  }

  tryGet(id: string): ContextItem | undefined { return this.items.get(id); }

  findByUri(uri: string): ContextItem | undefined {
    const id = this.byUri.get(uri);
    return id ? this.items.get(id) : undefined;
  }

  list(filter?: { kind?: ContextKind; scope?: string; retention?: Retention; spaceId?: string }): ContextItem[] {
    let out = [...this.items.values()];
    if (filter?.kind) out = out.filter((i) => i.kind === filter.kind);
    if (filter?.scope) out = out.filter((i) => i.scope === filter.scope);
    if (filter?.retention) out = out.filter((i) => i.retention === filter.retention);
    if (filter?.spaceId) out = out.filter((i) => i.links.some((l) => l.rel === "space" && l.target === filter.spaceId));
    return out.sort((a, b) => a.title.localeCompare(b.title));
  }

  touch(id: string, patch: Partial<ContextItem>): ContextItem {
    const it = this.get(id);
    Object.assign(it, patch, { updatedAt: this.now() });
    return it;
  }

  addProvenance(id: string, entry: Omit<ProvenanceEntry, "at">): void {
    const it = this.get(id);
    it.provenance.push({ at: this.now(), ...entry });
    it.updatedAt = this.now();
  }

  link(fromId: string, rel: LinkRel, targetId: string, label?: string): void {
    const from = this.get(fromId);
    const link: ContextLink = { rel, target: targetId, label };
    if (!from.links.some((l) => l.rel === rel && l.target === targetId)) from.links.push(link);
    // maintain inverse for the navigable pairs
    const inverse: Partial<Record<LinkRel, LinkRel>> = {
      parent: "child", child: "parent", "derived-from": "cites",
      "merged-into": "duplicate-of", session: "session", space: "space",
    };
    const inv = inverse[rel];
    const target = this.items.get(targetId);
    if (inv && target && !target.links.some((l) => l.rel === inv && l.target === fromId)) {
      target.links.push({ rel: inv, target: fromId, label });
    }
  }

  setRetention(id: string, retention: Retention): void {
    const it = this.get(id);
    it.retention = retention;
    it.updatedAt = this.now();
    if (retention === "deleted") {
      it.capabilities = { readable: false, writable: false, deletable: false, archivable: false, linkable: true };
    }
    if (retention === "archived") {
      it.capabilities = { ...it.capabilities, writable: false, deletable: false, archivable: false };
    }
  }

  /** ls-style listing of a cortex:// directory prefix. */
  ls(prefix: string): ContextItem[] {
    const norm = prefix.endsWith("/") ? prefix : prefix + "/";
    return [...this.items.values()].filter((i) => i.uri.startsWith(norm) || i.uri === prefix);
  }

  /** tree-style hierarchical view — exactly the Slice-1 UI hierarchy. */
  tree(): ContextTreeNode {
    const group = (title: string, children: ContextTreeNode[], count?: number): ContextTreeNode =>
      ({ id: `group:${title.toLowerCase().replace(/\s+/g, "-")}`, title, kind: "group", children, count });
    const node = (i: ContextItem): ContextTreeNode => ({
      id: i.id, title: i.title, kind: i.kind, uri: i.uri, uiPath: uiPath(i), retention: i.retention, children: [],
    });

    const runtime = this.list({ kind: "runtime" }).map(node);
    const docsActive = this.list({ kind: "document", retention: "durable" }).map(node);
    const docsArchived = this.list({ kind: "document", retention: "archived" }).map(node);
    const spaces = this.list({ kind: "space" })
      .filter((s) => !s.meta?.["providerDescriptor"]) // registry catalog entries are not memory spaces
      .map((s) => {
      const memories = this.list({ kind: "memory" })
        .filter((m) => m.links.some((l) => l.rel === "space" && l.target === s.id))
        .map(node);
      return { ...node(s), children: memories };
    });
    const localSpaces = spaces.filter((s) => this.get(s.id).meta?.["spaceKind"] === "local");
    const projectSpaces = spaces.filter((s) => this.get(s.id).scope === "project" && this.get(s.id).meta?.["spaceKind"] !== "local");
    const providerSpaces = spaces.filter((s) => !localSpaces.includes(s) && !projectSpaces.includes(s));
    const skills = this.list({ kind: "skill" }).map(node);
    const sessions = this.list({ kind: "session" });
    const mainSessions = sessions.filter((s) => !s.links.some((l) => l.rel === "parent")).map((s) => {
      const children = sessions
        .filter((c) => c.links.some((l) => l.rel === "parent" && l.target === s.id))
        .map(node);
      return { ...node(s), children };
    });
    const orphanSubagents = sessions
      .filter((s) => s.links.some((l) => l.rel === "parent") && !mainSessions.some((m) => m.children.some((c) => c.id === s.id)))
      .map(node);

    return group("Context", [
      group("Runtime", runtime),
      group("Documents", [group("Active", docsActive), group("Archived", docsArchived)]),
      group("Memory spaces", [group("Local", localSpaces), group("Project", projectSpaces), group("Provider-backed", providerSpaces)]),
      group("Skills", skills),
      group("Sessions", [group("Main agent", mainSessions), group("Subagents", orphanSubagents)]),
    ]);
  }

  /** find-style search over titles/summaries (deterministic, no vectors). */
  find(query: string): ContextItem[] {
    const q = query.toLowerCase();
    return [...this.items.values()].filter((i) =>
      i.title.toLowerCase().includes(q) || (i.summary ?? "").toLowerCase().includes(q));
  }

  /** Full resolve for the UI: item + every linked neighbor with labels. */
  resolve(id: string): { item: ContextItem; uiPath: string; links: { rel: LinkRel; target: string; item?: ContextItem; label?: string }[]; provenance: ProvenanceEntry[] } {
    const item = this.get(id);
    return {
      item,
      uiPath: uiPath(item),
      links: item.links.map((l) => ({ rel: l.rel, target: l.target, item: this.items.get(l.target), label: l.label })),
      provenance: [...item.provenance],
    };
  }

  static uriScope(uri: string): string | null {
    return parseCortexUri(uri)?.scope ?? null;
  }
}
