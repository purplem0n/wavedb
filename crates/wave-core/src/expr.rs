//! Expression IR (JSON-serializable), binder and evaluator.

use crate::error::{Error, Result};
use crate::stmt::SelectStmt;
use crate::value::{now_ms, sql_cmp, uuid4, uuid7, ColumnType, Value};
use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::sync::Arc;

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub enum BinOp {
    #[serde(rename = "=")]
    Eq,
    #[serde(rename = "!=")]
    Ne,
    #[serde(rename = "<")]
    Lt,
    #[serde(rename = "<=")]
    Le,
    #[serde(rename = ">")]
    Gt,
    #[serde(rename = ">=")]
    Ge,
    #[serde(rename = "+")]
    Add,
    #[serde(rename = "-")]
    Sub,
    #[serde(rename = "*")]
    Mul,
    #[serde(rename = "/")]
    Div,
    #[serde(rename = "%")]
    Mod,
    #[serde(rename = "and")]
    And,
    #[serde(rename = "or")]
    Or,
    #[serde(rename = "||")]
    Concat,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "t", rename_all = "camelCase")]
pub enum Expr {
    Col {
        #[serde(default)]
        table: Option<String>,
        name: String,
    },
    Lit {
        v: Value,
    },
    Bin {
        op: BinOp,
        l: Box<Expr>,
        r: Box<Expr>,
    },
    Not {
        e: Box<Expr>,
    },
    Neg {
        e: Box<Expr>,
    },
    IsNull {
        e: Box<Expr>,
        #[serde(default)]
        negated: bool,
    },
    In {
        e: Box<Expr>,
        list: Vec<Expr>,
        #[serde(default)]
        negated: bool,
    },
    Between {
        e: Box<Expr>,
        lo: Box<Expr>,
        hi: Box<Expr>,
        #[serde(default)]
        negated: bool,
    },
    Like {
        e: Box<Expr>,
        pattern: Box<Expr>,
        #[serde(default)]
        negated: bool,
        #[serde(default)]
        ci: bool,
    },
    Func {
        name: String,
        #[serde(default)]
        args: Vec<Expr>,
        #[serde(default)]
        distinct: bool,
        #[serde(default)]
        star: bool,
    },
    Case {
        #[serde(default)]
        operand: Option<Box<Expr>>,
        whens: Vec<(Expr, Expr)>,
        #[serde(default, rename = "else")]
        else_: Option<Box<Expr>>,
    },
    Subquery {
        query: Box<SelectStmt>,
        #[serde(default)]
        scalar: bool,
    },
    InSubquery {
        e: Box<Expr>,
        query: Box<SelectStmt>,
        #[serde(default)]
        negated: bool,
    },
}

impl Expr {
    pub fn lit(v: Value) -> Expr {
        Expr::Lit { v }
    }
    pub fn col(name: &str) -> Expr {
        Expr::Col {
            table: None,
            name: name.into(),
        }
    }
    pub fn bin(op: BinOp, l: Expr, r: Expr) -> Expr {
        Expr::Bin {
            op,
            l: Box::new(l),
            r: Box::new(r),
        }
    }
}

// ---------------------------------------------------------------------------
// bound expressions
// ---------------------------------------------------------------------------

#[derive(Clone, Debug)]
pub enum BExpr {
    Col(usize),
    Lit(Value),
    Bin(BinOp, Box<BExpr>, Box<BExpr>),
    Not(Box<BExpr>),
    Neg(Box<BExpr>),
    IsNull(Box<BExpr>, bool),
    In(Box<BExpr>, Vec<BExpr>, bool),
    Between(Box<BExpr>, Box<BExpr>, Box<BExpr>, bool),
    Like(Box<BExpr>, Box<BExpr>, bool, bool),
    Func(String, Vec<BExpr>),
    Case(Option<Box<BExpr>>, Vec<(BExpr, BExpr)>, Option<Box<BExpr>>),
    /// Reference to the n-th aggregate result of the current group.
    Agg(usize),
    /// Materialized uncorrelated scalar subquery (single column, first row).
    SubqueryScalar(Arc<SubqueryResult>),
    /// Materialized uncorrelated `IN (SELECT …)` (compare to column 0).
    InSubquery(Box<BExpr>, Arc<SubqueryResult>, bool),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AggFunc {
    Count,
    Sum,
    Avg,
    Min,
    Max,
}

#[derive(Clone, Debug)]
pub struct AggSpec {
    pub func: AggFunc,
    pub arg: Option<BExpr>,
    pub distinct: bool,
    pub key: String,
}

#[derive(Clone, Debug, Default)]
pub struct Layout {
    /// (source alias, column name)
    pub cols: Vec<(String, String)>,
}

impl Layout {
    pub fn resolve(&self, table: Option<&str>, name: &str) -> Result<usize> {
        let mut found = None;
        for (i, (a, n)) in self.cols.iter().enumerate() {
            if n == name && table.map_or(true, |t| t == a) {
                if found.is_some() {
                    return Err(Error::Sql(format!("ambiguous column \"{name}\"")));
                }
                found = Some(i);
            }
        }
        found.ok_or_else(|| match table {
            Some(t) => Error::NotFound(format!("column \"{t}.{name}\" not found")),
            None => Error::NotFound(format!("column \"{name}\" not found")),
        })
    }
}

pub struct BindCx<'a> {
    pub layout: &'a Layout,
    pub aggs: Vec<AggSpec>,
    pub allow_aggs: bool,
    /// Select-list aliases usable in ORDER BY / HAVING.
    pub aliases: Vec<(String, Expr)>,
    /// Materialized subquery results indexed by id.
    pub subqueries: &'a [SubqueryResult],
    pub next_subquery: usize,
}

#[derive(Clone, Debug)]
pub struct SubqueryResult {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Value>>,
}

impl<'a> BindCx<'a> {
    pub fn new(layout: &'a Layout) -> Self {
        BindCx {
            layout,
            aggs: vec![],
            allow_aggs: false,
            aliases: vec![],
            subqueries: &[],
            next_subquery: 0,
        }
    }

    pub fn take_subquery_id(&mut self) -> Result<usize> {
        let id = self.next_subquery;
        if id >= self.subqueries.len() {
            return Err(Error::Sql("internal error: subquery not materialized".into()));
        }
        self.next_subquery += 1;
        Ok(id)
    }
}

pub fn agg_func(name: &str) -> Option<AggFunc> {
    match name.to_ascii_lowercase().as_str() {
        "count" => Some(AggFunc::Count),
        "sum" => Some(AggFunc::Sum),
        "avg" => Some(AggFunc::Avg),
        "min" => Some(AggFunc::Min),
        "max" => Some(AggFunc::Max),
        _ => None,
    }
}

fn walk_expr(e: &Expr, f: &mut impl FnMut(&Expr)) {
    f(e);
    match e {
        Expr::Bin { l, r, .. } => {
            walk_expr(l, f);
            walk_expr(r, f);
        }
        Expr::Not { e } | Expr::Neg { e } | Expr::IsNull { e, .. } => walk_expr(e, f),
        Expr::In { e, list, .. } => {
            walk_expr(e, f);
            for x in list {
                walk_expr(x, f);
            }
        }
        Expr::Between { e, lo, hi, .. } => {
            walk_expr(e, f);
            walk_expr(lo, f);
            walk_expr(hi, f);
        }
        Expr::Like { e, pattern, .. } => {
            walk_expr(e, f);
            walk_expr(pattern, f);
        }
        Expr::Func { args, .. } => {
            for a in args {
                walk_expr(a, f);
            }
        }
        Expr::Case {
            operand,
            whens,
            else_,
        } => {
            if let Some(o) = operand {
                walk_expr(o, f);
            }
            for (a, b) in whens {
                walk_expr(a, f);
                walk_expr(b, f);
            }
            if let Some(o) = else_ {
                walk_expr(o, f);
            }
        }
        Expr::Subquery { .. } | Expr::InSubquery { .. } | Expr::Col { .. } | Expr::Lit { .. } => {}
    }
}

/// Visit subquery bodies in the same order `bind()` assigns materialization ids.
pub fn walk_subqueries_in_expr(e: &Expr, f: &mut impl FnMut(&SelectStmt)) {
    walk_expr(e, &mut |node| match node {
        Expr::Subquery { query, .. } => f(query),
        Expr::InSubquery { query, .. } => f(query),
        _ => {}
    });
}

pub fn contains_agg(e: &Expr) -> bool {
    match e {
        Expr::Func { name, args, .. } => {
            let is_agg = agg_func(name).is_some() && (args.len() == 1 || name.eq_ignore_ascii_case("count"));
            is_agg || args.iter().any(contains_agg)
        }
        Expr::Bin { l, r, .. } => contains_agg(l) || contains_agg(r),
        Expr::Not { e } | Expr::Neg { e } | Expr::IsNull { e, .. } => contains_agg(e),
        Expr::In { e, list, .. } => contains_agg(e) || list.iter().any(contains_agg),
        Expr::InSubquery { e, .. } => contains_agg(e),
        Expr::Between { e, lo, hi, .. } => contains_agg(e) || contains_agg(lo) || contains_agg(hi),
        Expr::Like { e, pattern, .. } => contains_agg(e) || contains_agg(pattern),
        Expr::Subquery { query, .. } => stmt_contains_agg(query),
        Expr::Case {
            operand,
            whens,
            else_,
        } => {
            operand.as_deref().map_or(false, contains_agg)
                || whens.iter().any(|(a, b)| contains_agg(a) || contains_agg(b))
                || else_.as_deref().map_or(false, contains_agg)
        }
        _ => false,
    }
}

/// True when the statement references a table alias defined outside its own `FROM`.
pub fn references_outer_aliases(st: &SelectStmt, outer: &std::collections::HashSet<String>) -> bool {
    fn expr_hit(e: &Expr, outer: &std::collections::HashSet<String>) -> bool {
        match e {
            Expr::Col { table: Some(t), .. } if outer.contains(t) => true,
            Expr::Bin { l, r, .. } => expr_hit(l, outer) || expr_hit(r, outer),
            Expr::Not { e } | Expr::Neg { e } | Expr::IsNull { e, .. } => expr_hit(e, outer),
            Expr::In { e, list, .. } => expr_hit(e, outer) || list.iter().any(|x| expr_hit(x, outer)),
            Expr::InSubquery { e, query, .. } => expr_hit(e, outer) || references_outer_aliases(query, outer),
            Expr::Between { e, lo, hi, .. } => {
                expr_hit(e, outer) || expr_hit(lo, outer) || expr_hit(hi, outer)
            }
            Expr::Like { e, pattern, .. } => expr_hit(e, outer) || expr_hit(pattern, outer),
            Expr::Func { args, .. } => args.iter().any(|a| expr_hit(a, outer)),
            Expr::Case {
                operand,
                whens,
                else_,
            } => {
                operand.as_deref().map_or(false, |o| expr_hit(o, outer))
                    || whens.iter().any(|(a, b)| expr_hit(a, outer) || expr_hit(b, outer))
                    || else_.as_deref().map_or(false, |o| expr_hit(o, outer))
            }
            Expr::Subquery { query, .. } => references_outer_aliases(query, outer),
            _ => false,
        }
    }
    st.where_.as_ref().map_or(false, |e| expr_hit(e, outer))
        || st.group_by.iter().any(|g| expr_hit(g, outer))
        || st.having.as_ref().map_or(false, |e| expr_hit(e, outer))
        || st.order_by.iter().any(|o| expr_hit(&o.expr, outer))
        || st.columns.iter().any(|c| match c {
            crate::stmt::SelectItem::Expr { expr, .. } => expr_hit(expr, outer),
            _ => false,
        })
        || st.joins.iter().any(|j| expr_hit(&j.on, outer))
        || st.from.as_ref().map_or(false, |f| {
            f.subquery
                .as_deref()
                .map_or(false, |q| references_outer_aliases(q, outer))
        })
        || st.with.iter().any(|c| references_outer_aliases(&c.query, outer))
}

pub fn collect_subqueries(st: &SelectStmt) -> Vec<SelectStmt> {
    let mut out = vec![];
    let mut take = |q: &SelectStmt| out.push(q.clone());
    for j in &st.joins {
        walk_subqueries_in_expr(&j.on, &mut take);
    }
    if let Some(w) = &st.where_ {
        walk_subqueries_in_expr(w, &mut take);
    }
    for g in &st.group_by {
        walk_subqueries_in_expr(g, &mut take);
    }
    for c in &st.columns {
        if let crate::stmt::SelectItem::Expr { expr, .. } = c {
            walk_subqueries_in_expr(expr, &mut take);
        }
    }
    if let Some(h) = &st.having {
        walk_subqueries_in_expr(h, &mut take);
    }
    for o in &st.order_by {
        walk_subqueries_in_expr(&o.expr, &mut take);
    }
    out
}

pub fn stmt_contains_agg(st: &SelectStmt) -> bool {
    use crate::stmt::SelectItem;
    st.where_.as_ref().map_or(false, contains_agg)
        || st.group_by.iter().any(|g| contains_agg(g))
        || st.having.as_ref().map_or(false, contains_agg)
        || st.order_by.iter().any(|o| contains_agg(&o.expr))
        || st.columns.iter().any(|c| match c {
            SelectItem::Expr { expr, .. } => contains_agg(expr),
            _ => false,
        })
        || st.joins.iter().any(|j| contains_agg(&j.on))
}

pub fn bind(e: &Expr, cx: &mut BindCx) -> Result<BExpr> {
    Ok(match e {
        Expr::Col { table, name } => {
            if table.is_none() {
                // alias reference (only if no real column of that name)
                if cx.layout.resolve(None, name).is_err() {
                    if let Some((_, aliased)) = cx.aliases.iter().find(|(a, _)| a == name).cloned() {
                        let saved = std::mem::take(&mut cx.aliases);
                        let r = bind(&aliased, cx);
                        cx.aliases = saved;
                        return r;
                    }
                }
            }
            BExpr::Col(cx.layout.resolve(table.as_deref(), name)?)
        }
        Expr::Lit { v } => BExpr::Lit(v.clone()),
        Expr::Bin { op, l, r } => BExpr::Bin(*op, Box::new(bind(l, cx)?), Box::new(bind(r, cx)?)),
        Expr::Not { e } => BExpr::Not(Box::new(bind(e, cx)?)),
        Expr::Neg { e } => BExpr::Neg(Box::new(bind(e, cx)?)),
        Expr::IsNull { e, negated } => BExpr::IsNull(Box::new(bind(e, cx)?), *negated),
        Expr::In { e, list, negated } => BExpr::In(
            Box::new(bind(e, cx)?),
            list.iter().map(|x| bind(x, cx)).collect::<Result<_>>()?,
            *negated,
        ),
        Expr::Between { e, lo, hi, negated } => BExpr::Between(
            Box::new(bind(e, cx)?),
            Box::new(bind(lo, cx)?),
            Box::new(bind(hi, cx)?),
            *negated,
        ),
        Expr::Like {
            e,
            pattern,
            negated,
            ci,
        } => BExpr::Like(
            Box::new(bind(e, cx)?),
            Box::new(bind(pattern, cx)?),
            *negated,
            *ci,
        ),
        Expr::Func {
            name,
            args,
            distinct,
            star,
        } => {
            let is_agg = agg_func(name).is_some() && (args.len() == 1 || *star);
            if is_agg {
                if !cx.allow_aggs {
                    return Err(Error::Sql(format!(
                        "aggregate function {name}() is not allowed here"
                    )));
                }
                let func = agg_func(name).unwrap();
                let key = serde_json::to_string(e)?;
                if let Some(i) = cx.aggs.iter().position(|a| a.key == key) {
                    return Ok(BExpr::Agg(i));
                }
                let arg = if *star || args.is_empty() {
                    None
                } else {
                    // nested aggregates are not allowed
                    let saved = cx.allow_aggs;
                    cx.allow_aggs = false;
                    let b = bind(&args[0], cx);
                    cx.allow_aggs = saved;
                    Some(b?)
                };
                cx.aggs.push(AggSpec {
                    func,
                    arg,
                    distinct: *distinct,
                    key,
                });
                BExpr::Agg(cx.aggs.len() - 1)
            } else {
                BExpr::Func(
                    name.to_ascii_lowercase(),
                    args.iter().map(|x| bind(x, cx)).collect::<Result<_>>()?,
                )
            }
        }
        Expr::Case {
            operand,
            whens,
            else_,
        } => BExpr::Case(
            match operand {
                Some(o) => Some(Box::new(bind(o, cx)?)),
                None => None,
            },
            whens
                .iter()
                .map(|(a, b)| Ok((bind(a, cx)?, bind(b, cx)?)))
                .collect::<Result<_>>()?,
            match else_ {
                Some(o) => Some(Box::new(bind(o, cx)?)),
                None => None,
            },
        ),
        Expr::Subquery { .. } => {
            let id = cx.take_subquery_id()?;
            BExpr::SubqueryScalar(Arc::new(cx.subqueries[id].clone()))
        }
        Expr::InSubquery { e, negated, .. } => {
            let id = cx.take_subquery_id()?;
            BExpr::InSubquery(
                Box::new(bind(e, cx)?),
                Arc::new(cx.subqueries[id].clone()),
                *negated,
            )
        }
    })
}

/// Does the expression reference any column with index >= `from`?
pub fn refs_col_ge(e: &BExpr, from: usize) -> bool {
    match e {
        BExpr::Col(i) => *i >= from,
        BExpr::Lit(_) | BExpr::Agg(_) => false,
        BExpr::Bin(_, l, r) => refs_col_ge(l, from) || refs_col_ge(r, from),
        BExpr::Not(e) | BExpr::Neg(e) | BExpr::IsNull(e, _) => refs_col_ge(e, from),
        BExpr::In(e, l, _) => refs_col_ge(e, from) || l.iter().any(|x| refs_col_ge(x, from)),
        BExpr::Between(a, b, c, _) => {
            refs_col_ge(a, from) || refs_col_ge(b, from) || refs_col_ge(c, from)
        }
        BExpr::Like(a, b, _, _) => refs_col_ge(a, from) || refs_col_ge(b, from),
        BExpr::Func(_, a) => a.iter().any(|x| refs_col_ge(x, from)),
        BExpr::Case(o, w, e) => {
            o.as_deref().map_or(false, |x| refs_col_ge(x, from))
                || w.iter().any(|(a, b)| refs_col_ge(a, from) || refs_col_ge(b, from))
                || e.as_deref().map_or(false, |x| refs_col_ge(x, from))
        }
        BExpr::SubqueryScalar(_) => false,
        BExpr::InSubquery(e, _, _) => refs_col_ge(e, from),
    }
}

pub fn split_conjuncts<'a>(e: &'a BExpr, out: &mut Vec<&'a BExpr>) {
    match e {
        BExpr::Bin(BinOp::And, l, r) => {
            split_conjuncts(l, out);
            split_conjuncts(r, out);
        }
        other => out.push(other),
    }
}

// ---------------------------------------------------------------------------
// evaluation
// ---------------------------------------------------------------------------

fn bool_val(b: Option<bool>) -> Value {
    match b {
        Some(b) => Value::Bool(b),
        None => Value::Null,
    }
}

pub fn eval(e: &BExpr, row: &[Value], aggs: &[Value]) -> Result<Value> {
    Ok(match e {
        BExpr::Col(i) => row.get(*i).cloned().unwrap_or(Value::Null),
        BExpr::Lit(v) => v.clone(),
        BExpr::Agg(i) => aggs.get(*i).cloned().unwrap_or(Value::Null),
        BExpr::Not(x) => bool_val(eval(x, row, aggs)?.truthy().map(|b| !b)),
        BExpr::Neg(x) => match eval(x, row, aggs)? {
            Value::Int(i) => Value::Int(-i),
            Value::Real(f) => Value::Real(-f),
            Value::Null => Value::Null,
            v => return Err(Error::Sql(format!("cannot negate {}", v.type_name()))),
        },
        BExpr::IsNull(x, neg) => Value::Bool(eval(x, row, aggs)?.is_null() != *neg),
        BExpr::Bin(BinOp::And, l, r) => {
            let a = eval(l, row, aggs)?.truthy();
            if a == Some(false) {
                return Ok(Value::Bool(false));
            }
            let b = eval(r, row, aggs)?.truthy();
            match (a, b) {
                (_, Some(false)) => Value::Bool(false),
                (Some(true), Some(true)) => Value::Bool(true),
                _ => Value::Null,
            }
        }
        BExpr::Bin(BinOp::Or, l, r) => {
            let a = eval(l, row, aggs)?.truthy();
            if a == Some(true) {
                return Ok(Value::Bool(true));
            }
            let b = eval(r, row, aggs)?.truthy();
            match (a, b) {
                (_, Some(true)) => Value::Bool(true),
                (Some(false), Some(false)) => Value::Bool(false),
                _ => Value::Null,
            }
        }
        BExpr::Bin(op, l, r) => binop(*op, eval(l, row, aggs)?, eval(r, row, aggs)?)?,
        BExpr::In(x, list, neg) => {
            let v = eval(x, row, aggs)?;
            if v.is_null() {
                return Ok(Value::Null);
            }
            let mut saw_null = false;
            for item in list {
                let iv = eval(item, row, aggs)?;
                match sql_cmp(&v, &iv) {
                    Some(Ordering::Equal) => return Ok(Value::Bool(!*neg)),
                    None if iv.is_null() => saw_null = true,
                    _ => {}
                }
            }
            if saw_null {
                Value::Null
            } else {
                Value::Bool(*neg)
            }
        }
        BExpr::Between(x, lo, hi, neg) => {
            let v = eval(x, row, aggs)?;
            let l = eval(lo, row, aggs)?;
            let h = eval(hi, row, aggs)?;
            match (sql_cmp(&v, &l), sql_cmp(&v, &h)) {
                (Some(a), Some(b)) => {
                    Value::Bool((a != Ordering::Less && b != Ordering::Greater) != *neg)
                }
                _ => Value::Null,
            }
        }
        BExpr::Like(x, p, neg, ci) => {
            let v = eval(x, row, aggs)?;
            let pat = eval(p, row, aggs)?;
            match (&v, &pat) {
                (Value::Null, _) | (_, Value::Null) => Value::Null,
                (Value::Text(s), Value::Text(p)) => {
                    let m = if *ci {
                        like_match(&s.to_lowercase(), &p.to_lowercase())
                    } else {
                        like_match(s, p)
                    };
                    Value::Bool(m != *neg)
                }
                _ => return Err(Error::Sql("LIKE requires text operands".into())),
            }
        }
        BExpr::Case(operand, whens, else_) => {
            let op = match operand {
                Some(o) => Some(eval(o, row, aggs)?),
                None => None,
            };
            for (cond, res) in whens {
                let c = eval(cond, row, aggs)?;
                let hit = match &op {
                    Some(o) => sql_cmp(o, &c) == Some(Ordering::Equal),
                    None => c.truthy() == Some(true),
                };
                if hit {
                    return eval(res, row, aggs);
                }
            }
            match else_ {
                Some(e) => eval(e, row, aggs)?,
                None => Value::Null,
            }
        }
        BExpr::Func(name, args) => {
            let vals: Vec<Value> = args
                .iter()
                .map(|a| eval(a, row, aggs))
                .collect::<Result<_>>()?;
            call_func(name, vals)?
        }
        BExpr::SubqueryScalar(sq) => {
            if sq.columns.len() != 1 {
                return Err(Error::Sql("scalar subquery must return one column".into()));
            }
            match sq.rows.len() {
                0 => Value::Null,
                1 => sq.rows[0][0].clone(),
                _ => return Err(Error::Sql("scalar subquery returned more than one row".into())),
            }
        }
        BExpr::InSubquery(e, sq, neg) => {
            let v = eval(e, row, aggs)?;
            if v.is_null() {
                return Ok(Value::Null);
            }
            let mut saw_null = false;
            for r in &sq.rows {
                let iv = r.first().cloned().unwrap_or(Value::Null);
                match sql_cmp(&v, &iv) {
                    Some(Ordering::Equal) => return Ok(Value::Bool(!*neg)),
                    None if iv.is_null() => saw_null = true,
                    _ => {}
                }
            }
            if saw_null {
                Value::Null
            } else {
                Value::Bool(*neg)
            }
        }
    })
}

fn binop(op: BinOp, a: Value, b: Value) -> Result<Value> {
    use BinOp::*;
    if a.is_null() || b.is_null() {
        return Ok(Value::Null);
    }
    Ok(match op {
        Eq | Ne | Lt | Le | Gt | Ge => {
            let o = sql_cmp(&a, &b);
            Value::Bool(match (op, o) {
                (Eq, Some(o)) => o == Ordering::Equal,
                (Ne, Some(o)) => o != Ordering::Equal,
                (Lt, Some(o)) => o == Ordering::Less,
                (Le, Some(o)) => o != Ordering::Greater,
                (Gt, Some(o)) => o == Ordering::Greater,
                (Ge, Some(o)) => o != Ordering::Less,
                (Ne, None) => true,
                _ => false,
            })
        }
        Add | Sub | Mul | Div | Mod => match (&a, &b) {
            (Value::Int(x), Value::Int(y)) => match op {
                Add => x.checked_add(*y).map(Value::Int).unwrap_or(Value::Real(*x as f64 + *y as f64)),
                Sub => x.checked_sub(*y).map(Value::Int).unwrap_or(Value::Real(*x as f64 - *y as f64)),
                Mul => x.checked_mul(*y).map(Value::Int).unwrap_or(Value::Real(*x as f64 * *y as f64)),
                Div => {
                    if *y == 0 {
                        return Err(Error::Sql("division by zero".into()));
                    }
                    Value::Int(x.wrapping_div(*y))
                }
                _ => {
                    if *y == 0 {
                        return Err(Error::Sql("division by zero".into()));
                    }
                    Value::Int(x.wrapping_rem(*y))
                }
            },
            _ => match (a.as_f64(), b.as_f64()) {
                (Some(x), Some(y)) => Value::Real(match op {
                    Add => x + y,
                    Sub => x - y,
                    Mul => x * y,
                    Div => {
                        if y == 0.0 {
                            return Err(Error::Sql("division by zero".into()));
                        }
                        x / y
                    }
                    _ => x % y,
                }),
                _ => {
                    return Err(Error::Sql(format!(
                        "cannot apply arithmetic to {} and {}",
                        a.type_name(),
                        b.type_name()
                    )))
                }
            },
        },
        Concat => Value::Text(format!("{}{}", a.display(), b.display())),
        And | Or => unreachable!(),
    })
}

pub fn like_match(s: &str, pat: &str) -> bool {
    let s: Vec<char> = s.chars().collect();
    let p: Vec<char> = pat.chars().collect();
    let (mut i, mut j) = (0usize, 0usize);
    let (mut star, mut mark) = (None::<usize>, 0usize);
    while i < s.len() {
        if j < p.len() && (p[j] == '_' || p[j] == s[i]) && p[j] != '%' {
            i += 1;
            j += 1;
        } else if j < p.len() && p[j] == '%' {
            star = Some(j);
            mark = i;
            j += 1;
        } else if let Some(st) = star {
            j = st + 1;
            mark += 1;
            i = mark;
        } else {
            return false;
        }
    }
    while j < p.len() && p[j] == '%' {
        j += 1;
    }
    j == p.len()
}

fn text_arg(v: &Value, f: &str) -> Result<String> {
    match v {
        Value::Text(s) => Ok(s.clone()),
        Value::Null => Ok(String::new()),
        other => Ok(other.display()),
    }
    .map_err(|e: Error| Error::Sql(format!("{f}: {e}")))
}

fn call_func(name: &str, a: Vec<Value>) -> Result<Value> {
    let arity = |n: usize| -> Result<()> {
        if a.len() != n {
            Err(Error::Sql(format!("{name}() takes {n} argument(s)")))
        } else {
            Ok(())
        }
    };
    Ok(match name {
        "lower" | "upper" | "length" | "trim" | "ltrim" | "rtrim" => {
            arity(1)?;
            if a[0].is_null() {
                return Ok(Value::Null);
            }
            let s = text_arg(&a[0], name)?;
            match name {
                "lower" => Value::Text(s.to_lowercase()),
                "upper" => Value::Text(s.to_uppercase()),
                "length" => Value::Int(s.chars().count() as i64),
                "trim" => Value::Text(s.trim().to_string()),
                "ltrim" => Value::Text(s.trim_start().to_string()),
                _ => Value::Text(s.trim_end().to_string()),
            }
        }
        "abs" => {
            arity(1)?;
            match &a[0] {
                Value::Int(i) => Value::Int(i.abs()),
                Value::Real(f) => Value::Real(f.abs()),
                Value::Null => Value::Null,
                _ => return Err(Error::Sql("abs() requires a number".into())),
            }
        }
        "round" | "floor" | "ceil" => {
            if a.is_empty() || a.len() > 2 {
                return Err(Error::Sql(format!("{name}() takes 1-2 arguments")));
            }
            let Some(x) = a[0].as_f64() else {
                return Ok(Value::Null);
            };
            let digits = a.get(1).and_then(|d| d.as_i64()).unwrap_or(0);
            let m = 10f64.powi(digits as i32);
            let r = match name {
                "round" => (x * m).round() / m,
                "floor" => (x * m).floor() / m,
                _ => (x * m).ceil() / m,
            };
            if digits == 0 {
                Value::Int(r as i64)
            } else {
                Value::Real(r)
            }
        }
        "coalesce" => a.into_iter().find(|v| !v.is_null()).unwrap_or(Value::Null),
        "ifnull" => {
            arity(2)?;
            if a[0].is_null() {
                a[1].clone()
            } else {
                a[0].clone()
            }
        }
        "nullif" => {
            arity(2)?;
            if sql_cmp(&a[0], &a[1]) == Some(Ordering::Equal) {
                Value::Null
            } else {
                a[0].clone()
            }
        }
        "substr" | "substring" => {
            if a.len() < 2 || a.len() > 3 {
                return Err(Error::Sql("substr() takes 2-3 arguments".into()));
            }
            if a[0].is_null() {
                return Ok(Value::Null);
            }
            let s: Vec<char> = text_arg(&a[0], name)?.chars().collect();
            let start = (a[1].as_i64().unwrap_or(1) - 1).max(0) as usize;
            let len = a.get(2).and_then(|l| l.as_i64()).map(|l| l.max(0) as usize);
            let end = len.map_or(s.len(), |l| (start + l).min(s.len()));
            Value::Text(if start >= s.len() {
                String::new()
            } else {
                s[start..end].iter().collect()
            })
        }
        "replace" => {
            arity(3)?;
            if a[0].is_null() {
                return Ok(Value::Null);
            }
            Value::Text(text_arg(&a[0], name)?.replace(&text_arg(&a[1], name)?, &text_arg(&a[2], name)?))
        }
        "concat" => Value::Text(a.iter().filter(|v| !v.is_null()).map(|v| v.display()).collect()),
        "now" => Value::Int(now_ms()),
        "uuid" | "uuid4" => Value::Text(uuid4()),
        "uuid7" => Value::Text(uuid7()),
        "typeof" => {
            arity(1)?;
            Value::Text(a[0].type_name().into())
        }
        "cast" => {
            arity(2)?;
            let ty = match &a[1] {
                Value::Text(t) => serde_json::from_value::<ColumnType>(serde_json::Value::String(t.to_lowercase()))
                    .map_err(|_| Error::Sql(format!("unknown type in CAST: {t}")))?,
                _ => return Err(Error::Sql("bad CAST".into())),
            };
            match (&a[0], ty) {
                (Value::Int(_) | Value::Real(_) | Value::Bool(_), ColumnType::Text) => Value::Text(a[0].display()),
                (Value::Real(f), ColumnType::Int) => Value::Int(*f as i64),
                (Value::Text(s), ColumnType::Int) => Value::Int(
                    s.trim()
                        .parse::<i64>()
                        .or_else(|_| s.trim().parse::<f64>().map(|f| f as i64))
                        .map_err(|_| Error::Sql(format!("cannot cast '{s}' to int")))?,
                ),
                (v, ty) => ty.coerce(v.clone()).map_err(|e| Error::Sql(e.to_string()))?,
            }
        }
        "json_extract" | "json_get" => {
            arity(2)?;
            let path = text_arg(&a[1], name)?;
            let mut cur = match &a[0] {
                Value::Json(j) => j.clone(),
                Value::Text(s) => match serde_json::from_str(s) {
                    Ok(j) => j,
                    Err(_) => return Ok(Value::Null),
                },
                _ => return Ok(Value::Null),
            };
            for seg in path.trim_start_matches('$').trim_start_matches('.').split('.') {
                if seg.is_empty() {
                    continue;
                }
                cur = match (&cur, seg.parse::<usize>()) {
                    (serde_json::Value::Array(arr), Ok(i)) => arr.get(i).cloned().unwrap_or(serde_json::Value::Null),
                    (serde_json::Value::Object(m), _) => m.get(seg).cloned().unwrap_or(serde_json::Value::Null),
                    _ => serde_json::Value::Null,
                };
            }
            match cur {
                serde_json::Value::Array(_) | serde_json::Value::Object(_) => Value::Json(cur),
                other => Value::from_json(&other),
            }
        }
        _ => return Err(Error::Sql(format!("unknown function {name}()"))),
    })
}

/// Constant-fold an expression that does not reference columns.
pub fn eval_const(e: &Expr) -> Result<Value> {
    let layout = Layout::default();
    let mut cx = BindCx::new(&layout);
    let b = bind(e, &mut cx)?;
    eval(&b, &[], &[])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn like_patterns() {
        assert!(like_match("hello", "h%o"));
        assert!(like_match("hello", "_ello"));
        assert!(!like_match("hello", "h_o"));
        assert!(like_match("", "%"));
        assert!(like_match("abc", "%b%"));
    }

    #[test]
    fn three_valued_logic() {
        let n = Expr::lit(Value::Null);
        let t = Expr::lit(Value::Bool(true));
        let f = Expr::lit(Value::Bool(false));
        assert_eq!(eval_const(&Expr::bin(BinOp::And, n.clone(), f.clone())).unwrap(), Value::Bool(false));
        assert_eq!(eval_const(&Expr::bin(BinOp::Or, n.clone(), t)).unwrap(), Value::Bool(true));
        assert_eq!(eval_const(&Expr::bin(BinOp::And, n.clone(), n)).unwrap(), Value::Null);
    }
}
