// Embed Wave Studio + HTTP API in an existing Fetch app (Hono, Bun.serve, etc.).

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Context, MiddlewareHandler, Next } from "hono";
import type { Database } from "./db.ts";
import { normalizePrefix } from "./auth.ts";
import { createWaveHandler, waveMiddleware, type HandlerOptions, type WaveHandler } from "./server.ts";

export interface WaveHostOptions extends Omit<HandlerOptions, "staticPrefix" | "apiPrefix" | "staticDir"> {
  /** URL path for Studio (default `/studio`). */
  studio?: string;
  /** URL prefix for Wave HTTP API (default `/__wave/api`). */
  apiPrefix?: string;
  /** Built Studio `dist/`; auto-detected when omitted. */
  staticDir?: string;
}

export interface WaveHost {
  handler: WaveHandler;
  /** Studio mount path, e.g. `/studio`. */
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

/** Mount Wave Studio + HTTP API on an existing server (minimal Hono/Bun integration). */
export function waveHost(db: Database<any>, opts: WaveHostOptions): WaveHost {
  const studioPath = opts.studio ?? "/studio";
  const apiPrefix = opts.apiPrefix ?? "/__wave/api";
  const staticDir = opts.staticDir ?? resolveStudioDist();
  const handler = createWaveHandler(db, {
    ...opts,
    dataPath: opts.dataPath ? resolve(opts.dataPath) : opts.dataPath,
    apiPrefix,
    staticPrefix: studioPath,
    staticDir,
    auth: opts.auth ?? !!opts.dataPath,
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
