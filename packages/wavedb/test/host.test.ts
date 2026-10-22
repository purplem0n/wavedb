import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { waveHost, resolveStudioDist } from "../src/host.ts";
import { openTmp } from "./helpers.ts";

describe("waveHost", () => {
  test("uses dataPath from wave() without opts", async () => {
    const { db, dir } = await openTmp({});
    expect(db.dataPath).toBe(join(dir, "data.wave"));
    const host = waveHost(db);
    const res = await host.handler.fetch(new Request("http://x/__wave/api/health"));
    expect(res.status).toBe(200);
    await host.close();
    await db.close();
  });
});

describe("resolveStudioDist", () => {
  test("finds bundled studio beside the package", () => {
    const dir = resolveStudioDist();
    expect(dir).toBeDefined();
    expect(existsSync(join(dir!, "index.html"))).toBe(true);
  });
});
