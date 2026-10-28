import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sha256Text } from '../canonical.js';
import type { GroupReviewRequest, AcceptanceCheckpoint } from './contracts.js';
import { TABLE_SWEEP_PROGRAM_CONTRACT } from './table-sweep.js';

/** Review requests and executable sweep requests are different protocols. */
export async function reviewMethodExecutionEvidence(
  controller: { state(): Pick<AcceptanceCheckpoint, 'table_sweeps'> }, request: GroupReviewRequest,
) {
  const trials = [];
  for (const entry of controller.state().table_sweeps ?? []) {
    if (entry.group_id !== request.group.id || entry.phase !== 'trial') continue;
    const text = await readFile(entry.path, 'utf8');
    if (sha256Text(text) !== entry.sha256) throw new Error('Method experiment receipt changed; retain the original evidence.');
    const saved = JSON.parse(text);
    const matching = Object.keys(request.sample_fingerprints ?? {}).filter(id => saved.trial_fingerprints?.[id] === request.sample_fingerprints![id]);
    if (!matching.length) continue;
    trials.push({ id: entry.id, verified_receipt_sha256: entry.sha256, sample_lot_ids: matching,
      methods: saved.methods, input_sha256: saved.input_sha256, output_sha256: saved.output_sha256,
      execution_scope: saved.execution_scope ?? 'whole_sample_items/legacy', preserved_item_count: saved.preserved_item_count ?? 0,
      request_shape: { phase: 'trial', group_id: request.group.id, source_ledger: `source/${saved.plan.source_id}.json`,
        input: 'DELIVERY.input.json', output: 'DELIVERY.output.json', outcomes: 'sweep.results.json', matches: saved.plan.matches },
      outcomes: saved.outcomes, semantic_approval: false });
  }
  return { context: 'This request is semantic review data, not the executable program input. The host runs programs in a separate directory with the sweep request contract below.',
    contract: TABLE_SWEEP_PROGRAM_CONTRACT, verified_trials: trials };
}

/** Review the exact method dependency, not just its author-supplied description. */
export async function freezeReviewMethods(
  controller: { authorPath(name: string): Promise<string> },
  request: Pick<GroupReviewRequest, 'rules'>,
  directory: string,
): Promise<Array<{ author_path: string; path: string; sha256: string }>> {
  const names = [...new Set(request.rules.flatMap(rule => rule.method_files))].sort();
  if (names.length) await mkdir(join(directory, 'methods'), { recursive: true });
  return Promise.all(names.map(async name => {
    const text = await readFile(await controller.authorPath(name), 'utf8');
    const hash = sha256Text(text), path = join(directory, 'methods', `${sha256Text(name)}.txt`);
    const previous = await readFile(path, 'utf8').catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
    if (previous !== undefined && previous !== text) throw new Error('Review method snapshot differs for the same request; preserve it and submit the changed method as a new review.');
    if (previous === undefined) await writeFile(path, text, { encoding: 'utf8', flag: 'wx' });
    return { author_path: name, path: await realpath(path), sha256: hash };
  }));
}
