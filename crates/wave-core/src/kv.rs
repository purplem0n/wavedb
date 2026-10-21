//! MVCC key-value engine with optimistic concurrency control, built on top of
//! the `fjall` LSM-tree.
//!
//! # Storage layout
//!
//! Every user key `k` committed at timestamp `ts` is stored in the `data`
//! keyspace as
//!
//! ```text
//! escape(k) ++ 00 00 ++ big_endian(!ts)
//! ```
//!
//! `escape` maps `00 -> 00 FF`, which keeps lexicographic order of user keys
//! while making the `00 00` terminator unambiguous. Inverting the timestamp
//! makes versions of one key sort newest-first, so a snapshot read is a single
//! seek. Values are prefixed with a tag byte: `1` = value, `0` = tombstone.
//!
//! # Concurrency
//!
//! * Readers take a snapshot timestamp (`visible_ts`) with an atomic load and
//!   never block or get blocked.
//! * Writers buffer their changes privately. Commit takes a short mutex, validates
//!   against an in-memory log of recent writes (first-committer-wins snapshot
//!   isolation; optionally serializable with read-set validation), appends the
//!   whole write set as one atomic fjall batch, and publishes the new timestamp.
//! * Durability uses *group commit*: after releasing the commit mutex one
//!   committer becomes the fsync leader and covers every commit that has been
//!   appended so far.

use crate::error::{Error, Result};
use fjall::{Database, Keyspace, KeyspaceCreateOptions, PersistMode};
use parking_lot::{Condvar, Mutex};
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::iter::Peekable;
use std::ops::Bound;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicI64, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Weak};

const TS_LEN: usize = 8;
const META_TS_KEY: &[u8] = b"last_ts";
const META_AI_PREFIX: &[u8] = b"ai:";

fn ai_meta_key(table_id: u32) -> Vec<u8> {
    let mut k = META_AI_PREFIX.to_vec();
    k.extend_from_slice(&table_id.to_be_bytes());
    k
}
pub const FORMAT_VERSION: u32 = 1;

/// How commits are made durable.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Durability {
    /// `fdatasync` (shared between concurrent committers) before acknowledging.
    Sync,
    /// Write to the OS page cache only; survives process crashes, not power loss.
    Async,
}

#[derive(Clone, Debug)]
pub struct Options {
    pub durability: Durability,
    /// Block cache size in bytes.
    pub cache_bytes: u64,
    /// Delete the directory on drop (tests / scratch databases).
    pub temporary: bool,
}

impl Default for Options {
    fn default() -> Self {
        Options {
            durability: Durability::Sync,
            cache_bytes: 64 * 1024 * 1024,
            temporary: false,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Isolation {
    /// Snapshot isolation: write-write conflicts abort (first committer wins).
    Snapshot,
    /// Serializable: additionally aborts if anything read was concurrently modified.
    Serializable,
}

pub type KeyBound = Bound<Vec<u8>>;

#[derive(Default)]
struct Counters {
    commits: AtomicU64,
    conflicts: AtomicU64,
    rollbacks: AtomicU64,
    syncs: AtomicU64,
}

#[derive(Debug, Clone, Default)]
pub struct EngineStats {
    pub visible_ts: u64,
    pub commits: u64,
    pub conflicts: u64,
    pub rollbacks: u64,
    pub fsyncs: u64,
    pub active_txns: usize,
    pub tracked_writes: usize,
    pub disk_bytes: u64,
}

struct CommitState {
    next_ts: u64,
    last_write: BTreeMap<Vec<u8>, u64>,
    log: VecDeque<(u64, Vec<u8>)>,
}

#[derive(Default)]
struct SyncState {
    synced_seq: u64,
    syncing: bool,
}

pub struct Engine {
    db: Database,
    data: Keyspace,
    meta: Keyspace,
    opts: Options,
    path: PathBuf,
    visible_ts: AtomicU64,
    commit_seq: AtomicU64,
    commit: Mutex<CommitState>,
    active: Mutex<BTreeMap<u64, usize>>,
    sync: Mutex<SyncState>,
    sync_cv: Condvar,
    /// committers that entered `commit` but have not finished appending yet (Sync mode only)
    entering: AtomicUsize,
    counters: Counters,
    aux: Mutex<HashMap<u32, Arc<AtomicI64>>>,
}

static REGISTRY: Mutex<Option<HashMap<PathBuf, Weak<Engine>>>> = Mutex::new(None);

impl Engine {
    /// Open (or create) a database directory. Fails if it is already open by
    /// another engine instance; use [`Engine::open_shared`] to share one.
    pub fn open(path: impl AsRef<Path>, opts: Options) -> Result<Arc<Engine>> {
        let path = path.as_ref().to_path_buf();
        std::fs::create_dir_all(&path)?;
        let marker = path.join("wave.format");
        if marker.exists() {
            let txt = std::fs::read_to_string(&marker).unwrap_or_default();
            let v: u32 = txt.trim().parse().unwrap_or(0);
            if v > FORMAT_VERSION {
                return Err(Error::Invalid(format!(
                    "database format v{v} is newer than supported v{FORMAT_VERSION}"
                )));
            }
        } else {
            std::fs::write(&marker, format!("{FORMAT_VERSION}\n"))?;
        }
        let db = Database::builder(path.join("lsm"))
            .cache_size(opts.cache_bytes)
            .temporary(opts.temporary)
            .open()?;
        let data = db.keyspace("data", KeyspaceCreateOptions::default)?;
        let meta = db.keyspace("meta", KeyspaceCreateOptions::default)?;
        let last_ts = match meta.get(META_TS_KEY)? {
            Some(v) if v.len() == 8 => u64::from_be_bytes(v[..8].try_into().unwrap()),
            _ => 0,
        };
        Ok(Arc::new(Engine {
            db,
            data,
            meta,
            opts,
            path,
            visible_ts: AtomicU64::new(last_ts),
            commit_seq: AtomicU64::new(0),
            commit: Mutex::new(CommitState {
                next_ts: last_ts + 1,
                last_write: BTreeMap::new(),
                log: VecDeque::new(),
            }),
            active: Mutex::new(BTreeMap::new()),
            sync: Mutex::new(SyncState::default()),
            sync_cv: Condvar::new(),
            entering: AtomicUsize::new(0),
            counters: Counters::default(),
            aux: Mutex::new(HashMap::new()),
        }))
    }

    /// Process-global registry: opening the same canonical path twice returns
    /// the same engine (so Node worker threads share one instance).
    pub fn open_shared(path: impl AsRef<Path>, opts: Options) -> Result<Arc<Engine>> {
        let p = path.as_ref();
        std::fs::create_dir_all(p)?;
        let canon = std::fs::canonicalize(p)?;
        let mut reg = REGISTRY.lock();
        let map = reg.get_or_insert_with(HashMap::new);
        if let Some(w) = map.get(&canon) {
            if let Some(e) = w.upgrade() {
                return Ok(e);
            }
        }
        let e = Engine::open(&canon, opts)?;
        map.insert(canon, Arc::downgrade(&e));
        Ok(e)
    }

    /// Named in-memory counter (used for auto-increment ids). `init` runs once.
    pub fn aux_counter(
        &self,
        id: u32,
        init: impl FnOnce() -> Result<i64>,
    ) -> Result<Arc<AtomicI64>> {
        let mut m = self.aux.lock();
        if let Some(c) = m.get(&id) {
            return Ok(c.clone());
        }
        let mut next = init()?;
        if let Ok(Some(bytes)) = self.meta.get(&ai_meta_key(id)) {
            if bytes.len() == 8 {
                let stored = i64::from_be_bytes(bytes.as_slice().try_into().unwrap());
                if stored > next {
                    next = stored;
                }
            }
        }
        let c = Arc::new(AtomicI64::new(next));
        m.insert(id, c.clone());
        Ok(c)
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn options(&self) -> &Options {
        &self.opts
    }

    pub fn visible_ts(&self) -> u64 {
        self.visible_ts.load(Ordering::Acquire)
    }

    pub fn begin(self: &Arc<Self>, iso: Isolation) -> Txn {
        let start_ts = {
            let mut a = self.active.lock();
            let ts = self.visible_ts.load(Ordering::Acquire);
            *a.entry(ts).or_insert(0) += 1;
            ts
        };
        Txn {
            engine: self.clone(),
            start_ts,
            iso,
            writes: BTreeMap::new(),
            read_keys: Vec::new(),
            read_ranges: Vec::new(),
            commutative_keys: HashSet::new(),
            pre_commit: None,
            done: false,
        }
    }

    fn unregister(&self, ts: u64) {
        let mut a = self.active.lock();
        if let Some(c) = a.get_mut(&ts) {
            *c -= 1;
            if *c == 0 {
                a.remove(&ts);
            }
        }
    }

    /// Oldest snapshot still in use (or the current visible ts when idle).
    fn watermark(&self) -> u64 {
        let a = self.active.lock();
        match a.keys().next() {
            Some(&t) => t,
            None => self.visible_ts.load(Ordering::Acquire),
        }
    }

    /// Point read of the newest version of `key` visible at `snap`.
    pub(crate) fn read_at(&self, key: &[u8], snap: u64) -> Result<Option<Vec<u8>>> {
        let lo = versioned_key(key, snap);
        let mut hi = encode_group(key);
        hi.extend_from_slice(&[0xFF; TS_LEN]);
        let mut it = self.data.range((Bound::Included(lo), Bound::Included(hi)));
        match it.next() {
            None => Ok(None),
            Some(g) => {
                let (_, v) = g.into_inner()?;
                if v.is_empty() || v[0] == 0 {
                    Ok(None)
                } else {
                    Ok(Some(v[1..].to_vec()))
                }
            }
        }
    }

    fn snap_iter(&self, lo: &KeyBound, hi: &KeyBound, snap: u64, reverse: bool) -> SnapIter {
        let lo_b = match lo {
            Bound::Unbounded => Bound::Unbounded,
            Bound::Included(k) => Bound::Included(encode_group(k)),
            Bound::Excluded(k) => {
                let mut g = encode_group(k);
                g.extend_from_slice(&[0xFF; TS_LEN]);
                Bound::Excluded(g)
            }
        };
        let hi_b = match hi {
            Bound::Unbounded => Bound::Unbounded,
            Bound::Included(k) => {
                let mut g = encode_group(k);
                g.extend_from_slice(&[0xFF; TS_LEN]);
                Bound::Included(g)
            }
            Bound::Excluded(k) => Bound::Excluded(encode_group(k)),
        };
        SnapIter {
            inner: self.data.range((lo_b.clone(), hi_b.clone())),
            data: self.data.clone(),
            lo_b,
            hi_b,
            snap,
            reverse,
            last_group: None,
            cur_group: None,
            candidate: None,
            run: 0,
        }
    }

    /// Wait until the commit with sequence `seq` is fsynced (group commit).
    fn wait_durable(&self, seq: u64) -> Result<()> {
        let mut st = self.sync.lock();
        while st.synced_seq < seq {
            if st.syncing {
                self.sync_cv.wait(&mut st);
                continue;
            }
            st.syncing = true;
            drop(st);
            // Commit window: fjall's journal lock is held while it fsyncs, so committers that
            // arrive mid-fsync queue up behind it. Give committers that have entered `commit`
            // but not yet appended a moment to do so, so one fsync covers the whole group.
            let mut waited = 0u32;
            while waited < 40 && self.entering.load(Ordering::Acquire) > 0 {
                std::thread::sleep(std::time::Duration::from_micros(25));
                waited += 1;
            }
            let target = self.commit_seq.load(Ordering::Acquire);
            let res = self.db.persist(PersistMode::SyncData);
            st = self.sync.lock();
            st.syncing = false;
            if res.is_ok() {
                st.synced_seq = st.synced_seq.max(target);
                self.counters.syncs.fetch_add(1, Ordering::Relaxed);
            }
            self.sync_cv.notify_all();
            res?;
        }
        Ok(())
    }

    /// Force all committed data to disk.
    pub fn flush(&self) -> Result<()> {
        self.db.persist(PersistMode::SyncAll)?;
        Ok(())
    }

    /// Rotate memtables and compact (best-effort), mostly useful in tests/benchmarks.
    pub fn compact(&self) -> Result<()> {
        self.data.rotate_memtable_and_wait()?;
        self.data.major_compact()?;
        Ok(())
    }

    /// Drop obsolete MVCC versions that no snapshot can observe. Returns the
    /// number of removed versions.
    pub fn vacuum(&self) -> Result<u64> {
        let wm = self.watermark();
        let mut removed = 0u64;
        let mut batch = self.db.batch();
        let mut pending = 0usize;
        // group state
        let mut cur_group: Option<Vec<u8>> = None;
        let mut kept_visible = false; // already kept the newest version <= wm for this group
        for g in self.data.iter() {
            let (k, v) = g.into_inner()?;
            let (group, ts) = split_version(&k);
            if cur_group.as_deref() != Some(group) {
                cur_group = Some(group.to_vec());
                kept_visible = false;
            }
            if ts > wm {
                continue;
            }
            if !kept_visible {
                kept_visible = true;
                // newest version at/below the watermark: only removable if it is a tombstone
                // and nothing older remains needed (older ones are dropped below).
                if v.first() == Some(&0) {
                    batch.remove(&self.data, k.to_vec());
                    removed += 1;
                    pending += 1;
                }
                continue;
            }
            batch.remove(&self.data, k.to_vec());
            removed += 1;
            pending += 1;
            if pending >= 5000 {
                std::mem::replace(&mut batch, self.db.batch()).commit()?;
                pending = 0;
            }
        }
        batch.commit()?;
        Ok(removed)
    }

    pub fn stats(&self) -> EngineStats {
        let (tracked, _) = {
            let c = self.commit.lock();
            (c.last_write.len(), c.next_ts)
        };
        EngineStats {
            visible_ts: self.visible_ts(),
            commits: self.counters.commits.load(Ordering::Relaxed),
            conflicts: self.counters.conflicts.load(Ordering::Relaxed),
            rollbacks: self.counters.rollbacks.load(Ordering::Relaxed),
            fsyncs: self.counters.syncs.load(Ordering::Relaxed),
            active_txns: self.active.lock().values().sum(),
            tracked_writes: tracked,
            disk_bytes: self.db.disk_space().unwrap_or(0),
        }
    }
}

impl Drop for Engine {
    fn drop(&mut self) {
        if !self.opts.temporary {
            let aux = self.aux.lock();
            if !aux.is_empty() {
                let mut batch = self.db.batch();
                for (id, counter) in aux.iter() {
                    let v = counter.load(Ordering::Relaxed);
                    batch.insert(&self.meta, ai_meta_key(*id), v.to_be_bytes().to_vec());
                }
                let _ = batch.commit();
            }
            drop(aux);
            let _ = self.db.persist(PersistMode::SyncAll);
        }
    }
}

// ---------------------------------------------------------------------------
// key encoding
// ---------------------------------------------------------------------------

fn escape_into(k: &[u8], out: &mut Vec<u8>) {
    for &b in k {
        out.push(b);
        if b == 0 {
            out.push(0xFF);
        }
    }
}

/// `escape(k) ++ 00 00`
fn encode_group(k: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(k.len() + 2 + TS_LEN);
    escape_into(k, &mut out);
    out.extend_from_slice(&[0, 0]);
    out
}

fn versioned_key(k: &[u8], ts: u64) -> Vec<u8> {
    let mut out = encode_group(k);
    out.extend_from_slice(&(!ts).to_be_bytes());
    out
}

fn split_version(k: &[u8]) -> (&[u8], u64) {
    let n = k.len() - TS_LEN;
    let ts = !u64::from_be_bytes(k[n..].try_into().unwrap());
    (&k[..n], ts)
}

fn unescape_group(group: &[u8]) -> Vec<u8> {
    let body = &group[..group.len() - 2];
    let mut out = Vec::with_capacity(body.len());
    let mut i = 0;
    while i < body.len() {
        out.push(body[i]);
        if body[i] == 0 {
            i += 1; // skip the 0xFF escape marker
        }
        i += 1;
    }
    out
}

/// Smallest key strictly greater than every key starting with `prefix`
/// (`None` if the prefix is all 0xFF).
pub fn prefix_end(prefix: &[u8]) -> Option<Vec<u8>> {
    let mut p = prefix.to_vec();
    while let Some(last) = p.pop() {
        if last != 0xFF {
            p.push(last + 1);
            return Some(p);
        }
    }
    None
}

pub fn prefix_range(prefix: &[u8]) -> (KeyBound, KeyBound) {
    let hi = match prefix_end(prefix) {
        Some(e) => Bound::Excluded(e),
        None => Bound::Unbounded,
    };
    (Bound::Included(prefix.to_vec()), hi)
}

// ---------------------------------------------------------------------------
// snapshot iteration
// ---------------------------------------------------------------------------

/// Iterates the newest visible, non-deleted version of each user key.
pub struct SnapIter {
    inner: fjall::Iter,
    data: Keyspace,
    lo_b: Bound<Vec<u8>>,
    hi_b: Bound<Vec<u8>>,
    snap: u64,
    reverse: bool,
    last_group: Option<Vec<u8>>,
    cur_group: Option<Vec<u8>>,
    candidate: Option<(Vec<u8>, Vec<u8>)>,
    /// consecutive entries of the same key group seen (hot rows pile up dead versions)
    run: u32,
}

/// After this many consecutive versions of one key, re-seek instead of walking the rest.
const RESEEK_AFTER: u32 = 8;

type KvItem = Result<(Vec<u8>, Vec<u8>)>;

impl SnapIter {
    fn emit(group: &[u8], tagged: &[u8]) -> Option<(Vec<u8>, Vec<u8>)> {
        if tagged.first() == Some(&1) {
            Some((unescape_group(group), tagged[1..].to_vec()))
        } else {
            None
        }
    }
}

impl Iterator for SnapIter {
    type Item = KvItem;

    fn next(&mut self) -> Option<KvItem> {
        if !self.reverse {
            loop {
                let g = self.inner.next()?;
                let (k, v) = match g.into_inner() {
                    Ok(kv) => kv,
                    Err(e) => return Some(Err(e.into())),
                };
                if k.len() <= TS_LEN + 2 {
                    continue;
                }
                let (group, ts) = split_version(&k);
                if self.last_group.as_deref() == Some(group) || ts > self.snap {
                    self.run += 1;
                    if self.run >= RESEEK_AFTER {
                        // many dead versions of one key: jump past the whole group
                        let mut end = group.to_vec();
                        end.extend_from_slice(&[0xFF; TS_LEN]);
                        self.inner = self.data.range((Bound::Excluded(end), self.hi_b.clone()));
                        self.run = 0;
                        if self.last_group.as_deref() != Some(group) {
                            // newest visible version not seen yet (all seen were too new): look it up
                            let key = unescape_group(group);
                            let lo = versioned_key(&key, self.snap);
                            let mut hi = group.to_vec();
                            hi.extend_from_slice(&[0xFF; TS_LEN]);
                            if let Some(g) = self.data.range((Bound::Included(lo), Bound::Included(hi))).next() {
                                match g.into_inner() {
                                    Ok((_, v)) => {
                                        self.last_group = Some(group.to_vec());
                                        if let Some(item) = Self::emit(group, &v) {
                                            return Some(Ok(item));
                                        }
                                    }
                                    Err(e) => return Some(Err(e.into())),
                                }
                            }
                        }
                    }
                    continue;
                }
                self.run = 0;
                self.last_group = Some(group.to_vec());
                if let Some(item) = Self::emit(group, &v) {
                    return Some(Ok(item));
                }
            }
        } else {
            loop {
                match self.inner.next_back() {
                    None => {
                        let cand = self.candidate.take()?;
                        if let Some(item) = Self::emit(&cand.0, &cand.1) {
                            return Some(Ok(item));
                        }
                        return None;
                    }
                    Some(g) => {
                        let (k, v) = match g.into_inner() {
                            Ok(kv) => kv,
                            Err(e) => return Some(Err(e.into())),
                        };
                        if k.len() <= TS_LEN + 2 {
                            continue;
                        }
                        let (group, ts) = split_version(&k);
                        let mut out = None;
                        if self.cur_group.as_deref() != Some(group) {
                            if let Some(c) = self.candidate.take() {
                                out = Self::emit(&c.0, &c.1);
                            }
                            self.cur_group = Some(group.to_vec());
                            self.run = 0;
                        }
                        self.run += 1;
                        if ts <= self.snap {
                            self.candidate = Some((group.to_vec(), v.to_vec()));
                        }
                        if self.run >= RESEEK_AFTER {
                            // hot key with many versions (walking oldest -> newest): look the visible
                            // one up directly and continue before this group
                            let key = unescape_group(group);
                            let lo = versioned_key(&key, self.snap);
                            let mut hi = group.to_vec();
                            hi.extend_from_slice(&[0xFF; TS_LEN]);
                            let found = self.data.range((Bound::Included(lo), Bound::Included(hi))).next();
                            self.candidate = match found {
                                Some(g) => match g.into_inner() {
                                    Ok((_, v)) => Some((group.to_vec(), v.to_vec())),
                                    Err(e) => return Some(Err(e.into())),
                                },
                                None => None,
                            };
                            let mut start = group.to_vec();
                            start.extend_from_slice(&[0x00; TS_LEN]);
                            self.inner = self.data.range((self.lo_b.clone(), Bound::Excluded(start)));
                            self.run = 0;
                        }
                        if let Some(item) = out {
                            return Some(Ok(item));
                        }
                    }
                }
            }
        }
    }
}

/// Snapshot scan merged with the transaction's own uncommitted writes.
pub struct Scan {
    base: Peekable<SnapIter>,
    buf: std::vec::IntoIter<(Vec<u8>, Option<Vec<u8>>)>,
    buf_head: Option<(Vec<u8>, Option<Vec<u8>>)>,
    reverse: bool,
}

impl Iterator for Scan {
    type Item = KvItem;

    fn next(&mut self) -> Option<KvItem> {
        loop {
            if self.buf_head.is_none() {
                self.buf_head = self.buf.next();
            }
            // surface storage errors immediately
            if let Some(Err(_)) = self.base.peek() {
                return self.base.next();
            }
            let base_key = match self.base.peek() {
                Some(Ok((k, _))) => Some(k.clone()),
                _ => None,
            };
            match (&self.buf_head, base_key) {
                (None, None) => return None,
                (None, Some(_)) => return self.base.next(),
                (Some(_), None) => {
                    let (k, v) = self.buf_head.take().unwrap();
                    if let Some(v) = v {
                        return Some(Ok((k, v)));
                    }
                    continue;
                }
                (Some((bk, _)), Some(sk)) => {
                    let ord = bk.as_slice().cmp(sk.as_slice());
                    let buf_first = if self.reverse {
                        ord == std::cmp::Ordering::Greater
                    } else {
                        ord == std::cmp::Ordering::Less
                    };
                    if ord == std::cmp::Ordering::Equal {
                        self.base.next();
                        let (k, v) = self.buf_head.take().unwrap();
                        if let Some(v) = v {
                            return Some(Ok((k, v)));
                        }
                        continue;
                    }
                    if buf_first {
                        let (k, v) = self.buf_head.take().unwrap();
                        if let Some(v) = v {
                            return Some(Ok((k, v)));
                        }
                        continue;
                    }
                    return self.base.next();
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// transactions
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy)]
pub struct CommitInfo {
    pub commit_ts: u64,
    pub keys_written: usize,
}

pub struct Txn {
    engine: Arc<Engine>,
    start_ts: u64,
    iso: Isolation,
    writes: BTreeMap<Vec<u8>, Option<Vec<u8>>>,
    read_keys: Vec<Vec<u8>>,
    read_ranges: Vec<(KeyBound, KeyBound)>,
    /// Row keys merged under the commit lock (skip write-write validation).
    commutative_keys: HashSet<Vec<u8>>,
    pre_commit: Option<Box<dyn FnOnce(&mut Txn) -> Result<()> + Send>>,
    done: bool,
}

impl Txn {
    pub fn start_ts(&self) -> u64 {
        self.start_ts
    }

    pub fn isolation(&self) -> Isolation {
        self.iso
    }

    pub fn is_read_only(&self) -> bool {
        self.writes.is_empty() && self.pre_commit.is_none()
    }

    /// Runs inside the commit mutex immediately before validation (e.g. commutative row merges).
    pub fn on_commit(&mut self, f: impl FnOnce(&mut Txn) -> Result<()> + Send + 'static) {
        self.pre_commit = Some(Box::new(f));
    }

    pub fn mark_commutative_key(&mut self, key: Vec<u8>) {
        self.commutative_keys.insert(key);
    }

    pub fn write_count(&self) -> usize {
        self.writes.len()
    }

    pub fn engine(&self) -> &Arc<Engine> {
        &self.engine
    }

    fn check_open(&self) -> Result<()> {
        if self.done {
            Err(Error::Closed)
        } else {
            Ok(())
        }
    }

    pub fn get(&mut self, key: &[u8]) -> Result<Option<Vec<u8>>> {
        self.check_open()?;
        if let Some(v) = self.writes.get(key) {
            return Ok(v.clone());
        }
        if self.iso == Isolation::Serializable {
            self.read_keys.push(key.to_vec());
        }
        self.engine.read_at(key, self.start_ts)
    }

    pub fn put(&mut self, key: &[u8], value: &[u8]) -> Result<()> {
        self.check_open()?;
        self.writes.insert(key.to_vec(), Some(value.to_vec()));
        Ok(())
    }

    pub fn delete(&mut self, key: &[u8]) -> Result<()> {
        self.check_open()?;
        self.writes.insert(key.to_vec(), None);
        Ok(())
    }

    /// Lazily scan `[lo, hi)`-style bounds in key order (or reverse).
    pub fn scan(&mut self, lo: KeyBound, hi: KeyBound, reverse: bool) -> Result<Scan> {
        self.check_open()?;
        let base = self.engine.snap_iter(&lo, &hi, self.start_ts, reverse);
        let mut buf: Vec<(Vec<u8>, Option<Vec<u8>>)> = if range_is_empty(&lo, &hi) {
            Vec::new()
        } else {
            self.writes
                .range::<Vec<u8>, _>((lo.clone(), hi.clone()))
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect()
        };
        if reverse {
            buf.reverse();
        }
        if self.iso == Isolation::Serializable {
            self.read_ranges.push((lo, hi));
        }
        Ok(Scan {
            base: base.peekable(),
            buf: buf.into_iter(),
            buf_head: None,
            reverse,
        })
    }

    pub fn scan_prefix(&mut self, prefix: &[u8], reverse: bool) -> Result<Scan> {
        let (lo, hi) = prefix_range(prefix);
        self.scan(lo, hi, reverse)
    }

    pub fn rollback(mut self) {
        self.finish(false);
    }

    fn finish(&mut self, committed: bool) {
        if !self.done {
            self.done = true;
            self.engine.unregister(self.start_ts);
            if !committed {
                self.engine.counters.rollbacks.fetch_add(1, Ordering::Relaxed);
            }
        }
    }

    /// Validate, append and (per durability setting) fsync the write set.
    pub fn commit(mut self) -> Result<CommitInfo> {
        self.check_open()?;
        let res = self.commit_inner();
        self.finish(res.is_ok());
        res
    }

    fn commit_inner(&mut self) -> Result<CommitInfo> {
        let eng = self.engine.clone();
        let sync_mode = eng.opts.durability == Durability::Sync;
        let entering = EnterGuard::new(sync_mode.then_some(&eng.entering));
        let (commit_ts, seq) = {
            let mut cs = eng.commit.lock();
            if let Some(f) = self.pre_commit.take() {
                f(self)?;
            }
            if self.writes.is_empty() {
                eng.counters.commits.fetch_add(1, Ordering::Relaxed);
                return Ok(CommitInfo {
                    commit_ts: self.start_ts,
                    keys_written: 0,
                });
            }
            // --- validate ---
            for k in self.writes.keys() {
                if self.commutative_keys.contains(k) {
                    continue;
                }
                if let Some(&ts) = cs.last_write.get(k) {
                    if ts > self.start_ts {
                        eng.counters.conflicts.fetch_add(1, Ordering::Relaxed);
                        return Err(Error::Conflict(format!(
                            "write-write conflict on key {}",
                            show_key(k)
                        )));
                    }
                }
            }
            if self.iso == Isolation::Serializable {
                for k in &self.read_keys {
                    if let Some(&ts) = cs.last_write.get(k) {
                        if ts > self.start_ts {
                            eng.counters.conflicts.fetch_add(1, Ordering::Relaxed);
                            return Err(Error::Conflict(format!(
                                "read-write conflict on key {}",
                                show_key(k)
                            )));
                        }
                    }
                }
                for (lo, hi) in &self.read_ranges {
                    if range_is_empty(lo, hi) {
                        continue;
                    }
                    if let Some((k, _)) = cs
                        .last_write
                        .range::<Vec<u8>, _>((lo.clone(), hi.clone()))
                        .find(|(_, &ts)| ts > self.start_ts)
                    {
                        eng.counters.conflicts.fetch_add(1, Ordering::Relaxed);
                        return Err(Error::Conflict(format!(
                            "range read conflict near key {}",
                            show_key(k)
                        )));
                    }
                }
            }
            // --- append ---
            let ts = cs.next_ts;
            let mut batch = eng.db.batch();
            for (k, v) in &self.writes {
                let vk = versioned_key(k, ts);
                match v {
                    Some(v) => {
                        let mut val = Vec::with_capacity(v.len() + 1);
                        val.push(1);
                        val.extend_from_slice(v);
                        batch.insert(&eng.data, vk, val);
                    }
                    None => batch.insert(&eng.data, vk, vec![0u8]),
                }
            }
            batch.insert(&eng.meta, META_TS_KEY.to_vec(), ts.to_be_bytes().to_vec());
            batch.commit()?;
            cs.next_ts = ts + 1;
            for k in self.writes.keys() {
                cs.last_write.insert(k.clone(), ts);
                cs.log.push_back((ts, k.clone()));
            }
            // --- prune the recent-writes log ---
            let wm = {
                let a = eng.active.lock();
                a.keys().next().copied().unwrap_or(ts)
            };
            while let Some((t, _)) = cs.log.front() {
                if *t > wm {
                    break;
                }
                let (t, k) = cs.log.pop_front().unwrap();
                if cs.last_write.get(&k) == Some(&t) {
                    cs.last_write.remove(&k);
                }
            }
            eng.visible_ts.store(ts, Ordering::Release);
            let seq = eng.commit_seq.fetch_add(1, Ordering::AcqRel) + 1;
            (ts, seq)
        };
        drop(entering);
        eng.counters.commits.fetch_add(1, Ordering::Relaxed);
        if sync_mode {
            eng.wait_durable(seq)?;
        }
        Ok(CommitInfo {
            commit_ts,
            keys_written: self.writes.len(),
        })
    }
}

impl Drop for Txn {
    fn drop(&mut self) {
        self.finish(false);
    }
}

fn range_is_empty(lo: &KeyBound, hi: &KeyBound) -> bool {
    match (lo, hi) {
        (Bound::Included(a), Bound::Included(b)) => a > b,
        (Bound::Included(a), Bound::Excluded(b))
        | (Bound::Excluded(a), Bound::Included(b))
        | (Bound::Excluded(a), Bound::Excluded(b)) => a >= b,
        _ => false,
    }
}

struct EnterGuard<'a>(Option<&'a AtomicUsize>);

impl<'a> EnterGuard<'a> {
    fn new(c: Option<&'a AtomicUsize>) -> Self {
        if let Some(c) = c {
            c.fetch_add(1, Ordering::AcqRel);
        }
        EnterGuard(c)
    }
}

impl Drop for EnterGuard<'_> {
    fn drop(&mut self) {
        if let Some(c) = self.0 {
            c.fetch_sub(1, Ordering::AcqRel);
        }
    }
}

pub fn show_key(k: &[u8]) -> String {
    if k.iter().all(|b| (0x20..0x7f).contains(b)) {
        String::from_utf8_lossy(k).into_owned()
    } else {
        k.iter().map(|b| format!("{b:02x}")).collect::<String>()
    }
}
