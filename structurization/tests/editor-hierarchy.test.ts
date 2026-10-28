import { describe, expect, it } from 'vitest'

import {
  compareEditorHierarchyPlans,
  initialEditorHierarchyPlan,
  validateEditorHierarchyPlan,
  type EditorHierarchyEvidence,
} from '../src/editor-hierarchy.js'

const evidence: EditorHierarchyEvidence = {
  schema_version: 'editor-hierarchy-evidence/v1',
  job_id: 'blind-job',
  business_result_sha256: 'current-result-sha',
  document: {
    schema_version: 'document-evidence/v1',
    source: { file_name: 'current.md', sha256: 'source-sha', char_count: 8, atom_chars: 6000 },
    atoms: [{ atom_id: 'atom-current', start_offset: 0, end_offset: 8, start_line: 1, end_line: 1, text: '当前文档领域语义', text_sha256: 'atom-sha' }],
    evidence_fingerprint: 'document-fingerprint',
  },
  lots: [
    { lot_key: 'T-A::L-1', target_id: 'T-A', target_name: '仅供调查的目标摘要', target_description: '', target_evidence_fragments: [], lot_id: 'L-1', lot_name: '批一', item_names: ['项目一'] },
    { lot_key: 'T-A::L-2', target_id: 'T-A', target_name: '仅供调查的目标摘要', target_description: '', target_evidence_fragments: [], lot_id: 'L-2', lot_name: '批二', item_names: ['项目二'] },
  ],
  evidence_fingerprint: 'current-evidence-fingerprint',
}

const fragment = [{ atom_id: 'atom-current', text: '领域语义' }]

function validPlan() {
  return {
    ...initialEditorHierarchyPlan(evidence),
    semantic_constraints: [
      {
        constraint_id: 'root-scope',
        kind: 'scope_assignment' as const,
        parent_node_id: 'root',
        node_type: '子分部' as const,
        node_ids: ['group'],
        expected_count: null,
        exhaustive: false,
        evidence_fragments: fragment,
        interpretation: '当前领域构成一个子分部范围',
      },
      {
        constraint_id: 'division-count',
        kind: 'child_count' as const,
        parent_node_id: 'group',
        node_type: '分项' as const,
        node_ids: ['division-a', 'division-b'],
        expected_count: 2,
        exhaustive: true,
        evidence_fragments: fragment,
        interpretation: '原文明确该范围包含两个分项',
      },
    ],
    atom_dispositions: [
      { atom_id: 'atom-current', disposition: 'hierarchy_authority' as const, constraint_ids: ['root-scope', 'division-count'], reason: '包含层级范围与数量声明' },
    ],
    nodes: [
      { node_id: 'group', parent_node_id: 'root', node_type: '子分部' as const, name: '语义组', constraint_ids: ['root-scope'], evidence_fragments: fragment, reason: '完整文档语义' },
      { node_id: 'division-a', parent_node_id: 'group', node_type: '分项' as const, name: '分项甲', constraint_ids: ['division-count'], evidence_fragments: fragment, reason: '验收对象甲' },
      { node_id: 'division-b', parent_node_id: 'group', node_type: '分项' as const, name: '分项乙', constraint_ids: ['division-count'], evidence_fragments: fragment, reason: '验收对象乙' },
    ],
    lot_bindings: [
      { lot_key: 'T-A::L-1', parent_node_id: 'division-a', display_name: '批一', constraint_ids: ['division-count'], evidence_fragments: fragment, reason: '该批属于甲' },
      { lot_key: 'T-A::L-2', parent_node_id: 'division-b', display_name: '批二', constraint_ids: ['division-count'], evidence_fragments: fragment, reason: '同一 target 的另一批属于乙' },
    ],
  }
}

describe('editor hierarchy process contract', () => {
  it('partitions a mixed source lot by exact item identities without changing sealed facts', () => {
    const source = structuredClone(evidence);
    source.lots[0]!.items = [{ item_id: 'item:alpha', name: '对象甲', source_clause: '1.1' }, { item_id: 'item:beta', name: '对象乙', source_clause: '1.2' }];
    const before = JSON.stringify(source);
    const base = validPlan();
    const whole = { unit_id: 'other', name: '批二', lot_keys: ['T-A::L-2'], source_title_fragments: [], evidence_fragments: fragment, reason: '独立来源范围' };
    const part = (id: string, parent: string) => ({ ...whole, unit_id: id, name: id, lot_keys: ['T-A::L-1'], parent_node_id: parent,
      item_selections: [{ lot_key: 'T-A::L-1', item_ids: [id] }] });
    const plan = { ...base, inspection_units: [part('item:alpha', 'division-a'), part('item:beta', 'division-b'), whole] };
    const checkParts = (input: unknown) => validateEditorHierarchyPlan(input, source, new Set(['atom-current']), new Set(source.lots.map(lot => lot.lot_key)));
    expect(checkParts(plan).ok).toBe(true);
    expect(JSON.stringify(source)).toBe(before);
    const renamed = structuredClone(plan);
    renamed.inspection_units.reverse();
    renamed.inspection_units.forEach(u => { u.unit_id += ':new'; });
    expect(compareEditorHierarchyPlans(plan, renamed, 'review').differences).toEqual([]);
    const moved = structuredClone(plan);
    moved.inspection_units[1]!.parent_node_id = 'division-a';
    expect(compareEditorHierarchyPlans(plan, moved, 'review').differences.some(d => d.kind === 'inspection_unit_mismatch')).toBe(true);
    const rejected = (units: unknown[], code: string) => expect(checkParts({ ...base, inspection_units: units }).issues.some(issue => issue.code === code)).toBe(true);
    rejected([part('item:alpha', 'division-a'), whole], 'inspection_unit_item_coverage');
    rejected([part('item:alpha', 'division-a'), part('item:alpha', 'division-b'), whole], 'inspection_unit_item_members');
    rejected([part('item:unknown', 'division-a'), part('item:beta', 'division-b'), whole], 'inspection_unit_item_members');
    rejected([{ ...part('item:alpha', 'division-a'), parent_node_id: undefined }, part('item:beta', 'division-b'), whole], 'inspection_unit_parent');
    rejected([{ ...part('item:alpha', 'division-a'), item_selections: [] }, part('item:beta', 'division-b'), whole], 'inspection_unit_item_selections');
    rejected([{ ...whole, unit_id: 'whole', lot_keys: ['T-A::L-1'] }, part('item:beta', 'division-b'), whole], 'inspection_unit_members');
    const noCatalogue = structuredClone(source); delete noCatalogue.lots[0]!.items;
    expect(validateEditorHierarchyPlan(plan, noCatalogue, new Set(['atom-current']), new Set(source.lots.map(lot => lot.lot_key))).issues.some(i => i.code === 'inspection_unit_item_catalogue')).toBe(true);
  });
  const check = (plan: unknown) => validateEditorHierarchyPlan(plan, evidence, new Set(['atom-current']), new Set(evidence.lots.map(lot => lot.lot_key)))
  const unit = (lotKeys = ['T-A::L-1', 'T-A::L-2']) => ({ unit_id: 'business-unit', name: '共同验收单元', lot_keys: lotKeys, source_title_fragments: fragment, evidence_fragments: fragment, reason: '原文共同组织范围，局部分片不是独立分批依据' })

  it('organizes sealed lots explicitly without rewriting their identity or automatically merging names', () => {
    const plan = validPlan()
    plan.lot_bindings[1]!.parent_node_id = 'division-a'
    const grouped = { ...plan, inspection_units: [unit()] }
    const before = JSON.stringify(evidence)
    expect(check(grouped).ok).toBe(true)
    expect(JSON.stringify(evidence)).toBe(before)
    const separate = { ...plan, inspection_units: [unit(['T-A::L-1']), { ...unit(['T-A::L-2']), unit_id: 'independent' }] }
    expect(check(separate).ok).toBe(true)
    const comparison = compareEditorHierarchyPlans(grouped, separate, 'review-fingerprint')
    expect(comparison.differences.some(d => d.kind === 'inspection_unit_mismatch')).toBe(true)
    const renamedIds = { ...grouped, inspection_units: [{ ...unit(), unit_id: 'other-id', lot_keys: ['T-A::L-2', 'T-A::L-1'] }] }
    expect(compareEditorHierarchyPlans(grouped, renamedIds, 'review-fingerprint').differences).toEqual([])
  })

  it.each([
    [[], 'inspection_unit_coverage'],
    [[unit(['T-A::L-1'])], 'inspection_unit_coverage'],
    [[unit(['T-A::L-1', 'T-A::L-1', 'T-A::L-2'])], 'inspection_unit_members'],
    [[unit(['unknown'])], 'inspection_unit_members'],
    [[{ ...unit(), name: '' }], 'inspection_unit_text'],
    [[{ ...unit(), reason: '' }], 'inspection_unit_text'],
    [[{ ...unit(), evidence_fragments: [] }], 'inspection_unit_sources'],
    [[{ ...unit(), source_title_fragments: [{ atom_id: 'atom-current', text: '编造标题' }] }], 'inspection_unit_source_invalid'],
    [null, 'inspection_units_type'],
  ])('rejects incomplete or unauditable organization with writable repair guidance (%j)', (units, code) => {
    const plan = validPlan()
    plan.lot_bindings[1]!.parent_node_id = 'division-a'
    const result = check({ ...plan, inspection_units: units })
    expect(result.ok).toBe(false)
    expect(result.issues).toContainEqual(expect.objectContaining({ code, details: expect.objectContaining({
      writable_collection: 'inspection_units', save_tool: 'edit_hierarchy_records', validate_tool: 'validate_hierarchy_plan', how_to_pass: expect.any(String), do_not_edit: expect.any(String),
    }) }))
  })

  it('constraint citation receipts hand the author the valid id set, not just the unknown ids (GB 50210 实测回归)', () => {
    const plan = validPlan()
    plan.nodes[0]!.constraint_ids = ['constraint:group:71453671e909:divisions']
    const orphaned = check(plan)
    const unknown = orphaned.issues.find(i => i.code === 'unknown_node_constraints')
    expect(unknown?.valid_constraint_ids).toEqual(['division-count', 'root-scope'])
    expect(unknown?.how_to_pass).toContain('semantic_constraints')
    const uncovered = orphaned.issues.find(i => i.code === 'node_not_covered_by_constraint')
    expect(uncovered?.details).toMatchObject({ cited: ['constraint:group:71453671e909:divisions'], covering_constraint_ids: ['root-scope'] })
    expect(uncovered?.how_to_pass).toContain('covering_constraint_ids')

    const restored = validPlan()
    restored.lot_bindings[0]!.constraint_ids = ['constraint:group:71453671e909:divisions']
    const binding = check(restored).issues.find(i => i.code === 'binding_parent_not_covered')
    expect(binding?.details).toMatchObject({ parent_node_id: 'division-a', covering_constraint_ids: ['division-count'] })
    expect(binding?.valid_constraint_ids).toEqual(['division-count', 'root-scope'])
  })

  it('requires a common parent and independently read sources, not merely a common name', () => {
    const plan = { ...validPlan(), inspection_units: [unit()] }
    expect(check(plan).issues.some(i => i.code === 'inspection_unit_parent_conflict')).toBe(true)
    plan.lot_bindings[1]!.parent_node_id = 'division-a'
    expect(validateEditorHierarchyPlan(plan, evidence, new Set(), new Set(evidence.lots.map(lot => lot.lot_key))).issues.some(i => i.code === 'inspection_unit_source_invalid')).toBe(true)
    plan.inspection_units[0]!.source_title_fragments = []
    expect(check(plan).ok).toBe(true) // Missing title may be explained semantically, never fabricated.
    expect(check(validPlan()).ok).toBe(true) // Legacy receipts retain their original identity/hash.
  })

  it('keeps exact original titles independent from inferred and cross-section display names', () => {
    const plan = validPlan()
    Object.assign(plan.lot_bindings[0]!, { display_name: '跨节归纳的验收范围', source_title_fragments: [
      { atom_id: 'atom-current', text: '当前文档' },
      { atom_id: 'atom-current', text: '领域语义' },
    ] })
    Object.assign(plan.lot_bindings[1]!, { source_title_fragments: [] })
    const validation = validateEditorHierarchyPlan(plan, evidence, new Set(['atom-current']), new Set(['T-A::L-1', 'T-A::L-2']))
    expect(validation.ok).toBe(true)
    expect(validation.plan?.lot_bindings[0]?.source_title_fragments).toEqual([
      { atom_id: 'atom-current', text: '当前文档' },
      { atom_id: 'atom-current', text: '领域语义' },
    ])
    expect(validation.plan?.lot_bindings[0]?.display_name).toBe('跨节归纳的验收范围')
  })

  it.each([
    [null, 'missing_evidence_fragments'],
    [[{ atom_id: 'atom-current', text: '模型扩写的名称' }], 'non_exact_evidence_fragment'],
    [[{ atom_id: 'invented', text: '领域语义' }], 'unknown_evidence_atom'],
    [[{ atom_id: 'atom-current', text: '' }], 'invalid_evidence_fragment'],
  ])('rejects invalid title provenance with an executable author repair route (%j)', (sourceTitles, code) => {
    const plan = validPlan()
    Object.assign(plan.lot_bindings[0]!, { source_title_fragments: sourceTitles })
    const validation = validateEditorHierarchyPlan(plan, evidence, new Set(['atom-current']), new Set(['T-A::L-1', 'T-A::L-2']))
    expect(validation.ok).toBe(false)
    expect(validation.issues).toContainEqual(expect.objectContaining({ code, details: expect.objectContaining({
      actual: sourceTitles,
      writable_path: '/lot_bindings/0/source_title_fragments',
      candidate_read_tools: ['list_document_atoms', 'open_document_atom'],
      save_tool: 'edit_hierarchy_records',
      how_to_pass: expect.stringContaining('保留 display_name、lot_key、父级'),
    }) }))
    Object.assign(plan.lot_bindings[0]!, { source_title_fragments: fragment })
    expect(validateEditorHierarchyPlan(plan, evidence, new Set(['atom-current']), new Set(['T-A::L-1', 'T-A::L-2'])).ok).toBe(true)
  })

  it('requires a separate read receipt even for an exact original title', () => {
    const plan = validPlan()
    Object.assign(plan.lot_bindings[0]!, { source_title_fragments: fragment })
    const validation = validateEditorHierarchyPlan(plan, evidence, new Set(), new Set(['T-A::L-1', 'T-A::L-2']))
    expect(validation.issues).toContainEqual(expect.objectContaining({
      code: 'unopened_evidence_atom', path: '/lot_bindings/0/source_title_fragments/0',
      details: expect.objectContaining({ save_tool: 'edit_hierarchy_records' }),
    }))
  })

  it('accepts explicit semantic decisions after complete current-document and lot investigation', () => {
    const validation = validateEditorHierarchyPlan(
      validPlan(),
      evidence,
      new Set(['atom-current']),
      new Set(['T-A::L-1', 'T-A::L-2']),
    )
    expect(validation.ok).toBe(true)
    expect(validation.fingerprint).toMatch(/^[a-f0-9]{64}$/)
  })

  it('blocks sealing when either author or reviewer has not independently opened all current evidence', () => {
    const validation = validateEditorHierarchyPlan(validPlan(), evidence, new Set(), new Set(['T-A::L-1']))
    expect(validation.ok).toBe(false)
    expect(validation.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      'unopened_evidence_atom',
      'unopened_lot',
      'incomplete_document_investigation',
      'incomplete_lot_investigation',
    ]))
  })

  it('rejects stale fingerprints independently of semantic content', () => {
    const plan = validPlan()
    plan.business_result_sha256 = 'old-result-sha'
    const validation = validateEditorHierarchyPlan(
      plan,
      evidence,
      new Set(['atom-current']),
      new Set(['T-A::L-1', 'T-A::L-2']),
    )
    expect(validation.ok).toBe(false)
    expect(validation.issues.map((issue) => issue.code)).toContain('result_identity')
  })

  it('rejects an explicitly provided empty contextual lot display name', () => {
    const plan = validPlan()
    plan.lot_bindings[0]!.display_name = ' '
    const validation = validateEditorHierarchyPlan(
      plan,
      evidence,
      new Set(['atom-current']),
      new Set(['T-A::L-1', 'T-A::L-2']),
    )
    expect(validation.ok).toBe(false)
    expect(validation.issues.map((issue) => issue.code)).toContain('binding_display_name')
  })

  it('rejects inferred missing coverage, duplicate bindings, and graph cycles', () => {
    const plan = validPlan()
    plan.nodes[0]!.parent_node_id = 'group'
    plan.lot_bindings.push({ ...plan.lot_bindings[0]! })
    plan.lot_bindings.splice(1, 1)
    const validation = validateEditorHierarchyPlan(
      plan,
      evidence,
      new Set(['atom-current']),
      new Set(['T-A::L-1', 'T-A::L-2']),
    )
    expect(validation.ok).toBe(false)
    expect(validation.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      'hierarchy_cycle',
      'duplicate_lot_binding',
      'missing_lot_bindings',
    ]))
  })

  it('rejects a tree that contradicts its own evidence-bound child count', () => {
    const plan = validPlan()
    plan.semantic_constraints[1]!.expected_count = 10
    const validation = validateEditorHierarchyPlan(
      plan,
      evidence,
      new Set(['atom-current']),
      new Set(['T-A::L-1', 'T-A::L-2']),
    )
    expect(validation.ok).toBe(false)
    expect(validation.issues.map((issue) => issue.code)).toContain('child_count_conflict')
  })

  it('requires the fixed editor ontology 分部 -> 子分部 -> 分项', () => {
    const plan = validPlan()
    plan.nodes = plan.nodes.filter((node) => node.node_id !== 'group')
    for (const node of plan.nodes) node.parent_node_id = 'root'
    plan.semantic_constraints[0]!.node_ids = []
    plan.semantic_constraints[1]!.parent_node_id = 'root'
    plan.lot_bindings[0]!.parent_node_id = 'division-a'
    plan.lot_bindings[1]!.parent_node_id = 'division-b'
    const validation = validateEditorHierarchyPlan(
      plan,
      evidence,
      new Set(['atom-current']),
      new Set(['T-A::L-1', 'T-A::L-2']),
    )
    expect(validation.ok).toBe(false)
    expect(validation.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      'missing_root_subdivision',
      'invalid_division_parent',
    ]))
  })

  it('does not let an explicit enumeration count collapse distinct named members', () => {
    const plan = validPlan()
    plan.semantic_constraints.push({
      constraint_id: 'explicit-members',
      kind: 'child_enumeration' as const,
      parent_node_id: 'group',
      node_type: '分项' as const,
      node_ids: ['division-a'],
      expected_count: 2,
      exhaustive: false,
      evidence_fragments: fragment,
      interpretation: '原文逐项命名两个成员',
    })
    plan.atom_dispositions[0]!.constraint_ids.push('explicit-members')
    const validation = validateEditorHierarchyPlan(
      plan,
      evidence,
      new Set(['atom-current']),
      new Set(['T-A::L-1', 'T-A::L-2']),
    )
    expect(validation.ok).toBe(false)
    expect(validation.issues.map((issue) => issue.code)).toContain('child_enumeration_count_conflict')
  })

  it('requires every document atom to be semantically disposed, not merely opened', () => {
    const plan = validPlan()
    plan.atom_dispositions = []
    const validation = validateEditorHierarchyPlan(
      plan,
      evidence,
      new Set(['atom-current']),
      new Set(['T-A::L-1', 'T-A::L-2']),
    )
    expect(validation.ok).toBe(false)
    expect(validation.issues.map((issue) => issue.code)).toContain('missing_atom_dispositions')
  })

  it('compares independently reconstructed semantic paths instead of stable IDs', () => {
    const candidate = validPlan()
    const reviewer = structuredClone(candidate)
    reviewer.nodes.find((node) => node.node_id === 'division-b')!.name = '独立审阅后的分项乙'
    reviewer.lot_bindings.find((binding) => binding.lot_key === 'T-A::L-2')!.parent_node_id = 'division-a'
    reviewer.lot_bindings.find((binding) => binding.lot_key === 'T-A::L-1')!.display_name = '独立审阅后的批一'
    const comparison = compareEditorHierarchyPlans(candidate, reviewer, 'review-fingerprint')
    expect(comparison.differences.map((difference) => difference.kind)).toEqual(expect.arrayContaining([
      'candidate_only_node',
      'reviewer_only_node',
      'lot_parent_mismatch',
      'lot_display_name_mismatch',
    ]))
    expect(new Set(comparison.differences.map((difference) => difference.difference_id)).size).toBe(comparison.differences.length)
  })
})
