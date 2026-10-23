import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, wave } from "@purplemon/wavedb";
import { createApp } from "../src/app.ts";
import { schema } from "../src/db/schema.ts";
import { seedOnly } from "../src/db/seed.ts";
import { SEED_PROFILES } from "../src/db/seed-profile.ts";
import { products } from "../src/db/schema.ts";

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

  test("rejects negative order quantity", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wave-mp-"));
    const dataPath = join(dir, "data.wave");
    try {
      await seedOnly(true, SEED_PROFILES.small, dataPath);
      const db = await wave(dataPath, { schema, push: false });
      const app = createApp(db);
      const res = await app.fetch(
        new Request("http://x/api/orders", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ customerId: 1, lines: [{ productId: 1, qty: -1 }] }),
        }),
      );
      expect(res.status).toBe(400);
      await db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("cancelled orders cannot reopen and double-restore stock", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wave-mp-"));
    const dataPath = join(dir, "data.wave");
    try {
      await seedOnly(true, SEED_PROFILES.small, dataPath);
      const db = await wave(dataPath, { schema, push: false });
      const app = createApp(db);

      const productId = 1;
      const before = await db.select({ stock: products.stock }).from(products).where(eq(products.id, productId)).first();
      expect(before).toBeTruthy();

      const create = await app.fetch(
        new Request("http://x/api/orders", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ customerId: 1, lines: [{ productId, qty: 2 }] }),
        }),
      );
      expect(create.status).toBe(201);
      const order = (await create.json()) as { data: { id: number } };

      const cancel = await app.fetch(
        new Request(`http://x/api/orders/${order.data.id}/status`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ status: "cancelled" }),
        }),
      );
      expect(cancel.status).toBe(200);
      const afterCancel = await db.select({ stock: products.stock }).from(products).where(eq(products.id, productId)).first();

      const reopen = await app.fetch(
        new Request(`http://x/api/orders/${order.data.id}/status`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ status: "pending" }),
        }),
      );
      expect(reopen.status).toBe(409);

      const cancelAgain = await app.fetch(
        new Request(`http://x/api/orders/${order.data.id}/status`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ status: "cancelled" }),
        }),
      );
      expect(cancelAgain.status).toBe(200);
      const afterDouble = await db.select({ stock: products.stock }).from(products).where(eq(products.id, productId)).first();
      expect(afterDouble!.stock).toBe(afterCancel!.stock);

      await db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
