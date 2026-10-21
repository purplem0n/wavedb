// HTTP server: exposes a Database to other processes (multi-process access, Studio, remote clients).
// Node + Bun compatible (uses node:http).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { WaveError, mapNativeError } from "./errors.ts";
import type { Database, TxBackend } from "./db.ts";

export interface ServeOptions {
  port?: number;
  host?: string;
  /** require `Authorization: Bearer <token>` on /api/* */
  token?: string;
  /** directory with a built single-page app (e.g. Wave Studio) served at `/` */
  staticDir?: string;
  /** roll back remote transactions idle for this long (default 30s) */
  txIdleMs?: number;
  /** send permissive CORS headers (dev) */
  cors?: boolean;
}

export interface WaveServer {
  url: string;
  port: number;
  host: string;
  server: Server;
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

async function readBody(req: IncomingMessage, limit = 64 * 1024 * 1024): Promise<any> {
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

export async function serve(db: Database<any>, opts: ServeOptions = {}): Promise<WaveServer> {
  const host = opts.host ?? "127.0.0.1";
  const idleMs = opts.txIdleMs ?? 30_000;
  const txs = new Map<string, { tx: TxBackend; timer: ReturnType<typeof setTimeout> }>();
  const staticDir = opts.staticDir ? resolve(opts.staticDir) : undefined;

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

  const authorized = (req: IncomingMessage): boolean => {
    if (!opts.token) return true;
    const h = req.headers.authorization ?? "";
    const given = Buffer.from(h.startsWith("Bearer ") ? h.slice(7) : "");
    const want = Buffer.from(opts.token);
    return given.length === want.length && timingSafeEqual(given, want);
  };

  const json = (res: ServerResponse, status: number, body: unknown) => {
    const text = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
    res.end(text);
  };

  async function api(req: IncomingMessage, res: ServerResponse, path: string) {
    const method = req.method ?? "GET";
    if (method === "GET" && path === "/api/ping") return json(res, 200, { ok: true });
    if (!authorized(req)) return json(res, 401, { error: { code: "WAVE_INVALID", message: "unauthorized" } });
    if (method === "GET" && (path === "/api/tables" || path === "/api/schema")) return json(res, 200, await db.tables());
    if (method === "GET" && path === "/api/stats") return json(res, 200, await db.stats());
    if (method !== "POST") return json(res, 404, { error: { code: "WAVE_NOT_FOUND", message: "no such endpoint" } });
    const body = await readBody(req);
    if (path === "/api/run") {
      const target = body.tx ? touch(String(body.tx)).tx.exec : db.backend.exec;
      const r = body.sql !== undefined ? await target.runSql(String(body.sql), body.params ?? []) : await target.run(body.stmt);
      return json(res, 200, r);
    }
    if (path === "/api/tx/begin") {
      const tx = await db.backend.begin(body.isolation === "serializable" ? "serializable" : "snapshot");
      const id = randomUUID();
      txs.set(id, { tx, timer: setTimeout(() => {}, 0) });
      touch(id);
      return json(res, 200, { id });
    }
    const m = /^\/api\/tx\/([^/]+)\/(commit|rollback)$/.exec(path);
    if (m) {
      const id = decodeURIComponent(m[1]!);
      const e = touch(id);
      clearTimeout(e.timer);
      txs.delete(id);
      if (m[2] === "commit") return json(res, 200, await e.tx.commit());
      await e.tx.rollback();
      return json(res, 200, { ok: true });
    }
    if (path === "/api/vacuum") return json(res, 200, { removed: await db.vacuum() });
    if (path === "/api/compact") {
      await db.compact();
      return json(res, 200, { ok: true });
    }
    return json(res, 404, { error: { code: "WAVE_NOT_FOUND", message: "no such endpoint" } });
  }

  function serveStatic(res: ServerResponse, urlPath: string) {
    if (!staticDir) {
      res.writeHead(404, { "content-type": "text/plain" });
      return res.end("WaveDB server. Use /api/*");
    }
    let rel = normalize(decodeURIComponent(urlPath)).replace(/^([/\\])+/, "");
    let file = join(staticDir, rel);
    if (!file.startsWith(staticDir)) {
      res.writeHead(403);
      return res.end();
    }
    if (!existsSync(file) || statSync(file).isDirectory()) {
      // SPA fallback
      if (extname(rel)) {
        res.writeHead(404);
        return res.end("not found");
      }
      file = join(staticDir, "index.html");
      if (!existsSync(file)) {
        res.writeHead(404);
        return res.end("studio not built");
      }
    }
    const data = readFileSync(file);
    res.writeHead(200, {
      "content-type": MIME[extname(file)] ?? "application/octet-stream",
      "cache-control": file.includes("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
    });
    res.end(data);
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (opts.cors) {
      res.setHeader("access-control-allow-origin", "*");
      res.setHeader("access-control-allow-headers", "authorization, content-type");
      res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
      if (req.method === "OPTIONS") {
        res.writeHead(204);
        return res.end();
      }
    }
    if (url.pathname.startsWith("/api/")) {
      api(req, res, url.pathname).catch((e) => {
        const err = mapNativeError(e);
        const code = err instanceof WaveError ? err.code : "WAVE_UNKNOWN";
        if (!res.headersSent) json(res, statusFor(code), { error: { code, message: err.message } });
        else res.end();
      });
    } else {
      serveStatic(res, url.pathname);
    }
  });

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
    async close() {
      for (const [id, e] of txs) {
        clearTimeout(e.timer);
        await Promise.resolve(e.tx.rollback()).catch(() => {});
        txs.delete(id);
      }
      await new Promise<void>((ok) => {
        server.close(() => ok());
        (server as any).closeAllConnections?.();
      });
    },
  };
}
