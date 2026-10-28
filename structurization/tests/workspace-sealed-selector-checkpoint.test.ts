import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test, vi } from "vitest";

import { atomicWriteJson } from "../src/atomic.js";
import { prettyJson, sha256Text } from "../src/canonical.js";
import {
  EVIDENCE_SCHEMA_VERSION,
  EVIDENCE_SCOPE_SCHEMA_VERSION,
  SEMANTIC_EVIDENCE_SCHEMA_VERSION,
  type EvidenceManifest,
} from "../src/contracts.js";
import {
  registerSourceSpan,
  registryWithFullSourceSpans,
  type SourceSpanRegistry,
} from "../src/source-span-registry.js";
import {
  compileTargetSelectors,
  migrateTargetSelectorPlanForAuthoring,
  targetSelectorFingerprint,
} from "../src/target-selector-compiler.js";
import { hydrateSemanticSourcePlan } from "../src/plan-hydration.js";
import { buildStructuredTargetEvidence } from "../src/evidence.js";
import { initialTableStructurePlan, validateTableStructurePlan } from "../src/table-structure.js";
import { checkTargetCompilerInvariants } from "../src/target-compiler-invariants.js";
import * as selectorCompiler from "../src/target-selector-compiler.js";
import * as compilerInvariants from "../src/target-compiler-invariants.js";
import { STRUCTURAL_VALIDATION_BOUNDARY } from "../src/validation-boundary.js";
import { ToolController } from "../src/tools.js";
import { targetModelingCheckpointSnapshot } from "../src/pi-runtime.js";
import { ModelSourceHandles } from "../src/model-source-handles.js";
import {
  coverageRepairAllowsExternalDependency,
  RevisionWorkspace,
} from "../src/workspace.js";

test.each(["untouched", "edited", "validated", "coverage", "advanced", "missing"])(
  "only recovers a provably unstarted selector after the old resume guard: %s", async (kind) => {
    const root = join(tmpdir(), `pi-unstarted-resume-${randomUUID()}`);
    try {
      const manifest = manifestForEntries([{ evidenceId: "e1", text: "构件应检验外观。" }]);
      const first = await RevisionWorkspace.createFromEvidence(root, manifest.job_id, manifest.target_id, { manifest, markdown: Buffer.from("构件应检验外观。") });
      const before = await readFile(first.workingSelectorPath, "utf8");
      await first.updateState((state) => {
        state.opened_evidence_ids = ["e1"];
        state.agent_runtime.session_file = "interrupted-investigation.jsonl";
        if (kind === "edited") state.next_history_sequence = 2;
        if (kind === "validated") state.validation_attempts = 1;
        if (kind === "coverage") state.selector_stage = "coverage_repair";
        if (kind === "advanced") state.selector_stage = "sampling";
      });
      if (kind === "missing") await rm(first.workingSelectorPath);
      await first.markTerminal("failed", "target_selector_resume_checkpoint_missing: resume requires nonblank persisted target selectors");
      expect(await first.hasUnstartedSelectorCheckpoint()).toBe(kind === "untouched");
      if (kind !== "untouched") {
        await expect(RevisionWorkspace.reviseFromTerminalFailure(root, manifest.job_id, manifest.target_id)).rejects.toThrow(/trusted selector checkpoint/u);
        return;
      }
      const next = await RevisionWorkspace.reviseFromTerminalFailure(root, manifest.job_id, manifest.target_id);
      expect(await readFile(next.workingSelectorPath, "utf8")).toBe(before);
      expect(await next.readState()).toMatchObject({ status: "working", opened_evidence_ids: ["e1"], validation_attempts: 0 });
      expect((await first.readState()).status).toBe("failed");
      expect(await next.hasUnstartedSelectorCheckpoint()).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
  },
);

function manifestForEntries(entries: Array<{ evidenceId: string; text: string }>): EvidenceManifest {
  const markdown = entries.map((entry) => entry.text).join("\n");
  return {
    schema_version: EVIDENCE_SCHEMA_VERSION,
    job_id: "sealed-checkpoint-job",
    target_id: "target:sealed-checkpoint",
    source: {
      adapter: "document-domain-agent/v1",
      file_name: "source.md",
      sha256: sha256Text(markdown),
      semantic_workflow: SEMANTIC_EVIDENCE_SCHEMA_VERSION,
    },
    scope: {
      schema_version: EVIDENCE_SCOPE_SCHEMA_VERSION,
      mode: "agent_discovered",
      target_id: "target:sealed-checkpoint",
      source_line_count: entries.length,
      selected_start_line: 0,
      selected_end_exclusive_line: entries.length,
      selected_heading: "",
      selection_reason: "Formatting-neutral sealed checkpoint fixture.",
      selected_atom_ids: entries.map((entry) => entry.evidenceId),
      target_evidence_fragments: entries.map((entry) => ({
        atom_id: entry.evidenceId,
        text: entry.text,
      })),
      candidates: [],
    },
    evidence: entries.map((entry, index) => ({
      evidence_id: entry.evidenceId,
      kind: "paragraph",
      role: "supporting_clause",
      locator: `fixture:${index}`,
      text: entry.text,
      text_sha256: sha256Text(entry.text),
      requires_disposition: true,
      evidence_scope: "primary",
    })),
    table_fragments: [],
    reference_occurrences: [],
    evidence_fingerprint: sha256Text(`sealed-checkpoint\0${markdown}`),
  };
}

function manifestFor(text: string): EvidenceManifest {
  return manifestForEntries([{ evidenceId: "atom:sealed-checkpoint", text }]);
}

function legacyV4Selectors(manifest: EvidenceManifest, spanId: string): Record<string, unknown> {
  const field = (composition: "verbatim" | "semantic_summary", reason: string) => ({
    composition,
    span_ids: [spanId],
    separator: "",
    reason,
  });
  return {
    schema_version: "target-selector-plan/v4",
    job_id: manifest.job_id,
    target_id: manifest.target_id,
    lots: [{ key: "lot", name: "构件", scope_span_ids: [spanId], reason: "原封存检验批" }],
    items: [{
      key: "item",
      lot_key: "lot",
      name: "构件质量",
      category: "主控项目",
      criterion_span_ids: [spanId],
      continuation_span_ids: [],
      fields: {
        name: field("semantic_summary", "原封存名称"),
        requirement: field("verbatim", "原封存要求"),
        method: field("verbatim", "原封存方法"),
        quantity: field("verbatim", "原封存数量"),
        note: { composition: "not_applicable", span_ids: [], separator: "", reason: "无注释" },
      },
      table: null,
      inspection_data_type: "review",
      inspection_data_type_reason: "原封存分类",
      inspection_data_type_span_ids: [spanId],
      sampling: {
        status: "reference",
        rule_key: "rule",
        branch_keys: ["branch"],
        quantity_span_ids: [],
        script_span_ids: [],
        condition_span_ids: [],
        reason: "引用封存规则",
        confidence: 1,
      },
      reason: "原封存 item",
    }],
    sampling_rules: [{
      key: "rule",
      complete_span_ids: [spanId],
      branches: [{
        key: "branch",
        applies_to_category: "主控项目",
        minimum_span_ids: [spanId],
        script_span_ids: [spanId],
        condition_span_ids: [],
        reason: "旧 v4 分支",
      }],
      shared_conditions: [],
      reason: "旧 v4 规则",
    }],
    references: [],
    source_dispositions: [],
  };
}

async function sealedFixture(): Promise<{
  root: string;
  first: RevisionWorkspace;
  manifest: EvidenceManifest;
  legacyText: string;
  registryText: string;
}> {
  const root = join(tmpdir(), `pi-sealed-selector-${randomUUID()}`);
  const text = "构件应符合要求。抽查1件。采用目测检查。";
  const manifest = manifestFor(text);
  const first = await RevisionWorkspace.createFromEvidence(
    root,
    manifest.job_id,
    manifest.target_id,
    { manifest, markdown: Buffer.from(text) },
  );
  const registry = await first.readSourceSpanRegistry();
  const spanId = registry.spans[0]!.span_id;
  const legacyText = prettyJson(legacyV4Selectors(manifest, spanId));
  await writeFile(first.workingSelectorPath, legacyText, "utf8");
  await writeFile(first.sealedPlanPath, await readFile(first.workingPlanPath), "utf8");
  await first.updateState((state) => { state.status = "sealed"; });
  return {
    root,
    first,
    manifest,
    legacyText,
    registryText: await readFile(first.sourceSpanRegistryPath, "utf8"),
  };
}

async function multiEvidenceSealedFixture(): Promise<{
  root: string;
  first: RevisionWorkspace;
  manifest: EvidenceManifest;
  selectorText: string;
  registryText: string;
  evidenceIds: { first: string; second: string; unreferenced: string };
  spanIds: { first: string; second: string; unreferenced: string };
}> {
  const root = join(tmpdir(), `pi-sealed-selector-opened-${randomUUID()}`);
  const evidenceIds = {
    first: "atom:f81595-selector-source",
    second: "atom:3af9-selector-source",
    unreferenced: "atom:registry-only-source",
  };
  const entries = [
    { evidenceId: evidenceIds.first, text: "第一项验收要求。" },
    { evidenceId: evidenceIds.second, text: "第二项检验方法。" },
    { evidenceId: evidenceIds.unreferenced, text: "已登记但未被 selector 使用的相邻证据。" },
  ];
  const markdown = entries.map((entry) => entry.text).join("\n");
  const manifest = manifestForEntries(entries);
  const first = await RevisionWorkspace.createFromEvidence(
    root,
    manifest.job_id,
    manifest.target_id,
    { manifest, markdown: Buffer.from(markdown) },
  );
  const registry = await first.readSourceSpanRegistry();
  const spanFor = (evidenceId: string): string => {
    const spanId = registry.spans.find((span) => span.evidence_id === evidenceId)?.span_id;
    if (!spanId) throw new Error(`Missing fixture span for ${evidenceId}`);
    return spanId;
  };
  const spanIds = {
    first: spanFor(evidenceIds.first),
    second: spanFor(evidenceIds.second),
    unreferenced: spanFor(evidenceIds.unreferenced),
  };
  const selectors = legacyV4Selectors(manifest, spanIds.first) as any;
  selectors.items[0].continuation_span_ids = [spanIds.second];
  selectors.items[0].fields.method.span_ids = [spanIds.second];
  selectors.items[0].reason = `说明文字提到 ${spanIds.unreferenced}，但它不是 selector 绑定。`;
  const selectorText = prettyJson(selectors);
  await writeFile(first.workingSelectorPath, selectorText, "utf8");
  await writeFile(first.sealedSelectorPath, selectorText, "utf8");
  await writeFile(first.sealedPlanPath, await readFile(first.workingPlanPath), "utf8");
  await first.updateState((state) => {
    state.status = "sealed";
    state.opened_evidence_ids = [evidenceIds.first];
    state.opened_evidence_window_keys = [`${evidenceIds.first}:window:0`];
    state.opened_global_resource_ids = ["global:already-opened"];
  });
  return {
    root,
    first,
    manifest,
    selectorText,
    registryText: await readFile(first.sourceSpanRegistryPath, "utf8"),
    evidenceIds,
    spanIds,
  };
}

describe("sealed selector checkpoint lineage", () => {
  test.each(["scope_extension_required", "selector_stage_incomplete"])("restores a verified earlier modeling checkpoint and retains retry progress after %s",async terminalReason=>{
    const root=join(tmpdir(),`pi-complete-handoff-${randomUUID()}`);
    const manifest=manifestFor("构件质量应符合要求。抽查1件；遇特殊情况应加倍检查。");
    try{
      const first=await RevisionWorkspace.createFromEvidence(root,manifest.job_id,manifest.target_id,{manifest,markdown:Buffer.from(manifest.evidence[0]!.text)});
      const registry=await first.readSourceSpanRegistry();
      const selectors=migrateTargetSelectorPlanForAuthoring(legacyV4Selectors(manifest,registry.spans[0]!.span_id)).plan;
      selectors.items[0]!.fields.note={composition:"verbatim",span_ids:[registry.spans[0]!.span_id],separator:"",reason:"保留条件和例外"};
      const selectorText=prettyJson(selectors);
      await first.writeWorkingSelectors(selectorText);
      await atomicWriteJson(join(first.historyDirectory,"000001.json"),{schema_version:"selector-history/v1",sequence:1,after_sha256:sha256Text(selectorText)});
      await first.updateState(s=>{
        s.next_history_sequence=2;s.selector_stage="sampling";s.status="failed";s.terminal_reason=terminalReason;
        s.selector_protocol!.stage_retries={stage:"sampling",best_stage_rank:1,best_issue_count:2,consecutive_non_improvements:terminalReason==="selector_stage_incomplete"?3:1};
      });
      const handles=await ModelSourceHandles.open(first.root);
      await handles.encode({span_ids:[registry.spans[0]!.span_id]});
      const proof={revision:1,selector_sha256:sha256Text(selectorText),registry_sha256:sha256Text(await readFile(first.sourceSpanRegistryPath,"utf8")),evidence_sha256:sha256Text(await readFile(first.evidenceManifestPath,"utf8")),markdown_sha256:sha256Text(await readFile(first.sourceMarkdownPath,"utf8")),source_handle_map_sha256:sha256Text(await readFile(handles.mapPath,"utf8"))};
      const empty=await RevisionWorkspace.createFromEvidence(root,manifest.job_id,manifest.target_id,{manifest,markdown:Buffer.from(manifest.evidence[0]!.text)});
      expect(empty.revision).toBe(2);
      await expect(RevisionWorkspace.reviseFromModelingCheckpoint(root,manifest.job_id,manifest.target_id,{...proof,selector_sha256:"wrong"})).rejects.toThrow(/hash_mismatch/u);
      const next=await RevisionWorkspace.reviseFromModelingCheckpoint(root,manifest.job_id,manifest.target_id,proof);
      expect(next.revision).toBe(3);
      expect(await readFile(next.workingSelectorPath,"utf8")).toBe(selectorText);
      expect(await readFile(next.sourceSpanRegistryPath,"utf8")).toBe(await readFile(first.sourceSpanRegistryPath,"utf8"));
      expect(await next.readState()).toMatchObject({status:"working",selector_stage:"sampling",last_valid_fingerprint:"",lineage:{source_revision:1,recovery_kind:"modeling_checkpoint"}});
      expect((await next.readState()).selector_protocol?.stage_retries).toEqual((await first.readState()).selector_protocol?.stage_retries);
      const handoff=JSON.parse(await readFile(join(next.root,"modeling-handoff.json"),"utf8"));
      expect(handoff).toMatchObject({checkpoint_verified:true,validation_status:"unvalidated_draft",selector_stage:"sampling",shared_sampling_rules:selectors.sampling_rules,references:selectors.references,unresolved:{previous_terminal_reason:terminalReason}});
      expect(await readdir(next.piSessionDirectory)).toEqual([]);
      await expect(readFile(next.lastValidPlanPath)).rejects.toThrow();
      const newHandles=await ModelSourceHandles.open(next.root);
      expect(newHandles.scope).not.toBe(handles.scope);
      await expect(newHandles.decodeArguments({span_ids:["s1"],source_handle_scope:handles.scope})).rejects.toMatchObject({code:"source_handle_scope_mismatch"});
      const context=await (await ToolController.create(next)).dispatch("get_target_context",{});
      expect(context.checkpoint_handoff).toMatchObject({revision:3,source_revision:1,checkpoint_verified:true});
      const changed=structuredClone(selectors);
      changed.items[0]!.name="更新后项目名称";
      await next.writeWorkingSelectors(prettyJson(changed));
      const refreshed=await (await ToolController.create(next)).dispatch("get_target_context",{});
      expect(refreshed.checkpoint_handoff).toMatchObject({snapshot_status:"updated_since_restore",proof_applies_to:"original_restoration_only",item_inventory:[{name:"更新后项目名称"}]});
      expect(await readFile(first.workingSelectorPath,"utf8")).toBe(selectorText);
    }finally{await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
  });

  test.each(["sealed", "interrupted", "terminal"] as const)("%s recovery retains exact table authoring decisions and validates them normally", async kind => {
    const root = join(tmpdir(), `pi-table-recovery-${randomUUID()}`);
    try {
      const markdown = "表 A 构件检查\n\n<table><tr><td>项目</td><td>允许值</td><td>检验方法</td></tr><tr><td>属性甲</td><td>4</td><td>仪器检查</td></tr></table>";
      const manifest = manifestFor(markdown);
      const structured = buildStructuredTargetEvidence(markdown, manifest.source.sha256, [{ start_line: 1, end_exclusive_line: 4 }], false);
      manifest.evidence = structured.evidence;
      manifest.table_fragments = structured.table_fragments;
      const first = await RevisionWorkspace.createFromEvidence(root, manifest.job_id, manifest.target_id, { manifest, markdown: Buffer.from(markdown) });
      const registry = await first.readSourceSpanRegistry();
      const selectors = migrateTargetSelectorPlanForAuthoring(legacyV4Selectors(manifest, registry.spans[0]!.span_id)).plan;
      await first.writeWorkingSelectors(prettyJson(selectors));
      const structure = initialTableStructurePlan(manifest, registry);
      const table = structure.tables[0]!;
      table.status = "confirmed";
      table.header_rows = manifest.table_fragments[0]!.header_evidence_ids;
      table.data_rows = table.review_rows.filter(id => !table.header_rows.includes(id));
      table.review_rows = [];
      table.reason = "模型已保存的结构判断。";
      // Invalid pending author edits must survive too; recovery cannot certify them.
      table.repeated_header_rows = [...table.header_rows];
      const structurePath = join(first.root, "table-structure.json");
      await atomicWriteJson(structurePath, structure);
      const structureText = await readFile(structurePath, "utf8");
      const repairWork = { schema_version: "selector-repair-work/v1", source_sha256: manifest.source.sha256,
        focus: { identity: "neutral-saved-obligation", code: "neutral", path: "/items", diagnostic_cursor: 0 },
        convergence: { blockers: [{ identity: "neutral-saved-obligation", fingerprint: "unchanged", unchanged_rounds: 2 }] } };
      await atomicWriteJson(join(first.root, "selector-repair-work.json"), repairWork);
      await first.updateState(state => {
        state.selector_stage = "table";
        state.selector_protocol!.stage_retries = { stage: "table", best_stage_rank: 1.5, best_issue_count: 3, consecutive_non_improvements: 2 };
      });
      if (kind === "terminal") {
        const checkpoint = await targetModelingCheckpointSnapshot(first);
        await first.markTerminal("failed", `target_modeling_phase_budget_exceeded: ${JSON.stringify({ durable_checkpoint: checkpoint })}`);
      } else {
        await writeFile(first.sealedPlanPath, await readFile(first.workingPlanPath));
        await first.updateState(state => { state.status = kind === "sealed" ? "sealed" : "working"; });
      }
      const next = kind === "terminal"
        ? await RevisionWorkspace.reviseFromTerminalFailure(root, manifest.job_id, manifest.target_id, { resumeModelingPhaseBudget: true })
        : kind === "sealed"
          ? await RevisionWorkspace.reviseFromSealed(root, manifest.job_id, manifest.target_id)
          : await RevisionWorkspace.reviseFromInterruptedSeal(root, manifest.job_id, manifest.target_id);
      expect(await readFile(join(next.root, "table-structure.json"), "utf8")).toBe(structureText);
      expect(JSON.parse(await readFile(join(next.root, "selector-repair-work.json"), "utf8"))).toEqual(repairWork);
      await writeFile(join(next.root, "table-structure.json"), structureText);
      expect(await readFile(structurePath, "utf8")).toBe(structureText);
      expect(await (await ToolController.create(next)).dispatch("read_saved_table_structure", {}))
        .toMatchObject({ ok: true, structure: { tables: [{ status: "confirmed", repeated_header_rows: table.header_rows }] } });
      expect(validateTableStructurePlan(structure, await next.readEvidenceManifest(), await next.readSourceSpanRegistry()))
        .toEqual(expect.arrayContaining([expect.objectContaining({ code: "table_structure_row_partition_invalid" })]));
      expect((await next.readState()).last_valid_fingerprint).toBe("");
      if (kind !== "sealed") expect((await next.readState()).selector_protocol?.stage_retries)
        .toEqual((await first.readState()).selector_protocol?.stage_retries);
    } finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  });

  test.each(["preserved", "wrong-hash", "wrong-revision", "changed-selector", "changed-registry", "changed-evidence", "changed-pdf", "invalid-table"])(
    "explicit table checkpoint restoration verifies all inputs and preserves current budgets: %s", async variant => {
      const root = join(tmpdir(), `pi-table-checkpoint-proof-${randomUUID()}`);
      try {
        const markdown = "表 A 构件检查\n\n<table><tr><td>项目</td><td>允许值</td><td>检验方法</td></tr><tr><td>属性甲</td><td>4</td><td>仪器检查</td></tr></table>";
        const manifest = manifestFor(markdown);
        const structured = buildStructuredTargetEvidence(markdown, manifest.source.sha256, [{ start_line: 1, end_exclusive_line: 4 }], false);
        manifest.evidence = structured.evidence;
        manifest.table_fragments = structured.table_fragments;
        const first = await RevisionWorkspace.createFromEvidence(root, manifest.job_id, manifest.target_id, { manifest, markdown: Buffer.from(markdown), pdf: Buffer.from("original PDF bytes") });
        const registry = await first.readSourceSpanRegistry();
        await first.writeWorkingSelectors(prettyJson(migrateTargetSelectorPlanForAuthoring(legacyV4Selectors(manifest, registry.spans[0]!.span_id)).plan));
        const structure = initialTableStructurePlan(manifest, registry);
        const table = structure.tables[0]!;
        table.status = "confirmed";
        table.header_rows = manifest.table_fragments[0]!.header_evidence_ids;
        table.data_rows = table.review_rows.filter(id => !table.header_rows.includes(id));
        table.review_rows = [];
        table.reason = "此前模型保存的结构判断。";
        if (variant === "invalid-table") table.repeated_header_rows = [...table.header_rows];
        await atomicWriteJson(join(first.root, "table-structure.json"), structure);
        const structureText = await readFile(join(first.root, "table-structure.json"), "utf8");
        await first.updateState(state => {
          state.selector_stage = "table";
          state.selector_protocol!.last_stage_issues = [{ code: "selector_table_expansion_obligations_pending", path: "/items" }];
        });
        await first.markTerminal("failed", `target_modeling_phase_budget_exceeded: ${JSON.stringify({ durable_checkpoint: await targetModelingCheckpointSnapshot(first) })}`);
        const second = await RevisionWorkspace.reviseFromTerminalFailure(root, manifest.job_id, manifest.target_id, { resumeModelingPhaseBudget: true });
        // Reproduce a historical recovery that omitted the saved table draft.
        await atomicWriteJson(join(second.root, "table-structure.json"), initialTableStructurePlan(manifest, registry));
        const changedPath = variant === "changed-selector" ? second.workingSelectorPath
          : variant === "changed-registry" ? second.sourceSpanRegistryPath
          : variant === "changed-evidence" ? second.evidenceManifestPath : undefined;
        if (changedPath) {
          if (changedPath === second.evidenceManifestPath) await chmod(changedPath, 0o644);
          await writeFile(changedPath, (await readFile(changedPath, "utf8")) + "\n");
        }
        if (variant === "changed-pdf") {
          await chmod(second.sourcePdfPath, 0o644);
          await writeFile(second.sourcePdfPath, "changed PDF bytes");
        }
        const checkpoint = await targetModelingCheckpointSnapshot(second);
        await second.updateState(state => {
          state.selector_protocol!.stage_retries = { stage: "table", best_stage_rank: 1.5, best_issue_count: 3, consecutive_non_improvements: 3, checkpoint };
          state.selector_protocol!.last_stage_issues = [{ code: "table_structure_confirmation_pending", path: "/tables/0" }];
        });
        await second.markTerminal("failed", "selector_stage_incomplete");
        const beforeState = await second.readState();
        const recover = () => RevisionWorkspace.reviseFromTerminalFailure(root, manifest.job_id, manifest.target_id, {
          resumeModelingPhaseBudget: true,
          tableStructureCheckpoint: { revision: variant === "wrong-revision" ? 2 : 1, sha256: variant === "wrong-hash" ? "0".repeat(64) : sha256Text(structureText) },
        });
        if (variant !== "preserved") {
          await expect(recover()).rejects.toThrow(/table_structure_checkpoint_(identity_mismatch|hash_mismatch|inputs_changed|invalid)/u);
          expect((await RevisionWorkspace.openLatest(root, manifest.job_id, manifest.target_id)).revision).toBe(2);
        } else {
          const next = await recover();
          expect(await readFile(join(next.root, "table-structure.json"), "utf8")).toBe(structureText);
          expect(await readFile(next.workingSelectorPath, "utf8")).toBe(await readFile(second.workingSelectorPath, "utf8"));
          expect((await next.readState()).selector_protocol).toEqual({ ...beforeState.selector_protocol,
            last_stage_issues: (await first.readState()).selector_protocol!.last_stage_issues });
          expect((await next.readState()).last_valid_fingerprint).toBe("");
          expect(await readFile(join(next.root, "session.events.jsonl"), "utf8")).toContain('"table_structure_checkpoint_revision":1');
        }
        expect(await readFile(join(first.root, "table-structure.json"), "utf8")).toBe(structureText);
      } finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
    },
  );

  test.each(["missing-proof", "changed-proof", "preserved"])("modeling checkpoint verifies and retains author-saved table decisions: %s", async variant => {
    const root = join(tmpdir(), `pi-modeling-table-checkpoint-${randomUUID()}`);
    try {
      const markdown = "表 A 构件检查\n\n<table><tr><td>项目</td><td>允许值</td><td>检验方法</td></tr><tr><td>属性甲</td><td>4</td><td>仪器检查</td></tr></table>";
      const manifest = manifestFor(markdown);
      const structured = buildStructuredTargetEvidence(markdown,manifest.source.sha256,[{start_line:1,end_exclusive_line:4}],false);
      manifest.evidence = structured.evidence;
      manifest.table_fragments = structured.table_fragments;
      const first = await RevisionWorkspace.createFromEvidence(root,manifest.job_id,manifest.target_id,{manifest,markdown:Buffer.from(markdown)});
      const controller = await ToolController.create(first);
      for (const evidence of manifest.evidence) await controller.dispatch("open_evidence",{evidence_id:evidence.evidence_id});
      const registry = await first.readSourceSpanRegistry();
      const structure = initialTableStructurePlan(manifest,registry);
      expect(structure.tables).toHaveLength(1);
      const table = structure.tables[0]!;
      table.status = "confirmed";
      table.header_rows = manifest.table_fragments[0]!.header_evidence_ids;
      table.data_rows = table.review_rows.filter(id=>!table.header_rows.includes(id));
      table.review_rows = [];
      table.reason = "已读物理表题、表头及数据行，保存模型结构判断。";
      expect(await controller.dispatch("stage_table_structure",{table})).toMatchObject({ok:true});
      const structureText = await readFile(join(first.root,"table-structure.json"),"utf8");
      const selectorText = await readFile(first.workingSelectorPath,"utf8");
      await atomicWriteJson(join(first.historyDirectory,"000001.json"),{sequence:1,after_sha256:sha256Text(selectorText)});
      await first.updateState(s=>{s.next_history_sequence=2;s.selector_stage="table";s.status="failed";s.terminal_reason="selector_stage_incomplete";});
      const proof = { revision:1,selector_sha256:sha256Text(selectorText),registry_sha256:sha256Text(await readFile(first.sourceSpanRegistryPath,"utf8")),
        evidence_sha256:sha256Text(await readFile(first.evidenceManifestPath,"utf8")),markdown_sha256:manifest.source.sha256,
        ...(variant==="missing-proof"?{}:{table_structure_sha256:variant==="changed-proof"?"0".repeat(64):sha256Text(structureText)}) };
      if (variant!=="preserved") {
        await expect(RevisionWorkspace.reviseFromModelingCheckpoint(root,manifest.job_id,manifest.target_id,proof))
          .rejects.toThrow("modeling_checkpoint_table_structure_hash_mismatch");
        expect((await RevisionWorkspace.openLatest(root,manifest.job_id,manifest.target_id)).revision).toBe(1);
      } else {
        const next = await RevisionWorkspace.reviseFromModelingCheckpoint(root,manifest.job_id,manifest.target_id,proof);
        expect(await readFile(join(next.root,"table-structure.json"),"utf8")).toBe(structureText);
        expect(await (await ToolController.create(next)).dispatch("read_saved_table_structure",{}))
          .toMatchObject({ok:true,structure:{tables:[{status:"confirmed",header_rows:table.header_rows,data_rows:table.data_rows}]}});
        expect(await readFile(first.workingSelectorPath,"utf8")).toBe(selectorText);
      }
    } finally { await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100}); }
  });

  test.each([
    ["phase", "unchanged"], ["phase", "changed_draft"], ["phase", "changed_source_span"],
    ["stage", "unchanged"], ["stage", "changed_draft"], ["stage", "changed_source_span"],
  ])("explicit %s budget resume preserves only its exact unvalidated checkpoint: %s", async (budget, change) => {
    const root = join(tmpdir(), `pi-modeling-resume-${randomUUID()}`);
    const manifest = manifestFor("构件应符合要求。抽查1件。采用目测检查。");
    try {
      const first = await RevisionWorkspace.createFromEvidence(root, manifest.job_id, manifest.target_id, {
        manifest, markdown: Buffer.from(manifest.evidence[0]!.text),
      });
      const registry = await first.readSourceSpanRegistry();
      const selectors = migrateTargetSelectorPlanForAuthoring(legacyV4Selectors(manifest, registry.spans[0]!.span_id)).plan;
      const text = prettyJson(selectors);
      await first.writeWorkingSelectors(text);
      await first.updateState(state => { state.selector_stage = "sampling"; });
      if (budget === "stage") {
        const controller = await ToolController.create(first);
        // Reproduce an exhausted legacy check for recovery verification,
        // independently of the current author-work admission guard.
        const admission = vi.spyOn(controller, "selectorRepairWork").mockResolvedValue(undefined);
        const validate = vi.spyOn(controller as any, "validateSelectorStageCompleteness")
          .mockResolvedValue({ ok: false, issues: [{ code: "selector_sampling_decision_pending", path: "/items/0/sampling/status", message: "抽样尚未完成" }] });
        for (let count = 0; count <= 3; count++) {
          // Exhaustion needs changed attempts; unchanged checks reuse their
          // receipt. Finish on the original bytes to test exact recovery.
          const attempt = structuredClone(selectors);
          if (count > 0 && count < 3) attempt.lots[0]!.reason += ` 未改善尝试${count}`;
          await first.writeWorkingSelectors(prettyJson(attempt));
          expect(await controller.dispatch("advance_target_selector_stage", { next_stage: "table" }))
            .toMatchObject({ terminal: count === 3, stage_retry: { count } });
        }
        validate.mockRestore();
        admission.mockRestore();
      }
      const checkpoint = await targetModelingCheckpointSnapshot(first);
      if (budget === "stage") expect((await first.readState()).selector_protocol?.stage_retries?.checkpoint).toEqual(checkpoint);
      await first.updateState(state => {
        state.status = "failed";
        state.terminal_reason = budget === "phase"
          ? `target_modeling_phase_budget_exceeded: ${JSON.stringify({ durable_checkpoint: checkpoint })}`
          : "selector_stage_incomplete";
      });
      // The terminal budget remains terminal unless the caller explicitly opts in.
      await expect(RevisionWorkspace.reviseFromTerminalFailure(root, manifest.job_id, manifest.target_id)).rejects.toThrow(/trusted selector checkpoint/u);
      if (change === "changed_draft") await writeFile(first.workingSelectorPath, text + " ", "utf8");
      if (change === "changed_source_span") {
        registry.spans[0]!.text_sha256 = "0".repeat(64);
        await atomicWriteJson(first.sourceSpanRegistryPath, registry);
      }
      const recover = () => RevisionWorkspace.reviseFromTerminalFailure(root, manifest.job_id, manifest.target_id, { resumeModelingPhaseBudget: true });
      if (change !== "unchanged") {
        await expect(recover()).rejects.toThrow(/trusted selector checkpoint/u);
        return;
      }
      const next = await recover();
      expect(await readFile(next.workingSelectorPath, "utf8")).toBe(text);
      expect(await next.readState()).toMatchObject({
        status: "working", selector_stage: "sampling", last_valid_fingerprint: "", last_valid_plan_sha256: "",
        selector_protocol: { submissions: 0, coverage_repairs: 0 }, lineage: { source_revision: 1, recovery_kind: "terminal_checkpoint" },
      });
      await expect(readFile(next.lastValidPlanPath)).rejects.toThrow();
      await expect(readFile(next.manifestPath)).rejects.toThrow();
      expect((await ToolController.create(next)).selectorStartupContext().current_selector_checkpoint).toBe("unvalidated_draft");
      if (budget === "stage") expect((await next.readState()).selector_protocol?.stage_retries)
        .toEqual((await first.readState()).selector_protocol?.stage_retries);
      expect((await first.readState()).status).toBe("failed");
      expect(await readFile(first.workingSelectorPath, "utf8")).toBe(text);
    } finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  });

  test("inherits a nonblank selector checkpoint across interrupted-seal recovery", async () => {
    const { root, first } = await sealedFixture();
    try {
      await first.updateState((state) => { state.status = "working"; });
      const before = migrateTargetSelectorPlanForAuthoring(
        JSON.parse(await readFile(first.workingSelectorPath, "utf8")),
      ).plan;
      const recovered = await RevisionWorkspace.reviseFromInterruptedSeal(
        root,
        first.jobId,
        first.targetId,
      );
      const after = migrateTargetSelectorPlanForAuthoring(
        JSON.parse(await readFile(recovered.workingSelectorPath, "utf8")),
      ).plan;

      expect(targetSelectorFingerprint(after)).toBe(targetSelectorFingerprint(before));
      expect(after.lots).toEqual(before.lots);
      expect(after.items).toEqual(before.items);
      expect(await recovered.readState()).toMatchObject({
        lineage: {
          source_revision: first.revision,
          selector_checkpoint_revision: first.revision,
          recovery_kind: "interrupted_checkpoint",
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  test("rebuilds opened evidence from the inherited sealed selector without opening unrelated registry entries", async () => {
    const fixture = await multiEvidenceSealedFixture();
    try {
      const ancestorStateBytes = await readFile(fixture.first.statePath, "utf8");
      const second = await RevisionWorkspace.reviseFromSealed(
        fixture.root,
        fixture.manifest.job_id,
        fixture.manifest.target_id,
      );
      const state = await second.readState();
      expect(state.opened_evidence_ids).toEqual([
        fixture.evidenceIds.second,
        fixture.evidenceIds.first,
      ].sort());
      expect(state.opened_evidence_ids).not.toContain(fixture.evidenceIds.unreferenced);
      expect(state.opened_evidence_window_keys).toEqual([`${fixture.evidenceIds.first}:window:0`]);
      expect(state.opened_global_resource_ids).toEqual(["global:already-opened"]);
      expect(await readFile(fixture.first.statePath, "utf8")).toBe(ancestorStateBytes);
      expect(await readFile(fixture.first.workingSelectorPath, "utf8")).toBe(fixture.selectorText);
      expect(await readFile(fixture.first.sourceSpanRegistryPath, "utf8")).toBe(fixture.registryText);
    } finally {
      await rm(fixture.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  test("merges partially opened evidence from a trusted terminal selector checkpoint", async () => {
    const fixture = await multiEvidenceSealedFixture();
    try {
      const failed = await RevisionWorkspace.reviseFromSealed(
        fixture.root,
        fixture.manifest.job_id,
        fixture.manifest.target_id,
      );
      await failed.updateState((state) => {
        state.status = "failed";
        state.terminal_reason = "target_blocked_with_evidence";
        state.opened_evidence_ids = [fixture.evidenceIds.first];
        state.opened_evidence_window_keys = [`${fixture.evidenceIds.first}:window:0`];
        state.opened_global_resource_ids = ["global:already-opened"];
      });
      const failedStateBytes = await readFile(failed.statePath, "utf8");

      const recovered = await RevisionWorkspace.reviseFromTerminalFailure(
        fixture.root,
        fixture.manifest.job_id,
        fixture.manifest.target_id,
      );
      const state = await recovered.readState();
      expect(state).toMatchObject({
        status: "working",
        opened_evidence_window_keys: [`${fixture.evidenceIds.first}:window:0`],
        opened_global_resource_ids: ["global:already-opened"],
        lineage: {
          source_revision: 2,
          selector_checkpoint_revision: 2,
          registry_checkpoint_revision: 2,
          recovery_kind: "terminal_checkpoint",
        },
      });
      expect(state.opened_evidence_ids).toEqual([
        fixture.evidenceIds.second,
        fixture.evidenceIds.first,
      ].sort());
      expect(state.opened_evidence_ids).not.toContain(fixture.evidenceIds.unreferenced);
      expect(await readFile(failed.statePath, "utf8")).toBe(failedStateBytes);
    } finally {
      await rm(fixture.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  test("recovers the external-dependency terminal checkpoint into an eligible coverage repair", async () => {
    const fixture = await sealedFixture();
    try {
      const failed = await RevisionWorkspace.reviseFromSealed(
        fixture.root,
        fixture.manifest.job_id,
        fixture.manifest.target_id,
      );
      await failed.updateState((state) => {
        state.status = "failed";
        state.terminal_reason = "external_dependency_must_precede_selector_submission";
        state.validation_attempts = 1;
        state.selector_stage = "coverage_repair";
        state.selector_protocol!.submissions = 1;
        state.last_valid_fingerprint = "";
        state.last_valid_plan_sha256 = "";
        state.repair = {
          ...state.repair!,
          mode: "repair",
          repair_source: "coverage",
          coverage_review_fingerprint: "f".repeat(64),
          coverage_finding_ids: ["finding:missing-external-dependency"],
          coverage_evidence_ids: [fixture.manifest.evidence[0]!.evidence_id],
          coverage_item_ids: ["item:referenced-table"],
        };
      });

      const recovered = await RevisionWorkspace.reviseFromTerminalFailure(
        fixture.root,
        fixture.manifest.job_id,
        fixture.manifest.target_id,
      );
      const state = await recovered.readState();
      expect(state).toMatchObject({
        status: "working",
        validation_attempts: 1,
        selector_stage: "coverage_repair",
        selector_protocol: { submissions: 1 },
        repair: {
          mode: "repair",
          repair_source: "coverage",
          coverage_finding_ids: ["finding:missing-external-dependency"],
        },
      });
      expect(coverageRepairAllowsExternalDependency(state)).toBe(true);
      expect((await ToolController.create(recovered)).selectorProviderPolicy())
        .toMatchObject({
          stage: "coverage_repair",
          allowed_tools: expect.arrayContaining(["register_external_dependency"]),
        });
    } finally {
      await rm(fixture.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  test("clears copied Windows read-only attributes only inside the new authoring revision", async () => {
    const fixture = await sealedFixture();
    try {
      await writeFile(fixture.first.sealedSelectorPath, fixture.legacyText, "utf8");
      const ancestorPaths = [
        fixture.first.sealedPlanPath,
        fixture.first.sealedSelectorPath,
        fixture.first.sourceSpanRegistryPath,
      ];
      const ancestorHashes = new Map(await Promise.all(ancestorPaths.map(async (path) => [
        path,
        sha256Text(await readFile(path, "utf8")),
      ] as const)));
      for (const path of ancestorPaths) await chmod(path, 0o444);

      const second = await RevisionWorkspace.reviseFromSealed(
        fixture.root,
        fixture.manifest.job_id,
        fixture.manifest.target_id,
      );
      const existingAuthoringPaths = [
        second.workingPlanPath,
        second.workingSelectorPath,
        second.sourceSpanRegistryPath,
        second.statePath,
        second.transcriptPath,
      ];
      for (const path of existingAuthoringPaths) {
        await expect(access(path, constants.W_OK)).resolves.toBeUndefined();
        expect((await stat(path)).mode & 0o200).not.toBe(0);
      }

      const registry = await second.readSourceSpanRegistry();
      await expect(atomicWriteJson(second.sourceSpanRegistryPath, registry)).resolves.toBeUndefined();
      await expect(second.writeWorkingSelectors(
        await readFile(second.workingSelectorPath, "utf8"),
      )).resolves.toBeUndefined();
      expect((await readdir(second.root)).filter((name) => name.endsWith(".tmp"))).toEqual([]);

      for (const path of ancestorPaths) {
        expect(sha256Text(await readFile(path, "utf8"))).toBe(ancestorHashes.get(path));
        expect((await stat(path)).mode & 0o200).toBe(0);
      }
    } finally {
      await rm(fixture.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  test("carries v4 selectors and registry into a writable v5 revision without guessing roles", async () => {
    const fixture = await sealedFixture();
    try {
      const second = await RevisionWorkspace.reviseFromSealed(
        fixture.root,
        fixture.manifest.job_id,
        fixture.manifest.target_id,
      );
      const migrated = JSON.parse(await readFile(second.workingSelectorPath, "utf8"));
      expect(migrated).toMatchObject({
        schema_version: "target-selector-plan/v6",
        lots: [{ key: "lot" }],
        items: [{ key: "item", criterion_span_ids: expect.any(Array) }],
      });
      expect(migrated.items[0].criterion_span_ids).toEqual(
        (JSON.parse(fixture.legacyText) as any).items[0].criterion_span_ids,
      );
      expect(migrated.sampling_rules[0].branches[0].components.map((entry: any) => entry.role)).toEqual([
        "quantity",
        "method",
        "branch_condition",
      ]);
      expect(migrated.sampling_rules[0].branches[0].components).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ role: "applicability" }),
        expect.objectContaining({ role: "acceptance_criterion" }),
        expect.objectContaining({ role: "exception" }),
        expect.objectContaining({ role: "note" }),
      ]));
      expect(await readFile(second.sourceSpanRegistryPath, "utf8")).toBe(fixture.registryText);
      expect(await second.readState()).toMatchObject({
        lineage: {
          source_revision: 1,
          selector_checkpoint_revision: 1,
          registry_checkpoint_revision: 1,
          recovery_kind: "sealed_checkpoint",
        },
      });

      await second.updateState((state) => {
        state.selector_stage = "coverage_repair";
        state.repair!.repair_source = "coverage";
      });
      const controller = await ToolController.create(second);
      const incrementalDraft = {
        collection: "lots",
        draft: { lots: [{ ...migrated.lots[0], reason: "仅增量修改当前 finding" }] },
      };
      expect(controller.selectorStartupContext()).toMatchObject({
        current_selector_state: "inherited_existing",
        read_target_selectors_required: true,
      });
      expect(await controller.dispatch("stage_target_selector_draft", incrementalDraft)).toMatchObject({
        ok: false,
        error: "inherited_selector_read_required",
        required_tool: "read_target_selectors",
        budget_consumed: false,
      });
      expect(JSON.parse(await readFile(second.workingSelectorPath, "utf8"))).toEqual(migrated);
      expect(await controller.dispatch("read_target_selectors", {})).toMatchObject({
        ok: true,
        summary: { counts: { lots: 1, items: 1, sampling_rules: 1 } },
      });
      const staged = await controller.dispatch("stage_target_selector_draft", incrementalDraft);
      expect(staged.ok).toBe(true);
      const after = JSON.parse(await readFile(second.workingSelectorPath, "utf8"));
      expect(after.lots[0].reason).toBe("仅增量修改当前 finding");
      expect(after.items).toEqual(migrated.items);
      expect(staged).toMatchObject({ draft_status: "saved_local_validation_passed", budget_consumed: false });
      // Coverage repair staging remains globally unvalidated. Its local check and
      // readable checkpoint still expose migration gaps; saving must not hide them.
      const checkpoint = await controller.dispatch("read_target_selectors", {});
      expect((checkpoint.summary as { migration_issues: Array<{ code: string }> }).migration_issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "selector_sampling_component_migration_required" }),
      ]));

      expect(await readFile(fixture.first.workingSelectorPath, "utf8")).toBe(fixture.legacyText);
      expect(await readFile(fixture.first.sourceSpanRegistryPath, "utf8")).toBe(fixture.registryText);
    } finally {
      await rm(fixture.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  test("recovers a legacy failed blank revision from its nearest sealed ancestor", async () => {
    const fixture = await sealedFixture();
    try {
      const legacyFailed = await RevisionWorkspace.reviseFromSealed(
        fixture.root,
        fixture.manifest.job_id,
        fixture.manifest.target_id,
      );
      await writeFile(legacyFailed.workingSelectorPath, prettyJson({
        schema_version: "target-selector-plan/v6",
        job_id: fixture.manifest.job_id,
        target_id: fixture.manifest.target_id,
        lots: [], items: [], sampling_rules: [], references: [], source_dispositions: [],
      }), "utf8");
      await writeFile(legacyFailed.sourceSpanRegistryPath, "{\"legacy_broken\":true}\n", "utf8");
      await legacyFailed.updateState((state) => {
        delete state.lineage;
        state.status = "failed";
        state.terminal_reason = "target_blocked_with_evidence";
        state.selector_stage = "coverage_repair";
        state.repair!.repair_source = "coverage";
        state.repair!.coverage_finding_ids = ["finding:preserved"];
      });
      const failedSelectorBytes = await readFile(legacyFailed.workingSelectorPath, "utf8");

      const recovered = await RevisionWorkspace.reviseFromTerminalFailure(
        fixture.root,
        fixture.manifest.job_id,
        fixture.manifest.target_id,
      );
      const selectors = JSON.parse(await readFile(recovered.workingSelectorPath, "utf8"));
      expect(selectors).toMatchObject({
        schema_version: "target-selector-plan/v6",
        lots: [{ key: "lot" }],
        items: [{ key: "item" }],
      });
      expect(await readFile(recovered.sourceSpanRegistryPath, "utf8")).toBe(fixture.registryText);
      expect(await readFile(recovered.lastValidPlanPath, "utf8")).toBe(
        await readFile(fixture.first.sealedPlanPath, "utf8"),
      );
      expect(await recovered.readState()).toMatchObject({
        status: "working",
        selector_stage: "coverage_repair",
        repair: { coverage_finding_ids: ["finding:preserved"] },
        lineage: {
          source_revision: 2,
          selector_checkpoint_revision: 1,
          registry_checkpoint_revision: 1,
          recovery_kind: "terminal_sealed_ancestor",
        },
      });
      expect(await readFile(legacyFailed.workingSelectorPath, "utf8")).toBe(failedSelectorBytes);
    } finally {
      await rm(fixture.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  test.each([false, true])("recovers a compiler-invariant terminal draft after compiler repair, retaining author diagnostics (unhandled=%s)", async unhandled => {
    const root = join(tmpdir(), `pi-compiler-replay-${randomUUID()}`);
    const manifest = manifestFor("构件应符合要求。抽查1件。采用目测检查。");
    if (unhandled) manifest.evidence.push({ ...manifest.evidence[0]!,
      evidence_id: "atom:neutral-unassigned-source", locator: "line:9",
      text: "附件另有记录。", text_sha256: sha256Text("附件另有记录。"), requires_disposition: true,
    });
    try {
      const failed = await RevisionWorkspace.createFromEvidence(root, manifest.job_id, manifest.target_id, {
        manifest,
        markdown: Buffer.from(manifest.evidence[0]!.text),
      });
      let registry = await failed.readSourceSpanRegistry();
      const record = manifest.evidence[0]!;
      const source = {
        source_id: record.evidence_id,
        evidence_id: record.evidence_id,
        atom_id: record.evidence_id,
        text: record.text,
      };
      const spanFor = (quote: string): string => {
        const start = record.text.indexOf(quote);
        const registered = registerSourceSpan(registry, source, start, start + quote.length);
        registry = registered.registry;
        return registered.span.span_id;
      };
      const nameSpan = spanFor("构件");
      const requirementSpan = spanFor("构件应符合要求");
      const quantitySpan = spanFor("抽查1件");
      const methodSpan = spanFor("采用目测检查");
      await atomicWriteJson(failed.sourceSpanRegistryPath, registry);
      const selectors = migrateTargetSelectorPlanForAuthoring(
        legacyV4Selectors(manifest, registry.spans[0]!.span_id),
      ).plan;
      selectors.lots[0]!.scope_span_ids = [requirementSpan];
      selectors.items[0]!.name = "构件";
      selectors.items[0]!.criterion_span_ids = [requirementSpan, quantitySpan, methodSpan];
      selectors.items[0]!.fields.name = { composition: "verbatim", span_ids: [nameSpan], separator: "", reason: "原文对象名" };
      selectors.items[0]!.fields.requirement = { composition: "verbatim", span_ids: [requirementSpan], separator: "", reason: "原文要求" };
      selectors.items[0]!.fields.quantity = { composition: "verbatim", span_ids: [quantitySpan], separator: "", reason: "原文数量" };
      selectors.items[0]!.fields.method = { composition: "verbatim", span_ids: [methodSpan], separator: "", reason: "原文方法" };
      selectors.items[0]!.sampling = {
        status: "explicit",
        rule_key: "",
        branch_keys: [],
        quantity_span_ids: [quantitySpan],
        script_span_ids: [quantitySpan],
        condition_span_ids: [],
        reason: "原文明确抽查数量",
        confidence: 1,
      };
      selectors.sampling_rules = [];
      const compiled = compileTargetSelectors(selectors, registry, manifest);
      const replayIssues = checkTargetCompilerInvariants(
        selectors,
        hydrateSemanticSourcePlan(compiled, manifest),
        manifest,
        compiled,
      );
      expect(replayIssues.map(issue => issue.code)).toEqual(unhandled ? ["compiler_unhandled_evidence"] : []);
      const selectorText = prettyJson(selectors);
      await failed.writeWorkingSelectors(selectorText);
      await failed.updateState((state) => {
        state.status = "failed";
        state.selector_stage = "commit";
        state.terminal_reason = "compiler_invariant_violation";
      });

      const recovered = await RevisionWorkspace.reviseFromTerminalFailure(
        root,
        manifest.job_id,
        manifest.target_id,
      );
      expect(await readFile(recovered.workingSelectorPath, "utf8")).toBe(selectorText);
      expect(await recovered.readState()).toMatchObject({
        status: "working",
        selector_stage: "commit",
        agent_runtime: { kind: "unassigned", session_id: "", session_file: "" },
        lineage: { source_revision: 1, recovery_kind: "terminal_checkpoint" },
      });
      expect((await failed.readState()).status).toBe("failed");
      if (unhandled) {
        const controller = await ToolController.create(recovered);
        const result = await controller.dispatch("commit_target_selector_draft", { draft_fingerprint: targetSelectorFingerprint(selectors) });
        expect(result, JSON.stringify(result)).toMatchObject({ ok: false, terminal: false, issue_owner: "selector_input_error" });
        expect(await access(recovered.sealedPlanPath).then(() => true, () => false)).toBe(false);
      }
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  test.each(["model-review", "structural-error", "unknown-error", "compiler-invariant"])(
    "compiler failure recovery uses the live structural boundary while retaining guards: %s", async mode => {
      const root = join(tmpdir(), `pi-compiler-boundary-${randomUUID()}`);
      const text = "基座平整度应不大于2格。检查方法见表7.5。用对照规读取最大偏差。随机抽查2组。";
      const manifest = manifestFor(text);
      let injected: { mockRestore(): void } | undefined;
      try {
        const failed = await RevisionWorkspace.createFromEvidence(root, manifest.job_id, manifest.target_id, { manifest, markdown: Buffer.from(text) });
        let registry = await failed.readSourceSpanRegistry();
        const evidenceId = manifest.evidence[0]!.evidence_id;
        const spanFor = (quote: string) => {
          const start = text.indexOf(quote);
          const saved = registerSourceSpan(registry, { source_id: evidenceId, evidence_id: evidenceId, atom_id: evidenceId, text }, start, start + quote.length);
          registry = saved.registry;
          return saved.span.span_id;
        };
        const name = spanFor("基座平整度"), criterion = spanFor("基座平整度应不大于2格"), navigation = spanFor("检查方法见表7.5"),
          method = spanFor("用对照规读取最大偏差"), quantity = spanFor("随机抽查2组");
        const selectors = migrateTargetSelectorPlanForAuthoring(legacyV4Selectors(manifest, criterion)).plan;
        const item = selectors.items[0]!;
        item.name = "基座平整度";
        item.criterion_span_ids = [criterion, navigation, method, quantity];
        const field = (span_ids: string[]) => ({ composition: "verbatim" as const, span_ids, separator: "\n", reason: "中性样本明确选择的来源" });
        item.fields.name = field([name]);
        item.fields.requirement = field([criterion]);
        item.fields.method = field([navigation, method]);
        item.fields.quantity = field([quantity]);
        item.table = { source_kind: "direct", table_key: "neutral-flatness", reference_span_ids: [navigation], reason: "保留作者的来源角色判断",
          properties: { table_no_span_ids: [], table_title_span_ids: [], applicability_span_ids: [], row_path_span_ids: [[name]],
            column_path_span_ids: [], unit_span_ids: [], condition_span_ids: [], allowed_value_span_ids: [criterion], inspection_method_span_ids: [method] } };
        item.sampling = { status: "explicit", rule_key: "", branch_keys: [], quantity_span_ids: [quantity], script_span_ids: [quantity],
          condition_span_ids: [], reason: "明确抽查2组", confidence: 1 };
        selectors.sampling_rules = [];
        expect(() => compileTargetSelectors(selectors, registry, manifest)).toThrow(/selector_table_method_role_conflict/u);
        const reviewCodes: string[] = [];
        compileTargetSelectors(selectors, registry, manifest, { validationBoundary: STRUCTURAL_VALIDATION_BOUNDARY,
          onModelReview: issues => reviewCodes.push(...issues.map(issue => issue.code)) });
        expect(reviewCodes).toContain("selector_table_method_role_conflict");
        if (mode === "structural-error") item.lot_key = "missing-lot";
        await atomicWriteJson(failed.sourceSpanRegistryPath, registry);
        const selectorText = prettyJson(selectors);
        await failed.writeWorkingSelectors(selectorText);
        await writeFile(join(failed.historyDirectory, "000001.json"), JSON.stringify({ after_sha256: sha256Text(selectorText), note: "中性历史记录" }));
        await failed.updateState(state => {
          state.status = "failed"; state.terminal_reason = "compiler_invariant_violation"; state.selector_stage = "table";
          state.next_history_sequence = 2; state.next_validation_sequence = 3; state.validation_attempts = 2;
          state.selector_protocol!.submissions = 2; state.selector_protocol!.corrections = 1;
          state.repair!.non_converging_rounds = 1;
        });
        const beforeState = await failed.readState();
        const names = ["state.json", "working.target-selectors.json", "source-span-registry.json", "evidence/evidence.json", "history/000001.json"];
        const beforeBytes = await Promise.all(names.map(file => readFile(join(failed.root, file))));
        if (mode === "unknown-error") injected = vi.spyOn(selectorCompiler, "compileTargetSelectors").mockImplementation(() => { throw new Error("neutral unexpected compiler exception"); });
        if (mode === "compiler-invariant") injected = vi.spyOn(compilerInvariants, "checkTargetCompilerInvariants").mockReturnValue([
          { code: "compiler_unknown_projection_fault", path: "/items", message: "neutral genuine compiler failure" },
        ]);
        if (mode !== "model-review") {
          await expect(RevisionWorkspace.reviseFromTerminalFailure(root, manifest.job_id, manifest.target_id)).rejects.toThrow(/trusted selector checkpoint/u);
          expect(await readdir(join(failed.root, ".."))).toEqual(["000001"]);
        } else {
          const recovered = await RevisionWorkspace.reviseFromTerminalFailure(root, manifest.job_id, manifest.target_id);
          const after = await recovered.readState();
          for (const key of ["next_history_sequence", "next_validation_sequence", "validation_attempts", "selector_stage", "selector_protocol", "repair"] as const) {
            expect(after[key]).toEqual(beforeState[key]);
          }
          expect(after).toMatchObject({ status: "working", revision: 2, lineage: { source_revision: 1, recovery_kind: "terminal_checkpoint" } });
          for (const [index, file] of names.entries()) if (file !== "state.json") expect(await readFile(join(recovered.root, file))).toEqual(beforeBytes[index]);
          const event = (await readFile(recovered.transcriptPath, "utf8")).trim().split(/\r?\n/u).map(line => JSON.parse(line))[0];
          expect(event.payload.checkpoint).toMatchObject({ terminal_checkpoint_source: "compiler_replay", validation_budget_reset: false });
          expect(await access(recovered.sealedPlanPath).then(() => true, () => false)).toBe(false);
        }
        for (const [index, file] of names.entries()) expect(await readFile(join(failed.root, file))).toEqual(beforeBytes[index]);
      } finally {
        injected?.mockRestore();
        await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    },
  );

  test("restores evidence, selectors, and registry from the same sealed ancestor revision", async () => {
    const fixture = await sealedFixture();
    try {
      const failed = await RevisionWorkspace.reviseFromSealed(
        fixture.root,
        fixture.manifest.job_id,
        fixture.manifest.target_id,
      );
      const divergent = manifestForEntries([{
        evidenceId: "atom:divergent-failed-revision",
        text: "失败 revision 使用了另一份证据。",
      }]);
      const divergentRegistry = registryWithFullSourceSpans(
        divergent.evidence_fingerprint,
        divergent.evidence.map((record) => ({
          source_id: record.evidence_id,
          evidence_id: record.evidence_id,
          atom_id: record.evidence_id,
          text: record.text,
        })),
      );
      await chmod(failed.evidenceManifestPath, 0o644);
      await chmod(failed.evidenceScopePath, 0o644);
      await chmod(failed.sourceMarkdownPath, 0o644);
      await atomicWriteJson(failed.evidenceManifestPath, divergent);
      await atomicWriteJson(failed.evidenceScopePath, divergent.scope);
      await writeFile(failed.sourceMarkdownPath, divergent.evidence[0]!.text, "utf8");
      await atomicWriteJson(failed.sourceSpanRegistryPath, divergentRegistry);
      await failed.updateState((state) => {
        state.status = "failed";
        state.terminal_reason = "target_blocked_with_evidence";
        state.opened_evidence_ids = [divergent.evidence[0]!.evidence_id];
      });

      const recovered = await RevisionWorkspace.reviseFromTerminalFailure(
        fixture.root,
        fixture.manifest.job_id,
        fixture.manifest.target_id,
      );
      const recoveredEvidence = await recovered.readEvidenceManifest();
      const recoveredRegistry = await recovered.readSourceSpanRegistry();
      expect(recoveredEvidence.evidence_fingerprint).toBe(fixture.manifest.evidence_fingerprint);
      expect(recoveredRegistry.source_fingerprint).toBe(fixture.manifest.evidence_fingerprint);
      expect((await recovered.readState()).opened_evidence_ids)
        .not.toContain(divergent.evidence[0]!.evidence_id);
      expect(await recovered.readState()).toMatchObject({
        lineage: {
          selector_checkpoint_revision: fixture.first.revision,
          registry_checkpoint_revision: fixture.first.revision,
          evidence_checkpoint_revision: fixture.first.revision,
          recovery_kind: "terminal_sealed_ancestor",
        },
      });
    } finally {
      await rm(fixture.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  test("rejects a best checkpoint whose registered span source is absent from current evidence", async () => {
    const fixture = await sealedFixture();
    try {
      const failed = await RevisionWorkspace.reviseFromSealed(
        fixture.root,
        fixture.manifest.job_id,
        fixture.manifest.target_id,
      );
      const registry = await failed.readSourceSpanRegistry();
      const foreign = registerSourceSpan(registry, {
        source_id: "evidence:foreign-checkpoint-source",
        evidence_id: "evidence:foreign-checkpoint-source",
        atom_id: "evidence:foreign-checkpoint-source",
        text: "不属于当前证据包的来源",
      }, 0, "不属于当前证据包的来源".length);
      await atomicWriteJson(failed.sourceSpanRegistryPath, foreign.registry);
      const best = JSON.parse(await readFile(failed.workingSelectorPath, "utf8"));
      best.items[0].name = "不应恢复的跨证据 best 草稿";
      best.items[0].criterion_span_ids = [foreign.span.span_id];
      await atomicWriteJson(failed.bestSelectorPath, best);
      await atomicWriteJson(join(failed.historyDirectory, "000001.json"), {});
      await failed.updateState((state) => {
        state.status = "failed";
        state.terminal_reason = "target_blocked_with_evidence";
        state.selector_protocol!.best_draft_fingerprint = targetSelectorFingerprint(
          migrateTargetSelectorPlanForAuthoring(best).plan,
        );
        state.selector_protocol!.best_history_sequence = 1;
        state.selector_protocol!.best_preflight_stage_rank = 4;
        state.selector_protocol!.best_issue_count = 0;
        state.selector_protocol!.best_issue_fingerprint = "stale-cross-evidence-checkpoint";
      });

      const recovered = await RevisionWorkspace.reviseFromTerminalFailure(
        fixture.root,
        fixture.manifest.job_id,
        fixture.manifest.target_id,
      );
      const selectors = JSON.parse(await readFile(recovered.workingSelectorPath, "utf8"));
      expect(selectors.items[0].name).toBe("构件质量");
      expect(selectors.items[0].criterion_span_ids).not.toContain(foreign.span.span_id);
      expect(await recovered.readState()).toMatchObject({
        lineage: {
          selector_checkpoint_revision: fixture.first.revision,
          registry_checkpoint_revision: fixture.first.revision,
          evidence_checkpoint_revision: fixture.first.revision,
          recovery_kind: "terminal_sealed_ancestor",
        },
      });
    } finally {
      await rm(fixture.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  test("skips a corrupted nearest sealed ancestor and recovers from the next coherent one", async () => {
    const fixture = await sealedFixture();
    try {
      const corruptedAncestor = await RevisionWorkspace.reviseFromSealed(
        fixture.root,
        fixture.manifest.job_id,
        fixture.manifest.target_id,
      );
      const registry = await corruptedAncestor.readSourceSpanRegistry();
      const foreign = registerSourceSpan(registry, {
        source_id: "evidence:corrupted-sealed-source",
        evidence_id: "evidence:corrupted-sealed-source",
        atom_id: "evidence:corrupted-sealed-source",
        text: "被污染的 sealed 来源",
      }, 0, "被污染的 sealed 来源".length);
      const corruptedSelectors = JSON.parse(await readFile(corruptedAncestor.workingSelectorPath, "utf8"));
      corruptedSelectors.items[0].criterion_span_ids = [foreign.span.span_id];
      await atomicWriteJson(corruptedAncestor.workingSelectorPath, corruptedSelectors);
      await atomicWriteJson(corruptedAncestor.sourceSpanRegistryPath, foreign.registry);
      await writeFile(corruptedAncestor.sealedPlanPath, await readFile(corruptedAncestor.workingPlanPath));
      await corruptedAncestor.updateState((state) => { state.status = "sealed"; });

      const failed = await RevisionWorkspace.reviseFromSealed(
        fixture.root,
        fixture.manifest.job_id,
        fixture.manifest.target_id,
      );
      await failed.updateState((state) => {
        state.status = "failed";
        state.terminal_reason = "target_blocked_with_evidence";
      });
      const recovered = await RevisionWorkspace.reviseFromTerminalFailure(
        fixture.root,
        fixture.manifest.job_id,
        fixture.manifest.target_id,
      );
      expect(await recovered.readState()).toMatchObject({
        lineage: {
          source_revision: failed.revision,
          selector_checkpoint_revision: fixture.first.revision,
          registry_checkpoint_revision: fixture.first.revision,
          evidence_checkpoint_revision: fixture.first.revision,
          recovery_kind: "terminal_sealed_ancestor",
        },
      });
      expect(JSON.parse(await readFile(recovered.workingSelectorPath, "utf8")).items[0].criterion_span_ids)
        .not.toContain(foreign.span.span_id);
    } finally {
      await rm(fixture.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  test("does not trust a fingerprint-matched best draft that failed selector-local preflight", async () => {
    const fixture = await sealedFixture();
    try {
      const failed = await RevisionWorkspace.reviseFromSealed(
        fixture.root,
        fixture.manifest.job_id,
        fixture.manifest.target_id,
      );
      const damaged = JSON.parse(await readFile(failed.workingSelectorPath, "utf8"));
      damaged.items[0].name = "未通过确定性检查的终态草稿";
      const damagedText = prettyJson(damaged);
      await writeFile(failed.workingSelectorPath, damagedText, "utf8");
      await writeFile(failed.bestSelectorPath, damagedText, "utf8");
      await writeFile(join(failed.historyDirectory, "000001.json"), "{}\n", "utf8");
      await failed.updateState((state) => {
        state.status = "failed";
        state.terminal_reason = "target_blocked_with_evidence";
        state.selector_stage = "coverage_repair";
        state.repair!.repair_source = "coverage";
        state.repair!.coverage_finding_ids = ["finding:still-active"];
        state.selector_protocol!.best_draft_fingerprint = targetSelectorFingerprint(damaged);
        state.selector_protocol!.best_history_sequence = 1;
        state.selector_protocol!.best_preflight_stage_rank = 1;
        state.selector_protocol!.best_issue_count = 4;
        state.selector_protocol!.best_issue_fingerprint = "selector-local-issues";
      });
      const failedBytes = await readFile(failed.workingSelectorPath, "utf8");

      const recovered = await RevisionWorkspace.reviseFromTerminalFailure(
        fixture.root,
        fixture.manifest.job_id,
        fixture.manifest.target_id,
      );
      const selectors = JSON.parse(await readFile(recovered.workingSelectorPath, "utf8"));
      expect(selectors.items[0].name).toBe("构件质量");
      expect(await recovered.readState()).toMatchObject({
        lineage: {
          source_revision: 2,
          selector_checkpoint_revision: 1,
          recovery_kind: "terminal_sealed_ancestor",
        },
        repair: { coverage_finding_ids: ["finding:still-active"] },
      });
      expect(await readFile(failed.workingSelectorPath, "utf8")).toBe(failedBytes);
    } finally {
      await rm(fixture.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  test("recovers a fingerprint-matched best draft only after complete issue-free preflight", async () => {
    const fixture = await sealedFixture();
    try {
      const failed = await RevisionWorkspace.reviseFromSealed(
        fixture.root,
        fixture.manifest.job_id,
        fixture.manifest.target_id,
      );
      const complete = JSON.parse(await readFile(failed.workingSelectorPath, "utf8"));
      complete.items[0].name = "已完成确定性预检的 best 草稿";
      const completeText = prettyJson(complete);
      await writeFile(failed.workingSelectorPath, completeText, "utf8");
      await writeFile(failed.bestSelectorPath, completeText, "utf8");
      await writeFile(join(failed.historyDirectory, "000001.json"), "{}\n", "utf8");
      await failed.updateState((state) => {
        state.status = "failed";
        state.terminal_reason = "target_blocked_with_evidence";
        state.selector_protocol!.best_draft_fingerprint = targetSelectorFingerprint(complete);
        state.selector_protocol!.best_history_sequence = 1;
        state.selector_protocol!.best_preflight_stage_rank = 4;
        state.selector_protocol!.best_issue_count = 0;
        state.selector_protocol!.best_issue_fingerprint = "complete-no-issues";
      });

      const recovered = await RevisionWorkspace.reviseFromTerminalFailure(
        fixture.root,
        fixture.manifest.job_id,
        fixture.manifest.target_id,
      );
      const selectors = JSON.parse(await readFile(recovered.workingSelectorPath, "utf8"));
      expect(selectors.items[0].name).toBe("已完成确定性预检的 best 草稿");
      expect(await recovered.readState()).toMatchObject({
        lineage: {
          source_revision: 2,
          selector_checkpoint_revision: 2,
          registry_checkpoint_revision: 2,
          recovery_kind: "terminal_checkpoint",
        },
      });
    } finally {
      await rm(fixture.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  test("recovers an issue-free best draft from a fresh failed revision without lineage", async () => {
    const root = join(tmpdir(), `pi-fresh-best-selector-${randomUUID()}`);
    const text = "构件应符合要求。抽查1件。采用目测检查。";
    const manifest = manifestFor(text);
    try {
      const failed = await RevisionWorkspace.createFromEvidence(
        root,
        manifest.job_id,
        manifest.target_id,
        { manifest, markdown: Buffer.from(text) },
      );
      const spanId = (await failed.readSourceSpanRegistry()).spans[0]!.span_id;
      const best = legacyV4Selectors(manifest, spanId) as any;
      best.items[0].name = "新鲜 revision 的 issue-free best 草稿";
      const bestText = prettyJson(best);
      await writeFile(failed.workingSelectorPath, bestText, "utf8");
      await writeFile(failed.bestSelectorPath, bestText, "utf8");
      await atomicWriteJson(join(failed.validationDirectory, "000003.json"), {
        schema_version: "validation-receipt/v1",
        sequence: 3,
        ok: false,
      });
      await atomicWriteJson(failed.validationReceiptPath, {
        schema_version: "validation-receipt/v1",
        sequence: 3,
        ok: false,
      });
      await failed.updateState((state) => {
        state.status = "failed";
        state.terminal_reason = "final_validator_attempt_limit";
        state.validation_attempts = 3;
        state.next_validation_sequence = 4;
        state.selector_protocol!.best_draft_fingerprint = targetSelectorFingerprint(
          migrateTargetSelectorPlanForAuthoring(best).plan,
        );
        state.selector_protocol!.best_history_sequence = 7;
        state.selector_protocol!.best_preflight_stage_rank = 4;
        state.selector_protocol!.best_issue_count = 0;
        state.selector_protocol!.best_issue_fingerprint = "complete-no-issues";
      });

      const recovered = await RevisionWorkspace.reviseFromTerminalFailure(
        root,
        manifest.job_id,
        manifest.target_id,
      );
      expect(JSON.parse(await readFile(recovered.workingSelectorPath, "utf8")).items[0].name)
        .toBe("新鲜 revision 的 issue-free best 草稿");
      expect(await recovered.readState()).toMatchObject({
        validation_attempts: 0,
        next_validation_sequence: 1,
        lineage: {
          source_revision: failed.revision,
          selector_checkpoint_revision: failed.revision,
          recovery_kind: "terminal_checkpoint",
        },
      });
      expect(await readdir(recovered.validationDirectory)).toEqual([]);
      expect(await access(recovered.validationReceiptPath).then(() => true).catch(() => false)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  test("restores validated state fingerprints from a trusted receipt", async () => {
    const root = join(tmpdir(), `pi-validated-selector-state-${randomUUID()}`);
    const text = "构件应符合要求。抽查1件。采用目测检查。";
    const manifest = manifestFor(text);
    try {
      const failed = await RevisionWorkspace.createFromEvidence(
        root,
        manifest.job_id,
        manifest.target_id,
        { manifest, markdown: Buffer.from(text) },
      );
      const spanId = (await failed.readSourceSpanRegistry()).spans[0]!.span_id;
      const selectors = migrateTargetSelectorPlanForAuthoring(
        legacyV4Selectors(manifest, spanId),
      ).plan;
      const selectorFingerprint = targetSelectorFingerprint(selectors);
      const validationFingerprint = "a".repeat(64);
      const planSha256 = "b".repeat(64);
      await atomicWriteJson(failed.workingSelectorPath, selectors);
      await atomicWriteJson(failed.lastValidSelectorPath, selectors);
      await writeFile(failed.lastValidPlanPath, await readFile(failed.workingPlanPath));
      await atomicWriteJson(failed.validationReceiptPath, {
        schema_version: "validation-receipt/v1",
        ok: true,
        evidence_fingerprint: manifest.evidence_fingerprint,
        selector_fingerprint: selectorFingerprint,
        validation_fingerprint: validationFingerprint,
        plan_sha256: planSha256,
      });
      await failed.updateState((state) => {
        state.status = "failed";
        state.terminal_reason = "operator_interrupted_invalid_seal_fingerprint_loop";
        state.last_valid_fingerprint = "";
        state.last_valid_plan_sha256 = "";
        state.repair!.mode = "validated";
      });

      const recovered = await RevisionWorkspace.reviseFromTerminalFailure(
        root,
        manifest.job_id,
        manifest.target_id,
      );
      expect(await recovered.readState()).toMatchObject({
        status: "working",
        last_valid_fingerprint: validationFingerprint,
        last_valid_plan_sha256: planSha256,
        repair: { mode: "validated" },
      });
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});
