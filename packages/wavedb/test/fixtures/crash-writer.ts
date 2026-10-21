// Child process for the crash-recovery test: commits transactions forever, acking each one on stdout.
import { int, table, text, wave } from "../../src/index.ts";

const a = table("a", { id: int().primaryKey(), v: text().notNull() });
const b = table("b", { id: int().primaryKey(), v: text().notNull() });

const db = await wave(process.argv[2]!, { schema: { a, b }, durability: "sync" });
const start = Number(process.argv[3] ?? 0);
console.log("READY");
for (let i = start; ; i++) {
  await db.tx(async (tx) => {
    await tx.insert(a).values({ id: i, v: "x".repeat(100) });
    await tx.insert(b).values({ id: i, v: "y".repeat(100) });
  });
  console.log(`ACK ${i}`);
}
