import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLeaderLease, renewLeaderLease, releaseLeaderLease } from "../src/leader.ts";

describe("leader lease", () => {
  test("acquire and renew", () => {
    const dir = mkdtempSync(join(tmpdir(), "wave-leader-"));
    try {
      const a = acquireLeaderLease({ dataPath: dir, ttlMs: 5000 });
      expect(a.ok).toBe(true);
      expect(a.lease?.holder).toBeTruthy();
      expect(renewLeaderLease({ dataPath: dir }, a.lease!.holder)).toBe(true);
      releaseLeaderLease({ dataPath: dir }, a.lease!.holder);
      const b = acquireLeaderLease({ dataPath: dir, ttlMs: 5000 });
      expect(b.ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
