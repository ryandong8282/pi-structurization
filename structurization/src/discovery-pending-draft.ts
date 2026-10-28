import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import { atomicWriteJson, readJson } from "./atomic.js";
import { sha256Json } from "./canonical.js";
import type { JsonPatchOperation } from "./json-patch.js";
import type { DocumentSelectorPlan } from "./document-selector-compiler.js";
import type { SourceSpanRegistry } from "./source-span-registry.js";

/** Unaccepted, canonical transaction; never a replacement for working selectors. */
export interface DiscoveryPendingDraft {
  schema_version: "discovery-pending-draft/v1";
  owner_root: string;
  job_id: string;
  evidence_fingerprint: string;
  phase: "candidate" | "review";
  phase_epoch: string;
  base_selector_fingerprint: string;
  nonce: string;
  /** Bounded final author intent; deterministic mirror/anchor repairs do not consume this budget. */
  operations: JsonPatchOperation[];
  /** Exact normalized view returned by preflight, including deterministic derived fields. */
  selectors: DocumentSelectorPlan;
  registry: SourceSpanRegistry;
}

export type DiscoveryDraftBinding = Pick<DiscoveryPendingDraft,
  "job_id" | "evidence_fingerprint" | "phase" | "phase_epoch" | "base_selector_fingerprint">;

export interface DiscoveryDraftRecovery {
  draft_id: string;
  draft_retained: true;
  writable_path: "draft_id";
  next_tool: "read_document_selectors";
  next_tool_arguments: { draft_id: string };
  instruction: string;
}

export class DiscoveryPendingDraftError extends Error {
  constructor(
    public readonly code: string,
    public readonly actual: unknown,
    public readonly recovery?: DiscoveryDraftRecovery,
  ) { super(code); }
}

const draftPath = (root: string) => join(root, "pending.document-selectors.json");
const fullToken = /^[a-f0-9]{64}$/u;
const shortToken = /^d_[a-f0-9]{12}$/u;
const draftHandle = (checksum: string) => `d_${checksum.slice(0, 12)}`;

interface StoredDiscoveryDraft {
  draft_id: string;
  /** Separate full integrity digest; older v1 files used the digest itself as draft_id. */
  checksum?: string;
  draft: DiscoveryPendingDraft;
}

async function readStoredDraft(root: string): Promise<{ draft_id: string; checksum: string; draft: DiscoveryPendingDraft }> {
  let stored: StoredDiscoveryDraft;
  try { stored = await readJson(draftPath(root)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new DiscoveryPendingDraftError("selector_draft_unavailable", null);
    if (error instanceof SyntaxError) throw new DiscoveryPendingDraftError("selector_draft_corrupt", null);
    throw error; // Permission and disk failures must not authorize overwriting a presumed-absent draft.
  }
  const draft = stored?.draft;
  const checksum = draft ? sha256Json(draft) : "";
  const storedChecksum = stored?.checksum ?? stored?.draft_id;
  if (!draft || typeof storedChecksum !== "string" || !fullToken.test(storedChecksum) || storedChecksum !== checksum
    || (stored.draft_id !== checksum && stored.draft_id !== draftHandle(checksum))
    || draft.schema_version !== "discovery-pending-draft/v1" || draft.owner_root !== root
    || typeof draft.job_id !== "string" || typeof draft.evidence_fingerprint !== "string"
    || !["candidate", "review"].includes(draft.phase) || typeof draft.phase_epoch !== "string"
    || typeof draft.base_selector_fingerprint !== "string" || typeof draft.nonce !== "string"
    || !Array.isArray(draft.operations) || !Array.isArray(draft.registry?.spans)
    || !Array.isArray(draft.selectors?.targets) || !Array.isArray(draft.selectors?.contexts)
    || !Array.isArray(draft.selectors?.dispositions)) {
    throw new DiscoveryPendingDraftError("selector_draft_corrupt", null);
  }
  // Legacy files are not rewritten; their original 64-character token remains valid.
  return { draft_id: draftHandle(checksum), checksum, draft };
}

function bindingFailure(draft: DiscoveryPendingDraft, binding: DiscoveryDraftBinding): DiscoveryPendingDraftError | undefined {
  if (draft.job_id !== binding.job_id || draft.evidence_fingerprint !== binding.evidence_fingerprint
    || draft.phase !== binding.phase || draft.phase_epoch !== binding.phase_epoch) {
    return new DiscoveryPendingDraftError("selector_draft_scope_mismatch", { current_phase: binding.phase });
  }
  if (draft.base_selector_fingerprint !== binding.base_selector_fingerprint) {
    return new DiscoveryPendingDraftError("selector_draft_base_stale", {
      base_selector_fingerprint: draft.base_selector_fingerprint, current_selector_fingerprint: binding.base_selector_fingerprint,
    });
  }
  return undefined;
}

/** Read-only recovery directory, scoped to one exact current accepted checkpoint and review phase. */
export async function findCurrentDiscoveryDraft(
  root: string,
  binding: DiscoveryDraftBinding,
): Promise<{ draft_id: string; draft: DiscoveryPendingDraft } | undefined> {
  try {
    const stored = await readStoredDraft(root);
    if (bindingFailure(stored.draft, binding)) return undefined;
    return { draft_id: stored.draft_id, draft: stored.draft };
  } catch (error) {
    if (error instanceof DiscoveryPendingDraftError) return undefined;
    throw error;
  }
}

export async function discardDiscoveryDraft(root: string): Promise<void> {
  await unlink(draftPath(root)).catch(error => { if (error?.code !== "ENOENT") throw error; });
}

export async function retainDiscoveryDraft(
  root: string,
  input: Omit<DiscoveryPendingDraft, "schema_version" | "owner_root" | "nonce">,
): Promise<string> {
  const draft: DiscoveryPendingDraft = { ...input, schema_version: "discovery-pending-draft/v1", owner_root: root, nonce: randomUUID() };
  const checksum = sha256Json(draft);
  const draft_id = draftHandle(checksum);
  await atomicWriteJson(draftPath(root), { draft_id, checksum, draft });
  return draft_id;
}

export async function readDiscoveryDraft(root: string, id: unknown, binding?: DiscoveryDraftBinding): Promise<DiscoveryPendingDraft> {
  let stored: Awaited<ReturnType<typeof readStoredDraft>>;
  try { stored = await readStoredDraft(root); }
  catch (error) {
    if (error instanceof DiscoveryPendingDraftError) throw new DiscoveryPendingDraftError(error.code, id);
    throw error;
  }
  const mismatch = binding ? bindingFailure(stored.draft, binding) : undefined;
  if (mismatch) throw mismatch;
  if (typeof id !== "string" || (!shortToken.test(id) && !fullToken.test(id))
    || (id !== stored.draft_id && id !== stored.checksum)) {
    const validShape = typeof id === "string" && (shortToken.test(id) || fullToken.test(id));
    // Never silently substitute another token. The caller must explicitly read and retry.
    // Without a verified live binding, a wrong token must not reveal a possibly obsolete draft.
    const recovery: DiscoveryDraftRecovery | undefined = binding ? {
      draft_id: stored.draft_id, draft_retained: true, writable_path: "draft_id",
      next_tool: "read_document_selectors", next_tool_arguments: { draft_id: stored.draft_id },
      instruction: "The supplied draft_id does not identify this current pending transaction. Nothing was applied or discarded. The retained draft matches this workspace, document, phase and accepted checkpoint. Copy the exact returned draft_id and call read_document_selectors with next_tool_arguments; then retry only the intended delta with that handle. Do not regenerate unchanged records, guess a token, replace the draft or edit stored/source files.",
    } : undefined;
    throw new DiscoveryPendingDraftError(validShape ? "selector_draft_token_stale" : "selector_draft_token_invalid", id, recovery);
  }
  return stored.draft;
}

/** Diff the final keyed records, not repair attempts. Keep removes index-safe and preserve order. */
export function discoveryDraftOperations(before: DocumentSelectorPlan, after: DocumentSelectorPlan): JsonPatchOperation[] {
  const operations: JsonPatchOperation[] = [];
  for (const collection of ["targets", "contexts", "dispositions"] as const) {
    const keyField = collection === "dispositions" ? "atom_span_id" : "key";
    const rows = [...before[collection]] as unknown as Array<Record<string, unknown>>;
    const final = after[collection] as unknown as Array<Record<string, unknown>>;
    const finalKeys = new Set(final.map(row => row[keyField]));
    for (let i = rows.length - 1; i >= 0; i--) {
      if (!finalKeys.has(rows[i]![keyField])) {
        operations.push({ op: "remove", path: `/${collection}/${i}` });
        rows.splice(i, 1);
      }
    }
    final.forEach((row, index) => {
      if (rows[index]?.[keyField] !== row[keyField]) {
        const prior = rows.findIndex((entry, i) => i > index && entry[keyField] === row[keyField]);
        if (prior >= 0) {
          operations.push({ op: "remove", path: `/${collection}/${prior}` });
          rows.splice(prior, 1);
        }
        operations.push({ op: "add", path: `/${collection}/${index}`, value: row });
        rows.splice(index, 0, row);
      } else if (sha256Json(rows[index]) !== sha256Json(row)) {
        operations.push({ op: "replace", path: `/${collection}/${index}`, value: row });
        rows[index] = row;
      }
    });
  }
  return operations;
}

/** Locate/read tools may append accepted spans while a pending transaction exists. */
export function mergeDiscoveryDraftRegistry(current: SourceSpanRegistry, pending: SourceSpanRegistry): SourceSpanRegistry {
  if (current.schema_version !== pending.schema_version || current.source_fingerprint !== pending.source_fingerprint) {
    throw new DiscoveryPendingDraftError("selector_draft_source_changed", pending.source_fingerprint);
  }
  const spans = new Map(current.spans.map(span => [span.span_id, span]));
  for (const span of pending.spans) {
    const existing = spans.get(span.span_id);
    if (existing && sha256Json(existing) !== sha256Json(span)) throw new DiscoveryPendingDraftError("selector_draft_registry_conflict", span.span_id);
    spans.set(span.span_id, span);
  }
  return { ...current, spans: [...spans.values()].sort((left, right) => left.span_id.localeCompare(right.span_id)) };
}
