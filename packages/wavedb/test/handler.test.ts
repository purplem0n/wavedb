import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createWaveHandler, waveHost } from "../src/server.ts";
import { connect, int, table, text } from "../src/index.ts";
import { cleanup, openTmp, postAuthSetup, tmpDir } from "./helpers.ts";
import { WaveError } from "../src/errors.ts";

afterAll(cleanup);

const items = table("items", { id: int().autoIncrement(), name: text().notNull().unique() });
const schema = { items };

describe("createWaveHandler", () => {
  test("prefixed API and static routes", async () => {
    const { db, dir } = await openTmp({ schema });
    const staticDir = join(tmpDir(), "studio-static");
    mkdirSync(staticDir, { recursive: true });
    writeFileSync(join(staticDir, "index.html"), "<html>embedded</html>");
    const dataPath = join(dir, "data.wave");
    const handler = createWaveHandler(db, {
      dataPath,
      auth: true,
      apiPrefix: "/wave/api",
      staticPrefix: "/wavedb-studio",
      staticDir,
    });
    const base = "http://127.0.0.1";
    const setup = await postAuthSetup(handler, `${base}/wave/api/auth/setup`, "supersecret1", dir);
    expect(setup.status).toBe(200);
    const login = await handler.fetch(
      new Request(`${base}/wave/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "supersecret1" }),
      }),
    );
    const cookie = login.headers.get("set-cookie") ?? "";
    const session = /wave_session=([^;]+)/.exec(cookie)?.[1];
    expect(session).toBeTruthy();
    const token = decodeURIComponent(session!);
    const tables = await handler.fetch(
      new Request(`${base}/wave/api/tables`, { headers: { authorization: `Bearer ${token}` } }),
    );
    expect(tables.status).toBe(200);
    expect((await tables.json()).map((t: { name: string }) => t.name)).toEqual(["items"]);

    const run = await handler.fetch(
      new Request(`${base}/wave/api/run`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ sql: "SELECT count(*) AS n FROM items" }),
      }),
    );
    expect(run.status).toBe(200);
    const runJson = (await run.json()) as { durationMs?: number };
    expect(typeof runJson.durationMs).toBe("number");
    expect(runJson.durationMs!).toBeGreaterThanOrEqual(0);

    const redirect = await handler.fetch(new Request(`${base}/wavedb-studio`));
    expect(redirect.status).toBe(308);
    expect(new URL(redirect.headers.get("location")!).pathname).toBe("/wavedb-studio/");

    const page = await handler.fetch(new Request(`${base}/wavedb-studio/`));
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("embedded");
    expect(html).toContain('<base href="/wavedb-studio/">');
    expect(html).toContain('__WAVE_API_PREFIX__="/wave/api"');

    const cfg = await handler.fetch(new Request(`${base}/wavedb-studio/config.js`));
    const cfgJs = await cfg.text();
    expect(cfgJs).toContain("/wave/api");
    expect(cfgJs).toContain("__WAVE_ENGINE_VERSION__");

    const srv = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => handler.fetch(req) });
    try {
      const remote = await connect(`http://127.0.0.1:${srv.port}/wave`, { schema, token });
      await remote.insert(items).values({ name: "x" });
      expect(await remote.query.items.count()).toBe(1);
      await remote.close();
    } finally {
      srv.stop();
      await handler.close();
      await db.close();
    }
  });

  test("waveHost hono middleware passes through unrelated routes", async () => {
    const { db, dir } = await openTmp({ schema });
    const host = waveHost(db, { dataPath: join(dir, "data.wave"), auth: false });
    const mw = host.hono();
    let nextCalled = false;
    await mw({ req: { raw: new Request("http://x/health") } } as any, async () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(true);
    await host.close();
    await db.close();
  });

  test("health and multi-statement /api/run", async () => {
    const { db, dir } = await openTmp({ schema });
    const handler = createWaveHandler(db, {
      dataPath: join(dir, "data.wave"),
      auth: true,
      token: "run-token",
      leader: true,
    });
    const health = await handler.fetch(new Request("http://x/api/health"));
    const h = (await health.json()) as { ok: boolean; standby: boolean; expiresAt: number | null };
    expect(h.ok).toBe(true);
    expect(h.standby).toBe(false);
    expect(typeof h.expiresAt).toBe("number");

    const bad = await handler.fetch(
      new Request("http://x/api/run", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer run-token" },
        body: JSON.stringify({ sql: "INSERT INTO items (name) VALUES ('a'); DELETE FROM items" }),
      }),
    );
    expect(bad.status).toBe(400);
    await handler.close();
    await db.close();
  });

  test("static path traversal is rejected", async () => {
    const { db, dir } = await openTmp({ schema });
    const staticDir = join(tmpDir(), "studio-trav");
    mkdirSync(staticDir, { recursive: true });
    writeFileSync(join(staticDir, "index.html"), "ok");
    writeFileSync(join(staticDir, "safe.js"), "ok");
    const handler = createWaveHandler(db, { dataPath: join(dir, "data.wave"), auth: false, staticDir });
    expect((await handler.fetch(new Request("http://x/safe.js"))).status).toBe(200);
    expect((await handler.fetch(new Request("http://x/..%2f..%2fetc/passwd"))).status).toBe(403);
    expect((await handler.fetch(new Request("http://x/foo/..%2f..%2f..%2fetc/passwd"))).status).toBe(403);
    await handler.close();
    await db.close();
  });

  test("auth without dataPath throws", async () => {
    const { db } = await openTmp({ schema });
    const saved = db.dataPath;
    const env = process.env.WAVE_DB_PATH;
    delete process.env.WAVE_DB_PATH;
    Object.defineProperty(db, "dataPath", { value: undefined, configurable: true });
    try {
      expect(() => createWaveHandler(db, { auth: true })).toThrow(WaveError);
    } finally {
      Object.defineProperty(db, "dataPath", { value: saved, configurable: true });
      if (env !== undefined) process.env.WAVE_DB_PATH = env;
      await db.close();
    }
  });

  test("machine token with auth enabled", async () => {
    const { db, dir } = await openTmp({ schema });
    const handler = createWaveHandler(db, { dataPath: join(dir, "data.wave"), auth: true, token: "m2m-token" });
    const res = await handler.fetch(new Request("http://x/api/tables", { headers: { authorization: "Bearer m2m-token" } }));
    expect(res.status).toBe(200);
    await handler.close();
    await db.close();
  });
});
