import type { AcceptanceItemPlan, EvidenceManifest, PersistedSemanticSourcePlan, SourceOrderAnchor } from './contracts.js';

/** Select already-authored judgement sources, not names, categories or shared sampling. */
export function createItemSourceAnchorReader(plan: PersistedSemanticSourcePlan, manifest: EvidenceManifest) {
  const evidence = new Map(manifest.evidence.map(record => [record.evidence_id, record]));
  const compact = plan.schema_version === 'semantic-source-plan/v8' ? plan : undefined;
  const expanded = plan.schema_version !== 'semantic-source-plan/v8' ? plan : undefined;
  const spans = new Map(compact?.source_spans.map(span => [span.span_id, span]) ?? []);
  const items = new Map(compact?.acceptance_items.map(item => [item.item_id, item]) ?? []);
  const anchor = (evidenceId: string, start: number): SourceOrderAnchor[] => {
    const record = evidence.get(evidenceId);
    if (!record || (record.registered_dependency && record.evidence_scope !== 'primary')
      || start < 0 || start >= record.text.length) return [];
    const char = /^char:(\d+)-\d+$/.exec(record.locator);
    if (char) return [{ offset: Number(char[1]) + start, row: 0, column: 0 }];
    const line = /^line:(\d+)(?:\/|$)/.exec(record.locator);
    if (!line) return [];
    const prefix = record.text.slice(0, start);
    return [{
      line: Number(line[1]) + (prefix.match(/\n/g)?.length ?? 0),
      row: record.row_index ?? Number(/(?:\/row:|\/table-row:)(\d+)/.exec(record.locator)?.[1] ?? 0),
      column: start - (prefix.lastIndexOf('\n') + 1),
    }];
  };
  return (item: AcceptanceItemPlan): SourceOrderAnchor[] => {
    const authored = items.get(item.item_id);
    if (authored && compact) {
      const table = authored.table_semantics;
      const criterion = (compact.semantic_evidence ?? [])
        .filter(node => node.materialized_item_id === item.item_id
          && (node.role === 'acceptance_item' || node.role === 'table_criterion'))
        .map(node => node.span_id);
      // An inherited header can precede several rows. Value cells locate the
      // actual row; a reference item stays at its LOCAL reference anchor.
      const selected = table?.source_kind === 'reference' ? table.reference_span_ids
        : table ? table.cell_evidence.filter(cell => cell.role === 'allowed_value').map(cell => cell.span_id)
          : criterion.length ? criterion : authored.field_bindings.requirement.source_span_ids;
      return selected.flatMap(id => {
        const span = spans.get(id);
        return span ? anchor(span.evidence_id, span.start) : [];
      });
    }
    const table = item.table_semantics;
    const criterion = (expanded?.semantic_evidence ?? [])
      .filter(node => node.materialized_item_id === item.item_id
        && (node.role === 'acceptance_item' || node.role === 'table_criterion'))
      .map(node => ({ evidence_id: node.evidence_id, text: node.exact_fragment }));
    const selected = table?.source_kind === 'reference' ? table.reference_fragments
      : table ? table.cell_evidence.filter(cell => cell.role === 'allowed_value')
        : criterion.length ? criterion : item.field_bindings.requirement.source_fragments;
    return selected.flatMap(fragment => {
      const text = evidence.get(fragment.evidence_id)?.text ?? '';
      const start = text.indexOf(fragment.text);
      // Legacy repeated text has no exact offset. Keep its record position
      // instead of guessing which repeated occurrence the author intended.
      return anchor(fragment.evidence_id, start >= 0 && text.indexOf(fragment.text, start + 1) < 0 ? start : 0);
    });
  };
}
