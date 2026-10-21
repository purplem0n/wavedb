//! Dynamic SQL values, column types, order-preserving key encoding and the
//! compact row codec.

use crate::error::{Error, Result};
use base64::Engine as _;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::cmp::Ordering;

#[derive(Clone, Debug)]
pub enum Value {
    Null,
    Int(i64),
    Real(f64),
    Text(String),
    Bool(bool),
    Blob(Vec<u8>),
    Json(serde_json::Value),
}

impl PartialEq for Value {
    fn eq(&self, other: &Self) -> bool {
        sort_cmp(self, other) == Ordering::Equal
    }
}

impl Value {
    pub fn from_json(j: &serde_json::Value) -> Value {
        use serde_json::Value as J;
        match j {
            J::Null => Value::Null,
            J::Bool(b) => Value::Bool(*b),
            J::Number(n) => {
                if let Some(i) = n.as_i64() {
                    Value::Int(i)
                } else if let Some(f) = n.as_f64() {
                    Value::Real(f)
                } else {
                    Value::Null
                }
            }
            J::String(s) => Value::Text(s.clone()),
            J::Array(_) => Value::Json(j.clone()),
            J::Object(m) => {
                if m.len() == 1 {
                    if let Some(J::String(b64)) = m.get("$blob") {
                        if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(b64) {
                            return Value::Blob(bytes);
                        }
                    }
                }
                Value::Json(j.clone())
            }
        }
    }

    pub fn to_json(&self) -> serde_json::Value {
        use serde_json::Value as J;
        match self {
            Value::Null => J::Null,
            Value::Int(i) => J::from(*i),
            Value::Real(f) => serde_json::Number::from_f64(*f).map(J::Number).unwrap_or(J::Null),
            Value::Text(s) => J::String(s.clone()),
            Value::Bool(b) => J::Bool(*b),
            Value::Blob(b) => {
                let mut m = serde_json::Map::new();
                m.insert(
                    "$blob".into(),
                    J::String(base64::engine::general_purpose::STANDARD.encode(b)),
                );
                J::Object(m)
            }
            Value::Json(j) => j.clone(),
        }
    }

    pub fn is_null(&self) -> bool {
        matches!(self, Value::Null)
    }

    pub fn as_f64(&self) -> Option<f64> {
        match self {
            Value::Int(i) => Some(*i as f64),
            Value::Real(f) => Some(*f),
            _ => None,
        }
    }

    pub fn as_i64(&self) -> Option<i64> {
        match self {
            Value::Int(i) => Some(*i),
            Value::Real(f) if f.fract() == 0.0 => Some(*f as i64),
            _ => None,
        }
    }

    /// Three-valued truthiness: `None` is SQL NULL / unknown.
    pub fn truthy(&self) -> Option<bool> {
        match self {
            Value::Null => None,
            Value::Bool(b) => Some(*b),
            Value::Int(i) => Some(*i != 0),
            Value::Real(f) => Some(*f != 0.0),
            _ => Some(true),
        }
    }

    pub fn type_name(&self) -> &'static str {
        match self {
            Value::Null => "null",
            Value::Int(_) => "int",
            Value::Real(_) => "real",
            Value::Text(_) => "text",
            Value::Bool(_) => "bool",
            Value::Blob(_) => "blob",
            Value::Json(_) => "json",
        }
    }

    pub fn display(&self) -> String {
        match self {
            Value::Null => "NULL".into(),
            Value::Int(i) => i.to_string(),
            Value::Real(f) => f.to_string(),
            Value::Text(s) => s.clone(),
            Value::Bool(b) => b.to_string(),
            Value::Blob(b) => format!("<blob {} bytes>", b.len()),
            Value::Json(j) => j.to_string(),
        }
    }
}

impl Serialize for Value {
    fn serialize<S: Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        self.to_json().serialize(s)
    }
}

impl<'de> Deserialize<'de> for Value {
    fn deserialize<D: Deserializer<'de>>(d: D) -> std::result::Result<Self, D::Error> {
        let j = serde_json::Value::deserialize(d)?;
        Ok(Value::from_json(&j))
    }
}

fn type_rank(v: &Value) -> u8 {
    match v {
        Value::Null => 0,
        Value::Int(_) | Value::Real(_) => 1,
        Value::Text(_) => 2,
        Value::Bool(_) => 3,
        Value::Blob(_) => 4,
        Value::Json(_) => 5,
    }
}

/// SQL comparison: `None` when either side is NULL or the types are incomparable.
pub fn sql_cmp(a: &Value, b: &Value) -> Option<Ordering> {
    match (a, b) {
        (Value::Null, _) | (_, Value::Null) => None,
        (Value::Int(x), Value::Int(y)) => Some(x.cmp(y)),
        (Value::Int(_) | Value::Real(_), Value::Int(_) | Value::Real(_)) => {
            a.as_f64()?.partial_cmp(&b.as_f64()?)
        }
        (Value::Text(x), Value::Text(y)) => Some(x.cmp(y)),
        (Value::Bool(x), Value::Bool(y)) => Some(x.cmp(y)),
        (Value::Blob(x), Value::Blob(y)) => Some(x.cmp(y)),
        (Value::Json(x), Value::Json(y)) => Some(x.to_string().cmp(&y.to_string())),
        _ => None,
    }
}

/// Total ordering used for ORDER BY, grouping and DISTINCT (NULL sorts first).
pub fn sort_cmp(a: &Value, b: &Value) -> Ordering {
    match sql_cmp(a, b) {
        Some(o) => o,
        None => {
            let (ra, rb) = (type_rank(a), type_rank(b));
            if ra != rb {
                ra.cmp(&rb)
            } else {
                Ordering::Equal
            }
        }
    }
}

// ---------------------------------------------------------------------------
// column types
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ColumnType {
    Int,
    Real,
    Text,
    Bool,
    Blob,
    Json,
    Timestamp,
    Uuid,
}

impl ColumnType {
    pub fn name(&self) -> &'static str {
        match self {
            ColumnType::Int => "int",
            ColumnType::Real => "real",
            ColumnType::Text => "text",
            ColumnType::Bool => "bool",
            ColumnType::Blob => "blob",
            ColumnType::Json => "json",
            ColumnType::Timestamp => "timestamp",
            ColumnType::Uuid => "uuid",
        }
    }

    /// Coerce a value to this column type (NULL is always accepted here;
    /// NOT NULL is enforced by the caller).
    pub fn coerce(&self, v: Value) -> Result<Value> {
        if v.is_null() {
            return Ok(v);
        }
        let bad = |v: &Value| {
            Error::Constraint(format!("cannot store {} value in {} column", v.type_name(), self.name()))
        };
        Ok(match self {
            ColumnType::Int => match &v {
                Value::Int(_) => v,
                Value::Real(f) if f.fract() == 0.0 && f.is_finite() => Value::Int(*f as i64),
                Value::Bool(b) => Value::Int(*b as i64),
                Value::Text(s) => Value::Int(s.trim().parse::<i64>().map_err(|_| bad(&v))?),
                _ => return Err(bad(&v)),
            },
            ColumnType::Real => match &v {
                Value::Real(_) => v,
                Value::Int(i) => Value::Real(*i as f64),
                Value::Text(s) => Value::Real(s.trim().parse::<f64>().map_err(|_| bad(&v))?),
                _ => return Err(bad(&v)),
            },
            ColumnType::Text => match &v {
                Value::Text(_) => v,
                _ => return Err(bad(&v)),
            },
            ColumnType::Bool => match &v {
                Value::Bool(_) => v,
                Value::Int(0) => Value::Bool(false),
                Value::Int(1) => Value::Bool(true),
                _ => return Err(bad(&v)),
            },
            ColumnType::Blob => match &v {
                Value::Blob(_) => v,
                _ => return Err(bad(&v)),
            },
            ColumnType::Json => match v {
                Value::Json(_) => v,
                Value::Blob(_) => return Err(bad(&v)),
                // text that holds a JSON object/array is parsed; any other text is a JSON string
                Value::Text(s) => match serde_json::from_str::<serde_json::Value>(&s) {
                    Ok(j @ (serde_json::Value::Object(_) | serde_json::Value::Array(_))) => Value::Json(j),
                    _ => Value::Json(serde_json::Value::String(s)),
                },
                other => Value::Json(other.to_json()),
            },
            ColumnType::Timestamp => match &v {
                Value::Int(_) => v,
                Value::Real(f) if f.is_finite() => Value::Int(*f as i64),
                Value::Text(s) => Value::Int(parse_timestamp(s).ok_or_else(|| bad(&v))?),
                _ => return Err(bad(&v)),
            },
            ColumnType::Uuid => match &v {
                Value::Text(s) if is_uuid(s) => Value::Text(s.to_ascii_lowercase()),
                _ => return Err(bad(&v)),
            },
        })
    }
}

fn is_uuid(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() != 36 {
        return false;
    }
    b.iter().enumerate().all(|(i, c)| match i {
        8 | 13 | 18 | 23 => *c == b'-',
        _ => c.is_ascii_hexdigit(),
    })
}

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

/// Parses `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM:SS[.fff](Z|±HH:MM)` into epoch milliseconds.
pub fn parse_timestamp(s: &str) -> Option<i64> {
    let s = s.trim();
    let (date, rest) = match s.find(['T', ' ']) {
        Some(i) => (&s[..i], Some(&s[i + 1..])),
        None => (s, None),
    };
    let mut dp = date.split('-');
    let y: i64 = dp.next()?.parse().ok()?;
    let m: i64 = dp.next()?.parse().ok()?;
    let d: i64 = dp.next()?.parse().ok()?;
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    let mut ms = days_from_civil(y, m, d) * 86_400_000;
    if let Some(rest) = rest {
        let (time, offset_ms) = if let Some(t) = rest.strip_suffix('Z') {
            (t, 0)
        } else if let Some(i) = rest.rfind(['+', '-']).filter(|i| *i > 0) {
            let (t, off) = rest.split_at(i);
            let sign = if off.starts_with('-') { -1 } else { 1 };
            let mut op = off[1..].split(':');
            let oh: i64 = op.next()?.parse().ok()?;
            let om: i64 = op.next().unwrap_or("0").parse().ok()?;
            (t, sign * (oh * 3_600_000 + om * 60_000))
        } else {
            (rest, 0)
        };
        let mut tp = time.split(':');
        let h: i64 = tp.next()?.parse().ok()?;
        let mi: i64 = tp.next().unwrap_or("0").parse().ok()?;
        let sec_str = tp.next().unwrap_or("0");
        let sec: f64 = sec_str.parse().ok()?;
        ms += h * 3_600_000 + mi * 60_000 + (sec * 1000.0).round() as i64 - offset_ms;
    }
    Some(ms)
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn uuid4() -> String {
    let mut b = [0u8; 16];
    getrandom::fill(&mut b).expect("os rng");
    b[6] = (b[6] & 0x0F) | 0x40;
    b[8] = (b[8] & 0x3F) | 0x80;
    fmt_uuid(&b)
}

/// Time-ordered UUID (v7): 48-bit ms timestamp + randomness.
pub fn uuid7() -> String {
    let mut b = [0u8; 16];
    getrandom::fill(&mut b).expect("os rng");
    let ms = now_ms() as u64;
    b[0..6].copy_from_slice(&ms.to_be_bytes()[2..8]);
    b[6] = (b[6] & 0x0F) | 0x70;
    b[8] = (b[8] & 0x3F) | 0x80;
    fmt_uuid(&b)
}

fn fmt_uuid(b: &[u8; 16]) -> String {
    let h: String = b.iter().map(|x| format!("{x:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32])
}

// ---------------------------------------------------------------------------
// order-preserving key encoding
// ---------------------------------------------------------------------------

fn push_escaped(out: &mut Vec<u8>, bytes: &[u8]) {
    for &b in bytes {
        out.push(b);
        if b == 0 {
            out.push(0xFF);
        }
    }
    out.extend_from_slice(&[0, 0]);
}

/// Encode a value so that byte-wise comparison matches value ordering.
pub fn encode_key_value(v: &Value, out: &mut Vec<u8>) {
    match v {
        Value::Null => out.push(0x00),
        Value::Int(i) => {
            out.push(0x10);
            out.extend_from_slice(&((*i as u64) ^ (1 << 63)).to_be_bytes());
        }
        Value::Real(f) => {
            out.push(0x20);
            let bits = f.to_bits();
            let t = if bits >> 63 == 1 { !bits } else { bits ^ (1 << 63) };
            out.extend_from_slice(&t.to_be_bytes());
        }
        Value::Text(s) => {
            out.push(0x30);
            push_escaped(out, s.as_bytes());
        }
        Value::Bool(b) => {
            out.push(0x40);
            out.push(*b as u8);
        }
        Value::Blob(b) => {
            out.push(0x50);
            push_escaped(out, b);
        }
        Value::Json(j) => {
            out.push(0x60);
            push_escaped(out, j.to_string().as_bytes());
        }
    }
}

// ---------------------------------------------------------------------------
// row codec: [col_id u16][tag u8][payload] ... for every non-null column
// ---------------------------------------------------------------------------

pub fn encode_row(cols: &[(u16, &Value)]) -> Vec<u8> {
    let mut out = Vec::with_capacity(16 + cols.len() * 12);
    for (id, v) in cols {
        if v.is_null() {
            continue;
        }
        out.extend_from_slice(&id.to_le_bytes());
        match v {
            Value::Null => unreachable!(),
            Value::Int(i) => {
                out.push(1);
                out.extend_from_slice(&i.to_le_bytes());
            }
            Value::Real(f) => {
                out.push(2);
                out.extend_from_slice(&f.to_le_bytes());
            }
            Value::Text(s) => {
                out.push(3);
                out.extend_from_slice(&(s.len() as u32).to_le_bytes());
                out.extend_from_slice(s.as_bytes());
            }
            Value::Bool(b) => {
                out.push(4);
                out.push(*b as u8);
            }
            Value::Blob(b) => {
                out.push(5);
                out.extend_from_slice(&(b.len() as u32).to_le_bytes());
                out.extend_from_slice(b);
            }
            Value::Json(j) => {
                let s = j.to_string();
                out.push(6);
                out.extend_from_slice(&(s.len() as u32).to_le_bytes());
                out.extend_from_slice(s.as_bytes());
            }
        }
    }
    out
}

/// Decode a row into `(col_id, value)` pairs.
pub fn decode_row(mut b: &[u8]) -> Result<Vec<(u16, Value)>> {
    let corrupt = || Error::Storage("corrupt row encoding".into());
    let mut out = Vec::new();
    while !b.is_empty() {
        if b.len() < 3 {
            return Err(corrupt());
        }
        let id = u16::from_le_bytes([b[0], b[1]]);
        let tag = b[2];
        b = &b[3..];
        let take = |b: &mut &[u8], n: usize| -> Result<Vec<u8>> {
            if b.len() < n {
                return Err(corrupt());
            }
            let v = b[..n].to_vec();
            *b = &b[n..];
            Ok(v)
        };
        let v = match tag {
            1 => Value::Int(i64::from_le_bytes(take(&mut b, 8)?.try_into().unwrap())),
            2 => Value::Real(f64::from_le_bytes(take(&mut b, 8)?.try_into().unwrap())),
            3 | 5 | 6 => {
                let n = u32::from_le_bytes(take(&mut b, 4)?.try_into().unwrap()) as usize;
                let data = take(&mut b, n)?;
                match tag {
                    3 => Value::Text(String::from_utf8(data).map_err(|_| corrupt())?),
                    5 => Value::Blob(data),
                    _ => Value::Json(serde_json::from_slice(&data).map_err(|_| corrupt())?),
                }
            }
            4 => Value::Bool(take(&mut b, 1)?[0] != 0),
            _ => return Err(corrupt()),
        };
        out.push((id, v));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_encoding_orders_like_values() {
        let vals = vec![
            Value::Int(i64::MIN),
            Value::Int(-5),
            Value::Int(0),
            Value::Int(7),
            Value::Int(i64::MAX),
        ];
        let enc: Vec<Vec<u8>> = vals
            .iter()
            .map(|v| {
                let mut o = vec![];
                encode_key_value(v, &mut o);
                o
            })
            .collect();
        assert!(enc.windows(2).all(|w| w[0] < w[1]));
        let fl = [-1e9, -1.5, -0.0, 0.0, 0.5, 2.0, 1e300];
        let enc: Vec<Vec<u8>> = fl
            .iter()
            .map(|f| {
                let mut o = vec![];
                encode_key_value(&Value::Real(*f), &mut o);
                o
            })
            .collect();
        assert!(enc.windows(2).all(|w| w[0] <= w[1]));
        let mut a = vec![];
        let mut b = vec![];
        encode_key_value(&Value::Text("ab".into()), &mut a);
        encode_key_value(&Value::Text("ab\0".into()), &mut b);
        assert!(a < b);
    }

    #[test]
    fn row_roundtrip() {
        let vals = vec![
            Value::Int(-9),
            Value::Real(2.5),
            Value::Text("héllo".into()),
            Value::Bool(true),
            Value::Blob(vec![0, 1, 2]),
            Value::Json(serde_json::json!({"a": [1, 2]})),
            Value::Null,
        ];
        let cols: Vec<(u16, &Value)> = vals.iter().enumerate().map(|(i, v)| (i as u16, v)).collect();
        let bytes = encode_row(&cols);
        let dec = decode_row(&bytes).unwrap();
        assert_eq!(dec.len(), 6);
        assert_eq!(dec[2].1, Value::Text("héllo".into()));
    }

    #[test]
    fn timestamps() {
        assert_eq!(parse_timestamp("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_timestamp("2024-01-01"), Some(1704067200000));
        assert_eq!(parse_timestamp("2024-01-01T01:00:00+01:00"), Some(1704067200000));
    }
}
