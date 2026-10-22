// Superuser credentials and session auth for Wave HTTP / Studio (not app SQL tables).

import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { IncomingMessage } from "node:http";

const ADMIN_FILE = "admin.json";
const SESSION_KEY_FILE = "session.key";
const COOKIE_NAME = "wave_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface AdminRecord {
  passwordHash: string;
  salt: string;
  createdAt: string;
}

export interface WaveAuth {
  dataPath: string;
  /** Static bearer for M2M (`opts.token` / WAVE_SERVE_TOKEN). */
  machineToken?: string;
  hasAdmin(): boolean;
  status(req?: IncomingMessage): { phase: "setup" | "login" | "ready"; authenticated?: boolean };
  setup(password: string): void;
  login(password: string): string;
  verifySession(token: string | undefined): boolean;
  parseCookie(header: string | undefined): string | undefined;
  sessionCookie(token: string, secure: boolean): string;
  clearCookie(secure: boolean): string;
  authorize(req: IncomingMessage): boolean;
}

function waveDir(dataPath: string): string {
  const dir = join(dataPath, ".wave");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function hashPassword(password: string, salt: string): string {
  return scryptSync(password, salt, 64).toString("hex");
}

function readAdmin(dataPath: string): AdminRecord | undefined {
  const p = join(waveDir(dataPath), ADMIN_FILE);
  if (!existsSync(p)) return undefined;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as AdminRecord;
  } catch {
    return undefined;
  }
}

function writeAdmin(dataPath: string, rec: AdminRecord): void {
  writeFileSync(join(waveDir(dataPath), ADMIN_FILE), JSON.stringify(rec, null, 2) + "\n", { mode: 0o600 });
}

function sessionSecret(dataPath: string): Buffer {
  const env = process.env.WAVE_SESSION_SECRET;
  if (env) return createHash("sha256").update(env).digest();
  const p = join(waveDir(dataPath), SESSION_KEY_FILE);
  if (existsSync(p)) return Buffer.from(readFileSync(p, "utf8").trim(), "hex");
  const key = randomBytes(32);
  writeFileSync(p, key.toString("hex") + "\n", { mode: 0o600 });
  return key;
}

function signSession(secret: Buffer, payload: string): string {
  const sig = createHash("sha256").update(secret).update(payload).digest("hex");
  return `${payload}.${sig}`;
}

function verifySignedFixed(secret: Buffer, token: string): { exp: number } | undefined {
  const i = token.lastIndexOf(".");
  if (i <= 0) return undefined;
  const payload = token.slice(0, i);
  const sig = token.slice(i + 1);
  const want = createHash("sha256").update(secret).update(payload).digest("hex");
  try {
    const a = Buffer.from(sig, "hex");
    const b = Buffer.from(want, "hex");
    if (a.length !== b.length || !timingSafeEqual(a, b)) return undefined;
  } catch {
    return undefined;
  }
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp: number };
    if (typeof data.exp !== "number" || data.exp < Date.now()) return undefined;
    return data;
  } catch {
    return undefined;
  }
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    out[k] = decodeURIComponent(v);
  }
  return out;
}

export function initWaveAuth(dataPath: string, opts: { machineToken?: string; bootstrapPassword?: string } = {}): WaveAuth {
  const secret = sessionSecret(dataPath);
  let admin = readAdmin(dataPath);
  const bootstrap = opts.bootstrapPassword ?? process.env.WAVE_ADMIN_PASSWORD;
  if (!admin && bootstrap) {
    const salt = randomBytes(16).toString("hex");
    admin = { passwordHash: hashPassword(bootstrap, salt), salt, createdAt: new Date().toISOString() };
    writeAdmin(dataPath, admin);
  }

  const checkPassword = (password: string): boolean => {
    const a = readAdmin(dataPath);
    if (!a) return false;
    const h = hashPassword(password, a.salt);
    try {
      return timingSafeEqual(Buffer.from(h), Buffer.from(a.passwordHash));
    } catch {
      return false;
    }
  };

  const makeToken = (): string => {
    const payload = Buffer.from(JSON.stringify({ exp: Date.now() + SESSION_TTL_MS, v: 1 }), "utf8").toString("base64url");
    return signSession(secret, payload);
  };

  return {
    dataPath,
    machineToken: opts.machineToken,
    hasAdmin: () => !!readAdmin(dataPath),
    status(req?: IncomingMessage) {
      if (!readAdmin(dataPath)) return { phase: "setup" as const };
      if (req && this.authorize(req)) return { phase: "ready" as const };
      return { phase: "login" as const };
    },
    setup(password: string) {
      if (readAdmin(dataPath)) throw new Error("admin already exists");
      if (!password || password.length < 8) throw new Error("password must be at least 8 characters");
      const salt = randomBytes(16).toString("hex");
      writeAdmin(dataPath, { passwordHash: hashPassword(password, salt), salt, createdAt: new Date().toISOString() });
    },
    login(password: string) {
      if (!checkPassword(password)) throw new Error("invalid password");
      return makeToken();
    },
    verifySession(token: string | undefined) {
      if (!token) return false;
      return !!verifySignedFixed(secret, token);
    },
    parseCookie(header: string | undefined) {
      return parseCookies(header)[COOKIE_NAME];
    },
    sessionCookie(token: string, secure: boolean) {
      const parts = [`${COOKIE_NAME}=${encodeURIComponent(token)}`, "HttpOnly", "Path=/", "SameSite=Lax", `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`];
      if (secure) parts.push("Secure");
      return parts.join("; ");
    },
    clearCookie(secure: boolean) {
      const parts = [`${COOKIE_NAME}=`, "HttpOnly", "Path=/", "SameSite=Lax", "Max-Age=0"];
      if (secure) parts.push("Secure");
      return parts.join("; ");
    },
    authorize(req: IncomingMessage) {
      const pathAuth = this.parseCookie(req.headers.cookie);
      if (this.verifySession(pathAuth)) return true;
      const h = req.headers.authorization ?? "";
      if (h.startsWith("Bearer ")) {
        const bearer = h.slice(7);
        if (this.verifySession(bearer)) return true;
        if (opts.machineToken && bearer.length === opts.machineToken.length) {
          try {
            if (timingSafeEqual(Buffer.from(bearer), Buffer.from(opts.machineToken))) return true;
          } catch {
            /* length mismatch */
          }
        }
      }
      return false;
    },
  };
}

export function normalizePrefix(p: string): string {
  if (!p || p === "/") return "";
  let s = p.startsWith("/") ? p : `/${p}`;
  if (s.length > 1 && s.endsWith("/")) s = s.slice(0, -1);
  return s;
}
