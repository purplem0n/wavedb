//! Statement executor: access-path planning, joins, aggregation, DML with
//! secondary-index maintenance.

use crate::catalog::{self, ColDefault, ForeignKeyDef, TableDef};
use crate::value::ColumnType;
use crate::error::{Error, Result};
use crate::expr::*;
use crate::kv::{prefix_end, prefix_range, CommitInfo, Isolation, KeyBound, Scan, Txn};
use crate::stmt::*;
use crate::value::{encode_key_value, now_ms, sort_cmp, uuid4, uuid7, Value};
use std::cmp::Ordering;
use std::collections::{HashMap, HashSet, VecDeque};
use std::ops::Bound;
use std::sync::atomic::Ordering as AtomicOrdering;
use std::sync::Arc;

/// A transaction that executes statements against the relational catalog.
pub struct DbTxn {
    txn: Txn,
    tables: HashMap<String, Arc<TableDef>>,
    /// Pending integer column deltas merged at commit (conflict-free under lock).
    commutative: HashMap<Vec<u8>, (Arc<TableDef>, Vec<Value>, Vec<(HashMap<usize, i64>, Option<BExpr>)>)>,
}

enum SourceKind {
    Table(Arc<TableDef>),
    Memory {
        columns: Vec<String>,
        rows: Arc<Vec<Vec<Value>>>,
        label: String,
    },
}

struct Source {
    alias: String,
    kind: SourceKind,
    off: usize,
}

impl Source {
    fn col_count(&self) -> usize {
        match &self.kind {
            SourceKind::Table(def) => def.columns.len(),
            SourceKind::Memory { columns, .. } => columns.len(),
        }
    }

    fn describe(&self, plan: &AccessPlan) -> String {
        match &self.kind {
            SourceKind::Table(def) => describe_plan(def, plan, &self.alias),
            SourceKind::Memory { label, .. } => format!("FULL SCAN {label} AS {}", self.alias),
        }
    }
}

enum RowsIter {
    Table(RowIter),
    Memory {
        rows: Arc<Vec<Vec<Value>>>,
        i: usize,
    },
}

impl RowsIter {
    fn next(&mut self, txn: &mut Txn) -> Result<Option<Vec<Value>>> {
        match self {
            RowsIter::Table(it) => it.next(txn),
            RowsIter::Memory { rows, i } => {
                if *i >= rows.len() {
                    Ok(None)
                } else {
                    let r = rows[*i].clone();
                    *i += 1;
                    Ok(Some(r))
                }
            }
        }
    }
}

fn source_iter(s: &Source, plan: &AccessPlan, env: &[Value]) -> Result<RowsIter> {
    Ok(match &s.kind {
        SourceKind::Table(def) => RowsIter::Table(row_iter(def, plan, env)?),
        SourceKind::Memory { rows, .. } => RowsIter::Memory {
            rows: rows.clone(),
            i: 0,
        },
    })
}

#[derive(Default, Clone)]
struct Cons {
    eq: Option<BExpr>,
    ins: Option<Vec<BExpr>>,
    lo: Option<(BExpr, bool)>,
    hi: Option<(BExpr, bool)>,
}

#[derive(Clone, Default)]
struct AccessPlan {
    /// position into `table.indexes`, or `None` for the primary key
    index: Option<usize>,
    /// table column positions making up the key (index columns, or PK columns)
    cols: Vec<usize>,
    eq: Vec<BExpr>,
    in_list: Option<Vec<BExpr>>,
    lower: Option<(BExpr, bool)>,
    upper: Option<(BExpr, bool)>,
    reverse: bool,
    ordered: bool,
    score: i32,
}

fn flip(op: BinOp) -> BinOp {
    match op {
        BinOp::Lt => BinOp::Gt,
        BinOp::Le => BinOp::Ge,
        BinOp::Gt => BinOp::Lt,
        BinOp::Ge => BinOp::Le,
        o => o,
    }
}

fn plan_access(
    table: &TableDef,
    off: usize,
    conj: &[&BExpr],
    order: &[(usize, bool)],
    has_limit: bool,
) -> AccessPlan {
    let n = table.columns.len();
    let mut cons: Vec<Cons> = vec![Cons::default(); n];
    let local = |e: &BExpr| -> Option<usize> {
        if let BExpr::Col(i) = e {
            if *i >= off && *i < off + n {
                return Some(*i - off);
            }
        }
        None
    };
    let usable = |e: &BExpr| !refs_col_ge(e, off);
    let apply = |cons: &mut Vec<Cons>, p: usize, op: BinOp, v: &BExpr| match op {
        BinOp::Eq => {
            if cons[p].eq.is_none() {
                cons[p].eq = Some(v.clone())
            }
        }
        BinOp::Lt | BinOp::Le => {
            if cons[p].hi.is_none() {
                cons[p].hi = Some((v.clone(), op == BinOp::Le))
            }
        }
        BinOp::Gt | BinOp::Ge => {
            if cons[p].lo.is_none() {
                cons[p].lo = Some((v.clone(), op == BinOp::Ge))
            }
        }
        _ => {}
    };
    for c in conj {
        match c {
            BExpr::Bin(op, l, r)
                if matches!(op, BinOp::Eq | BinOp::Lt | BinOp::Le | BinOp::Gt | BinOp::Ge) =>
            {
                if let (Some(p), true) = (local(l), usable(r)) {
                    apply(&mut cons, p, *op, r);
                } else if let (Some(p), true) = (local(r), usable(l)) {
                    apply(&mut cons, p, flip(*op), l);
                }
            }
            BExpr::In(e, list, false) => {
                if let Some(p) = local(e) {
                    if list.iter().all(|x| usable(x)) && cons[p].ins.is_none() {
                        cons[p].ins = Some(list.clone());
                    }
                }
            }
            BExpr::Between(e, lo, hi, false) => {
                if let Some(p) = local(e) {
                    if usable(lo) && usable(hi) {
                        apply(&mut cons, p, BinOp::Ge, lo);
                        apply(&mut cons, p, BinOp::Le, hi);
                    }
                }
            }
            _ => {}
        }
    }

    let pk = table.pk_positions();
    let build = |index: Option<usize>, cols: Vec<usize>, unique_full: i32| -> AccessPlan {
        let mut eq = vec![];
        for &c in &cols {
            match &cons[c].eq {
                Some(e) => eq.push(e.clone()),
                None => break,
            }
        }
        let k = eq.len();
        let mut score = (k as i32) * 10;
        let (mut in_list, mut lower, mut upper) = (None, None, None);
        if k < cols.len() {
            let c = cols[k];
            if let Some(l) = &cons[c].ins {
                in_list = Some(l.clone());
                score += 5;
            } else {
                lower = cons[c].lo.clone();
                upper = cons[c].hi.clone();
                if lower.is_some() {
                    score += 2;
                }
                if upper.is_some() {
                    score += 2;
                }
            }
        }
        if unique_full > 0 && k == cols.len() {
            score += unique_full;
        }
        AccessPlan {
            index,
            cols,
            eq,
            in_list,
            lower,
            upper,
            reverse: false,
            ordered: false,
            score,
        }
    };
    let mut best = build(None, pk.clone(), 100);
    for (i, idx) in table.indexes.iter().enumerate() {
        let cols: Vec<usize> = idx.columns.iter().map(|c| table.col_pos(c).unwrap()).collect();
        let cand = build(Some(i), cols, if idx.unique { 90 } else { 0 });
        if cand.score > best.score {
            best = cand;
        }
    }
    let order_cols = |p: &AccessPlan| -> Vec<usize> {
        let mut v: Vec<usize> = p.cols[p.eq.len().min(p.cols.len())..].to_vec();
        if p.index.is_some() {
            v.extend(pk.iter().copied());
        }
        v
    };
    let matches_order = |p: &AccessPlan| -> Option<bool> {
        if order.is_empty() || p.in_list.is_some() {
            return None;
        }
        let oc = order_cols(p);
        if order.len() > oc.len() {
            return None;
        }
        let desc = order[0].1;
        for (i, (abs, d)) in order.iter().enumerate() {
            if abs - off != oc[i] || *d != desc {
                return None;
            }
        }
        Some(desc)
    };
    if best.score == 0 && !order.is_empty() {
        // no useful predicate: pick an access path that yields the requested order
        let pkp = build(None, pk.clone(), 100);
        if matches_order(&pkp).is_some() {
            best = pkp;
        } else if has_limit {
            for (i, idx) in table.indexes.iter().enumerate() {
                let cols: Vec<usize> = idx.columns.iter().map(|c| table.col_pos(c).unwrap()).collect();
                let cand = build(Some(i), cols, 0);
                if matches_order(&cand).is_some() {
                    best = cand;
                    break;
                }
            }
        }
    }
    if let Some(desc) = matches_order(&best) {
        best.ordered = true;
        best.reverse = desc;
    }
    best
}

fn describe_plan(table: &TableDef, p: &AccessPlan, alias: &str) -> String {
    let colname = |i: usize| table.columns[i].name.clone();
    let how = match p.index {
        None => "PRIMARY KEY".to_string(),
        Some(i) => format!("INDEX {}", table.indexes[i].name),
    };
    if p.eq.is_empty() && p.in_list.is_none() && p.lower.is_none() && p.upper.is_none() {
        return match p.index {
            None => format!(
                "FULL SCAN {} AS {}{}",
                table.name,
                alias,
                if p.ordered { " (ordered)" } else { "" }
            ),
            Some(_) => format!(
                "SCAN {} AS {} USING {} (ordered)",
                table.name, alias, how
            ),
        };
    }
    let mut parts: Vec<String> = p.eq.iter().enumerate().map(|(i, _)| format!("{}=?", colname(p.cols[i]))).collect();
    let k = p.eq.len();
    if p.in_list.is_some() {
        parts.push(format!("{} IN (...)", colname(p.cols[k])));
    } else if p.lower.is_some() || p.upper.is_some() {
        parts.push(format!("{} RANGE", colname(p.cols[k])));
    }
    format!(
        "SEARCH {} AS {} USING {} ({}){}",
        table.name,
        alias,
        how,
        parts.join(", "),
        if p.ordered { " (ordered)" } else { "" }
    )
}

struct RowIter {
    ranges: VecDeque<(KeyBound, KeyBound)>,
    reverse: bool,
    current: Option<Scan>,
    via_index: bool,
    table: Arc<TableDef>,
}

impl RowIter {
    fn next(&mut self, txn: &mut Txn) -> Result<Option<Vec<Value>>> {
        loop {
            if let Some(s) = &mut self.current {
                match s.next() {
                    Some(Ok((_, v))) => {
                        if self.via_index {
                            let rk = self.table.row_key(&v);
                            match txn.get(&rk)? {
                                Some(b) => return Ok(Some(self.table.decode_value(&b)?)),
                                None => continue,
                            }
                        }
                        return Ok(Some(self.table.decode_value(&v)?));
                    }
                    Some(Err(e)) => return Err(e),
                    None => self.current = None,
                }
            } else if let Some((lo, hi)) = self.ranges.pop_front() {
                self.current = Some(txn.scan(lo, hi, self.reverse)?);
            } else {
                return Ok(None);
            }
        }
    }
}

fn build_ranges(table: &TableDef, p: &AccessPlan, env: &[Value]) -> Result<Vec<(KeyBound, KeyBound)>> {
    let base = match p.index {
        None => table.row_prefix(),
        Some(i) => TableDef::index_prefix(&table.indexes[i]),
    };
    let mut prefix = base;
    for (i, e) in p.eq.iter().enumerate() {
        let v = eval(e, env, &[])?;
        if v.is_null() {
            return Ok(vec![]);
        }
        match table.columns[p.cols[i]].ty.coerce(v) {
            Ok(v) => encode_key_value(&v, &mut prefix),
            Err(_) => return Ok(vec![]),
        }
    }
    let k = p.eq.len();
    let next_ty = p.cols.get(k).map(|c| table.columns[*c].ty);
    if let Some(list) = &p.in_list {
        let ty = next_ty.unwrap();
        let mut encs: Vec<Vec<u8>> = vec![];
        for e in list {
            let v = eval(e, env, &[])?;
            if v.is_null() {
                continue;
            }
            if let Ok(v) = ty.coerce(v) {
                let mut k2 = prefix.clone();
                encode_key_value(&v, &mut k2);
                encs.push(k2);
            }
        }
        encs.sort();
        encs.dedup();
        return Ok(encs.into_iter().map(|k| prefix_range(&k)).collect());
    }
    let bound_enc = |b: &Option<(BExpr, bool)>| -> Result<Option<(Vec<u8>, bool)>> {
        let Some((e, incl)) = b else { return Ok(None) };
        let v = eval(e, env, &[])?;
        if v.is_null() {
            return Ok(None);
        }
        match next_ty.map(|t| t.coerce(v)) {
            Some(Ok(v)) => {
                let mut k2 = prefix.clone();
                encode_key_value(&v, &mut k2);
                Ok(Some((k2, *incl)))
            }
            _ => Ok(None),
        }
    };
    // a NULL bound can never be satisfied
    for b in [&p.lower, &p.upper] {
        if let Some((e, _)) = b {
            if eval(e, env, &[])?.is_null() {
                return Ok(vec![]);
            }
        }
    }
    let lo = match bound_enc(&p.lower)? {
        Some((k, true)) => Bound::Included(k),
        Some((k, false)) => match prefix_end(&k) {
            Some(e) => Bound::Included(e),
            None => return Ok(vec![]),
        },
        None => {
            if p.upper.is_some() {
                // skip NULL entries (tag 0x00) when only an upper bound exists
                let mut k2 = prefix.clone();
                k2.push(0x01);
                Bound::Included(k2)
            } else {
                Bound::Included(prefix.clone())
            }
        }
    };
    let hi = match bound_enc(&p.upper)? {
        Some((k, true)) => match prefix_end(&k) {
            Some(e) => Bound::Excluded(e),
            None => Bound::Unbounded,
        },
        Some((k, false)) => Bound::Excluded(k),
        None => match prefix_end(&prefix) {
            Some(e) => Bound::Excluded(e),
            None => Bound::Unbounded,
        },
    };
    Ok(vec![(lo, hi)])
}

fn row_iter(table: &Arc<TableDef>, p: &AccessPlan, env: &[Value]) -> Result<RowIter> {
    let ranges = build_ranges(table, p, env)?;
    Ok(RowIter {
        ranges: ranges.into(),
        reverse: p.reverse,
        current: None,
        via_index: p.index.is_some(),
        table: table.clone(),
    })
}

/// `SELECT max(pk)` / `min(pk)` with no filters — one PK edge row instead of a full scan.
fn pk_bound_agg_plan(
    st: &SelectStmt,
    sources: &[Source],
    where_b: &Option<BExpr>,
    aggs: &[AggSpec],
    items: &[(String, Expr)],
) -> Option<String> {
    if st.distinct || !st.joins.is_empty() || !st.group_by.is_empty() || st.having.is_some() {
        return None;
    }
    if sources.len() != 1 || where_b.is_some() || aggs.len() != 1 || items.len() != 1 {
        return None;
    }
    let def = match &sources[0].kind {
        SourceKind::Table(t) => t.as_ref(),
        _ => return None,
    };
    let spec = &aggs[0];
    if spec.distinct {
        return None;
    }
    let edge = match spec.func {
        AggFunc::Max => "MAX",
        AggFunc::Min => "MIN",
        _ => return None,
    };
    let BExpr::Col(col_idx) = spec.arg.as_ref()? else {
        return None;
    };
    if def.primary_key.len() != 1 {
        return None;
    }
    let pk_pos = def.col_pos(&def.primary_key[0])?;
    if *col_idx != pk_pos || def.columns[pk_pos].ty != ColumnType::Int {
        return None;
    }
    Some(format!(
        "PK BOUND {edge}({}.{})",
        def.name, def.primary_key[0]
    ))
}

fn try_pk_bound_aggregate(
    txn: &mut Txn,
    st: &SelectStmt,
    sources: &[Source],
    where_b: &Option<BExpr>,
    aggs: &[AggSpec],
    items: &[(String, Expr)],
    select_b: &[BExpr],
    col_names: &[String],
    order_b: &[(BExpr, bool)],
    offset: usize,
    limit: Option<usize>,
    has_window: bool,
) -> Result<Option<QueryResult>> {
    if has_window {
        return Ok(None);
    }
    let Some(plan_text) = pk_bound_agg_plan(st, sources, where_b, aggs, items) else {
        return Ok(None);
    };
    let def = match &sources[0].kind {
        SourceKind::Table(t) => t.clone(),
        _ => return Ok(None),
    };
    let spec = &aggs[0];
    let reverse = spec.func == AggFunc::Max;
    let pk_pos = def.col_pos(&def.primary_key[0]).unwrap();
    let mut plan = AccessPlan::default();
    plan.reverse = reverse;
    let mut it = row_iter(&def, &plan, &[])?;
    let bound = if let Some(row) = it.next(txn)? {
        row[pk_pos].clone()
    } else {
        Value::Null
    };
    let agg_vals = vec![bound];
    let rep: Vec<Value> = vec![];
    let vals: Vec<Value> = select_b
        .iter()
        .map(|e| eval(e, &rep, &agg_vals))
        .collect::<Result<_>>()?;
    let keys: Vec<Value> = order_b
        .iter()
        .map(|(e, _)| eval(e, &rep, &agg_vals))
        .collect::<Result<_>>()?;
    let mut out = vec![(keys, vals)];
    if !order_b.is_empty() {
        out.sort_by(|a, b| {
            for (i, (_, desc)) in order_b.iter().enumerate() {
                let o = sort_cmp(&a.0[i], &b.0[i]);
                let o = if *desc { o.reverse() } else { o };
                if o != Ordering::Equal {
                    return o;
                }
            }
            Ordering::Equal
        });
    }
    let mut rows: Vec<Vec<Value>> = out.into_iter().map(|(_, v)| v).collect();
    if offset > 0 {
        rows.drain(..offset.min(rows.len()));
    }
    if let Some(l) = limit {
        rows.truncate(l);
    }
    let _ = plan_text; // used by EXPLAIN path
    Ok(Some(QueryResult {
        columns: col_names.to_vec(),
        rows,
        ..Default::default()
    }))
}

// ---------------------------------------------------------------------------
// aggregation
// ---------------------------------------------------------------------------

enum Acc {
    Count(i64),
    Sum { i: i64, f: f64, real: bool, any: bool },
    Avg { sum: f64, n: i64 },
    Min(Option<Value>),
    Max(Option<Value>),
}

struct AccState {
    acc: Acc,
    seen: Option<HashSet<Vec<u8>>>,
}

impl AccState {
    fn new(spec: &AggSpec) -> Self {
        AccState {
            acc: match spec.func {
                AggFunc::Count => Acc::Count(0),
                AggFunc::Sum => Acc::Sum {
                    i: 0,
                    f: 0.0,
                    real: false,
                    any: false,
                },
                AggFunc::Avg => Acc::Avg { sum: 0.0, n: 0 },
                AggFunc::Min => Acc::Min(None),
                AggFunc::Max => Acc::Max(None),
            },
            seen: if spec.distinct { Some(HashSet::new()) } else { None },
        }
    }

    fn update(&mut self, v: Option<Value>) -> Result<()> {
        // `None` = count(*) (row counted unconditionally)
        let Some(v) = v else {
            if let Acc::Count(n) = &mut self.acc {
                *n += 1;
            }
            return Ok(());
        };
        if v.is_null() {
            return Ok(());
        }
        if let Some(seen) = &mut self.seen {
            let mut k = vec![];
            encode_key_value(&v, &mut k);
            if !seen.insert(k) {
                return Ok(());
            }
        }
        match &mut self.acc {
            Acc::Count(n) => *n += 1,
            Acc::Sum { i, f, real, any } => {
                *any = true;
                match v {
                    Value::Int(x) if !*real => match i.checked_add(x) {
                        Some(s) => *i = s,
                        None => {
                            *real = true;
                            *f = *i as f64 + x as f64;
                        }
                    },
                    other => {
                        let x = other
                            .as_f64()
                            .ok_or_else(|| Error::Sql("sum() requires numbers".into()))?;
                        if !*real {
                            *real = true;
                            *f = *i as f64;
                        }
                        *f += x;
                    }
                }
            }
            Acc::Avg { sum, n } => {
                *sum += v
                    .as_f64()
                    .ok_or_else(|| Error::Sql("avg() requires numbers".into()))?;
                *n += 1;
            }
            Acc::Min(cur) => {
                if cur.as_ref().map_or(true, |c| sort_cmp(&v, c) == Ordering::Less) {
                    *cur = Some(v);
                }
            }
            Acc::Max(cur) => {
                if cur.as_ref().map_or(true, |c| sort_cmp(&v, c) == Ordering::Greater) {
                    *cur = Some(v);
                }
            }
        }
        Ok(())
    }

    fn finish(&self) -> Value {
        match &self.acc {
            Acc::Count(n) => Value::Int(*n),
            Acc::Sum { i, f, real, any } => {
                if !*any {
                    Value::Null
                } else if *real {
                    Value::Real(*f)
                } else {
                    Value::Int(*i)
                }
            }
            Acc::Avg { sum, n } => {
                if *n == 0 {
                    Value::Null
                } else {
                    Value::Real(*sum / *n as f64)
                }
            }
            Acc::Min(v) | Acc::Max(v) => v.clone().unwrap_or(Value::Null),
        }
    }
}

struct Group {
    rep: Vec<Value>,
    accs: Vec<AccState>,
}

fn target_matches(target: &[String], cols: &[String]) -> bool {
    if target.is_empty() {
        return true;
    }
    let mut a: Vec<&String> = target.iter().collect();
    let mut b: Vec<&String> = cols.iter().collect();
    a.sort();
    b.sort();
    a == b
}

fn default_name(e: &Expr, i: usize) -> String {
    match e {
        Expr::Col { name, .. } => name.clone(),
        Expr::Func { name, .. } => name.to_lowercase(),
        Expr::Window { kind, .. } => match kind {
            WindowKind::RowNumber => "row_number".into(),
            WindowKind::Rank => "rank".into(),
            WindowKind::DenseRank => "dense_rank".into(),
            WindowKind::Sum => "sum".into(),
            WindowKind::Avg => "avg".into(),
        },
        _ => format!("col{}", i + 1),
    }
}

fn group_key(vals: &[Value]) -> Vec<u8> {
    let mut k = vec![];
    for v in vals {
        encode_key_value(v, &mut k);
    }
    k
}

fn cmp_window_order(a: &[Value], b: &[Value], order: &[(BExpr, bool)]) -> Ordering {
    for (e, desc) in order {
        let va = eval(e, a, &[]).unwrap_or(Value::Null);
        let vb = eval(e, b, &[]).unwrap_or(Value::Null);
        let mut o = sort_cmp(&va, &vb);
        if *desc {
            o = o.reverse();
        }
        if o != Ordering::Equal {
            return o;
        }
    }
    Ordering::Equal
}

fn apply_windows(
    specs: &[BoundWindowSpec],
    select_b: &[BExpr],
    sources: &[Vec<Value>],
    rows: &mut [Vec<Value>],
) -> Result<()> {
    for (spec_id, spec) in specs.iter().enumerate() {
        let out_cols: Vec<usize> = select_b
            .iter()
            .enumerate()
            .filter_map(|(i, e)| matches!(e, BExpr::Window(id) if *id == spec_id).then_some(i))
            .collect();
        if out_cols.is_empty() {
            continue;
        }
        let mut parts: HashMap<Vec<u8>, Vec<usize>> = HashMap::new();
        for (i, src) in sources.iter().enumerate() {
            let pk: Vec<Value> = spec
                .partition_by
                .iter()
                .map(|e| eval(e, src, &[]))
                .collect::<Result<_>>()?;
            parts.entry(group_key(&pk)).or_default().push(i);
        }
        for indices in parts.values_mut() {
            indices.sort_by(|&a, &b| cmp_window_order(&sources[a], &sources[b], &spec.order_by));
            let mut row_num = 0i64;
            let mut rank = 0i64;
            let mut dense = 0i64;
            let mut prev_order: Option<Vec<Value>> = None;
            let mut run_sum_int: i64 = 0;
            let mut run_sum_real: f64 = 0.0;
            let mut run_real = false;
            let mut run_cnt = 0i64;
            for &idx in indices.iter() {
                row_num += 1;
                let order_vals: Vec<Value> = spec
                    .order_by
                    .iter()
                    .map(|(e, _)| eval(e, &sources[idx], &[]))
                    .collect::<Result<_>>()?;
                if prev_order.as_ref().map_or(true, |p| order_vals != *p) {
                    rank = row_num;
                    dense += 1;
                    prev_order = Some(order_vals);
                }
                let val = match spec.kind {
                    WindowKind::RowNumber => Value::Int(row_num),
                    WindowKind::Rank => Value::Int(rank),
                    WindowKind::DenseRank => Value::Int(dense),
                    WindowKind::Sum | WindowKind::Avg => {
                        let arg = spec
                            .arg
                            .as_ref()
                            .ok_or_else(|| Error::Sql("internal error: window aggregate missing arg".into()))?;
                        let v = eval(arg, &sources[idx], &[])?;
                        if v.is_null() {
                            if spec.kind == WindowKind::Sum {
                                if run_real {
                                    Value::Real(run_sum_real)
                                } else {
                                    Value::Int(run_sum_int)
                                }
                            } else if run_cnt == 0 {
                                Value::Null
                            } else {
                                Value::Real(run_sum_real / run_cnt as f64)
                            }
                        } else {
                            match v {
                                Value::Int(x) if !run_real => {
                                    run_sum_int = run_sum_int.saturating_add(x);
                                    run_cnt += 1;
                                    if spec.kind == WindowKind::Sum {
                                        Value::Int(run_sum_int)
                                    } else {
                                        run_sum_real = run_sum_int as f64;
                                        Value::Real(run_sum_real / run_cnt as f64)
                                    }
                                }
                                other => {
                                    let x = other
                                        .as_f64()
                                        .ok_or_else(|| Error::Sql("window sum/avg requires numbers".into()))?;
                                    if !run_real {
                                        run_real = true;
                                        run_sum_real = run_sum_int as f64;
                                    }
                                    run_sum_real += x;
                                    run_cnt += 1;
                                    if spec.kind == WindowKind::Sum {
                                        Value::Real(run_sum_real)
                                    } else {
                                        Value::Real(run_sum_real / run_cnt as f64)
                                    }
                                }
                            }
                        }
                    }
                };
                for c in &out_cols {
                    rows[idx][*c] = val.clone();
                }
            }
        }
    }
    Ok(())
}

fn apply_post_select(st: &SelectStmt, col_names: &[String], mut rows: Vec<Vec<Value>>) -> Result<Vec<Vec<Value>>> {
    if !st.order_by.is_empty() {
        let layout = Layout {
            cols: col_names.iter().map(|c| (String::new(), c.clone())).collect(),
        };
        let mut cx = BindCx::new(&layout);
        let order_b: Vec<(BExpr, bool)> = st
            .order_by
            .iter()
            .map(|o| Ok((bind(&o.expr, &mut cx)?, o.desc)))
            .collect::<Result<_>>()?;
        rows.sort_by(|a, b| {
            for (e, desc) in &order_b {
                let va = eval(e, a, &[]).unwrap_or(Value::Null);
                let vb = eval(e, b, &[]).unwrap_or(Value::Null);
                let mut o = sort_cmp(&va, &vb);
                if *desc {
                    o = o.reverse();
                }
                if o != Ordering::Equal {
                    return o;
                }
            }
            Ordering::Equal
        });
    }
    if st.distinct {
        let mut seen = HashSet::new();
        rows.retain(|r| seen.insert(group_key(r)));
    }
    let offset = st.offset.unwrap_or(0).max(0) as usize;
    if offset > 0 {
        rows.drain(..offset.min(rows.len()));
    }
    if let Some(l) = st.limit {
        rows.truncate(l.max(0) as usize);
    }
    Ok(rows)
}

fn int_increment_delta(e: &BExpr, col: usize) -> Option<i64> {
    match e {
        BExpr::Bin(BinOp::Add, l, r) => {
            if matches!(l.as_ref(), BExpr::Col(p) if *p == col) {
                if let BExpr::Lit(Value::Int(d)) = r.as_ref() {
                    return Some(*d);
                }
            }
            if matches!(r.as_ref(), BExpr::Col(p) if *p == col) {
                if let BExpr::Lit(Value::Int(d)) = l.as_ref() {
                    return Some(*d);
                }
            }
            None
        }
        BExpr::Bin(BinOp::Sub, l, r) => {
            if matches!(l.as_ref(), BExpr::Col(p) if *p == col) {
                if let BExpr::Lit(Value::Int(d)) = r.as_ref() {
                    return Some(-*d);
                }
            }
            None
        }
        _ => None,
    }
}

/// Apply queued commutative deltas in order. When `preview` is false, a failing WHERE returns `Conflict`.
fn replay_commutative_ops(
    table: &str,
    row: &mut Vec<Value>,
    ops: &[(HashMap<usize, i64>, Option<BExpr>)],
    preview: bool,
) -> Result<()> {
    for (deltas, where_) in ops {
        if let Some(w) = where_ {
            if eval(w, row, &[])?.truthy() != Some(true) {
                if preview {
                    return Ok(());
                }
                return Err(Error::Conflict(format!(
                    "conditional update predicate no longer satisfied on \"{table}\""
                )));
            }
        }
        for (p, d) in deltas {
            let n = row[*p].as_i64().unwrap_or(0).saturating_add(*d);
            row[*p] = Value::Int(n);
        }
    }
    Ok(())
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

fn check_row_foreign_keys(txn: &mut Txn, t: &TableDef, row: &[Value]) -> Result<()> {
    catalog::check_row_foreign_keys(txn, t, row)
}

fn child_fk_matches(
    child: &TableDef,
    fk: &ForeignKeyDef,
    child_row: &[Value],
    parent: &TableDef,
    parent_row: &[Value],
) -> Result<bool> {
    let cv = fk_values(child, child_row, fk)?;
    if cv.iter().any(|v| v.is_null()) {
        return Ok(false);
    }
    let mut pv = vec![];
    for rc in &fk.ref_columns {
        pv.push(parent_row[parent.col_pos(rc).unwrap()].clone());
    }
    Ok(cv == pv)
}

fn parent_ref_columns_changed(
    txn: &mut Txn,
    parent: &TableDef,
    old: &[Value],
    new: &[Value],
) -> Result<bool> {
    for child_def in catalog::list_tables(txn)? {
        for fk in &child_def.foreign_keys {
            if fk.ref_table != parent.name {
                continue;
            }
            for rc in &fk.ref_columns {
                let p = parent.col_pos(rc).unwrap();
                if old[p] != new[p] {
                    return Ok(true);
                }
            }
        }
    }
    Ok(false)
}

fn check_referencing_children(
    txn: &mut Txn,
    parent: &TableDef,
    parent_row: &[Value],
) -> Result<()> {
    for child_def in catalog::list_tables(txn)? {
        for fk in &child_def.foreign_keys {
            if fk.ref_table != parent.name {
                continue;
            }
            let (lo, hi) = prefix_range(&child_def.row_prefix());
            let rows: Vec<(Vec<u8>, Vec<u8>)> = txn.scan(lo, hi, false)?.collect::<Result<_>>()?;
            for (_, v) in rows {
                let crow = child_def.decode_value(&v)?;
                if child_fk_matches(&child_def, fk, &crow, parent, parent_row)? {
                    return Err(Error::Constraint(format!(
                        "FOREIGN KEY constraint failed: cannot delete or update parent row in \"{}\" — referenced from \"{}\"",
                        parent.name, child_def.name
                    )));
                }
            }
        }
    }
    Ok(())
}

fn apply_row_update(txn: &mut Txn, t: &TableDef, old: &[Value], new: &[Value]) -> Result<()> {
    let old_pk = t.pk_enc(old);
    let new_pk = t.pk_enc(new);
    debug_assert_eq!(old_pk, new_pk);
    txn.put(&t.row_key(&new_pk), &t.encode_value(new))?;
    for idx in &t.indexes {
        let ok = t.index_key(idx, old, &old_pk);
        let nk = t.index_key(idx, new, &new_pk);
        if ok != nk {
            txn.delete(&ok)?;
            txn.put(&nk, &new_pk)?;
        }
        if idx.unique {
            let og = if t.index_has_null(idx, old) { None } else { Some(t.guard_key(idx, old)) };
            let ng = if t.index_has_null(idx, new) { None } else { Some(t.guard_key(idx, new)) };
            if og != ng {
                if let Some(g) = &ng {
                    if txn.get(g)?.is_some() {
                        return Err(DbTxn::unique_violation(t, &idx.name, &idx.columns));
                    }
                }
                if let Some(g) = &og {
                    txn.delete(g)?;
                }
                if let Some(g) = &ng {
                    txn.put(g, &new_pk)?;
                }
            }
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// executor
// ---------------------------------------------------------------------------

impl DbTxn {
    pub fn new(txn: Txn) -> Self {
        DbTxn {
            txn,
            tables: HashMap::new(),
            commutative: HashMap::new(),
        }
    }

    pub fn txn(&mut self) -> &mut Txn {
        &mut self.txn
    }

    pub fn commit(mut self) -> Result<CommitInfo> {
        if !self.commutative.is_empty() {
            let pending = std::mem::take(&mut self.commutative);
            self.txn.on_commit(move |txn| {
                for (_, (t, _old, ops)) in pending {
                    let pk = t.pk_enc(&_old);
                    let rk = t.row_key(&pk);
                    let vis = txn.engine().visible_ts();
                    let cur = match txn.engine().read_at(&rk, vis)? {
                        Some(b) => t.decode_value(&b)?,
                        None => return Err(Error::NotFound(format!("row missing for {}", t.name))),
                    };
                    if cur != _old {
                        return Err(Error::Conflict(format!(
                            "row on \"{}\" changed since this transaction read it",
                            t.name
                        )));
                    }
                    let mut row = cur.clone();
                    replay_commutative_ops(&t.name, &mut row, &ops, false)?;
                    check_row_foreign_keys(txn, &t, &row)?;
                    apply_row_update(txn, &t, &cur, &row)?;
                    txn.mark_commutative_key(rk);
                }
                Ok(())
            });
        }
        self.txn.commit()
    }

    pub fn rollback(self) {
        self.txn.rollback()
    }

    pub fn table(&mut self, name: &str) -> Result<Arc<TableDef>> {
        if let Some(t) = self.tables.get(name) {
            return Ok(t.clone());
        }
        let t = Arc::new(catalog::require_table(&mut self.txn, name)?);
        self.tables.insert(name.to_string(), t.clone());
        Ok(t)
    }

    pub fn list_tables(&mut self) -> Result<Vec<TableDef>> {
        catalog::list_tables(&mut self.txn)
    }

    pub fn execute(&mut self, stmt: &Statement) -> Result<QueryResult> {
        let started = std::time::Instant::now();
        Ok(self.execute_stmt(stmt)?.with_duration(started))
    }

    fn execute_stmt(&mut self, stmt: &Statement) -> Result<QueryResult> {
        match stmt {
            Statement::Select(s) => self.exec_select(s, false),
            Statement::Insert(s) => self.exec_insert(s),
            Statement::Update(s) => self.exec_update(s),
            Statement::Delete(s) => self.exec_delete(s),
            Statement::Explain { stmt } => match &**stmt {
                Statement::Select(s) => self.exec_select(s, true),
                Statement::Update(u) => self.explain_dml(&u.table, u.where_.as_ref()),
                Statement::Delete(d) => self.explain_dml(&d.table, d.where_.as_ref()),
                _ => Err(Error::Sql("EXPLAIN supports SELECT, UPDATE and DELETE".into())),
            },
            Statement::CreateTable(spec) => {
                catalog::create_table(&mut self.txn, spec)?;
                self.tables.clear();
                Ok(QueryResult::default())
            }
            Statement::DropTable {
                name,
                if_exists,
                cascade,
            } => {
                catalog::drop_table(&mut self.txn, name, *if_exists, *cascade)?;
                self.tables.clear();
                Ok(QueryResult::default())
            }
            Statement::CreateIndex {
                table,
                index,
                if_not_exists,
            } => {
                catalog::create_index(&mut self.txn, table, index, *if_not_exists)?;
                self.tables.clear();
                Ok(QueryResult::default())
            }
            Statement::DropIndex {
                name,
                table,
                if_exists,
            } => {
                catalog::drop_index(&mut self.txn, name, table.as_deref(), *if_exists)?;
                self.tables.clear();
                Ok(QueryResult::default())
            }
            Statement::AlterTable { table, action } => {
                catalog::alter_table(&mut self.txn, table, action)?;
                self.tables.clear();
                Ok(QueryResult::default())
            }
            Statement::CreateView {
                name,
                query,
                or_replace,
                if_not_exists,
            } => {
                catalog::create_view(&mut self.txn, name, query.clone(), *or_replace, *if_not_exists)?;
                Ok(QueryResult::default())
            }
            Statement::DropView { name, if_exists } => {
                catalog::drop_view(&mut self.txn, name, *if_exists)?;
                Ok(QueryResult::default())
            }
            Statement::Begin | Statement::Commit | Statement::Rollback => Err(Error::Sql(
                "BEGIN/COMMIT/ROLLBACK in an open transaction are not supported (use db.execute_sql)".into(),
            )),
        }
    }

    // ----- SELECT -----------------------------------------------------------

    fn exec_select(&mut self, st: &SelectStmt, explain: bool) -> Result<QueryResult> {
        let empty_ctes = HashMap::new();
        let empty_scope = HashSet::new();
        let mut expanding_views = HashSet::new();
        self.exec_select_impl(st, explain, &empty_ctes, &empty_scope, &mut expanding_views, 0)
    }

    fn exec_select_impl(
        &mut self,
        st: &SelectStmt,
        explain: bool,
        parent_ctes: &HashMap<String, Arc<SubqueryResult>>,
        outer_scope: &HashSet<String>,
        expanding_views: &mut HashSet<String>,
        view_depth: usize,
    ) -> Result<QueryResult> {
        const MAX_VIEW_DEPTH: usize = 32;
        if view_depth > MAX_VIEW_DEPTH {
            return Err(Error::Sql("view expansion depth limit exceeded".into()));
        }
        if let Some(u) = &st.union {
            let mut left = st.clone();
            left.union = None;
            left.order_by = vec![];
            left.limit = None;
            left.offset = None;
            left.distinct = false;
            if explain {
                let mut rows = vec![vec![Value::Text(format!(
                    "UNION{}",
                    if u.all { " ALL" } else { "" }
                ))]];
                rows.extend(
                    self.exec_select_impl(&left, true, parent_ctes, outer_scope, expanding_views, view_depth)?
                        .rows,
                );
                rows.extend(
                    self.exec_select_impl(&u.right, true, parent_ctes, outer_scope, expanding_views, view_depth)?
                        .rows,
                );
                if stmt_contains_window(st) {
                    rows.push(vec![Value::Text("WINDOW".into())]);
                }
                return Ok(QueryResult {
                    columns: vec!["plan".into()],
                    rows,
                    ..Default::default()
                });
            }
            let l = self.exec_select_impl(&left, false, parent_ctes, outer_scope, expanding_views, view_depth)?;
            let r = self.exec_select_impl(&u.right, false, parent_ctes, outer_scope, expanding_views, view_depth)?;
            if l.columns.len() != r.columns.len() {
                return Err(Error::Sql("UNION requires the same number of columns".into()));
            }
            let mut rows = l.rows;
            rows.extend(r.rows);
            if !u.all {
                let mut seen = HashSet::new();
                rows.retain(|row| seen.insert(group_key(row)));
            }
            rows = apply_post_select(st, &l.columns, rows)?;
            return Ok(QueryResult {
                columns: l.columns,
                rows,
                ..Default::default()
            });
        }

        let mut cte_map = parent_ctes.clone();
        for cte in &st.with {
            if references_outer_aliases(&cte.query, outer_scope) {
                return Err(Error::Sql("correlated subqueries are not supported".into()));
            }
            let qr = self.exec_select_impl(&cte.query, false, &cte_map, outer_scope, expanding_views, view_depth)?;
            cte_map.insert(
                cte.name.clone(),
                Arc::new(SubqueryResult {
                    columns: qr.columns,
                    rows: qr.rows,
                }),
            );
        }

        let mut scope: HashSet<String> = outer_scope.clone();
        for c in &st.with {
            scope.insert(c.name.clone());
        }

        // sources
        let mut sources: Vec<Source> = vec![];
        let mut layout = Layout::default();

        let mut push_source = |this: &mut Self,
                               tr: &TableRef,
                               cte_map: &HashMap<String, Arc<SubqueryResult>>,
                               scope: &HashSet<String>|
         -> Result<()> {
            let alias = tr
                .alias
                .clone()
                .unwrap_or_else(|| {
                    if tr.name.is_empty() {
                        "subquery".into()
                    } else {
                        tr.name.clone()
                    }
                });
            if sources.iter().any(|s| s.alias == alias) {
                return Err(Error::Sql(format!("duplicate table alias \"{alias}\"; use an alias")));
            }
            let off = layout.cols.len();
            let kind = if let Some(sq) = &tr.subquery {
                if references_outer_aliases(sq, scope) {
                    return Err(Error::Sql("correlated subqueries are not supported".into()));
                }
                let qr = this.exec_select_impl(sq.as_ref(), false, cte_map, scope, expanding_views, view_depth)?;
                let cols = qr.columns.clone();
                for c in &cols {
                    layout.cols.push((alias.clone(), c.clone()));
                }
                SourceKind::Memory {
                    columns: cols,
                    rows: Arc::new(qr.rows),
                    label: "SUBQUERY".into(),
                }
            } else if let Some(mat) = cte_map.get(&tr.name) {
                for c in &mat.columns {
                    layout.cols.push((alias.clone(), c.clone()));
                }
                SourceKind::Memory {
                    columns: mat.columns.clone(),
                    rows: Arc::new(mat.rows.clone()),
                    label: tr.name.clone(),
                }
            } else if let Some(view) = catalog::load_view(&mut this.txn, &tr.name)? {
                if expanding_views.contains(&tr.name) {
                    return Err(Error::Sql(format!("view expansion cycle: \"{}\"", tr.name)));
                }
                expanding_views.insert(tr.name.clone());
                let qr = this.exec_select_impl(&view.query, false, cte_map, scope, expanding_views, view_depth + 1)?;
                expanding_views.remove(&tr.name);
                let cols = qr.columns.clone();
                for c in &cols {
                    layout.cols.push((alias.clone(), c.clone()));
                }
                SourceKind::Memory {
                    columns: cols,
                    rows: Arc::new(qr.rows),
                    label: format!("VIEW {}", tr.name),
                }
            } else {
                let t = this.table(&tr.name)?;
                for c in &t.columns {
                    layout.cols.push((alias.clone(), c.name.clone()));
                }
                SourceKind::Table(t)
            };
            sources.push(Source { alias: alias.clone(), kind, off });
            Ok(())
        };

        if let Some(from) = &st.from {
            push_source(self, from, &cte_map, &scope)?;
            scope.insert(
                from.alias
                    .clone()
                    .unwrap_or_else(|| {
                        if from.name.is_empty() {
                            "subquery".into()
                        } else {
                            from.name.clone()
                        }
                    }),
            );
        } else if !st.joins.is_empty() {
            return Err(Error::Sql("JOIN requires a FROM table".into()));
        }
        for j in &st.joins {
            push_source(self, &j.table, &cte_map, &scope)?;
            let alias = j
                .table
                .alias
                .clone()
                .unwrap_or_else(|| {
                    if j.table.name.is_empty() {
                        "subquery".into()
                    } else {
                        j.table.name.clone()
                    }
                });
            scope.insert(alias);
        }

        // select list
        let mut items: Vec<(String, Expr)> = vec![];
        let default_star = [SelectItem::Star { table: None }];
        let cols: &[SelectItem] = if st.columns.is_empty() { &default_star } else { &st.columns };
        for it in cols {
            match it {
                SelectItem::Star { table } => {
                    let mut any = false;
                    for s in &sources {
                        if table.as_ref().map_or(true, |t| t == &s.alias) {
                            any = true;
                            let names: Vec<String> = match &s.kind {
                                SourceKind::Table(def) => {
                                    def.columns.iter().map(|c| c.name.clone()).collect()
                                }
                                SourceKind::Memory { columns, .. } => columns.clone(),
                            };
                            for c in names {
                                items.push((
                                    c.clone(),
                                    Expr::Col {
                                        table: Some(s.alias.clone()),
                                        name: c,
                                    },
                                ));
                            }
                        }
                    }
                    if !any {
                        return Err(Error::Sql("`*` has no matching table".into()));
                    }
                }
                SelectItem::Expr { expr, alias } => {
                    let n = items.len();
                    items.push((alias.clone().unwrap_or_else(|| default_name(expr, n)), expr.clone()));
                }
            }
        }

        let agg_mode = items.iter().any(|(_, e)| contains_agg(e))
            || !st.group_by.is_empty()
            || st.having.is_some()
            || st.order_by.iter().any(|o| contains_agg(&o.expr));

        let subq_specs = collect_subqueries(st);
        let mut subq_results: Vec<SubqueryResult> = vec![];
        for sq in &subq_specs {
            if references_outer_aliases(sq, &scope) {
                return Err(Error::Sql("correlated subqueries are not supported".into()));
            }
            let qr = self.exec_select_impl(sq, false, &cte_map, &scope, expanding_views, view_depth)?;
            subq_results.push(SubqueryResult {
                columns: qr.columns,
                rows: qr.rows,
            });
        }

        // bind
        let mut cx = BindCx::new(&layout);
        cx.subqueries = &subq_results;
        let mut on_b: Vec<BExpr> = vec![];
        for j in &st.joins {
            on_b.push(bind(&j.on, &mut cx)?);
        }
        let where_b = match &st.where_ {
            Some(w) => Some(bind(w, &mut cx)?),
            None => None,
        };
        cx.aliases = items.clone();
        let group_b: Vec<BExpr> = st
            .group_by
            .iter()
            .map(|g| bind(g, &mut cx))
            .collect::<Result<_>>()?;
        cx.allow_aggs = agg_mode;
        let select_b: Vec<BExpr> = items
            .iter()
            .map(|(_, e)| bind(e, &mut cx))
            .collect::<Result<_>>()?;
        let having_b = match &st.having {
            Some(h) => Some(bind(h, &mut cx)?),
            None => None,
        };
        let order_b: Vec<(BExpr, bool)> = st
            .order_by
            .iter()
            .map(|o| Ok((bind(&o.expr, &mut cx)?, o.desc)))
            .collect::<Result<_>>()?;
        let aggs = cx.aggs.clone();
        let windows = cx.windows.clone();
        let has_window = !windows.is_empty();

        // plan
        let mut conj: Vec<&BExpr> = vec![];
        if let Some(w) = &where_b {
            split_conjuncts(w, &mut conj);
        }
        let mut path_order: Vec<(usize, bool)> = vec![];
        if !agg_mode && !st.distinct && !order_b.is_empty() && !sources.is_empty() {
            let n0 = sources[0].col_count();
            for (e, d) in &order_b {
                match e {
                    BExpr::Col(i) if *i < n0 => path_order.push((*i, *d)),
                    _ => {
                        path_order.clear();
                        break;
                    }
                }
            }
        }
        let mut plans: Vec<AccessPlan> = vec![];
        if let Some(s0) = sources.first() {
            let p = match &s0.kind {
                SourceKind::Table(def) => plan_access(def, 0, &conj, &path_order, st.limit.is_some()),
                SourceKind::Memory { .. } => AccessPlan::default(),
            };
            plans.push(p);
        }
        for (ji, _) in st.joins.iter().enumerate() {
            let s = &sources[ji + 1];
            let mut jc = vec![];
            split_conjuncts(&on_b[ji], &mut jc);
            let p = match &s.kind {
                SourceKind::Table(def) => plan_access(def, s.off, &jc, &[], false),
                SourceKind::Memory { .. } => AccessPlan::default(),
            };
            plans.push(p);
        }

        if explain {
            if let Some(fast) = pk_bound_agg_plan(st, &sources, &where_b, &aggs, &items) {
                return Ok(QueryResult {
                    columns: vec!["plan".into()],
                    rows: vec![vec![Value::Text(fast)]],
                    ..Default::default()
                });
            }
            let mut rows: Vec<Vec<Value>> = sources
                .iter()
                .zip(plans.iter())
                .map(|(s, p)| vec![Value::Text(s.describe(p))])
                .collect();
            if stmt_contains_window(st) {
                rows.push(vec![Value::Text("WINDOW".into())]);
            }
            return Ok(QueryResult {
                columns: vec!["plan".into()],
                rows,
                ..Default::default()
            });
        }

        let col_names: Vec<String> = items.iter().map(|(n, _)| n.clone()).collect();
        let offset = st.offset.unwrap_or(0).max(0) as usize;
        let limit = st.limit.map(|l| l.max(0) as usize);
        let sorted_by_path = plans.first().map_or(true, |p| p.ordered) || order_b.is_empty();
        let early_stop_at = if !agg_mode && !st.distinct && sorted_by_path && !has_window {
            limit.map(|l| l + offset)
        } else {
            None
        };
        let need_sort = !order_b.is_empty() && !plans.first().map_or(false, |p| p.ordered);

        if let Some(result) = try_pk_bound_aggregate(
            &mut self.txn,
            st,
            &sources,
            &where_b,
            &aggs,
            &items,
            &select_b,
            &col_names,
            &order_b,
            offset,
            limit,
            has_window,
        )? {
            return Ok(result);
        }

        // execute
        let mut out: Vec<(Vec<Value>, Vec<Value>)> = vec![]; // (sort keys, values)
        let mut raw_sources: Vec<Vec<Value>> = vec![];
        let mut groups: Vec<Group> = vec![];
        let mut group_idx: HashMap<Vec<u8>, usize> = HashMap::new();

        let mut handle = |row: Vec<Value>, out: &mut Vec<(Vec<Value>, Vec<Value>)>| -> Result<()> {
            if agg_mode {
                let gk: Vec<Value> = group_b
                    .iter()
                    .map(|g| eval(g, &row, &[]))
                    .collect::<Result<_>>()?;
                let key = group_key(&gk);
                let gi = match group_idx.get(&key) {
                    Some(i) => *i,
                    None => {
                        groups.push(Group {
                            rep: row.clone(),
                            accs: aggs.iter().map(AccState::new).collect(),
                        });
                        group_idx.insert(key, groups.len() - 1);
                        groups.len() - 1
                    }
                };
                for (ai, spec) in aggs.iter().enumerate() {
                    let v = match &spec.arg {
                        Some(a) => Some(eval(a, &row, &[])?),
                        None => None,
                    };
                    groups[gi].accs[ai].update(v)?;
                }
            } else {
                let vals: Vec<Value> = select_b
                    .iter()
                    .map(|e| eval(e, &row, &[]))
                    .collect::<Result<_>>()?;
                let keys: Vec<Value> = if need_sort {
                    order_b
                        .iter()
                        .map(|(e, _)| eval(e, &row, &[]))
                        .collect::<Result<_>>()?
                } else {
                    vec![]
                };
                if has_window {
                    raw_sources.push(row);
                }
                out.push((keys, vals));
            }
            Ok(())
        };

        if sources.is_empty() {
            handle(vec![], &mut out)?;
        } else {
            let mut base = source_iter(&sources[0], &plans[0], &[])?;
            'outer: while let Some(brow) = base.next(&mut self.txn)? {
                let mut rows = vec![brow];
                for (ji, j) in st.joins.iter().enumerate() {
                    let s = &sources[ji + 1];
                    let width = s.col_count();
                    let mut next_rows = vec![];
                    for left in &rows {
                        let mut it = source_iter(s, &plans[ji + 1], left)?;
                        let mut matched = false;
                        while let Some(r) = it.next(&mut self.txn)? {
                            let mut combined = left.clone();
                            combined.extend(r);
                            if eval(&on_b[ji], &combined, &[])?.truthy() == Some(true) {
                                matched = true;
                                next_rows.push(combined);
                            }
                        }
                        if !matched && j.kind == JoinKind::Left {
                            let mut combined = left.clone();
                            combined.extend(std::iter::repeat(Value::Null).take(width));
                            next_rows.push(combined);
                        }
                    }
                    rows = next_rows;
                    if rows.is_empty() {
                        break;
                    }
                }
                for row in rows {
                    if let Some(w) = &where_b {
                        if eval(w, &row, &[])?.truthy() != Some(true) {
                            continue;
                        }
                    }
                    handle(row, &mut out)?;
                    if let Some(stop) = early_stop_at {
                        if out.len() >= stop {
                            break 'outer;
                        }
                    }
                }
            }
        }

        if agg_mode {
            if groups.is_empty() && st.group_by.is_empty() {
                groups.push(Group {
                    rep: vec![],
                    accs: aggs.iter().map(AccState::new).collect(),
                });
            }
            for g in &groups {
                let agg_vals: Vec<Value> = g.accs.iter().map(|a| a.finish()).collect();
                if let Some(h) = &having_b {
                    if eval(h, &g.rep, &agg_vals)?.truthy() != Some(true) {
                        continue;
                    }
                }
                let vals: Vec<Value> = select_b
                    .iter()
                    .map(|e| eval(e, &g.rep, &agg_vals))
                    .collect::<Result<_>>()?;
                let keys: Vec<Value> = order_b
                    .iter()
                    .map(|(e, _)| eval(e, &g.rep, &agg_vals))
                    .collect::<Result<_>>()?;
                out.push((keys, vals));
            }
        }

        if has_window {
            let mut rows: Vec<Vec<Value>> = out.iter().map(|(_, v)| v.clone()).collect();
            apply_windows(&windows, &select_b, &raw_sources, &mut rows)?;
            out = out
                .into_iter()
                .zip(rows)
                .map(|((k, _), v)| (k, v))
                .collect();
        }

        if !order_b.is_empty() && (agg_mode || need_sort) {
            out.sort_by(|a, b| {
                for (i, (_, desc)) in order_b.iter().enumerate() {
                    let o = sort_cmp(&a.0[i], &b.0[i]);
                    let o = if *desc { o.reverse() } else { o };
                    if o != Ordering::Equal {
                        return o;
                    }
                }
                Ordering::Equal
            });
        }
        let mut rows: Vec<Vec<Value>> = out.into_iter().map(|(_, v)| v).collect();
        if st.distinct {
            let mut seen = HashSet::new();
            rows.retain(|r| seen.insert(group_key(r)));
        }
        if offset > 0 {
            rows.drain(..offset.min(rows.len()));
        }
        if let Some(l) = limit {
            rows.truncate(l);
        }
        Ok(QueryResult {
            columns: col_names,
            rows,
            ..Default::default()
        })
    }

    fn explain_dml(&mut self, table: &str, where_: Option<&Expr>) -> Result<QueryResult> {
        let t = self.table(table)?;
        let layout = Layout {
            cols: t.columns.iter().map(|c| (t.name.clone(), c.name.clone())).collect(),
        };
        let mut cx = BindCx::new(&layout);
        let wb = match where_ {
            Some(w) => Some(bind(w, &mut cx)?),
            None => None,
        };
        let mut conj = vec![];
        if let Some(w) = &wb {
            split_conjuncts(w, &mut conj);
        }
        let p = plan_access(&t, 0, &conj, &[], false);
        Ok(QueryResult {
            columns: vec!["plan".into()],
            rows: vec![vec![Value::Text(describe_plan(&t, &p, &t.name))]],
            ..Default::default()
        })
    }

    // ----- helpers for DML ----------------------------------------------------

    fn matching_rows(&mut self, t: &Arc<TableDef>, where_: Option<&Expr>) -> Result<Vec<Vec<Value>>> {
        let layout = Layout {
            cols: t.columns.iter().map(|c| (t.name.clone(), c.name.clone())).collect(),
        };
        let mut cx = BindCx::new(&layout);
        let wb = match where_ {
            Some(w) => Some(bind(w, &mut cx)?),
            None => None,
        };
        let mut conj = vec![];
        if let Some(w) = &wb {
            split_conjuncts(w, &mut conj);
        }
        let plan = plan_access(t, 0, &conj, &[], false);
        let mut it = row_iter(t, &plan, &[])?;
        let mut rows = vec![];
        while let Some(r) = it.next(&mut self.txn)? {
            if let Some(w) = &wb {
                if eval(w, &r, &[])?.truthy() != Some(true) {
                    continue;
                }
            }
            rows.push(r);
        }
        Ok(rows)
    }

    fn returning(
        &mut self,
        t: &TableDef,
        items: &Option<Vec<SelectItem>>,
        rows: &[Vec<Value>],
    ) -> Result<(Vec<String>, Vec<Vec<Value>>)> {
        let Some(items) = items else {
            return Ok((vec![], vec![]));
        };
        let layout = Layout {
            cols: t.columns.iter().map(|c| (t.name.clone(), c.name.clone())).collect(),
        };
        let mut names = vec![];
        let mut exprs = vec![];
        for it in items {
            match it {
                SelectItem::Star { .. } => {
                    for c in &t.columns {
                        names.push(c.name.clone());
                        exprs.push(Expr::col(&c.name));
                    }
                }
                SelectItem::Expr { expr, alias } => {
                    names.push(alias.clone().unwrap_or_else(|| default_name(expr, names.len())));
                    exprs.push(expr.clone());
                }
            }
        }
        let mut cx = BindCx::new(&layout);
        let bound: Vec<BExpr> = exprs.iter().map(|e| bind(e, &mut cx)).collect::<Result<_>>()?;
        let mut out = vec![];
        for r in rows {
            out.push(bound.iter().map(|b| eval(b, r, &[])).collect::<Result<Vec<_>>>()?);
        }
        Ok((names, out))
    }

    fn auto_counter(&mut self, t: &TableDef) -> Result<Arc<std::sync::atomic::AtomicI64>> {
        let eng = self.txn.engine().clone();
        let eng2 = eng.clone();
        eng.aux_counter(t.id, move || {
            let mut rt = eng2.begin(Isolation::Snapshot);
            let (lo, hi) = prefix_range(&t.row_prefix());
            let mut sc = rt.scan(lo, hi, true)?;
            let next = match sc.next() {
                Some(Ok((_, v))) => {
                    let row = t.decode_value(&v)?;
                    let p = t.pk_positions()[0];
                    Ok(row[p].as_i64().unwrap_or(0) + 1)
                }
                Some(Err(e)) => Err(e),
                None => Ok(1),
            };
            rt.commit()?;
            next
        })
    }

    fn check_row(&self, t: &TableDef, row: &mut [Value]) -> Result<()> {
        for (i, c) in t.columns.iter().enumerate() {
            let v = std::mem::replace(&mut row[i], Value::Null);
            let v = c.ty.coerce(v).map_err(|e| {
                Error::Constraint(format!("column \"{}\": {}", c.name, e.to_string().replace("constraint violation: ", "")))
            })?;
            if v.is_null() && !c.nullable {
                return Err(Error::Constraint(format!(
                    "NOT NULL constraint failed: {}.{}",
                    t.name, c.name
                )));
            }
            row[i] = v;
        }
        Ok(())
    }

    fn write_new(&mut self, t: &TableDef, row: &[Value]) -> Result<()> {
        check_row_foreign_keys(&mut self.txn, t, row)?;
        let pk = t.pk_enc(row);
        self.txn.put(&t.row_key(&pk), &t.encode_value(row))?;
        for idx in &t.indexes {
            if idx.unique && !t.index_has_null(idx, row) {
                self.txn.put(&t.guard_key(idx, row), &pk)?;
            }
            self.txn.put(&t.index_key(idx, row, &pk), &pk)?;
        }
        Ok(())
    }

    fn remove_row_without_fk_check(&mut self, t: &TableDef, row: &[Value]) -> Result<()> {
        let pk = t.pk_enc(row);
        self.txn.delete(&t.row_key(&pk))?;
        for idx in &t.indexes {
            if idx.unique && !t.index_has_null(idx, row) {
                self.txn.delete(&t.guard_key(idx, row))?;
            }
            self.txn.delete(&t.index_key(idx, row, &pk))?;
        }
        Ok(())
    }

    fn remove_row(&mut self, t: &TableDef, row: &[Value]) -> Result<()> {
        check_referencing_children(&mut self.txn, t, row)?;
        self.remove_row_without_fk_check(t, row)
    }

    fn unique_violation(t: &TableDef, which: &str, cols: &[String]) -> Error {
        Error::Constraint(format!(
            "UNIQUE constraint failed: {} ({}) on table {}",
            which,
            cols.join(", "),
            t.name
        ))
    }

    /// Find an existing row that conflicts (same PK or same unique value) with `row`.
    fn find_conflict(&mut self, t: &TableDef, row: &[Value]) -> Result<Option<(Vec<Value>, String, Vec<String>)>> {
        let pk = t.pk_enc(row);
        if let Some(b) = self.txn.get(&t.row_key(&pk))? {
            return Ok(Some((t.decode_value(&b)?, "PRIMARY KEY".into(), t.primary_key.clone())));
        }
        for idx in &t.indexes {
            if idx.unique && !t.index_has_null(idx, row) {
                if let Some(cpk) = self.txn.get(&t.guard_key(idx, row))? {
                    if let Some(b) = self.txn.get(&t.row_key(&cpk))? {
                        return Ok(Some((t.decode_value(&b)?, idx.name.clone(), idx.columns.clone())));
                    }
                }
            }
        }
        Ok(None)
    }

    fn update_row(&mut self, t: &TableDef, old: &[Value], new: &[Value]) -> Result<()> {
        check_row_foreign_keys(&mut self.txn, t, new)?;
        let old_pk = t.pk_enc(old);
        let new_pk = t.pk_enc(new);
        let refs_changed = parent_ref_columns_changed(&mut self.txn, t, old, new)?;
        if old_pk != new_pk {
            check_referencing_children(&mut self.txn, t, old)?;
            self.remove_row_without_fk_check(t, old)?;
            if let Some((_, which, cols)) = self.find_conflict(t, new)? {
                return Err(Self::unique_violation(t, &which, &cols));
            }
            return self.write_new(t, new);
        }
        if refs_changed {
            check_referencing_children(&mut self.txn, t, old)?;
        }
        apply_row_update(&mut self.txn, t, old, new)
    }

    // ----- INSERT ---------------------------------------------------------------

    fn exec_insert(&mut self, st: &InsertStmt) -> Result<QueryResult> {
        let t = self.table(&st.table)?;
        let positions: Vec<usize> = match &st.columns {
            Some(cols) => cols
                .iter()
                .map(|c| {
                    t.col_pos(c)
                        .ok_or_else(|| Error::NotFound(format!("column \"{c}\" not found in \"{}\"", t.name)))
                })
                .collect::<Result<_>>()?,
            None => (0..t.columns.len()).collect(),
        };
        let pk_pos = t.pk_positions();
        let auto_pos = if t.auto_increment { Some(pk_pos[0]) } else { None };

        // bind ON CONFLICT update expressions over [existing ++ excluded]
        let upd_layout = Layout {
            cols: t
                .columns
                .iter()
                .map(|c| (t.name.clone(), c.name.clone()))
                .chain(t.columns.iter().map(|c| ("excluded".to_string(), c.name.clone())))
                .collect(),
        };
        let mut upd_bound: Option<Vec<(usize, BExpr)>> = None;
        if let Some(OnConflict {
            action: ConflictAction::DoUpdate { set },
            ..
        }) = &st.on_conflict
        {
            let mut cx = BindCx::new(&upd_layout);
            let mut v = vec![];
            for a in set {
                let p = t
                    .col_pos(&a.column)
                    .ok_or_else(|| Error::NotFound(format!("column \"{}\" not found", a.column)))?;
                v.push((p, bind(&a.expr, &mut cx)?));
            }
            upd_bound = Some(v);
        }

        let mut inserted: Vec<Vec<Value>> = vec![];
        let mut affected = 0u64;
        let mut last_id = None;
        for exprs in &st.rows {
            if exprs.len() != positions.len() {
                return Err(Error::Sql(format!(
                    "expected {} values, got {}",
                    positions.len(),
                    exprs.len()
                )));
            }
            let mut row: Vec<Option<Value>> = vec![None; t.columns.len()];
            for (e, p) in exprs.iter().zip(&positions) {
                // `{t:"func", name:"default"}` = DEFAULT keyword: leave the slot empty
                if matches!(e, Expr::Func { name, args, .. } if args.is_empty() && name.eq_ignore_ascii_case("default")) {
                    continue;
                }
                row[*p] = Some(eval_const(e)?);
            }
            let mut full: Vec<Value> = Vec::with_capacity(row.len());
            for (i, slot) in row.into_iter().enumerate() {
                let v = match slot {
                    Some(v) => v,
                    None => match &t.columns[i].default {
                        Some(ColDefault::Value { v }) => v.clone(),
                        Some(ColDefault::Now) => Value::Int(now_ms()),
                        Some(ColDefault::Uuid7) => Value::Text(uuid7()),
                        Some(ColDefault::Uuid4) => Value::Text(uuid4()),
                        None => Value::Null,
                    },
                };
                full.push(v);
            }
            if let Some(ap) = auto_pos {
                let counter = self.auto_counter(&t)?;
                match full[ap].as_i64() {
                    Some(explicit) if !full[ap].is_null() => {
                        counter.fetch_max(explicit + 1, AtomicOrdering::SeqCst);
                    }
                    _ => {
                        full[ap] = Value::Int(counter.fetch_add(1, AtomicOrdering::SeqCst));
                    }
                }
            }
            self.check_row(&t, &mut full)?;
            let conflict = self.find_conflict(&t, &full)?;
            match (conflict, &st.on_conflict) {
                (None, _) => {
                    self.write_new(&t, &full)?;
                    affected += 1;
                    if let Some(ap) = auto_pos.or_else(|| pk_pos.first().copied()) {
                        last_id = Some(full[ap].clone());
                    }
                    inserted.push(full);
                }
                (Some((_, which, cols)), None) => return Err(Self::unique_violation(&t, &which, &cols)),
                (Some((_, which, cols)), Some(oc)) if !target_matches(&oc.target, &cols) => {
                    return Err(Self::unique_violation(&t, &which, &cols))
                }
                (Some(_), Some(OnConflict { action: ConflictAction::DoNothing, .. })) => {}
                (Some((old, _, _)), Some(OnConflict { action: ConflictAction::DoUpdate { .. }, .. })) => {
                    let combined: Vec<Value> = old.iter().cloned().chain(full.iter().cloned()).collect();
                    let mut new = old.clone();
                    for (p, e) in upd_bound.as_ref().unwrap() {
                        new[*p] = eval(e, &combined, &[])?;
                    }
                    self.check_row(&t, &mut new)?;
                    self.update_row(&t, &old, &new)?;
                    affected += 1;
                    inserted.push(new);
                }
            }
        }
        let (columns, rows) = self.returning(&t, &st.returning, &inserted)?;
        Ok(QueryResult {
            columns,
            rows,
            rows_affected: affected,
            last_insert_id: last_id,
            ..Default::default()
        })
    }

    // ----- UPDATE / DELETE --------------------------------------------------------

    fn exec_update(&mut self, st: &UpdateStmt) -> Result<QueryResult> {
        let t = self.table(&st.table)?;
        let layout = Layout {
            cols: t.columns.iter().map(|c| (t.name.clone(), c.name.clone())).collect(),
        };
        let mut cx = BindCx::new(&layout);
        let mut sets = vec![];
        for a in &st.set {
            let p = t
                .col_pos(&a.column)
                .ok_or_else(|| Error::NotFound(format!("column \"{}\" not found", a.column)))?;
            sets.push((p, bind(&a.expr, &mut cx)?));
        }
        let wb = match st.where_.as_ref() {
            Some(w) => Some(bind(w, &mut cx)?),
            None => None,
        };
        let rows = self.matching_rows(&t, st.where_.as_ref())?;
        let mut updated = vec![];
        let pk_cols: HashSet<usize> = t.pk_positions().into_iter().collect();
        let commutative_ok = !sets.is_empty()
            && sets
                .iter()
                .all(|(p, e)| int_increment_delta(e, *p).is_some() && !pk_cols.contains(p));
        for old in rows {
            if commutative_ok {
                let pk = t.pk_enc(&old);
                let rk = t.row_key(&pk);
                let mut new = old.clone();
                let mut deltas = HashMap::new();
                for (p, e) in &sets {
                    let d = int_increment_delta(e, *p).unwrap();
                    deltas.insert(*p, d);
                }
                let entry = self
                    .commutative
                    .entry(rk.clone())
                    .or_insert_with(|| (t.clone(), old.clone(), Vec::new()));
                entry.2.push((deltas, wb.clone()));
                replay_commutative_ops(&t.name, &mut new, &entry.2, true)?;
                self.check_row(&t, &mut new)?;
                updated.push(new);
            } else {
                let mut new = old.clone();
                for (p, e) in &sets {
                    new[*p] = eval(e, &old, &[])?;
                }
                self.check_row(&t, &mut new)?;
                self.update_row(&t, &old, &new)?;
                updated.push(new);
            }
        }
        let (columns, rows) = self.returning(&t, &st.returning, &updated)?;
        Ok(QueryResult {
            columns,
            rows,
            rows_affected: updated.len() as u64,
            last_insert_id: None,
            ..Default::default()
        })
    }

    fn exec_delete(&mut self, st: &DeleteStmt) -> Result<QueryResult> {
        let t = self.table(&st.table)?;
        let rows = self.matching_rows(&t, st.where_.as_ref())?;
        for r in &rows {
            self.remove_row(&t, r)?;
        }
        let (columns, out) = self.returning(&t, &st.returning, &rows)?;
        Ok(QueryResult {
            columns,
            rows: out,
            rows_affected: rows.len() as u64,
            last_insert_id: None,
            ..Default::default()
        })
    }
}
