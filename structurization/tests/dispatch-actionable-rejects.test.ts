import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { sha256Text } from "../src/canonical.js";
import {
  EVIDENCE_SCHEMA_VERSION,
  EVIDENCE_SCOPE_SCHEMA_VERSION,
  SEMANTIC_EVIDENCE_SCHEMA_VERSION,
  type EvidenceManifest,
} from "../src/contracts.js";
import { documentReferenceTargetReadIdentity } from "../src/document-reference.js";
import { readReferenceCatalog } from "../src/reference-analysis.js";
import { ModelSourceHandles } from "../src/model-source-handles.js";
import { createPiTools, ToolController } from "../src/tools.js";
import { RevisionWorkspace } from "../src/workspace.js";

function manifestFor(text: string): EvidenceManifest {
  const evidenceId = "atom:dispatch-reject";
  return {
    schema_version: EVIDENCE_SCHEMA_VERSION,
    job_id: "dispatch-job",
    target_id: "target-dispatch",
    source: {
      adapter: "document-domain-agent/v1",
      file_name: "source.md",
      sha256: sha256Text(text),
      semantic_workflow: SEMANTIC_EVIDENCE_SCHEMA_VERSION,
    },
    scope: {
      schema_version: EVIDENCE_SCOPE_SCHEMA_VERSION,
      mode: "agent_discovered",
      target_id: "target-dispatch",
      source_line_count: 1,
      selected_start_line: 1,
      selected_end_exclusive_line: 2,
      selected_heading: "",
      selection_reason: "全文语义选择",
      selected_atom_ids: [evidenceId],
      target_evidence_fragments: [{ atom_id: evidenceId, text }],
      candidates: [],
    },
    evidence: [{
      evidence_id: evidenceId,
      kind: "paragraph",
      role: "supporting_clause",
      locator: `char:0-${text.length}`,
      text,
      text_sha256: sha256Text(text),
      requires_disposition: true,
      evidence_scope: "primary",
    }],
    table_fragments: [],
    reference_occurrences: [],
    evidence_fingerprint: sha256Text(`evidence\0${text}`),
  };
}

function referenceManifest(targetCount: number): EvidenceManifest {
  const origin = "安装要求应符合本规范第 1.1 节的规定。";
  const originId = "atom:reference-origin";
  const targets = Array.from({ length: targetCount }, (_entry, index) => ({
    evidence_id: `atom:reference-target-${index}`,
    kind: "paragraph" as const,
    role: "supporting_clause" as const,
    locator: `chunk:${index + 1}`,
    text: `1.1.${index + 1} 被引要求 ${index + 1}。`,
    text_sha256: sha256Text(`1.1.${index + 1} 被引要求 ${index + 1}。`),
    requires_disposition: true,
    evidence_scope: "reference" as const,
  }));
  const occurrence = {
    occurrence_id: "reference-occurrence",
    origin_evidence_id: originId,
    origin_fields: ["requirement" as const],
    raw_reference: "本规范第 1.1 节",
    target_evidence_ids: targets.map((record) => record.evidence_id),
    required: true,
    status: "resolved" as const,
    depth: 1,
    path: [],
    reference_kind: "clause" as const,
    target_address: {
      source_id: "reference-source",
      locator_kind: "section" as const,
      locator: "1.1",
    },
  };
  const evidence = [{
    evidence_id: originId,
    kind: "paragraph" as const,
    role: "supporting_clause" as const,
    locator: "chunk:0",
    text: origin,
    text_sha256: sha256Text(origin),
    requires_disposition: true,
    evidence_scope: "primary" as const,
  }, ...targets];
  return {
    schema_version: EVIDENCE_SCHEMA_VERSION,
    job_id: "dispatch-reference-job",
    target_id: "target-dispatch-reference",
    source: {
      adapter: "document-domain-agent/v1",
      file_name: "source.md",
      sha256: sha256Text(evidence.map((record) => record.text).join("\n")),
      semantic_workflow: SEMANTIC_EVIDENCE_SCHEMA_VERSION,
    },
    scope: {
      schema_version: EVIDENCE_SCOPE_SCHEMA_VERSION,
      mode: "agent_discovered",
      target_id: "target-dispatch-reference",
      source_line_count: evidence.length,
      selected_start_line: 1,
      selected_end_exclusive_line: 2,
      selected_heading: "",
      selection_reason: "引用反馈测试",
      selected_atom_ids: [originId],
      target_evidence_fragments: [{ atom_id: originId, text: origin }],
      candidates: [],
    },
    evidence,
    table_fragments: [],
    reference_occurrences: [occurrence],
    evidence_fingerprint: sha256Text(`reference\0${evidence.map((record) => record.text).join("\0")}`),
  };
}

describe("target dispatch actionable rejects", () => {
  test("unknown tools and illegal patches keep the actual value", async () => {
    const root = await mkdtemp(join(tmpdir(), "target-dispatch-reject-"));
    try {
      const text = "地基承载力应满足设计要求。";
      const manifest = manifestFor(text);
      const workspace = await RevisionWorkspace.createFromEvidence(
        root,
        manifest.job_id,
        manifest.target_id,
        { manifest, markdown: Buffer.from(text) },
      );
      const controller = await ToolController.create(workspace);
      const unknown = await controller.dispatch("not_a_target_tool", {});
      expect(unknown).toMatchObject({
        ok: false,
        error: "unknown_target_tool",
        actual_tool: "not_a_target_tool",
      });
      expect(String(unknown.instruction)).toMatch(/get_plan_contract/);
      const patch = await controller.dispatch("patch_working_plan", {
        operations: [{ op: "move", path: "/acceptance_items/0" }],
      });
      expect(patch).toMatchObject({
        ok: false,
        error: "unsupported_json_patch_operation",
        actual_op: "move",
      });
      expect(String(patch.instruction)).toMatch(/add, remove, or replace/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("isolated source rejection starts with the real catalog call and does not require unknown entry ids", async () => {
    const root = await mkdtemp(join(tmpdir(), "target-dispatch-isolated-reference-"));
    try {
      const manifest = referenceManifest(25);
      const workspace = await RevisionWorkspace.createFromEvidence(
        root,
        manifest.job_id,
        manifest.target_id,
        { manifest, markdown: Buffer.from(manifest.evidence.map((record) => record.text).join("\n")) },
      );
      const controller = await ToolController.create(workspace);
      const evidenceId = manifest.reference_occurrences[0]!.target_evidence_ids[0]!;
      const expectedTargetKey = documentReferenceTargetReadIdentity(manifest.reference_occurrences[0]!).target_key;

      const rejected = await controller.dispatch("open_evidence", { evidence_id: evidenceId });
      expect(rejected).toMatchObject({
        ok: false,
        error: "isolated_reference_body_access_forbidden",
        target_key: expectedTargetKey,
        next_tool: "read_reference_facts",
        tool_arguments: { target_key: expectedTargetKey },
        writable_parameters: ["target_key"],
        do_not_edit: expect.any(String),
      });
      expect(String(rejected.instruction)).toContain("只传 target_key");
      expect(String(rejected.instruction)).toContain("entry_ids");
      expect(String(rejected.instruction)).toContain("自动返回 resolved_rows");
      expect(String(rejected.instruction)).toContain("仅在重新取得此前已打开行");
      expect(String(rejected.required_action)).not.toContain("entry_ids_and_resolve_rows");

      const located = await controller.dispatch("locate_evidence_span", { evidence_id: evidenceId, quote: "被引要求" });
      expect(located).toMatchObject({
        ok: false,
        error: "isolated_reference_body_access_forbidden",
        next_tool: "read_reference_facts",
        tool_arguments: { target_key: expectedTargetKey },
        writable_parameters: ["target_key"],
      });
      const batch = await controller.dispatch("batch_locate_evidence_spans", {
        requests: [{ evidence_id: evidenceId, quote: "被引要求" }],
      });
      expect(batch).toMatchObject({
        ok: false,
        results: [{
          ok: false,
          error: "isolated_reference_body_access_forbidden",
          next_tool: "read_reference_facts",
          tool_arguments: { target_key: expectedTargetKey },
          writable_parameters: ["target_key"],
        }],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("inline catalog rejection names the real reader and its legal pagination parameters", async () => {
    const root = await mkdtemp(join(tmpdir(), "target-dispatch-inline-reference-"));
    try {
      const manifest = referenceManifest(1);
      const workspace = await RevisionWorkspace.createFromEvidence(
        root,
        manifest.job_id,
        manifest.target_id,
        { manifest, markdown: Buffer.from(manifest.evidence.map((record) => record.text).join("\n")) },
      );
      const targetKey = documentReferenceTargetReadIdentity(manifest.reference_occurrences[0]!).target_key;
      const rejected = await readReferenceCatalog(workspace, manifest, targetKey);
      expect(rejected).toMatchObject({
        ok: false,
        error: "inline_reference_catalog_not_available",
        target_key: targetKey,
        next_tool: "read_document_reference_evidence",
        tool_arguments: { target_key: targetKey, cursor: 0 },
        next_tool_arguments: { target_key: targetKey, cursor: 0 },
        writable_parameters: ["target_key", "cursor", "limit"],
        do_not_edit: expect.any(String),
      });
      expect(String(rejected.instruction)).toContain("next_cursor");
      expect(String(rejected.instruction)).toContain("done=true");
      expect(String(rejected.required_action)).not.toContain("until_done");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("inline recovery retains the current handle scope and reads the advertised page through real wrapped tools", async () => {
    const root = await mkdtemp(join(tmpdir(), "target-dispatch-inline-scope-"));
    try {
      const manifest = referenceManifest(1);
      const workspace = await RevisionWorkspace.createFromEvidence(root, manifest.job_id, manifest.target_id,
        { manifest, markdown: Buffer.from(manifest.evidence.map(record => record.text).join("\n")) });
      const controller = await ToolController.create(workspace);
      const codec = await ModelSourceHandles.open(workspace.root);
      const tools = codec.wrapTools(createPiTools(controller));
      const targetKey = documentReferenceTargetReadIdentity(manifest.reference_occurrences[0]!).target_key;
      const encoded = await codec.encode({ target_key: targetKey }) as any;
      const before = await readFile(workspace.workingSelectorPath, "utf8");
      const rejected = await tools.find(tool => tool.name === "read_reference_facts")!.execute("inline-catalog",
        { ...encoded, source_handle_scope: codec.scope }, undefined as any, undefined as any, undefined as any);
      const visible = JSON.parse((rejected.content[0] as any).text);
      expect(visible).toMatchObject({ error: "inline_reference_catalog_not_available", source_handle_scope: codec.scope,
        next_tool: "read_document_reference_evidence", next_tool_arguments: { target_key: encoded.target_key, cursor: 0 } });
      expect(visible.instruction).toContain("来源所属目标由程序绑定");
      expect(visible.instruction).not.toContain("只可填写 target_key、cursor、limit");
      const read = await tools.find(tool => tool.name === visible.next_tool)!.execute("inline-page",
        { ...visible.next_tool_arguments, source_handle_scope: visible.source_handle_scope }, undefined as any, undefined as any, undefined as any);
      expect(JSON.parse((read.content[0] as any).text)).toMatchObject({ ok: true, target_key: encoded.target_key, done: true, next_cursor: null });
      expect(await readFile(workspace.workingSelectorPath, "utf8")).toBe(before);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
