//! High-level database handle.

use crate::catalog::TableDef;
use crate::error::{Error, Result};
use crate::exec::DbTxn;
use crate::kv::{Engine, Isolation, Options};
use crate::stmt::{QueryResult, Statement};
use std::cell::RefCell;
use std::path::Path;
use std::sync::Arc;

/// Maximum automatic retries for single-statement (autocommit) conflicts.
pub const AUTOCOMMIT_RETRIES: usize = 200;

thread_local! {
    static SESSION_TX: RefCell<Option<DbTxn>> = const { RefCell::new(None) };
}

/// Tiny per-thread xorshift for back-off jitter (no external RNG needed).
fn jitter(bound: u64) -> u64 {
    use std::cell::Cell;
    thread_local! {
        static S: Cell<u64> = Cell::new({
            let t = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos() as u64)
                .unwrap_or(0x9E37_79B9_7F4A_7C15);
            (t ^ (&t as *const u64 as u64)).max(1)
        });
    }
    S.with(|s| {
        let mut x = s.get();
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        s.set(x);
        x % bound.max(1)
    })
}

#[derive(Clone)]
pub struct Db {
    engine: Arc<Engine>,
}

impl Db {
    /// Open (or create) a database directory. Opening the same directory twice in one
    /// process returns handles to the same engine.
    pub fn open(path: impl AsRef<Path>, opts: Options) -> Result<Db> {
        Ok(Db {
            engine: Engine::open_shared(path, opts)?,
        })
    }

    pub fn from_engine(engine: Arc<Engine>) -> Db {
        Db { engine }
    }

    pub fn engine(&self) -> &Arc<Engine> {
        &self.engine
    }

    pub fn begin(&self, iso: Isolation) -> DbTxn {
        DbTxn::new(self.engine.begin(iso))
    }

    /// Read-only snapshot work that must end in commit (not drop-as-rollback).
    fn read_snapshot<T>(&self, f: impl FnOnce(&mut DbTxn) -> Result<T>) -> Result<T> {
        let mut tx = self.begin(Isolation::Snapshot);
        let out = f(&mut tx)?;
        tx.commit()?;
        Ok(out)
    }

    /// Run a closure in a transaction, retrying on conflict.
    pub fn retry<T>(&self, iso: Isolation, mut f: impl FnMut(&mut DbTxn) -> Result<T>) -> Result<T> {
        let mut attempt = 0;
        loop {
            let mut tx = self.begin(iso);
            let res = f(&mut tx).and_then(|v| tx.commit().map(|_| v));
            match res {
                Err(Error::Conflict(_)) if attempt < AUTOCOMMIT_RETRIES => {
                    attempt += 1;
                    // Single statements are short, so the first retries just yield; after that a
                    // randomized, capped (2 ms) exponential back-off de-synchronizes contenders.
                    if attempt <= 3 {
                        std::thread::yield_now();
                    } else {
                        let window = (20u64 << (attempt - 3).min(7)).min(2_000);
                        std::thread::sleep(std::time::Duration::from_micros(jitter(window) + 1));
                    }
                }
                other => return other,
            }
        }
    }

    fn run_statement(&self, stmt: &Statement) -> Result<QueryResult> {
        match stmt {
            Statement::Begin => SESSION_TX.with(|slot| {
                let mut s = slot.borrow_mut();
                if s.is_some() {
                    return Err(Error::Sql("already in transaction".into()));
                }
                *s = Some(self.begin(Isolation::Snapshot));
                Ok(QueryResult::default())
            }),
            Statement::Commit => SESSION_TX.with(|slot| {
                let tx = slot
                    .borrow_mut()
                    .take()
                    .ok_or_else(|| Error::Sql("no active transaction".into()))?;
                tx.commit()?;
                Ok(QueryResult::default())
            }),
            Statement::Rollback => SESSION_TX.with(|slot| {
                if let Some(tx) = slot.borrow_mut().take() {
                    tx.rollback();
                }
                Ok(QueryResult::default())
            }),
            other => SESSION_TX.with(|slot| {
                if let Some(tx) = slot.borrow_mut().as_mut() {
                    return tx.execute(other);
                }
                self.retry(Isolation::Snapshot, |tx| tx.execute(other))
            }),
        }
    }

    /// Execute one statement in its own transaction (auto-retried on conflict).
    pub fn execute(&self, stmt: &Statement) -> Result<QueryResult> {
        let started = std::time::Instant::now();
        Ok(self.run_statement(stmt)?.with_duration(started))
    }

    pub fn execute_sql(&self, sql: &str, params: &[crate::value::Value]) -> Result<QueryResult> {
        let started = std::time::Instant::now();
        let stmts = crate::sql::parse_sql(sql, params)?;
        let mut last = QueryResult::default();
        for s in &stmts {
            last = self.run_statement(s)?;
        }
        Ok(last.with_duration(started))
    }

    pub fn tables(&self) -> Result<Vec<TableDef>> {
        self.read_snapshot(|tx| tx.list_tables())
    }
}

impl DbTxn {
    pub fn execute_all(&mut self, stmts: &[Statement]) -> Result<QueryResult> {
        let started = std::time::Instant::now();
        let mut last = QueryResult::default();
        for s in stmts {
            last = self.execute(s)?;
        }
        Ok(last.with_duration(started))
    }

    pub fn execute_sql(&mut self, sql: &str, params: &[crate::value::Value]) -> Result<QueryResult> {
        let stmts = crate::sql::parse_sql(sql, params)?;
        self.execute_all(&stmts)
    }
}
