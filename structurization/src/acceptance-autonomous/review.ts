import { sha256Json } from '../canonical.js';
import type { AcceptanceDelivery, AcceptanceGroup, GroupReviewResult, ReviewFailureCheck, SourceLedger } from './contracts.js';
import { verifySourceQuote } from './source-ledger.js';
import { reviewEvidenceId } from './review-evidence.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AutonomousWorkRequest, SampleReviewReceipt } from './contracts.js';

export function reviewQuoteBlocks(value: unknown, keys = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach(row => reviewQuoteBlocks(row, keys));
  else if (value && typeof value === 'object') {
    const row = value as Record<string, unknown>;
    if (typeof row.source_id === 'string' && typeof row.block_id === 'string') keys.add(`${row.source_id}:${row.block_id}`);
    Object.values(row).forEach(item => reviewQuoteBlocks(item, keys));
  }
  return keys;
}

/** Shared method examples owned by other lots are not evidence for this local review. */
export function focusedReviewRules(delivery: AcceptanceDelivery, lots: AcceptanceDelivery['lots'],
  references: AcceptanceDelivery['references'], rules: AcceptanceDelivery['rules'], problemBlocks: string[]) {
  const selected = new Set(lots.map(lot => lot.id)), selectedRefs = new Set(references.map(ref => ref.id));
  const focus = reviewQuoteBlocks([lots, references]);
  for (const id of [...problemBlocks, ...lots.flatMap(lot => lot.scope.block_ids)]) focus.add(`${delivery.source_sha256}:${id}`);
  const otherLots = delivery.lots.filter(lot => !selected.has(lot.id));
  const outside = reviewQuoteBlocks([otherLots, delivery.references.filter(ref => !selectedRefs.has(ref.id))]);
  for (const lot of otherLots) for (const id of lot.scope.block_ids) outside.add(`${delivery.source_sha256}:${id}`);
  return rules.map(rule => ({ ...rule, evidence: rule.evidence.filter(quote => {
    const key = `${quote.source_id}:${quote.block_id}`;
    return focus.has(key) || !outside.has(key);
  }) }));
}

/** Bind a sample to its actual rules and dependencies, rather than the growing group roster. */
export function sampleReviewMaterial(delivery: AcceptanceDelivery, group: AcceptanceGroup, ids: string[]) {
  const selected = new Set(ids), ruleIds = new Set<string>(), refIds = new Set<string>();
  const boundByGroup = new Set(delivery.lots.filter(lot => group.lot_ids.includes(lot.id)).flatMap(lot =>
    [...lot.dependency_ids, ...lot.items.flatMap(item => item.rule_ids)]));
  // Unbound group rules are shared context and remain conservative dependencies of every sample.
  group.rule_ids.filter(id => !boundByGroup.has(id)).forEach(id => ruleIds.add(id));
  let count = -1;
  while (count !== selected.size + ruleIds.size + refIds.size) {
    count = selected.size + ruleIds.size + refIds.size;
    const blocks = new Set(delivery.lots.filter(lot => selected.has(lot.id)).flatMap(lot => lot.scope.block_ids));
    for (const lot of delivery.lots) if (lot.scope.block_ids.some(id => blocks.has(id))) selected.add(lot.id);
    for (const lot of delivery.lots.filter(lot => selected.has(lot.id))) {
      for (const id of lot.dependency_ids) {
        if (delivery.lots.some(row => row.id === id)) selected.add(id);
        if (delivery.rules.some(row => row.id === id)) ruleIds.add(id);
        if (delivery.references.some(row => row.id === id)) refIds.add(id);
      }
      lot.items.forEach(item => { item.rule_ids.forEach(id => ruleIds.add(id)); item.reference_ids.forEach(id => refIds.add(id)); });
    }
    delivery.rules.filter(rule => rule.relationship?.objects.some(id => selected.has(id))).forEach(rule => ruleIds.add(rule.id));
    delivery.references.filter(ref => ref.dependent_lot_ids.some(id => selected.has(id))).forEach(ref => refIds.add(ref.id));
  }
  const byId = <T extends { id: string }>(rows: T[]) => [...rows].sort((a, b) => a.id.localeCompare(b.id));
  const lots = byId(delivery.lots.filter(lot => selected.has(lot.id)));
  const rules = byId(delivery.rules.filter(rule => ruleIds.has(rule.id)));
  const references = byId(delivery.references.filter(ref => refIds.has(ref.id)).map(ref => ({ ...ref,
    dependent_lot_ids: ref.dependent_lot_ids.filter(id => selected.has(id)).sort() })));
  const dispositions = delivery.dispositions.filter(row => row.lot_ids.some(id => selected.has(id))).map(row => ({ ...row,
    lot_ids: row.lot_ids.filter(id => selected.has(id)).sort() })).sort((a, b) => `${a.source_id}:${a.block_id}`.localeCompare(`${b.source_id}:${b.block_id}`));
  return { group: { id: group.id, conditions: group.conditions, exclusions: [...group.exclusions].sort() }, lots, rules, references, dispositions };
}

export function sampleReviewFingerprint(delivery: AcceptanceDelivery, group: AcceptanceGroup, id: string, files: Record<string, string>, images?: Record<string, string>) {
  const material = sampleReviewMaterial(delivery, group, [id]);
  const paths = new Set(material.rules.flatMap(rule => rule.method_files));
  return sha256Json({ protocol: 'acceptance-sample/v1', source: delivery.source_sha256, ...material,
    files: Object.fromEntries(Object.entries(files).filter(([path]) => paths.has(path))), ...(images ? { images } : {}) });
}

export function sampleReceiptAccepted(receipt: SampleReviewReceipt, requests: AutonomousWorkRequest[]): boolean {
  const request = requests.find(row => row.id === receipt.request_id);
  const result = request?.result;
  return Boolean(request?.sample_fingerprints?.[receipt.lot_id] === receipt.fingerprint && result
    && ['passed', 'needs_work'].includes(request.status) && result.reviewed_lot_ids.includes(receipt.lot_id)
    && (result.approved || result.lot_decisions?.some(row => row.lot_id === receipt.lot_id && row.approved))
    && !result.findings.some(finding => !finding.lot_id || !(finding.lot_id in (request.sample_fingerprints ?? {})) || finding.lot_id === receipt.lot_id));
}

/** Old snapshots stay untouched; their actual candidate scopes still count as exposed. */
export async function reviewExposures(root: string, request: AutonomousWorkRequest): Promise<Array<{ lot_id: string; block_ids: string[] }>> {
  // A model extracting a scope has already seen it, even before it created candidate IDs.
  if (request.kind === 'extraction' && request.extraction) return [
    { lot_id: request.extraction.task_id, block_ids: request.extraction.block_ids }, ...(request.exposed_lots ?? []),
  ];
  if (request.exposed_lots) return request.exposed_lots;
  if (!/^review:[a-f0-9]{24}$/u.test(request.id)) throw new Error('Invalid review history identity');
  const input = JSON.parse(await readFile(join(root, 'reviews', `${request.id.replace(':', '_')}.input.json`), 'utf8'));
  if (!Array.isArray(input.lots)) throw new Error('Review exposure history is unavailable');
  return input.lots.map((lot: { id: string; scope: { block_ids: string[] } }) => ({ lot_id: lot.id, block_ids: lot.scope.block_ids }));
}

/** Batch membership may grow after a trial; only changed trial inputs require another trial. */
export function trialReviewGroup(delivery: AcceptanceDelivery, group: AcceptanceGroup): AcceptanceGroup {
  const seeds = new Set([...group.trial_lot_ids, ...group.boundary_lot_ids]);
  const blocks = new Set(delivery.lots.filter(lot => seeds.has(lot.id)).flatMap(lot => lot.scope.block_ids));
  const lots = delivery.lots.filter(lot => seeds.has(lot.id) || lot.scope.block_ids.some(id => blocks.has(id)));
  return { ...group, lot_ids: lots.map(lot => lot.id),
    rule_ids: [...new Set([...group.rule_ids, ...lots.flatMap(lot => lot.items.flatMap(item => item.rule_ids))])] };
}

export function groupReviewFingerprint(delivery: AcceptanceDelivery, group: AcceptanceGroup, files: Record<string, string>, images?: Record<string, string>): string {
  return sha256Json({ source: delivery.source_sha256, group,
    rules: delivery.rules.filter(rule => group.rule_ids.includes(rule.id)), files,
    lots: delivery.lots.filter(lot => group.lot_ids.includes(lot.id)),
    references: delivery.references.filter(ref => ref.dependent_lot_ids.some(id => group.lot_ids.includes(id))),
    dispositions: delivery.dispositions.filter(row => row.lot_ids.some(id => group.lot_ids.includes(id))), ...(images ? { images } : {}) });
}

/** A rejected submission must identify the field to fix without discarding valid findings. */
export function reviewSubmissionIssues(result: GroupReviewResult, ids: string[], sources: SourceLedger[], checks: ReviewFailureCheck[] = []) {
  const issues: Array<{ path: string; actual: unknown; expected: unknown }> = [];
  if (!result.reason?.trim()) issues.push({ path: '/reason', actual: result.reason, expected: '实际核对过程和结论' });
  if (result.reviewed_lot_ids.length !== ids.length || ids.some(id => !result.reviewed_lot_ids.includes(id)) || new Set(result.reviewed_lot_ids).size !== result.reviewed_lot_ids.length) {
    issues.push({ path: '/reviewed_lot_ids', actual: result.reviewed_lot_ids, expected: ids });
  }
  if (result.approved && result.findings.length) issues.push({ path: '/approved', actual: true, expected: false });
  if (result.lot_decisions) {
    const decisions = result.lot_decisions;
    if (decisions.length !== ids.length || new Set(decisions.map(row => row.lot_id)).size !== ids.length
      || ids.some(id => !decisions.some(row => row.lot_id === id)) || decisions.some(row => !row.reason.trim())) {
      issues.push({ path: '/lot_decisions', actual: decisions, expected: ids });
    }
    if (result.approved !== (decisions.every(row => row.approved) && !result.findings.length)) issues.push({ path: '/approved', actual: result.approved, expected: '仅所有逐批决定通过且 findings 为空时为 true' });
    decisions.forEach((row, i) => { if (row.approved && result.findings.some(finding => !finding.lot_id || finding.lot_id === row.lot_id)) issues.push({ path: `/lot_decisions/${i}/approved`, actual: true, expected: false }); });
  }
  result.findings.forEach((finding, i) => {
    if (finding.lot_id && !ids.includes(finding.lot_id)) issues.push({ path: `/findings/${i}/lot_id`, actual: finding.lot_id,
      expected: { lot_ids: ids, global: '无法归属到本次候选的问题用空 lot_id；全局问题不能让任何逐批决定通过。' } });
    if (!finding.path || !finding.message || !finding.evidence.length) issues.push({ path: `/findings/${i}`, actual: finding, expected: '定位字段、具体问题及至少一条精确原文证据' });
    finding.evidence.forEach((quote, q) => {
      if (verifySourceQuote(sources, quote)) return;
      const block = sources.find(source => source.source_id === quote.source_id)?.blocks.find(block => block.id === quote.block_id);
      issues.push({ path: `/findings/${i}/evidence/${q}`, actual: { ...quote, text: quote.text.slice(0, 256) },
        expected: { source_block_exists: Boolean(block), block_utf16_length: block?.text.length,
          source_ids_owning_block: sources.filter(source => source.blocks.some(row => row.id === quote.block_id)).map(source => source.source_id),
          evidence_ids: sources.flatMap(source => source.blocks.filter(row => row.id === quote.block_id).map(block => reviewEvidenceId(source, block))),
          text_at_range: block?.text.slice(Math.max(0, quote.start), quote.end).slice(0, 256),
          instruction: '优先将本条证据改为 {evidence_id}，程序还原冻结原文及坐标；需短引文加逐字匹配的 excerpt。保留其他有效 findings。旧坐标格式须满足 UTF-16 start/end/text 完全相等。' } });
    });
  });
  const answers = result.failure_responses ?? [];
  answers.forEach((answer, i) => {
    if (!checks.some(check => check.id === answer.check_id) || answers.filter(row => row.check_id === answer.check_id).length !== 1
      || !['fixed', 'not_applicable', 'unresolved'].includes(answer.disposition) || !answer.reason?.trim() || !answer.evidence?.length) {
      issues.push({ path: `/failure_responses/${i}`, actual: answer,
        expected: { check_ids: checks.map(check => check.id), instruction: '每个 check_id 只回应一次；说明具体修复或原问题不成立的依据，附有效原文证据；尚未解决写 unresolved。' } });
    }
    answer.evidence?.forEach((quote, q) => {
      if (verifySourceQuote(sources, quote)) return;
      issues.push({ path: `/failure_responses/${i}/evidence/${q}`, actual: quote,
        expected: { source_ids_owning_block: sources.filter(source => source.blocks.some(row => row.id === quote.block_id)).map(source => source.source_id),
          evidence_ids: sources.flatMap(source => source.blocks.filter(row => row.id === quote.block_id).map(block => reviewEvidenceId(source, block))),
          instruction: '优先改用 {evidence_id}，程序还原冻结原文及坐标；需短引文加逐字匹配的 excerpt。旧坐标格式仍严格校验；不可修改原件或删除真实问题。' } });
    });
  });
  for (const check of checks) {
    const approved = result.approved || result.lot_decisions?.some(row => row.lot_id === check.lot_id && row.approved);
    if (approved && !answers.some(answer => answer.check_id === check.id && ['fixed', 'not_applicable'].includes(answer.disposition))) {
      issues.push({ path: '/failure_responses', actual: { missing_or_unresolved_check_id: check.id, lot_id: check.lot_id },
        expected: '批准本批前须逐项核对 failure_checks，用 fixed 或 not_applicable、具体理由及原文证据回应；未解决则拒绝该批并保留 findings。笼统通过不能核销旧问题。' });
    }
  }
  return issues;
}
