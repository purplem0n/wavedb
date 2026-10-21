// Runs the built package under plain Node (no Bun) to prove the N-API addon + dist output work.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(fileURLToPath(import.meta.url), "..", "..");
execFileSync(join(root, "node_modules/.bin/tsc"), ["-p", "packages/wavedb/tsconfig.build.json"], { cwd: root, stdio: "inherit" });
const w = await import(pathToFileURL(join(root, "packages/wavedb/dist/index.js")).href);

const dir = mkdtempSync(join(tmpdir(), "wave-node-"));
try {
  const users = w.table("users", { id: w.int().autoIncrement(), name: w.text().notNull(), n: w.int().notNull().default(0) });
  const db = await w.wave(join(dir, "data.wave"), { schema: { users }, durability: "async" });
  await db.insert(users).values([{ name: "a" }, { name: "b" }]);
  assert.equal((await db.select().from(users)).length, 2);
  await Promise.all(
    Array.from({ length: 10 }, () =>
      db.tx(async (tx) => {
        const [u] = await tx.select().from(users).where(w.eq(users.id, 1));
        await tx.update(users).set({ n: u.n + 1 }).where(w.eq(users.id, 1));
      }, { retries: 100 }),
    ),
  );
  assert.equal((await db.query.users.findFirst({ where: { id: 1 } })).n, 10);
  const r = await db.sql`SELECT count(*) AS c FROM users`;
  assert.equal(r[0].c, 2);
  const server = await w.serve(db);
  const remote = await w.connect(server.url, { schema: { users } });
  assert.equal(await remote.query.users.count(), 2);
  await server.close();
  await db.close();
  console.log(`node ${process.version}: smoke test passed`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
