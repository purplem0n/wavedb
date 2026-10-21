use std::ops::Bound;
use std::sync::Arc;
use std::thread;
use wave_core::kv::{prefix_range, Engine, Isolation, Options};
use wave_core::{Durability, Error};

fn tmp() -> tempfile::TempDir {
    tempfile::tempdir().unwrap()
}

fn open(dir: &std::path::Path) -> Arc<Engine> {
    Engine::open(
        dir,
        Options {
            durability: Durability::Async,
            cache_bytes: 8 << 20,
            temporary: false,
        },
    )
    .unwrap()
}

fn put(e: &Arc<Engine>, k: &str, v: &str) {
    let mut t = e.begin(Isolation::Snapshot);
    t.put(k.as_bytes(), v.as_bytes()).unwrap();
    t.commit().unwrap();
}

fn get(e: &Arc<Engine>, k: &str) -> Option<String> {
    let mut t = e.begin(Isolation::Snapshot);
    t.get(k.as_bytes())
        .unwrap()
        .map(|v| String::from_utf8(v).unwrap())
}

#[test]
fn basic_put_get_delete() {
    let d = tmp();
    let e = open(d.path());
    assert_eq!(get(&e, "a"), None);
    put(&e, "a", "1");
    assert_eq!(get(&e, "a").as_deref(), Some("1"));
    put(&e, "a", "2");
    assert_eq!(get(&e, "a").as_deref(), Some("2"));
    let mut t = e.begin(Isolation::Snapshot);
    t.delete(b"a").unwrap();
    t.commit().unwrap();
    assert_eq!(get(&e, "a"), None);
}

#[test]
fn read_your_writes_and_rollback() {
    let d = tmp();
    let e = open(d.path());
    let mut t = e.begin(Isolation::Snapshot);
    t.put(b"k", b"v").unwrap();
    assert_eq!(t.get(b"k").unwrap().as_deref(), Some(&b"v"[..]));
    t.rollback();
    assert_eq!(get(&e, "k"), None);
}

#[test]
fn snapshot_isolation_repeatable_read() {
    let d = tmp();
    let e = open(d.path());
    put(&e, "x", "old");
    let mut reader = e.begin(Isolation::Snapshot);
    put(&e, "x", "new");
    put(&e, "y", "added");
    assert_eq!(reader.get(b"x").unwrap().as_deref(), Some(&b"old"[..]));
    assert_eq!(reader.get(b"y").unwrap(), None);
    // new txn sees the latest
    assert_eq!(get(&e, "x").as_deref(), Some("new"));
}

#[test]
fn write_write_conflict_first_committer_wins() {
    let d = tmp();
    let e = open(d.path());
    put(&e, "c", "0");
    let mut a = e.begin(Isolation::Snapshot);
    let mut b = e.begin(Isolation::Snapshot);
    a.get(b"c").unwrap();
    b.get(b"c").unwrap();
    a.put(b"c", b"a").unwrap();
    b.put(b"c", b"b").unwrap();
    a.commit().unwrap();
    match b.commit() {
        Err(Error::Conflict(_)) => {}
        other => panic!("expected conflict, got {other:?}"),
    }
    assert_eq!(get(&e, "c").as_deref(), Some("a"));
    assert_eq!(e.stats().conflicts, 1);
}

#[test]
fn disjoint_writes_do_not_conflict() {
    let d = tmp();
    let e = open(d.path());
    let mut a = e.begin(Isolation::Snapshot);
    let mut b = e.begin(Isolation::Snapshot);
    a.put(b"a", b"1").unwrap();
    b.put(b"b", b"2").unwrap();
    a.commit().unwrap();
    b.commit().unwrap();
    assert_eq!(get(&e, "a").as_deref(), Some("1"));
    assert_eq!(get(&e, "b").as_deref(), Some("2"));
}

#[test]
fn write_skew_allowed_in_snapshot_rejected_in_serializable() {
    for iso in [Isolation::Snapshot, Isolation::Serializable] {
        let d = tmp();
        let e = open(d.path());
        put(&e, "oncall:alice", "1");
        put(&e, "oncall:bob", "1");
        // each txn reads both, then turns *its own* person off
        let mut t1 = e.begin(iso);
        let mut t2 = e.begin(iso);
        t1.get(b"oncall:alice").unwrap();
        t1.get(b"oncall:bob").unwrap();
        t2.get(b"oncall:alice").unwrap();
        t2.get(b"oncall:bob").unwrap();
        t1.put(b"oncall:alice", b"0").unwrap();
        t2.put(b"oncall:bob", b"0").unwrap();
        t1.commit().unwrap();
        let r2 = t2.commit();
        match iso {
            Isolation::Snapshot => assert!(r2.is_ok(), "SI permits write skew"),
            Isolation::Serializable => {
                assert!(matches!(r2, Err(Error::Conflict(_))), "serializable must abort")
            }
        }
    }
}

#[test]
fn serializable_detects_phantom_in_range() {
    let d = tmp();
    let e = open(d.path());
    put(&e, "p:1", "x");
    let mut t1 = e.begin(Isolation::Serializable);
    let (lo, hi) = prefix_range(b"p:");
    let n = t1.scan(lo, hi, false).unwrap().count();
    assert_eq!(n, 1);
    t1.put(b"other", b"y").unwrap();
    put(&e, "p:2", "phantom");
    assert!(matches!(t1.commit(), Err(Error::Conflict(_))));
}

#[test]
fn scans_forward_reverse_with_buffer_merge() {
    let d = tmp();
    let e = open(d.path());
    for i in 0..20 {
        put(&e, &format!("k{i:02}"), &format!("v{i}"));
    }
    // overwrite and delete some to create versions
    put(&e, "k05", "v5b");
    let mut t = e.begin(Isolation::Snapshot);
    t.delete(b"k06").unwrap();
    t.commit().unwrap();

    let mut t = e.begin(Isolation::Snapshot);
    t.put(b"k07", b"buffered").unwrap();
    t.put(b"k99", b"tail").unwrap();
    t.delete(b"k08").unwrap();
    let fwd: Vec<(String, String)> = t
        .scan(Bound::Unbounded, Bound::Unbounded, false)
        .unwrap()
        .map(|r| {
            let (k, v) = r.unwrap();
            (String::from_utf8(k).unwrap(), String::from_utf8(v).unwrap())
        })
        .collect();
    let rev: Vec<(String, String)> = t
        .scan(Bound::Unbounded, Bound::Unbounded, true)
        .unwrap()
        .map(|r| {
            let (k, v) = r.unwrap();
            (String::from_utf8(k).unwrap(), String::from_utf8(v).unwrap())
        })
        .collect();
    assert_eq!(fwd.len(), 20 - 2 + 1); // -k06 -k08 +k99
    let mut rev_sorted = rev.clone();
    rev_sorted.reverse();
    assert_eq!(fwd, rev_sorted);
    assert!(fwd.contains(&("k05".into(), "v5b".into())));
    assert!(fwd.contains(&("k07".into(), "buffered".into())));
    assert!(!fwd.iter().any(|(k, _)| k == "k06" || k == "k08"));
    assert_eq!(fwd.last().unwrap().0, "k99");
    // bounded
    let sub: Vec<_> = t
        .scan(
            Bound::Included(b"k10".to_vec()),
            Bound::Excluded(b"k13".to_vec()),
            false,
        )
        .unwrap()
        .map(|r| r.unwrap().0)
        .collect();
    assert_eq!(sub, vec![b"k10".to_vec(), b"k11".to_vec(), b"k12".to_vec()]);
}

#[test]
fn snapshot_scan_ignores_newer_versions() {
    let d = tmp();
    let e = open(d.path());
    for i in 0..10 {
        put(&e, &format!("s{i}"), "v1");
    }
    let mut snap = e.begin(Isolation::Snapshot);
    for i in 0..10 {
        put(&e, &format!("s{i}"), "v2");
    }
    put(&e, "s_new", "v1");
    for rev in [false, true] {
        let items: Vec<_> = snap
            .scan(Bound::Unbounded, Bound::Unbounded, rev)
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        assert_eq!(items.len(), 10);
        assert!(items.iter().all(|(_, v)| v == b"v1"));
    }
}

#[test]
fn keys_with_zero_bytes_keep_order() {
    let d = tmp();
    let e = open(d.path());
    let keys: Vec<Vec<u8>> = vec![
        b"a".to_vec(),
        b"a\x00".to_vec(),
        b"a\x00\x00".to_vec(),
        b"a\x00\x01".to_vec(),
        b"a\x01".to_vec(),
        b"ab".to_vec(),
        vec![0],
        vec![0, 0],
        vec![255],
    ];
    let mut t = e.begin(Isolation::Snapshot);
    for k in &keys {
        t.put(k, b"v").unwrap();
    }
    t.commit().unwrap();
    let mut sorted = keys.clone();
    sorted.sort();
    let mut t = e.begin(Isolation::Snapshot);
    let got: Vec<Vec<u8>> = t
        .scan(Bound::Unbounded, Bound::Unbounded, false)
        .unwrap()
        .map(|r| r.unwrap().0)
        .collect();
    assert_eq!(got, sorted);
    for k in &keys {
        assert!(t.get(k).unwrap().is_some());
    }
}

#[test]
fn recovery_after_reopen() {
    let d = tmp();
    {
        let e = open(d.path());
        for i in 0..500 {
            put(&e, &format!("r{i:04}"), &format!("{i}"));
        }
        put(&e, "r0001", "changed");
        let mut t = e.begin(Isolation::Snapshot);
        t.delete(b"r0002").unwrap();
        t.commit().unwrap();
    }
    let e = open(d.path());
    assert!(e.visible_ts() >= 502);
    assert_eq!(get(&e, "r0001").as_deref(), Some("changed"));
    assert_eq!(get(&e, "r0002"), None);
    assert_eq!(get(&e, "r0499").as_deref(), Some("499"));
    // timestamps keep advancing monotonically after recovery
    let before = e.visible_ts();
    put(&e, "after", "1");
    assert_eq!(e.visible_ts(), before + 1);
    // and a stale-snapshot conflict is still detected after recovery
    let mut a = e.begin(Isolation::Snapshot);
    put(&e, "r0003", "x");
    a.put(b"r0003", b"y").unwrap();
    assert!(matches!(a.commit(), Err(Error::Conflict(_))));
}

#[test]
fn recovery_with_compaction_and_large_values() {
    let d = tmp();
    {
        let e = open(d.path());
        let big = "x".repeat(10_000);
        for i in 0..300 {
            put(&e, &format!("big{i:04}"), &big);
        }
        e.compact().unwrap();
        for i in 300..400 {
            put(&e, &format!("big{i:04}"), &big);
        }
    }
    let e = open(d.path());
    let mut t = e.begin(Isolation::Snapshot);
    let n = t
        .scan(Bound::Unbounded, Bound::Unbounded, false)
        .unwrap()
        .count();
    assert_eq!(n, 400);
}

#[test]
fn durable_sync_mode_roundtrip() {
    let d = tmp();
    {
        let e = Engine::open(d.path(), Options::default()).unwrap();
        for i in 0..50 {
            put(&e, &format!("d{i}"), "v");
        }
        assert!(e.stats().fsyncs >= 1);
    }
    let e = open(d.path());
    assert_eq!(get(&e, "d49").as_deref(), Some("v"));
}

#[test]
fn vacuum_removes_old_versions_but_keeps_snapshots_correct() {
    let d = tmp();
    let e = open(d.path());
    for round in 0..10 {
        for i in 0..20 {
            put(&e, &format!("g{i}"), &format!("r{round}"));
        }
    }
    let mut t = e.begin(Isolation::Snapshot);
    t.delete(b"g0").unwrap();
    t.commit().unwrap();
    // long-running reader pins its snapshot: nothing it needs may disappear
    let mut pinned = e.begin(Isolation::Snapshot);
    put(&e, "g1", "after-pin");
    let removed_pinned = e.vacuum().unwrap();
    assert_eq!(pinned.get(b"g1").unwrap().as_deref(), Some(&b"r9"[..]));
    assert_eq!(pinned.get(b"g0").unwrap(), None);
    drop(pinned);
    let removed = e.vacuum().unwrap();
    assert!(removed_pinned + removed > 0);
    assert_eq!(get(&e, "g1").as_deref(), Some("after-pin"));
    assert_eq!(get(&e, "g0"), None);
    assert_eq!(get(&e, "g19").as_deref(), Some("r9"));
    // second vacuum finds (almost) nothing
    assert_eq!(e.vacuum().unwrap(), 0);
}

#[test]
fn concurrent_disjoint_writers() {
    let d = tmp();
    let e = open(d.path());
    let threads = 8;
    let per = 500;
    let hs: Vec<_> = (0..threads)
        .map(|t| {
            let e = e.clone();
            thread::spawn(move || {
                for i in 0..per {
                    let mut tx = e.begin(Isolation::Snapshot);
                    tx.put(format!("t{t}:{i:05}").as_bytes(), b"v").unwrap();
                    tx.commit().unwrap();
                }
            })
        })
        .collect();
    for h in hs {
        h.join().unwrap();
    }
    let mut t = e.begin(Isolation::Snapshot);
    assert_eq!(
        t.scan(Bound::Unbounded, Bound::Unbounded, false)
            .unwrap()
            .count(),
        threads * per
    );
    assert_eq!(e.stats().conflicts, 0);
}

#[test]
fn concurrent_counter_with_retry_is_exact() {
    let d = tmp();
    let e = open(d.path());
    put(&e, "counter", "0");
    let threads = 8;
    let per = 100;
    let hs: Vec<_> = (0..threads)
        .map(|_| {
            let e = e.clone();
            thread::spawn(move || {
                for _ in 0..per {
                    loop {
                        let mut tx = e.begin(Isolation::Snapshot);
                        let cur: u64 = String::from_utf8(tx.get(b"counter").unwrap().unwrap())
                            .unwrap()
                            .parse()
                            .unwrap();
                        tx.put(b"counter", (cur + 1).to_string().as_bytes()).unwrap();
                        match tx.commit() {
                            Ok(_) => break,
                            Err(Error::Conflict(_)) => continue,
                            Err(e) => panic!("{e}"),
                        }
                    }
                }
            })
        })
        .collect();
    for h in hs {
        h.join().unwrap();
    }
    assert_eq!(get(&e, "counter").as_deref(), Some("800"));
    assert!(e.stats().conflicts > 0, "contended counter should conflict");
}

#[test]
fn bank_transfers_preserve_total_under_serializable() {
    let d = tmp();
    let e = open(d.path());
    let accounts = 10;
    for i in 0..accounts {
        put(&e, &format!("acct{i}"), "1000");
    }
    let hs: Vec<_> = (0..6)
        .map(|w| {
            let e = e.clone();
            thread::spawn(move || {
                let mut seed = 12345u64 + w;
                let mut rnd = move || {
                    seed ^= seed << 13;
                    seed ^= seed >> 7;
                    seed ^= seed << 17;
                    seed
                };
                for _ in 0..150 {
                    let a = rnd() % accounts;
                    let mut b = rnd() % accounts;
                    if a == b {
                        b = (b + 1) % accounts;
                    }
                    loop {
                        let mut tx = e.begin(Isolation::Serializable);
                        let get_i = |tx: &mut wave_core::Txn, i: u64| -> i64 {
                            String::from_utf8(tx.get(format!("acct{i}").as_bytes()).unwrap().unwrap())
                                .unwrap()
                                .parse()
                                .unwrap()
                        };
                        let va = get_i(&mut tx, a);
                        let vb = get_i(&mut tx, b);
                        tx.put(format!("acct{a}").as_bytes(), (va - 10).to_string().as_bytes())
                            .unwrap();
                        tx.put(format!("acct{b}").as_bytes(), (vb + 10).to_string().as_bytes())
                            .unwrap();
                        if tx.commit().is_ok() {
                            break;
                        }
                    }
                }
            })
        })
        .collect();
    for h in hs {
        h.join().unwrap();
    }
    let mut t = e.begin(Isolation::Snapshot);
    let total: i64 = (0..accounts)
        .map(|i| {
            String::from_utf8(t.get(format!("acct{i}").as_bytes()).unwrap().unwrap())
                .unwrap()
                .parse::<i64>()
                .unwrap()
        })
        .sum();
    assert_eq!(total, 10_000);
}

#[test]
fn readers_never_block_writers_consistent_snapshots() {
    let d = tmp();
    let e = open(d.path());
    // invariant: x + y == 100 at every committed state
    {
        let mut t = e.begin(Isolation::Snapshot);
        t.put(b"x", b"50").unwrap();
        t.put(b"y", b"50").unwrap();
        t.commit().unwrap();
    }
    let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let writer = {
        let e = e.clone();
        let stop = stop.clone();
        thread::spawn(move || {
            let mut i = 0u32;
            while !stop.load(std::sync::atomic::Ordering::Relaxed) {
                let mut t = e.begin(Isolation::Snapshot);
                let x = i % 100;
                t.put(b"x", x.to_string().as_bytes()).unwrap();
                t.put(b"y", (100 - x).to_string().as_bytes()).unwrap();
                t.commit().unwrap();
                i += 1;
            }
        })
    };
    let readers: Vec<_> = (0..4)
        .map(|_| {
            let e = e.clone();
            thread::spawn(move || {
                for _ in 0..2000 {
                    let mut t = e.begin(Isolation::Snapshot);
                    let x: i64 = String::from_utf8(t.get(b"x").unwrap().unwrap()).unwrap().parse().unwrap();
                    let y: i64 = String::from_utf8(t.get(b"y").unwrap().unwrap()).unwrap().parse().unwrap();
                    assert_eq!(x + y, 100, "torn snapshot");
                }
            })
        })
        .collect();
    for r in readers {
        r.join().unwrap();
    }
    stop.store(true, std::sync::atomic::Ordering::Relaxed);
    writer.join().unwrap();
}

#[test]
fn shared_open_returns_same_engine() {
    let d = tmp();
    let a = Engine::open_shared(d.path(), Options::default()).unwrap();
    let b = Engine::open_shared(d.path(), Options::default()).unwrap();
    assert!(Arc::ptr_eq(&a, &b));
}

#[test]
fn large_dataset_scan_and_point_reads() {
    let d = tmp();
    let e = open(d.path());
    let n = 50_000;
    for chunk in 0..(n / 1000) {
        let mut t = e.begin(Isolation::Snapshot);
        for i in 0..1000 {
            let id = chunk * 1000 + i;
            t.put(format!("row{id:08}").as_bytes(), format!("value-{id}").as_bytes())
                .unwrap();
        }
        t.commit().unwrap();
    }
    let mut t = e.begin(Isolation::Snapshot);
    assert_eq!(
        t.scan(Bound::Unbounded, Bound::Unbounded, false).unwrap().count(),
        n
    );
    assert_eq!(
        t.scan(Bound::Unbounded, Bound::Unbounded, true).unwrap().count(),
        n
    );
    for id in (0..n).step_by(997) {
        assert_eq!(
            t.get(format!("row{id:08}").as_bytes()).unwrap().unwrap(),
            format!("value-{id}").into_bytes()
        );
    }
    let first_rev = t
        .scan(Bound::Unbounded, Bound::Unbounded, true)
        .unwrap()
        .next()
        .unwrap()
        .unwrap();
    assert_eq!(first_rev.0, format!("row{:08}", n - 1).into_bytes());
}

#[test]
fn group_commit_batches_fsyncs_under_concurrency() {
    let d = tmp();
    let e = Engine::open(d.path(), Options::default()).unwrap(); // Durability::Sync
    let threads = 16;
    let per = 25;
    let start = std::time::Instant::now();
    let hs: Vec<_> = (0..threads)
        .map(|t| {
            let e = e.clone();
            thread::spawn(move || {
                for i in 0..per {
                    put(&e, &format!("gc-{t}-{i}"), "v");
                }
            })
        })
        .collect();
    for h in hs {
        h.join().unwrap();
    }
    let s = e.stats();
    let commits = (threads * per) as u64;
    eprintln!("group commit: {} commits, {} fsyncs, {:?}", commits, s.fsyncs, start.elapsed());
    assert_eq!(s.commits, commits);
    assert!(s.fsyncs < commits, "expected batching: {} fsyncs for {} commits", s.fsyncs, commits);
}

#[test]
fn scans_over_hot_keys_with_many_versions_are_correct_in_both_directions() {
    let d = tmp();
    let e = open(d.path());
    put(&e, "a", "a0");
    put(&e, "z", "z0");
    let mut snaps = vec![];
    for i in 0..200 {
        put(&e, "hot", &format!("v{i}"));
        if i % 50 == 25 {
            snaps.push((i, e.begin(Isolation::Snapshot)));
        }
        if i == 100 {
            put(&e, "a", "a1");
        }
    }
    // tombstone newest version of another hot key
    for i in 0..40 {
        put(&e, "gone", &format!("g{i}"));
    }
    let mut t = e.begin(Isolation::Snapshot);
    t.delete(b"gone").unwrap();
    t.commit().unwrap();

    let cur = |rev: bool| -> Vec<(String, String)> {
        let mut t = e.begin(Isolation::Snapshot);
        t.scan(Bound::Unbounded, Bound::Unbounded, rev)
            .unwrap()
            .map(|r| {
                let (k, v) = r.unwrap();
                (String::from_utf8(k).unwrap(), String::from_utf8(v).unwrap())
            })
            .collect()
    };
    let want = vec![
        ("a".to_string(), "a1".to_string()),
        ("hot".to_string(), "v199".to_string()),
        ("z".to_string(), "z0".to_string()),
    ];
    assert_eq!(cur(false), want);
    let mut rev = want.clone();
    rev.reverse();
    assert_eq!(cur(true), rev);

    for (i, mut s) in snaps {
        let a_expect = if i >= 100 { "a1" } else { "a0" };
        for reverse in [false, true] {
            let mut rows: Vec<(String, String)> = s
                .scan(Bound::Unbounded, Bound::Unbounded, reverse)
                .unwrap()
                .map(|r| {
                    let (k, v) = r.unwrap();
                    (String::from_utf8(k).unwrap(), String::from_utf8(v).unwrap())
                })
                .collect();
            if reverse {
                rows.reverse();
            }
            assert_eq!(
                rows,
                vec![
                    ("a".to_string(), a_expect.to_string()),
                    ("hot".to_string(), format!("v{i}")),
                    ("z".to_string(), "z0".to_string())
                ],
                "snapshot at version {i}, reverse={reverse}"
            );
        }
    }
}
