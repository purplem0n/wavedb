use std::sync::Arc;
use std::thread;
use wave_core::{Db, Durability, Error, Isolation, Options, Value};

fn open_tmp() -> (tempfile::TempDir, Db) {
    let d = tempfile::tempdir().unwrap();
    let db = Db::open(
        d.path().join("data.wave"),
        Options {
            durability: Durability::Async,
            cache_bytes: 16 << 20,
            temporary: false,
        },
    )
    .unwrap();
    (d, db)
}

fn q(db: &Db, sql: &str) -> Vec<Vec<Value>> {
    db.execute_sql(sql, &[]).unwrap_or_else(|e| panic!("{sql}: {e}")).rows
}

fn qp(db: &Db, sql: &str, p: &[Value]) -> Vec<Vec<Value>> {
    db.execute_sql(sql, p).unwrap_or_else(|e| panic!("{sql}: {e}")).rows
}

fn i(v: i64) -> Value {
    Value::Int(v)
}
fn t(s: &str) -> Value {
    Value::Text(s.into())
}

fn setup_users(db: &Db) {
    q(
        db,
        "CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL UNIQUE, name TEXT, age INT, active BOOLEAN DEFAULT true, created TIMESTAMP DEFAULT now())",
    );
    q(db, "CREATE INDEX users_age ON users (age)");
}

#[test]
fn create_insert_select_basic() {
    let (_d, db) = open_tmp();
    setup_users(&db);
    let r = db
        .execute_sql(
            "INSERT INTO users (email, name, age) VALUES ('a@x.io','Ann',30), ('b@x.io','Bob',25), ('c@x.io','Cy',NULL)",
            &[],
        )
        .unwrap();
    assert_eq!(r.rows_affected, 3);
    assert_eq!(r.last_insert_id, Some(i(3)));
    let rows = q(&db, "SELECT id, email, name, age, active FROM users ORDER BY id");
    assert_eq!(rows.len(), 3);
    assert_eq!(rows[0][..3], [i(1), t("a@x.io"), t("Ann")]);
    assert_eq!(rows[0][4], Value::Bool(true));
    assert_eq!(rows[2][3], Value::Null);
    // params
    let rows = qp(&db, "SELECT name FROM users WHERE email = $1", &[t("b@x.io")]);
    assert_eq!(rows, vec![vec![t("Bob")]]);
    let rows = qp(&db, "SELECT name FROM users WHERE age > ? AND age < ?", &[i(20), i(28)]);
    assert_eq!(rows, vec![vec![t("Bob")]]);
}

#[test]
fn constraints_and_types() {
    let (_d, db) = open_tmp();
    setup_users(&db);
    q(&db, "INSERT INTO users (email, name) VALUES ('a@x.io','Ann')");
    let e = db
        .execute_sql("INSERT INTO users (email) VALUES ('a@x.io')", &[])
        .unwrap_err();
    assert!(matches!(e, Error::Constraint(_)), "{e}");
    let e = db.execute_sql("INSERT INTO users (name) VALUES ('x')", &[]).unwrap_err();
    assert!(e.to_string().contains("NOT NULL"), "{e}");
    let e = db
        .execute_sql("INSERT INTO users (email, age) VALUES ('z@x.io', 'old')", &[])
        .unwrap_err();
    assert!(matches!(e, Error::Constraint(_)), "{e}");
    // explicit PK dup
    let e = db
        .execute_sql("INSERT INTO users (id, email) VALUES (1, 'q@x.io')", &[])
        .unwrap_err();
    assert!(matches!(e, Error::Constraint(_)));
    // unknown table / column
    assert!(matches!(
        db.execute_sql("SELECT * FROM nope", &[]).unwrap_err(),
        Error::NotFound(_)
    ));
    assert!(matches!(
        db.execute_sql("SELECT zzz FROM users", &[]).unwrap_err(),
        Error::NotFound(_)
    ));
    // multiple NULLs allowed in unique column
    q(&db, "CREATE TABLE u2 (id INT PRIMARY KEY, code TEXT UNIQUE)");
    q(&db, "INSERT INTO u2 VALUES (1, NULL), (2, NULL), (3, 'x')");
    assert_eq!(q(&db, "SELECT count(*) FROM u2"), vec![vec![i(3)]]);
}

#[test]
fn explain_uses_expected_access_paths() {
    let (_d, db) = open_tmp();
    setup_users(&db);
    let plan = |sql: &str| -> String {
        match &q(&db, &format!("EXPLAIN {sql}"))[0][0] {
            Value::Text(s) => s.clone(),
            _ => panic!(),
        }
    };
    assert!(plan("SELECT * FROM users WHERE id = 5").contains("PRIMARY KEY (id=?)"));
    assert!(plan("SELECT * FROM users WHERE id > 5 AND id < 9").contains("PRIMARY KEY (id RANGE)"));
    assert!(plan("SELECT * FROM users WHERE id IN (1,2,3)").contains("PRIMARY KEY (id IN"));
    assert!(plan("SELECT * FROM users WHERE email = 'a'").contains("INDEX users_email_key"));
    assert!(plan("SELECT * FROM users WHERE age >= 10").contains("INDEX users_age (age RANGE)"));
    assert!(plan("SELECT * FROM users WHERE name = 'x'").contains("FULL SCAN"));
    assert!(plan("SELECT * FROM users ORDER BY id DESC LIMIT 5").contains("(ordered)"));
    assert!(plan("SELECT * FROM users ORDER BY age LIMIT 5").contains("INDEX users_age"));
    assert!(plan("DELETE FROM users WHERE id = 1").contains("PRIMARY KEY"));
}

#[test]
fn where_filters_and_expressions() {
    let (_d, db) = open_tmp();
    q(&db, "CREATE TABLE n (id INT PRIMARY KEY, v REAL, s TEXT, j JSON)");
    q(&db, "INSERT INTO n VALUES (1, 1.5, 'alpha', '{\"a\":{\"b\":[10,20]}}'), (2, 2.5, 'beta', NULL), (3, NULL, 'gamma', NULL), (4, 4, NULL, NULL)");
    assert_eq!(q(&db, "SELECT id FROM n WHERE v IS NULL"), vec![vec![i(3)]]);
    assert_eq!(q(&db, "SELECT id FROM n WHERE v IS NOT NULL ORDER BY id").len(), 3);
    assert_eq!(q(&db, "SELECT id FROM n WHERE s LIKE '%a' ORDER BY id").len(), 3);
    assert_eq!(q(&db, "SELECT id FROM n WHERE s ILIKE 'ALPHA'"), vec![vec![i(1)]]);
    assert_eq!(q(&db, "SELECT id FROM n WHERE id BETWEEN 2 AND 3 ORDER BY id").len(), 2);
    assert_eq!(q(&db, "SELECT id FROM n WHERE id NOT IN (1,2) ORDER BY id").len(), 2);
    assert_eq!(q(&db, "SELECT id FROM n WHERE NOT (id = 1 OR id = 2) ORDER BY id").len(), 2);
    assert_eq!(q(&db, "SELECT v * 2 + 1 FROM n WHERE id = 2"), vec![vec![Value::Real(6.0)]]);
    assert_eq!(q(&db, "SELECT upper(s) || '!' FROM n WHERE id = 2"), vec![vec![t("BETA!")]]);
    assert_eq!(q(&db, "SELECT coalesce(s, 'none') FROM n WHERE id = 4"), vec![vec![t("none")]]);
    assert_eq!(
        q(&db, "SELECT CASE WHEN id < 3 THEN 'low' ELSE 'high' END FROM n ORDER BY id")
            .iter()
            .map(|r| r[0].clone())
            .collect::<Vec<_>>(),
        vec![t("low"), t("low"), t("high"), t("high")]
    );
    assert_eq!(q(&db, "SELECT json_extract(j, 'a.b.1') FROM n WHERE id = 1"), vec![vec![i(20)]]);
    assert_eq!(q(&db, "SELECT CAST(v AS INT) FROM n WHERE id = 2"), vec![vec![i(2)]]);
    assert_eq!(q(&db, "SELECT 1 + 2"), vec![vec![i(3)]]);
    // real column stores ints as reals
    assert_eq!(q(&db, "SELECT v FROM n WHERE id = 4"), vec![vec![Value::Real(4.0)]]);
}

#[test]
fn order_limit_offset_distinct() {
    let (_d, db) = open_tmp();
    setup_users(&db);
    for k in 0..20 {
        qp(
            &db,
            "INSERT INTO users (email, name, age) VALUES ($1, $2, $3)",
            &[t(&format!("u{k:02}@x.io")), t(&format!("n{}", k % 4)), i(20 + (k % 5))],
        );
    }
    let ids = |sql: &str| -> Vec<i64> { q(&db, sql).iter().map(|r| r[0].as_i64().unwrap()).collect() };
    assert_eq!(ids("SELECT id FROM users ORDER BY id DESC LIMIT 3"), vec![20, 19, 18]);
    assert_eq!(ids("SELECT id FROM users ORDER BY id LIMIT 3 OFFSET 5"), vec![6, 7, 8]);
    assert_eq!(ids("SELECT id FROM users WHERE id > 15 ORDER BY id DESC"), vec![20, 19, 18, 17, 16]);
    assert_eq!(ids("SELECT id FROM users ORDER BY age, id LIMIT 4"), vec![1, 6, 11, 16]);
    assert_eq!(ids("SELECT id FROM users ORDER BY age DESC, id DESC LIMIT 2"), vec![20, 15]);
    assert_eq!(q(&db, "SELECT DISTINCT name FROM users ORDER BY name").len(), 4);
    assert_eq!(q(&db, "SELECT DISTINCT age FROM users").len(), 5);
}

#[test]
fn max_min_pk_bound_fast_path() {
    let (_d, db) = open_tmp();
    q(
        &db,
        "CREATE TABLE things (id INTEGER PRIMARY KEY AUTOINCREMENT, v INT NOT NULL)",
    );
    for k in 1..=50_000 {
        qp(&db, "INSERT INTO things (v) VALUES ($1)", &[i(k % 100)]);
    }
    assert_eq!(q(&db, "SELECT max(id) FROM things"), vec![vec![i(50_000)]]);
    assert_eq!(q(&db, "SELECT min(id) FROM things"), vec![vec![i(1)]]);
    let plan = q(&db, "EXPLAIN SELECT max(id) FROM things");
    assert_eq!(plan[0][0], t("PK BOUND MAX(things.id)"));
    assert_eq!(q(&db, "SELECT max(id) FROM things WHERE id > 1000"), vec![vec![i(50_000)]]);
}

#[test]
fn aggregates_group_by_having() {
    let (_d, db) = open_tmp();
    setup_users(&db);
    for k in 0..30 {
        qp(
            &db,
            "INSERT INTO users (email, name, age) VALUES ($1, $2, $3)",
            &[t(&format!("u{k:02}@x.io")), t(&format!("grp{}", k % 3)), i(k)],
        );
    }
    assert_eq!(
        q(&db, "SELECT count(*), sum(age), min(age), max(age), avg(age) FROM users"),
        vec![vec![i(30), i(435), i(0), i(29), Value::Real(14.5)]]
    );
    let rows = q(
        &db,
        "SELECT name, count(*) AS n, sum(age) AS total FROM users GROUP BY name HAVING sum(age) > 140 ORDER BY total DESC",
    );
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0][0], t("grp2"));
    assert_eq!(rows[0][2], i(155));
    assert_eq!(rows[1][2], i(145));
    // empty aggregate
    assert_eq!(
        q(&db, "SELECT count(*), sum(age), max(age) FROM users WHERE id > 1000"),
        vec![vec![i(0), Value::Null, Value::Null]]
    );
    assert_eq!(q(&db, "SELECT count(DISTINCT name) FROM users"), vec![vec![i(3)]]);
    assert_eq!(q(&db, "SELECT name, count(*) FROM users WHERE id > 1000 GROUP BY name").len(), 0);
}

#[test]
fn joins_inner_left_and_alias() {
    let (_d, db) = open_tmp();
    q(&db, "CREATE TABLE authors (id INT PRIMARY KEY, name TEXT)");
    q(&db, "CREATE TABLE posts (id INT PRIMARY KEY AUTOINCREMENT, author_id INT, title TEXT)");
    q(&db, "CREATE INDEX posts_author ON posts (author_id)");
    q(&db, "INSERT INTO authors VALUES (1,'Ann'),(2,'Bob'),(3,'Cy')");
    q(&db, "INSERT INTO posts (author_id, title) VALUES (1,'a1'),(1,'a2'),(2,'b1')");
    let rows = q(
        &db,
        "SELECT a.name, p.title FROM authors a JOIN posts p ON p.author_id = a.id ORDER BY a.id, p.id",
    );
    assert_eq!(rows.len(), 3);
    assert_eq!(rows[0], vec![t("Ann"), t("a1")]);
    let rows = q(
        &db,
        "SELECT a.name, p.title FROM authors a LEFT JOIN posts p ON p.author_id = a.id ORDER BY a.id, p.id",
    );
    assert_eq!(rows.len(), 4);
    assert_eq!(rows[3], vec![t("Cy"), Value::Null]);
    let rows = q(
        &db,
        "SELECT a.name, count(p.id) AS n FROM authors a LEFT JOIN posts p ON p.author_id = a.id GROUP BY a.name ORDER BY n DESC, a.name",
    );
    assert_eq!(rows[0], vec![t("Ann"), i(2)]);
    assert_eq!(rows[2], vec![t("Cy"), i(0)]);
    // index is used on the join side
    let plan = q(
        &db,
        "EXPLAIN SELECT * FROM authors a JOIN posts p ON p.author_id = a.id",
    );
    assert!(format!("{:?}", plan).contains("posts_author"), "{plan:?}");
    // where on joined
    let rows = q(
        &db,
        "SELECT p.title FROM posts p JOIN authors a ON a.id = p.author_id WHERE a.name = 'Bob'",
    );
    assert_eq!(rows, vec![vec![t("b1")]]);
}

#[test]
fn update_delete_and_index_consistency() {
    let (_d, db) = open_tmp();
    setup_users(&db);
    for k in 0..50 {
        qp(
            &db,
            "INSERT INTO users (email, name, age) VALUES ($1, 'x', $2)",
            &[t(&format!("u{k:02}@x.io")), i(k % 10)],
        );
    }
    let r = db.execute_sql("UPDATE users SET age = age + 100 WHERE age = 3", &[]).unwrap();
    assert_eq!(r.rows_affected, 5);
    assert_eq!(q(&db, "SELECT count(*) FROM users WHERE age = 3"), vec![vec![i(0)]]);
    assert_eq!(q(&db, "SELECT count(*) FROM users WHERE age = 103"), vec![vec![i(5)]]);
    // update unique column
    q(&db, "UPDATE users SET email = 'new@x.io' WHERE id = 1");
    assert_eq!(q(&db, "SELECT id FROM users WHERE email = 'new@x.io'"), vec![vec![i(1)]]);
    assert_eq!(q(&db, "SELECT id FROM users WHERE email = 'u00@x.io'").len(), 0);
    let e = db
        .execute_sql("UPDATE users SET email = 'u02@x.io' WHERE id = 5", &[])
        .unwrap_err();
    assert!(matches!(e, Error::Constraint(_)));
    // update PK
    q(&db, "UPDATE users SET id = 1000 WHERE id = 2");
    assert_eq!(q(&db, "SELECT email FROM users WHERE id = 1000").len(), 1);
    assert_eq!(q(&db, "SELECT email FROM users WHERE id = 2").len(), 0);
    assert_eq!(q(&db, "SELECT count(*) FROM users"), vec![vec![i(50)]]);
    // delete
    let r = db.execute_sql("DELETE FROM users WHERE age < 3", &[]).unwrap();
    assert_eq!(r.rows_affected, 15);
    assert_eq!(q(&db, "SELECT count(*) FROM users"), vec![vec![i(35)]]);
    // index scan == full scan after all the churn
    let by_index = q(&db, "SELECT id FROM users WHERE age >= 5 AND age < 50 ORDER BY id");
    let by_scan = q(&db, "SELECT id FROM users WHERE age + 0 >= 5 AND age + 0 < 50 ORDER BY id");
    assert_eq!(by_index, by_scan);
    // deleted unique value can be reused
    q(&db, "INSERT INTO users (email) VALUES ('u00@x.io')");
    // RETURNING
    let r = db
        .execute_sql("UPDATE users SET name = 'ret' WHERE id = 5 RETURNING id, name", &[])
        .unwrap();
    assert_eq!(r.rows, vec![vec![i(5), t("ret")]]);
    let r = db.execute_sql("DELETE FROM users WHERE id = 5 RETURNING id", &[]).unwrap();
    assert_eq!(r.rows, vec![vec![i(5)]]);
}

#[test]
fn upsert_on_conflict() {
    let (_d, db) = open_tmp();
    q(&db, "CREATE TABLE kv (k TEXT PRIMARY KEY, v INT, hits INT DEFAULT 0)");
    q(&db, "INSERT INTO kv (k, v) VALUES ('a', 1)");
    q(&db, "INSERT INTO kv (k, v) VALUES ('a', 2) ON CONFLICT DO NOTHING");
    assert_eq!(q(&db, "SELECT v FROM kv WHERE k = 'a'"), vec![vec![i(1)]]);
    q(
        &db,
        "INSERT INTO kv (k, v) VALUES ('a', 5) ON CONFLICT (k) DO UPDATE SET v = excluded.v, hits = kv.hits + 1",
    );
    q(
        &db,
        "INSERT INTO kv (k, v) VALUES ('a', 7) ON CONFLICT (k) DO UPDATE SET v = excluded.v, hits = kv.hits + 1",
    );
    assert_eq!(q(&db, "SELECT v, hits FROM kv WHERE k = 'a'"), vec![vec![i(7), i(2)]]);
    // upsert on unique secondary index
    q(&db, "CREATE TABLE emails (id INT PRIMARY KEY, email TEXT UNIQUE, n INT)");
    q(&db, "INSERT INTO emails VALUES (1, 'x', 1)");
    q(&db, "INSERT INTO emails VALUES (2, 'x', 9) ON CONFLICT (email) DO UPDATE SET n = excluded.n");
    assert_eq!(q(&db, "SELECT id, n FROM emails"), vec![vec![i(1), i(9)]]);
}

#[test]
fn alter_table_and_drop() {
    let (_d, db) = open_tmp();
    q(&db, "CREATE TABLE a (id INT PRIMARY KEY, x TEXT)");
    q(&db, "INSERT INTO a VALUES (1,'one')");
    q(&db, "ALTER TABLE a ADD COLUMN y INT DEFAULT 7");
    assert_eq!(q(&db, "SELECT id, x, y FROM a"), vec![vec![i(1), t("one"), i(7)]]);
    q(&db, "INSERT INTO a (id, x) VALUES (2,'two')");
    assert_eq!(q(&db, "SELECT y FROM a WHERE id = 2"), vec![vec![i(7)]]);
    q(&db, "ALTER TABLE a RENAME COLUMN x TO label");
    assert_eq!(q(&db, "SELECT label FROM a WHERE id = 1"), vec![vec![t("one")]]);
    q(&db, "ALTER TABLE a DROP COLUMN y");
    assert!(db.execute_sql("SELECT y FROM a", &[]).is_err());
    q(&db, "ALTER TABLE a RENAME TO b");
    assert_eq!(q(&db, "SELECT count(*) FROM b"), vec![vec![i(2)]]);
    q(&db, "CREATE UNIQUE INDEX b_label ON b (label)");
    assert!(db.execute_sql("INSERT INTO b (id, label) VALUES (9, 'one')", &[]).is_err());
    q(&db, "DROP INDEX b_label");
    q(&db, "INSERT INTO b (id, label) VALUES (9, 'one')");
    // creating a unique index over duplicates must fail
    assert!(db.execute_sql("CREATE UNIQUE INDEX b_label2 ON b (label)", &[]).is_err());
    q(&db, "DROP TABLE b");
    assert!(db.execute_sql("SELECT * FROM b", &[]).is_err());
    q(&db, "DROP TABLE IF EXISTS b");
    // drop + recreate gives a clean table
    q(&db, "CREATE TABLE b (id INT PRIMARY KEY)");
    assert_eq!(q(&db, "SELECT count(*) FROM b"), vec![vec![i(0)]]);
}

#[test]
fn transactions_commit_rollback_conflict() {
    let (_d, db) = open_tmp();
    q(&db, "CREATE TABLE acc (id INT PRIMARY KEY, bal INT)");
    q(&db, "INSERT INTO acc VALUES (1, 100), (2, 100)");
    // rollback leaves no trace
    let mut tx = db.begin(Isolation::Snapshot);
    tx.execute_sql("UPDATE acc SET bal = 0", &[]).unwrap();
    assert_eq!(tx.execute_sql("SELECT sum(bal) FROM acc", &[]).unwrap().rows, vec![vec![i(0)]]);
    tx.rollback();
    assert_eq!(q(&db, "SELECT sum(bal) FROM acc"), vec![vec![i(200)]]);
    // conflicting transactions
    let mut a = db.begin(Isolation::Snapshot);
    let mut b = db.begin(Isolation::Snapshot);
    a.execute_sql("UPDATE acc SET bal = bal - 10 WHERE id = 1", &[]).unwrap();
    b.execute_sql("UPDATE acc SET bal = bal - 20 WHERE id = 1", &[]).unwrap();
    a.commit().unwrap();
    assert!(matches!(b.commit(), Err(Error::Conflict(_))));
    assert_eq!(q(&db, "SELECT bal FROM acc WHERE id = 1"), vec![vec![i(90)]]);
    // concurrent unique insert -> one wins
    q(&db, "CREATE TABLE uq (id INT PRIMARY KEY, code TEXT UNIQUE)");
    let mut a = db.begin(Isolation::Snapshot);
    let mut b = db.begin(Isolation::Snapshot);
    a.execute_sql("INSERT INTO uq VALUES (1, 'same')", &[]).unwrap();
    b.execute_sql("INSERT INTO uq VALUES (2, 'same')", &[]).unwrap();
    a.commit().unwrap();
    assert!(matches!(b.commit(), Err(Error::Conflict(_))));
    // snapshot reads are repeatable inside a tx
    let mut r = db.begin(Isolation::Snapshot);
    let before = r.execute_sql("SELECT count(*) FROM uq", &[]).unwrap().rows;
    q(&db, "INSERT INTO uq VALUES (3, 'other')");
    assert_eq!(r.execute_sql("SELECT count(*) FROM uq", &[]).unwrap().rows, before);
    // DDL inside a transaction rolls back too
    let mut d = db.begin(Isolation::Snapshot);
    d.execute_sql("CREATE TABLE temp_t (id INT PRIMARY KEY)", &[]).unwrap();
    d.rollback();
    assert!(db.execute_sql("SELECT * FROM temp_t", &[]).is_err());
}

#[test]
fn persistence_across_reopen() {
    let d = tempfile::tempdir().unwrap();
    let path = d.path().join("data.wave");
    {
        let db = Db::open(&path, Options { durability: Durability::Sync, ..Default::default() }).unwrap();
        setup_users(&db);
        for k in 0..200 {
            qp(&db, "INSERT INTO users (email, age) VALUES ($1, $2)", &[t(&format!("p{k}@x.io")), i(k % 7)]);
        }
        q(&db, "DELETE FROM users WHERE id <= 10");
    }
    // opening again after the first Db handle is dropped
    let db = Db::open(&path, Options::default()).unwrap();
    assert_eq!(q(&db, "SELECT count(*) FROM users"), vec![vec![i(190)]]);
    assert_eq!(q(&db, "SELECT count(*) FROM users WHERE age = 3").len(), 1);
    // autoincrement continues after restart
    let r = db.execute_sql("INSERT INTO users (email) VALUES ('after@x.io')", &[]).unwrap();
    assert_eq!(r.last_insert_id, Some(i(201)));
    // unique index survives
    assert!(db.execute_sql("INSERT INTO users (email) VALUES ('p50@x.io')", &[]).is_err());
    assert_eq!(db.tables().unwrap().len(), 1);
}

#[test]
fn read_only_autocommit_and_tables_do_not_count_as_rollbacks() {
    let (_d, db) = open_tmp();
    setup_users(&db);
    for _ in 0..50 {
        q(&db, "SELECT count(*) FROM users");
    }
    assert_eq!(db.tables().unwrap().len(), 1);
    let s = db.engine().stats();
    assert_eq!(s.rollbacks, 0, "read-only work must commit, not rollback on drop");
    assert!(s.commits >= 51, "autocommit SELECTs and tables() should commit");
}

#[test]
fn concurrent_inserts_with_autoincrement_have_unique_ids() {
    let (_d, db) = open_tmp();
    q(&db, "CREATE TABLE ev (id INT PRIMARY KEY AUTOINCREMENT, w INT, n INT)");
    let db = Arc::new(db);
    let hs: Vec<_> = (0..8)
        .map(|w| {
            let db = db.clone();
            thread::spawn(move || {
                for n in 0..250 {
                    db.execute_sql("INSERT INTO ev (w, n) VALUES ($1, $2)", &[i(w), i(n)]).unwrap();
                }
            })
        })
        .collect();
    for h in hs {
        h.join().unwrap();
    }
    assert_eq!(q(&db, "SELECT count(*), count(DISTINCT id) FROM ev"), vec![vec![i(2000), i(2000)]]);
    assert_eq!(db.engine().stats().conflicts, 0, "autoincrement must not cause conflicts");
}

#[test]
fn concurrent_counter_updates_serialize_via_retry() {
    let (_d, db) = open_tmp();
    q(&db, "CREATE TABLE c (id INT PRIMARY KEY, n INT)");
    q(&db, "INSERT INTO c VALUES (1, 0)");
    let db = Arc::new(db);
    let hs: Vec<_> = (0..6)
        .map(|_| {
            let db = db.clone();
            thread::spawn(move || {
                for _ in 0..100 {
                    db.execute_sql("UPDATE c SET n = n + 1 WHERE id = 1", &[]).unwrap();
                }
            })
        })
        .collect();
    for h in hs {
        h.join().unwrap();
    }
    assert_eq!(q(&db, "SELECT n FROM c"), vec![vec![i(600)]]);
    assert_eq!(db.engine().stats().conflicts, 0, "commutative integer updates should not OCC-conflict");
}

/// Randomised differential test: SQL table vs an in-memory model, with a secondary index.
#[test]
fn model_based_random_ops() {
    let (_d, db) = open_tmp();
    q(&db, "CREATE TABLE m (id INT PRIMARY KEY, grp INT, tag TEXT UNIQUE)");
    q(&db, "CREATE INDEX m_grp ON m (grp)");
    let mut model: std::collections::BTreeMap<i64, (i64, Option<String>)> = Default::default();
    let mut seed = 0x9e3779b97f4a7c15u64;
    let mut rnd = move |n: u64| {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        seed % n
    };
    for step in 0..3000 {
        let id = rnd(120) as i64;
        match rnd(4) {
            0 | 1 => {
                let grp = rnd(8) as i64;
                let tag = format!("t{}", rnd(150));
                let tag_taken = model.iter().any(|(k, v)| v.1.as_deref() == Some(&tag) && *k != id);
                let r = db.execute_sql(
                    "INSERT INTO m VALUES ($1, $2, $3) ON CONFLICT (id) DO UPDATE SET grp = excluded.grp, tag = excluded.tag",
                    &[i(id), i(grp), t(&tag)],
                );
                if tag_taken {
                    // unique violation on tag (either via insert or via the upsert update)
                    assert!(r.is_err(), "step {step}: expected unique violation");
                } else {
                    r.unwrap();
                    model.insert(id, (grp, Some(tag)));
                }
            }
            2 => {
                db.execute_sql("DELETE FROM m WHERE id = $1", &[i(id)]).unwrap();
                model.remove(&id);
            }
            _ => {
                let grp = rnd(8) as i64;
                let r = db.execute_sql("UPDATE m SET grp = $1 WHERE id = $2", &[i(grp), i(id)]).unwrap();
                if let Some(e) = model.get_mut(&id) {
                    e.0 = grp;
                    assert_eq!(r.rows_affected, 1);
                } else {
                    assert_eq!(r.rows_affected, 0);
                }
            }
        }
        if step % 250 == 0 {
            verify_model(&db, &model);
        }
    }
    verify_model(&db, &model);
}

fn verify_model(db: &Db, model: &std::collections::BTreeMap<i64, (i64, Option<String>)>) {
    let rows = q(db, "SELECT id, grp, tag FROM m ORDER BY id");
    let got: Vec<(i64, i64, String)> = rows
        .iter()
        .map(|r| {
            (
                r[0].as_i64().unwrap(),
                r[1].as_i64().unwrap(),
                match &r[2] {
                    Value::Text(s) => s.clone(),
                    _ => panic!(),
                },
            )
        })
        .collect();
    let want: Vec<(i64, i64, String)> = model.iter().map(|(k, v)| (*k, v.0, v.1.clone().unwrap())).collect();
    assert_eq!(got, want);
    for g in 0..8 {
        let via_index = q(db, &format!("SELECT id FROM m WHERE grp = {g} ORDER BY id"));
        let expected: Vec<Vec<Value>> = model.iter().filter(|(_, v)| v.0 == g).map(|(k, _)| vec![i(*k)]).collect();
        assert_eq!(via_index, expected, "index lookup grp={g}");
    }
    for (k, v) in model.iter().take(10) {
        let tag = v.1.clone().unwrap();
        assert_eq!(q(db, &format!("SELECT id FROM m WHERE tag = '{tag}'")), vec![vec![i(*k)]]);
    }
}

#[test]
fn composite_primary_key_and_composite_index() {
    let (_d, db) = open_tmp();
    q(&db, "CREATE TABLE ev (tenant INT, seq INT, kind TEXT, PRIMARY KEY (tenant, seq))");
    q(&db, "CREATE INDEX ev_kind ON ev (tenant, kind)");
    for tnt in 0..5 {
        for s in 0..40 {
            qp(&db, "INSERT INTO ev VALUES ($1,$2,$3)", &[i(tnt), i(s), t(if s % 2 == 0 { "even" } else { "odd" })]);
        }
    }
    let plan = format!("{:?}", q(&db, "EXPLAIN SELECT * FROM ev WHERE tenant = 2 AND seq > 10"));
    assert!(plan.contains("PRIMARY KEY"), "{plan}");
    let plan = format!("{:?}", q(&db, "EXPLAIN SELECT * FROM ev WHERE tenant = 2 AND kind = 'odd'"));
    assert!(plan.contains("ev_kind (tenant=?, kind=?)"), "{plan}");
    assert_eq!(q(&db, "SELECT count(*) FROM ev WHERE tenant = 2 AND seq >= 10 AND seq < 20"), vec![vec![i(10)]]);
    assert_eq!(q(&db, "SELECT count(*) FROM ev WHERE tenant = 3 AND kind = 'odd'"), vec![vec![i(20)]]);
    assert_eq!(q(&db, "SELECT seq FROM ev WHERE tenant = 1 ORDER BY seq DESC LIMIT 2"), vec![vec![i(39)], vec![i(38)]]);
    assert!(db.execute_sql("INSERT INTO ev VALUES (1, 1, 'dup')", &[]).is_err());
}

#[test]
fn text_and_float_keys_order_correctly_in_ranges() {
    let (_d, db) = open_tmp();
    q(&db, "CREATE TABLE f (id INT PRIMARY KEY, x REAL, s TEXT)");
    q(&db, "CREATE INDEX f_x ON f (x)");
    q(&db, "CREATE INDEX f_s ON f (s)");
    let xs = [-100.5, -1.0, -0.25, 0.0, 0.25, 1.0, 2.5, 1e6];
    for (k, x) in xs.iter().enumerate() {
        qp(&db, "INSERT INTO f VALUES ($1,$2,$3)", &[i(k as i64), Value::Real(*x), t(&format!("s{:03}", k * 7 % 8))]);
    }
    let r = q(&db, "SELECT id FROM f WHERE x >= -1 AND x <= 1 ORDER BY x");
    assert_eq!(r, vec![vec![i(1)], vec![i(2)], vec![i(3)], vec![i(4)], vec![i(5)]]);
    let r = q(&db, "SELECT id FROM f WHERE x < 0 ORDER BY x DESC");
    assert_eq!(r, vec![vec![i(2)], vec![i(1)], vec![i(0)]]);
    let r = q(&db, "SELECT s FROM f WHERE s > 's003' ORDER BY s");
    assert_eq!(r.len(), 4);
    assert_eq!(q(&db, "SELECT id FROM f WHERE x > 0.25 AND x < 1.5"), vec![vec![i(5)]]);
}

#[test]
fn large_dataset_queries() {
    let (_d, db) = open_tmp();
    q(&db, "CREATE TABLE big (id INT PRIMARY KEY AUTOINCREMENT, bucket INT, email TEXT UNIQUE, score REAL, payload TEXT)");
    q(&db, "CREATE INDEX big_bucket ON big (bucket)");
    let n = 60_000;
    // batched multi-row inserts inside one txn per batch
    for chunk in 0..(n / 1000) {
        let mut tx = db.begin(Isolation::Snapshot);
        let mut sql = String::from("INSERT INTO big (bucket, email, score, payload) VALUES ");
        for k in 0..1000 {
            let id = chunk * 1000 + k;
            if k > 0 {
                sql.push(',');
            }
            sql.push_str(&format!("({}, 'user{}@example.com', {}.5, 'payload-{}')", id % 100, id, id % 1000, id));
        }
        tx.execute_sql(&sql, &[]).unwrap();
        tx.commit().unwrap();
    }
    assert_eq!(q(&db, "SELECT count(*) FROM big"), vec![vec![i(n as i64)]]);
    // point lookups via PK and unique index
    assert_eq!(q(&db, "SELECT email FROM big WHERE id = 31337"), vec![vec![t("user31336@example.com")]]);
    assert_eq!(q(&db, "SELECT id FROM big WHERE email = 'user4242@example.com'"), vec![vec![i(4243)]]);
    // secondary index
    assert_eq!(q(&db, "SELECT count(*) FROM big WHERE bucket = 42"), vec![vec![i(600)]]);
    assert_eq!(q(&db, "SELECT count(*) FROM big WHERE bucket IN (1, 2, 3)"), vec![vec![i(1800)]]);
    // range
    assert_eq!(q(&db, "SELECT count(*) FROM big WHERE id >= 100 AND id < 200"), vec![vec![i(100)]]);
    // ordering + limit uses ordered access path
    let top = q(&db, "SELECT id FROM big ORDER BY id DESC LIMIT 3");
    assert_eq!(top, vec![vec![i(n as i64)], vec![i(n as i64 - 1)], vec![i(n as i64 - 2)]]);
    // aggregation over everything
    let g = q(&db, "SELECT bucket, count(*), min(id), max(id) FROM big GROUP BY bucket ORDER BY bucket LIMIT 2");
    assert_eq!(g[0], vec![i(0), i(600), i(1), i(59901)]);
    // bulk update + delete and verify
    let r = db.execute_sql("UPDATE big SET score = 0 WHERE bucket = 7", &[]).unwrap();
    assert_eq!(r.rows_affected, 600);
    let r = db.execute_sql("DELETE FROM big WHERE bucket >= 90", &[]).unwrap();
    assert_eq!(r.rows_affected, 6000);
    assert_eq!(q(&db, "SELECT count(*) FROM big"), vec![vec![i(54_000)]]);
    assert_eq!(q(&db, "SELECT count(*) FROM big WHERE bucket >= 90"), vec![vec![i(0)]]);
    assert_eq!(q(&db, "SELECT sum(score) FROM big WHERE bucket = 7"), vec![vec![Value::Real(0.0)]]);
    db.engine().compact().unwrap();
    assert_eq!(q(&db, "SELECT count(*) FROM big"), vec![vec![i(54_000)]]);
    let freed = db.engine().vacuum().unwrap();
    assert!(freed > 0);
    assert_eq!(q(&db, "SELECT count(*) FROM big"), vec![vec![i(54_000)]]);
}

#[test]
fn subqueries_in_where_from_and_scalar() {
    let (_d, db) = open_tmp();
    q(&db, "CREATE TABLE dept (id INT PRIMARY KEY, name TEXT)");
    q(&db, "CREATE TABLE emp (id INT PRIMARY KEY, dept_id INT, name TEXT)");
    q(
        &db,
        "INSERT INTO dept VALUES (1,'eng'),(2,'sales'),(3,'ops'),(4,'empty')",
    );
    q(
        &db,
        "INSERT INTO emp VALUES (1,1,'a'),(2,1,'b'),(3,2,'c'),(4,3,'d'),(5,99,'orphan')",
    );
    // IN (SELECT …)
    assert_eq!(
        q(
            &db,
            "SELECT name FROM emp WHERE dept_id IN (SELECT id FROM dept WHERE name IN ('eng','sales')) ORDER BY id"
        ),
        vec![vec![t("a")], vec![t("b")], vec![t("c")]]
    );
    // NOT IN empty subquery -> true for all non-null lhs
    assert_eq!(
        q(
            &db,
            "SELECT count(*) FROM emp WHERE dept_id NOT IN (SELECT id FROM dept WHERE name = 'empty')"
        ),
        vec![vec![i(5)]]
    );
    // scalar subquery
    assert_eq!(
        q(&db, "SELECT (SELECT count(*) FROM emp WHERE dept_id = 1)"),
        vec![vec![i(2)]]
    );
    // FROM subquery
    assert_eq!(
        q(
            &db,
            "SELECT n FROM (SELECT name AS n FROM emp WHERE dept_id = 2) AS x ORDER BY n"
        ),
        vec![vec![t("c")]]
    );
}

#[test]
fn with_cte_non_recursive() {
    let (_d, db) = open_tmp();
    q(&db, "CREATE TABLE t (id INT PRIMARY KEY, v INT)");
    q(&db, "INSERT INTO t VALUES (1,10),(2,20),(3,30)");
    assert_eq!(
        q(
            &db,
            "WITH big AS (SELECT * FROM t WHERE v >= 20) SELECT sum(v) FROM big"
        ),
        vec![vec![i(50)]]
    );
    assert_eq!(
        q(
            &db,
            "WITH a AS (SELECT id FROM t WHERE v < 30), b AS (SELECT count(*) AS n FROM a) SELECT n FROM b"
        ),
        vec![vec![i(2)]]
    );
}

#[test]
fn subquery_null_and_empty_edges() {
    let (_d, db) = open_tmp();
    q(&db, "CREATE TABLE p (id INT PRIMARY KEY, tag TEXT)");
    q(&db, "INSERT INTO p VALUES (1,'x'),(2,NULL)");
    // lhs NULL -> IN subquery is unknown
    assert_eq!(
        q(&db, "SELECT id FROM p WHERE tag IN (SELECT 'x')"),
        vec![vec![i(1)]]
    );
    assert_eq!(q(&db, "SELECT count(*) FROM p WHERE tag IN (SELECT 'y')"), vec![vec![i(0)]]);
    let rows = q(&db, "SELECT (tag = 'nope') IS NULL FROM p WHERE id = 2");
    assert_eq!(rows, vec![vec![Value::Bool(true)]]);
    // empty scalar subquery -> NULL
    assert_eq!(
        q(&db, "SELECT (SELECT id FROM p WHERE id > 100) IS NULL"),
        vec![vec![Value::Bool(true)]]
    );
}

#[test]
fn correlated_subquery_is_rejected() {
    let (_d, db) = open_tmp();
    q(&db, "CREATE TABLE a (id INT PRIMARY KEY, g INT)");
    q(&db, "CREATE TABLE b (id INT PRIMARY KEY, g INT)");
    q(&db, "INSERT INTO a VALUES (1,1),(2,2)");
    q(&db, "INSERT INTO b VALUES (1,1),(2,9)");
    let e = db
        .execute_sql(
            "SELECT id FROM a WHERE g IN (SELECT g FROM b WHERE b.id = a.id)",
            &[],
        )
        .unwrap_err();
    assert!(e.to_string().contains("correlated"), "{e}");
}

#[test]
fn create_view_select_and_drop() {
    let (_d, db) = open_tmp();
    q(&db, "CREATE TABLE v_users (id INT PRIMARY KEY, name TEXT)");
    q(&db, "INSERT INTO v_users VALUES (1, 'Ada'), (2, 'Bob')");
    q(
        &db,
        "CREATE VIEW active_users AS SELECT id, name FROM v_users WHERE id > 0",
    );
    assert_eq!(
        q(&db, "SELECT name FROM active_users ORDER BY id"),
        vec![vec![t("Ada")], vec![t("Bob")]]
    );
    q(&db, "DROP VIEW active_users");
    assert!(db.execute_sql("SELECT * FROM active_users", &[]).is_err());
}

#[test]
fn pk_increment_does_not_overwrite_destination_row() {
    let (_d, db) = open_tmp();
    q(&db, "CREATE TABLE t (id INT PRIMARY KEY, v INT)");
    q(&db, "INSERT INTO t VALUES (1, 10), (2, 20)");
    let r = db.execute_sql("UPDATE t SET id = id + 1 WHERE id = 1", &[]);
    assert!(r.is_err(), "expected unique violation when PK moves onto existing row");
    assert_eq!(
        q(&db, "SELECT id, v FROM t ORDER BY id"),
        vec![vec![i(1), i(10)], vec![i(2), i(20)]]
    );
}

#[test]
fn view_expansion_cycle_is_rejected() {
    let (_d, db) = open_tmp();
    q(&db, "CREATE VIEW v AS SELECT * FROM v");
    let e = db.execute_sql("SELECT * FROM v", &[]).unwrap_err();
    assert!(e.to_string().to_lowercase().contains("cycle"), "{e}");
}

#[test]
fn begin_read_only_is_rejected() {
    let (_d, db) = open_tmp();
    let e = db.execute_sql("BEGIN READ ONLY", &[]).unwrap_err();
    assert!(e.to_string().contains("READ ONLY"), "{e}");
}

#[test]
fn commutative_conditional_updates_in_one_transaction_are_sequential() {
    let (_d, db) = open_tmp();
    q(&db, "CREATE TABLE inv (id INT PRIMARY KEY, stock INT)");
    q(&db, "INSERT INTO inv VALUES (1, 5)");
    let mut tx = db.begin(Isolation::Snapshot);
    tx.execute_sql("UPDATE inv SET stock = stock - 4 WHERE id = 1 AND stock >= 4", &[])
        .unwrap();
    tx.execute_sql("UPDATE inv SET stock = stock - 4 WHERE id = 1 AND stock >= 4", &[])
        .unwrap();
    assert!(tx.commit().is_err());
    assert_eq!(q(&db, "SELECT stock FROM inv"), vec![vec![i(5)]]);
}

#[test]
fn guarded_increment_conflicts_when_predicate_fails_at_commit() {
    let (_d, db) = open_tmp();
    q(&db, "CREATE TABLE inv (id INT PRIMARY KEY, stock INT)");
    q(&db, "INSERT INTO inv VALUES (1, 5)");
    let db = Arc::new(db);
    let sql = "UPDATE inv SET stock = stock - 4 WHERE id = 1 AND stock >= 4";
    let h1 = thread::spawn({ let db = db.clone(); move || db.execute_sql(sql, &[]) });
    let h2 = thread::spawn({ let db = db.clone(); move || db.execute_sql(sql, &[]) });
    let _ = h1.join().unwrap();
    let _ = h2.join().unwrap();
    let stock = q(&db, "SELECT stock FROM inv")[0][0].as_i64().unwrap();
    assert!(stock >= 0, "stock must not go negative");
    assert_eq!(stock, 1, "only one guarded decrement of 4 from 5 should apply");
}

#[test]
fn foreign_key_rejects_orphan_insert() {
    let (_d, db) = open_tmp();
    q(&db, "CREATE TABLE fk_parent (id INT PRIMARY KEY)");
    q(
        &db,
        "CREATE TABLE fk_child (id INT PRIMARY KEY, parent_id INT, FOREIGN KEY (parent_id) REFERENCES fk_parent(id))",
    );
    q(&db, "INSERT INTO fk_parent VALUES (1)");
    q(&db, "INSERT INTO fk_child VALUES (1, 1)");
    let e = db
        .execute_sql("INSERT INTO fk_child VALUES (2, 99)", &[])
        .unwrap_err();
    assert!(matches!(e, Error::Constraint(_)), "{e}");
}

#[test]
fn union_distinct_and_all() {
    let (_d, db) = open_tmp();
    q(&db, "CREATE TABLE u (id INT PRIMARY KEY, tag TEXT)");
    q(&db, "INSERT INTO u VALUES (1,'a'),(2,'b')");
    assert_eq!(
        q(&db, "SELECT tag FROM u UNION SELECT tag FROM u"),
        vec![vec![t("a")], vec![t("b")]]
    );
    assert_eq!(
        q(&db, "SELECT tag FROM u UNION ALL SELECT tag FROM u").len(),
        4
    );
}

#[test]
fn window_row_number() {
    let (_d, db) = open_tmp();
    q(&db, "CREATE TABLE w (id INT PRIMARY KEY, g INT)");
    q(&db, "INSERT INTO w VALUES (1,1),(2,1),(3,2)");
    let rows = q(
        &db,
        "SELECT row_number() OVER (PARTITION BY g ORDER BY id) AS rn FROM w ORDER BY id",
    );
    assert_eq!(rows, vec![vec![i(1)], vec![i(2)], vec![i(1)]]);
}

#[test]
fn sql_begin_commit_batch() {
    let (_d, db) = open_tmp();
    q(&db, "CREATE TABLE tx_t (id INT PRIMARY KEY, n INT)");
    db.execute_sql(
        "BEGIN; INSERT INTO tx_t VALUES (1, 10); COMMIT",
        &[],
    )
    .unwrap();
    assert_eq!(q(&db, "SELECT n FROM tx_t WHERE id = 1"), vec![vec![i(10)]]);
    db.execute_sql("BEGIN; INSERT INTO tx_t VALUES (2, 20); ROLLBACK", &[])
        .unwrap();
    assert_eq!(q(&db, "SELECT count(*) FROM tx_t"), vec![vec![i(1)]]);
}

#[test]
fn timestamps_uuid_json_defaults() {
    let (_d, db) = open_tmp();
    q(&db, "CREATE TABLE doc (id UUID PRIMARY KEY DEFAULT uuid7(), meta JSON, at TIMESTAMP DEFAULT now(), blob BLOB)");
    q(&db, "INSERT INTO doc (meta) VALUES ('{\"k\": [1,2,3]}')");
    q(&db, "INSERT INTO doc (id, at) VALUES ('0190c1c2-aaaa-7bbb-8ccc-0123456789ab', '2024-01-01T00:00:00Z')");
    let r = q(&db, "SELECT id, at FROM doc ORDER BY at");
    assert_eq!(r.len(), 2);
    assert_eq!(r[0][1], i(1704067200000));
    match &r[1][0] {
        Value::Text(s) => assert_eq!(s.len(), 36),
        _ => panic!(),
    }
    assert!(db.execute_sql("INSERT INTO doc (id) VALUES ('not-a-uuid')", &[]).is_err());
    let r = q(&db, "SELECT json_extract(meta, 'k.1') FROM doc WHERE meta IS NOT NULL");
    assert_eq!(r, vec![vec![i(2)]]);
}

#[test]
fn sql_rejects_multi_statement_scripts() {
    let (_d, db) = open_tmp();
    q(&db, "CREATE TABLE m (id INT PRIMARY KEY, n INT)");
    assert!(db
        .execute_sql("INSERT INTO m VALUES (1, 1); DELETE FROM m", &[])
        .is_err());
    assert_eq!(q(&db, "SELECT count(*) FROM m"), vec![vec![i(0)]]);
}

#[test]
fn sql_begin_does_not_span_calls() {
    let (_d, db) = open_tmp();
    q(&db, "CREATE TABLE m (id INT PRIMARY KEY, n INT)");
    assert!(db.execute_sql("BEGIN", &[]).is_err());
    db.execute_sql("INSERT INTO m VALUES (1, 10)", &[]).unwrap();
    assert!(db.execute_sql("ROLLBACK", &[]).is_err());
    assert_eq!(q(&db, "SELECT n FROM m WHERE id = 1"), vec![vec![i(10)]]);
}

#[test]
fn sql_incomparable_ne_is_false() {
    let (_d, db) = open_tmp();
    q(&db, "CREATE TABLE t (id INT PRIMARY KEY)");
    q(&db, "INSERT INTO t VALUES (1),(2)");
    assert_eq!(
        q(&db, "SELECT id FROM t WHERE id != 'x'"),
        Vec::<Vec<Value>>::new()
    );
    db.execute_sql("DELETE FROM t WHERE id != 'x'", &[]).unwrap();
    assert_eq!(q(&db, "SELECT count(*) FROM t"), vec![vec![i(2)]]);
}

#[test]
fn sql_int64_extremes_error() {
    let (_d, db) = open_tmp();
    let min = i64::MIN;
    assert!(db.execute_sql("SELECT abs($1)", &[Value::Int(min)]).is_err());
    assert!(db.execute_sql("SELECT -$1", &[Value::Int(min)]).is_err());
    assert!(db
        .execute_sql("SELECT $1 / -1", &[Value::Int(min)])
        .is_err());
}
