//! Table / index definitions, key layout and DDL.
//!
//! Key space (all inside the MVCC store, so DDL is transactional):
//!
//! ```text
//! 01 ++ table_name                      -> TableDef (JSON)
//! 03 ++ view_name                       -> ViewDef (JSON)
//! 02 6e                                 -> next object id (u32 BE)
//! 10 ++ table_id ++ pk                  -> row
//! 20 ++ index_id ++ cols ++ pk          -> pk            (secondary index entry)
//! 21 ++ index_id ++ cols                -> pk            (unique guard; makes concurrent
//!                                                         duplicate inserts write-conflict)
//! ```

use crate::error::{Error, Result};
use crate::kv::{prefix_range, Txn};
use crate::stmt::SelectStmt;
use crate::value::{decode_row, encode_key_value, encode_row, ColumnType, Value};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

pub const CAT_PREFIX: u8 = 0x01;
pub const VIEW_PREFIX: u8 = 0x03;
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
pub struct ForeignKeyRef {
    pub table: String,
    pub columns: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ForeignKeyDef {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub columns: Vec<String>,
    #[serde(alias = "ref_table")]
    pub ref_table: String,
    #[serde(alias = "ref_columns")]
    pub ref_columns: Vec<String>,
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
pub struct ViewDef {
    pub name: String,
    pub query: SelectStmt,
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
    #[serde(default)]
    pub foreign_keys: Vec<ForeignKeyDef>,
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

pub fn view_key(name: &str) -> Vec<u8> {
    let mut k = vec![VIEW_PREFIX];
    k.extend_from_slice(name.as_bytes());
    k
}

pub fn load_view(txn: &mut Txn, name: &str) -> Result<Option<ViewDef>> {
    match txn.get(&view_key(name))? {
        None => Ok(None),
        Some(b) => Ok(Some(serde_json::from_slice(&b)?)),
    }
}

pub fn create_view(txn: &mut Txn, name: &str, query: SelectStmt, or_replace: bool, if_not_exists: bool) -> Result<()> {
    if !valid_ident(name) {
        return Err(Error::Invalid("invalid view name".into()));
    }
    if load_table(txn, name)?.is_some() {
        return Err(Error::Constraint(format!("table \"{name}\" already exists")));
    }
    match load_view(txn, name)? {
        Some(_) if if_not_exists => return Ok(()),
        Some(_) if or_replace => {}
        Some(_) => return Err(Error::Constraint(format!("view \"{name}\" already exists"))),
        None => {}
    }
    let def = ViewDef { name: name.into(), query };
    txn.put(&view_key(name), &serde_json::to_vec(&def)?)
}

pub fn drop_view(txn: &mut Txn, name: &str, if_exists: bool) -> Result<()> {
    match load_view(txn, name)? {
        Some(_) => txn.delete(&view_key(name)),
        None if if_exists => Ok(()),
        None => Err(Error::NotFound(format!("view \"{name}\" does not exist"))),
    }
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub references: Option<ForeignKeyRef>,
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
    pub foreign_keys: Vec<ForeignKeyDef>,
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
    SetAutoIncrement { enabled: bool },
    AddForeignKey { fk: ForeignKeyDef },
    DropConstraint {
        name: String,
        #[serde(rename = "ifExists", alias = "if_exists")]
        if_exists: bool,
    },
}

fn valid_ident(n: &str) -> bool {
    !n.is_empty() && n.len() <= 128 && !n.contains('\0')
}

fn default_fk_name(table: &str, fk: &ForeignKeyDef) -> String {
    format!("{}_{}_fkey", table, fk.columns.join("_"))
}

fn ensure_fk_names(table: &mut TableDef) {
    for (i, fk) in table.foreign_keys.iter_mut().enumerate() {
        if fk.name.is_none() {
            let name = if i == 0 {
                default_fk_name(&table.name, fk)
            } else {
                format!("{}_{i}", default_fk_name(&table.name, fk))
            };
            fk.name = Some(name);
        }
    }
}

fn fk_defs_equivalent(a: &ForeignKeyDef, b: &ForeignKeyDef) -> bool {
    a.columns == b.columns && a.ref_table == b.ref_table && a.ref_columns == b.ref_columns
}

fn ref_columns_unique_on_parent(parent: &TableDef, ref_columns: &[String]) -> bool {
    if parent.primary_key == ref_columns {
        return true;
    }
    parent
        .indexes
        .iter()
        .any(|idx| idx.unique && idx.columns == ref_columns)
}

fn fk_values(t: &TableDef, row: &[Value], fk: &ForeignKeyDef) -> Result<Vec<Value>> {
    let mut out = Vec::with_capacity(fk.columns.len());
    for c in &fk.columns {
        let p = t
            .col_pos(c)
            .ok_or_else(|| Error::NotFound(format!("column \"{c}\" not found")))?;
        out.push(row[p].clone());
    }
    Ok(out)
}

fn fk_parent_exists(txn: &mut Txn, parent: &TableDef, fk: &ForeignKeyDef, child_vals: &[Value]) -> Result<bool> {
    if child_vals.iter().any(|v| v.is_null()) {
        return Ok(true);
    }
    if fk.ref_columns.len() != child_vals.len() {
        return Err(Error::Invalid("foreign key column count mismatch".into()));
    }
    let mut row = vec![Value::Null; parent.columns.len()];
    for (rc, val) in fk.ref_columns.iter().zip(child_vals) {
        let p = parent
            .col_pos(rc)
            .ok_or_else(|| Error::NotFound(format!("column \"{rc}\" not found in \"{}\"", parent.name)))?;
        row[p] = val.clone();
    }
    for pk_col in &parent.primary_key {
        if row[parent.col_pos(pk_col).unwrap()].is_null() {
            return Ok(false);
        }
    }
    let pk = parent.pk_enc(&row);
    Ok(txn.get(&parent.row_key(&pk))?.is_some())
}

fn fk_violation(child: &TableDef, fk: &ForeignKeyDef) -> Error {
    Error::Constraint(format!(
        "FOREIGN KEY constraint failed: {} ({}) REFERENCES {} ({})",
        child.name,
        fk.columns.join(", "),
        fk.ref_table,
        fk.ref_columns.join(", ")
    ))
}

/// Row-level FK enforcement (shared by DML and `ADD CONSTRAINT`).
fn fk_references_own_primary_key(t: &TableDef, fk: &ForeignKeyDef, row: &[Value]) -> Result<bool> {
    if fk.ref_table != t.name {
        return Ok(false);
    }
    for (c, rc) in fk.columns.iter().zip(&fk.ref_columns) {
        let cv = row[t.col_pos(c).unwrap()].clone();
        let pk_pos = t
            .col_pos(rc)
            .ok_or_else(|| Error::NotFound(format!("column \"{rc}\" not found")))?;
        if cv != row[pk_pos] {
            return Ok(false);
        }
    }
    Ok(true)
}

pub(crate) fn check_row_foreign_keys(txn: &mut Txn, t: &TableDef, row: &[Value]) -> Result<()> {
    for fk in &t.foreign_keys {
        let vals = fk_values(t, row, fk)?;
        if vals.iter().all(|v| v.is_null()) {
            continue;
        }
        if fk_references_own_primary_key(t, fk, row)? {
            continue;
        }
        let parent = if fk.ref_table == t.name {
            t.clone()
        } else {
            require_table(txn, &fk.ref_table)?
        };
        if !fk_parent_exists(txn, &parent, fk, &vals)? {
            return Err(fk_violation(t, fk));
        }
    }
    Ok(())
}

fn validate_existing_rows_foreign_keys(txn: &mut Txn, table: &TableDef) -> Result<()> {
    let (lo, hi) = prefix_range(&table.row_prefix());
    for item in txn.scan(lo, hi, false)? {
        let (_, v) = item?;
        let row = table.decode_value(&v)?;
        check_row_foreign_keys(txn, table, &row)?;
    }
    Ok(())
}

fn fk_column_types_match(child: &TableDef, parent: &TableDef, fk: &ForeignKeyDef) -> Result<()> {
    for (c, rc) in fk.columns.iter().zip(&fk.ref_columns) {
        let ct = child.columns[child.col_pos(c).unwrap()].ty;
        let pt = parent.columns[parent.col_pos(rc).unwrap()].ty;
        if ct != pt {
            return Err(Error::Constraint(format!(
                "foreign key on \"{}\".\"{}\" type {ct:?} does not match referenced column \"{}\".\"{}\" type {pt:?}",
                child.name, c, parent.name, rc
            )));
        }
    }
    Ok(())
}

/// Validate a foreign key definition against the live catalog (DDL-time).
pub fn validate_foreign_key_def(txn: &mut Txn, child: &TableDef, fk: &ForeignKeyDef) -> Result<()> {
    if fk.columns.is_empty() || fk.ref_columns.is_empty() {
        return Err(Error::Invalid("foreign key requires columns".into()));
    }
    if fk.columns.len() != fk.ref_columns.len() {
        return Err(Error::Invalid("foreign key column count mismatch".into()));
    }
    for c in &fk.columns {
        if child.col_pos(c).is_none() {
            return Err(Error::NotFound(format!(
                "column \"{c}\" not found in table \"{}\"",
                child.name
            )));
        }
    }
    let parent = if fk.ref_table == child.name {
        child.clone()
    } else {
        require_table(txn, &fk.ref_table).map_err(|_| {
            Error::Constraint(format!(
                "foreign key references missing table \"{}\"",
                fk.ref_table
            ))
        })?
    };
    for rc in &fk.ref_columns {
        if parent.col_pos(rc).is_none() {
            return Err(Error::Constraint(format!(
                "column \"{rc}\" referenced in foreign key constraint does not exist on table \"{}\"",
                fk.ref_table
            )));
        }
    }
    if !ref_columns_unique_on_parent(&parent, &fk.ref_columns) {
        return Err(Error::Constraint(format!(
            "there is no unique constraint matching given keys for referenced table \"{}\"",
            fk.ref_table
        )));
    }
    fk_column_types_match(child, &parent, fk)
}

fn validate_table_foreign_keys(txn: &mut Txn, table: &TableDef) -> Result<()> {
    for fk in &table.foreign_keys {
        validate_foreign_key_def(txn, table, fk)?;
    }
    Ok(())
}

/// Tables that declare a foreign key referencing `table_name`.
pub fn inbound_fk_dependents(txn: &mut Txn, table_name: &str) -> Result<Vec<String>> {
    let mut deps = Vec::new();
    for t in list_tables(txn)? {
        if t.name == table_name {
            continue;
        }
        if t.foreign_keys
            .iter()
            .any(|fk| fk.ref_table == table_name)
            && !deps.contains(&t.name)
        {
            deps.push(t.name.clone());
        }
    }
    Ok(deps)
}

pub fn list_views(txn: &mut Txn) -> Result<Vec<ViewDef>> {
    let (lo, hi) = prefix_range(&[VIEW_PREFIX]);
    let mut out = Vec::new();
    for item in txn.scan(lo, hi, false)? {
        let (_, v) = item?;
        out.push(serde_json::from_slice(&v)?);
    }
    Ok(out)
}

fn collect_select_base_tables(st: &SelectStmt, out: &mut Vec<String>) {
    for cte in &st.with {
        collect_select_base_tables(&cte.query, out);
    }
    if let Some(from) = &st.from {
        if let Some(sq) = &from.subquery {
            collect_select_base_tables(sq, out);
        } else if !from.name.is_empty() {
            out.push(from.name.clone());
        }
    }
    for j in &st.joins {
        if let Some(sq) = &j.table.subquery {
            collect_select_base_tables(sq, out);
        } else if !j.table.name.is_empty() {
            out.push(j.table.name.clone());
        }
    }
    if let Some(u) = &st.union {
        collect_select_base_tables(&u.right, out);
    }
}

fn views_referencing_table(txn: &mut Txn, table_name: &str) -> Result<Vec<String>> {
    let mut hits = Vec::new();
    for v in list_views(txn)? {
        let mut tables = Vec::new();
        collect_select_base_tables(&v.query, &mut tables);
        if tables.iter().any(|t| t == table_name) && !hits.contains(&v.name) {
            hits.push(v.name.clone());
        }
    }
    Ok(hits)
}

fn unique_index_dependents(txn: &mut Txn, table: &TableDef, idx: &IndexDef) -> Result<Vec<String>> {
    if !idx.unique {
        return Ok(vec![]);
    }
    let cols = &idx.columns;
    let mut deps = Vec::new();
    for t in list_tables(txn)? {
        for fk in &t.foreign_keys {
            if fk.ref_table == table.name && fk.ref_columns == *cols && !deps.contains(&t.name) {
                deps.push(t.name.clone());
            }
        }
    }
    Ok(deps)
}

fn column_fk_dependents(txn: &mut Txn, table: &TableDef, col: &str) -> Result<Vec<String>> {
    let mut deps = Vec::new();
    if table
        .foreign_keys
        .iter()
        .any(|fk| fk.columns.iter().any(|c| c == col))
    {
        deps.push(format!("{} (outbound foreign key)", table.name));
    }
    for t in list_tables(txn)? {
        for fk in &t.foreign_keys {
            if fk.ref_table == table.name && fk.ref_columns.contains(&col.to_string()) {
                let label = format!("{}.foreign key ({})", t.name, fk.columns.join(", "));
                if !deps.contains(&label) {
                    deps.push(label);
                }
            }
        }
    }
    Ok(deps)
}

fn sync_fk_ref_table(txn: &mut Txn, from: &str, to: &str) -> Result<()> {
    for mut t in list_tables(txn)? {
        let mut changed = false;
        for fk in t.foreign_keys.iter_mut() {
            if fk.ref_table == from {
                fk.ref_table = to.to_string();
                changed = true;
            }
        }
        if changed {
            t.version += 1;
            save_table(txn, &t)?;
        }
    }
    Ok(())
}

fn sync_fk_column_rename(txn: &mut Txn, table: &str, from: &str, to: &str) -> Result<()> {
    for mut t in list_tables(txn)? {
        if t.name == table {
            continue;
        }
        let mut changed = false;
        for fk in t.foreign_keys.iter_mut() {
            if fk.ref_table == table {
                for rc in fk.ref_columns.iter_mut() {
                    if rc == from {
                        *rc = to.to_string();
                        changed = true;
                    }
                }
            }
        }
        if changed {
            t.version += 1;
            save_table(txn, &t)?;
        }
    }
    Ok(())
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
    if load_view(txn, &spec.name)?.is_some() {
        return Err(Error::Constraint(format!("view \"{}\" already exists", spec.name)));
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
    let mut foreign_keys = Vec::new();
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
        if let Some(r) = &c.references {
            foreign_keys.push(ForeignKeyDef {
                name: None,
                columns: vec![c.name.clone()],
                ref_table: r.table.clone(),
                ref_columns: r.columns.clone(),
            });
        }
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
        foreign_keys,
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
    for fk in &spec.foreign_keys {
        table.foreign_keys.push(fk.clone());
    }
    ensure_fk_names(&mut table);
    validate_table_foreign_keys(txn, &table)?;
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
            let deps = unique_index_dependents(txn, &t, &idx)?;
            if !deps.is_empty() {
                return Err(Error::Constraint(format!(
                    "cannot drop index \"{}\" because foreign key constraints depend on it: {}",
                    idx.name,
                    deps.join(", ")
                )));
            }
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

pub fn drop_table(txn: &mut Txn, name: &str, if_exists: bool, cascade: bool) -> Result<Option<TableDef>> {
    let mut visiting = HashSet::new();
    drop_table_inner(txn, name, if_exists, cascade, &mut visiting)
}

fn drop_table_inner(
    txn: &mut Txn,
    name: &str,
    if_exists: bool,
    cascade: bool,
    visiting: &mut HashSet<String>,
) -> Result<Option<TableDef>> {
    if visiting.contains(name) {
        return Ok(None);
    }
    visiting.insert(name.to_string());
    let t = match load_table(txn, name)? {
        Some(t) => t,
        None if if_exists => return Ok(None),
        None => return Err(Error::NotFound(format!("table \"{name}\" does not exist"))),
    };
    let fk_deps = inbound_fk_dependents(txn, name)?;
    if !fk_deps.is_empty() {
        if cascade {
            for dep in fk_deps {
                drop_table_inner(txn, &dep, true, true, visiting)?;
            }
        } else {
            return Err(Error::Constraint(format!(
                "cannot drop table \"{name}\" because other objects depend on it: {}",
                fk_deps.join(", ")
            )));
        }
    }
    let view_deps = views_referencing_table(txn, name)?;
    if !view_deps.is_empty() {
        if cascade {
            for v in view_deps {
                drop_view(txn, &v, true)?;
            }
        } else {
            return Err(Error::Constraint(format!(
                "cannot drop table \"{name}\" because view(s) depend on it: {}",
                view_deps.join(", ")
            )));
        }
    }
    delete_prefix(txn, &t.row_prefix())?;
    for idx in &t.indexes {
        drop_index_data(txn, idx)?;
    }
    txn.delete(&catalog_key(name))?;
    visiting.remove(name);
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
            let fk_deps = column_fk_dependents(txn, &t, col)?;
            if !fk_deps.is_empty() {
                return Err(Error::Constraint(format!(
                    "cannot drop column \"{col}\" because foreign key constraints depend on it: {}",
                    fk_deps.join("; ")
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
            for fk in t.foreign_keys.iter_mut() {
                for c in fk.columns.iter_mut() {
                    if c == from {
                        *c = to.to_string();
                    }
                }
                if fk.ref_table == name {
                    for rc in fk.ref_columns.iter_mut() {
                        if rc == from {
                            *rc = to.to_string();
                        }
                    }
                }
            }
            sync_fk_column_rename(txn, name, from, to)?;
        }
        AlterAction::RenameTable { to } => {
            if load_table(txn, to)?.is_some() {
                return Err(Error::Constraint(format!("table \"{to}\" already exists")));
            }
            sync_fk_ref_table(txn, name, to)?;
            for fk in t.foreign_keys.iter_mut() {
                if fk.ref_table == name {
                    fk.ref_table = to.clone();
                }
            }
            txn.delete(&catalog_key(name))?;
            t.name = to.clone();
        }
        AlterAction::AddForeignKey { fk } => {
            let mut fk = fk.clone();
            if fk.name.as_ref().is_some_and(|n| !valid_ident(n)) {
                return Err(Error::Invalid("invalid foreign key constraint name".into()));
            }
            if t.foreign_keys.iter().any(|x| {
                x.name.is_some()
                    && fk.name.is_some()
                    && x.name == fk.name
            }) {
                return Err(Error::Constraint(format!(
                    "constraint \"{}\" for relation \"{}\" already exists",
                    fk.name.as_deref().unwrap_or(""),
                    t.name
                )));
            }
            if t.foreign_keys.iter().any(|x| fk_defs_equivalent(x, &fk)) {
                return Err(Error::Constraint(format!(
                    "foreign key on \"{}\" already exists",
                    t.name
                )));
            }
            if fk.name.is_none() {
                fk.name = Some(default_fk_name(&t.name, &fk));
            }
            t.foreign_keys.push(fk);
            ensure_fk_names(&mut t);
            validate_table_foreign_keys(txn, &t)?;
            validate_existing_rows_foreign_keys(txn, &t)?;
        }
        AlterAction::DropConstraint { name, if_exists } => {
            let pos = t
                .foreign_keys
                .iter()
                .position(|fk| fk.name.as_deref() == Some(name.as_str()));
            match pos {
                Some(p) => {
                    t.foreign_keys.remove(p);
                }
                None if *if_exists => {}
                None => {
                    return Err(Error::NotFound(format!(
                        "constraint \"{name}\" for relation \"{}\" does not exist",
                        t.name
                    )));
                }
            }
        }
        AlterAction::SetAutoIncrement { enabled } => {
            if *enabled {
                if t.primary_key.len() != 1 {
                    return Err(Error::Invalid(
                        "autoIncrement requires a single-column primary key".into(),
                    ));
                }
                let pk = t.col_pos(&t.primary_key[0]).ok_or_else(|| {
                    Error::Invalid("primary key column missing".into())
                })?;
                if t.columns[pk].ty != ColumnType::Int {
                    return Err(Error::Invalid(
                        "autoIncrement requires an integer primary key".into(),
                    ));
                }
            }
            t.auto_increment = *enabled;
        }
    }
    t.version += 1;
    save_table(txn, &t)?;
    Ok(t)
}
