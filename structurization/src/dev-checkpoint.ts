import { chmod, lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { sha256Bytes, sha256Json, sha256Text } from "./canonical.js";
import { buildDocumentEvidence, validateDocumentTargetPlan, type DocumentEvidence, type DocumentTargetPlan } from "./document-discovery.js";
import { confirmedTargetScope } from "./confirmed-target-scope.js";

export function devJobDirectory(root: string, job: string): string {
  return join(root, "jobs", encodeURIComponent(job.trim()).replaceAll("%", "_"));
}

export function within(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

/** Resolve existing ancestors too, so a symlink cannot make an isolated output overlap the source. */
export async function physicalPath(path: string): Promise<string> {
  try { return await realpath(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(await physicalPath(parent), basename(path));
  }
}

const REQUIRED = ["source.md", "document-evidence.json", "state.json", "document-target-plan.json", "document-selectors.json", "source-span-registry.json", "seal-receipt.json", "manifest.json", "session.events.jsonl", "document-ledger.json"];
const OPTIONAL = ["working.document-target-plan.json", "working.document-selectors.json", "last-valid.document-target-plan.json", "validation-receipt.json", "pdf-layout-catalog.json", "pdf-layout-profile.json", "discovery-decisions.json"];

/** Byte-preserving discovery-only relocation. No batch, target draft, answer, auth or model session is imported. */
export async function copyDevDiscovery(input: { from: string; out: string; job: string; markdown: string; pdf?: string; targets: string[] }): Promise<{ targets: string[]; manifest_sha256: string }> {
  const sourceRoot = await realpath(input.from);
  const destinationRoot = await physicalPath(resolve(input.out));
  if (within(sourceRoot, destinationRoot) || within(destinationRoot, sourceRoot)) throw new Error("Output and checkpoint roots must be disjoint");
  const source = devJobDirectory(sourceRoot, input.job);
  const discovery = join(source, "discovery");
  if (!within(sourceRoot, await realpath(discovery))) throw new Error("Checkpoint discovery escapes its root");
  const files = new Map<string, Buffer>();
  const modes = new Map<string, number>();
  for (const name of [...REQUIRED, ...OPTIONAL]) {
    try {
      const stat = await lstat(join(discovery, name));
      if (!stat.isFile()) throw new Error(`Checkpoint artifact must be a regular file: ${name}`);
      modes.set(name, stat.mode & 0o777);
      files.set(name, await readFile(join(discovery, name)));
    } catch (error) {
      if (!OPTIONAL.includes(name) || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const json = <T>(name: string): T => JSON.parse(files.get(name)!.toString("utf8")) as T;
  const state = json<{ status: string; last_valid_fingerprint: string; last_valid_plan_sha256: string }>("state.json");
  const evidence = json<DocumentEvidence>("document-evidence.json");
  const plan = json<DocumentTargetPlan>("document-target-plan.json");
  const manifest = json<{ schema_version: string; job_id: string; target_count: number; files: Record<string, string> }>("manifest.json");
  const receipt = json<{ fingerprint: string; plan_sha256: string; document_fingerprint: string; transcript: { byte_length: number; sha256: string } }>("seal-receipt.json");
  const markdown = await readFile(input.markdown, "utf8");
  if (state.status !== "sealed" || manifest.schema_version !== "document-discovery-manifest/v4" || manifest.job_id !== input.job || plan.job_id !== input.job) throw new Error("A sealed current discovery checkpoint with the same job identity is required");
  const rebuilt = buildDocumentEvidence(markdown, basename(input.markdown));
  if (sha256Json(rebuilt) !== sha256Json(evidence) || sha256Text(markdown) !== sha256Bytes(files.get("source.md")!)) throw new Error("Checkpoint Markdown/source identity mismatch (bytes and filename must match)");
  const hashes: Record<string, string> = {
    plan_sha256: sha256Bytes(files.get("document-target-plan.json")!), selector_sha256: sha256Bytes(files.get("document-selectors.json")!),
    source_span_registry_sha256: sha256Bytes(files.get("source-span-registry.json")!), evidence_sha256: sha256Json(evidence), seal_receipt_sha256: sha256Json(receipt),
  };
  if (manifest.files.document_ledger_sha256) hashes.document_ledger_sha256 = sha256Json(json<unknown>("document-ledger.json"));
  for (const [key, actual] of Object.entries(hashes)) if (manifest.files[key] !== actual) throw new Error(`Discovery manifest mismatch: ${key}`);
  if (manifest.target_count !== plan.targets.length || receipt.document_fingerprint !== evidence.evidence_fingerprint || receipt.plan_sha256 !== sha256Json(plan) || receipt.fingerprint !== state.last_valid_fingerprint || receipt.plan_sha256 !== state.last_valid_plan_sha256) throw new Error("Discovery seal/state identity mismatch");
  const transcript = files.get("session.events.jsonl")!;
  if (!Number.isSafeInteger(receipt.transcript.byte_length) || receipt.transcript.byte_length < 0 || receipt.transcript.byte_length > transcript.length || sha256Bytes(transcript.subarray(0, receipt.transcript.byte_length)) !== receipt.transcript.sha256) throw new Error("Discovery sealed transcript prefix mismatch");
  const validation = validateDocumentTargetPlan(plan, evidence, input.job, new Set(evidence.atoms.map(a => a.atom_id)));
  if (!validation.ok) throw new Error(`Discovery fails current contract: ${JSON.stringify(validation.issues.slice(0, 10))}`);
  if (validation.fingerprint !== receipt.fingerprint) throw new Error("Discovery seal fingerprint does not match current validation");
  for (const target of plan.targets) confirmedTargetScope(target, evidence);
  const known = new Set(plan.targets.map(t => t.target_id));
  if (!input.targets.length || input.targets.some(id => !known.has(id))) throw new Error("Select one or more target IDs present in the sealed discovery plan");
  // Optional PDF identity is enforced against the original batch when present; never copy that batch.
  try {
    const old = JSON.parse(await readFile(join(source, "batch.json"), "utf8")) as { source: { markdown_sha256: string; pdf_sha256?: string; pdf_file?: string } };
    if (old.source.markdown_sha256 !== evidence.source.sha256) throw new Error("Original batch/source identity mismatch");
    if (old.source.pdf_sha256) {
      if (!input.pdf || basename(input.pdf) !== old.source.pdf_file || sha256Bytes(await readFile(input.pdf)) !== old.source.pdf_sha256) throw new Error("Original batch PDF identity mismatch; supply the same PDF");
    } else if (input.pdf) throw new Error("Cannot add a PDF absent from the original batch identity");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (input.pdf) throw new Error("Cannot verify PDF identity without the original batch");
  }
  const dest = join(devJobDirectory(destinationRoot, input.job), "discovery");
  await mkdir(dest, { recursive: true });
  for (const name of files.keys()) {
    // Copy bytes from the validated snapshot, not a second read of a possibly changing original.
    // writeFile with wx below also protects against accidental replacement.
    await writeFile(join(dest, name), files.get(name)!, { flag: "wx" });
    await chmod(join(dest, name), modes.get(name)!);
  }
  return { targets: [...known], manifest_sha256: sha256Bytes(files.get("manifest.json")!) };
}
