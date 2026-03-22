use crate::mark_index::MarkCache;
use arrow::datatypes::SchemaRef;
use tv_core::{Literal, Predicate, ViewOp};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PipelineClass {
    PureRead,
    StatelessOnly,
    NeedsMaterialization,
}

pub(crate) fn classify_pipeline(ops: &[ViewOp]) -> PipelineClass {
    if ops.is_empty() {
        return PipelineClass::PureRead;
    }
    for op in ops {
        match op {
            ViewOp::Sort { .. }
            | ViewOp::GroupBy { .. }
            | ViewOp::Deduplicate { .. }
            | ViewOp::Sample { .. }
            | ViewOp::Limit { .. }
            | ViewOp::TopK { .. } => return PipelineClass::NeedsMaterialization,
            _ => {}
        }
    }
    PipelineClass::StatelessOnly
}

pub(crate) fn extract_combined_filter(ops: &[ViewOp]) -> Option<Predicate> {
    let filter_preds: Vec<Predicate> = ops
        .iter()
        .filter_map(|op| {
            if let ViewOp::Filter { predicate } = op {
                Some(predicate.clone())
            } else {
                None
            }
        })
        .collect();

    match filter_preds.len() {
        0 => None,
        1 => Some(filter_preds.into_iter().next().unwrap()),
        _ => Some(Predicate::And {
            exprs: filter_preds,
        }),
    }
}

pub(crate) fn literal_to_f64(lit: &Literal) -> Option<f64> {
    match lit {
        Literal::Int(n) => Some(*n as f64),
        Literal::Float(f) => Some(*f),
        _ => None,
    }
}

pub(crate) fn pred_col_for_roaring(predicate: &Predicate, schema: &SchemaRef) -> Option<usize> {
    use crate::roaring_index::applicable_predicate;
    if let Some((col_name, _)) = applicable_predicate(predicate) {
        if let Ok(idx) = schema.index_of(col_name) {
            let field = schema.field(idx);
            if matches!(
                field.data_type(),
                arrow::datatypes::DataType::Utf8 | arrow::datatypes::DataType::LargeUtf8
            ) {
                return Some(idx);
            }
        }
    }
    None
}

pub(crate) fn mark_qualifying_rgs(
    pred: &Predicate,
    schema: &SchemaRef,
    path: &str,
    mark_cache: &MarkCache,
) -> Option<Vec<usize>> {
    match pred {
        Predicate::Eq { column, value } => {
            let col_idx = schema.index_of(column).ok()?;
            let val = literal_to_f64(value)?;
            let cache = mark_cache.read().unwrap();
            let mi = cache.get(&(path.to_string(), col_idx))?;
            Some(mi.lookup_eq(val))
        }
        Predicate::Gt { column, value } => {
            let col_idx = schema.index_of(column).ok()?;
            let val = literal_to_f64(value)?;
            let cache = mark_cache.read().unwrap();
            let mi = cache.get(&(path.to_string(), col_idx))?;
            Some(mi.lookup_gt(val))
        }
        Predicate::Gte { column, value } => {
            let col_idx = schema.index_of(column).ok()?;
            let val = literal_to_f64(value)?;
            let cache = mark_cache.read().unwrap();
            let mi = cache.get(&(path.to_string(), col_idx))?;
            Some(mi.lookup_gte(val))
        }
        Predicate::Lt { column, value } => {
            let col_idx = schema.index_of(column).ok()?;
            let val = literal_to_f64(value)?;
            let cache = mark_cache.read().unwrap();
            let mi = cache.get(&(path.to_string(), col_idx))?;
            Some(mi.lookup_lt(val))
        }
        Predicate::Lte { column, value } => {
            let col_idx = schema.index_of(column).ok()?;
            let val = literal_to_f64(value)?;
            let cache = mark_cache.read().unwrap();
            let mi = cache.get(&(path.to_string(), col_idx))?;
            Some(mi.lookup_lte(val))
        }
        Predicate::Between { column, lo, hi } => {
            let col_idx = schema.index_of(column).ok()?;
            let lo_val = literal_to_f64(lo)?;
            let hi_val = literal_to_f64(hi)?;
            let cache = mark_cache.read().unwrap();
            let mi = cache.get(&(path.to_string(), col_idx))?;
            Some(mi.lookup_between(lo_val, hi_val))
        }
        Predicate::And { exprs } => exprs
            .iter()
            .find_map(|e| mark_qualifying_rgs(e, schema, path, mark_cache)),
        _ => None,
    }
}
