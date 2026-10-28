import { describe, expect, test } from 'vitest';
import type { AcceptanceItemPlan, EvidenceManifest, SemanticSourcePlan, SemanticSourcePlanV8 } from '../src/contracts.js';
import { createItemSourceAnchorReader } from '../src/item-source-order.js';

function fixture(reference = false) {
  const evidence = { evidence: [
    { evidence_id: 'header', text: '共同上级', locator: 'line:2', row_index: 1 },
    { evidence_id: 'row', text: '子项  12', locator: 'line:20/table:T/row:4', row_index: 4 },
    { evidence_id: 'local', text: '本地引用', locator: 'char:100-104' },
    { evidence_id: 'external', text: '远端标准', locator: 'line:1', registered_dependency: true },
  ] } as EvidenceManifest;
  const plan = { schema_version: 'semantic-source-plan/v8', source_spans: [
    { span_id: 'header-span', evidence_id: 'header', start: 0, end: 4 },
    { span_id: 'value-span', evidence_id: 'row', start: 4, end: 6 },
    { span_id: 'local-span', evidence_id: 'local', start: 1, end: 4 },
    { span_id: 'external-span', evidence_id: 'external', start: 0, end: 4 },
  ], semantic_evidence: [], acceptance_items: [{
    item_id: 'item', table_semantics: {
      source_kind: reference ? 'reference' : 'direct',
      cell_evidence: [{ role: 'row_header', span_id: 'header-span' }, { role: 'allowed_value', span_id: 'value-span' }],
      reference_span_ids: ['local-span'],
    },
  }] } as unknown as SemanticSourcePlanV8;
  return { evidence, plan, item: { item_id: 'item' } as AcceptanceItemPlan };
}

describe('mechanical source anchors', () => {
  test('uses the actual value row, not its inherited header or shared quantity', () => {
    const f = fixture();
    expect(createItemSourceAnchorReader(f.plan, f.evidence)(f.item)).toEqual([{ line: 20, row: 4, column: 4 }]);
    // Source extension may register a primary row; registration alone does not
    // make that local row an external-document coordinate.
    f.evidence.evidence[1]!.registered_dependency = true;
    f.evidence.evidence[1]!.evidence_scope = 'primary';
    expect(createItemSourceAnchorReader(f.plan, f.evidence)(f.item)).toEqual([{ line: 20, row: 4, column: 4 }]);
  });
  test('keeps referenced criteria at the local citation and excludes external coordinates', () => {
    const f = fixture(true);
    f.plan.acceptance_items[0]!.table_semantics!.reference_span_ids.push('external-span');
    expect(createItemSourceAnchorReader(f.plan, f.evidence)(f.item)).toEqual([{ offset: 101, row: 0, column: 0 }]);
  });
  test('uses precise compact spans for repeated text without searching for the first occurrence', () => {
    const f = fixture();
    f.evidence.evidence[1]!.text = '12\n12';
    f.plan.source_spans[1]!.start = 3;
    expect(createItemSourceAnchorReader(f.plan, f.evidence)(f.item)).toEqual([{ line: 21, row: 4, column: 0 }]);
  });
  test('uses the hydrated item judgement instead of an inherited requirement and does not guess repeated offsets', () => {
    const f = fixture();
    const plan = { schema_version: 'semantic-source-plan/v7', semantic_evidence: [{
      materialized_item_id: 'item', role: 'acceptance_item', evidence_id: 'row', exact_fragment: '12',
    }] } as unknown as SemanticSourcePlan;
    const item = { item_id: 'item', field_bindings: { requirement: {
      source_fragments: [{ evidence_id: 'header', text: '共同上级' }, { evidence_id: 'row', text: '12' }],
    } } } as AcceptanceItemPlan;
    expect(createItemSourceAnchorReader(plan, f.evidence)(item)).toEqual([{ line: 20, row: 4, column: 4 }]);
    f.evidence.evidence[1]!.text = '12\n12';
    expect(createItemSourceAnchorReader(plan, f.evidence)(item)).toEqual([{ line: 20, row: 4, column: 0 }]);
  });
});
