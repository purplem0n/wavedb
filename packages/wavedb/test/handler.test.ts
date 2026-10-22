import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createWaveHandler, waveHost } from "../src/server.ts";
import { connect, int, table, text } from "../src/index.ts";
import { cleanup, openTmp, tmpDir } from "./helpers.ts";

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
      staticPrefix: "/studio",
      staticDir,
    });
    const base = "http://127.0.0.1";
    const setup = await handler.fetch(
      new Request(`${base}/wave/api/auth/setup`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "supersecret1" }),
      }),
    );
    expect(setup.status).toBe(200);
    const login = await handler.fetch(
      new Request(`${base}/wave/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "supersecret1" }),
      }),
    );
    const loginJson = (await login.json()) as { token: string };
    const tables = await handler.fetch(
      new Request(`${base}/wave/api/tables`, { headers: { authorization: `Bearer ${loginJson.token}` } }),
    );
    expect(tables.status).toBe(200);
    expect((await tables.json()).map((t: { name: string }) => t.name)).toEqual(["items"]);

    const redirect = await handler.fetch(new Request(`${base}/studio`));
    expect(redirect.status).toBe(308);
    expect(new URL(redirect.headers.get("location")!).pathname).toBe("/studio/");

    const page = await handler.fetch(new Request(`${base}/studio/`));
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("embedded");
    expect(html).toContain('<base href="/studio/">');
    expect(html).toContain('__WAVE_API_PREFIX__="/wave/api"');

    const cfg = await handler.fetch(new Request(`${base}/studio/config.js`));
    expect(await cfg.text()).toContain("/wave/api");

    const srv = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => handler.fetch(req) });
    try {
      const remote = await connect(`http://127.0.0.1:${srv.port}/wave`, { schema, token: loginJson.token });
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

  test("machine token with auth enabled", async () => {
    const { db, dir } = await openTmp({ schema });
    const handler = createWaveHandler(db, { dataPath: join(dir, "data.wave"), auth: true, token: "m2m-token" });
    const res = await handler.fetch(new Request("http://x/api/tables", { headers: { authorization: "Bearer m2m-token" } }));
    expect(res.status).toBe(200);
    await handler.close();
    await db.close();
  });
});
