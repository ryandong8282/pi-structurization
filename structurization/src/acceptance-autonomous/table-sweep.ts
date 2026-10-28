import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, symlink, realpath, copyFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { sha256Json, sha256Text } from '../canonical.js';
import { atomicWriteJson } from '../atomic.js';
import { strictJsonParse } from '../strict-json.js';
import { terminateProcessTree } from '../process-tree.js';
import type { AcceptanceDelivery, SourceBlock, SourceLedger } from './contracts.js';
import { sourceTextForDisplay } from './source-ledger.js';
import { parseAcceptanceDelivery } from './schema.js';
import { collectSweepArtifacts } from './sweep-artifacts.js';
import type { lotSplitInputs } from './lot-split-handoff.js';

function headerRows(block: SourceBlock): string[] {
  const normalize = (value: string) => sourceTextForDisplay(value).replace(/\s+/gu, '');
  if (/^\s*<table\b/iu.test(block.text)) {
    if ((block.text.match(/<table\b/giu) ?? []).length !== 1 || !/<\/table>/iu.test(block.text)) return [];
    return [...block.text.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/giu)].map(row => JSON.stringify(
      [...row[1]!.matchAll(/<(td|th)\b([^>]*)>([\s\S]*?)<\/\1>/giu)].map(cell => ({
        // A category label's vertical span follows the number of body rows. It is
        // not a column-layout discriminator; the author parser still reads the real spans.
        text: normalize(cell[3]!), colspan: Number(cell[2]!.match(/\bcolspan\s*=\s*["']?(\d+)/iu)?.[1] ?? 1),
      }))));
  }
  return block.text.split(/\r?\n/u).filter(line => line.trim().startsWith('|') && !/^\s*\|[\s:|-]+\|\s*$/u.test(line))
    .map(line => JSON.stringify(line.trim().replace(/^\||\|$/gu, '').split(/(?<!\\)\|/u)
      .map(cell => ({ text: normalize(cell), colspan: 1 }))));
}

/** Every physical table is considered; membership is derived from a frozen sample header, never a target-id list. */
export function planTableSweep(source: SourceLedger, sampleBlockId: string, headerRowIndex: number, delivery: AcceptanceDelivery) {
  const sample = source.blocks.find(block => block.id === sampleBlockId && block.kind === 'table');
  const signature = sample && headerRows(sample)[headerRowIndex];
  if (!signature || JSON.parse(signature).filter((cell: { text: string }) => cell.text).length < 2) {
    throw new Error('Provide an existing sample table and a zero-based header_row_index with at least two nonempty column labels; do not select a per-instance title/value row.');
  }
  const tables = source.blocks.filter(block => block.kind === 'table');
  const parsed = tables.map(block => ({ block, headers: headerRows(block) }));
  return { source_id: source.source_id, source_sha256: source.sha256, sample_block_id: sampleBlockId,
    header_match_policy: 'column-labels-and-widths/v2' as const,
    header_row_index: headerRowIndex, header_signature: signature, scanned_table_count: tables.length,
    unparsed_block_ids: parsed.filter(row => !row.headers.length).map(row => row.block.id),
    matches: parsed.filter(row => row.headers.includes(signature)).map(({ block }) => ({ block_id: block.id,
      start_line: block.start_line, end_line: block.end_line,
      existing_lot_ids: delivery.lots.filter(lot => lot.scope.block_ids.includes(block.id)).map(lot => lot.id) })) };
}

export interface TableSweepOutcome { block_id: string; status: 'processed' | 'exception'; lot_ids: string[]; reason: string }

export const TABLE_SWEEP_PROGRAM_CONTRACT = {
  invocation: 'node <program_file> request.json; cwd is an isolated work directory containing declared method_files only',
  request: { source_ledger: 'relative path of the frozen SourceLedger JSON', input: 'DELIVERY.input.json', output: 'DELIVERY.output.json', outcomes: 'sweep.results.json', matches: 'all automatically matched source tables; do not truncate or replace this list' },
  lot_inputs: 'When present, these are complete business lot ranges plus shared source. Preserve these business boundaries and existing IDs; do not invent one lot per table. A program may handle only its matching tables inside a mixed lot. Other prose/tables may be authored by the model or another method and remain pending until independently reviewed.',
  output: 'Complete AcceptanceDelivery matching DELIVERY.schema.json; preserve existing candidates and history',
  trial: 'When phase=trial, items whose evidence or referenced origin touches a matched source table are removed from the input. Regenerate those items from source; no matched answer rows are supplied. Other items in the same business lot are retained and must stay byte-equivalent as JSON. Do not replace the whole items array or shrink the business scope. Cross-source items touching a matched table must be regenerated in full. This proves only matched-table execution, not whole-lot coverage or semantic approval.',
  generated_dependencies: 'Write newly referenced rules[].method_files inside the isolated cwd; admitted files transfer before the draft. Existing differing author files are never overwritten.',
  outcomes: { type: 'array', fields: ['block_id', 'status', 'lot_ids', 'reason'],
    status: ['processed', 'exception'], lot_ids: 'array of candidate IDs (also required for exceptions)',
    coverage: 'One entry per request.matches block_id, exactly once; no enclosing object',
    processed: 'All owners must belong to the requested group and be recorded in lot dispositions',
    exception: 'Keep a concrete problem for the block or affected lots in DELIVERY.output.json; a reason alone is insufficient' },
} as const;

const EXECUTION_SCOPE = 'matched_table_items/v1';

function touchesTables(item: AcceptanceDelivery['lots'][number]['items'][number], delivery: AcceptanceDelivery,
  sourceId: string, blocks: Set<string>): boolean {
  const containsQuote = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.some(containsQuote);
    if (!value || typeof value !== 'object') return false;
    const row = value as Record<string, unknown>;
    return (row.source_id === sourceId && typeof row.block_id === 'string' && blocks.has(row.block_id))
      || Object.values(row).some(containsQuote);
  };
  return containsQuote(item) || delivery.references.some(reference => item.reference_ids.includes(reference.id) && containsQuote(reference.origin));
}

export class TableSweepOutputError extends Error {
  constructor(readonly feedback: Record<string, unknown>, cause: unknown) {
    super('sweep_output_contract_failed', { cause });
  }
}

function outcomeSummary(value: unknown, plan: ReturnType<typeof planTableSweep>) {
  if (!Array.isArray(value)) return { type: value === null ? 'null' : typeof value,
    ...(value && typeof value === 'object' ? { keys: Object.keys(value).slice(0, 12) } : {}), expected_count: plan.matches.length };
  const ids = value.map(row => row?.block_id), expected = new Set(plan.matches.map(row => row.block_id));
  const missing = [...expected].filter(id => !ids.includes(id));
  const unexpected = [...new Set(ids.filter(id => !expected.has(id)))];
  return { type: 'array', count: value.length, expected_count: expected.size, duplicate_count: ids.length - new Set(ids).size,
    missing_count: missing.length, missing_block_ids: missing.slice(0, 8), unexpected_count: unexpected.length,
    unexpected_block_ids: unexpected.slice(0, 8), invalid_rows: value.map((row, index) => ({ row, index }))
      .filter(({ row }) => !row || typeof row.block_id !== 'string' || !['processed', 'exception'].includes(row.status)
        || !Array.isArray(row.lot_ids) || row.lot_ids.some((id: unknown) => typeof id !== 'string') || typeof row.reason !== 'string' || !row.reason.trim())
      .slice(0, 8).map(({ row, index }) => ({ index, block_id: row?.block_id, keys: row && typeof row === 'object' ? Object.keys(row).slice(0, 12) : [] })) };
}

export function admitTableSweep(before: AcceptanceDelivery, after: AcceptanceDelivery, plan: ReturnType<typeof planTableSweep>, outcomes: TableSweepOutcome[], groupId: string) {
  if (after.source_sha256 !== before.source_sha256 || before.lots.some(lot => !after.lots.some(row => row.id === lot.id))) {
    throw new Error('Sweep cannot change the frozen source or remove existing candidates, including failed samples.');
  }
  if (!Array.isArray(outcomes) || outcomes.length !== plan.matches.length || new Set(outcomes.map(row => row.block_id)).size !== outcomes.length
    || plan.matches.some(match => !outcomes.some(row => row.block_id === match.block_id))) throw new Error('sweep.results.json must account for every matched source table exactly once; omitted tables are failures, not a smaller batch.');
  const matched = new Set(plan.matches.map(row => row.block_id));
  for (const lot of before.lots) {
    const updated = after.lots.find(row => row.id === lot.id)!;
    if (!lot.scope.block_ids.some(id => matched.has(id)) && sha256Json(lot) !== sha256Json(updated))
      throw new Error(`Sweep changed a candidate outside its matched source tables: ${lot.id}`);
    if (lot.scope.block_ids.some(id => !updated.scope.block_ids.includes(id)))
      throw new Error(`Sweep cannot shrink the existing business lot scope: ${lot.id}`);
    for (const item of lot.items) if (!touchesTables(item, before, plan.source_id, matched)
      && sha256Json(item) !== sha256Json(updated.items.find(row => row.id === item.id) ?? null))
      throw new Error(`Sweep changed or removed an item outside its matched tables: ${lot.id}/${item.id}. Preserve model-authored prose and other table types; regenerate only the matched-table items.`);
  }
  for (const row of outcomes) {
    if (!row.reason?.trim() || !Array.isArray(row.lot_ids)) throw new Error(`Sweep outcome requires lot_ids and an actual reason: ${row.block_id}`);
    if (row.status === 'processed') {
      const owners = after.lots.filter(lot => lot.scope.block_ids.includes(row.block_id));
      if (!owners.length || owners.some(lot => lot.group_id !== groupId || !row.lot_ids.includes(lot.id))
        || row.lot_ids.some(id => !owners.some(lot => lot.id === id))
        || !after.dispositions.some(disposition => disposition.source_id === plan.source_id && disposition.block_id === row.block_id
          && disposition.role === 'lot' && owners.every(lot => disposition.lot_ids.includes(lot.id)))) {
        throw new Error(`Processed table must have complete source ownership in the requested structure group: ${row.block_id}`);
      }
      if (owners.some(lot => !lot.items.some(item => touchesTables(item, after, plan.source_id, new Set([row.block_id])))))
        throw new Error(`Processed table has no reconstructed source-bound item: ${row.block_id}. Copying the preserved prose or other tables is not an executable table experiment.`);
    } else if (row.status !== 'exception' || !after.problems.some(problem => problem.block_ids.includes(row.block_id)
      || row.lot_ids.some(id => problem.affected_lot_ids.includes(id)))) {
      throw new Error(`An exceptional table must retain a concrete problem in DELIVERY.output.json: ${row.block_id}`);
    }
  }
}

async function localFile(root: string, name: string) {
  const file = await realpath(resolve(root, name)), rel = relative(await realpath(root), file);
  if (isAbsolute(rel) || rel === '..' || rel.startsWith('..\\') || rel.startsWith('../') || rel.split(/[\\/]/u)[0] === 'source') throw new Error('Sweep program/dependency must be an author file inside work/.');
  return file;
}

/** Runs deterministic author code once over the entire manifest, without starting an LLM worker. */
export async function executeTableSweep(options: { root: string; workRoot: string; sourceRoot: string; path: string;
  groupId: string; plan: ReturnType<typeof planTableSweep>; programFile: string; methodFiles: string[];
  assertSources: () => Promise<void>; signal?: AbortSignal; lotInputs?: ReturnType<typeof lotSplitInputs>; trialLotIds?: string[] }) {
  const beforeText = await readFile(options.path, 'utf8');
  const files: Record<string, string> = {};
  for (const name of new Set([options.programFile, ...options.methodFiles])) files[name] = await readFile(await localFile(options.workRoot, name), 'utf8');
  const hashes = Object.fromEntries(Object.entries(files).map(([name, text]) => [name, sha256Text(text)]));
  const id = `sweep:${sha256Json({ execution_scope: EXECUTION_SCOPE, plan: options.plan, group: options.groupId, files: hashes, input: sha256Text(beforeText), lot_inputs: options.lotInputs ?? null,
    ...(options.trialLotIds ? { phase: 'trial', trial_lot_ids: options.trialLotIds } : {}) }).slice(0, 24)}`;
  const directory = join(options.root, 'table-sweeps', id.replace(':', '_'), 'work');
  await mkdir(directory, { recursive: true });
  await mkdir(join(directory, 'tmp'), { recursive: true });
  const source = join(directory, 'source');
  const linked = await realpath(source).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
  if (linked && linked !== await realpath(options.sourceRoot)) throw new Error('Sweep frozen-source link changed.');
  if (!linked) await symlink(options.sourceRoot, source, process.platform === 'win32' ? 'junction' : 'dir');
  for (const [name, text] of Object.entries(files)) {
    const target = resolve(directory, name), rel = relative(directory, target);
    if (isAbsolute(rel) || rel === '..' || rel.startsWith('..\\') || rel.startsWith('../')) throw new Error('Sweep dependency path escapes its work directory.');
    await mkdir(dirname(target), { recursive: true }); await writeFile(target, text, 'utf8');
  }
  const programInput = JSON.parse(beforeText) as AcceptanceDelivery;
  const matched = new Set(options.plan.matches.map(row => row.block_id));
  const preservedItemCount = programInput.lots.filter(lot => lot.scope.block_ids.some(id => matched.has(id)))
    .reduce((count, lot) => count + lot.items.filter(item => !touchesTables(item, programInput, options.plan.source_id, matched)).length, 0);
  if (options.trialLotIds) for (const lot of programInput.lots) if (options.trialLotIds.includes(lot.id))
    lot.items = lot.items.filter(item => !touchesTables(item, programInput, options.plan.source_id, matched));
  const programInputText = options.trialLotIds ? JSON.stringify(programInput) : beforeText;
  await writeFile(join(directory, 'DELIVERY.input.json'), programInputText, 'utf8');
  await atomicWriteJson(join(directory, 'request.json'), { id, group_id: options.groupId, execution_scope: EXECUTION_SCOPE, preserved_item_count: preservedItemCount, ...options.plan,
    ...(options.trialLotIds ? { phase: 'trial', trial_lot_ids: options.trialLotIds } : { phase: 'batch' }),
    ...(options.lotInputs ? { lot_inputs: options.lotInputs } : {}), program_contract: TABLE_SWEEP_PROGRAM_CONTRACT,
    source_ledger: `source/${options.plan.source_id}.json`, input: 'DELIVERY.input.json', output: 'DELIVERY.output.json', outcomes: 'sweep.results.json' });
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(?:PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|LANG|LC_ALL|TERM)$/iu.test(key))),
    HOME: directory, USERPROFILE: directory, TMP: join(directory, 'tmp'), TEMP: join(directory, 'tmp') };
  const diagnostics = `diagnostics/${id.replace(':', '_')}-program.json`;
  await mkdir(join(options.workRoot, 'diagnostics'), { recursive: true });
  await new Promise<void>((done, reject) => {
    const child = spawn(process.execPath, [options.programFile, 'request.json'], { cwd: directory, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let stdoutBytes = 0, stderrBytes = 0;
    child.stdout.on('data', (chunk: Buffer) => { if (stdoutBytes < 32768) stdout.push(chunk.subarray(0, 32768 - stdoutBytes)); stdoutBytes += chunk.length; });
    child.stderr.on('data', (chunk: Buffer) => { if (stderrBytes < 32768) stderr.push(chunk.subarray(0, 32768 - stderrBytes)); stderrBytes += chunk.length; });
    let failure: Error | undefined;
    const stop = () => { failure = new Error(options.signal?.aborted ? 'Sweep normally paused; outputs preserved, no merge.' : 'Sweep program exceeded 60 seconds; no merge.');
      if (child.pid) void terminateProcessTree(child.pid).catch(reject); };
    const timer = setTimeout(stop, 60_000);
    options.signal?.addEventListener('abort', stop, { once: true });
    child.once('error', error => { clearTimeout(timer); options.signal?.removeEventListener('abort', stop); reject(error); });
    child.once('close', code => {
      clearTimeout(timer); options.signal?.removeEventListener('abort', stop);
      void atomicWriteJson(join(options.workRoot, diagnostics), { exit_code: code, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'),
        stdout_bytes: stdoutBytes, stderr_bytes: stderrBytes }).then(() => {
        if (failure) reject(failure); else if (code !== 0) reject(new Error(`Sweep program exited with ${code}; read ${diagnostics}, correct the author program/dependencies, then rerun. Isolated outputs and all history retained.`)); else done();
      }, reject);
    });
    if (options.signal?.aborted) stop();
  });
  options.signal?.throwIfAborted();
  await options.assertSources();
  if (await readFile(options.path, 'utf8') !== beforeText) throw new Error('Draft changed during sweep; no overwrite.');
  for (const [name, text] of Object.entries(files)) if (await readFile(await localFile(options.workRoot, name), 'utf8') !== text) throw new Error('Sweep method/configuration changed during execution; no overwrite.');
  let rawOutcomes: unknown;
  try {
    rawOutcomes = strictJsonParse(await readFile(join(directory, 'sweep.results.json'), 'utf8'));
    const outputText = await readFile(join(directory, 'DELIVERY.output.json'), 'utf8');
    const parsed = parseAcceptanceDelivery(strictJsonParse(outputText));
    if (!parsed.delivery) throw new Error(`Sweep output violates DELIVERY.schema.json: ${JSON.stringify(parsed.issues.slice(0, 3))}`);
    if (options.trialLotIds && parsed.delivery.lots.some(lot => !programInput.lots.some(old => old.id === lot.id)))
      throw new Error('A method trial cannot expand the candidate roster. Rebuild the selected sample items from source under their existing IDs; batch expansion follows a passing trial.');
    const outcomes = rawOutcomes as TableSweepOutcome[];
    admitTableSweep(strictJsonParse(beforeText) as AcceptanceDelivery, parsed.delivery, options.plan, outcomes, options.groupId);
    const artifacts = await collectSweepArtifacts(directory, strictJsonParse(beforeText) as AcceptanceDelivery, parsed.delivery);
    return { id, directory, delivery: parsed.delivery, outcomes, methods: hashes, artifacts, input_sha256: sha256Text(programInputText), outputText,
      execution_scope: EXECUTION_SCOPE, preserved_item_count: preservedItemCount };
  } catch (error) {
    // The isolated run is outside authorPath. Supply readable copies, not a path
    // the next read tool cannot access, and never merge malformed output.
    const prefix = `diagnostics/${id.replace(':', '_')}`;
    const outputFiles: Record<string, string> = {};
    for (const [key, name] of Object.entries({ request: 'request.json', delivery: 'DELIVERY.output.json', outcomes: 'sweep.results.json' })) {
      const target = `${prefix}-${name}`;
      try { await copyFile(join(directory, name), join(options.workRoot, target)); outputFiles[key] = target; }
      catch (copyError) { if ((copyError as NodeJS.ErrnoException).code !== 'ENOENT') throw copyError; }
    }
    const detailPath = `${prefix}-output-error.json`;
    const actual = { message: error instanceof Error ? error.message : String(error), outcomes: outcomeSummary(rawOutcomes, options.plan) };
    const feedback = { ok: false, error: 'sweep_output_contract_failed', actual, expected: TABLE_SWEEP_PROGRAM_CONTRACT,
      output_files: outputFiles, writable: `Repair author program ${options.programFile} and its declared dependencies, then rerun sweep_acceptance_tables; isolated copies/checkpoints/receipts are not writable inputs.`,
      next_tool: 'read', next_tool_arguments: { path: detailPath }, merged: false, counters_reset: false };
    await atomicWriteJson(join(options.workRoot, detailPath), feedback);
    throw new TableSweepOutputError(feedback, error);
  }
}
