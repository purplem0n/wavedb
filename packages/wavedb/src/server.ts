// HTTP server: exposes a Database to other processes (multi-process access, Studio, remote clients).
// Node + Bun compatible (uses node:http + Web Fetch handler for embedding).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { WaveError, mapNativeError } from "./errors.ts";
import type { Database, TxBackend } from "./db.ts";
import { defaultWavePath } from "./db.ts";
import type { TLSSocket } from "node:tls";
import { acquireLeaderLease, startLeaderRenewal, type LeaderLease } from "./leader.ts";
import { QueryLog } from "./queryLog.ts";
import { initWaveAuth, normalizePrefix, type WaveAuth } from "./auth.ts";
import { wavedbPackageVersion } from "./pkgVersion.ts";

export interface HandlerOptions {
  /** Path to database directory (leader lease + superuser auth). */
  dataPath?: string;
  /** Acquire/renew a leader lease under `dataPath/.wave/leader.json`. */
  leader?: boolean;
  /** If leader acquisition fails, start HTTP in standby mode (503 on /api/run). */
  standby?: boolean;
  /** Static bearer for M2M clients (`Authorization: Bearer`). */
  token?: string;
  /** Enable superuser auth (default: true when `dataPath` is set, else false). */
  auth?: boolean;
  /** URL prefix for API routes (default `/api`). Embedded: `/__wave/api`. */
  apiPrefix?: string;
  /** URL prefix for Studio static files (default `/`). Embedded: `/wavedb-studio`. */
  staticPrefix?: string;
  /** Built Wave Studio `dist/` directory. */
  staticDir?: string;
  /** Inject runtime API prefix into Studio via `config.js` (default true when staticPrefix !== `/`). */
  studioConfig?: boolean;
  txIdleMs?: number;
  cors?: boolean;
}

export interface ServeOptions extends HandlerOptions {
  port?: number;
  host?: string;
}

export interface WaveHandler {
  fetch(request: Request): Promise<Response>;
  nodeListener(req: IncomingMessage, res: ServerResponse): void;
  close(): Promise<void>;
  /** Resolved API prefix (e.g. `/api` or `/__wave/api`). */
  apiPrefix: string;
  /** Resolved static prefix (e.g. `/` or `/wavedb-studio`). */
  staticPrefix: string;
}

export interface WaveServer {
  url: string;
  port: number;
  host: string;
  server: Server;
  handler: WaveHandler;
  close(): Promise<void>;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".map": "application/json",
  ".woff2": "font/woff2",
};

function statusFor(code: string): number {
  switch (code) {
    case "WAVE_CONFLICT":
      return 409;
    case "WAVE_CONSTRAINT":
      return 409;
    case "WAVE_NOT_FOUND":
      return 404;
    case "WAVE_SQL":
    case "WAVE_INVALID":
      return 400;
    default:
      return 500;
  }
}

async function readJsonBody(req: IncomingMessage, limit = 64 * 1024 * 1024): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new WaveError("request body too large", "WAVE_INVALID");
    chunks.push(c as Buffer);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new WaveError("invalid JSON body", "WAVE_INVALID");
  }
}

async function readRequestJson(request: Request, limit = 64 * 1024 * 1024): Promise<any> {
  if (!request.body) return {};
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) throw new WaveError("request body too large", "WAVE_INVALID");
    chunks.push(value);
  }
  if (size === 0) return {};
  const text = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
  try {
    return JSON.parse(text);
  } catch {
    throw new WaveError("invalid JSON body", "WAVE_INVALID");
  }
}

function jsonResponse(status: number, body: unknown, headers?: Record<string, string>): Response {
  const h = { "content-type": "application/json", ...headers };
  return new Response(JSON.stringify(body), { status, headers: h });
}

function toInternalApiPath(pathname: string, apiPrefix: string): string | undefined {
  const p = normalizePrefix(apiPrefix || "/api");
  if (p) {
    if (pathname === p) return "/api";
    if (!pathname.startsWith(p + "/")) return undefined;
    const rest = pathname.slice(p.length);
    return "/api" + rest;
  }
  if (pathname === "/api" || pathname.startsWith("/api/")) return pathname;
  return undefined;
}

function staticRelPath(pathname: string, staticPrefix: string): string | undefined {
  const p = normalizePrefix(staticPrefix);
  if (!p) return pathname;
  if (pathname === p || pathname === p + "/") return "";
  if (!pathname.startsWith(p + "/")) return undefined;
  return pathname.slice(p.length + 1);
}

function studioRuntimeConfigJs(apiPrefix: string): string {
  const prefix = normalizePrefix(apiPrefix) || "/api";
  const version = wavedbPackageVersion();
  return (
    `window.__WAVE_API_PREFIX__=${JSON.stringify(prefix)};\n` +
    `window.__WAVE_ENGINE_VERSION__=${JSON.stringify(version)};\n`
  );
}

/** Vite `base: "./"` breaks under a subpath without a trailing slash; fix at serve time. */
function embedStudioIndex(html: string, staticPrefix: string, apiPrefix: string): string {
  const base = `${normalizePrefix(staticPrefix)}/`;
  const prefix = normalizePrefix(apiPrefix) || "/api";
  const version = wavedbPackageVersion();
  const boot =
    `<script>window.__WAVE_API_PREFIX__=${JSON.stringify(prefix)};` +
    `window.__WAVE_ENGINE_VERSION__=${JSON.stringify(version)};</script>`;
  let out = html;
  if (!/<base\s/i.test(out)) {
    if (/<head[\s>]/i.test(out)) {
      out = out.replace(/<head(\s[^>]*)?>/i, (m) => `${m}\n    <base href="${base}">`);
    } else {
      out = out.replace(/<html(\s[^>]*)?>/i, (m) => `${m}\n  <head>\n    <base href="${base}">\n  </head>`);
    }
  }
  out = out.replace(/<script src="[^"]*config\.js"><\/script>\s*/gi, "");
  if (!out.includes("__WAVE_API_PREFIX__")) {
    const inject = `${boot}\n    <script src="${base}config.js"></script>\n    `;
    if (/<script type="module"/i.test(out)) {
      out = out.replace(/<script type="module"/i, `${inject}<script type="module"`);
    } else if (/<base\s/i.test(out)) {
      out = out.replace(/<base href="[^"]*">/i, (m) => `${m}\n    ${inject}`);
    } else if (/<head[\s>]/i.test(out)) {
      out = out.replace(/<head(\s[^>]*)?>/i, (m) => `${m}\n    ${inject}`);
    }
  }
  return out;
}

const MAX_OPEN_TX = 256;

function isHttps(request: Request | IncomingMessage, waveAuth?: WaveAuth): boolean {
  if (request instanceof Request) {
    if (new URL(request.url).protocol === "https:") return true;
    if (
      waveAuth?.isSecureRequest({
        headers: { "x-forwarded-proto": request.headers.get("x-forwarded-proto") ?? undefined },
      } as unknown as IncomingMessage)
    ) {
      return true;
    }
    return false;
  }
  const sock = request.socket as TLSSocket | undefined;
  if (sock?.encrypted) return true;
  if (waveAuth?.isSecureRequest(request)) return true;
  return false;
}

export function createWaveHandler(db: Database<any>, opts: HandlerOptions = {}): WaveHandler {
  const idleMs = opts.txIdleMs ?? 30_000;
  const staticDir = opts.staticDir ? resolve(opts.staticDir) : undefined;
  const apiPrefix = normalizePrefix(opts.apiPrefix ?? "/api") || "/api";
  const staticPrefix = opts.staticPrefix ?? "/";
  const resolvedDataPathRaw =
    opts.dataPath ?? db.dataPath ?? (process.env.WAVE_DB_PATH ? defaultWavePath() : undefined);
  const resolvedDataPath = resolvedDataPathRaw ? resolve(resolvedDataPathRaw) : undefined;
  const authEnabled = opts.auth ?? !!resolvedDataPath;
  if (authEnabled && !resolvedDataPath) {
    throw new WaveError("auth requires a database dataPath (set dataPath, open wave() with a path, or WAVE_DB_PATH)", "WAVE_INVALID");
  }
  const cookiePath = apiPrefix || "/api";
  const waveAuth: WaveAuth | undefined =
    authEnabled && resolvedDataPath
      ? initWaveAuth(resolvedDataPath, {
          machineToken: opts.token,
          cookiePath,
          trustProxy: process.env.WAVE_TRUST_PROXY === "1",
        })
      : undefined;

  const txs = new Map<string, { tx: TxBackend; timer: ReturnType<typeof setTimeout> }>();
  const queryLog =
    db.queryLog ?? (db.queryLogDisabled ? new QueryLog() : db.enableQueryLog({ dataPath: resolvedDataPath }));
  let stopLeader: (() => void) | undefined;
  let leader: LeaderLease | undefined;
  let active = true;

  if (opts.leader && resolvedDataPath) {
    const got = acquireLeaderLease({ dataPath: resolvedDataPath });
    if (!got.ok) {
      if (!opts.standby) throw new WaveError(got.reason ?? "not leader", "WAVE_INVALID");
      active = false;
    } else if (got.lease) {
      leader = got.lease;
      stopLeader = startLeaderRenewal({ dataPath: resolvedDataPath }, leader.holder);
    }
  }

  const touch = (id: string) => {
    const e = txs.get(id);
    if (!e) throw new WaveError(`unknown or expired transaction ${id}`, "WAVE_NOT_FOUND");
    clearTimeout(e.timer);
    e.timer = setTimeout(() => {
      txs.delete(id);
      void Promise.resolve(e.tx.rollback()).catch(() => {});
    }, idleMs);
    (e.timer as any).unref?.();
    return e;
  };

  const legacyAuthorized = (req: IncomingMessage): boolean => {
    if (waveAuth) return waveAuth.authorize(req);
    if (!opts.token) return true;
    const h = req.headers.authorization ?? "";
    const given = Buffer.from(h.startsWith("Bearer ") ? h.slice(7) : "");
    const want = Buffer.from(opts.token);
    return given.length === want.length && timingSafeEqual(given, want);
  };

  const legacyAuthorizedFetch = (request: Request): boolean => {
    if (waveAuth) {
      const fake = { headers: { cookie: request.headers.get("cookie") ?? undefined, authorization: request.headers.get("authorization") ?? undefined } } as IncomingMessage;
      return waveAuth.authorize(fake);
    }
    if (!opts.token) return true;
    const h = request.headers.get("authorization") ?? "";
    const given = Buffer.from(h.startsWith("Bearer ") ? h.slice(7) : "");
    const want = Buffer.from(opts.token);
    return given.length === want.length && timingSafeEqual(given, want);
  };

  const isPublicApi = (path: string) =>
    path === "/api/ping" ||
    path === "/api/health" ||
    path === "/api/auth/status" ||
    path === "/api/auth/setup" ||
    path === "/api/auth/login" ||
    path === "/api/auth/logout";

  async function handleApi(method: string, path: string, body: any, reqLike: IncomingMessage | Request): Promise<Response> {
    const secure = isHttps(reqLike as Request, waveAuth);
    const req =
      reqLike instanceof Request
        ? ({ headers: { cookie: reqLike.headers.get("cookie") ?? undefined, authorization: reqLike.headers.get("authorization") ?? undefined } } as IncomingMessage)
        : reqLike;

    if (method === "GET" && path === "/api/ping") return jsonResponse(200, { ok: true });
    if (method === "GET" && path === "/api/health")
      return jsonResponse(active ? 200 : 503, {
        ok: active,
        standby: !active,
        expiresAt: leader?.expiresAt ?? null,
      });
    if (method === "GET" && path === "/api/auth/status") {
      if (!waveAuth) return jsonResponse(200, { phase: "ready", auth: false });
      return jsonResponse(200, { ...waveAuth.status(req), auth: true, apiPrefix: apiPrefix || "/api" });
    }
    if (method === "POST" && path === "/api/auth/setup") {
      if (!waveAuth) return jsonResponse(400, { error: { code: "WAVE_INVALID", message: "auth disabled" } });
      try {
        const password = String(body.password ?? "");
        await waveAuth.setup(password, String(body.setupToken ?? ""));
        const token = await waveAuth.login(password);
        return jsonResponse(200, { ok: true }, { "set-cookie": waveAuth.sessionCookie(token, secure) });
      } catch (e) {
        return jsonResponse(400, { error: { code: "WAVE_INVALID", message: (e as Error).message } });
      }
    }
    if (method === "POST" && path === "/api/auth/login") {
      if (!waveAuth) return jsonResponse(400, { error: { code: "WAVE_INVALID", message: "auth disabled" } });
      try {
        const token = await waveAuth.login(String(body.password ?? ""));
        return jsonResponse(200, { ok: true }, { "set-cookie": waveAuth.sessionCookie(token, secure) });
      } catch {
        return jsonResponse(401, { error: { code: "WAVE_INVALID", message: "invalid password" } });
      }
    }
    if (method === "POST" && path === "/api/auth/logout") {
      if (!waveAuth) return jsonResponse(200, { ok: true });
      return jsonResponse(200, { ok: true }, { "set-cookie": waveAuth.clearCookie(secure) });
    }
    if (method === "GET" && path === "/api/auth/me") {
      if (!waveAuth) return jsonResponse(200, { ok: true, auth: false });
      return jsonResponse(waveAuth.authorize(req) ? 200 : 401, waveAuth.authorize(req) ? { ok: true } : { error: { code: "WAVE_INVALID", message: "unauthorized" } });
    }

    if (!active) return jsonResponse(503, { error: { code: "WAVE_INVALID", message: "standby: not leader" } });
    if (!isPublicApi(path)) {
      const ok = reqLike instanceof Request ? legacyAuthorizedFetch(reqLike) : legacyAuthorized(reqLike);
      if (!ok) return jsonResponse(401, { error: { code: "WAVE_INVALID", message: "unauthorized" } });
    }

    if (method === "GET" && (path === "/api/tables" || path === "/api/schema")) return jsonResponse(200, await db.tables());
    if (method === "GET" && path === "/api/stats") return jsonResponse(200, await db.stats());
    if (method === "GET" && path === "/api/query-metrics") return jsonResponse(200, queryLog.getMetrics());
    if (method === "GET" && path === "/api/query-log") {
      const url = reqLike instanceof Request ? new URL(reqLike.url) : new URL("http://x" + (reqLike.url ?? ""));
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit") ?? 100) || 100));
      const since = url.searchParams.get("since") ?? undefined;
      return jsonResponse(200, { entries: queryLog.recent(limit, since) });
    }
    if (method !== "POST") return jsonResponse(404, { error: { code: "WAVE_NOT_FOUND", message: "no such endpoint" } });

    if (path === "/api/run") {
      const target = body.tx ? touch(String(body.tx)).tx.exec : db.backend.exec;
      const sql = body.sql !== undefined ? String(body.sql) : undefined;
      const r =
        sql !== undefined ? await target.runSql(sql, body.params ?? []) : await target.run(body.stmt);
      return jsonResponse(200, r);
    }
    if (path === "/api/tx/begin") {
      if (txs.size >= MAX_OPEN_TX) {
        return jsonResponse(503, { error: { code: "WAVE_INVALID", message: "too many open transactions" } });
      }
      const tx = await db.backend.begin(body.isolation === "serializable" ? "serializable" : "snapshot");
      const id = randomUUID();
      txs.set(id, { tx, timer: setTimeout(() => {}, 0) });
      touch(id);
      return jsonResponse(200, { id });
    }
    const m = /^\/api\/tx\/([^/]+)\/(commit|rollback)$/.exec(path);
    if (m) {
      const id = decodeURIComponent(m[1]!);
      const e = touch(id);
      clearTimeout(e.timer);
      txs.delete(id);
      if (m[2] === "commit") return jsonResponse(200, await e.tx.commit());
      await e.tx.rollback();
      return jsonResponse(200, { ok: true });
    }
    if (path === "/api/vacuum") return jsonResponse(200, { removed: await db.vacuum() });
    if (path === "/api/compact") {
      await db.compact();
      return jsonResponse(200, { ok: true });
    }
    return jsonResponse(404, { error: { code: "WAVE_NOT_FOUND", message: "no such endpoint" } });
  }

  function serveStaticFile(rel: string): Response {
    if (!staticDir) {
      return new Response("WaveDB server. Use API routes.", { status: 404, headers: { "content-type": "text/plain" } });
    }
    if (opts.studioConfig !== false && staticDir && rel === "config.js") {
      const js = studioRuntimeConfigJs(apiPrefix || "/api");
      return new Response(js, { status: 200, headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache" } });
    }
    if (/(\.\.|%2e%2e)/i.test(rel)) {
      return new Response(null, { status: 403 });
    }
    let fileRel = normalize(decodeURIComponent(rel)).replace(/^([/\\])+/, "");
    if (fileRel.includes("..")) {
      return new Response(null, { status: 403 });
    }
    let file = join(staticDir, fileRel);
    if (file !== staticDir && !file.startsWith(staticDir + sep)) {
      return new Response(null, { status: 403 });
    }
    if (!existsSync(file) || statSync(file).isDirectory()) {
      if (extname(fileRel)) return new Response("not found", { status: 404 });
      file = join(staticDir, "index.html");
      if (!existsSync(file)) return new Response("studio not built", { status: 404 });
    }
    let data = readFileSync(file);
    if (file.endsWith(`${sep}index.html`) && normalizePrefix(staticPrefix)) {
      data = Buffer.from(embedStudioIndex(data.toString("utf8"), staticPrefix, apiPrefix || "/api"), "utf8");
    }
    return new Response(data, {
      status: 200,
      headers: {
        "content-type": MIME[extname(file)] ?? "application/octet-stream",
        "cache-control": file.includes(`${sep}assets${sep}`) ? "public, max-age=31536000, immutable" : "no-cache",
      },
    });
  }

  async function dispatch(request: Request): Promise<Response | null> {
    const url = new URL(request.url);
    let pathname = url.pathname;

    if (opts.cors) {
      if (request.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: {
            "access-control-allow-origin": "*",
            "access-control-allow-headers": "authorization, content-type",
            "access-control-allow-methods": "GET, POST, OPTIONS",
          },
        });
      }
    }

    const studioMount = normalizePrefix(staticPrefix);
    if (request.method === "GET" && staticDir && studioMount && pathname === studioMount) {
      const target = new URL(request.url);
      target.pathname = `${studioMount}/`;
      return Response.redirect(target, 308);
    }

    const apiPath = toInternalApiPath(pathname, apiPrefix);
    if (apiPath) {
      try {
        const body = request.method === "POST" ? await readRequestJson(request) : {};
        const res = await handleApi(request.method ?? "GET", apiPath, body, request);
        if (opts.cors) {
          const h = new Headers(res.headers);
          h.set("access-control-allow-origin", "*");
          return new Response(res.body, { status: res.status, headers: h });
        }
        return res;
      } catch (e) {
        const err = mapNativeError(e);
        const code = err instanceof WaveError ? err.code : "WAVE_UNKNOWN";
        return jsonResponse(statusFor(code), { error: { code, message: err.message } });
      }
    }

    const staticRel = staticDir ? staticRelPath(pathname, staticPrefix) : undefined;
    if (staticRel !== undefined) {
      return serveStaticFile(staticRel);
    }

    // Standalone: root `/` serves studio when staticPrefix is `/`
    if (staticDir && !normalizePrefix(staticPrefix) && (pathname === "/" || pathname === "")) {
      return serveStaticFile("");
    }

    return null;
  }

  const handler: WaveHandler = {
    apiPrefix: apiPrefix || "/api",
    staticPrefix,
    async fetch(request: Request) {
      const res = await dispatch(request);
      return res ?? new Response(null, { status: 404 });
    },
    nodeListener(req, res) {
      const url = new URL(req.url ?? "/", "http://x");
      const run = async () => {
        if (opts.cors) {
          res.setHeader("access-control-allow-origin", "*");
          res.setHeader("access-control-allow-headers", "authorization, content-type");
          res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
          if (req.method === "OPTIONS") {
            res.writeHead(204);
            return res.end();
          }
        }
        const apiPath = toInternalApiPath(url.pathname, apiPrefix);
        if (apiPath) {
          try {
            const body = req.method === "POST" ? await readJsonBody(req) : {};
            const response = await handleApi(req.method ?? "GET", apiPath, body, req);
            const text = await response.text();
            const headers: Record<string, string> = {};
            response.headers.forEach((v, k) => {
              headers[k] = v;
            });
            res.writeHead(response.status, headers);
            return res.end(text);
          } catch (e) {
            const err = mapNativeError(e);
            const code = err instanceof WaveError ? err.code : "WAVE_UNKNOWN";
            const text = JSON.stringify({ error: { code, message: err.message } });
            if (!res.headersSent) {
              res.writeHead(statusFor(code), { "content-type": "application/json" });
              return res.end(text);
            }
            return res.end();
          }
        }
        const staticRel = staticDir ? staticRelPath(url.pathname, staticPrefix) : undefined;
        if (
          staticDir &&
          (staticRel !== undefined || (!normalizePrefix(staticPrefix) && url.pathname === "/"))
        ) {
          const response = serveStaticFile(staticRel ?? "");
          const buf = Buffer.from(await response.arrayBuffer());
          const headers: Record<string, string> = {};
          response.headers.forEach((v, k) => {
            headers[k] = v;
          });
          res.writeHead(response.status, headers);
          return res.end(buf);
        }
        res.writeHead(404);
        res.end();
      };
      void run();
    },
    async close() {
      stopLeader?.();
      for (const [id, e] of txs) {
        clearTimeout(e.timer);
        await Promise.resolve(e.tx.rollback()).catch(() => {});
        txs.delete(id);
      }
    },
  };

  return handler;
}

/** Hono / Connect-style middleware: handles Wave routes, otherwise returns false so caller can `next()`. */
export function waveMiddleware(handler: WaveHandler): (request: Request) => Promise<Response | undefined> {
  return async (request) => {
    const res = await handler.fetch(request);
    return res.status === 404 ? undefined : res;
  };
}

export { waveHost, resolveStudioDist, type WaveHost, type WaveHostOptions } from "./host.ts";

export async function serve(db: Database<any>, opts: ServeOptions = {}): Promise<WaveServer> {
  const host = opts.host ?? "127.0.0.1";
  const handler = createWaveHandler(db, { ...opts, auth: opts.auth ?? !!opts.dataPath });
  const server = createServer(handler.nodeListener);

  await new Promise<void>((ok, fail) => {
    server.once("error", fail);
    server.listen(opts.port ?? 0, host, () => ok());
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : (opts.port ?? 0);
  return {
    url: `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`,
    port,
    host,
    server,
    handler,
    async close() {
      await handler.close();
      await new Promise<void>((ok) => {
        server.close(() => ok());
        (server as any).closeAllConnections?.();
      });
    },
  };
}
