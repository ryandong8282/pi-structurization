import { describe, expect, test } from 'vitest';
import { deliveryInvestigationHints, selectorDeliveryInvestigationHints } from '../src/acceptance-delivery-contract.js';
import type { MaterializedAcceptanceItem } from '../src/contracts.js';
import type { EvidenceRecord } from '../src/contracts.js';
import type { SourceSpanRegistry } from '../src/source-span-registry.js';
import type { TargetSelectorPlan } from '../src/target-selector-compiler.js';

const item = (overrides: Partial<MaterializedAcceptanceItem> = {}) => ({
  item_id: 'one', name: '长度', requirement: '长度≤5mm', method: '尺量', source_clause: '4.2.1',
  evidence_ids: ['source'], table_semantics: null, ...overrides,
} as MaterializedAcceptanceItem);

test.each(['fragmented_display', 'different_source', 'equal_union', 'equal_union_different_spans', 'disjoint', 'table_item', 'table_row', 'unresolved_span', 'untouched', 'text_already_contains'] as const)(
  'strict source containment supplements prose comparisons for %s without choosing a business correction', mode => {
    const source = '对象甲：连接应牢固；工况乙时，壳体应完整。';
    const first = '连接应牢固', second = '壳体应完整';
    const evidence = ['source', 'other'].map(evidence_id => ({ evidence_id, text: source, clause_id: '1.1.1',
      kind: mode === 'table_row' ? 'table_row' : 'paragraph', role: 'supporting_clause' })) as EvidenceRecord[];
    const registry = { spans: [
      { span_id: 'whole', evidence_id: 'source', start: 0, end: source.length },
      { span_id: 'first', evidence_id: 'source', start: source.indexOf(first), end: source.indexOf(first) + first.length },
      { span_id: 'second', evidence_id: mode === 'different_source' ? 'other' : 'source', start: source.indexOf(second), end: source.indexOf(second) + second.length },
      { span_id: 'left', evidence_id: 'source', start: 0, end: 8 },
      { span_id: 'right', evidence_id: 'source', start: 8, end: source.length },
    ] } as SourceSpanRegistry;
    const parentIds = mode === 'equal_union' ? ['first', 'second'] : mode === 'disjoint' ? ['first'] : ['whole'];
    const childIds = mode === 'equal_union_different_spans' ? ['left', 'right']
      : mode === 'unresolved_span' ? ['first', 'missing'] : mode === 'disjoint' ? ['second']
      : mode === 'text_already_contains' ? ['first'] : ['first', 'second'];
    const selectors = { items: [['parent', parentIds], ['child', childIds]].map(([key, ids]) => ({
      key, name: key, table: mode === 'table_item' ? {} : null, criterion_span_ids: ['whole'],
      fields: { name: { span_ids: [] }, requirement: { composition: 'verbatim', span_ids: ids, separator: ' / ' },
        method: { span_ids: [], separator: '' } }, sampling: { quantity_span_ids: [], script_span_ids: [] },
    })) } as unknown as TargetSelectorPlan;
    const before = structuredClone({ selectors, registry, evidence });
    const hints = selectorDeliveryInvestigationHints(selectors, registry, evidence, new Set([mode === 'untouched' ? 'unrelated' : 'child']));
    const contains = hints.filter(hint => hint.code === 'sibling_requirement_contains');
    const sourced = contains.filter((hint: any) => hint.actual?.comparison_basis === 'strict_requirement_source_containment');
    expect(sourced).toHaveLength(mode === 'fragmented_display' ? 1 : 0);
    if (mode === 'fragmented_display') {
      expect(sourced[0]).toMatchObject({ item_keys: ['parent', 'child'], next_tool: 'read_target_selectors',
        read_arguments: [{ collection: 'items', key: 'parent' }, { collection: 'items', key: 'child' }],
        writable_collection: 'items', actual: { containing_item_key: 'parent', contained_item_count: 1, contained_items_complete: true } });
      expect(sourced[0]!.instruction).toContain('不认定缺陷');
      expect(JSON.stringify(sourced[0])).not.toContain(source);
    }
    if (mode === 'text_already_contains') expect(contains).toHaveLength(1);
    expect({ selectors, registry, evidence }).toEqual(before);
  },
);

test('source containment comparisons retain a late touched key within a bounded related-key preview', () => {
  const phrases = Array.from({ length: 11 }, (_, index) => [`甲${index}`, `乙${index}`]);
  const source = phrases.map(parts => parts.join('；')).join('。');
  const registry = { spans: [{ span_id: 'whole', evidence_id: 'source', start: 0, end: source.length },
    ...phrases.flatMap((parts, index) => parts.map((text, part) => ({ span_id: `s${index}-${part}`, evidence_id: 'source',
      start: source.indexOf(text), end: source.indexOf(text) + text.length }))),
  ] } as SourceSpanRegistry;
  const rows = [['parent', ['whole']], ...phrases.map((_parts, index) => [`child-${index}`, [`s${index}-0`, `s${index}-1`]])];
  const selectors = { items: rows.map(([key, ids]) => ({ key, name: key, table: null, criterion_span_ids: ['whole'],
    fields: { name: { span_ids: [] }, requirement: { composition: 'verbatim', span_ids: ids, separator: '/' },
      method: { span_ids: [], separator: '' } }, sampling: { quantity_span_ids: [], script_span_ids: [] },
  })) } as unknown as TargetSelectorPlan;
  const evidence = [{ evidence_id: 'source', kind: 'paragraph', text: source, clause_id: '1.1.1' }] as EvidenceRecord[];
  const hint = selectorDeliveryInvestigationHints(selectors, registry, evidence, new Set(['child-10']))
    .find((hint: any) => hint.actual?.comparison_basis === 'strict_requirement_source_containment') as any;
  expect(hint.actual).toMatchObject({ contained_item_count: 11, contained_items_complete: false });
  expect(hint.item_keys).toHaveLength(9);
  expect(hint.item_keys.slice(0, 2)).toEqual(['parent', 'child-10']);
  expect(hint.read_arguments).toHaveLength(9);
});

test.each(['independent', 'different_source', 'table_item', 'table_row', 'untouched'] as const)(
  'source sharing is an advisory allocation signal, with %s boundaries', mode => {
    const source = '内容甲。内容乙。';
    const evidence = ['source', 'other'].map(evidence_id => ({ evidence_id, kind: mode === 'table_row' ? 'table_row' : 'paragraph',
      role: 'supporting_clause', text: source, clause_id: '1.1.1' })) as EvidenceRecord[];
    const registry = { spans: [
      { span_id: 'first', evidence_id: 'source', start: 0, end: 4 },
      { span_id: 'second', evidence_id: mode === 'different_source' ? 'other' : 'source', start: 4, end: 8 },
    ] } as SourceSpanRegistry;
    const selectors = { items: ['first', 'second'].map(key => ({ key, name: key, table: mode === 'table_item' ? {} : null,
      criterion_span_ids: [key], fields: {
        name: { span_ids: [key] }, requirement: { composition: 'verbatim', span_ids: [key], separator: '' },
        method: { span_ids: [], separator: '' },
      }, sampling: { quantity_span_ids: [], script_span_ids: [] },
    })) } as unknown as TargetSelectorPlan;
    const before = structuredClone({ selectors, registry, evidence });
    const hints = selectorDeliveryInvestigationHints(selectors, registry, evidence,
      new Set(mode === 'untouched' ? ['unrelated'] : ['second']));
    expect(hints.filter(hint => hint.code === 'prose_source_split')).toHaveLength(mode === 'independent' ? 1 : 0);
    if (mode === 'independent') expect(hints[0]!.instruction).toContain('不认定缺陷');
    expect({ selectors, registry, evidence }).toEqual(before);
  },
);

test.each(['unassigned_prefix', 'complete_union', 'prefix_only_in_name', 'prefix_only_in_note'] as const)(
  'split source allocation exposes exact unassigned requirement ranges for %s without assigning semantics', mode => {
    const prefix = '工况甲时，';
    const first = '连接件应锁紧；', second = '壳体应完整。';
    const source = prefix + first + second;
    const evidence = [{ evidence_id: 'source', kind: 'paragraph', role: 'supporting_clause', text: source }] as EvidenceRecord[];
    const registry = { spans: [
      { span_id: 'prefix', evidence_id: 'source', start: 0, end: prefix.length },
      { span_id: 'first', evidence_id: 'source', start: prefix.length, end: prefix.length + first.length },
      { span_id: 'second', evidence_id: 'source', start: prefix.length + first.length, end: source.length },
    ] } as SourceSpanRegistry;
    const selectors = { items: ['first', 'second'].map(key => ({ key, name: key, table: null, criterion_span_ids: [key],
      fields: {
        name: { span_ids: mode === 'prefix_only_in_name' ? ['prefix', key] : [key] },
        requirement: { composition: 'verbatim', span_ids: mode === 'complete_union' && key === 'first' ? ['prefix', key] : [key], separator: '' },
        method: { span_ids: [], separator: '' }, note: { span_ids: mode === 'prefix_only_in_note' ? ['prefix'] : [], separator: '' },
      }, sampling: { quantity_span_ids: [], script_span_ids: [] },
    })) } as unknown as TargetSelectorPlan;
    const before = structuredClone({ selectors, registry, evidence });
    const split = selectorDeliveryInvestigationHints(selectors, registry, evidence, new Set(['second']))
      .find(hint => hint.code === 'prose_source_split') as any;
    expect(split).toMatchObject({
      actual: { source_text_length: source.length,
        unassigned_requirement_interval_count: mode === 'complete_union' ? 0 : 1,
        unassigned_requirement_intervals: mode === 'complete_union' ? [] : [{ evidence_id: 'source', start: 0, end: prefix.length }],
        intervals_complete: true },
      save_tool: 'stage_target_selector_draft',
    });
    expect(JSON.stringify(split)).not.toContain(prefix);
    expect(split.instruction).toContain('不认定缺陷');
    expect({ selectors, registry, evidence }).toEqual(before);
  },
);

test.each(['whitespace_edges', 'bounded_many_intervals'] as const)(
  'split source range metadata handles %s without returning source excerpts', mode => {
    const source = mode === 'whitespace_edges' ? ' 内容甲。内容乙。 ' : '字甲'.repeat(10);
    const evidence = [{ evidence_id: 'source', kind: 'paragraph', role: 'supporting_clause', text: source }] as EvidenceRecord[];
    const registry = { spans: mode === 'whitespace_edges'
      ? [{ span_id: 'first', evidence_id: 'source', start: 1, end: 5 }, { span_id: 'second', evidence_id: 'source', start: 5, end: 9 }]
      : Array.from({ length: 10 }, (_, index) => ({ span_id: `span-${index}`, evidence_id: 'source', start: index * 2 + 1, end: index * 2 + 2 })),
    } as SourceSpanRegistry;
    const selectors = { items: ['first', 'second'].map((key, index) => ({ key, name: key, table: null,
      criterion_span_ids: [registry.spans[index]!.span_id], fields: { name: { span_ids: [] },
        requirement: { composition: 'verbatim', separator: '', span_ids: mode === 'whitespace_edges'
          ? [key] : registry.spans.filter((_, spanIndex) => spanIndex % 2 === index).map(span => span.span_id) },
        method: { span_ids: [], separator: '' } }, sampling: { quantity_span_ids: [], script_span_ids: [] },
    })) } as unknown as TargetSelectorPlan;
    const split = selectorDeliveryInvestigationHints(selectors, registry, evidence, new Set(['second']))
      .find(hint => hint.code === 'prose_source_split') as any;
    expect(split.actual.unassigned_requirement_interval_count).toBe(mode === 'whitespace_edges' ? 0 : 10);
    expect(split.actual.unassigned_requirement_intervals).toHaveLength(mode === 'whitespace_edges' ? 0 : 8);
    expect(split.actual.intervals_complete).toBe(mode === 'whitespace_edges');
    expect(JSON.stringify(split)).not.toContain(source.trim());
  },
);

test.each(['adjacent_union', 'redundant_overlap_removed', 'whitespace_trimmed', 'real_interval_removed'] as const)(
  'requirement change hints use exact source coverage for %s without approving or restoring content', mode => {
    const source = '  内容甲。内容乙。  ';
    const evidence = [{ evidence_id: 'source', kind: 'paragraph', role: 'supporting_clause', text: source }] as EvidenceRecord[];
    const registry = { spans: [
      { span_id: 'whole', evidence_id: 'source', start: 0, end: source.length },
      { span_id: 'trim', evidence_id: 'source', start: 2, end: source.length - 2 },
      { span_id: 'left', evidence_id: 'source', start: 0, end: 6 },
      { span_id: 'right', evidence_id: 'source', start: 6, end: source.length },
    ] } as SourceSpanRegistry;
    const previous = { key: 'item', name: '来源核对', table: null, criterion_span_ids: ['whole'],
      fields: { name: { span_ids: ['whole'] }, requirement: { composition: 'verbatim', span_ids: mode === 'redundant_overlap_removed' ? ['whole', 'trim'] : ['whole'], separator: '' },
        method: { span_ids: [], separator: '' } }, sampling: { quantity_span_ids: [], script_span_ids: [] } } as unknown as TargetSelectorPlan['items'][number];
    const current = structuredClone(previous);
    current.fields.requirement.span_ids = mode === 'adjacent_union' ? ['left', 'right']
      : mode === 'redundant_overlap_removed' ? ['whole'] : mode === 'whitespace_trimmed' ? ['trim'] : ['left'];
    const selectors = { items: [current] } as TargetSelectorPlan;
    const before = structuredClone({ selectors, previous, registry, evidence });
    const hints = selectorDeliveryInvestigationHints(selectors, registry, evidence, new Set(['item']), [previous]);
    expect(hints.filter(hint => hint.code === 'requirement_source_removed')).toHaveLength(mode === 'real_interval_removed' ? 1 : 0);
    expect({ selectors, previous, registry, evidence }).toEqual(before);
  },
);

describe('delivery investigation hints', () => {
  test('nominates method-as-requirement without judging or rewriting it', () => {
    const candidate = item({ requirement: '尺量' }); const before = structuredClone(candidate);
    expect(deliveryInvestigationHints(candidate).map(h => h.code)).toEqual(['requirement_method_identical']);
    expect(candidate).toEqual(before);
    expect(deliveryInvestigationHints(item())).toEqual([]);
  });
  test('locates value/method source overlap without leaking referenced text into hints', () => {
    const candidate = item({ table_semantics: { cell_evidence: [
      { role: 'allowed_value', evidence_id: 'remote-row', text: '测机头上升距离和时间' },
      { role: 'inspection_method', evidence_id: 'remote-row', text: '测机头上升距离和时间' },
    ] } as MaterializedAcceptanceItem['table_semantics'] });
    const hints = deliveryInvestigationHints(candidate);
    expect(hints[0]?.code).toBe('table_value_method_source_overlap');
    expect(JSON.stringify(hints)).not.toContain('测机头');
    candidate.table_semantics!.cell_evidence[0]!.text = '设计值';
    expect(deliveryInvestigationHints(candidate)).toEqual([]);
  });
  test('recognizes whole-clause copying across splits but permits complete independent splits', () => {
    const a = item({ requirement: '长度≤5mm，宽度≤3mm' });
    const b = item({ item_id: 'two', name: '宽度', requirement: a.requirement });
    expect(deliveryInvestigationHints(a, [a, b])[0]).toMatchObject({ code: 'sibling_requirement_repeated', item_ids: ['one', 'two'] });
    a.requirement = '长度≤5mm'; b.requirement = '宽度≤3mm';
    expect(deliveryInvestigationHints(a, [b])).toEqual([]);
  });
  test('does not confuse shared methods, unrelated sources or empty values with duplicate judgments', () => {
    expect(deliveryInvestigationHints(item(), [item({ item_id: 'two', name: '宽度', evidence_ids: ['other'] })])).toEqual([]);
    expect(deliveryInvestigationHints(item({ requirement: '', method: '' }))).toEqual([]);
    expect(deliveryInvestigationHints(item(), [item({ item_id: 'two', name: '宽度', requirement: '宽度≤3mm' })])).toEqual([]);
  });
  test('does not nominate independent table rows merely because both use the same design criterion', () => {
    const table = { cell_evidence: [] } as unknown as NonNullable<MaterializedAcceptanceItem['table_semantics']>;
    const a = item({ requirement: '设计要求', table_semantics: table });
    const b = item({ item_id: 'two', name: '宽度', requirement: '设计要求', table_semantics: table });
    expect(deliveryInvestigationHints(a, [b])).toEqual([]);
  });

  test('nominates parent-child containment without deciding whether a residual judgment exists', () => {
    const parent = item({ requirement: '壳体应密闭；接头应锁紧。' });
    const child = item({ item_id: 'child', name: '接头', requirement: '接头应锁紧。' });
    const before = structuredClone([parent, child]);
    expect(deliveryInvestigationHints(parent, [child])).toEqual([expect.objectContaining({
      code: 'sibling_requirement_contains', item_ids: ['one', 'child'],
      instruction: expect.stringContaining('independent residual judgment'),
    })]);
    expect([parent, child]).toEqual(before);
    expect(deliveryInvestigationHints(child, [parent])).toEqual([]);
    expect(deliveryInvestigationHints(parent, [{ ...child, evidence_ids: ['unrelated'] }])).toEqual([]);
    expect(deliveryInvestigationHints(parent, [{ ...child, source_clause: '8.9.1' }])).toEqual([]);
  });

  test('heading hints disclose identifiers only and leave field semantics to review', () => {
    const source = { evidence_id: 'source', kind: 'heading', role: 'context', locator: 'line:2',
      text: '## Verification: pressure hold.', text_sha256: 'hash', requires_disposition: false } as const;
    const hints = deliveryInvestigationHints(item(), [], [source]);
    expect(hints[0]).toMatchObject({ code: 'heading_source_role_unconfirmed', evidence_ids: ['source'] });
    expect(JSON.stringify(hints)).not.toContain('pressure hold');
    expect(deliveryInvestigationHints(item(), [], [{ ...source, role: 'section_heading' }])).toEqual([]);
  });
});

test('missing table units nominate source investigation without filling dimensionless or inherited units', () => {
  const dimensionless = item({table_semantics: {unit: '', allowed_value: '设计值', cell_evidence: []} as any});
  const before = structuredClone(dimensionless);
  expect(deliveryInvestigationHints(dimensionless).map(h => h.code)).toEqual(['table_unit_unresolved']);
  expect(dimensionless).toEqual(before);
  const complete = item({table_semantics: {unit: 'MPa', allowed_value: '7', cell_evidence: []} as any});
  expect(deliveryInvestigationHints(complete)).toEqual([]);
});
