import { afterAll, describe, expect, test } from "bun:test";
import {
  ConflictError,
  ConstraintError,
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  inArray,
  inc,
  int,
  json,
  like,
  or,
  sql,
  sum,
  table,
  text,
  timestamp,
  bool,
  real,
  uniqueIndex,
  excluded,
  jsonGet,
  wave,
  blob,
  uuid,
} from "../src/index.ts";
import { cleanup, openTmp } from "./helpers.ts";

afterAll(cleanup);

const users = table(
  "users",
  {
    id: int().autoIncrement(),
    name: text().notNull(),
    email: text().notNull().unique(),
    age: int(),
    active: bool().notNull().default(true),
    meta: json<{ tags?: string[]; n?: number }>(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({ indexes: [uniqueIndex().on(t.name, t.age)] }),
);

const posts = table("posts", {
  id: int().autoIncrement(),
  userId: int("user_id")
    .notNull()
    .references(() => users.id)
    .index(),
  title: text().notNull(),
  views: int().notNull().default(0),
  score: real(),
});

const schema = { users, posts };

describe("typed query builder", () => {
  test("insert / select / update / delete round trip", async () => {
    const { db } = await openTmp({ schema });
    const r = await db.insert(users).values({ name: "Ada", email: "ada@x.io", age: 36, meta: { tags: ["a", "b"] } });
    expect(r.rowsAffected).toBe(1);
    expect(r.lastInsertId).toBe(1);

    const rows = await db.select().from(users).where(eq(users.email, "ada@x.io"));
    expect(rows).toHaveLength(1);
    const ada = rows[0]!;
    expect(ada.name).toBe("Ada");
    expect(ada.active).toBe(true);
    expect(ada.createdAt).toBeInstanceOf(Date);
    expect(Math.abs(ada.createdAt.getTime() - Date.now())).toBeLessThan(10_000);
    expect(ada.meta).toEqual({ tags: ["a", "b"] });

    await db.update(users).set({ age: 37 }).where(eq(users.id, ada.id));
    expect((await db.select().from(users).first())!.age).toBe(37);

    const del = await db.delete(users).where(eq(users.id, ada.id));
    expect(del.rowsAffected).toBe(1);
    expect(await db.select().from(users)).toHaveLength(0);
    await db.close();
  });

  test("multi-row insert, defaults for omitted columns, returning", async () => {
    const { db } = await openTmp({ schema });
    const out = await db
      .insert(users)
      .values([
        { name: "A", email: "a@x", age: 1 },
        { name: "B", email: "b@x", active: false },
        { name: "C", email: "c@x", age: 3, meta: { n: 3 } },
      ])
      .returning();
    expect(out.map((u) => u.id)).toEqual([1, 2, 3]);
    expect(out[1]!.active).toBe(false);
    expect(out[1]!.age).toBeNull();
    expect(out[0]!.active).toBe(true);

    const some = await db.insert(posts).values({ userId: 1, title: "t" }).returning({ id: posts.id, v: posts.views });
    expect(some).toEqual([{ id: 1, v: 0 }]);
    await db.close();
  });

  test("where operators, ordering, paging, aggregates", async () => {
    const { db } = await openTmp({ schema });
    await db.insert(users).values(
      Array.from({ length: 50 }, (_, i) => ({
        name: `user${String(i).padStart(2, "0")}`,
        email: `u${i}@x.io`,
        age: 20 + (i % 10),
        meta: { n: i },
      })),
    );
    const adults = await db.select({ id: users.id }).from(users).where(and(gt(users.age, 25), like(users.name, "user1%")));
    expect(adults.every((r) => r.id >= 11 && r.id <= 20)).toBe(true);

    const top = await db.select().from(users).orderBy(desc(users.age), asc(users.id)).limit(3).offset(1);
    expect(top.map((u) => u.age)).toEqual([29, 29, 29]);
    expect(top[0]!.id).toBe(20);

    const stats = await db
      .select({ age: users.age, n: count(), ids: sum(users.id) })
      .from(users)
      .groupBy(users.age)
      .orderBy(asc(users.age));
    expect(stats).toHaveLength(10);
    expect(stats[0]).toEqual({ age: 20, n: 5, ids: 1 + 11 + 21 + 31 + 41 });

    const either = await db
      .select({ id: users.id })
      .from(users)
      .where(or(eq(users.id, 1), inArray(users.id, [2, 3])))
      .orderBy(asc(users.id));
    expect(either.map((r) => r.id)).toEqual([1, 2, 3]);

    const js = await db.select({ n: jsonGet(users.meta, "n") }).from(users).where(eq(users.id, 5));
    expect(js[0]!.n).toBe(4);
    await db.close();
  });

  test("joins produce nested rows; left join yields null", async () => {
    const { db } = await openTmp({ schema });
    await db.insert(users).values([
      { name: "A", email: "a@x" },
      { name: "B", email: "b@x" },
    ]);
    await db.insert(posts).values([
      { userId: 1, title: "p1" },
      { userId: 1, title: "p2" },
    ]);
    const inner = await db.select().from(users).innerJoin(posts, eq(posts.userId, users.id)).orderBy(asc(posts.id));
    expect(inner).toHaveLength(2);
    expect(inner[0]!.users.name).toBe("A");
    expect(inner[1]!.posts.title).toBe("p2");

    const left = await db.select().from(users).leftJoin(posts, eq(posts.userId, users.id)).orderBy(asc(users.id), asc(posts.id));
    expect(left).toHaveLength(3);
    expect(left[2]!.users.name).toBe("B");
    expect(left[2]!.posts).toBeNull();

    const counts = await db
      .select({ name: users.name, posts: count(posts.id) })
      .from(users)
      .leftJoin(posts, eq(posts.userId, users.id))
      .groupBy(users.id)
      .orderBy(asc(users.id));
    expect(counts).toEqual([
      { name: "A", posts: 2 },
      { name: "B", posts: 0 },
    ]);
    await db.close();
  });

  test("upsert: doNothing / doUpdate with excluded and inc", async () => {
    const { db } = await openTmp({ schema });
    await db.insert(users).values({ name: "A", email: "a@x", age: 1 });
    const r1 = await db.insert(users).values({ name: "A2", email: "a@x" }).onConflictDoNothing();
    expect(r1.rowsAffected).toBe(0);
    await db
      .insert(users)
      .values({ name: "A3", email: "a@x", age: 9 })
      .onConflictDoUpdate({ target: users.email, set: { name: excluded(users.name), age: inc(5) } });
    const u = (await db.select().from(users))[0]!;
    expect(u.name).toBe("A3");
    expect(u.age).toBe(6);
    expect(await db.select().from(users)).toHaveLength(1);
    await db.close();
  });

  test("constraint errors are typed", async () => {
    const { db } = await openTmp({ schema });
    await db.insert(users).values({ name: "A", email: "a@x" });
    await expect(db.insert(users).values({ name: "B", email: "a@x" }).execute()).rejects.toBeInstanceOf(ConstraintError);
    await expect(db.insert(users).values({ name: "B", email: null as any }).execute()).rejects.toBeInstanceOf(ConstraintError);
    await db.close();
  });

  test("blob + uuid + timestamp columns", async () => {
    const t = table("files", {
      id: uuid().primaryKey().defaultUuid(),
      data: blob(),
      at: timestamp(),
    });
    const { db } = await openTmp({ schema: { t } });
    const when = new Date("2024-05-06T07:08:09.123Z");
    const [row] = await db
      .insert(t)
      .values({ data: new Uint8Array([1, 2, 3, 255]), at: when })
      .returning();
    expect(row!.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(Array.from(row!.data!)).toEqual([1, 2, 3, 255]);
    expect(row!.at!.getTime()).toBe(when.getTime());
    const back = await db.select().from(t).where(eq(t.id, row!.id));
    expect(Array.from(back[0]!.data!)).toEqual([1, 2, 3, 255]);
    await db.close();
  });

  test("explain shows index usage", async () => {
    const { db } = await openTmp({ schema });
    const plan = await db.select().from(users).where(eq(users.email, "x")).explain();
    expect(plan.join("\n")).toMatch(/INDEX|SEARCH|index/i);
    const full = await db.select().from(users).where(eq(users.age, 3)).explain();
    expect(full.join("\n")).toMatch(/SCAN/i);
    await db.close();
  });
});

describe("sql tag", () => {
  test("binds parameters and composes fragments", async () => {
    const { db } = await openTmp({ schema });
    await db.insert(users).values([
      { name: "A", email: "a@x", age: 10 },
      { name: "B", email: "b@x", age: 20 },
    ]);
    const min = 15;
    const rows = await db.sql<{ name: string }>`SELECT name FROM users WHERE age > ${min} AND name = ${"B"}`;
    expect([...rows]).toEqual([{ name: "B" }]);
    expect(rows.columns).toEqual(["name"]);

    const where = sql`age < ${15}`;
    const r2 = await db.sql`SELECT name FROM users WHERE ${where}`;
    expect(r2.map((r) => r.name)).toEqual(["A"]);

    const ids = sql.join([1, 2].map((i) => sql`${i}`));
    const r3 = await db.sql`SELECT count(*) AS n FROM users WHERE id IN (${ids})`;
    expect(r3[0]!.n).toBe(2);

    const col = sql.identifier("users");
    const r4 = await db.sql`SELECT count(*) AS n FROM ${col}`;
    expect(r4[0]!.n).toBe(2);

    // injection attempt stays data
    await db.sql`INSERT INTO users (name, email) VALUES (${"x'); DROP TABLE users; --"}, ${"i@x"})`;
    expect((await db.sql`SELECT count(*) AS n FROM users`)[0]!.n).toBe(3);
    const r5 = await db.sql`SELECT id FROM users WHERE id IN (${[1, 2]}) ORDER BY id`;
    expect(r5.map((r) => r.id)).toEqual([1, 2]);
    await db.close();
  });

  test("execute with positional params; DDL via SQL", async () => {
    const { db } = await openTmp();
    await db.execute("CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT NOT NULL)");
    const r = await db.execute("INSERT INTO t (v) VALUES ($1), ($2) RETURNING id", ["a", "b"]);
    expect(r.map((x) => x.id)).toEqual([1, 2]);
    expect(r.rowsAffected).toBe(2);
    await db.close();
  });
});

describe("transactions", () => {
  test("commit and rollback", async () => {
    const { db } = await openTmp({ schema });
    await db.tx(async (tx) => {
      await tx.insert(users).values({ name: "A", email: "a@x" });
      // read your own writes
      expect(await tx.select().from(users)).toHaveLength(1);
    });
    expect(await db.select().from(users)).toHaveLength(1);

    await expect(
      db.tx(async (tx) => {
        await tx.insert(users).values({ name: "B", email: "b@x" });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await db.select().from(users)).toHaveLength(1);
    await db.close();
  });

  test("snapshot isolation: tx does not see later commits", async () => {
    const { db } = await openTmp({ schema });
    await db.insert(users).values({ name: "A", email: "a@x" });
    const tx = await db.begin();
    await db.insert(users).values({ name: "B", email: "b@x" });
    expect(await tx.select().from(users)).toHaveLength(1);
    await tx.commit();
    expect(await db.select().from(users)).toHaveLength(2);
    await db.close();
  });

  test("conflicting manual transactions: first committer wins", async () => {
    const { db } = await openTmp({ schema });
    await db.insert(users).values({ name: "A", email: "a@x", age: 1 });
    const t1 = await db.begin();
    const t2 = await db.begin();
    await t1.update(users).set({ age: 2 }).where(eq(users.id, 1));
    await t2.update(users).set({ age: 3 }).where(eq(users.id, 1));
    await t1.commit();
    await expect(t2.commit()).rejects.toBeInstanceOf(ConflictError);
    expect((await db.select().from(users))[0]!.age).toBe(2);
    await db.close();
  });

  test("db.tx retries conflicts: concurrent read-modify-write is lossless", async () => {
    const counter = table("counter", { id: int().primaryKey(), n: int().notNull() });
    const { db } = await openTmp({ schema: { counter } });
    await db.insert(counter).values({ id: 1, n: 0 });
    const N = 20;
    const M = 10;
    await Promise.all(
      Array.from({ length: N }, async () => {
        for (let i = 0; i < M; i++) {
          await db.tx(
            async (tx) => {
              const [row] = await tx.select().from(counter).where(eq(counter.id, 1));
              await tx.update(counter).set({ n: row!.n + 1 }).where(eq(counter.id, 1));
            },
            { retries: 200 },
          );
        }
      }),
    );
    expect((await db.select().from(counter))[0]!.n).toBe(N * M);
    const s = await db.stats();
    expect(s.conflicts).toBeGreaterThan(0);
    await db.close();
  });

  test("inc() updates merge without OCC conflicts under contention", async () => {
    const counter = table("counter", { id: int().primaryKey(), n: int().notNull() });
    const { db } = await openTmp({ schema: { counter } });
    await db.insert(counter).values({ id: 1, n: 0 });
    const N = 16;
    const M = 15;
    await Promise.all(
      Array.from({ length: N }, () =>
        Promise.all(
          Array.from({ length: M }, () =>
            db.update(counter).set({ n: inc(1) }).where(eq(counter.id, 1)).execute(),
          ),
        ),
      ),
    );
    expect((await db.select().from(counter))[0]!.n).toBe(N * M);
    expect((await db.stats()).conflicts).toBe(0);
    await db.close();
  });

  test("serializable detects write skew; snapshot allows it", async () => {
    const acct = table("acct", { id: int().primaryKey(), bal: int().notNull() });
    const { db } = await openTmp({ schema: { acct } });
    await db.insert(acct).values([
      { id: 1, bal: 50 },
      { id: 2, bal: 50 },
    ]);
    const skew = async (iso: "snapshot" | "serializable") => {
      await db.update(acct).set({ bal: 50 });
      const a = await db.begin({ isolation: iso });
      const b = await db.begin({ isolation: iso });
      await a.select().from(acct);
      await b.select().from(acct);
      await a.update(acct).set({ bal: 0 }).where(eq(acct.id, 1));
      await b.update(acct).set({ bal: 0 }).where(eq(acct.id, 2));
      await a.commit();
      return b.commit().then(
        () => "committed",
        (e) => (e instanceof ConflictError ? "conflict" : String(e)),
      );
    };
    expect(await skew("snapshot")).toBe("committed");
    expect(await skew("serializable")).toBe("conflict");
    await db.close();
  });

  test("tx object is unusable after commit", async () => {
    const { db } = await openTmp({ schema });
    const tx = await db.begin();
    await tx.commit();
    await expect(tx.select().from(users).execute()).rejects.toThrow(/finished/);
    await db.close();
  });
});

describe("relational query API", () => {
  test("findMany / findFirst / count / with", async () => {
    const { db } = await openTmp({ schema });
    await db.insert(users).values([
      { name: "A", email: "a@x", age: 30 },
      { name: "B", email: "b@x", age: 40 },
      { name: "C", email: "c@x", age: 50 },
    ]);
    await db.insert(posts).values([
      { userId: 1, title: "a1", views: 5 },
      { userId: 1, title: "a2", views: 9 },
      { userId: 2, title: "b1", views: 1 },
    ]);
    const older = await db.query.users.findMany({ where: { age: { gte: 40 } }, orderBy: { age: "desc" } });
    expect(older.map((u) => u.name)).toEqual(["C", "B"]);
    expect((await db.query.users.findFirst({ where: { email: "b@x" } }))!.name).toBe("B");
    expect(await db.query.users.findFirst({ where: { email: "zz" } })).toBeUndefined();
    expect(await db.query.users.count()).toBe(3);
    expect(await db.query.users.count({ age: { lt: 45 } })).toBe(2);
    expect(await db.query.users.findMany({ where: { OR: [{ name: "A" }, { name: "C" }] } })).toHaveLength(2);

    const withPosts = await db.query.users.findMany({
      with: { posts: { orderBy: { views: "desc" } } },
      orderBy: { id: "asc" },
    });
    expect(withPosts[0]!.posts.map((p: any) => p.title)).toEqual(["a2", "a1"]);
    expect(withPosts[1]!.posts).toHaveLength(1);
    expect(withPosts[2]!.posts).toEqual([]);

    const postsWithAuthor = await db.query.posts.findMany({ with: { users: true }, orderBy: { id: "asc" } });
    expect(postsWithAuthor[2]!.users.name).toBe("B");
    await db.close();
  });
});

describe("schema push & migrations", () => {
  test("push is idempotent and additive; destructive requires opt-in", async () => {
    const { db, dir } = await openTmp();
    const v1 = table("things", { id: int().autoIncrement(), name: text().notNull() });
    const d1 = await wave(`${dir}/s.wave`, { schema: { v1 } });
    expect(await d1.diff()).toEqual([]);
    await d1.insert(v1).values({ name: "x" });
    await d1.close();

    const v2 = table("things", {
      id: int().autoIncrement(),
      name: text().notNull(),
      note: text(),
      rank: int().notNull().default(7),
      tag: text().index(),
    });
    const d2 = await wave(`${dir}/s.wave`, { schema: { v2 }, push: false });
    const ops = await d2.diff();
    expect(ops.map((o) => o.op).sort()).toEqual(["addColumn", "addColumn", "addColumn", "createIndex"]);
    await d2.push();
    expect(await d2.diff()).toEqual([]);
    const rows = await d2.select().from(v2);
    expect(rows).toEqual([{ id: 1, name: "x", note: null, rank: 7, tag: null }]);
    await d2.close();

    const v3 = table("things", { id: int().autoIncrement(), name: text().notNull() });
    const d3 = await wave(`${dir}/s.wave`, { schema: { v3 }, push: false });
    await expect(d3.push()).rejects.toThrow(/lose data/);
    await d3.push({ allowDestructive: true });
    expect(await d3.diff()).toEqual([]);
    expect(await d3.select().from(v3)).toEqual([{ id: 1, name: "x" }]);
    await d3.close();
    await db.close();
  });

  test("type mismatch and NOT NULL without default are reported", async () => {
    const { dir } = await openTmp();
    const a = table("t", { id: int().primaryKey(), v: int() });
    const d1 = await wave(`${dir}/m.wave`, { schema: { a } });
    await d1.close();
    const b = table("t", { id: int().primaryKey(), v: text(), w: int().notNull() });
    const d2 = await wave(`${dir}/m.wave`, { schema: { b }, push: false });
    const ops = await d2.diff();
    expect(ops.some((o) => o.op === "rebuildTable")).toBe(true);
    await expect(d2.push()).rejects.toThrow(/allowDestructive/);
    await d2.close();
  });

  test("migrate runs each migration once, in order", async () => {
    const { db } = await openTmp();
    const log: string[] = [];
    const migs = [
      {
        id: "001_init",
        up: async (tx: any) => {
          log.push("001");
          await tx.execute("CREATE TABLE m (id INTEGER PRIMARY KEY, v TEXT)");
        },
      },
      {
        id: "002_seed",
        up: async (tx: any) => {
          log.push("002");
          await tx.execute("INSERT INTO m (id, v) VALUES (1, 'x')");
        },
      },
    ];
    expect(await db.migrate(migs)).toEqual(["001_init", "002_seed"]);
    expect(await db.migrate(migs)).toEqual([]);
    expect(log).toEqual(["001", "002"]);
    expect((await db.sql`SELECT v FROM m`)[0]!.v).toBe("x");
    await db.close();
  });
});

describe("wide integers", () => {
  test("bigint round-trips through insert and select", async () => {
    const wide = table("wide", { id: int().primaryKey(), n: int().notNull() });
    const { db } = await openTmp({ schema: { wide } });
    const v = 9007199254740993n;
    await db.insert(wide).values({ id: 1, n: v });
    const row = (await db.select().from(wide))[0]!;
    expect(row.n).toBe(v);
    expect(typeof row.n).toBe("bigint");
    const sql = await db.sql<{ n: bigint }>`SELECT n FROM wide WHERE id = ${1}`;
    expect(sql[0]!.n).toBe(v);
    await db.close();
  });
});

describe("persistence & ops", () => {
  test("data survives close and reopen; vacuum and stats work", async () => {
    const { db, dir } = await openTmp({ schema });
    await db.insert(users).values({ name: "A", email: "a@x" });
    for (let i = 0; i < 5; i++) await db.update(users).set({ age: i }).where(eq(users.id, 1));
    const removed = await db.vacuum();
    expect(removed).toBeGreaterThanOrEqual(0);
    await db.compact();
    const s = await db.stats();
    expect(s.commits).toBeGreaterThan(5);
    await db.close();

    const again = await wave(`${dir}/data.wave`, { schema });
    const rows = await again.select().from(users);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.age).toBe(4);
    expect(await again.diff()).toEqual([]);
    await again.close();
  });

  test("watch fires on change", async () => {
    const { db } = await openTmp({ schema });
    const seen: number[] = [];
    const stop = db.watch(
      () => db.query.users.count(),
      (n) => seen.push(n),
      { intervalMs: 20 },
    );
    await new Promise((r) => setTimeout(r, 80));
    await db.insert(users).values({ name: "A", email: "a@x" });
    await new Promise((r) => setTimeout(r, 150));
    stop();
    expect(seen[0]).toBe(0);
    expect(seen.at(-1)).toBe(1);
    await db.close();
  });

  test("use after close throws", async () => {
    const { db } = await openTmp({ schema });
    await db.close();
    await expect(db.select().from(users).execute()).rejects.toThrow();
  });
});
