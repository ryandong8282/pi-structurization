import { readFile, mkdir, writeFile, copyFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWriteJson } from '../atomic.js';
import { sha256Json, sha256Text } from '../canonical.js';
import type { AcceptanceDelivery, AcceptanceIssue, SourceLedger, SourceQuote } from './contracts.js';
import { buildAcceptanceSourceLedger, verifySourceQuote } from './source-ledger.js';
import type { AgenticSplitDecision } from './agentic-lot-split.js';

export interface SplitSourceSlice extends SourceQuote { block: number; start_line: number; end_line: number }
export interface SplitInputDecision {
  id: string; kind: AgenticSplitDecision['kind']; name: string; reason: string;
  related_lot_ids: string[]; source: SplitSourceSlice[];
}
export interface SplitBoundaryReview {
  schema_version: 'acceptance-split-boundary-review/v1'; manifest_sha256: string; source_sha256: string;
  pdf_sha256: string; reviewed_by: string; review_scope: string;
  entries: Array<{ block_id: string; start: number; end: number; from_id: string; to_id: string;
    pdf_page: number; page_image_sha256: string; reason: string }>;
}
export interface LotSplitHandoff {
  schema_version: 'acceptance-lot-split-handoff/v1'; source_sha256: string; manifest_sha256: string;
  pdf_sha256: string | null; decisions: SplitInputDecision[]; boundary_review?: SplitBoundaryReview;
  history: { checkpoint_sha256: string; tool_calls: number; tool_response_bytes: number; sessions: number; limits: unknown };
  /** A host-created continuation of an incomplete split; the predecessor remains immutable. */
  supersedes_sha256?: string;
}

export function assertSplitRefinement(previous: LotSplitHandoff, next: LotSplitHandoff) {
  if (next.supersedes_sha256 !== sha256Json(previous) || previous.source_sha256 !== next.source_sha256
    || previous.pdf_sha256 !== next.pdf_sha256 || !previous.decisions.some(row => row.kind === 'unresolved')
    || next.decisions.some(row => row.kind === 'unresolved')
    || sha256Json(previous.history.limits) !== sha256Json(next.history.limits)
    || ['tool_calls', 'tool_response_bytes', 'sessions'].some(key => next.history[key as 'sessions'] < previous.history[key as 'sessions']))
    throw new Error('Invalid split refinement: preserve exact source, predecessor, limits and all accumulated counts; resolve pending ranges before handoff.');
}

/** Continue an incomplete rule-assisted seal without writing into the predecessor directory. */
export async function createUnresolvedSplitRefinement(previousRoot: string, root: string, markdown: string, previous: LotSplitHandoff) {
  const verified = await prepareLotSplitHandoff(previousRoot, markdown);
  if (sha256Json(verified) !== sha256Json(previous) || !previous.decisions.some(row => row.kind === 'unresolved'))
    throw new Error('Refinement requires the exact registered incomplete predecessor.');
  const checkpoint = JSON.parse(await readFile(join(previousRoot, 'checkpoint.json'), 'utf8'));
  if (checkpoint.strategy !== 'rule-assisted') throw new Error('Legacy split strategy is preserved; automatic refinement is only for rule-assisted runs.');
  const predecessorHash = sha256Json(previous);
  const existing = await readFile(join(root, 'checkpoint.json'), 'utf8').catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
  if (existing) {
    const saved = JSON.parse(existing);
    if (saved.refinement_of !== predecessorHash || saved.source_digest !== checkpoint.source_digest
      || saved.pdf_digest !== checkpoint.pdf_digest || sha256Json(saved.limits) !== sha256Json(checkpoint.limits)
      || ['tool_calls', 'tool_response_bytes', 'sessions'].some(key => saved[key] < checkpoint[key]))
      throw new Error('Existing refinement differs from its predecessor; no checkpoint was reset.');
    return;
  }
  const staging = `${root}.preparing`;
  await mkdir(staging);
  for (const name of ['source.md', 'source.json', ...(checkpoint.pdf_digest ? ['pdf-evidence.json'] : [])])
    await copyFile(join(previousRoot, name), join(staging, name));
  await atomicWriteJson(join(staging, 'checkpoint.json'), { ...checkpoint, sealed: false, refinement_of: predecessorHash });
  await rename(staging, root);
}

/** Transport ordering only, identical to the splitter; no business-title heuristics. */
function orderedBlocks(source: SourceLedger) {
  const chunks: Array<{ page: number; order: number; blocks: typeof source.blocks }> = [];
  for (const block of source.blocks) {
    const marker = block.text.match(/^<!--\s*pages_(\d+)_(\d+)\s*-->$/u);
    if (marker || !chunks.length) chunks.push({ page: Number(marker?.[1] ?? 0), order: chunks.length, blocks: [] });
    chunks.at(-1)!.blocks.push(block);
  }
  return chunks.sort((a, b) => a.page - b.page || a.order - b.order).flatMap(chunk => chunk.blocks);
}

export function validateLotSplitHandoff(value: LotSplitHandoff, source: SourceLedger): void {
  if (value.schema_version !== 'acceptance-lot-split-handoff/v1' || value.source_sha256 !== source.sha256)
    throw new Error('Split handoff source/version mismatch; reuse requires the exact frozen Markdown.');
  const ids = new Set<string>(), coverage = new Map<string, SplitSourceSlice[]>();
  for (const decision of value.decisions) {
    if (!/^[a-zA-Z0-9_-]{1,80}$/u.test(decision.id) || ids.has(decision.id) || !decision.source.length || !decision.name.trim()
      || !['lot', 'shared', 'non_lot', 'unresolved'].includes(decision.kind)) throw new Error('Split decision IDs/names/ranges are invalid.');
    ids.add(decision.id);
    for (const piece of decision.source) {
      if (!verifySourceQuote([source], piece) || piece.source_id !== source.source_id || piece.start === piece.end)
        throw new Error(`Split raw slice changed: ${decision.id}/${piece.block_id}.`);
      coverage.set(piece.block_id, [...(coverage.get(piece.block_id) ?? []), piece]);
    }
  }
  const lots = new Set(value.decisions.filter(row => row.kind === 'lot').map(row => row.id));
  for (const decision of value.decisions) if (decision.related_lot_ids.some(id => !lots.has(id))) throw new Error('Split shared/unresolved link has no lot.');
  for (const block of source.blocks) {
    let end = 0;
    for (const piece of (coverage.get(block.id) ?? []).sort((a, b) => a.start - b.start)) {
      if (piece.start !== end) throw new Error(`Split source gap/overlap: ${block.id}:${end}.`);
      end = piece.end;
    }
    if (end !== block.text.length) throw new Error(`Split source is incomplete: ${block.id}:${end}/${block.text.length}.`);
  }
}

/** Read-only adoption. The original seal and its complete accounting are never rewritten. */
export async function prepareLotSplitHandoff(splitRoot: string, markdown: string, review?: SplitBoundaryReview): Promise<LotSplitHandoff> {
  const source = buildAcceptanceSourceLedger(markdown), blocks = orderedBlocks(source);
  const [manifestText, checkpointText, frozenMarkdown] = await Promise.all(['manifest.json', 'checkpoint.json', 'source.md'].map(name => readFile(join(splitRoot, name), 'utf8')));
  const manifest = JSON.parse(manifestText!), checkpoint = JSON.parse(checkpointText!);
  if (sha256Text(frozenMarkdown!) !== source.sha256 || manifest.schema_version !== 'agentic-lot-split/v3'
    || checkpoint.schema_version !== 'agentic-lot-split/v3' || manifest.status !== 'sealed' || !checkpoint.sealed || checkpoint.source_digest !== sha256Json(source)
    || manifest.source_sha256 !== source.sha256 || manifest.revision !== checkpoint.revision)
    throw new Error('Only a complete, source-matching persisted split may be adopted; preserve partial runs and counters.');
  if (checkpoint.pdf_digest) {
    const pdf = JSON.parse(await readFile(join(splitRoot, 'pdf-evidence.json'), 'utf8'));
    if (sha256Json(pdf) !== checkpoint.pdf_digest || pdf.sha256 !== manifest.pdf_sha256) throw new Error('Split PDF evidence changed.');
  }
  const decisions: SplitInputDecision[] = [];
  for (const row of checkpoint.decisions as AgenticSplitDecision[]) {
    if (row.open_end || checkpoint.reviews[row.id]?.digest !== sha256Json(row)) throw new Error(`Split boundary is not closed/reviewed: ${row.id}.`);
    const emitted = manifest.decisions.find((item: { id: string }) => item.id === row.id);
    if (!emitted) throw new Error(`Split manifest lost a decision: ${row.id}.`);
    for (const key of ['id', 'kind', 'name', 'reason', 'ranges', 'related_lot_ids', 'open_end'] as const)
      if (sha256Json(emitted[key] ?? null) !== sha256Json(row[key] ?? null)) throw new Error(`Split manifest decision changed: ${row.id}/${key}.`);
    const pieces = row.ranges.flatMap(range => {
      if (!Number.isSafeInteger(range.from) || !Number.isSafeInteger(range.to) || range.from < 0 || range.to < range.from || range.to >= blocks.length)
        throw new Error('Invalid frozen split range.');
      return blocks.slice(range.from, range.to + 1).map((block, index) => ({ source_id: source.source_id, block_id: block.id,
        block: range.from + index, start: index === 0 ? range.start ?? 0 : 0,
        end: range.from + index === range.to ? range.end ?? block.text.length : block.text.length }));
    }).sort((a, b) => a.block - b.block || a.start - b.start);
    const raw = pieces.map(piece => { const block = blocks[piece.block]!; return { ...piece,
      text: block.text.slice(piece.start, piece.end), start_line: block.start_line + block.text.slice(0, piece.start).split('\n').length - 1,
      end_line: block.start_line + block.text.slice(0, piece.end).split('\n').length - 1 }; });
    if (sha256Json(raw) !== sha256Json(emitted.source)) throw new Error(`Split manifest raw source changed: ${row.id}.`);
    decisions.push({ id: row.id, kind: row.kind, name: row.name, reason: row.reason, related_lot_ids: row.related_lot_ids, source: raw });
  }
  if (manifest.decisions.length !== decisions.length) throw new Error('Split manifest contains unregistered decisions.');
  const result: LotSplitHandoff = { schema_version: 'acceptance-lot-split-handoff/v1', source_sha256: source.sha256,
    manifest_sha256: sha256Text(manifestText!), pdf_sha256: manifest.pdf_sha256, decisions,
    history: { checkpoint_sha256: sha256Text(checkpointText!), tool_calls: checkpoint.tool_calls,
      tool_response_bytes: checkpoint.tool_response_bytes, sessions: checkpoint.sessions, limits: checkpoint.limits } };
  if (checkpoint.refinement_of) result.supersedes_sha256 = checkpoint.refinement_of;
  validateLotSplitHandoff(result, source);
  if (review) {
    if (review.schema_version !== 'acceptance-split-boundary-review/v1' || review.manifest_sha256 !== result.manifest_sha256
      || review.source_sha256 !== source.sha256 || review.pdf_sha256 !== result.pdf_sha256 || !review.reviewed_by.trim())
      throw new Error('Boundary review is not bound to this sealed split and original PDF.');
    const moved = new Set<string>();
    for (const entry of review.entries) {
      const from = decisions.find(row => row.id === entry.from_id), to = decisions.find(row => row.id === entry.to_id);
      const key = `${entry.block_id}:${entry.start}:${entry.end}`;
      if (!from || !to || moved.has(key) || !entry.reason.trim() || !Number.isSafeInteger(entry.pdf_page) || entry.pdf_page < 1
        || !/^[a-f0-9]{64}$/u.test(entry.page_image_sha256)) throw new Error('Invalid or duplicate boundary review entry.');
      moved.add(key);
      const index = from.source.findIndex(piece => piece.block_id === entry.block_id && piece.start <= entry.start && piece.end >= entry.end);
      if (index === -1 || entry.start >= entry.end) throw new Error('Reviewed interval is not owned by the stated original decision.');
      if (from === to) continue;
      const piece = from.source[index]!, block = source.blocks.find(row => row.id === entry.block_id)!;
      const slice = (start: number, end: number): SplitSourceSlice => ({ ...piece, start, end, text: block.text.slice(start, end),
        start_line: block.start_line + block.text.slice(0, start).split('\n').length - 1,
        end_line: block.start_line + block.text.slice(0, end).split('\n').length - 1 });
      from.source.splice(index, 1, ...[slice(piece.start, entry.start), slice(entry.end, piece.end)].filter(row => row.start < row.end));
      to.source.push(slice(entry.start, entry.end));
      to.source.sort((a, b) => a.block - b.block || a.start - b.start);
    }
    result.boundary_review = review;
    validateLotSplitHandoff(result, source);
  }
  return result;
}

export function lotSplitInputs(handoff: LotSplitHandoff) {
  return handoff.decisions.filter(row => row.kind === 'lot').map(lot => ({ ...lot,
    shared: handoff.decisions.filter(row => row.kind === 'shared' && row.related_lot_ids.includes(lot.id)),
    unresolved: handoff.decisions.filter(row => row.kind === 'unresolved' && (!row.related_lot_ids.length || row.related_lot_ids.includes(lot.id))) }));
}

/** Existing IDs are matched by primary source material; no renaming, deletion or receipt reset. */
export function mapSplitCandidates(handoff: LotSplitHandoff, source: SourceLedger, delivery?: AcceptanceDelivery) {
  const tables = new Set(source.blocks.filter(row => row.kind === 'table').map(row => row.id));
  const lengths = new Map(source.blocks.map(row => [row.id, row.text.length]));
  return lotSplitInputs(handoff).map(input => {
    const tablePieces = input.source.filter(piece => tables.has(piece.block_id));
    const anchors = tablePieces.length ? tablePieces : input.source;
    const partial = (piece: SplitSourceSlice) => piece.start !== 0 || piece.end !== lengths.get(piece.block_id);
    const matches = delivery?.lots.filter(lot => anchors.some(piece => lot.scope.block_ids.includes(piece.block_id)
      && (!partial(piece) || lot.scope.evidence.some(quote => quote.source_id === source.source_id && quote.block_id === piece.block_id
        && quote.start < piece.end && quote.end > piece.start)))) ?? [];
    const missing = anchors.filter(piece => !matches.some(lot => {
      if (!lot.scope.block_ids.includes(piece.block_id)) return false;
      if (!partial(piece)) return true;
      let end = piece.start;
      for (const quote of lot.scope.evidence.filter(quote => quote.source_id === source.source_id && quote.block_id === piece.block_id
        && quote.start >= piece.start && quote.end <= piece.end).sort((a, b) => a.start - b.start)) {
        if (quote.start > end) return false;
        end = Math.max(end, quote.end);
      }
      return end === piece.end;
    })).map(piece => piece.block_id);
    return { id: input.id, name: input.name, candidate_ids: matches.map(row => row.id),
      status: matches.length === 0 ? 'pending' as const : matches.length === 1 && !missing.length ? 'candidate' as const : 'conflict' as const,
      block_ids: [...new Set(input.source.map(piece => piece.block_id))], missing_body_blocks: missing };
  });
}

export function splitDeliveryIssues(handoff: LotSplitHandoff, source: SourceLedger, delivery: AcceptanceDelivery): AcceptanceIssue[] {
  const mapped = mapSplitCandidates(handoff, source, delivery), issues: AcceptanceIssue[] = [];
  for (const row of mapped.filter(row => row.status !== 'candidate')) issues.push({ code: 'split_lot_pending', path: `/lot_split/${row.id}`,
    message: `已拆分批 ${row.name} 尚无唯一完整候选；实际 ${row.candidate_ids.length} 个候选、${row.missing_body_blocks.length} 个主体块未覆盖。`,
    affected_lot_ids: row.candidate_ids, actual: row });
  const assigned = new Map<string, string[]>();
  const inputs = new Map(lotSplitInputs(handoff).map(input => [input.id, input]));
  for (const row of mapped) for (const id of row.candidate_ids) assigned.set(id, [...(assigned.get(id) ?? []), row.id]);
  for (const row of mapped.filter(row => row.status === 'candidate')) {
    const input = inputs.get(row.id)!, lot = delivery.lots.find(lot => lot.id === row.candidate_ids[0])!;
    const allowed = new Set([...input.source, ...input.shared.flatMap(row => row.source)].map(piece => piece.block_id));
    const missing = row.block_ids.filter(id => !lot.scope.block_ids.includes(id));
    const outside = lot.scope.block_ids.filter(id => !allowed.has(id));
    if (missing.length || outside.length) issues.push({ code: 'split_lot_scope_mismatch', path: `/lots/${lot.id}/scope`,
      actual: { split_id: row.id, missing_block_ids: missing, outside_block_ids: outside }, affected_lot_ids: [lot.id],
      message: '逐批来源必须保留已确认的标题、正文、表尾范围，不能跨入其他批；读取 read_acceptance_lot_input 后由作者修订 scope/dispositions 及受影响证据，旧历史与冻结原文不可写。' });
  }
  for (const lot of delivery.lots) if (assigned.get(lot.id)?.length !== 1) issues.push({ code: 'split_lot_boundary_mismatch', path: `/lots/${lot.id}/scope`,
    message: `候选须对应一个已拆分业务对象；实际关联 ${assigned.get(lot.id)?.length ?? 0} 批。按冻结逐批输入修订候选，保留历史记录。`, affected_lot_ids: [lot.id], actual: assigned.get(lot.id) ?? [] });
  return issues;
}

/** Settle the agent's source plan before paying for reviews that later context would invalidate. */
export function splitReviewReadinessIssues(handoff: LotSplitHandoff, source: SourceLedger, delivery: AcceptanceDelivery): AcceptanceIssue[] {
  const mapped = mapSplitCandidates(handoff, source, delivery), issues: AcceptanceIssue[] = [];
  const candidates = new Map(mapped.map(row => [row.id, row.candidate_ids]));
  const dispositions = new Map<string, AcceptanceDelivery['dispositions']>();
  for (const row of delivery.dispositions.filter(row => row.source_id === source.source_id))
    dispositions.set(row.block_id, [...(dispositions.get(row.block_id) ?? []), row]);
  const pending = (id: string) => {
    const rows = dispositions.get(id) ?? [];
    return rows.length !== 1 || rows[0]!.role === 'unresolved';
  };
  for (const context of handoff.decisions.filter(row => row.kind === 'shared')) {
    const affected = [...new Set(context.related_lot_ids.flatMap(id => candidates.get(id) ?? []))];
    const missing = [...new Set(context.source.filter(piece => pending(piece.block_id)).map(piece => piece.block_id))];
    if (!affected.length || !missing.length) continue;
    issues.push({ code: 'split_shared_context_pending', path: `/lot_split/${context.id}/source_plan`, affected_lot_ids: affected,
      actual: { split_context_id: context.id, pending_block_count: missing.length, block_ids: missing.slice(0, 16), related_split_lot_ids: context.related_lot_ids },
      message: `已确认的共同上下文还有 ${missing.length} 块未完成唯一归属，先落实后再送审相关批。通过 read_acceptance_lot_input 读取该批 shared 范围，在作者 DELIVERY.json 的 dispositions 中按实际适用性填写归属、理由和原文证据；不自动把共同范围变成项目，不修改原文、回执或历史计数。` });
  }
  // Earlier local experiments remain available while other independent lots are still being extracted.
  // Once every planned lot exists, finish source planning before the final wave of reviews/reviews reused after changes.
  if (mapped.length && mapped.every(row => row.status === 'candidate')) {
    const missing = source.blocks.filter(block => pending(block.id));
    if (missing.length) issues.push({ code: 'split_source_plan_pending', path: '/lot_split/source_plan',
      affected_lot_ids: [...new Set(mapped.flatMap(row => row.candidate_ids))],
      actual: { candidate_lot_count: mapped.length, total_source_blocks: source.blocks.length, pending_block_count: missing.length, block_ids: missing.slice(0, 16).map(block => block.id) },
      message: `已拆分的 ${mapped.length} 个业务批均有候选，但还剩 ${missing.length} 块原文归属未完成。先复用已确认拆分计划按范围处理 shared、non_lot 和实际异常，在作者 DELIVERY.json 的 dispositions 中补齐唯一归属、理由与证据；用 survey_acceptance_source 定位未处置范围，必要时 read_acceptance_source_block 核对，不逐批重审后再补共同依赖。只在实际问题已解决后更新 problems；检查点、旧回执与计数不可写。` });
  }
  return issues;
}

export async function installLotSplitHandoff(root: string, handoff: LotSplitHandoff, source: SourceLedger) {
  validateLotSplitHandoff(handoff, source);
  const directory = join(root, 'lot-split'), hash = sha256Json(handoff);
  await mkdir(directory, { recursive: true });
  const text = JSON.stringify(handoff);
  const file = join(directory, `${hash}.json`);
  await writeFile(file, text, { flag: 'wx' }).catch(async error => {
    if (error.code !== 'EEXIST' || await readFile(file, 'utf8') !== text) throw error;
  });
  const registration = JSON.stringify({ schema_version: 'acceptance-lot-split-registration/v1', sha256: hash });
  const pointer = join(directory, 'accepted.json');
  await writeFile(pointer, registration, { flag: 'wx' }).catch(async error => {
    if (error.code !== 'EEXIST') throw error;
    if (await readFile(pointer, 'utf8') === registration) return;
    const previous = await readLotSplitHandoff(root, source);
    if (!previous || !handoff.supersedes_sha256) throw new Error('A different split is already registered; preserve the current checkpoint and both versions.');
    assertSplitRefinement(previous, handoff);
    const checkpointText = await readFile(join(root, 'checkpoint.json'), 'utf8').catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
    const checkpoint = checkpointText ? JSON.parse(checkpointText) : undefined;
    if (checkpoint?.approvals?.length || checkpoint?.publications?.length)
      throw new Error('Split refinement cannot replace inputs that already have approvals/publications; preserve the current result.');
    await atomicWriteJson(pointer, JSON.parse(registration));
  });
  return { sha256: hash, path: file };
}

export async function readLotSplitHandoff(root: string, source: SourceLedger): Promise<LotSplitHandoff | undefined> {
  const text = await readFile(join(root, 'lot-split', 'accepted.json'), 'utf8').catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
  if (!text) return undefined;
  const registration = JSON.parse(text);
  if (registration.schema_version !== 'acceptance-lot-split-registration/v1' || !/^[a-f0-9]{64}$/u.test(registration.sha256)) throw new Error('Invalid split registration.');
  const handoff = JSON.parse(await readFile(join(root, 'lot-split', `${registration.sha256}.json`), 'utf8')) as LotSplitHandoff;
  if (sha256Json(handoff) !== registration.sha256) throw new Error('Registered split handoff changed.');
  validateLotSplitHandoff(handoff, source);
  return handoff;
}
