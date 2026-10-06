/** Injectable clock so tests and demos are deterministic. */
export interface Clock {
  now(): Date;
  iso(): string;
}

export class SystemClock implements Clock {
  now(): Date { return new Date(); }
  iso(): string { return this.now().toISOString(); }
}

/** Manually advanced clock for tests; `tick(ms)` moves time forward. */
export class ManualClock implements Clock {
  constructor(private t: Date = new Date("2026-10-06T09:00:00.000Z")) {}
  now(): Date { return new Date(this.t.getTime()); }
  iso(): string { return this.now().toISOString(); }
  tick(ms: number): void { this.t = new Date(this.t.getTime() + ms); }
  set(iso: string): void { this.t = new Date(iso); }
}
