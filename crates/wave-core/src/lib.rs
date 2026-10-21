//! WaveDB core engine: an MVCC/OCC relational store on an LSM substrate.
pub mod catalog;
pub mod db;
pub mod error;
pub mod exec;
pub mod expr;
pub mod kv;
pub mod sql;
pub mod stmt;
pub mod value;

pub use db::Db;
pub use error::{Error, Result};
pub use exec::DbTxn;
pub use kv::{Durability, Engine, EngineStats, Isolation, Options, Txn};
pub use stmt::{QueryResult, Statement};
pub use value::Value;
