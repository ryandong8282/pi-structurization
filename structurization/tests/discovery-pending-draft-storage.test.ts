import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { atomicWriteJson } from "../src/atomic.js";
import { sha256Json } from "../src/canonical.js";
import {
  DiscoveryPendingDraftError,
  discardDiscoveryDraft,
  findCurrentDiscoveryDraft,
  readDiscoveryDraft,
  retainDiscoveryDraft,
  type DiscoveryDraftBinding,
  type DiscoveryPendingDraft,
} from "../src/discovery-pending-draft.js";
import { initialDocumentSelectorPlan } from "../src/document-selector-compiler.js";
import { initialSourceSpanRegistry } from "../src/source-span-registry.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-draft-storage-"));
  const binding: DiscoveryDraftBinding = {
    job_id: "job-a", evidence_fingerprint: "source-a", phase: "candidate", phase_epoch: "epoch-a", base_selector_fingerprint: "accepted-a",
  };
  const input: Omit<DiscoveryPendingDraft, "schema_version" | "owner_root" | "nonce"> = {
    ...binding, operations: [], selectors: initialDocumentSelectorPlan("job-a"), registry: initialSourceSpanRegistry("source-a"),
  };
  const id = await retainDiscoveryDraft(root, input);
  const path = join(root, "pending.document-selectors.json");
  return { root, binding, input, id, path };
}

async function rejected(action: Promise<unknown>): Promise<DiscoveryPendingDraftError> {
  try { await action; }
  catch (error) {
    expect(error).toBeInstanceOf(DiscoveryPendingDraftError);
    return error as DiscoveryPendingDraftError;
  }
  throw new Error("Expected an explicit pending draft rejection");
}

describe("short discovery draft handles and bound recovery", () => {
  test("new short handles retain a full independent checksum and remain recoverable without writing", async () => {
    const f = await fixture();
    expect(f.id).toMatch(/^d_[a-f0-9]{12}$/u);
    const before = await readFile(f.path, "utf8");
    const stored = JSON.parse(before);
    expect(stored.checksum).toMatch(/^[a-f0-9]{64}$/u);
    expect(stored.checksum).toBe(sha256Json(stored.draft));
    expect(stored.draft_id).toBe(f.id);
    expect(await readDiscoveryDraft(f.root, f.id, f.binding)).toEqual(stored.draft);
    expect(await findCurrentDiscoveryDraft(f.root, f.binding)).toEqual({ draft_id: f.id, draft: stored.draft });
    expect(await readFile(f.path, "utf8")).toBe(before);
  });

  test.each(["truncated", "unknown_short", "unknown_long", "foreign", "missing", "path"] as const)(
    "%s token is rejected with an exact next read, never silently substituted or discarded", async kind => {
      const f = await fixture();
      const foreign = await fixture();
      const id = kind === "truncated" ? f.id.slice(0, -1)
        : kind === "unknown_short" ? "d_000000000000"
        : kind === "unknown_long" ? "0".repeat(64)
        : kind === "foreign" ? foreign.id
        : kind === "path" ? "../../another-job/pending.document-selectors.json" : undefined;
      const before = await readFile(f.path, "utf8");
      const error = await rejected(readDiscoveryDraft(f.root, id, f.binding));
      expect(error.actual).toBe(id);
      expect(error.code).toMatch(/^selector_draft_token_(invalid|stale)$/u);
      expect(error.recovery).toMatchObject({
        draft_id: f.id, draft_retained: true, writable_path: "draft_id",
        next_tool: "read_document_selectors", next_tool_arguments: { draft_id: f.id },
      });
      expect(error.recovery!.instruction).toContain("Nothing was applied or discarded");
      expect(error.recovery!.instruction).toContain("Do not regenerate unchanged records");
      expect(await readDiscoveryDraft(f.root, error.recovery!.draft_id, f.binding)).toMatchObject(f.binding);
      expect(await readFile(f.path, "utf8")).toBe(before);
    },
  );

  test("a wrong token without verified live binding cannot reveal the stored handle", async () => {
    const f = await fixture();
    const error = await rejected(readDiscoveryDraft(f.root, f.id.slice(0, -1)));
    expect(error.code).toBe("selector_draft_token_invalid");
    expect(error.recovery).toBeUndefined();
  });

  test.each([
    { job_id: "other-job" },
    { evidence_fingerprint: "new-source" },
    { phase: "review" as const },
    { phase_epoch: "new-review-epoch" },
    { base_selector_fingerprint: "new-accepted-checkpoint" },
  ])("expired or foreign binding %j offers no recovery and performs no write", async change => {
    const f = await fixture();
    const before = await readFile(f.path, "utf8");
    const binding = { ...f.binding, ...change };
    expect(await findCurrentDiscoveryDraft(f.root, binding)).toBeUndefined();
    for (const token of [f.id, f.id.slice(0, -1)]) {
      const error = await rejected(readDiscoveryDraft(f.root, token, binding));
      expect(error.code).toBe("base_selector_fingerprint" in change ? "selector_draft_base_stale" : "selector_draft_scope_mismatch");
      expect(error.recovery).toBeUndefined();
    }
    expect(await readFile(f.path, "utf8")).toBe(before);
  });

  test("legacy 64-character files accept the original token and short handle without migration", async () => {
    const f = await fixture();
    const { draft } = JSON.parse(await readFile(f.path, "utf8"));
    const legacyId = sha256Json(draft);
    await atomicWriteJson(f.path, { draft_id: legacyId, draft });
    const before = await readFile(f.path, "utf8");
    expect(await readDiscoveryDraft(f.root, legacyId, f.binding)).toEqual(draft);
    const recovered = await findCurrentDiscoveryDraft(f.root, f.binding);
    expect(recovered!.draft_id).toMatch(/^d_[a-f0-9]{12}$/u);
    expect(await readDiscoveryDraft(f.root, recovered!.draft_id, f.binding)).toEqual(draft);
    // The real failure: one missing final character must not demand resending the transaction.
    const error = await rejected(readDiscoveryDraft(f.root, legacyId.slice(0, -1), f.binding));
    expect(error.code).toBe("selector_draft_token_invalid");
    expect(error.recovery!.draft_id).toBe(recovered!.draft_id);
    expect(await readFile(f.path, "utf8")).toBe(before);
  });

  test("obsolete generation tokens never apply the new draft implicitly", async () => {
    const f = await fixture();
    const newer = await retainDiscoveryDraft(f.root, { ...f.input, selectors: { ...f.input.selectors, rationale: "新的明确事务" } });
    expect(newer).not.toBe(f.id);
    const error = await rejected(readDiscoveryDraft(f.root, f.id, f.binding));
    expect(error.code).toBe("selector_draft_token_stale");
    expect(error.recovery!.draft_id).toBe(newer);
    expect(await readDiscoveryDraft(f.root, newer, f.binding)).toMatchObject({ selectors: { rationale: "新的明确事务" } });
  });

  test.each(["checksum_tail", "body", "owner", "invalid_json", "no_checksum"] as const)(
    "corrupt %s cannot expose or resurrect a draft", async kind => {
      const f = await fixture();
      const stored = JSON.parse(await readFile(f.path, "utf8"));
      if (kind === "checksum_tail") stored.checksum = stored.checksum.slice(0, -1) + (stored.checksum.endsWith("0") ? "1" : "0");
      else if (kind === "body") stored.draft.selectors.rationale = "篡改内容";
      else if (kind === "owner") {
        stored.draft.owner_root = "another-workspace";
        stored.checksum = sha256Json(stored.draft);
        stored.draft_id = `d_${stored.checksum.slice(0, 12)}`;
      } else if (kind === "no_checksum") delete stored.checksum;
      if (kind === "invalid_json") await writeFile(f.path, "{invalid json");
      else await atomicWriteJson(f.path, stored);
      const before = await readFile(f.path, "utf8");
      expect(await findCurrentDiscoveryDraft(f.root, f.binding)).toBeUndefined();
      const error = await rejected(readDiscoveryDraft(f.root, f.id, f.binding));
      expect(error.code).toBe("selector_draft_corrupt");
      expect(error.recovery).toBeUndefined();
      expect(await readFile(f.path, "utf8")).toBe(before);
    },
  );

  test("copying another workspace file cannot make its token or recovery local", async () => {
    const local = await fixture();
    const foreign = await fixture();
    await writeFile(local.path, await readFile(foreign.path));
    expect(await findCurrentDiscoveryDraft(local.root, local.binding)).toBeUndefined();
    const error = await rejected(readDiscoveryDraft(local.root, foreign.id, local.binding));
    expect(error.code).toBe("selector_draft_corrupt");
    expect(error.recovery).toBeUndefined();
  });

  test("missing drafts are unavailable, while unexpected filesystem failures are not absence", async () => {
    const f = await fixture();
    await discardDiscoveryDraft(f.root);
    expect(await findCurrentDiscoveryDraft(f.root, f.binding)).toBeUndefined();
    expect((await rejected(readDiscoveryDraft(f.root, f.id, f.binding))).code).toBe("selector_draft_unavailable");
    await mkdir(f.path);
    await expect(findCurrentDiscoveryDraft(f.root, f.binding)).rejects.not.toBeInstanceOf(DiscoveryPendingDraftError);
  });
});
