import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolveStudioDist } from "../src/host.ts";

describe("resolveStudioDist", () => {
  test("finds bundled studio beside the package", () => {
    const dir = resolveStudioDist();
    expect(dir).toBeDefined();
    expect(existsSync(join(dir!, "index.html"))).toBe(true);
  });
});
