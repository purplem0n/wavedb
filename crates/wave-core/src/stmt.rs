//! Statement IR shared by the SQL front-end and the TypeScript query builder.

use crate::catalog::{AlterAction, IndexSpec, TableSpec};
use crate::expr::Expr;
use crate::value::Value;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct TableRef {
    pub name: String,
    #[serde(default)]
    pub alias: Option<String>,
    /// Derived table / subquery in `FROM` (when set, `name` is unused).
    #[serde(default)]
    pub subquery: Option<Box<SelectStmt>>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct CteEntry {
    pub name: String,
    pub query: SelectStmt,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum JoinKind {
    #[default]
    Inner,
    Left,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Join {
    #[serde(default)]
    pub kind: JoinKind,
    pub table: TableRef,
    pub on: Expr,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "t", rename_all = "camelCase")]
pub enum SelectItem {
    Star {
        #[serde(default)]
        table: Option<String>,
    },
    Expr {
        expr: Expr,
        #[serde(default)]
        alias: Option<String>,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct OrderItem {
    pub expr: Expr,
    #[serde(default)]
    pub desc: bool,
}

/// `UNION` / `UNION ALL` with the right-hand select (left-hand is `self`).
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UnionOp {
    pub all: bool,
    pub right: Box<SelectStmt>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SelectStmt {
    #[serde(default)]
    pub with: Vec<CteEntry>,
    #[serde(default)]
    pub from: Option<TableRef>,
    #[serde(default)]
    pub joins: Vec<Join>,
    #[serde(default)]
    pub columns: Vec<SelectItem>,
    #[serde(default, rename = "where")]
    pub where_: Option<Expr>,
    #[serde(default)]
    pub group_by: Vec<Expr>,
    #[serde(default)]
    pub having: Option<Expr>,
    #[serde(default)]
    pub order_by: Vec<OrderItem>,
    #[serde(default)]
    pub limit: Option<i64>,
    #[serde(default)]
    pub offset: Option<i64>,
    #[serde(default)]
    pub distinct: bool,
    #[serde(default)]
    pub union: Option<UnionOp>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Assign {
    pub column: String,
    pub expr: Expr,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ConflictAction {
    DoNothing,
    DoUpdate { set: Vec<Assign> },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct OnConflict {
    #[serde(default)]
    pub target: Vec<String>,
    #[serde(flatten)]
    pub action: ConflictAction,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InsertStmt {
    pub table: String,
    #[serde(default)]
    pub columns: Option<Vec<String>>,
    pub rows: Vec<Vec<Expr>>,
    #[serde(default)]
    pub on_conflict: Option<OnConflict>,
    #[serde(default)]
    pub returning: Option<Vec<SelectItem>>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct UpdateStmt {
    pub table: String,
    pub set: Vec<Assign>,
    #[serde(default, rename = "where")]
    pub where_: Option<Expr>,
    #[serde(default)]
    pub returning: Option<Vec<SelectItem>>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DeleteStmt {
    pub table: String,
    #[serde(default, rename = "where")]
    pub where_: Option<Expr>,
    #[serde(default)]
    pub returning: Option<Vec<SelectItem>>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Statement {
    Select(SelectStmt),
    Insert(InsertStmt),
    Update(UpdateStmt),
    Delete(DeleteStmt),
    CreateTable(TableSpec),
    #[serde(rename_all = "camelCase")]
    DropTable {
        name: String,
        #[serde(default)]
        if_exists: bool,
    },
    #[serde(rename_all = "camelCase")]
    CreateIndex {
        table: String,
        #[serde(flatten)]
        index: IndexSpec,
        #[serde(default)]
        if_not_exists: bool,
    },
    #[serde(rename_all = "camelCase")]
    DropIndex {
        name: String,
        #[serde(default)]
        table: Option<String>,
        #[serde(default)]
        if_exists: bool,
    },
    AlterTable {
        table: String,
        action: AlterAction,
    },
    Explain {
        stmt: Box<Statement>,
    },
    #[serde(rename_all = "camelCase")]
    CreateView {
        name: String,
        query: SelectStmt,
        #[serde(default)]
        or_replace: bool,
        #[serde(default)]
        if_not_exists: bool,
    },
    #[serde(rename_all = "camelCase")]
    DropView {
        name: String,
        #[serde(default)]
        if_exists: bool,
    },
    Begin,
    Commit,
    Rollback,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct QueryResult {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Value>>,
    pub rows_affected: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_insert_id: Option<Value>,
    /// Wall time spent executing this statement (ms), excluding JSON/API overhead.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<f64>,
}

impl QueryResult {
    pub fn with_duration(mut self, started: std::time::Instant) -> Self {
        self.duration_ms = Some(started.elapsed().as_secs_f64() * 1000.0);
        self
    }
}
