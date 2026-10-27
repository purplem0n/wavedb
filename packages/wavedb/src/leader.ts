// Simple leader lease for single-host `wave serve` failover (one writer on data.wave).

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";

/** Unique per process start; distinguishes PID reuse after restart on the same host. */
const processInstanceId = randomUUID();

export interface LeaderLease {
  holder: string;
  host: string;
  expiresAt: number;
  /** Monotonic generation for fencing (incremented on each successful acquire). */
  generation: number;
  /** Process that holds the lease (used to reclaim after crash on same host). */
  pid?: number;
  /** Random id assigned at process start (detects PID reuse). */
  instanceId?: string;
}

export interface LeaderOptions {
  /** Database directory (parent of data.wave contents). */
  dataPath: string;
  ttlMs?: number;
}

function leasePath(dataPath: string): string {
  return join(dataPath, ".wave", "leader.json");
}

/** Host id stored in the lease (Fly machine id when present). */
export function leaderHostId(): string {
  return process.env.FLY_MACHINE_ID ?? hostname();
}

/** Returns whether `pid` refers to a live process (`kill(pid, 0)`; false on `ESRCH`). */
function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: unknown) {
    return (e as NodeJS.ErrnoException)?.code !== "ESRCH";
  }
}

/** True when an unexpired lease is from a prior process on this host (e.g. SIGINT without release). */
export function canReclaimStaleLeaderLease(cur: LeaderLease, host: string): boolean {
  if (cur.host !== host) return false;
  // Legacy leases or hard kills (OOM) may omit pid; only the same host id may replace them.
  if (cur.pid === undefined || !Number.isInteger(cur.pid) || cur.pid <= 0) return true;
  if (!isProcessAlive(cur.pid)) return true;
  return cur.pid === process.pid && cur.instanceId !== processInstanceId;
}

function readLease(path: string): LeaderLease | null {
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as LeaderLease;
    if (typeof raw.holder !== "string" || typeof raw.expiresAt !== "number") return null;
    return {
      holder: raw.holder,
      host: raw.host ?? "",
      expiresAt: raw.expiresAt,
      generation: typeof raw.generation === "number" ? raw.generation : 0,
      pid: typeof raw.pid === "number" ? raw.pid : undefined,
      instanceId: typeof raw.instanceId === "string" ? raw.instanceId : undefined,
    };
  } catch {
    return null;
  }
}

function writeLeaseAtomic(path: string, lease: LeaderLease): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(lease, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
  try {
    chmodSync(path, 0o600);
  } catch {
    /* ignore on platforms without chmod */
  }
}

/** Compare-and-swap: write only if on-disk lease still matches `expected`. */
function writeLeaseCas(path: string, lease: LeaderLease, expected: LeaderLease | null): boolean {
  const cur = readLease(path);
  if (expected === null) {
    if (cur !== null) return false;
  } else if (!cur || cur.holder !== expected.holder || cur.expiresAt !== expected.expiresAt || cur.generation !== expected.generation) {
    return false;
  }
  writeLeaseAtomic(path, lease);
  return true;
}

/** Returns true if this process holds or acquired the lease. */
export function acquireLeaderLease(opts: LeaderOptions): { ok: boolean; lease?: LeaderLease; reason?: string } {
  const ttl = opts.ttlMs ?? 15_000;
  const path = leasePath(opts.dataPath);
  const now = Date.now();
  const host = leaderHostId();

  for (let attempt = 0; attempt < 8; attempt++) {
    const cur = readLease(path);
    if (cur && cur.expiresAt > now && !canReclaimStaleLeaderLease(cur, host)) {
      return {
        ok: false,
        reason: `leader is ${cur.host} until ${new Date(cur.expiresAt).toISOString()}`,
      };
    }
    const nextGen = (cur?.generation ?? 0) + 1;
    const lease: LeaderLease = {
      holder: randomUUID(),
      host,
      expiresAt: now + ttl,
      generation: nextGen,
      pid: process.pid,
      instanceId: processInstanceId,
    };
    if (writeLeaseCas(path, lease, cur)) {
      return { ok: true, lease };
    }
  }
  return { ok: false, reason: "could not acquire leader lease (contention)" };
}

/** True when on-disk lease still matches the handler's acquired lease (fencing). */
export function verifyLeaderFence(dataPath: string, lease: LeaderLease | undefined): boolean {
  if (!lease) return true;
  const cur = readLease(leasePath(dataPath));
  if (!cur) return false;
  return cur.holder === lease.holder && cur.generation === lease.generation;
}

export function renewLeaderLease(opts: LeaderOptions, holder: string): boolean {
  const path = leasePath(opts.dataPath);
  const cur = readLease(path);
  if (!cur || cur.holder !== holder) return false;
  const ttl = opts.ttlMs ?? 15_000;
  const updated: LeaderLease = { ...cur, expiresAt: Date.now() + ttl };
  return writeLeaseCas(path, updated, cur);
}

export function releaseLeaderLease(opts: LeaderOptions, holder: string): void {
  const path = leasePath(opts.dataPath);
  const cur = readLease(path);
  if (cur?.holder === holder) {
    try {
      unlinkSync(path);
    } catch {
      /* ignore */
    }
  }
}

export function startLeaderRenewal(
  opts: LeaderOptions,
  holder: string,
  onLost?: () => void,
): () => void {
  const iv = setInterval(() => {
    try {
      if (!renewLeaderLease(opts, holder)) {
        clearInterval(iv);
        onLost?.();
      }
    } catch {
      clearInterval(iv);
      onLost?.();
    }
  }, Math.max(1000, (opts.ttlMs ?? 15_000) / 3));
  (iv as any).unref?.();
  return () => {
    clearInterval(iv);
    releaseLeaderLease(opts, holder);
  };
}
