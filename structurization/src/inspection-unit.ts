import type { EditorHierarchyPlan, EditorHierarchyIssue, EditorHierarchyEvidence } from './editor-hierarchy.js';

type Fragment = { atom_id: string; text: string };

/** Product organization over immutable extraction lots, not a rewrite of sealed facts. */
export interface EditorInspectionUnit {
  unit_id: string;
  name: string;
  lot_keys: string[];
  /** Explicit destination; required for item selections, otherwise legacy lot binding applies. */
  parent_node_id?: string;
  /** Exact sealed membership. Omission means all items in each member lot. */
  item_selections?: Array<{ lot_key: string; item_ids: string[] }>;
  source_title_fragments: Fragment[];
  evidence_fragments: Fragment[];
  reason: string;
}

/** Missing mapping means the historical one-node-per-lot contract, never name-based merging. */
export function editorInspectionUnits(plan: EditorHierarchyPlan): EditorInspectionUnit[] {
  return plan.inspection_units ?? plan.lot_bindings.map(binding => ({
    unit_id: binding.lot_key,
    name: binding.display_name ?? '',
    lot_keys: [binding.lot_key],
    source_title_fragments: binding.source_title_fragments ?? [],
    evidence_fragments: binding.evidence_fragments,
    reason: binding.reason,
  }));
}

export function validateInspectionUnits(
  value: unknown,
  evidence: EditorHierarchyEvidence,
  bindings: unknown[],
  openedAtoms: Set<string>,
  nodes: unknown[] = [],
): EditorHierarchyIssue[] {
  const issues: EditorHierarchyIssue[] = [];
  const add = (code: string, path: string, actual: unknown, how: string) => issues.push({
    code, path, message: how,
    details: {
      actual, writable_path: path, writable_collection: 'inspection_units',
      how_to_pass: how, save_tool: 'edit_hierarchy_records', validate_tool: 'validate_hierarchy_plan',
      candidate_read_tools: ['list_sealed_lots', 'open_sealed_lot', 'search_document', 'open_document_atom'],
      do_not_edit: '封存 target/lot/item、验收判据、category、抽样和原文；仅修订组织映射及必要的 lot_bindings 父分项。',
    },
  });
  if (!Array.isArray(value)) {
    add('inspection_units_type', '/inspection_units', value, 'inspection_units 必须为数组；按 get_hierarchy_contract 填写完整 lot 或精确 item_selections，封存项目须恰好覆盖一次。');
    return issues;
  }
  const knownLots = new Set(evidence.lots.map(lot => lot.lot_key));
  const atomById = new Map(evidence.document.atoms.map(atom => [atom.atom_id, atom]));
  const parentByLot = new Map(bindings.filter(isRecord).map(b => [b.lot_key, b.parent_node_id]));
  const assigned = new Set<string>();
  const wholeLots = new Set<string>();
  const itemAssignments = new Map<string, Set<string>>();
  const lotByKey = new Map(evidence.lots.map(lot => [lot.lot_key, lot]));
  const divisions = new Set(nodes.filter(isRecord).filter(node => node.node_type === '分项').map(node => node.node_id));
  const ids = new Set<string>();
  const fragments = (raw: unknown, path: string, allowEmpty: boolean) => {
    if (!Array.isArray(raw) || (!allowEmpty && !raw.length)) {
      add('inspection_unit_sources', path, raw, allowEmpty ? '标题来源须为数组；无适用标题用 []，并在 reason 解释归纳名称。' : '提供至少一条已打开的精确原文 {atom_id,text}，支持验收单元范围及拆并判断；可直接复用成员 lot_bindings.evidence_fragments 里已验证的片段。');
      return;
    }
    raw.forEach((f, index) => {
      if (!isRecord(f) || typeof f.atom_id !== 'string' || typeof f.text !== 'string' || !f.text.trim()
        || !atomById.get(f.atom_id)?.text.includes(f.text) || !openedAtoms.has(f.atom_id)) {
        add('inspection_unit_source_invalid', `${path}/${index}`, f, '先 open_document_atom 阅读来源，再填该原子的真实 atom_id 和非空逐字 text（必须能在该 atom 中逐字找到；自己拼的标题行不算）；最短路径是复用本单元成员 lot_bindings.evidence_fragments 里已验证的 {atom_id,text} 或其子集。不可把归纳名当作原标题。');
      }
    });
  };
  value.forEach((unit, index) => {
    const path = `/inspection_units/${index}`;
    if (!isRecord(unit)) { add('inspection_unit_type', path, unit, '单元必须为对象，按 get_hierarchy_contract.inspection_unit_template 填写。'); return; }
    const extra = Object.keys(unit).filter(key => !['unit_id', 'name', 'lot_keys', 'parent_node_id', 'item_selections', 'source_title_fragments', 'evidence_fragments', 'reason'].includes(key));
    if (extra.length) add('inspection_unit_fields', path, extra, '按 get_hierarchy_contract 填写单元字段；显式 parent_node_id 指向现有分项，item_selections 只引用封存项目身份。');
    const partial = Object.hasOwn(unit, 'item_selections');
    const explicitParent = Object.hasOwn(unit, 'parent_node_id');
    if ((partial || explicitParent) && (typeof unit.parent_node_id !== 'string' || !divisions.has(unit.parent_node_id))) {
      add('inspection_unit_parent', `${path}/parent_node_id`, unit.parent_node_id, 'item_selections 必须同时填写 parent_node_id，指向 nodes 中现有的分项；按已读原文选归属，不改封存来源。');
    }
    if (typeof unit.unit_id !== 'string' || !unit.unit_id.trim() || unit.unit_id !== unit.unit_id.trim() || ids.has(unit.unit_id)) {
      add('inspection_unit_id', `${path}/unit_id`, unit.unit_id, '填写非空、无首尾空白且在 inspection_units 内唯一的 unit_id；不同单元即使同名也使用不同 ID。');
    } else ids.add(unit.unit_id);
    for (const field of ['name', 'reason']) if (typeof unit[field] !== 'string' || !unit[field].trim()) {
      add('inspection_unit_text', `${path}/${field}`, unit[field], `填写非空 ${field}；先判定组织范围，再确定名称和来源理由。`);
    }
    if (!Array.isArray(unit.lot_keys) || !unit.lot_keys.length) {
      add('inspection_unit_members', `${path}/lot_keys`, unit.lot_keys, 'lot_keys 至少包含一个 list_sealed_lots 返回的精确 lot_key；不创建空业务单元。');
    } else {
      const parents = new Set<unknown>();
      const memberKeys = new Set<string>();
      for (const key of unit.lot_keys) {
        if (typeof key !== 'string' || !knownLots.has(key) || memberKeys.has(key)
          || (!partial && assigned.has(key)) || (partial && wholeLots.has(key))) {
          add('inspection_unit_members', `${path}/lot_keys`, key, 'lot_keys 使用已封存身份且在本单元内不重复。完整 lot 不可重复挂载；共享 lot 时，各单元用互不重叠的 item_selections，全部项目恰好覆盖一次。');
        } else {
          assigned.add(key); memberKeys.add(key); parents.add(parentByLot.get(key));
          if (!partial) wholeLots.add(key);
        }
      }
      if (!explicitParent && parents.size > 1) add('inspection_unit_parent_conflict', `${path}/lot_keys`, unit.lot_keys, '未显式填写 parent_node_id 时，各成员 lot_bindings 必须指向同一父分项；按原文修正映射或显式声明单元父分项。');
      if (partial) {
        const selections = unit.item_selections;
        if (!Array.isArray(selections) || !selections.length) {
          add('inspection_unit_item_selections', `${path}/item_selections`, selections, '每个 lot_keys 成员填写一条 {lot_key,item_ids}；item_ids 为 open_sealed_lot 返回的非空精确封存项目 ID。');
        } else {
          const selectedLots = new Set<string>();
          selections.forEach((selection, selectionIndex) => {
            const selectionPath = `${path}/item_selections/${selectionIndex}`;
            if (!isRecord(selection) || typeof selection.lot_key !== 'string' || !memberKeys.has(selection.lot_key)
              || selectedLots.has(selection.lot_key) || Object.keys(selection).some(key => !['lot_key', 'item_ids'].includes(key))) {
              add('inspection_unit_item_selections', selectionPath, selection, '每条仅含 lot_key、item_ids；lot_key 必须属于本单元 lot_keys 且恰有一条选择记录。'); return;
            }
            selectedLots.add(selection.lot_key);
            const catalogue = lotByKey.get(selection.lot_key)?.items;
            if (!catalogue?.length || catalogue.some(item => !item.item_id) || new Set(catalogue.map(item => item.item_id)).size !== catalogue.length) {
              add('inspection_unit_item_catalogue', selectionPath, selection.lot_key, '当前来源没有完整且唯一的 item_id 目录，不能部分挂载；保留完整 lot，或由 harness 从封存结果重建项目目录。'); return;
            }
            const knownItems = new Set(catalogue.map(item => item.item_id));
            const allocated = itemAssignments.get(selection.lot_key) ?? new Set<string>();
            itemAssignments.set(selection.lot_key, allocated);
            if (!Array.isArray(selection.item_ids) || !selection.item_ids.length) {
              add('inspection_unit_item_members', `${selectionPath}/item_ids`, selection.item_ids, '至少选择一个该 lot 内的封存 item_id；不建立空单元或按名称猜身份。'); return;
            }
            for (const id of selection.item_ids) {
              if (typeof id !== 'string' || !knownItems.has(id) || allocated.has(id)) {
                add('inspection_unit_item_members', `${selectionPath}/item_ids`, id, 'item_id 必须属于所选 lot 且在全部单元中恰好出现一次；从 open_sealed_lot 取得实际身份，删除重复挂载。');
              } else allocated.add(id);
            }
          });
          const missingSelections = [...memberKeys].filter(key => !selectedLots.has(key));
          if (missingSelections.length) add('inspection_unit_item_selections', `${path}/item_selections`, missingSelections, '为这些 lot_keys 成员补齐项目选择；使用 item_selections 后不能暗含完整 lot。');
        }
      }
    }
    fragments(unit.source_title_fragments, `${path}/source_title_fragments`, true);
    fragments(unit.evidence_fragments, `${path}/evidence_fragments`, false);
  });
  const missing = [...knownLots].filter(key => !assigned.has(key));
  if (missing.length) add('inspection_unit_coverage', '/inspection_units', missing, '这些已封存 lot_key 尚未分配；用 edit_hierarchy_records 以 collection=inspection_units、op=upsert、稳定 unit_id 逐单元保存（lot_keys 必须取 list_sealed_lots 的精确 lot_key），或按原文加入适用单元；不能仅改批名或跳过组织映射。');
  for (const lot of evidence.lots) {
    if (!assigned.has(lot.lot_key) || wholeLots.has(lot.lot_key)) continue;
    const missingItems = lot.items?.filter(item => !itemAssignments.get(lot.lot_key)?.has(item.item_id)).map(item => item.item_id) ?? [];
    if (missingItems.length) add('inspection_unit_item_coverage', '/inspection_units', { lot_key: lot.lot_key, item_ids: missingItems }, '这些封存项目没有归属；按原文补入适用单元 item_selections，所有项目须恰好覆盖一次，不删除原项目。');
  }
  return issues;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
