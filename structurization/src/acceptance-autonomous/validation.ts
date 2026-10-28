import { sha256Json } from '../canonical.js';
import { normalizeStandardNo } from '../external-source-workflow.js';
import type { AcceptanceDelivery, AcceptanceGroup, AcceptanceIssue, BoundText, SourceLedger, SourceQuote } from './contracts.js';
import { parseAcceptanceDelivery } from './schema.js';
import { referenceSourceField, sourceTextForDisplay, verifySourceQuote } from './source-ledger.js';

export interface ValidationContext {
  sources: SourceLedger[];
  root_source_id: string;
  /** Only controller-resolved sources are eligible for an expanded reference. */
  resolved_references: Record<string, { key: string; source_id?: string; literal_only: boolean }>;
}

export function referenceScenarioKey(reference: AcceptanceDelivery['references'][number]): string {
  return sha256Json({ standard: normalizeStandardNo(reference.standard_no), version: reference.version,
    clause: reference.clause, object: reference.object, purpose: reference.purpose, conditions: reference.conditions,
    origin: reference.origin });
}

/** Deterministic checks are prerequisites for, not substitutes for, semantic group review. */
export function validateAcceptanceDelivery(value: unknown, context: ValidationContext): {
  delivery?: AcceptanceDelivery; issues: AcceptanceIssue[];
} {
  const parsed = parseAcceptanceDelivery(value);
  if (!parsed.delivery) return parsed;
  const delivery = parsed.delivery;
  const issues: AcceptanceIssue[] = [];
  const issue = (code: string, path: string, actual: unknown, message: string, affected: string[] = []) =>
    issues.push({ code, path, actual, message: `${message}；修改作者交付文件的该字段后重新验证，不能修改原文或审查回执。`, affected_lot_ids: affected });
  const root = context.sources.find(source => source.source_id === context.root_source_id);
  if (!root || root.sha256 !== delivery.source_sha256) issue('source_version', '/source_sha256', delivery.source_sha256, '须使用当前冻结输入的 SHA-256');
  const unique = (rows: Array<{ id: string }>, path: string) => {
    const ids = new Set<string>();
    rows.forEach((row, index) => { if (ids.has(row.id)) issue('duplicate_identity', `${path}/${index}/id`, row.id, '同一集合内 ID 必须唯一'); ids.add(row.id); });
    return ids;
  };
  const lotIds = unique(delivery.lots, '/lots');
  const ruleIds = unique(delivery.rules, '/rules');
  const groupIds = unique(delivery.groups, '/groups');
  const refIds = unique(delivery.references, '/references');
  unique(delivery.problems, '/problems');
  const rootBlocks = new Set(root?.blocks.map(block => block.id));
  const quoteCheck = (quote: SourceQuote, path: string, affected: string[]) => {
    if (!verifySourceQuote(context.sources, quote)) issue('source_quote_mismatch', path, quote, '必须绑定可访问原文块内的精确字符区间与原文文字', affected);
  };
  const evidenceCheck = (evidence: SourceQuote[], path: string, affected: string[], required = true) => {
    if (required && !evidence.length) issue('evidence_required', path, evidence, '该判断必须有原文依据', affected);
    evidence.forEach((quote, index) => quoteCheck(quote, `${path}/${index}`, affected));
  };
  const boundCheck = (bound: BoundText, path: string, affected: string[]) => {
    evidenceCheck(bound.evidence, `${path}/evidence`, affected, Boolean(bound.value));
    if (!bound.value && !bound.reason) issue('absence_reason_required', path, bound, '空字段须说明原文缺省或不适用原因，不能用空值隐藏遗漏', affected);
    if (bound.mode === 'summary') {
      if (!bound.reason) issue('summary_reason_required', `${path}/reason`, bound.reason, '归纳文字须保留原文证据和归纳理由，交由独立语义审查', affected);
    } else if (bound.value) {
      const normalized = (text: string) => sourceTextForDisplay(text).replace(/\s+/gu, '');
      if (normalized(bound.value) !== normalized(bound.evidence.map(quote => quote.text).join(''))) {
        issue('literal_field_mismatch', path, bound.value, 'literal 字段须完整等于按顺序绑定的原文；确有归纳需要时显式标记 summary 并说明理由', affected);
      }
    }
  };
  delivery.rules.forEach((rule, index) => {
    evidenceCheck(rule.evidence, `/rules/${index}/evidence`, []);
    if (rule.relationship) {
      for (const id of rule.relationship.objects) if (!lotIds.has(id)) issue('unknown_relationship_object', `/rules/${index}/relationship/objects`, id, '业务规则对象须绑定真实检验批，不能悬空');
      rule.relationship.conditions.forEach((bound, i) => boundCheck(bound, `/rules/${index}/relationship/conditions/${i}`, rule.relationship!.objects));
      rule.relationship.exclusions.forEach((bound, i) => boundCheck(bound, `/rules/${index}/relationship/exclusions/${i}`, rule.relationship!.objects));
    }
  });
  const lotGroups = new Map<string, string[]>();
  delivery.groups.forEach((group, index) => {
    const path = `/groups/${index}`;
    if (!group.lot_ids.length || !group.rule_ids.length) issue('empty_rule_group', path, group.id, '规则组必须声明实际规则和成员');
    for (const id of group.rule_ids) if (!ruleIds.has(id)) issue('unknown_rule', `${path}/rule_ids`, id, '只能使用已声明的规则', group.lot_ids);
    for (const id of group.lot_ids) {
      if (!lotIds.has(id)) issue('unknown_lot', `${path}/lot_ids`, id, '组成员必须指向实际检验批');
      lotGroups.set(id, [...(lotGroups.get(id) ?? []), group.id]);
    }
    for (const id of [...group.trial_lot_ids, ...group.boundary_lot_ids]) {
      if (!group.lot_ids.includes(id)) issue('sample_outside_group', path, id, '样本必须属于当前结构组', group.lot_ids);
    }
    if (!group.trial_lot_ids.length) issue('trial_sample_required', `${path}/trial_lot_ids`, [], '先声明已实际试探的代表样本', group.lot_ids);
  });
  delivery.lots.forEach((lot, index) => {
    const path = `/lots/${index}`;
    const affected = [lot.id];
    boundCheck(lot.name, `${path}/name`, affected);
    if (!lot.name.value) issue('lot_name_required', `${path}/name`, lot.name, '业务检验批必须有完整名称', affected);
    if (!groupIds.has(lot.group_id) || JSON.stringify(lotGroups.get(lot.id)) !== JSON.stringify([lot.group_id])) {
      issue('group_membership', `${path}/group_id`, lotGroups.get(lot.id), '每个批须恰好属于其声明的结构组', affected);
    }
    if (!lot.scope.block_ids.length) issue('empty_lot_scope', `${path}/scope`, lot.scope, '业务范围不能从空来源创建', affected);
    for (const id of lot.scope.block_ids) if (!rootBlocks.has(id)) issue('unknown_root_block', `${path}/scope/block_ids`, id, '业务范围须定位根文档的真实原文块', affected);
    evidenceCheck(lot.scope.evidence, `${path}/scope/evidence`, affected);
    const rank = { 分部: 0, 子分部: 1, 分项: 2 };
    lot.ancestors.forEach((ancestor, a) => {
      boundCheck(ancestor.name, `${path}/ancestors/${a}/name`, affected);
      if (a > 0 && rank[ancestor.kind] <= rank[lot.ancestors[a - 1]!.kind]) issue('ancestor_order', `${path}/ancestors/${a}`, ancestor, '只保留原文支持且按部、子部、分项顺序的业务祖先，不制造占位层级', affected);
    });
    for (const dependency of lot.dependency_ids) if (!lotIds.has(dependency) && !refIds.has(dependency) && !ruleIds.has(dependency)) issue('unknown_dependency', `${path}/dependency_ids`, dependency, '依赖必须指向已声明的批、引用或规则', affected);
    unique(lot.items, `${path}/items`);
    lot.items.forEach((item, itemIndex) => {
      const ip = `${path}/items/${itemIndex}`;
      for (const key of ['name', 'category', 'requirement', 'method', 'quantity', 'unit', 'condition', 'note'] as const) boundCheck(item[key], `${ip}/${key}`, affected);
      if (!item.name.value || !item.requirement.value) issue('item_content_required', ip, { name: item.name.value, requirement: item.requirement.value }, '真实验收项目必须有名称和合格判据', affected);
      boundCheck(item.sampling.text, `${ip}/sampling/text`, affected);
      item.sampling.conditions.forEach((condition, c) => boundCheck(condition, `${ip}/sampling/conditions/${c}`, affected));
      if (item.sampling.status === 'requires_conditions' && !item.sampling.conditions.length) issue('sampling_conditions_required', `${ip}/sampling`, item.sampling, '条件抽样须保留实际条件，缺批量信息不能编造固定数量', affected);
      if (item.sampling.formula) {
        evidenceCheck(item.sampling.formula.evidence, `${ip}/sampling/formula/evidence`, affected);
        if (!item.sampling.formula.variables.length) issue('sampling_formula_variables', `${ip}/sampling/formula`, item.sampling.formula, '公式须显式保留所依赖的工程输入变量；实际固定数量直接保留原文', affected);
      }
      for (const id of item.reference_ids) if (!refIds.has(id)) issue('unknown_reference', `${ip}/reference_ids`, id, '引用必须先声明并取得原文策略回执', affected);
      for (const id of item.rule_ids) if (!ruleIds.has(id)) issue('unknown_rule', `${ip}/rule_ids`, id, '项目规则必须存在', affected);
      const externalQuotes = [item.name, item.category, item.requirement, item.method, item.quantity, item.unit, item.condition,
        item.note, item.sampling.text, ...item.sampling.conditions].flatMap(field => field.evidence)
        .filter(quote => quote.source_id !== context.root_source_id);
      for (const quote of externalQuotes) {
        const applicable = delivery.references.some(reference => item.reference_ids.includes(reference.id)
          && reference.disposition === 'applicable' && reference.dependent_lot_ids.includes(lot.id)
          && reference.source_id === quote.source_id && reference.evidence.some(basis => basis.block_id === quote.block_id
            && basis.start <= quote.start && basis.end >= quote.end));
        if (!applicable) issue('external_field_applicability', ip, quote, '外部正文须有该项目明确采用且绑定对象、用途、条件和原文区间的引用，不因文件已解析就自动授权使用', affected);
      }
    });
  });
  const dispositions = new Map<string, typeof delivery.dispositions>();
  delivery.dispositions.forEach((row, index) => {
    const path = `/dispositions/${index}`;
    const key = `${row.source_id}:${row.block_id}`;
    dispositions.set(key, [...(dispositions.get(key) ?? []), row]);
    const source = context.sources.find(source => source.source_id === row.source_id);
    if (!source?.blocks.some(block => block.id === row.block_id)) issue('unknown_source_block', path, row.block_id, '处置须引用程序独立枚举的原文块', row.lot_ids);
    if (row.role !== 'unresolved') evidenceCheck(row.evidence, `${path}/evidence`, row.lot_ids);
    for (const id of row.lot_ids) if (!lotIds.has(id)) issue('unknown_lot', `${path}/lot_ids`, id, '处置归属必须指向实际业务批');
    if (row.role === 'not_extractable' && row.lot_ids.length) issue('ignored_block_has_owner', path, row.lot_ids, '无需提取和业务归属不可同时声明', row.lot_ids);
    if ((row.role === 'lot' || row.role === 'shared') && !row.lot_ids.length) issue('source_owner_required', path, [], '业务来源或共享规则须声明适用批', []);
    if (row.role === 'unresolved') issue('unresolved_source', path, row.block_id, '未确定来源归属仍属待办，不能声明完成', row.lot_ids);
  });
  for (const block of root?.blocks ?? []) {
    const rows = dispositions.get(`${root!.source_id}:${block.id}`) ?? [];
    if (rows.length !== 1) issue('source_ledger_ownership', '/dispositions', { block_id: block.id, count: rows.length }, '根文档每个原文块须恰好有一条完整处置；共享内容在同一处置中列明全部归属', rows.flatMap(row => row.lot_ids));
    if (block.features.includes('unclosed_table')) issue('source_structure_anomaly', '/dispositions', block.id, '原文表格结构未闭合，须先确认来源或保留问题', rows.flatMap(row => row.lot_ids));
  }
  delivery.lots.forEach(lot => { for (const block of lot.scope.block_ids) {
    const row = dispositions.get(`${context.root_source_id}:${block}`)?.[0];
    if (!row?.lot_ids.includes(lot.id)) issue('scope_ownership_mismatch', '/dispositions', { lot_id: lot.id, block_id: block }, '批范围和全文处置须双向对应', [lot.id]);
  } });
  delivery.references.forEach((reference, index) => {
    const path = `/references/${index}`;
    for (const id of reference.dependent_lot_ids) if (!lotIds.has(id)) issue('unknown_reference_consumer', `${path}/dependent_lot_ids`, id, '引用消费者须为真实检验批');
    quoteCheck(reference.origin, `${path}/origin`, reference.dependent_lot_ids);
    const origin = context.sources.find(source => source.source_id === reference.origin.source_id);
    const field = origin ? referenceSourceField(origin, reference.origin) : 'unclassified';
    if (field === 'ambiguous') issue('reference_origin_ambiguous', `${path}/origin`, reference.origin, '引用区间须缩小到单一实际字段；跨验收依据和允许偏差的宽引用不能取得处置批准', reference.dependent_lot_ids);
    const receipt = context.resolved_references[reference.id];
    if (!receipt || receipt.key !== referenceScenarioKey(reference)) issue('reference_receipt_required', path, reference.id, '调用 resolve_acceptance_reference 核对当前版本、条款、对象、用途、条件和来源后再交付', reference.dependent_lot_ids);
    if ((field === 'allowable_deviation' || receipt?.literal_only) && reference.disposition !== 'literal') issue('literal_reference_policy', `${path}/disposition`, reference.disposition, '该来源字段或外部层级只能保留完整引用文字，不能冒充正文已核验', reference.dependent_lot_ids);
    if (reference.disposition === 'applicable' || reference.disposition === 'not_applicable') {
      if (!reference.source_id || reference.source_id !== receipt?.source_id) issue('reference_source_identity', `${path}/source_id`, reference.source_id, '只能使用当前回执所确认版本的正文', reference.dependent_lot_ids);
      evidenceCheck(reference.evidence, `${path}/evidence`, reference.dependent_lot_ids);
      if (!reference.evidence.some(quote => quote.source_id === reference.source_id)) issue('reference_body_evidence', `${path}/evidence`, reference.evidence, '适用性判断必须引用目标版本正文', reference.dependent_lot_ids);
    }
    if (reference.disposition === 'unresolved') issue('unresolved_reference', path, reference.id, '引用依赖未闭合，保留问题和检查点', reference.dependent_lot_ids);
    reference.conditions.forEach((condition, c) => boundCheck(condition, `${path}/conditions/${c}`, reference.dependent_lot_ids));
  });
  for (const [index, problem] of delivery.problems.entries()) {
    for (const id of problem.affected_lot_ids) if (!lotIds.has(id)) issue('unknown_problem_scope', '/problems', id, '影响范围不能以不存在的检验批绕过全局阻塞');
    issue(`pending_${problem.kind}`, `/problems/${index}`, problem, problem.message, problem.affected_lot_ids);
  }
  return { delivery, issues };
}

/** A local trial is independent of unfinished inventory elsewhere. Publication still uses every issue. */
export function groupReviewBlockers(delivery: AcceptanceDelivery, group: AcceptanceGroup, issues: AcceptanceIssue[]): AcceptanceIssue[] {
  const lots = new Set(group.lot_ids);
  const rules = new Set(group.rule_ids);
  const refs = new Set<string>();
  let count = -1;
  while (count !== lots.size + rules.size + refs.size) {
    count = lots.size + rules.size + refs.size;
    const sharedBlocks = new Set(delivery.lots.filter(lot => lots.has(lot.id)).flatMap(lot => lot.scope.block_ids));
    for (const lot of delivery.lots) if (lot.scope.block_ids.some(id => sharedBlocks.has(id))) lots.add(lot.id);
    for (const lot of delivery.lots.filter(lot => lots.has(lot.id))) {
      for (const id of lot.dependency_ids) {
        if (delivery.lots.some(row => row.id === id)) lots.add(id);
        if (delivery.rules.some(row => row.id === id)) rules.add(id);
        if (delivery.references.some(row => row.id === id)) refs.add(id);
      }
      lot.items.forEach(item => { item.rule_ids.forEach(id => rules.add(id)); item.reference_ids.forEach(id => refs.add(id)); });
    }
    for (const ref of delivery.references) if (ref.dependent_lot_ids.some(id => lots.has(id))) refs.add(ref.id);
  }
  const blocks = new Set(delivery.lots.filter(lot => lots.has(lot.id)).flatMap(lot => lot.scope.block_ids));
  const relatedProblem = (problem: AcceptanceDelivery['problems'][number]) => problem.affected_lot_ids.some(id => lots.has(id))
    || problem.block_ids.some(id => blocks.has(id)) || problem.dependency_ids.some(id => lots.has(id) || rules.has(id) || refs.has(id));
  return issues.filter(issue => {
    if (issue.affected_lot_ids.some(id => lots.has(id))) return true;
    const [, collection, index] = issue.path.split('/');
    if (collection === 'lots') return lots.has(delivery.lots[Number(index)]?.id ?? '');
    if (collection === 'groups') {
      const row = delivery.groups[Number(index)];
      return !row || row.id === group.id || row.lot_ids.some(id => lots.has(id));
    }
    if (collection === 'rules') return rules.has(delivery.rules[Number(index)]?.id ?? '');
    if (collection === 'references') return refs.has(delivery.references[Number(index)]?.id ?? '');
    if (collection === 'problems') {
      const problem = delivery.problems[Number(index)];
      // Each issue owns its scope; an unmapped integrity issue stays fail-closed.
      return !problem || relatedProblem(problem);
    }
    if (collection === 'dispositions') {
      const row = delivery.dispositions[Number(index)];
      if (row) return blocks.has(row.block_id) || row.lot_ids.some(id => lots.has(id));
      const block = typeof issue.actual === 'string' ? issue.actual : (issue.actual as { block_id?: string })?.block_id;
      if (block) return blocks.has(block);
    }
    // Unknown global integrity errors (including source identity) remain fail-closed.
    return !issue.affected_lot_ids.length;
  });
}

/** Show why an authored problem blocks this review, without reinterpreting or clearing its declaration. */
export function reviewBlockerFeedback(delivery: AcceptanceDelivery, group: AcceptanceGroup, issues: AcceptanceIssue[]) {
  const lots = delivery.lots.filter(lot => group.lot_ids.includes(lot.id));
  const ids = new Set(lots.map(lot => lot.id)), blocks = new Set(lots.flatMap(lot => lot.scope.block_ids));
  const dependencies = new Set([...group.rule_ids, ...lots.flatMap(lot => [...lot.dependency_ids,
    ...lot.items.flatMap(item => [...item.rule_ids, ...item.reference_ids])])]);
  const paths = new Set(issues.map(issue => issue.path));
  const relevant = delivery.problems.flatMap((problem, index) => paths.has(`/problems/${index}`) ? [{ problem, path: `/problems/${index}` }] : []);
  const blocked_problem_scopes = relevant.slice(0, 4).map(({ problem, path }) => {
    const matchingBlocks = problem.block_ids.filter(id => blocks.has(id));
    const matchingLots = problem.affected_lot_ids.filter(id => ids.has(id));
    const matchingDependencies = problem.dependency_ids.filter(id => dependencies.has(id));
    return { path, id: problem.id.slice(0, 160), kind: problem.kind,
      actual: { declared_block_count: problem.block_ids.length, declared_lot_count: problem.affected_lot_ids.length,
        declared_dependency_count: problem.dependency_ids.length, matching_block_count: matchingBlocks.length,
        matching_blocks: matchingBlocks.slice(0, 8).map(id => ({ block_id: id.slice(0, 160),
          roles: [...new Set(delivery.dispositions.filter(row => row.source_id === delivery.source_sha256 && row.block_id === id).map(row => row.role))],
          consumer_lot_ids: lots.filter(lot => lot.scope.block_ids.includes(id)).slice(0, 8).map(lot => lot.id.slice(0, 160)) })),
        matching_lot_ids: matchingLots.slice(0, 8).map(id => id.slice(0, 160)), matching_lot_count: matchingLots.length,
        matching_dependency_ids: matchingDependencies.slice(0, 8).map(id => id.slice(0, 160)), matching_dependency_count: matchingDependencies.length },
      writable_paths: ['message', 'affected_lot_ids', 'block_ids', 'dependency_ids'].map(field => `${path}/${field}`) };
  });
  if (!blocked_problem_scopes.length) return { model_started: false };
  return { model_started: false, semantic_approval: false, blocked_problem_scopes, total_blocking_problems: relevant.length,
    expected: '当前组/小样没有尚未解决且实际影响本范围的缺陷；未知全局范围仍阻止封存。',
    writable: '仅作者交付文件中 writable_paths 所指问题声明及实际出错的字段；原文、程序检查点、批准/封存回执及历史用量不可写。',
    how_to_pass: '据上列实际关联核对问题范围。待复核、待批准是流程进度，用 report_acceptance_progress 记录；若问题仅反映这些阶段状态，应按真实未决原文维护范围，避免用等待本次复核的状态阻止同一次复核。真实结构、边界或字段缺陷仍须先修复，不能为进入审查而删除有效问题。修订后重新验证，再调用原审查工具；本回条不批准任何结果。' };
}

/** A local issue blocks its transitive consumers; an unknown/global scope blocks publication. */
export function eligibleLotIds(delivery: AcceptanceDelivery, issues: AcceptanceIssue[], approvedGroups: ReadonlySet<string>): string[] {
  if (issues.some(issue => !issue.affected_lot_ids.length)) return [];
  const blocked = new Set(issues.flatMap(issue => issue.affected_lot_ids));
  for (const lot of delivery.lots) if (!approvedGroups.has(lot.group_id)) blocked.add(lot.id);
  const blockedRules = new Set(delivery.groups.filter(group => !approvedGroups.has(group.id)).flatMap(group => group.rule_ids));
  let changed = true;
  while (changed) {
    changed = false;
    const blockedReferences = new Set(delivery.references.filter(ref => ref.disposition === 'unresolved'
      || ref.dependent_lot_ids.some(id => blocked.has(id))).map(ref => ref.id));
    for (const lot of delivery.lots) {
      const dependentRefs = delivery.references.filter(ref => ref.dependent_lot_ids.includes(lot.id));
      if (!blocked.has(lot.id) && (lot.dependency_ids.some(id => blocked.has(id) || blockedRules.has(id) || blockedReferences.has(id))
        || dependentRefs.some(ref => ref.disposition === 'unresolved')
        || lot.items.some(item => item.rule_ids.some(id => blockedRules.has(id))))) { blocked.add(lot.id); changed = true; }
    }
  }
  return delivery.lots.filter(lot => !blocked.has(lot.id)).map(lot => lot.id);
}
