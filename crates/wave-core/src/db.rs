//! High-level database handle.

use crate::catalog::TableDef;
use crate::error::{Error, Result};
use crate::exec::DbTxn;
use crate::kv::{Engine, Isolation, Options};
use crate::stmt::{QueryResult, Statement};
use std::path::Path;
use std::sync::Arc;

/// Maximum automatic retries for single-statement (autocommit) conflicts.
pub const AUTOCOMMIT_RETRIES: usize = 24;

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

    /// Run a closure in a transaction, retrying on conflict.
    pub fn retry<T>(&self, iso: Isolation, mut f: impl FnMut(&mut DbTxn) -> Result<T>) -> Result<T> {
        let mut attempt = 0;
        loop {
            let mut tx = self.begin(iso);
            let res = f(&mut tx).and_then(|v| tx.commit().map(|_| v));
            match res {
                Err(Error::Conflict(_)) if attempt < AUTOCOMMIT_RETRIES => {
                    attempt += 1;
                    let us = (1u64 << attempt.min(10)) * 20;
                    std::thread::sleep(std::time::Duration::from_micros(us + (attempt as u64 * 37) % 97));
                }
                other => return other,
            }
        }
    }

    /// Execute one statement in its own transaction (auto-retried on conflict).
    pub fn execute(&self, stmt: &Statement) -> Result<QueryResult> {
        self.retry(Isolation::Snapshot, |tx| tx.execute(stmt))
    }

    pub fn execute_sql(&self, sql: &str, params: &[crate::value::Value]) -> Result<QueryResult> {
        let stmts = crate::sql::parse_sql(sql, params)?;
        self.retry(Isolation::Snapshot, |tx| tx.execute_all(&stmts))
    }

    pub fn tables(&self) -> Result<Vec<TableDef>> {
        let mut tx = self.begin(Isolation::Snapshot);
        tx.list_tables()
    }
}

impl DbTxn {
    pub fn execute_all(&mut self, stmts: &[Statement]) -> Result<QueryResult> {
        let mut last = QueryResult::default();
        for s in stmts {
            last = self.execute(s)?;
        }
        Ok(last)
    }

    pub fn execute_sql(&mut self, sql: &str, params: &[crate::value::Value]) -> Result<QueryResult> {
        let stmts = crate::sql::parse_sql(sql, params)?;
        self.execute_all(&stmts)
    }
}
