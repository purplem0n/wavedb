// Seeds ./demo.wave with a small multi-table dataset to explore in Wave Studio.
//   bun tools/seed-demo.ts [path] [orders]
import { blob, bool, int, json, real, table, text, timestamp, uniqueIndex, wave } from "../packages/wavedb/src/index.ts";

const path = process.argv[2] ?? "./demo.wave";
const nOrders = Number(process.argv[3] ?? 20_000);

export const users = table("users", {
  id: int().autoIncrement(),
  name: text().notNull(),
  email: text().notNull().unique(),
  active: bool().notNull().default(true),
  profile: json<{ plan: string; tags: string[] }>(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
export const orders = table(
  "orders",
  {
    id: int().autoIncrement(),
    userId: int("user_id").notNull().references(() => users.id).index(),
    status: text().notNull().default("new"),
    total: real().notNull(),
    avatar: blob(),
    placedAt: timestamp("placed_at").notNull(),
  },
  (t) => ({ indexes: [uniqueIndex().on(t.userId, t.placedAt)] }),
);

const db = await wave(path, { schema: { users, orders }, durability: "async" });
if ((await db.query.users.count()) === 0) {
  const plans = ["free", "pro", "team"];
  await db.insert(users).values(
    Array.from({ length: 1000 }, (_, i) => ({
      name: `User ${i}`,
      email: `user${i}@example.com`,
      active: i % 7 !== 0,
      profile: { plan: plans[i % 3]!, tags: i % 2 ? ["beta"] : [] },
    })),
  );
  const statuses = ["new", "paid", "shipped", "done"];
  for (let off = 0; off < nOrders; off += 2000) {
    await db.insert(orders).values(
      Array.from({ length: Math.min(2000, nOrders - off) }, (_, k) => {
        const i = off + k;
        return {
          userId: (i % 1000) + 1,
          status: statuses[i % 4]!,
          total: Math.round((i % 500) * 3.17 * 100) / 100,
          avatar: i % 50 === 0 ? new Uint8Array([1, 2, 3]) : null,
          placedAt: new Date(1_700_000_000_000 + i * 60_000),
        };
      }),
    );
  }
}
console.log(`seeded ${path}: ${await db.query.users.count()} users, ${await db.query.orders.count()} orders`);
await db.close();
