import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createWaveHandler } from "../src/server.ts";
import { openTmp } from "./helpers.ts";

function sessionToken(res: Response): string {
  const cookie = res.headers.get("set-cookie") ?? "";
  const m = /wave_session=([^;]+)/.exec(cookie);
  expect(m).toBeTruthy();
  return decodeURIComponent(m![1]!);
}

describe("auth", () => {
  test("setup has one winner", async () => {
    const { db, dir } = await openTmp({});
    const handler = createWaveHandler(db, { dataPath: join(dir, "data.wave"), auth: true });
    const [a, b] = await Promise.all([
      handler.fetch(
        new Request("http://x/api/auth/setup", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ password: "password-a1" }),
        }),
      ),
      handler.fetch(
        new Request("http://x/api/auth/setup", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ password: "password-b1" }),
        }),
      ),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 400]);
    const okRes = a.status === 200 ? a : b;
    const winner = sessionToken(okRes);
    const loginA = await handler.fetch(
      new Request("http://x/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "password-a1" }),
      }),
    );
    const loginB = await handler.fetch(
      new Request("http://x/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "password-b1" }),
      }),
    );
    const goodLogin = loginA.status === 200 ? loginA : loginB;
    expect(goodLogin.status).toBe(200);
    const badLogin = loginA.status === 401 ? loginA : loginB;
    expect(badLogin.status).toBe(401);
    const stale = sessionToken(goodLogin);
    const tablesWin = await handler.fetch(new Request("http://x/api/tables", { headers: { authorization: `Bearer ${winner}` } }));
    expect(tablesWin.status).toBe(200);
    void stale;
    await handler.close();
    await db.close();
  });

  test("cookie path follows API prefix", async () => {
    const { db, dir } = await openTmp({});
    const handler = createWaveHandler(db, {
      dataPath: join(dir, "data.wave"),
      auth: true,
      apiPrefix: "/wave/api",
    });
    await handler.fetch(
      new Request("http://x/wave/api/auth/setup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "supersecret1" }),
      }),
    );
    const login = await handler.fetch(
      new Request("http://x/wave/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "supersecret1" }),
      }),
    );
    expect(login.headers.get("set-cookie")).toContain("Path=/wave/api");
    await handler.close();
    await db.close();
  });
});
