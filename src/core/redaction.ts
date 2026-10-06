/**
 * Credential redaction (Slice 2 requirement):
 * "Provider credentials never enter browser-rendered data or agent prompts."
 *
 * The RedactionVault learns secret values when providers register, then
 * scrubs them from ANY string that is about to be logged, persisted into a
 * receipt, serialized to a read model, or rendered.
 */
export class RedactionVault {
  private secrets = new Map<string, string>(); // value -> label

  register(label: string, secret: string): void {
    if (secret && secret.length >= 4) this.secrets.set(secret, label);
  }

  redact(text: string): string {
    let out = text;
    for (const [secret, label] of this.secrets) {
      if (out.includes(secret)) out = out.split(secret).join(`[redacted:${label}]`);
    }
    // Generic patterns as a second net (keys, tokens, basic-auth URLs).
    out = out.replace(/\b(sk|pk|ghp|xox[baprs]|AKIA)[-_A-Za-z0-9]{8,}\b/g, "[redacted:key-pattern]");
    out = out.replace(/\/\/[^/\s:@]+:[^@\s]+@/g, "//[redacted:basic-auth]@");
    return out;
  }

  /** Deep-redact every string inside a JSON-serializable structure. */
  redactDeep<T>(value: T): T {
    const seen = new WeakSet<object>();
    const walk = (v: unknown): unknown => {
      if (typeof v === "string") return this.redact(v);
      if (Array.isArray(v)) return v.map(walk);
      if (v && typeof v === "object") {
        if (seen.has(v as object)) return "[circular]";
        seen.add(v as object);
        const out: Record<string, unknown> = {};
        for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
          out[k] = /^(_?secret|_?password|_?token|_?apikey|_?credential)/i.test(k)
            ? "[redacted:field]"
            : walk(val);
        }
        return out;
      }
      return v;
    };
    return walk(value) as T;
  }
}
