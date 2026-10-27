import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { acquireLeaderLease, leaderHostId, renewLeaderLease, releaseLeaderLease } from "../src/leader.ts";
import { createWaveHandler } from "../src/server.ts";
import { openTmp } from "./helpers.ts";

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

  test("reclaims legacy lease without pid on same host", () => {
    const dir = mkdtempSync(join(tmpdir(), "wave-leader-"));
    try {
      const path = join(dir, ".wave", "leader.json");
      mkdirSync(dirname(path), { recursive: true });
      const host = leaderHostId();
      writeFileSync(
        path,
        JSON.stringify(
          {
            holder: "legacy-holder",
            host,
            expiresAt: Date.now() + 60_000,
            generation: 1,
          },
          null,
          2,
        ),
      );
      const b = acquireLeaderLease({ dataPath: dir, ttlMs: 60_000 });
      expect(b.ok).toBe(true);
      expect(b.lease?.holder).not.toBe("legacy-holder");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("does not reclaim legacy lease without pid on another host until expiry", () => {
    const dir = mkdtempSync(join(tmpdir(), "wave-leader-"));
    try {
      const path = join(dir, ".wave", "leader.json");
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(
        path,
        JSON.stringify(
          {
            holder: "legacy-holder",
            host: "other-fly-machine",
            expiresAt: Date.now() + 60_000,
            generation: 1,
          },
          null,
          2,
        ),
      );
      const b = acquireLeaderLease({ dataPath: dir, ttlMs: 60_000 });
      expect(b.ok).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("reclaims unexpired lease when pid was reused on same host", () => {
    const dir = mkdtempSync(join(tmpdir(), "wave-leader-"));
    try {
      const a = acquireLeaderLease({ dataPath: dir, ttlMs: 60_000 });
      expect(a.ok).toBe(true);
      const path = join(dir, ".wave", "leader.json");
      const stale = JSON.parse(readFileSync(path, "utf8")) as {
        holder: string;
        host: string;
        expiresAt: number;
        generation: number;
        pid: number;
        instanceId: string;
      };
      stale.pid = process.pid;
      stale.instanceId = "prior-process-instance";
      writeFileSync(path, JSON.stringify(stale, null, 2));
      const b = acquireLeaderLease({ dataPath: dir, ttlMs: 60_000 });
      expect(b.ok).toBe(true);
      expect(b.lease?.instanceId).not.toBe(stale.instanceId);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("reclaims unexpired lease after same-host process exit", () => {
    const dir = mkdtempSync(join(tmpdir(), "wave-leader-"));
    try {
      const a = acquireLeaderLease({ dataPath: dir, ttlMs: 60_000 });
      expect(a.ok).toBe(true);
      const path = join(dir, ".wave", "leader.json");
      const stale = JSON.parse(readFileSync(path, "utf8")) as {
        holder: string;
        host: string;
        expiresAt: number;
        generation: number;
        pid: number;
      };
      stale.pid = 9_999_999;
      writeFileSync(path, JSON.stringify(stale, null, 2));
      const b = acquireLeaderLease({ dataPath: dir, ttlMs: 60_000 });
      expect(b.ok).toBe(true);
      expect(b.lease?.holder).not.toBe(stale.holder);
      expect(b.lease?.pid).toBe(process.pid);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("live lease cannot be stolen on same host", () => {
    const dir = mkdtempSync(join(tmpdir(), "wave-leader-"));
    try {
      const a = acquireLeaderLease({ dataPath: dir, ttlMs: 60_000 });
      expect(a.ok).toBe(true);
      const b = acquireLeaderLease({ dataPath: dir, ttlMs: 60_000 });
      expect(b.ok).toBe(false);
      const onDisk = JSON.parse(readFileSync(join(dir, ".wave", "leader.json"), "utf8")) as { holder: string };
      expect(onDisk.holder).toBe(a.lease!.holder);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("lease file is mode 0600 and has no token field", () => {
    const dir = mkdtempSync(join(tmpdir(), "wave-leader-"));
    try {
      acquireLeaderLease({ dataPath: dir, ttlMs: 5000 });
      const path = join(dir, ".wave", "leader.json");
      const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      expect(raw.token).toBeUndefined();
      if (process.platform !== "win32") {
        expect(statSync(path).mode & 0o777).toBe(0o600);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("health omits bearer with leader and token", async () => {
    const { db, dir } = await openTmp({});
    const secret = "health-test-token";
    const handler = createWaveHandler(db, {
      dataPath: join(dir, "data.wave"),
      auth: true,
      token: secret,
      leader: true,
    });
    const res = await handler.fetch(new Request("http://x/api/health"));
    const text = await res.text();
    expect(text).not.toContain(secret);
    const json = JSON.parse(text) as { ok: boolean; standby: boolean; expiresAt: number | null; leader?: unknown };
    expect(json.leader).toBeUndefined();
    expect(json.expiresAt === null || typeof json.expiresAt === "number").toBe(true);
    await handler.close();
    await db.close();
  });
});
