import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCortexOS, ManualClock, MockLocalProvider, MockRemoteProvider, MockLimitedProvider, type CortexOS, type CortexOSOptions } from "../src/index.js";

export interface TestRig {
  os: CortexOS;
  dir: string;
  local: MockLocalProvider;
  remote: MockRemoteProvider;
  limited: MockLimitedProvider;
}

export function freshRig(opts: Partial<CortexOSOptions> = {}): TestRig {
  const dir = mkdtempSync(join(tmpdir(), "cortex-test-"));
  const os = createCortexOS({ dataDir: dir, clock: new ManualClock(), queue: { backoffBaseMs: 2, backoffCapMs: 20 }, ...opts });
  const local = new MockLocalProvider(join(dir, "local"));
  const remote = new MockRemoteProvider({ latencyMs: 1 });
  const limited = new MockLimitedProvider();
  os.registerProvider(local);
  os.registerProvider(remote, { apiKey: "sk-test-secret-value-do-not-leak-1234" });
  os.registerProvider(limited);
  return { os, dir, local, remote, limited };
}

export const USER = { kind: "user", id: "u-test", label: "Test User" } as const;
export const AGENT = { kind: "agent", id: "agent-main", label: "Main Agent" } as const;
