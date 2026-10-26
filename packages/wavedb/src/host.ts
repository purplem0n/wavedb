// Embed Wave Studio + HTTP API in an existing Fetch app (Hono, Bun.serve, etc.).

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Context, MiddlewareHandler, Next } from "hono";
import type { Database } from "./db.ts";
import { defaultWavePath } from "./db.ts";
import { normalizePrefix } from "./auth.ts";
import { createWaveHandler, waveMiddleware, type HandlerOptions, type WaveHandler } from "./server.ts";

export interface WaveHostOptions extends Omit<HandlerOptions, "staticPrefix" | "apiPrefix" | "staticDir"> {
  /** Mount Studio static assets (default true). Set false for API-only embeds. */
  studio?: boolean | string;
  /** URL prefix for Wave HTTP API (default `/__wave/api`). */
  apiPrefix?: string;
  /** Built Studio `dist/`; auto-detected when omitted. */
  staticDir?: string;
}

export interface WaveHost {
  handler: WaveHandler;
  /** Studio mount path, e.g. `/wavedb-studio`. */
  studioPath: string;
  /** Base URL path for `connect()` / `wave --url`, e.g. `/__wave`. */
  connectPath: string;
  close(): Promise<void>;
  /** Hono middleware: handles Wave routes, otherwise calls `next()`. */
  hono(): MiddlewareHandler;
}

/** Locate prebuilt Wave Studio static assets (bundled with wavedb, monorepo, or `WAVE_STUDIO_DIR`). */
export function resolveStudioDist(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    process.env.WAVE_STUDIO_DIR,
    join(here, "..", "studio"),
    join(here, "..", "..", "wave-cli", "studio"),
    join(here, "..", "..", "wave-studio", "dist"),
    join(here, "..", "wave-studio", "dist"),
    join(process.cwd(), "node_modules", "@purplemon", "wavedb", "studio"),
    join(process.cwd(), "node_modules", "@purplemon", "wave-cli", "studio"),
    join(process.cwd(), "node_modules", "@purplemon", "wave-studio", "dist"),
  ].filter((p): p is string => !!p);
  return candidates.find((c) => existsSync(join(c, "index.html")));
}

function connectPathFromApiPrefix(apiPrefix: string): string {
  const p = normalizePrefix(apiPrefix || "/__wave/api");
  if (p.endsWith("/api")) return p.slice(0, -4) || "/";
  return p;
}

function resolveEmbedHandlerOptions(db: Database<any>, opts: WaveHostOptions): HandlerOptions {
  const dataPathRaw = opts.dataPath ?? db.dataPath ?? (process.env.WAVE_DB_PATH ? defaultWavePath() : undefined);
  const dataPath = dataPathRaw ? resolve(dataPathRaw) : undefined;
  const token = opts.token ?? process.env.WAVE_SERVE_TOKEN;
  const leader = opts.leader ?? process.env.WAVE_LEADER === "1";
  const standby = opts.standby ?? process.env.WAVE_STANDBY === "1";
  return {
    ...opts,
    dataPath,
    token,
    leader,
    standby,
    auth: opts.auth ?? !!dataPath,
  };
}

/** Mount Wave Studio + HTTP API on an existing server (minimal Hono/Bun integration). */
export function waveHost(db: Database<any>, opts: WaveHostOptions = {}): WaveHost {
  const studioOpt = opts.studio ?? true;
  const studioEnabled = studioOpt !== false;
  const studioPath = typeof studioOpt === "string" ? studioOpt : "/wavedb-studio";
  const apiPrefix = opts.apiPrefix ?? "/__wave/api";
  const staticDir = studioEnabled ? (opts.staticDir ?? resolveStudioDist()) : undefined;
  const handlerOpts = resolveEmbedHandlerOptions(db, opts);
  const handler = createWaveHandler(db, {
    ...handlerOpts,
    apiPrefix,
    staticPrefix: studioPath,
    staticDir,
    cors: opts.cors ?? process.env.NODE_ENV !== "production",
  });
  const tryHandle = waveMiddleware(handler);
  const connectPath = connectPathFromApiPrefix(apiPrefix);

  return {
    handler,
    studioPath,
    connectPath,
    close: () => handler.close(),
    hono(): MiddlewareHandler {
      return async (c: Context, next: Next) => {
        const res = await tryHandle(c.req.raw);
        if (res) return res;
        await next();
      };
    },
  };
}
