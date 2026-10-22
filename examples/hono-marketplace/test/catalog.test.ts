import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { wave } from "@purplemon/wavedb";
import { createApp } from "../src/app.ts";
import { schema } from "../src/db/schema.ts";
import { seedOnly } from "../src/db/seed.ts";
import { SEED_PROFILES } from "../src/db/seed-profile.ts";

describe("marketplace catalog", () => {
  test("customer orders include line items", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wave-mp-"));
    const dataPath = join(dir, "data.wave");
    try {
      await seedOnly(true, SEED_PROFILES.small, dataPath);
      const db = await wave(dataPath, { schema, push: false });
      const app = createApp(db);
      const customerId = 1;

      const res = await app.fetch(new Request(`http://x/api/customers/${customerId}/orders`));
      expect(res.status).toBe(200);
      const json = (await res.json()) as { data: { orderItems: unknown[] }[] };
      expect(json.data.length).toBeGreaterThan(0);
      expect(json.data[0]!.orderItems.length).toBeGreaterThan(0);
      expect(json.data[0]!.orderItems[0]!.products?.title).toBeTruthy();
      await db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
