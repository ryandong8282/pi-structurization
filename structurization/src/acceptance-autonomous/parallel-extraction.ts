import { readFile, mkdir, copyFile, realpath } from 'node:fs/promises';
import { join, dirname, relative, isAbsolute, resolve } from 'node:path';
import { atomicWriteJson } from '../atomic.js';
import { sha256Json, sha256Text } from '../canonical.js';
import { strictJsonParse } from '../strict-json.js';
import { parseAcceptanceDelivery } from './schema.js';
import { verifySourceQuote } from './source-ledger.js';
import { subtaskBudgetRequests } from './tool-accounting.js';
import type { AcceptanceCheckpoint, AcceptanceDelivery, AcceptanceExtractor, ExtractionTask, ExtractionTaskInput, SourceLedger, SourceQuote } from './contracts.js';

/** Bounded real overlap; an abort stops admission and waits for in-flight workers to settle. */
export async function parallelMap<T, R>(rows: T[], concurrency: number, run: (row: T) => Promise<R>, signal?: AbortSignal,
  onActivity?: (counts: { queued: number; running: number }) => Promise<void>): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = [];
  let cursor = 0;
  let running = 0;
  const report = () => onActivity?.({ queued: rows.length - cursor, running }) ?? Promise.resolve();
  await report();
  await Promise.all(Array.from({ length: Math.min(rows.length, Math.max(1, concurrency)) }, async () => {
    while (cursor < rows.length) {
      const index = cursor++;
      running++; await report();
      try { signal?.throwIfAborted(); results[index] = { status: 'fulfilled', value: await run(rows[index]!) }; }
      catch (reason) { results[index] = { status: 'rejected', reason }; }
      finally { running--; await report(); }
    }
  }));
  return results;
}

export async function localFile(root: string, name: string): Promise<string> {
  const target = resolve(root, name), rel = relative(root, target);
  if (!rel || isAbsolute(name) || name.split(/[\\/]/u).includes('..') || rel.startsWith('..') || isAbsolute(rel) || /^(?:source|DELIVERY\.schema\.json|request\.json)(?:[\\/]|$)/u.test(rel)) throw new Error(`Worker output path is not writable: ${name}`);
  const path = await realpath(target);
  const escaped = relative(await realpath(root), path);
  if (escaped.startsWith('..') || isAbsolute(escaped)) throw new Error(`Worker path escapes its isolated directory: ${name}`);
  return path;
}

async function preserveCopy(source: string, target: string): Promise<void> {
  const bytes = await readFile(source), old = await readFile(target).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
  if (old && !old.equals(bytes)) throw new Error('Previously staged method differs; preserve both versions instead of overwriting.');
  if (!old) await copyFile(source, target);
}

function parsed(text: string): AcceptanceDelivery {
  const result = parseAcceptanceDelivery(strictJsonParse(text));
  if (!result.delivery) throw new Error(`Extraction fragment schema invalid: ${JSON.stringify(result.issues.slice(0, 3))}`);
  return result.delivery;
}

export interface FragmentEvidenceIssue {
  path: string;
  actual: { source_id: string; source_id_length: number; source_id_sha256: string; block_id: string; block_id_length: number; block_id_sha256: string;
    start: number; end: number; text_length: number; text_preview: string; text_sha256: string; full_quote_path: string };
  expected: { offset_basis: 'block.text'; offset_unit: 'UTF-16'; start_min: 0; end_max: number | null; exact_slice_match: true;
    frozen_slice?: { text_preview: string; text_length: number; text_sha256: string } };
  source_location: { source_id: string; block_id: string; start_line?: number; end_line?: number; source_count: number;
    source_ids_preview: string[]; source_index_path: string };
}

export class FragmentEvidenceError extends Error {
  readonly code = 'fragment_evidence_invalid';
  constructor(readonly issues: FragmentEvidenceIssue[]) {
    super('Fragment evidence does not match frozen source coordinates.');
    this.name = 'FragmentEvidenceError';
  }
}

export interface FragmentStructureIssue {
  path: string;
  actual: { preview: string; sha256: string; full_value_path: string };
  expected: string;
}
export class FragmentStructureError extends Error {
  readonly code = 'fragment_structure_invalid';
  constructor(readonly issues: FragmentStructureIssue[], message: string) { super(message); this.name = 'FragmentStructureError'; }
}
function invalidStructure(path: string, value: unknown, expected: string, message: string): never {
  const text = JSON.stringify(value) ?? String(value);
  throw new FragmentStructureError([{ path, actual: { preview: text.slice(0, 480), sha256: sha256Text(text),
    full_value_path: `fragment.json#${path}` }, expected }], message);
}

/** Uses the same exact frozen-quote predicate at submission and at final admission. */
export function assertFragmentEvidence(fragment: AcceptanceDelivery, sources: readonly SourceLedger[]): void {
  const issues: FragmentEvidenceIssue[] = [];
  const inspect = (value: unknown, path = ''): void => {
    if (Array.isArray(value)) { value.forEach((row, index) => inspect(row, `${path}/${index}`)); return; }
    if (!value || typeof value !== 'object') return;
    const row = value as Record<string, unknown>;
    if ('source_id' in row && 'block_id' in row && 'start' in row && 'end' in row && 'text' in row
      && !verifySourceQuote(sources, row as unknown as SourceQuote)) {
      const quote = row as unknown as SourceQuote;
      const block = sources.find(source => source.source_id === quote.source_id)?.blocks.find(block => block.id === quote.block_id);
      const frozenSlice = block && Number.isInteger(quote.start) && Number.isInteger(quote.end)
        && quote.start >= 0 && quote.start < quote.end && quote.end <= block.text.length ? block.text.slice(quote.start, quote.end) : undefined;
      issues.push({ path, actual: { source_id: quote.source_id.slice(0, 160), source_id_length: quote.source_id.length, source_id_sha256: sha256Text(quote.source_id),
        block_id: quote.block_id.slice(0, 160), block_id_length: quote.block_id.length, block_id_sha256: sha256Text(quote.block_id), start: quote.start, end: quote.end,
        text_length: quote.text.length, text_preview: quote.text.slice(0, 160), text_sha256: sha256Text(quote.text), full_quote_path: `fragment.json#${path}` },
        expected: { offset_basis: 'block.text', offset_unit: 'UTF-16', start_min: 0, end_max: block?.text.length ?? null, exact_slice_match: true,
          ...(frozenSlice === undefined ? {} : { frozen_slice: { text_preview: frozenSlice.slice(0, 320), text_length: frozenSlice.length, text_sha256: sha256Text(frozenSlice) } }) },
        source_location: { source_id: quote.source_id.slice(0, 160), block_id: quote.block_id.slice(0, 160), ...(block ? { start_line: block.start_line, end_line: block.end_line } : {}),
          source_count: sources.length, source_ids_preview: sources.slice(0, 8).map(source => source.source_id), source_index_path: 'request.json#/source_index' } });
    }
    Object.entries(row).forEach(([key, item]) => inspect(item, `${path}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`));
  };
  inspect(fragment);
  if (issues.length) throw new FragmentEvidenceError(issues);
}

export function fragmentEvidenceFeedback(error: FragmentEvidenceError, nextTool = 'submit_acceptance_fragment') {
  return { error: error.code, semantic_approval: false, total_issues: error.issues.length, issues: error.issues.slice(0, 4),
    expected: 'SourceQuote.start/end 是对应 block.text 内的 UTF-16 字符偏移；0 <= start < end <= block.text.length，且 block.text.slice(start,end) 必须逐字等于 text。SourceBlock.start/end 是全篇位置，不能复制到 SourceQuote。',
    writable: nextTool === 'parallel_acceptance_extract'
      ? '由原隔离子会话修订其 fragment.json 中标出的证据字段；主会话保持任务范围和方法文件版本重试，继续原请求用量和会话。'
      : 'fragment.json 中 issues[].path 指向的 source_id / block_id / start / end / text；保留其他有效字段和发现。',
    next_tool: nextTool, next_tool_arguments: {},
    how_to_pass: '按 request.json 的 source_index 读取冻结 ledger 中对应 block.text，再修正证据并重新提交。expected.frozen_slice 是当前坐标对应的原文预览，最多320字符；保留原始HTML实体等文字，不能以渲染后的文字代替。宿主不自动重写坐标或正文；修正后仍须通过范围、依赖和独立审查。',
    do_not_edit: ['source/', 'request.json', 'DELIVERY.schema.json', 'host checkpoints', 'historical usage', 'sealed outputs'] };
}

export function fragmentAdmissionFeedback(error: FragmentEvidenceError | FragmentStructureError, nextTool = 'submit_acceptance_fragment') {
  if (error instanceof FragmentEvidenceError) return fragmentEvidenceFeedback(error, nextTool);
  return { error: error.code, semantic_approval: false, total_issues: error.issues.length, issues: error.issues.slice(0, 4),
    expected: '隔离片段必须自洽：只声明分派范围内的新业务对象、对应新组及依赖；复用方法不等于可以引用或修改主草稿中既有组。',
    writable: '仅修订 fragment.json 中标出的字段及其对应新组/依赖；保留其他有效字段。任务范围和主草稿归属由主会话处理。',
    next_tool: nextTool, next_tool_arguments: {},
    how_to_pass: '按 issues[].path、actual 和 expected 修正片段后重新提交。完整业务边界不能在本任务范围内成立时，保留 unresolved 和具体问题，不能虚构业务组或越界；宿主仍会重新检查，语义批准另行进行。',
    do_not_edit: ['source/', 'request.json', 'DELIVERY.schema.json', 'host checkpoints', 'historical usage', 'sealed outputs'] };
}

/** This merges proposals only. Normal validation, reference resolution and independent reviews still gate publication. */
function assertSplitTask(task: ExtractionTask, source: SourceLedger) {
  if (!task.split_input) return;
  const pieces = task.split_input.source;
  if (pieces.length !== task.block_ids.length || new Set(pieces.map(row => row.block_id)).size !== task.block_ids.length
    || pieces.some(row => row.source_id !== source.source_id || !task.block_ids.includes(row.block_id) || row.start !== 0
      || row.end !== source.blocks.find(block => block.id === row.block_id)?.text.length || !verifySourceQuote([source], row)))
    throw new Error('Trusted split task must contain the exact complete assigned source blocks.');
}

function blocksAdmission(role: string, task: ExtractionTask) {
  return role !== 'unresolved' && !(task.split_input && role === 'not_extractable');
}

export function mergeExtractionFragment(base: AcceptanceDelivery, fragment: AcceptanceDelivery, task: ExtractionTask, sources: SourceLedger[]): AcceptanceDelivery {
  if (fragment.source_sha256 !== base.source_sha256) invalidStructure('/source_sha256', fragment.source_sha256,
    `source_sha256 必须等于冻结原文版本 ${base.source_sha256}。`, 'Extraction fragment source version differs.');
  const owned = new Set(task.block_ids), root = sources.find(row => row.source_id === base.source_sha256)!;
  assertSplitTask(task, root);
  if (task.split_input && (fragment.lots.length !== 1 || task.block_ids.some(id => !fragment.lots[0]!.scope.block_ids.includes(id))))
    invalidStructure('/lots', fragment.lots.map(lot => ({ id: lot.id, scope: lot.scope })),
      '本输入已经确认业务边界；恰好输出一个检验批，scope.block_ids 保留该批所有标题、正文和表尾块。字段异常写 problems，不可缩减来源范围或另造批边界。', 'Split lot must retain its complete frozen ownership.');
  const lots = new Set(fragment.lots.map(row => row.id));
  for (const collection of ['rules', 'groups', 'lots', 'references', 'problems'] as const) {
    const ids = fragment[collection].map(row => row.id);
    const existing = new Set(base[collection].map(row => row.id)), seen = new Set<string>();
    const conflict = ids.findIndex(id => { const duplicate = seen.has(id) || existing.has(id); seen.add(id); return duplicate; });
    if (conflict !== -1) invalidStructure(`/${collection}/${conflict}/id`, ids[conflict],
      `${collection}[].id 必须在片段内唯一且不覆盖主草稿；使用本单元 ${task.id}- 前缀并同步片段内依赖。`, `Extraction id collision in ${collection}; use task-specific ids.`);
  }
  if (fragment.dispositions.length !== owned.size || new Set(fragment.dispositions.map(row => row.block_id)).size !== owned.size
    || fragment.dispositions.some(row => row.source_id !== root.source_id || !owned.has(row.block_id) || row.lot_ids.some(id => !lots.has(id)))) invalidStructure('/dispositions', fragment.dispositions,
      `dispositions 必须恰好覆盖 request.json#/task/block_ids 的 ${owned.size} 个根文档块，source_id=${root.source_id}，每块一次，lot_ids 只能来自 fragment.lots[].id；歧义保留 unresolved。`, 'Fragment must dispose exactly its assigned root blocks and own lots.');
  for (const [index, lot] of fragment.lots.entries()) {
    const itemIds = new Set<string>();
    for (const [itemIndex, item] of lot.items.entries()) {
      if (itemIds.has(item.id)) invalidStructure(`/lots/${index}/items/${itemIndex}/id`, item.id,
        '同一检验批 items[].id 必须唯一；为冲突项选择新的稳定 ID，保留条目原文和证据。不同检验批可以使用相同条目 ID。', 'Fragment item id collision within its lot.');
      itemIds.add(item.id);
    }
    if (!lot.scope.block_ids.length || lot.scope.block_ids.some(id => !owned.has(id))) invalidStructure(`/lots/${index}/scope/block_ids`, lot.scope.block_ids,
      'scope.block_ids 必须非空且全部属于 request.json#/task/block_ids；不能拆分范围外对象或改写既有检验批。', 'A worker cannot split ownership across tasks or alter an existing business lot.');
    const groupIndex = fragment.groups.findIndex(group => group.id === lot.group_id);
    if (groupIndex === -1) invalidStructure(`/lots/${index}/group_id`, lot.group_id,
      'fragment.groups 必须声明与本 lot.group_id 对应的新组，且该组 lot_ids 含当前 lot.id；不能直接引用主草稿既有组。仅复用方法，不凭执行分片虚构业务结构；无法自洽时保留 unresolved 和具体问题。', 'Fragment lot group is not declared in fragment.groups.');
    if (!fragment.groups[groupIndex]!.lot_ids.includes(lot.id)) invalidStructure(`/groups/${groupIndex}/lot_ids`, fragment.groups[groupIndex]!.lot_ids,
      `与 fragment.lots[${index}].id 对应的新检验批必须列入该组 lot_ids。`, 'Fragment group does not include its own lot.');
  }
  for (const [index, group] of fragment.groups.entries()) if (group.lot_ids.some(id => !lots.has(id))) invalidStructure(`/groups/${index}/lot_ids`, group.lot_ids,
    '组内 lot_ids 只能来自 fragment.lots[].id；不修改其他工作单元或主草稿检验批。', 'Fragment dependencies escape assigned business objects.');
  for (const [index, ref] of fragment.references.entries()) {
    if (!owned.has(ref.origin.block_id)) invalidStructure(`/references/${index}/origin/block_id`, ref.origin.block_id,
      '引用的原文起点必须属于 request.json#/task/block_ids；相邻内容可只读，不并入所有权。', 'Fragment dependencies escape assigned business objects.');
    if (ref.dependent_lot_ids.some(id => !lots.has(id))) invalidStructure(`/references/${index}/dependent_lot_ids`, ref.dependent_lot_ids,
      'dependent_lot_ids 只能来自 fragment.lots[].id。', 'Fragment dependencies escape assigned business objects.');
  }
  for (const [index, problem] of fragment.problems.entries()) {
    if (problem.block_ids.some(id => !owned.has(id))) invalidStructure(`/problems/${index}/block_ids`, problem.block_ids,
      '问题定位必须属于 request.json#/task/block_ids；范围外上下文保持只读。', 'Fragment dependencies escape assigned business objects.');
    if (problem.affected_lot_ids.some(id => !lots.has(id))) invalidStructure(`/problems/${index}/affected_lot_ids`, problem.affected_lot_ids,
      'affected_lot_ids 只能来自 fragment.lots[].id。', 'Fragment dependencies escape assigned business objects.');
  }
  assertFragmentEvidence(fragment, sources);
  if (base.lots.some(lot => lot.scope.block_ids.some(id => owned.has(id)))
    || base.dispositions.some(row => row.source_id === root.source_id && owned.has(row.block_id) && blocksAdmission(row.role, task))) throw new Error('Assigned source blocks already have business ownership; keep existing checkpoint.');
  return { ...base, rules: [...base.rules, ...fragment.rules], groups: [...base.groups, ...fragment.groups], lots: [...base.lots, ...fragment.lots],
    references: [...base.references, ...fragment.references], problems: [...base.problems, ...fragment.problems],
    dispositions: [...base.dispositions.filter(row => row.source_id !== root.source_id || !owned.has(row.block_id)), ...fragment.dispositions] };
}

export async function runParallelExtraction(host: {
  root: string; workRoot: string; sources: SourceLedger[]; checkpoint: AcceptanceCheckpoint;
  extractor: AcceptanceExtractor; sourceIndex: ExtractionTaskInput['source_index'];
  save: () => Promise<void>; assertSources: () => Promise<void>; account: (id: string) => Promise<void>;
  event: (type: string, payload: unknown) => Promise<void>;
  activity?: (counts: { queued: number; running: number }) => Promise<void>;
}, path: string, tasks: ExtractionTask[], signal?: AbortSignal) {
  if (!Array.isArray(tasks) || !tasks.length || tasks.length > 64 || tasks.some(task => !/^[a-zA-Z0-9_-]{1,64}$/u.test(task.id)
    || !task.instruction?.trim() || !Array.isArray(task.method_files) || !task.block_ids?.length)) throw new Error('Provide 1–64 named extraction tasks with disjoint complete business ranges, instructions and method_files.');
  const source = host.sources.find(row => row.source_id === host.checkpoint.source_sha256)!;
  const owned = tasks.flatMap(task => task.block_ids);
  if (new Set(tasks.map(task => task.id)).size !== tasks.length || new Set(owned).size !== owned.length
    || owned.some(id => !source.blocks.some(block => block.id === id))) throw new Error('Extraction tasks must have unique ids and non-overlapping existing root block ids.');
  const before = await readFile(path, 'utf8'), base = parsed(before);
  const methods = new Map<string, string>();
  for (const name of new Set(tasks.flatMap(task => task.method_files))) methods.set(name, await readFile(await localFile(host.workRoot, name), 'utf8'));
  const outcomes = await parallelMap(tasks, host.checkpoint.budget.concurrency, async task => {
    assertSplitTask(task, source);
    const fingerprint = sha256Json({ task, source: source.sha256, methods: task.method_files.map(name => [name, sha256Text(methods.get(name)!)]) });
    const id = `extract:${fingerprint.slice(0, 24)}`;
    let request = host.checkpoint.requests.find(row => row.id === id);
    if (request?.extraction?.merged) return { task_id: task.id, request_id: id, reused: true, merged: true };
    if (request?.extraction?.merge_proposal_sha256) {
      const proposalText = await readFile(join(host.root, 'extraction-sessions', id.replace(':', '_'), 'merge.json'), 'utf8');
      if (sha256Text(proposalText) !== request.extraction.merge_proposal_sha256) throw new Error('Extraction merge journal changed; restore host-owned journal, never reset usage.');
      const proposal = JSON.parse(proposalText) as { fragment: AcceptanceDelivery; files: Record<string, string> };
      const fragment = proposal.fragment;
      const subset: AcceptanceDelivery = { ...base, ...Object.fromEntries((['rules', 'groups', 'lots', 'references', 'problems'] as const)
        .map(key => [key, base[key].filter(row => fragment[key].some(item => item.id === row.id))])),
        dispositions: base.dispositions.filter(row => row.source_id === source.source_id && task.block_ids.includes(row.block_id)) };
      if (sha256Json(subset) === sha256Json(fragment)) {
        for (const [name, hash] of Object.entries(proposal.files)) if (sha256Text(await readFile(await localFile(host.workRoot, name), 'utf8')) !== hash) throw new Error('Merged method changed before recovery; no overwrite.');
        request.extraction.merged = true; request.status = 'passed'; await host.save();
        await host.event('extraction_merge_recovered', { request_id: id, counters_reset: false });
        return { task_id: task.id, request_id: id, reused: true, merged: true };
      }
    }
    // Validate ownership before spending any worker budget.
    const blocked = task.block_ids.flatMap(id => {
      const dispositions = base.dispositions.filter(row => row.source_id === source.source_id && row.block_id === id && blocksAdmission(row.role, task));
      const owners = base.lots.filter(lot => lot.scope.block_ids.includes(id)).map(lot => lot.id);
      return dispositions.length || owners.length ? [{ block_id: id, kind: source.blocks.find(block => block.id === id)!.kind,
        roles: dispositions.map(row => row.role), owner_lot_ids: owners }] : [];
    });
    if (blocked.length) return { task_id: task.id, ok: false, error: 'extraction_scope_already_processed',
      actual: { blocked_count: blocked.length, blocked_blocks: blocked.slice(0, 12) },
      expected: 'tasks[].block_ids 只分配 role=unresolved 或尚未处置、且没有既有检验批所有者的原文块。已经处置的标题、辅助文字等仍可作为只读相邻上下文，不必加入分派所有权。',
      writable: '本次 tasks[].block_ids / instruction / method_files；若原候选处置确有错误，由主作者按原文修订 DELIVERY.json，再验证。原文、检查点、历史计数、批准及封存结果不可写。',
      next_tool: 'parallel_acceptance_extract', checkpoint_preserved: true, worker_started: false,
      instruction: '依据上列实际 block_id 与 role 缩小所有权范围后重试；不要为通过分派而改写原文或删除有效的旧处置/业务批。未启动工作单元，不新增请求次数或其回条用量。' };
    if (!request) {
      request = { id, kind: 'extraction', fingerprint, source_ids: host.sources.map(row => row.source_id), lot_ids: [], dependency_ids: [],
        status: 'pending', attempts: 0, tool_response_bytes: 0, exposed_lots: [], extraction: { task_id: task.id, block_ids: task.block_ids } };
      host.checkpoint.requests.push(request);
    }
    const directory = join(host.root, 'extraction-sessions', id.replace(':', '_'), 'work');
    await mkdir(directory, { recursive: true });
    const artifactPath = join(directory, 'fragment.json');
    try {
      let text = await readFile(artifactPath, 'utf8').catch(() => '');
      if (request.status === 'failed' || !request.extraction?.artifact_sha256 || sha256Text(text) !== request.extraction.artifact_sha256) {
        const scopeAttempts = subtaskBudgetRequests(host.checkpoint.requests, request).reduce((sum, row) => sum + row.attempts, 0);
        if (scopeAttempts >= host.checkpoint.budget.max_attempts) throw new Error(`Extraction attempt limit reached: actual=${scopeAttempts}, max=${host.checkpoint.budget.max_attempts}; identical source scopes share the allowance, historical usage retained.`);
        await host.account(id);
        for (const name of task.method_files) {
          const target = resolve(directory, name);
          if (relative(directory, target).startsWith('..') || isAbsolute(relative(directory, target))) throw new Error('Method path escapes worker directory.');
          await mkdir(dirname(target), { recursive: true });
          await atomicWriteJson(join(directory, 'request.json'), { request_id: id, task });
          const existing = await readFile(target, 'utf8').catch(() => undefined);
          if (existing === undefined) await copyFile(await localFile(host.workRoot, name), target);
        }
        request.status = 'running'; request.attempts += 1; delete request.error;
        await host.save(); await host.event('extraction_started', { request_id: id, task_id: task.id, block_count: task.block_ids.length });
        await host.extractor({ request_id: id, directory, task, source_root: host.workRoot, source_index: host.sourceIndex,
          validate_fragment: fragment => { mergeExtractionFragment(base, fragment, task, host.sources); } }, signal);
        signal?.throwIfAborted();
        text = await readFile(artifactPath, 'utf8');
        const fragment = parsed(text);
        mergeExtractionFragment(base, fragment, task, host.sources);
        request.extraction!.artifact_sha256 = sha256Text(text);
        request.lot_ids = fragment.lots.map(lot => lot.id);
      }
      request.status = 'pending'; await host.save();
      return { task_id: task.id, request_id: id, directory, task, text };
    } catch (error) {
      request.status = signal?.aborted ? 'pending' : 'failed'; request.error = String(error); await host.save();
      await host.event('extraction_stopped', { request_id: id, status: request.status, error: request.error });
      throw error;
    }
  }, signal, host.activity);
  signal?.throwIfAborted();
  await host.assertSources();
  if (await readFile(path, 'utf8') !== before || (await Promise.all([...methods].map(async ([name, text]) => await readFile(await localFile(host.workRoot, name), 'utf8') === text))).some(ok => !ok)) throw new Error('Author draft or shared methods changed while workers ran; isolated fragments retained, no overwrite.');
  let merged = base;
  const results: Record<string, unknown>[] = [];
  for (let index = 0; index < outcomes.length; index++) {
    const outcome = outcomes[index]!;
    if (outcome.status === 'rejected') {
      results.push({ task_id: tasks[index]!.id, ok: false,
        ...(outcome.reason instanceof FragmentEvidenceError || outcome.reason instanceof FragmentStructureError ? { ...fragmentAdmissionFeedback(outcome.reason, 'parallel_acceptance_extract'),
          next_tool_arguments: { path: relative(host.workRoot, path).replaceAll('\\', '/'), tasks: [tasks[index]!] } } : { error: String(outcome.reason) }) });
      continue;
    }
    const row = outcome.value;
    if (!row.text || !row.request_id || !row.directory || !row.task) { results.push(row); continue; }
    const request = host.checkpoint.requests.find(request => request.id === row.request_id)!;
    try {
      const fragment = parsed(row.text!);
      const prefix = `parallel/${row.request_id.replace(':', '_')}`;
      for (const name of new Set(fragment.rules.flatMap(rule => rule.method_files))) {
        const original = await localFile(row.directory!, name), target = join(host.workRoot, prefix, name);
        await mkdir(dirname(target), { recursive: true });
        await preserveCopy(original, target);
      }
      // Copy declared methods together with explicitly supplied dependencies, preserving relative imports.
      for (const name of row.task!.method_files) {
        const target = join(host.workRoot, prefix, name); await mkdir(dirname(target), { recursive: true });
        await preserveCopy(await localFile(row.directory!, name), target);
      }
      fragment.rules.forEach(rule => { rule.method_files = rule.method_files.map(name => `${prefix}/${name}`); });
      const next = mergeExtractionFragment(merged, fragment, row.task!, host.sources);
      const files: Record<string, string> = {};
      for (const name of new Set([...fragment.rules.flatMap(rule => rule.method_files), ...row.task!.method_files.map(name => `${prefix}/${name}`)])) files[name] = sha256Text(await readFile(await localFile(host.workRoot, name), 'utf8'));
      const mergePath = join(host.root, 'extraction-sessions', row.request_id.replace(':', '_'), 'merge.json');
      await atomicWriteJson(mergePath, { fragment, files });
      request.extraction!.merge_proposal_sha256 = sha256Text(await readFile(mergePath, 'utf8')); await host.save();
      merged = next;
      await atomicWriteJson(path, merged);
      request.status = 'passed'; request.extraction!.merged = true;
      await host.save(); await host.event('extraction_merged', { request_id: request.id, lots: fragment.lots.length, items: fragment.lots.reduce((sum, lot) => sum + lot.items.length, 0), semantic_approval: false });
      results.push({ task_id: row.task!.id, request_id: request.id, ok: true, lots: fragment.lots.length, semantic_approval: false });
    } catch (error) {
      request.status = 'failed'; request.error = String(error); await host.save();
      results.push({ task_id: row.task!.id, ok: false,
        ...(error instanceof FragmentEvidenceError || error instanceof FragmentStructureError ? { ...fragmentAdmissionFeedback(error, 'parallel_acceptance_extract'),
          next_tool_arguments: { path: relative(host.workRoot, path).replaceAll('\\', '/'), tasks: [row.task!] } } : { error: request.error }) });
    }
  }
  return { ok: results.every(row => row.ok !== false), results, concurrency: host.checkpoint.budget.concurrency,
    instruction: '合并的是待审候选；继续原有 validate → trial → batch → holdout/full → seal。未完成/缺资料/边界不清的范围继续保留未决，不得据并发回执宣称发布。' };
}
