import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { sha256Json, sha256Text } from "../src/canonical.js";
import {
  canAnchorStaticTableReference, EVIDENCE_SCHEMA_VERSION, EVIDENCE_SCOPE_SCHEMA_VERSION,
  SEMANTIC_EVIDENCE_SCHEMA_VERSION, type EvidenceManifest, type ReferenceOccurrence,
} from "../src/contracts.js";
import { buildStructuredTargetEvidence } from "../src/evidence.js";
import { ToolController } from "../src/tools.js";
import { RevisionWorkspace } from "../src/workspace.js";

async function fixture(table: string, title: string, criterion: string, duplicate = false, literal = `本规程表${table}`) {
  const originText = `6.1.1 ${title}应符合${literal}的规定。`;
  const markdown = ["# 6 虚构测件", originText, "", "# 4 共同要求", `表${table} ${title}要求`,
    `<table><tr><td>项目</td><td>指标</td></tr><tr><td>${title}</td><td>${criterion}</td></tr></table>`].join("\n");
  const structured = buildStructuredTargetEvidence(markdown, sha256Text(markdown), [{ start_line: 1, end_exclusive_line: 3 }], false);
  const raw = {
    schema_version: EVIDENCE_SCHEMA_VERSION, job_id: "neutral-identity", target_id: "target:neutral-identity",
    source: { adapter: "document-domain-agent/v1" as const, file_name: "fictional.md", sha256: sha256Text(markdown), semantic_workflow: SEMANTIC_EVIDENCE_SCHEMA_VERSION },
    scope: { schema_version: EVIDENCE_SCOPE_SCHEMA_VERSION, mode: "agent_discovered" as const, target_id: "target:neutral-identity",
      source_line_count: 6, selected_start_line: 1, selected_end_exclusive_line: 3, selected_heading: title,
      selection_reason: "中性引用身份回归", selected_atom_ids: structured.evidence.filter(e => e.evidence_scope === "primary").map(e => e.evidence_id),
      target_evidence_fragments: [], candidates: [] },
    evidence: structured.evidence, table_fragments: structured.table_fragments,
    reference_occurrences: duplicate ? [...structured.reference_occurrences,
      { ...structured.reference_occurrences[0]!, occurrence_id: "reference:ambiguous-static-copy" }] : structured.reference_occurrences,
  };
  const manifest: EvidenceManifest = { ...raw, evidence_fingerprint: sha256Json(raw) };
  const workspace = await RevisionWorkspace.createFromEvidence(resolve(".tmp-tests", `static-reference-${randomUUID()}`),
    raw.job_id, raw.target_id, { manifest, markdown: Buffer.from(markdown) });
  const origin = manifest.evidence.find(e => e.text === originText)!;
  const originSpan = (await workspace.readSourceSpanRegistry()).spans.find(s => s.evidence_id === origin.evidence_id)!;
  const controller = await ToolController.create(workspace);
  const resolveReference = () => controller.dispatch("resolve_document_reference", { origin_span_id: originSpan.span_id,
    origin_field: "requirement", raw_reference: literal, target: { kind: "table", number: table }, relation: "原文明确引用" });
  return { workspace, manifest, origin, resolveReference };
}

describe("static table reference identity", () => {
  test.each([
    ["4.2.1", "端面平顺性", "表面应平顺", "本规程表4.2.1"],
    ["9.3.2", "锁扣闭合", "各锁扣应完全闭合", "本规程表9.3.2"],
    ["4.2.1", "端面平顺性", "表面应平顺", "本规程表 4.2.1"],
    ["4.2.1", "端面平顺性", "表面应平顺", "本规程表 4. 2.1"],
  ])("anchors %s without adding another obligation or changing its saved identity", async (table, title, criterion, raw) => {
    const f = await fixture(table, title, criterion, false, raw);
    expect(f.manifest.reference_occurrences).toHaveLength(1);
    const original = f.manifest.reference_occurrences[0]!;
    expect(original.reference_literal).toBeUndefined();
    const first = await f.resolveReference();
    expect(first).toMatchObject({ ok: true, occurrence_id: original.occurrence_id });
    const after = await f.workspace.readEvidenceManifest();
    expect(after.reference_occurrences).toHaveLength(1);
    expect(after.reference_occurrences[0]).toMatchObject({ occurrence_id: original.occurrence_id,
      origin_evidence_id: original.origin_evidence_id, target_evidence_ids: original.target_evidence_ids,
      reference_literal_span_id: expect.any(String) });
    const literal = after.reference_occurrences[0]!.reference_literal!;
    expect(f.origin.text.slice(literal.start, literal.end)).toBe(raw);
    const second = await f.resolveReference();
    expect(second).toMatchObject({ ok: true, occurrence_id: original.occurrence_id, idempotent: true });
    expect(await f.workspace.readEvidenceManifest()).toEqual(after);
  });

  test("does not guess between two unanchored identities", async () => {
    const f = await fixture("4.2.1", "端面平顺性", "表面应平顺", true);
    const receipt = await f.resolveReference();
    expect(receipt.ok).toBe(true);
    expect(f.manifest.reference_occurrences.map(o => o.occurrence_id)).not.toContain(receipt.occurrence_id);
    const after = await f.workspace.readEvidenceManifest();
    expect(after.reference_occurrences.slice(0, 2)).toEqual(f.manifest.reference_occurrences);
  });

  test("requires unique literal, same source, same target and exact origin before enrichment", async () => {
    const f = await fixture("4.2.1", "端面平顺性", "表面应平顺");
    await f.resolveReference();
    const previous = f.manifest.reference_occurrences[0]!;
    const proposed = (await f.workspace.readEvidenceManifest()).reference_occurrences[0]!;
    expect(canAnchorStaticTableReference(previous, proposed, f.manifest)).toBe(true);
    const changes: Partial<ReferenceOccurrence>[] = [
      { origin_evidence_id: "different-origin" }, { target_evidence_ids: [] }, { status: "target_not_found" },
      { required: false }, { target_table_id: "8.1.1" },
      { external_standard: { standard_no: "EXTERNAL-1", status: "resolved" } },
      { target_address: { source_id: "different-source", locator_kind: "table", locator: "table:4.2.1" } },
      { reference_literal: { evidence_id: f.origin.evidence_id, start: 0, end: 1 } },
    ];
    for (const change of changes) expect(canAnchorStaticTableReference(previous, { ...proposed, ...change } as ReferenceOccurrence, f.manifest)).toBe(false);
    const repeated = { ...f.manifest, evidence: f.manifest.evidence.map(e => e.evidence_id === f.origin.evidence_id
      ? { ...e, text: `${e.text}再次引用${previous.raw_reference}。` } : e) };
    expect(canAnchorStaticTableReference(previous, proposed, repeated)).toBe(false);
    expect(canAnchorStaticTableReference(proposed, proposed, f.manifest)).toBe(false);
  });

  test.each(["validation", "coverage_repair", "review_observation"])("does not enrich a frozen %s candidate", async mode => {
    const f = await fixture("4.2.1", "端面平顺性", "表面应平顺");
    const before = await f.workspace.readEvidenceManifest();
    const previous = f.manifest.reference_occurrences[0]!;
    const literalStart = f.origin.text.indexOf(previous.raw_reference);
    const candidate = { ...previous, target_address: { source_id: f.manifest.source.sha256, locator_kind: "table", locator: "table:4.2.1" },
      reference_literal: { evidence_id: f.origin.evidence_id, start: literalStart, end: literalStart + previous.raw_reference.length } } as ReferenceOccurrence;
    await f.workspace.updateState(state => {
      state.validation_attempts = 1;
      if (mode === "coverage_repair") {
        state.selector_stage = "coverage_repair";
        state.repair = { ...state.repair!, mode: "repair", repair_source: "coverage",
          coverage_review_fingerprint: "f".repeat(64), coverage_finding_ids: ["finding:frozen-reference"] };
      } else state.last_valid_fingerprint = "f".repeat(64);
    });
    const counts = await f.workspace.readState();
    await expect(f.workspace.registerDocumentReferenceDependency([], candidate, mode === "review_observation")).rejects.toThrow(
      mode === "validation" ? "Document references must be registered before final validation" : "Document reference occurrence collision");
    expect(await f.workspace.readEvidenceManifest()).toEqual(before);
    expect(await f.workspace.readState()).toEqual(counts);
  });
});
