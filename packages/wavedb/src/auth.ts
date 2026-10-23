// Superuser credentials and session auth for Wave HTTP / Studio (not app SQL tables).

import { createHmac, randomBytes, scrypt, scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { IncomingMessage } from "node:http";

const scryptAsync = promisify(scrypt);

const ADMIN_FILE = "admin.json";
const SESSION_KEY_FILE = "session.key";
const SETUP_TOKEN_FILE = "setup.token";
const COOKIE_NAME = "wave_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface AdminRecord {
  passwordHash: string;
  salt: string;
  createdAt: string;
}

export interface WaveAuthOptions {
  machineToken?: string;
  bootstrapPassword?: string;
  /** Set-Cookie Path (default `/`). */
  cookiePath?: string;
  /** Honor X-Forwarded-Proto: https when true. */
  trustProxy?: boolean;
}

export interface WaveAuth {
  dataPath: string;
  machineToken?: string;
  cookiePath: string;
  hasAdmin(): boolean;
  status(req?: IncomingMessage): { phase: "setup" | "login" | "ready"; authenticated?: boolean };
  setup(password: string, setupToken?: string): Promise<void>;
  login(password: string): Promise<string>;
  verifySession(token: string | undefined): boolean;
  parseCookie(header: string | undefined): string | undefined;
  sessionCookie(token: string, secure: boolean): string;
  clearCookie(secure: boolean): string;
  authorize(req: IncomingMessage): boolean;
  isSecureRequest(req: IncomingMessage): boolean;
}

function waveDir(dataPath: string): string {
  const dir = join(dataPath, ".wave");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

async function hashPassword(password: string, salt: string): Promise<string> {
  const buf = (await scryptAsync(password, salt, 64)) as Buffer;
  return buf.toString("hex");
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
  writeFileSync(join(waveDir(dataPath), ADMIN_FILE), JSON.stringify(rec, null, 2) + "\n", { flag: "wx", mode: 0o600 });
}

function setupTokenPath(dataPath: string): string {
  return join(waveDir(dataPath), SETUP_TOKEN_FILE);
}

/** Read one-time web setup token (tests / operators). */
export function readSetupToken(dataPath: string): string | undefined {
  const env = process.env.WAVE_SETUP_TOKEN;
  if (env) return env;
  const p = setupTokenPath(dataPath);
  if (!existsSync(p)) return undefined;
  try {
    return readFileSync(p, "utf8").trim();
  } catch {
    return undefined;
  }
}

function tokensEqual(a: string, b: string): boolean {
  try {
    const x = Buffer.from(a);
    const y = Buffer.from(b);
    if (x.length !== y.length) return false;
    return timingSafeEqual(x, y);
  } catch {
    return false;
  }
}

function verifySetupToken(dataPath: string, provided: string): boolean {
  if (!provided) return false;
  const env = process.env.WAVE_SETUP_TOKEN;
  if (env && tokensEqual(provided, env)) return true;
  const p = setupTokenPath(dataPath);
  if (!existsSync(p)) return false;
  try {
    const want = readFileSync(p, "utf8").trim();
    return tokensEqual(provided, want);
  } catch {
    return false;
  }
}

function consumeSetupTokenFile(dataPath: string): void {
  const p = setupTokenPath(dataPath);
  if (existsSync(p)) {
    try {
      unlinkSync(p);
    } catch {
      /* ignore */
    }
  }
}

/** Create `.wave/setup.token` when no admin and no env bootstrap (exclusive). */
function ensureSetupTokenFile(dataPath: string): void {
  if (readAdmin(dataPath)) return;
  if (process.env.WAVE_ADMIN_PASSWORD) return;
  if (process.env.WAVE_SETUP_TOKEN) return;
  const p = setupTokenPath(dataPath);
  if (existsSync(p)) return;
  const token = randomBytes(32).toString("hex");
  try {
    writeFileSync(p, token + "\n", { flag: "wx", mode: 0o600 });
    console.error(`[wavedb] First-time setup: use setupToken from ${p} (or set WAVE_SETUP_TOKEN) for POST /api/auth/setup`);
  } catch {
    /* concurrent creator */
  }
}

function sessionSecret(dataPath: string): Buffer {
  const env = process.env.WAVE_SESSION_SECRET;
  if (env) return Buffer.from(env, "utf8");
  const p = join(waveDir(dataPath), SESSION_KEY_FILE);
  if (existsSync(p)) return Buffer.from(readFileSync(p, "utf8").trim(), "hex");
  const key = randomBytes(32);
  writeFileSync(p, key.toString("hex") + "\n", { mode: 0o600 });
  return key;
}

function signSession(secret: Buffer, payload: string): string {
  const sig = createHmac("sha256", secret).update(payload).digest("hex");
  return `${payload}.${sig}`;
}

function verifySignedFixed(secret: Buffer, token: string): { exp: number } | undefined {
  const i = token.lastIndexOf(".");
  if (i <= 0) return undefined;
  const payload = token.slice(0, i);
  const sig = token.slice(i + 1);
  const want = createHmac("sha256", secret).update(payload).digest("hex");
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

const loginAttempts = new Map<string, { count: number; resetAt: number }>();
const LOGIN_WINDOW_MS = 60_000;
const LOGIN_MAX = 30;

function checkRateLimit(key: string): void {
  const now = Date.now();
  const e = loginAttempts.get(key);
  if (!e || e.resetAt < now) {
    loginAttempts.set(key, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
    return;
  }
  e.count += 1;
  if (e.count > LOGIN_MAX) throw new Error("too many attempts; try again later");
}

export function initWaveAuth(dataPath: string, opts: WaveAuthOptions = {}): WaveAuth {
  const secret = sessionSecret(dataPath);
  const cookiePath = opts.cookiePath && opts.cookiePath !== "/" ? opts.cookiePath : "/";
  const trustProxy = opts.trustProxy ?? process.env.WAVE_TRUST_PROXY === "1";
  let admin = readAdmin(dataPath);
  const bootstrap = opts.bootstrapPassword ?? process.env.WAVE_ADMIN_PASSWORD;
  if (!admin && bootstrap) {
    const salt = randomBytes(16).toString("hex");
    admin = { passwordHash: "", salt, createdAt: new Date().toISOString() };
    // sync bootstrap for env-only deploys
    const h = scryptSync(bootstrap, salt, 64).toString("hex");
    admin.passwordHash = h;
    try {
      writeAdmin(dataPath, admin);
    } catch {
      admin = readAdmin(dataPath);
    }
  }
  ensureSetupTokenFile(dataPath);

  const checkPassword = async (password: string): Promise<boolean> => {
    const a = readAdmin(dataPath);
    if (!a) return false;
    const h = await hashPassword(password, a.salt);
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
    cookiePath,
    hasAdmin: () => !!readAdmin(dataPath),
    status(req?: IncomingMessage) {
      if (!readAdmin(dataPath)) return { phase: "setup" as const };
      if (req && this.authorize(req)) return { phase: "ready" as const };
      return { phase: "login" as const };
    },
    async setup(password: string, setupToken?: string) {
      if (readAdmin(dataPath)) throw new Error("admin already exists");
      if (!verifySetupToken(dataPath, setupToken ?? "")) throw new Error("invalid or missing setup token");
      if (!password || password.length < 8) throw new Error("password must be at least 8 characters");
      checkRateLimit("setup");
      const salt = randomBytes(16).toString("hex");
      const rec: AdminRecord = {
        passwordHash: await hashPassword(password, salt),
        salt,
        createdAt: new Date().toISOString(),
      };
      try {
        writeAdmin(dataPath, rec);
        consumeSetupTokenFile(dataPath);
      } catch {
        throw new Error("admin already exists");
      }
    },
    async login(password: string) {
      checkRateLimit("login");
      if (!(await checkPassword(password))) throw new Error("invalid password");
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
      const parts = [
        `${COOKIE_NAME}=${encodeURIComponent(token)}`,
        "HttpOnly",
        `Path=${cookiePath}`,
        "SameSite=Lax",
        `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
      ];
      if (secure) parts.push("Secure");
      return parts.join("; ");
    },
    clearCookie(secure: boolean) {
      const parts = [`${COOKIE_NAME}=`, "HttpOnly", `Path=${cookiePath}`, "SameSite=Lax", "Max-Age=0"];
      if (secure) parts.push("Secure");
      return parts.join("; ");
    },
    isSecureRequest(req: IncomingMessage) {
      if (trustProxy) {
        const raw = req.headers["x-forwarded-proto"];
        const proto = (Array.isArray(raw) ? raw[0] : raw)?.split(",")[0]?.trim().toLowerCase();
        if (proto === "https") return true;
      }
      return false;
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
