//! WaveDB core engine.
pub mod error;
pub mod kv;

pub use error::{Error, Result};
pub use kv::{Durability, Engine, EngineStats, Isolation, Options, Txn};
