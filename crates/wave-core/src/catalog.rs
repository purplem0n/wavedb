//! Table / index definitions, key layout and DDL.
//!
//! Key space (all inside the MVCC store, so DDL is transactional):
//!
//! ```text
//! 01 ++ table_name                      -> TableDef (JSON)
//! 02 6e                                 -> next object id (u32 BE)
//! 10 ++ table_id ++ pk                  -> row
//! 20 ++ index_id ++ cols ++ pk          -> pk            (secondary index entry)
//! 21 ++ index_id ++ cols                -> pk            (unique guard; makes concurrent
//!                                                         duplicate inserts write-conflict)
//! ```

use crate::error::{Error, Result};
use crate::kv::{prefix_range, Txn};
use crate::value::{decode_row, encode_key_value, encode_row, ColumnType, Value};
use serde::{Deserialize, Serialize};

pub const CAT_PREFIX: u8 = 0x01;
pub const META_NEXT_ID: [u8; 2] = [0x02, b'n'];
pub const ROW_PREFIX: u8 = 0x10;
pub const IDX_PREFIX: u8 = 0x20;
pub const UNIQ_PREFIX: u8 = 0x21;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ColDefault {
    Value { v: Value },
    Now,
    Uuid7,
    Uuid4,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct ColumnDef {
    pub id: u16,
    pub name: String,
    #[serde(rename = "type")]
    pub ty: ColumnType,
    #[serde(default)]
    pub nullable: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default: Option<ColDefault>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct IndexDef {
    pub id: u32,
    pub name: String,
    pub columns: Vec<String>,
    #[serde(default)]
    pub unique: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TableDef {
    pub id: u32,
    pub name: String,
    pub columns: Vec<ColumnDef>,
    pub primary_key: Vec<String>,
    #[serde(default)]
    pub auto_increment: bool,
    #[serde(default)]
    pub indexes: Vec<IndexDef>,
    pub next_col_id: u16,
    /// Bumped on every schema change.
    #[serde(default)]
    pub version: u32,
}

impl TableDef {
    pub fn col_pos(&self, name: &str) -> Option<usize> {
        self.columns.iter().position(|c| c.name == name)
    }

    pub fn pk_positions(&self) -> Vec<usize> {
        self.primary_key
            .iter()
            .map(|n| self.col_pos(n).expect("pk column exists"))
            .collect()
    }

    pub fn row_prefix(&self) -> Vec<u8> {
        let mut k = vec![ROW_PREFIX];
        k.extend_from_slice(&self.id.to_be_bytes());
        k
    }

    pub fn pk_enc(&self, row: &[Value]) -> Vec<u8> {
        let mut out = Vec::new();
        for p in self.pk_positions() {
            encode_key_value(&row[p], &mut out);
        }
        out
    }

    pub fn row_key(&self, pk_enc: &[u8]) -> Vec<u8> {
        let mut k = self.row_prefix();
        k.extend_from_slice(pk_enc);
        k
    }

    pub fn index_prefix(idx: &IndexDef) -> Vec<u8> {
        let mut k = vec![IDX_PREFIX];
        k.extend_from_slice(&idx.id.to_be_bytes());
        k
    }

    pub fn index_cols_enc(&self, idx: &IndexDef, row: &[Value]) -> Vec<u8> {
        let mut out = Vec::new();
        for c in &idx.columns {
            let p = self.col_pos(c).expect("index column exists");
            encode_key_value(&row[p], &mut out);
        }
        out
    }

    pub fn index_has_null(&self, idx: &IndexDef, row: &[Value]) -> bool {
        idx.columns
            .iter()
            .any(|c| row[self.col_pos(c).unwrap()].is_null())
    }

    pub fn index_key(&self, idx: &IndexDef, row: &[Value], pk_enc: &[u8]) -> Vec<u8> {
        let mut k = Self::index_prefix(idx);
        k.extend_from_slice(&self.index_cols_enc(idx, row));
        k.extend_from_slice(pk_enc);
        k
    }

    pub fn guard_key(&self, idx: &IndexDef, row: &[Value]) -> Vec<u8> {
        let mut k = vec![UNIQ_PREFIX];
        k.extend_from_slice(&idx.id.to_be_bytes());
        k.extend_from_slice(&self.index_cols_enc(idx, row));
        k
    }

    pub fn encode_value(&self, row: &[Value]) -> Vec<u8> {
        let cols: Vec<(u16, &Value)> = self
            .columns
            .iter()
            .zip(row.iter())
            .map(|(c, v)| (c.id, v))
            .collect();
        encode_row(&cols)
    }

    pub fn decode_value(&self, bytes: &[u8]) -> Result<Vec<Value>> {
        let pairs = decode_row(bytes)?;
        let mut row: Vec<Value> = Vec::with_capacity(self.columns.len());
        for c in &self.columns {
            let v = pairs
                .iter()
                .find(|(id, _)| *id == c.id)
                .map(|(_, v)| v.clone());
            row.push(match v {
                Some(v) => v,
                // column added after this row was written -> constant default
                None => match &c.default {
                    Some(ColDefault::Value { v }) => v.clone(),
                    _ => Value::Null,
                },
            });
        }
        Ok(row)
    }
}

pub fn catalog_key(name: &str) -> Vec<u8> {
    let mut k = vec![CAT_PREFIX];
    k.extend_from_slice(name.as_bytes());
    k
}

pub fn load_table(txn: &mut Txn, name: &str) -> Result<Option<TableDef>> {
    match txn.get(&catalog_key(name))? {
        None => Ok(None),
        Some(b) => Ok(Some(serde_json::from_slice(&b)?)),
    }
}

pub fn require_table(txn: &mut Txn, name: &str) -> Result<TableDef> {
    load_table(txn, name)?.ok_or_else(|| Error::NotFound(format!("table \"{name}\" does not exist")))
}

pub fn list_tables(txn: &mut Txn) -> Result<Vec<TableDef>> {
    let (lo, hi) = prefix_range(&[CAT_PREFIX]);
    let mut out = Vec::new();
    for item in txn.scan(lo, hi, false)? {
        let (_, v) = item?;
        out.push(serde_json::from_slice(&v)?);
    }
    Ok(out)
}

fn save_table(txn: &mut Txn, t: &TableDef) -> Result<()> {
    txn.put(&catalog_key(&t.name), &serde_json::to_vec(t)?)
}

fn alloc_id(txn: &mut Txn) -> Result<u32> {
    let cur = match txn.get(&META_NEXT_ID)? {
        Some(b) if b.len() == 4 => u32::from_be_bytes(b[..4].try_into().unwrap()),
        _ => 1,
    };
    txn.put(&META_NEXT_ID, &(cur + 1).to_be_bytes())?;
    Ok(cur)
}

// ---------------------------------------------------------------------------
// DDL specs (JSON IR)
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnSpec {
    pub name: String,
    #[serde(rename = "type")]
    pub ty: ColumnType,
    #[serde(default = "yes")]
    pub nullable: bool,
    #[serde(default)]
    pub default: Option<ColDefault>,
    #[serde(default)]
    pub unique: bool,
    #[serde(default)]
    pub primary_key: bool,
    #[serde(default)]
    pub auto_increment: bool,
}

fn yes() -> bool {
    true
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexSpec {
    #[serde(default)]
    pub name: Option<String>,
    pub columns: Vec<String>,
    #[serde(default)]
    pub unique: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableSpec {
    pub name: String,
    pub columns: Vec<ColumnSpec>,
    #[serde(default)]
    pub primary_key: Option<Vec<String>>,
    #[serde(default)]
    pub indexes: Vec<IndexSpec>,
    #[serde(default)]
    pub if_not_exists: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum AlterAction {
    AddColumn { column: ColumnSpec },
    DropColumn { name: String },
    RenameColumn { from: String, to: String },
    RenameTable { to: String },
}

fn valid_ident(n: &str) -> bool {
    !n.is_empty() && n.len() <= 128 && !n.contains('\0')
}

pub fn create_table(txn: &mut Txn, spec: &TableSpec) -> Result<Option<TableDef>> {
    if !valid_ident(&spec.name) {
        return Err(Error::Invalid("invalid table name".into()));
    }
    if load_table(txn, &spec.name)?.is_some() {
        if spec.if_not_exists {
            return Ok(None);
        }
        return Err(Error::Constraint(format!("table \"{}\" already exists", spec.name)));
    }
    if spec.columns.is_empty() {
        return Err(Error::Invalid("table needs at least one column".into()));
    }
    let mut pk: Vec<String> = spec.primary_key.clone().unwrap_or_default();
    let inline_pk: Vec<String> = spec
        .columns
        .iter()
        .filter(|c| c.primary_key)
        .map(|c| c.name.clone())
        .collect();
    if pk.is_empty() {
        pk = inline_pk;
    }
    if pk.is_empty() {
        return Err(Error::Invalid(format!(
            "table \"{}\" requires a PRIMARY KEY",
            spec.name
        )));
    }
    let mut columns = Vec::new();
    let mut auto_increment = false;
    for (i, c) in spec.columns.iter().enumerate() {
        if !valid_ident(&c.name) {
            return Err(Error::Invalid("invalid column name".into()));
        }
        if columns.iter().any(|x: &ColumnDef| x.name == c.name) {
            return Err(Error::Invalid(format!("duplicate column \"{}\"", c.name)));
        }
        let is_pk = pk.contains(&c.name);
        if c.auto_increment {
            if pk.len() != 1 || !is_pk || c.ty != ColumnType::Int {
                return Err(Error::Invalid(
                    "autoIncrement requires a single integer primary key".into(),
                ));
            }
            auto_increment = true;
        }
        columns.push(ColumnDef {
            id: i as u16,
            name: c.name.clone(),
            ty: c.ty,
            nullable: c.nullable && !is_pk,
            default: c.default.clone(),
        });
    }
    for p in &pk {
        if !columns.iter().any(|c| &c.name == p) {
            return Err(Error::Invalid(format!("primary key column \"{p}\" not found")));
        }
    }
    let id = alloc_id(txn)?;
    let mut table = TableDef {
        id,
        name: spec.name.clone(),
        columns,
        primary_key: pk,
        auto_increment,
        indexes: vec![],
        next_col_id: spec.columns.len() as u16,
        version: 1,
    };
    let mut idx_specs: Vec<IndexSpec> = spec.indexes.clone();
    for c in &spec.columns {
        if c.unique && !table.primary_key.contains(&c.name) {
            idx_specs.push(IndexSpec {
                name: None,
                columns: vec![c.name.clone()],
                unique: true,
            });
        }
    }
    for is in &idx_specs {
        add_index_def(txn, &mut table, is)?;
    }
    save_table(txn, &table)?;
    Ok(Some(table))
}

fn add_index_def(txn: &mut Txn, table: &mut TableDef, is: &IndexSpec) -> Result<IndexDef> {
    if is.columns.is_empty() {
        return Err(Error::Invalid("index needs at least one column".into()));
    }
    for c in &is.columns {
        if table.col_pos(c).is_none() {
            return Err(Error::NotFound(format!(
                "column \"{c}\" not found in table \"{}\"",
                table.name
            )));
        }
    }
    let name = is.name.clone().unwrap_or_else(|| {
        format!(
            "{}_{}_{}",
            table.name,
            is.columns.join("_"),
            if is.unique { "key" } else { "idx" }
        )
    });
    if table.indexes.iter().any(|i| i.name == name) {
        return Err(Error::Constraint(format!("index \"{name}\" already exists")));
    }
    let def = IndexDef {
        id: alloc_id(txn)?,
        name,
        columns: is.columns.clone(),
        unique: is.unique,
    };
    table.indexes.push(def.clone());
    Ok(def)
}

/// Create an index and backfill it from existing rows.
pub fn create_index(
    txn: &mut Txn,
    table_name: &str,
    spec: &IndexSpec,
    if_not_exists: bool,
) -> Result<()> {
    let mut table = require_table(txn, table_name)?;
    if let Some(n) = &spec.name {
        if table.indexes.iter().any(|i| &i.name == n) {
            if if_not_exists {
                return Ok(());
            }
        }
    }
    let idx = add_index_def(txn, &mut table, spec)?;
    table.version += 1;
    // backfill
    let (lo, hi) = prefix_range(&table.row_prefix());
    let prefix_len = table.row_prefix().len();
    let rows: Vec<(Vec<u8>, Vec<u8>)> = txn.scan(lo, hi, false)?.collect::<Result<_>>()?;
    for (k, v) in rows {
        let row = table.decode_value(&v)?;
        let pk_enc = &k[prefix_len..];
        if idx.unique && !table.index_has_null(&idx, &row) {
            let gk = table.guard_key(&idx, &row);
            if txn.get(&gk)?.is_some() {
                return Err(Error::Constraint(format!(
                    "cannot create unique index \"{}\": duplicate values exist",
                    idx.name
                )));
            }
            txn.put(&gk, pk_enc)?;
        }
        txn.put(&table.index_key(&idx, &row, pk_enc), pk_enc)?;
    }
    save_table(txn, &table)
}

fn delete_prefix(txn: &mut Txn, prefix: &[u8]) -> Result<()> {
    let (lo, hi) = prefix_range(prefix);
    let keys: Vec<Vec<u8>> = txn
        .scan(lo, hi, false)?
        .map(|r| r.map(|(k, _)| k))
        .collect::<Result<_>>()?;
    for k in keys {
        txn.delete(&k)?;
    }
    Ok(())
}

fn drop_index_data(txn: &mut Txn, idx: &IndexDef) -> Result<()> {
    delete_prefix(txn, &TableDef::index_prefix(idx))?;
    let mut g = vec![UNIQ_PREFIX];
    g.extend_from_slice(&idx.id.to_be_bytes());
    delete_prefix(txn, &g)
}

pub fn drop_index(txn: &mut Txn, name: &str, table: Option<&str>, if_exists: bool) -> Result<()> {
    let tables = match table {
        Some(t) => vec![require_table(txn, t)?],
        None => list_tables(txn)?,
    };
    for mut t in tables {
        if let Some(pos) = t.indexes.iter().position(|i| i.name == name) {
            let idx = t.indexes.remove(pos);
            drop_index_data(txn, &idx)?;
            t.version += 1;
            return save_table(txn, &t);
        }
    }
    if if_exists {
        Ok(())
    } else {
        Err(Error::NotFound(format!("index \"{name}\" does not exist")))
    }
}

pub fn drop_table(txn: &mut Txn, name: &str, if_exists: bool) -> Result<Option<TableDef>> {
    let t = match load_table(txn, name)? {
        Some(t) => t,
        None if if_exists => return Ok(None),
        None => return Err(Error::NotFound(format!("table \"{name}\" does not exist"))),
    };
    delete_prefix(txn, &t.row_prefix())?;
    for idx in &t.indexes {
        drop_index_data(txn, idx)?;
    }
    txn.delete(&catalog_key(name))?;
    Ok(Some(t))
}

pub fn alter_table(txn: &mut Txn, name: &str, action: &AlterAction) -> Result<TableDef> {
    let mut t = require_table(txn, name)?;
    match action {
        AlterAction::AddColumn { column } => {
            if t.col_pos(&column.name).is_some() {
                return Err(Error::Constraint(format!("column \"{}\" already exists", column.name)));
            }
            if column.primary_key {
                return Err(Error::Invalid("cannot add a primary key column".into()));
            }
            if !column.nullable && column.default.is_none() {
                return Err(Error::Invalid(
                    "adding a NOT NULL column requires a DEFAULT".into(),
                ));
            }
            t.columns.push(ColumnDef {
                id: t.next_col_id,
                name: column.name.clone(),
                ty: column.ty,
                nullable: column.nullable,
                default: column.default.clone(),
            });
            t.next_col_id += 1;
            if column.unique {
                add_index_def(
                    txn,
                    &mut t,
                    &IndexSpec {
                        name: None,
                        columns: vec![column.name.clone()],
                        unique: true,
                    },
                )?;
            }
        }
        AlterAction::DropColumn { name: col } => {
            if t.col_pos(col).is_none() {
                return Err(Error::NotFound(format!("column \"{col}\" not found")));
            }
            if t.primary_key.contains(col) {
                return Err(Error::Invalid("cannot drop a primary key column".into()));
            }
            if t.indexes.iter().any(|i| i.columns.contains(col)) {
                return Err(Error::Invalid(format!(
                    "column \"{col}\" is used by an index; drop the index first"
                )));
            }
            t.columns.retain(|c| &c.name != col);
        }
        AlterAction::RenameColumn { from, to } => {
            if t.col_pos(to).is_some() {
                return Err(Error::Constraint(format!("column \"{to}\" already exists")));
            }
            let pos = t
                .col_pos(from)
                .ok_or_else(|| Error::NotFound(format!("column \"{from}\" not found")))?;
            t.columns[pos].name = to.clone();
            for p in t.primary_key.iter_mut() {
                if p == from {
                    *p = to.clone();
                }
            }
            for i in t.indexes.iter_mut() {
                for c in i.columns.iter_mut() {
                    if c == from {
                        *c = to.clone();
                    }
                }
            }
        }
        AlterAction::RenameTable { to } => {
            if load_table(txn, to)?.is_some() {
                return Err(Error::Constraint(format!("table \"{to}\" already exists")));
            }
            txn.delete(&catalog_key(name))?;
            t.name = to.clone();
        }
    }
    t.version += 1;
    save_table(txn, &t)?;
    Ok(t)
}
