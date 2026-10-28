import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { prettyJson, sha256Text } from '../canonical.js';
import type { AcceptanceDelivery } from './contracts.js';

type Artifacts = Record<string, { text: string; sha256: string }>;
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const inside = (root: string, path: string) => {
  const rel = relative(root, path);
  if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') || rel.split(/[\\/]/u)[0] === 'source')
    throw new Error(`Sweep dependency must remain in author work files: ${path}`);
};
async function authorFile(root: string, name: string) {
  const target = resolve(root, name), canonicalRoot = await realpath(root); inside(resolve(root), target);
  let ancestor = target;
  for (;;) {
    try { const canonical = await realpath(ancestor); if (canonical !== canonicalRoot) inside(canonicalRoot, canonical); break; }
    catch (error) { if (!missing(error) || dirname(ancestor) === ancestor) throw error; ancestor = dirname(ancestor); }
  }
  return target;
}

/** Only files newly referenced by the admitted output can cross the isolation boundary. */
export async function collectSweepArtifacts(directory: string, before: AcceptanceDelivery, after: AcceptanceDelivery): Promise<Artifacts> {
  const previous = new Set(before.rules.flatMap(rule => rule.method_files)), files: Artifacts = {};
  for (const name of new Set(after.rules.flatMap(rule => rule.method_files))) if (!previous.has(name)) {
    const text = await readFile(await authorFile(directory, name), 'utf8'); files[name] = { text, sha256: sha256Text(text) };
  }
  return files;
}

/** Preflight all destinations, then create missing files exclusively before writing the draft. */
export async function installSweepArtifacts(workRoot: string, artifacts: Artifacts) {
  const pending: Array<{ name: string; target: string; text: string }> = [];
  for (const [name, artifact] of Object.entries(artifacts)) {
    const target = await authorFile(workRoot, name);
    const existing = await readFile(target, 'utf8').catch(error => { if (missing(error)) return undefined; throw error; });
    if (existing !== undefined && sha256Text(existing) !== artifact.sha256)
      throw new Error(`Sweep artifact collision at ${name}; existing author file retained. Choose a new instance path in the program and rerun; do not overwrite existing methods.`);
    if (existing === undefined) pending.push({ name, target, text: artifact.text });
  }
  for (const file of pending) {
    await mkdir(dirname(file.target), { recursive: true }); await authorFile(workRoot, file.name);
    await writeFile(file.target, file.text, { flag: 'wx' }).catch(async error => {
      if (error.code !== 'EEXIST' || await readFile(file.target, 'utf8') !== file.text) throw error;
    });
  }
  return pending.map(file => file.name);
}

/** Repair a missing transfer from an already registered sweep, without touching its receipt or business draft. */
export async function recoverSweepArtifacts(root: string, workRoot: string,
  entries: Array<{ id: string; path: string; sha256: string }>, current: AcceptanceDelivery) {
  const required = new Set(current.rules.flatMap(rule => rule.method_files));
  const absent = new Set<string>();
  for (const name of required) {
    try { await readFile(await authorFile(workRoot, name)); } catch (error) { if (missing(error)) absent.add(name); else throw error; }
  }
  const restored: Array<{ id: string; files: string[]; audit: string }> = [];
  if (!absent.size) return restored;
  for (const entry of entries) {
    if (!/^sweep:[a-f0-9]{24}$/u.test(entry.id)) throw new Error('Invalid registered sweep identity; no artifact recovery.');
    const directory = join(root, 'table-sweeps', entry.id.replace(':', '_'));
    if (await realpath(entry.path) !== await realpath(join(directory, 'receipt.json'))) throw new Error('Registered sweep path changed.');
    const receiptText = await readFile(entry.path, 'utf8');
    if (sha256Text(receiptText) !== entry.sha256) throw new Error('Registered sweep receipt changed; no artifact recovery.');
    const receipt = JSON.parse(receiptText), isolated = join(directory, 'work');
    const beforeText = await readFile(join(isolated, 'DELIVERY.input.json'), 'utf8');
    const after: AcceptanceDelivery = JSON.parse(await readFile(join(isolated, 'DELIVERY.output.json'), 'utf8'));
    if (receipt.id !== entry.id || sha256Text(beforeText) !== receipt.input_sha256 || sha256Text(prettyJson(after)) !== receipt.output_sha256
      || after.source_sha256 !== current.source_sha256) throw new Error('Sweep input/output fingerprint changed; no artifact recovery.');
    const artifacts = await collectSweepArtifacts(isolated, JSON.parse(beforeText), after);
    const selected: Artifacts = {};
    for (const [name, artifact] of Object.entries(artifacts)) if (absent.has(name)) {
      if (receipt.generated_methods && receipt.generated_methods[name] !== artifact.sha256) throw new Error(`Frozen generated sweep dependency changed: ${name}`);
      selected[name] = artifact;
    }
    if (!Object.keys(selected).length) continue;
    const audit = join(directory, 'artifact-transfer.json');
    const record = { receipt_sha256: entry.sha256, generated_methods: Object.fromEntries(Object.entries(artifacts).map(([name, file]) => [name, file.sha256])),
      legacy_unhashed_artifacts: !receipt.generated_methods, semantic_approval: false, counters_reset: false };
    const auditText = prettyJson(record);
    await writeFile(audit, auditText, { flag: 'wx' }).catch(async error => {
      if (error.code !== 'EEXIST' || await readFile(audit, 'utf8') !== auditText) throw new Error('Sweep transfer audit changed; no artifact recovery.');
    });
    const files = await installSweepArtifacts(workRoot, selected);
    files.forEach(name => absent.delete(name)); restored.push({ id: entry.id, files, audit });
  }
  return restored;
}
