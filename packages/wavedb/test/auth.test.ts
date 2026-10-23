import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createWaveHandler } from "../src/server.ts";
import { handlerDataPath, openTmp, postAuthSetup, readSetupTokenForDataDir } from "./helpers.ts";

function sessionToken(res: Response): string {
  const cookie = res.headers.get("set-cookie") ?? "";
  const m = /wave_session=([^;]+)/.exec(cookie);
  expect(m).toBeTruthy();
  return decodeURIComponent(m![1]!);
}

describe("auth", () => {
  test("setup requires token", async () => {
    const { db, dir } = await openTmp({});
    const handler = createWaveHandler(db, { dataPath: handlerDataPath(dir), auth: true });
    const bad = await handler.fetch(
      new Request("http://x/api/auth/setup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "password-a1" }),
      }),
    );
    expect(bad.status).toBe(400);
    const ok = await postAuthSetup(handler, "http://x/api/auth/setup", "password-a1", dir);
    expect(ok.status).toBe(200);
    await handler.close();
    await db.close();
  });

  test("setup has one winner", async () => {
    const { db, dir } = await openTmp({});
    const handler = createWaveHandler(db, { dataPath: handlerDataPath(dir), auth: true });
    const token = readSetupTokenForDataDir(dir);
    const [a, b] = await Promise.all([
      handler.fetch(
        new Request("http://x/api/auth/setup", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ password: "password-a1", setupToken: token }),
        }),
      ),
      handler.fetch(
        new Request("http://x/api/auth/setup", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ password: "password-b1", setupToken: token }),
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
    const tablesWin = await handler.fetch(new Request("http://x/api/tables", { headers: { authorization: `Bearer ${winner}` } }));
    expect(tablesWin.status).toBe(200);
    await handler.close();
    await db.close();
  });

  test("https fetch sets Secure on session cookie", async () => {
    const { db, dir } = await openTmp({});
    const handler = createWaveHandler(db, { dataPath: handlerDataPath(dir), auth: true });
    await postAuthSetup(handler, "https://x/api/auth/setup", "password-a1", dir);
    const login = await handler.fetch(
      new Request("https://x/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "password-a1" }),
      }),
    );
    expect(login.headers.get("set-cookie")).toContain("Secure");
    const httpLogin = await handler.fetch(
      new Request("http://x/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "password-a1" }),
      }),
    );
    expect(httpLogin.headers.get("set-cookie") ?? "").not.toContain("Secure");
    await handler.close();
    await db.close();
  });

  test("cookie path follows API prefix", async () => {
    const { db, dir } = await openTmp({});
    const handler = createWaveHandler(db, {
      dataPath: handlerDataPath(dir),
      auth: true,
      apiPrefix: "/wave/api",
    });
    await postAuthSetup(handler, "http://x/wave/api/auth/setup", "supersecret1", dir);
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
