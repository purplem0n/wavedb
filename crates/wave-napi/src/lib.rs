//! N-API bindings for WaveDB (Node.js + Bun).
//!
//! Everything crosses the boundary as JSON strings; the TypeScript package owns
//! typing, query building and ergonomics. Errors are thrown as
//! `Error("WAVE_CODE: message")` so the JS side can map them to typed errors.

use napi::bindgen_prelude::*;
use napi::{Error as NapiError, Status};
use napi_derive::napi;
use parking_lot::Mutex;
use std::sync::Arc;
use wave_core::{Db, DbTxn, Durability, Error, Isolation, Options, Statement, Value};

fn to_napi(e: Error) -> NapiError {
    NapiError::new(Status::GenericFailure, format!("{}: {}", e.code(), e))
}

fn parse_params(json: &str) -> std::result::Result<Vec<Value>, Error> {
    if json.is_empty() {
        return Ok(vec![]);
    }
    let v: Vec<Value> = serde_json::from_str(json)?;
    Ok(v)
}

fn parse_stmt(json: &str) -> std::result::Result<Statement, Error> {
    serde_json::from_str(json).map_err(|e| Error::Invalid(format!("bad statement: {e}")))
}

fn iso(s: Option<String>) -> Isolation {
    match s.as_deref() {
        Some("serializable") => Isolation::Serializable,
        _ => Isolation::Snapshot,
    }
}

/// Generic background job returning a JSON string.
pub struct Job {
    f: Option<Box<dyn FnOnce() -> std::result::Result<String, Error> + Send>>,
}

impl Task for Job {
    type Output = String;
    type JsValue = String;

    fn compute(&mut self) -> Result<String> {
        let f = self.f.take().ok_or_else(|| NapiError::from_reason("job already ran"))?;
        f().map_err(to_napi)
    }

    fn resolve(&mut self, _env: Env, output: String) -> Result<String> {
        Ok(output)
    }
}

fn job(f: impl FnOnce() -> std::result::Result<String, Error> + Send + 'static) -> AsyncTask<Job> {
    AsyncTask::new(Job { f: Some(Box::new(f)) })
}

#[napi]
pub struct NativeDb {
    db: Mutex<Option<Db>>,
}

impl NativeDb {
    fn handle(&self) -> Result<Db> {
        self.db
            .lock()
            .clone()
            .ok_or_else(|| to_napi(Error::Invalid("database is closed".into())))
    }
}

#[napi]
impl NativeDb {
    /// `options` is a JSON object: `{ durability?: "sync"|"async", cacheMb?: number, temporary?: boolean }`.
    #[napi(factory)]
    pub fn open(path: String, options: Option<String>) -> Result<NativeDb> {
        let mut opts = Options::default();
        if let Some(o) = options.filter(|s| !s.is_empty()) {
            let j: serde_json::Value = serde_json::from_str(&o).map_err(|e| to_napi(e.into()))?;
            if let Some(d) = j.get("durability").and_then(|d| d.as_str()) {
                opts.durability = match d {
                    "async" => Durability::Async,
                    "sync" => Durability::Sync,
                    other => return Err(to_napi(Error::Invalid(format!("unknown durability {other}")))),
                };
            }
            if let Some(mb) = j.get("cacheMb").and_then(|d| d.as_u64()) {
                opts.cache_bytes = mb * 1024 * 1024;
            }
            if let Some(t) = j.get("temporary").and_then(|d| d.as_bool()) {
                opts.temporary = t;
            }
        }
        let db = Db::open(&path, opts).map_err(to_napi)?;
        Ok(NativeDb {
            db: Mutex::new(Some(db)),
        })
    }

    /// Release this handle. The engine shuts down once every handle/transaction is gone.
    #[napi]
    pub fn close(&self) {
        *self.db.lock() = None;
    }

    #[napi]
    pub fn execute(&self, statement: String) -> Result<AsyncTask<Job>> {
        let db = self.handle()?;
        Ok(job(move || {
            let stmt = parse_stmt(&statement)?;
            Ok(serde_json::to_string(&db.execute(&stmt)?)?)
        }))
    }

    #[napi]
    pub fn execute_sql(&self, sql: String, params: String) -> Result<AsyncTask<Job>> {
        let db = self.handle()?;
        Ok(job(move || {
            let p = parse_params(&params)?;
            Ok(serde_json::to_string(&db.execute_sql(&sql, &p)?)?)
        }))
    }

    #[napi]
    pub fn execute_sync(&self, statement: String) -> Result<String> {
        let db = self.handle()?;
        let stmt = parse_stmt(&statement).map_err(to_napi)?;
        let r = db.execute(&stmt).map_err(to_napi)?;
        serde_json::to_string(&r).map_err(|e| to_napi(e.into()))
    }

    #[napi]
    pub fn execute_sql_sync(&self, sql: String, params: String) -> Result<String> {
        let db = self.handle()?;
        let p = parse_params(&params).map_err(to_napi)?;
        let r = db.execute_sql(&sql, &p).map_err(to_napi)?;
        serde_json::to_string(&r).map_err(|e| to_napi(e.into()))
    }

    /// Start an interactive transaction. `isolation`: "snapshot" (default) | "serializable".
    #[napi]
    pub fn begin(&self, isolation: Option<String>) -> Result<NativeTx> {
        let db = self.handle()?;
        Ok(NativeTx {
            tx: Arc::new(Mutex::new(Some(db.begin(iso(isolation))))),
        })
    }

    #[napi]
    pub fn tables(&self) -> Result<String> {
        let db = self.handle()?;
        let t = db.tables().map_err(to_napi)?;
        serde_json::to_string(&t).map_err(|e| to_napi(e.into()))
    }

    #[napi]
    pub fn stats(&self) -> Result<String> {
        let db = self.handle()?;
        let s = db.engine().stats();
        Ok(serde_json::json!({
            "visibleTs": s.visible_ts,
            "commits": s.commits,
            "conflicts": s.conflicts,
            "rollbacks": s.rollbacks,
            "fsyncs": s.fsyncs,
            "activeTxns": s.active_txns,
            "trackedWrites": s.tracked_writes,
            "diskBytes": s.disk_bytes,
        })
        .to_string())
    }

    /// Remove MVCC versions no snapshot can see; resolves with the number removed.
    #[napi]
    pub fn vacuum(&self) -> Result<AsyncTask<Job>> {
        let db = self.handle()?;
        Ok(job(move || Ok(db.engine().vacuum()?.to_string())))
    }

    #[napi]
    pub fn compact(&self) -> Result<AsyncTask<Job>> {
        let db = self.handle()?;
        Ok(job(move || {
            db.engine().compact()?;
            Ok("null".into())
        }))
    }

    #[napi]
    pub fn flush(&self) -> Result<()> {
        self.handle()?.engine().flush().map_err(to_napi)
    }
}

#[napi]
pub struct NativeTx {
    tx: Arc<Mutex<Option<DbTxn>>>,
}

fn with_tx<T>(
    tx: &Arc<Mutex<Option<DbTxn>>>,
    f: impl FnOnce(&mut DbTxn) -> std::result::Result<T, Error>,
) -> std::result::Result<T, Error> {
    let mut g = tx.lock();
    match g.as_mut() {
        Some(t) => f(t),
        None => Err(Error::Closed),
    }
}

#[napi]
impl NativeTx {
    #[napi]
    pub fn execute(&self, statement: String) -> AsyncTask<Job> {
        let tx = self.tx.clone();
        job(move || {
            let stmt = parse_stmt(&statement)?;
            let r = with_tx(&tx, |t| t.execute(&stmt))?;
            Ok(serde_json::to_string(&r)?)
        })
    }

    #[napi]
    pub fn execute_sql(&self, sql: String, params: String) -> AsyncTask<Job> {
        let tx = self.tx.clone();
        job(move || {
            let p = parse_params(&params)?;
            let r = with_tx(&tx, |t| t.execute_sql(&sql, &p))?;
            Ok(serde_json::to_string(&r)?)
        })
    }

    #[napi]
    pub fn execute_sync(&self, statement: String) -> Result<String> {
        let stmt = parse_stmt(&statement).map_err(to_napi)?;
        let r = with_tx(&self.tx, |t| t.execute(&stmt)).map_err(to_napi)?;
        serde_json::to_string(&r).map_err(|e| to_napi(e.into()))
    }

    #[napi]
    pub fn execute_sql_sync(&self, sql: String, params: String) -> Result<String> {
        let p = parse_params(&params).map_err(to_napi)?;
        let r = with_tx(&self.tx, |t| t.execute_sql(&sql, &p)).map_err(to_napi)?;
        serde_json::to_string(&r).map_err(|e| to_napi(e.into()))
    }

    /// Commit (validates and fsyncs per the database durability). Resolves `{commitTs, keysWritten}`.
    #[napi]
    pub fn commit(&self) -> AsyncTask<Job> {
        let tx = self.tx.clone();
        job(move || {
            let t = tx.lock().take().ok_or(Error::Closed)?;
            let info = t.commit()?;
            Ok(serde_json::json!({"commitTs": info.commit_ts, "keysWritten": info.keys_written}).to_string())
        })
    }

    #[napi]
    pub fn rollback(&self) {
        if let Some(t) = self.tx.lock().take() {
            t.rollback();
        }
    }
}

/// Library version string.
#[napi]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}
