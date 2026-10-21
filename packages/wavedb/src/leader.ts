// Simple leader lease for single-host `wave serve` failover (one writer on data.wave).

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";

export interface LeaderLease {
  holder: string;
  host: string;
  expiresAt: number;
  token?: string;
}

export interface LeaderOptions {
  /** Database directory (parent of data.wave contents). */
  dataPath: string;
  ttlMs?: number;
  token?: string;
}

function leasePath(dataPath: string): string {
  return join(dataPath, ".wave", "leader.json");
}

function readLease(path: string): LeaderLease | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as LeaderLease;
  } catch {
    return null;
  }
}

function writeLeaseAtomic(path: string, lease: LeaderLease): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(lease, null, 2));
  renameSync(tmp, path);
}

/** Returns true if this process holds or acquired the lease. */
export function acquireLeaderLease(opts: LeaderOptions): { ok: boolean; lease?: LeaderLease; reason?: string } {
  const ttl = opts.ttlMs ?? 15_000;
  const path = leasePath(opts.dataPath);
  const now = Date.now();
  const cur = readLease(path);
  if (cur && cur.expiresAt > now && cur.host !== hostname()) {
    return { ok: false, reason: `leader is ${cur.host} until ${new Date(cur.expiresAt).toISOString()}` };
  }
  const lease: LeaderLease = {
    holder: randomUUID(),
    host: hostname(),
    expiresAt: now + ttl,
    token: opts.token,
  };
  writeLeaseAtomic(path, lease);
  return { ok: true, lease };
}

export function renewLeaderLease(opts: LeaderOptions, holder: string): boolean {
  const path = leasePath(opts.dataPath);
  const cur = readLease(path);
  if (!cur || cur.holder !== holder) return false;
  const ttl = opts.ttlMs ?? 15_000;
  cur.expiresAt = Date.now() + ttl;
  writeLeaseAtomic(path, cur);
  return true;
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

export function startLeaderRenewal(opts: LeaderOptions, holder: string): () => void {
  const iv = setInterval(() => {
    if (!renewLeaderLease(opts, holder)) clearInterval(iv);
  }, Math.max(1000, (opts.ttlMs ?? 15_000) / 3));
  (iv as any).unref?.();
  return () => {
    clearInterval(iv);
    releaseLeaderLease(opts, holder);
  };
}
