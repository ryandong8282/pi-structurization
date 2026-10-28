import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { cloneAcceptanceRevision } from '../src/acceptance-revision.js';
import { atomicWriteJson } from '../src/atomic.js';
import { sha256Json, sha256Text } from '../src/canonical.js';
import { EVIDENCE_SCHEMA_VERSION, EVIDENCE_SCOPE_SCHEMA_VERSION, SEMANTIC_EVIDENCE_SCHEMA_VERSION, type EvidenceManifest } from '../src/contracts.js';
import { buildGranularProseCoverageEvidence } from '../src/evidence.js';
import { validFixturePlan } from '../src/tools.js';
import { RevisionWorkspace } from '../src/workspace.js';

const roots: string[] = [];
const parent = resolve('.tmp-tests');
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (!resolve(root).startsWith(join(parent, 'acceptance-revision-'))) throw new Error('Unsafe test cleanup');
    await rm(root, { recursive: true, force: true });
  }
});

test('a dialogue revision preserves both old seals, carries selected records and retains preparation', async () => {
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'acceptance-revision-'));
  roots.push(root);
  const source = join(root, 'old', 'pi-agent'), destination = join(root, 'new', 'pi-agent');
  const markdown = '# 1 示例器件\n1.1.1 接口应符合设计要求。\n1.1.2 标识应清晰。';
  const jobId = 'revision-fixture';
  const targets = [];
  const before = new Map<string, string>();
  for (const [index, targetId] of ['target:interface', 'target:label'].entries()) {
    const records = buildGranularProseCoverageEvidence(markdown, sha256Text(markdown), [{ start_line: index + 2, end_exclusive_line: index + 3 }]);
    const payload = { schema_version: EVIDENCE_SCHEMA_VERSION, job_id: jobId, target_id: targetId,
      source: { adapter: 'document-domain-agent/v1' as const, file_name: 'example.md', sha256: sha256Text(markdown), semantic_workflow: SEMANTIC_EVIDENCE_SCHEMA_VERSION },
      scope: { schema_version: EVIDENCE_SCOPE_SCHEMA_VERSION, mode: 'agent_discovered' as const, target_id: targetId,
        source_line_count: 3, selected_start_line: index + 2, selected_end_exclusive_line: index + 3,
        selected_heading: '示例器件', selection_reason: 'synthetic scope', selected_atom_ids: records.map(row => row.evidence_id),
        target_evidence_fragments: records.map(row => ({ atom_id: row.evidence_id, text: row.text })), candidates: [] },
      evidence: records.map(record => ({ ...record, requires_disposition: true })), table_fragments: [], reference_occurrences: [],
    };
    const manifest: EvidenceManifest = { ...payload, evidence_fingerprint: sha256Json(payload) };
    const workspace = await RevisionWorkspace.createFromEvidence(source, jobId, targetId, { manifest, markdown: Buffer.from(markdown) });
    const selectors = JSON.parse(await readFile(workspace.workingSelectorPath, 'utf8'));
    await atomicWriteJson(workspace.sealedSelectorPath, selectors);
    await atomicWriteJson(workspace.sealedPlanPath, validFixturePlan(manifest));
    await workspace.updateState(state => { state.status = 'sealed'; state.target_review_protocol = 'direct-validation/v1'; });
    for (const file of [workspace.sealedSelectorPath, workspace.sealedPlanPath, workspace.evidenceManifestPath, workspace.sourceSpanRegistryPath]) before.set(file, sha256Text(await readFile(file, 'utf8')));
    targets.push({ target_id: targetId, name: targetId, status: 'sealed', revision: workspace.revision, workdir: workspace.root,
      attempts: 1, table_count: 1, row_count: 1, model: 'fixture', error: '', attempt_counters: { transport_attempts: 1, candidate_validation_attempts: 1, coverage_repair_attempts: 0 } });
  }
  const folder = join(source, 'jobs', jobId);
  await mkdir(join(folder, 'hierarchy'), { recursive: true });
  await writeFile(join(folder, 'hierarchy', 'old-seal.json'), 'old hierarchy', 'utf8');
  await atomicWriteJson(join(folder, 'batch.json'), { schema_version: 'acceptance-full-batch/v3', job_id: jobId, status: 'passed',
    source: { markdown_file: 'example.md', markdown_sha256: sha256Text(markdown) }, targets });
  await mkdir(destination, { recursive: true });
  await writeFile(join(destination, 'input.json'), '{"prepared":"new round"}', 'utf8');
  await cloneAcceptanceRevision(source, destination, jobId, ['target:interface']);
  const batch = JSON.parse(await readFile(join(destination, 'jobs', jobId, 'batch.json'), 'utf8'));
  expect(batch.targets[0]).toMatchObject({ status: 'pending', revision: 2 });
  expect(batch.targets[1]).toMatchObject({ status: 'sealed', revision: 1 });
  const carried = await RevisionWorkspace.openRevision(destination, jobId, 'target:interface', 2);
  expect(JSON.parse(await readFile(carried.workingSelectorPath, 'utf8'))).toEqual(JSON.parse(await readFile(targets[0]!.workdir + '/target-selectors.json', 'utf8')));
  expect((await carried.readState()).target_review_protocol).toBe('direct-validation/v1');
  expect(await readFile(join(destination, 'input.json'), 'utf8')).toBe('{"prepared":"new round"}');
  expect(batch.targets.every((target: { workdir: string }) => target.workdir.startsWith(destination))).toBe(true);
  for (const [file, digest] of before) expect(sha256Text(await readFile(file, 'utf8'))).toBe(digest);
  // Same interrupted round can finish idempotently, without creating another revision.
  await cloneAcceptanceRevision(source, destination, jobId, ['target:interface']);
  expect(JSON.parse(await readFile(join(destination, 'jobs', jobId, 'batch.json'), 'utf8')).targets[0].revision).toBe(2);
});
