import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { describe, expect, test } from "vitest";

import { domainFindings } from "../src/audit.js";
import { prettyJson, sha256Json } from "../src/canonical.js";
import { buildFieldBinding, buildItemFieldBindings } from "../src/domain-contract.js";
import { buildPlanContract } from "../src/source-plan-contract.js";
import { materialize } from "../src/materializer.js";
import { validatePlanText } from "../src/validator.js";
import { RevisionWorkspace } from "../src/workspace.js";
import { createPiTools, ToolController, validFixturePlan } from "../src/tools.js";
import { scanDocumentLedger } from "../src/document-ledger.js";
import {
  CoverageReviewController,
  coverageReviewObligations,
  type SemanticCoverageDisposition,
} from "../src/coverage-review.js";

import {
  buildAgentScopedEvidenceManifest,
  buildDocumentEvidence,
  createDocumentDiscoveryTools,
  DocumentDiscoveryController,
  DocumentDiscoveryWorkspace,
  initialDocumentTargetPlan,
  migrateDocumentTargetPlan,
  stableHeadingWorkScopePlan,
  validateDocumentTargetPlan,
  type DocumentTargetPlan,
} from "../src/document-discovery.js";

async function tempRoot(label: string): Promise<string> {
  const root = resolve(".tmp-tests", `${label}-${randomUUID()}`);
  await mkdir(root, { recursive: true });
  return root;
}

function validPlan(jobId: string, markdown: string): {
  evidence: ReturnType<typeof buildDocumentEvidence>;
  plan: DocumentTargetPlan;
} {
  const evidence = buildDocumentEvidence(markdown, "source.md");
  const atom = evidence.atoms[0]!;
  return {
    evidence,
    plan: {
      schema_version: "document-target-plan/v4",
      job_id: jobId,
      document_fingerprint: evidence.evidence_fingerprint,
      targets: [{
        target_id: "domain-target-001",
        group_id: "domain-group-foundation",
        group_name: "地基工程",
        group_reason: "按地基施工质量验收对象归组",
        name: "地基验收",
        description: "地基施工质量的验收要求",
        evidence_atom_ids: [atom.atom_id],
        evidence_fragments: [{ atom_id: atom.atom_id, text: "地基承载力应满足设计要求" }],
        materialization: {
          kind: "inspection_scope",
          lot_basis_summary: "以地基承载力满足设计要求作为检验批划分依据",
          lot_basis_fragments: [{ atom_id: atom.atom_id, text: "地基承载力应满足设计要求" }],
          reason: "原文直接规定地基实体质量要求，可形成地基检验批",
        },
        reason: "原文包含可形成检验批验收项目的实体质量要求",
      }],
      context_notes: [],
      dispositions: [{
        atom_id: atom.atom_id,
        disposition: "target",
        target_ids: ["domain-target-001"],
        reason: "该原子是地基验收业务内容",
      }],
    },
  };
}

describe("full-document domain discovery", () => {
  test.each(["inspection_scope", "work_scope"] as const)("semantic basis handoff preserves approved reasons for %s", async (kind) => {
    const root = await tempRoot("semantic-basis-handoff");
    const markdownPath = join(root, "source.md");
    const markdown = "# 9.1 组合装置\n9.1.1 连接应牢固。\n9.1.2 尺寸应符合设计要求。";
    await writeFile(markdownPath, markdown, "utf8");
    const { evidence, plan } = validPlan("handoff-job", markdown);
    const target = plan.targets[0]!;
    target.name = "组合装置";
    target.description = "组合装置：含尺寸条款";
    target.evidence_fragments = [{ atom_id: evidence.atoms[0]!.atom_id, text: markdown }];
    target.materialization = {
      kind, lot_basis_summary: "仅索引到尺寸条款",
      lot_basis_fragments: [{ atom_id: evidence.atoms[0]!.atom_id, text: "# 9.1 组合装置" }],
      reason: "待确认的机械索引",
    };
    target.semantic_basis = {
      subject: "组合装置及连接部件", subject_kind: "system", acceptance_kind: "direct_criterion",
      acceptance_span_ids: ["document-phase-span-not-a-target-handle"],
      acceptance_reason: "正文同时规定连接与尺寸的验收要求。",
      boundary_reason: "装置及其连接部件在同一范围内；不涉及安装设备。",
    };
    const before = structuredClone(target);
    const prepared = await buildAgentScopedEvidenceManifest(markdownPath, "handoff-job", target, evidence);
    const reason = prepared.manifest.scope.selection_reason;
    for (const value of [target.semantic_basis.subject, target.semantic_basis.acceptance_reason, target.semantic_basis.boundary_reason]) {
      expect(reason).toContain(value);
    }
    expect(reason).toContain("定位摘要（非完整范围定义）");
    expect(reason).toContain(`任务：${target.name}。`);
    expect(reason).not.toContain(`任务：${target.description}`);
    expect(reason.split(target.materialization.lot_basis_summary)).toHaveLength(2);
    expect(reason).not.toContain("范围摘要：");
    // Discovery span IDs belong to a different registry; never advertise them as Target handles.
    expect(reason).not.toContain(target.semantic_basis.acceptance_span_ids[0]);
    expect(target).toEqual(before);
    const revision = await RevisionWorkspace.createFromEvidence(root, "handoff-job", target.target_id, prepared);
    const controller = await ToolController.create(revision);
    expect(JSON.stringify(await controller.dispatch("get_target_context", {}))).toContain(target.semantic_basis.boundary_reason);
  });

  test("semantic basis handoff does not invent approved reasons for a legacy target", async () => {
    const root = await tempRoot("semantic-basis-legacy");
    const markdownPath = join(root, "source.md");
    const markdown = "地基承载力应满足设计要求。";
    await writeFile(markdownPath, markdown, "utf8");
    const { evidence, plan } = validPlan("legacy-handoff", markdown);
    const prepared = await buildAgentScopedEvidenceManifest(markdownPath, "legacy-handoff", plan.targets[0]!, evidence);
    expect(prepared.manifest.scope.selection_reason).toContain(plan.targets[0]!.reason);
    expect(prepared.manifest.scope.selection_reason).toContain("定位摘要（非完整范围定义）");
    expect(prepared.manifest.scope.selection_reason).not.toContain("目标发现语义依据：");
  });

  test("legacy line ranges cannot bypass exclusive primary ownership, including containment", () => {
    const markdown = "地基承载力应满足设计要求\n连接应牢固\n\n表面应完整";
    const { evidence, plan } = validPlan("job", markdown);
    const first = plan.targets[0]!;
    first.materialization.kind = "work_scope";
    first.work_scope = { start_line: 1, end_exclusive_line: 5 };
    const second = structuredClone(first);
    second.target_id = "second";
    second.work_scope = { start_line: 2, end_exclusive_line: 3 };
    plan.targets.push(second);
    plan.dispositions[0]!.target_ids.push(second.target_id);
    const opened = new Set(evidence.atoms.map(atom => atom.atom_id));
    const validation = validateDocumentTargetPlan(plan, evidence, "job", opened);
    expect(validation.issues).toEqual(expect.arrayContaining([expect.objectContaining({
      code: "target_primary_overlap", details: expect.objectContaining({
        target_ids: [first.target_id, second.target_id],
        next_tools: expect.arrayContaining(["patch_document_selectors"]),
      }),
    })]));
    first.work_scope.end_exclusive_line = 2;
    expect(validateDocumentTargetPlan(plan, evidence, "job", opened).ok).toBe(true);
  });

  test("builds stable heading work scopes when the ledger has no active item windows", () => {
    const markdown = [
      "# 1 总则",
      "1.0.1 本规范规定适用范围。",
      "# 2 缩略语",
      "ABC 表示测试缩写。",
      "# 3 环境检查",
      "3.0.1 建筑环境应符合设计要求。",
      "# 4 器材检查",
      "4.0.1 工程器材应进行进场检查。",
      "# 5 缆线工程",
      "# 5.1 缆线敷设",
      "5.1.1 缆线应自然平直。",
      "# 5.2 缆线保护",
      "5.2.1 缆线应采取保护措施。",
      "# 6 工程验收",
      "6.0.1 工程验收资料应完整。",
      "# 本规范用词说明",
      "# 中华人民共和国国家标准",
      "# 1 总则",
      "# 3 环境检查",
      "3.0.1 本条说明环境检查要求。",
    ].join("\n");
    const evidence = buildDocumentEvidence(markdown, "stable-work-scopes.md");
    const ledger = scanDocumentLedger(markdown, "stable-work-scopes.md");
    const first = stableHeadingWorkScopePlan("job-a", evidence, ledger)!;
    const second = stableHeadingWorkScopePlan("job-b", evidence, ledger)!;

    expect(first.targets.map((target) => target.name)).toEqual([
      "环境检查",
      "器材检查",
      "缆线敷设",
      "缆线保护",
    ]);
    expect(first.targets.map((target) => target.target_id))
      .toEqual(second.targets.map((target) => target.target_id));
    expect(first.targets.every((target) => target.materialization.kind === "work_scope"))
      .toBe(true);
    expect(first.targets.map((target) =>
      `${target.work_scope!.start_line}-${target.work_scope!.end_exclusive_line}`
    )).toEqual(["5-7", "7-9", "10-12", "12-14"]);
    expect(validateDocumentTargetPlan(
      first,
      evidence,
      "job-a",
      new Set(evidence.atoms.map((atom) => atom.atom_id)),
    ).ok).toBe(true);
  });

  test("creates only neutral transport atoms and preserves the complete source", () => {
    const source = [
      "# 4.2 错乱标题",
      "<table><tr><td>主控项日</td><td>地基承载力应满足设计要求</td></tr></table>",
      "OCR乱入x字符与断\n行不改变它仍是领域内容。",
    ].join("\n").repeat(600);
    const evidence = buildDocumentEvidence(source, "source.md", 1_000);
    expect(evidence.atoms.map((atom) => atom.text).join("")).toBe(source);
    expect(evidence.atoms.every((atom, index) => {
      const previous = evidence.atoms[index - 1];
      return atom.start_offset === (previous?.end_offset ?? 0)
        && atom.end_offset > atom.start_offset;
    })).toBe(true);
    expect(JSON.stringify(evidence)).not.toContain("formal_table_row");
    expect(JSON.stringify(evidence)).not.toContain("target_id");
  });

  test("keeps unselected clauses inside one selected atom as granular coverage obligations", async () => {
    const root = await tempRoot("agent-granular-primary-coverage");
    const markdownPath = join(root, "source.md");
    const aluminiumClause = "4.2.1 铝合金材料品种、规格、性能应符合设计文件要求。";
    const aluminiumMethod = "检查方法：检查铝合金材料质量合格证明文件。";
    const weldingClause = "4.3.1 焊接材料的品种、规格、性能应符合设计文件要求。";
    const weldingMethod = "检查方法：检查焊接材料质量合格证明文件。";
    const markdown = [
      "# 4 原材料及成品进场验收",
      "## 4.2 铝合金材料",
      aluminiumClause,
      aluminiumMethod,
      "## 4.3 焊接材料",
      weldingClause,
      weldingMethod,
    ].join("\n");
    await writeFile(markdownPath, markdown, "utf8");
    const { evidence, plan } = validPlan("granular-primary-job", markdown);
    const target = plan.targets[0]!;
    target.evidence_fragments = [{
      atom_id: target.evidence_atom_ids[0]!,
      text: aluminiumClause,
    }];
    target.materialization.lot_basis_fragments = [{
      atom_id: target.evidence_atom_ids[0]!,
      text: aluminiumClause,
    }];
    const prepared = await buildAgentScopedEvidenceManifest(
      markdownPath,
      "granular-primary-job",
      target,
      evidence,
    );
    const primaryTexts = prepared.manifest.evidence
      .filter((record) =>
        record.evidence_scope === "primary"
        && record.evidence_id !== target.evidence_atom_ids[0]
      )
      .map((record) => record.text);
    expect(primaryTexts).toEqual(expect.arrayContaining([
      aluminiumClause,
      aluminiumMethod,
      weldingClause,
      weldingMethod,
    ]));

    const candidatePlan = validFixturePlan(prepared.manifest);
    const item = candidatePlan.acceptance_items[0]!;
    const atomId = target.evidence_atom_ids[0]!;
    const fields = {
      name: "铝合金材料品种、规格、性能",
      requirement: aluminiumClause,
      method: aluminiumMethod,
      quantity: "",
      note: "",
    };
    Object.assign(item, fields, {
      evidence_ids: [atomId],
      reference_evidence_ids: [],
      inspection_data_type_evidence_ids: [atomId],
      field_bindings: buildItemFieldBindings(fields, [atomId], prepared.manifest),
    });
    candidatePlan.inspection_lots[0]!.evidence_ids = [atomId];
    candidatePlan.evidence_dispositions = [{
      evidence_id: atomId,
      disposition: "used",
      item_ids: [item.item_id],
      reason: "该原子包含当前已建模条款及仍待覆盖复核的相邻条款。",
    }];
    candidatePlan.semantic_evidence = [{
      semantic_id: "semantic:aluminium-material",
      role: "acceptance_item",
      evidence_id: atomId,
      exact_fragment: aluminiumClause,
      parent_semantic_id: "",
      materialized_item_id: item.item_id,
      reason: "当前候选仅选择了铝合金材料条款。",
    }];

    const uncoveredTexts = coverageReviewObligations(prepared.manifest, candidatePlan)
      .uncovered_primary_evidence_ids
      .map((evidenceId) => prepared.manifest.evidence.find((record) =>
        record.evidence_id === evidenceId
      )!.text);
    expect(uncoveredTexts).toContain(weldingClause);
    expect(uncoveredTexts).toContain(weldingMethod);
    expect(uncoveredTexts).not.toContain(aluminiumClause);
    expect(uncoveredTexts).not.toContain(aluminiumMethod);
  });

  test("chooses the nearest newline around 6000 and prefers the earlier one on a tie", () => {
    const nearerAfter = `${"a".repeat(5_799)}\n${"b".repeat(99)}\n${"c".repeat(6_000)}`;
    expect(buildDocumentEvidence(nearerAfter, "source.md").atoms[0]!.end_offset).toBe(5_900);

    const equalDistance = `${"a".repeat(5_799)}\n${"b".repeat(399)}\n${"c".repeat(6_000)}`;
    expect(buildDocumentEvidence(equalDistance, "source.md").atoms[0]!.end_offset).toBe(5_800);

    const atWindowEdge = `${"a".repeat(6_499)}\n${"b".repeat(6_000)}`;
    expect(buildDocumentEvidence(atWindowEdge, "source.md").atoms[0]!.end_offset).toBe(6_500);
    const outsideWindow = `${"a".repeat(6_500)}\n${"b".repeat(6_000)}`;
    expect(buildDocumentEvidence(outsideWindow, "source.md").atoms[0]!.end_offset).toBe(6_000);
  });

  test("keeps 1000 intact when it crosses 6000 and a nearby newline is available", () => {
    const source = `${"a".repeat(5_998)}1000${"b".repeat(47)}\n${"c".repeat(6_000)}`;
    const evidence = buildDocumentEvidence(source, "source.md");

    expect(evidence.atoms[0]).toMatchObject({ end_offset: 6_050 });
    expect(evidence.atoms[0]!.text).toContain("1000");
    expect(evidence.atoms[1]!.text.startsWith("00")).toBe(false);
  });

  test("hard-cuts at the target only when the newline window is empty", () => {
    const source = "x".repeat(12_500);
    const evidence = buildDocumentEvidence(source, "source.md");

    expect(evidence.atoms.map((atom) => [atom.start_offset, atom.end_offset])).toEqual([
      [0, 6_000],
      [6_000, 12_000],
      [12_000, 12_500],
    ]);
  });

  test("never splits CRLF or Unicode surrogate pairs at an atom boundary", () => {
    const crlfSource = `${"x".repeat(5_999)}\r\n${"y".repeat(6_000)}`;
    const crlfEvidence = buildDocumentEvidence(crlfSource, "crlf.md");
    expect(crlfEvidence.atoms[0]!.end_offset).toBe(6_001);
    expect(crlfEvidence.atoms[0]!.text.endsWith("\r\n")).toBe(true);
    expect(crlfEvidence.atoms[1]!.text.startsWith("\n")).toBe(false);

    const surrogateSource = `${"x".repeat(5_999)}😀${"y".repeat(6_000)}`;
    const surrogateEvidence = buildDocumentEvidence(surrogateSource, "surrogate.md");
    expect(surrogateEvidence.atoms[0]!.end_offset).toBe(6_001);
    expect(surrogateEvidence.atoms[0]!.text.endsWith("😀")).toBe(true);
    expect(surrogateEvidence.atoms[1]!.text.charCodeAt(0)).not.toBeGreaterThanOrEqual(0xdc00);
  });

  test("reconstructs bytes exactly with continuous offsets, line semantics, and deterministic IDs", () => {
    const source = [
      "首行😀",
      "a".repeat(5_950),
      "边界前\r\n边界后",
      "b".repeat(6_200),
      "末行😀",
    ].join("\n");
    const first = buildDocumentEvidence(source, "source.md");
    const second = buildDocumentEvidence(source, "source.md");
    const rebuilt = first.atoms.map((atom) => atom.text).join("");

    expect(rebuilt).toBe(source);
    expect(Buffer.from(rebuilt, "utf8").equals(Buffer.from(source, "utf8"))).toBe(true);
    expect(first).toEqual(second);
    expect(first.atoms.every((atom, index) => {
      const previous = first.atoms[index - 1];
      return atom.start_offset === (previous?.end_offset ?? 0)
        && atom.start_line === (previous?.end_line ?? 1)
        && atom.text === source.slice(atom.start_offset, atom.end_offset);
    })).toBe(true);
    expect(first.atoms.at(-1)!.end_offset).toBe(source.length);
  });

  test("rejects zero targets, unopened content, and incomplete coverage", () => {
    const evidence = buildDocumentEvidence("地基承载力应满足设计要求。".repeat(100), "source.md", 1_000);
    const empty = initialDocumentTargetPlan("job", evidence);
    const result = validateDocumentTargetPlan(empty, evidence, "job", new Set());
    expect(result.ok).toBe(false);
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "zero_targets" }),
      expect.objectContaining({ code: "unreviewed_disposition" }),
      expect.objectContaining({ code: "unopened_document_atom" }),
    ]));
  });

  test("discovery tool rejects keep the actual value and next tool", async () => {
    const root = await tempRoot("document-discovery-actionable-reject");
    const markdownPath = join(root, "source.md");
    await writeFile(markdownPath, "地基承载力应满足设计要求。".repeat(20), "utf8");
    const workspace = await DocumentDiscoveryWorkspace.openOrCreate(root, "job-actionable", markdownPath);
    const controller = await DocumentDiscoveryController.create(workspace, "candidate");
    const unknownTool = await controller.dispatch("not_a_discovery_tool", {});
    expect(unknownTool).toMatchObject({
      ok: false,
      error: "unknown_discovery_tool",
      actual_tool: "not_a_discovery_tool",
    });
    expect(String(unknownTool.instruction)).toMatch(/get_document_selector_contract/);
    const unknownAtom = await controller.dispatch("open_document_atom", { atom_id: "atom:missing" });
    expect(unknownAtom).toMatchObject({
      ok: false,
      error: "unknown_document_atom",
      actual_atom_id: "atom:missing",
    });
    expect(String(unknownAtom.instruction)).toMatch(/list_document_atoms/);
    const reviewerUnopened = await DocumentDiscoveryController.create(workspace, "review");
    const unopened = await reviewerUnopened.dispatch("locate_document_span", {
      atom_id: controller.evidence.atoms[0]!.atom_id,
      quote: "地基承载力应满足设计要求",
    });
    expect(unopened).toMatchObject({
      ok: false,
      error: "span_atom_not_opened",
    });
    expect(String(unopened.instruction)).toMatch(/open_document_atom/);
    const invalidJson = await controller.dispatch("replace_discovery_plan", { content: "{" });
    expect(invalidJson).toMatchObject({
      ok: false,
      error: "discovery_tool_rejected",
    });
    expect(String(invalidJson.instruction)).toMatch(/actual_error/);
    expect(String(invalidJson.actual_error)).toMatch(/offset|Expected/);
    const fingerprint = await controller.dispatch("submit_discovery_candidate", { fingerprint: "nope" });
    expect(fingerprint).toMatchObject({
      ok: false,
      actual_fingerprint: "nope",
      candidate_read_tool: "compile_document_selectors",
    });
    expect(String(fingerprint.instruction)).toMatch(/nope/);
  });

  test("validates and seals an observable full-coverage discovery workfile", async () => {
    const root = await tempRoot("document-discovery-seal");
    const markdownPath = join(root, "source.md");
    const markdown = "地基承载力应满足设计要求。".repeat(40);
    await writeFile(markdownPath, markdown, "utf8");
    const workspace = await DocumentDiscoveryWorkspace.openOrCreate(root, "job", markdownPath);
    const controller = await DocumentDiscoveryController.create(workspace, "candidate");
    const atom = controller.evidence.atoms[0]!;
    await controller.dispatch("open_document_atom", { atom_id: atom.atom_id });
    const { plan } = validPlan("job", markdown);
    expect(await controller.dispatch("replace_discovery_plan", {
      content: JSON.stringify(plan),
    })).toMatchObject({ ok: true });
    const validation = await controller.dispatch("validate_discovery_plan", {});
    expect(validation).toMatchObject({ ok: true });
    expect(await controller.dispatch("seal_discovery_plan", {
      fingerprint: validation.fingerprint,
    })).toMatchObject({ ok: true, target_count: 1 });
    expect(JSON.parse(await readFile(workspace.sealReceiptPath, "utf8"))).toMatchObject({
      sealing_role: "discovery_author", independent_semantic_review_performed: false,
    });
    expect(JSON.parse(await readFile(workspace.sealedPlanPath, "utf8"))).toEqual(plan);

    const archive = await workspace.reopenForDiscoveryRepair(
      "A later regression found one inspectable scope misclassified as context",
    );
    expect(await workspace.readState()).toMatchObject({
      status: "working",
      review_reason: "A later regression found one inspectable scope misclassified as context",
    });
    expect(JSON.parse(await readFile(workspace.workingPlanPath, "utf8"))).toEqual(plan);
    expect(JSON.parse(await readFile(join(archive, "document-target-plan.json"), "utf8")))
      .toEqual(plan);
  });

  test("exposes pre-registered full-atom span ids so the agent never quotes whole atoms", async () => {
    const root = await tempRoot("document-discovery-full-atom-spans");
    const markdownPath = join(root, "source.md");
    const markdown = "地基承载力应满足设计要求。".repeat(500);
    await writeFile(markdownPath, markdown, "utf8");
    const workspace = await DocumentDiscoveryWorkspace.openOrCreate(root, "job", markdownPath);
    const controller = await DocumentDiscoveryController.create(workspace, "candidate");
    const registry = await workspace.readSourceSpanRegistry();
    const fullSpanFor = (atomId: string) => {
      const atom = controller.evidence.atoms.find((candidate) => candidate.atom_id === atomId)!;
      return registry.spans.find((span) =>
        span.atom_id === atomId && span.start === 0 && span.end === atom.text.length)!.span_id;
    };

    const contract = await controller.dispatch("get_document_selector_contract", {});
    expect(contract.ok).toBe(true);
    expect(contract.full_atom_spans).toEqual(
      controller.evidence.atoms.map((atom) => ({
        atom_id: atom.atom_id,
        span_id: fullSpanFor(atom.atom_id),
      })),
    );

    const listed = await controller.dispatch("list_document_atoms", {});
    const entries = listed.atoms as Array<{ atom_id: string; full_atom_span_id: string }>;
    expect(entries).toHaveLength(controller.evidence.atoms.length);
    for (const entry of entries) {
      expect(entry.full_atom_span_id).toBe(fullSpanFor(entry.atom_id));
    }

    const opened = await controller.dispatch("open_document_atom", {
      atom_id: controller.evidence.atoms[0]!.atom_id,
    });
    expect(opened.full_atom_span_id).toBe(fullSpanFor(controller.evidence.atoms[0]!.atom_id));
  });

  test("locate failures return a verbatim-copy instruction instead of a bare error", async () => {
    const root = await tempRoot("document-discovery-locate-hint");
    const markdownPath = join(root, "source.md");
    const markdown = "前置说明。地基承载力应满足设计要求。后续说明。";
    await writeFile(markdownPath, markdown, "utf8");
    const workspace = await DocumentDiscoveryWorkspace.openOrCreate(root, "job", markdownPath);
    const controller = await DocumentDiscoveryController.create(workspace, "candidate");
    const atom = controller.evidence.atoms[0]!;
    await controller.dispatch("open_document_atom", { atom_id: atom.atom_id });

    const failed = await controller.dispatch("locate_document_span", {
      atom_id: atom.atom_id,
      quote: "承载力必须满足设计要求",
    });
    expect(failed).toMatchObject({ ok: false, error: "selector_span_not_found" });
    expect(failed.instruction).toContain("character-exact");

    const exact = await controller.dispatch("locate_document_span", {
      atom_id: atom.atom_id,
      quote: "地基承载力应满足设计要求",
    });
    expect(exact).toMatchObject({ ok: true });
  });

  test("discovery span context feedback names available tools and preserves a matching quote", async () => {
    const root = await tempRoot("document-discovery-locate-context-feedback");
    const markdownPath = join(root, "source.md");
    await writeFile(markdownPath, "甲。组件连接应牢固。乙。组件连接应牢固。丙。", "utf8");
    const workspace = await DocumentDiscoveryWorkspace.openOrCreate(root, "job", markdownPath);
    const controller = await DocumentDiscoveryController.create(workspace, "candidate");
    const atom = controller.evidence.atoms[0]!;
    await controller.dispatch("open_document_atom", { atom_id: atom.atom_id });

    const failed = await controller.dispatch("batch_locate_document_spans", { requests: [
      { atom_id: atom.atom_id, quote: "组件连接应牢固", suffix: "不存在的后文" },
    ] });
    expect(failed.ok).toBe(false);
    const result = (failed.results as Array<Record<string, unknown>>)[0]!;
    expect(result).toMatchObject({ error: "selector_span_not_found", issues: [{ details: {
      quote_match_count: 2, next_tool: "locate_document_span", batch_next_tool: "batch_locate_document_spans",
    } }] });
    expect(result.instruction).toContain("Keep the quote");
    expect(result.instruction).not.toContain("character-exact");

    expect(await controller.dispatch("locate_document_span", {
      atom_id: atom.atom_id, quote: "组件连接应牢固", prefix: "甲。",
    })).toMatchObject({ ok: true });
  });

  test("locate_document_span accepts prefix and suffix to disambiguate repeated exact quotes", async () => {
    const root = await tempRoot("document-discovery-locate-context");
    const markdownPath = join(root, "source.md");
    const markdown = "甲：地基承载力应满足设计要求。乙。丙：地基承载力应满足设计要求。丁。";
    await writeFile(markdownPath, markdown, "utf8");
    const workspace = await DocumentDiscoveryWorkspace.openOrCreate(root, "job", markdownPath);
    const controller = await DocumentDiscoveryController.create(workspace, "candidate");
    const atom = controller.evidence.atoms[0]!;
    await controller.dispatch("open_document_atom", { atom_id: atom.atom_id });

    const ambiguous = await controller.dispatch("locate_document_span", {
      atom_id: atom.atom_id,
      quote: "地基承载力应满足设计要求",
    });
    expect(ambiguous).toMatchObject({ ok: false, error: "selector_span_not_unique" });
    expect(ambiguous.instruction).toContain("prefix/suffix");

    const located = await controller.dispatch("locate_document_span", {
      atom_id: atom.atom_id,
      quote: "地基承载力应满足设计要求",
      prefix: "丙：",
      suffix: "。丁",
    });
    expect(located).toMatchObject({ ok: true });
  });

  test("selector read schema and runtime expose only actionable collection choices", async () => {
    const root = await tempRoot("document-discovery-read-collections");
    const markdownPath = join(root, "source.md");
    await writeFile(markdownPath, "地基承载力应满足设计要求。", "utf8");
    const workspace = await DocumentDiscoveryWorkspace.openOrCreate(root, "job", markdownPath);
    const controller = await DocumentDiscoveryController.create(workspace, "candidate");
    const readTool = createDocumentDiscoveryTools(controller)
      .find((tool) => tool.name === "read_document_selectors")! as unknown as { parameters: unknown };
    const schema = JSON.stringify(readTool.parameters);
    for (const collection of ["targets", "contexts", "dispositions"]) {
      expect(schema).toContain(`\"const\":\"${collection}\"`);
    }

    expect(await controller.dispatch("read_document_selectors", { collection: "span_registry" }))
      .toMatchObject({
        ok: false,
        error: "unknown_selector_collection",
        allowed_collections: ["targets", "contexts", "dispositions"],
        instruction: expect.stringContaining("choose one allowed collection"),
      });
  });

  test("invalid disposition span checkpoints return registered replacement candidates", async () => {
    const root = await tempRoot("document-discovery-disposition-candidates");
    const markdownPath = join(root, "source.md");
    await writeFile(markdownPath, "地基承载力应满足设计要求。", "utf8");
    const workspace = await DocumentDiscoveryWorkspace.openOrCreate(root, "job", markdownPath);
    const controller = await DocumentDiscoveryController.create(workspace, "candidate");
    const atom = controller.evidence.atoms[0]!;

    const patched = await controller.dispatch("patch_document_selectors", {
      operations: [{
        op: "add",
        path: "/dispositions/-",
        value: {
          atom_span_id: `span:${"0".repeat(32)}`,
          disposition: "irrelevant",
          target_keys: [],
          reason: "本测试只验证机械绑定错误的恢复信息",
        },
      }],
    });
    expect(patched).toMatchObject({
      ok: false,
      selector_issues: [expect.objectContaining({ code: "selector_unknown_span" })],
      allowed_full_atom_spans: [expect.objectContaining({ atom_id: atom.atom_id })],
      instruction: expect.stringContaining("replace atom_span_id"),
    });
  });

  test("blocks sealing when the independent reviewer has not reopened every document atom", async () => {
    const root = await tempRoot("document-discovery-incomplete-review");
    const markdownPath = join(root, "source.md");
    const markdown = "地基承载力应满足设计要求。".repeat(500);
    await writeFile(markdownPath, markdown, "utf8");
    const workspace = await DocumentDiscoveryWorkspace.openOrCreate(root, "review-job", markdownPath);
    const controller = await DocumentDiscoveryController.create(workspace, "candidate");
    expect(controller.evidence.atoms.length).toBeGreaterThan(1);
    for (const atom of controller.evidence.atoms) {
      await controller.dispatch("open_document_atom", { atom_id: atom.atom_id });
    }
    const { plan } = validPlan("review-job", markdown);
    plan.dispositions = controller.evidence.atoms.map((atom, index) => index === 0
      ? {
          atom_id: atom.atom_id,
          disposition: "target",
          target_ids: ["domain-target-001"],
          reason: "该原子包含地基验收业务内容",
        }
      : {
          atom_id: atom.atom_id,
          disposition: "irrelevant",
          target_ids: [],
          reason: "重复文本不增加新的验收业务目标",
        });
    await controller.dispatch("replace_discovery_plan", { content: JSON.stringify(plan) });
    const validation = await controller.dispatch("validate_discovery_plan", {});
    expect(validation).toMatchObject({ ok: true });
    expect(await controller.dispatch("submit_discovery_candidate", {
      fingerprint: validation.fingerprint,
    })).toMatchObject({ ok: true, status: "candidate" });

    const reviewer = await DocumentDiscoveryController.create(workspace, "review");
    await reviewer.dispatch("open_document_atom", { atom_id: reviewer.evidence.atoms[0]!.atom_id });
    const reviewed = await reviewer.dispatch("validate_discovery_plan", {});
    expect(reviewed.ok).toBe(false);
    expect(reviewed.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "unopened_document_atom" }),
    ]));
    expect(await reviewer.dispatch("seal_discovery_plan", {
      fingerprint: validation.fingerprint,
    })).toMatchObject({ ok: false });
  });

  test("rejects legacy discovery plans that lack semantic context and lot-basis proof", () => {
    const markdown = "地基承载力应满足设计要求。".repeat(40);
    const { evidence, plan } = validPlan("legacy-job", markdown);
    const legacy = structuredClone(plan) as unknown as Record<string, unknown>;
    legacy.schema_version = "document-target-plan/v2";
    delete legacy.context_notes;
    delete (legacy.targets as Array<Record<string, unknown>>)[0]!.materialization;
    const validation = validateDocumentTargetPlan(
      legacy,
      evidence,
      "legacy-job",
      new Set(evidence.atoms.map((atom) => atom.atom_id)),
    );
    expect(validation.ok).toBe(false);
    expect(validation.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "schema_version" }),
      expect.objectContaining({ code: "context_notes_type" }),
    ]));
  });

  test("allows a semantic lot-basis summary to paraphrase while exact citations stay strict", () => {
    const markdown = "地基承载力应满足设计要求。".repeat(40);
    const { evidence, plan } = validPlan("summary-job", markdown);
    plan.targets[0]!.materialization.lot_basis_summary = "以承载能力符合设计作为地基检验批的划分依据";
    expect(markdown).not.toContain(plan.targets[0]!.materialization.lot_basis_summary);

    const opened = new Set(evidence.atoms.map((atom) => atom.atom_id));
    expect(validateDocumentTargetPlan(plan, evidence, "summary-job", opened)).toMatchObject({ ok: true });

    plan.targets[0]!.materialization.lot_basis_fragments[0]!.text = "承载能力符合设计";
    const invalid = validateDocumentTargetPlan(plan, evidence, "summary-job", opened);
    expect(invalid.ok).toBe(false);
    expect(invalid.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "target_lot_basis_not_exact" }),
    ]));
  });

  test("canonicalizes GB 50209 formatting-only target citations and derives description", () => {
    const exact = "4.3.6 灰土体积比应符合设计要求。";
    const exactMatchedRange = exact.slice(0, -1);
    const markdown = ["# 4.3 灰土垫层 [PDF p.24]", exact].join("\n");
    const { evidence, plan } = validPlan("gb50209-format-target", markdown);
    const target = plan.targets[0]!;
    target.name = "灰土垫层";
    target.description = "";
    target.materialization.lot_basis_summary = "按灰土体积比要求形成检验批";
    const formatted = "4．3．6　灰土体积比，应符合设计要求";
    target.evidence_fragments = [{ atom_id: evidence.atoms[0]!.atom_id, text: formatted }];
    target.materialization.lot_basis_fragments = [{
      atom_id: evidence.atoms[0]!.atom_id,
      text: formatted,
    }];

    const validation = validateDocumentTargetPlan(
      plan,
      evidence,
      "gb50209-format-target",
      new Set([evidence.atoms[0]!.atom_id]),
    );

    expect(validation).toMatchObject({ ok: true, issues: [] });
    expect(validation.plan!.targets[0]).toMatchObject({
      description: "灰土垫层：按灰土体积比要求形成检验批",
      evidence_fragments: [{ text: exactMatchedRange }],
      materialization: { lot_basis_fragments: [{ text: exactMatchedRange }] },
    });
    expect(evidence.atoms[0]!.text).toContain(validation.plan!.targets[0]!.evidence_fragments[0]!.text);
  });

  test("persists deterministic citation canonicalization before discovery sealing", async () => {
    const root = await tempRoot("gb50209-canonical-working-plan");
    const markdownPath = join(root, "source.md");
    const exact = "4.4.4 砂垫层和砂石垫层的干密度(或贯入度)应符合设计要求。";
    const exactMatchedRange = exact.slice(0, -1);
    await writeFile(markdownPath, exact, "utf8");
    const workspace = await DocumentDiscoveryWorkspace.openOrCreate(
      root,
      "gb50209-canonical-working-plan",
      markdownPath,
    );
    const controller = await DocumentDiscoveryController.create(workspace, "candidate");
    const atom = controller.evidence.atoms[0]!;
    await controller.dispatch("open_document_atom", { atom_id: atom.atom_id });
    const { plan } = validPlan("gb50209-canonical-working-plan", exact);
    plan.document_fingerprint = controller.evidence.evidence_fingerprint;
    plan.targets[0]!.evidence_atom_ids = [atom.atom_id];
    plan.targets[0]!.description = "";
    plan.targets[0]!.evidence_fragments = [{
      atom_id: atom.atom_id,
      text: "4.4.4砂垫层和砂石垫层的干密度（或贯入度），应符合设计要求",
    }];
    plan.targets[0]!.materialization.lot_basis_fragments = structuredClone(
      plan.targets[0]!.evidence_fragments,
    );
    plan.dispositions = [{
      atom_id: atom.atom_id,
      disposition: "target",
      target_ids: [plan.targets[0]!.target_id],
      reason: "该原子包含砂垫层和砂石垫层验收要求",
    }];
    await controller.dispatch("replace_discovery_plan", { content: prettyJson(plan) });

    const validation = await controller.dispatch("validate_discovery_plan", {});
    expect(validation).toMatchObject({ ok: true, fingerprint: expect.any(String) });
    const persisted = JSON.parse(await readFile(workspace.workingPlanPath, "utf8")) as DocumentTargetPlan;
    expect(persisted.targets[0]!.description).toBe(
      `${persisted.targets[0]!.name}：${persisted.targets[0]!.materialization.lot_basis_summary}`,
    );
    expect(persisted.targets[0]!.evidence_fragments[0]!.text).toBe(exactMatchedRange);
    expect(persisted.targets[0]!.materialization.lot_basis_fragments[0]!.text).toBe(exactMatchedRange);
    expect(await controller.dispatch("submit_discovery_candidate", {
      fingerprint: validation.fingerprint,
    })).toMatchObject({ ok: true, status: "candidate" });
    const reviewer = await DocumentDiscoveryController.create(workspace, "review");
    await reviewer.dispatch("open_document_atom", { atom_id: atom.atom_id });
    const reviewed = await reviewer.dispatch("validate_discovery_plan", {});
    expect(reviewed).toMatchObject({ ok: true, fingerprint: expect.any(String) });
    expect(await reviewer.dispatch("seal_discovery_plan", {
      fingerprint: reviewed.fingerprint,
    })).toMatchObject({ ok: true });
    const sealed = JSON.parse(await readFile(workspace.sealedPlanPath, "utf8")) as DocumentTargetPlan;
    expect(sealed).toEqual(persisted);
  });

  test("deduplicates a substantive GB 50209 citation mismatch across target fields", () => {
    const exact = "7.3.6 实木复合地板面层采用的地板、胶粘剂等提出要求和检验方法。";
    const { evidence, plan } = validPlan("gb50209-substantive-mismatch", exact);
    const altered = "7.3.6 面层采用的地板、胶粘剂等提出要求和检验方法";
    plan.targets[0]!.evidence_fragments = [{ atom_id: evidence.atoms[0]!.atom_id, text: altered }];
    plan.targets[0]!.materialization.lot_basis_fragments = [{
      atom_id: evidence.atoms[0]!.atom_id,
      text: altered,
    }];

    const validation = validateDocumentTargetPlan(
      plan,
      evidence,
      "gb50209-substantive-mismatch",
      new Set([evidence.atoms[0]!.atom_id]),
    );
    const exactIssues = validation.issues.filter((issue) =>
      issue.code === "fragment_not_exact" || issue.code === "target_lot_basis_not_exact");

    expect(validation.ok).toBe(false);
    expect(exactIssues).toHaveLength(1);
    expect(exactIssues[0]).toMatchObject({
      code: "fragment_not_exact",
      details: {
        affected_fields: ["evidence_fragments", "materialization.lot_basis_fragments"],
        affected_paths: [
          "/targets/0/evidence_fragments/0",
          "/targets/0/materialization/lot_basis_fragments/0",
        ],
      },
    });
  });

  test("keeps semantic punctuation changes and nonunique normalized matches as hard issues", () => {
    const percentageSource = "取芯数量不应少于总桩数的0.5%，且不应少于3根。";
    const percentage = validPlan("semantic-punctuation", percentageSource);
    const missingPercent = "取芯数量不应少于总桩数的0.5，且不应少于3根";
    percentage.plan.targets[0]!.evidence_fragments = [{
      atom_id: percentage.evidence.atoms[0]!.atom_id,
      text: missingPercent,
    }];
    percentage.plan.targets[0]!.materialization.lot_basis_fragments = structuredClone(
      percentage.plan.targets[0]!.evidence_fragments,
    );
    expect(validateDocumentTargetPlan(
      percentage.plan,
      percentage.evidence,
      "semantic-punctuation",
      new Set([percentage.evidence.atoms[0]!.atom_id]),
    ).issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "fragment_not_exact" }),
    ]));

    const repeatedSource = "4.3.6 灰土体积比应符合设计要求。\n4.3.6 灰土体积比应符合设计要求。";
    const repeated = validPlan("nonunique-format-match", repeatedSource);
    const formatted = "4．3．6　灰土体积比，应符合设计要求";
    repeated.plan.targets[0]!.evidence_fragments = [{
      atom_id: repeated.evidence.atoms[0]!.atom_id,
      text: formatted,
    }];
    repeated.plan.targets[0]!.materialization.lot_basis_fragments = structuredClone(
      repeated.plan.targets[0]!.evidence_fragments,
    );
    expect(validateDocumentTargetPlan(
      repeated.plan,
      repeated.evidence,
      "nonunique-format-match",
      new Set([repeated.evidence.atoms[0]!.atom_id]),
    ).issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "fragment_not_exact" }),
    ]));
  });

  test("returns exact split candidates for a GB 50209 page-boundary context citation", () => {
    const beforeMarker = "3.0.21 建筑地面工程施工质量的检验,应符合下列规定:\n1 基层(各构造层)和各类面层的分项工程的施工质量验收";
    const afterMarker = "应按每一层次或每层施工段(或变形缝)划分检验批";
    const markdown = `${beforeMarker}\n\n<!-- pages_021_030 -->\n\n${afterMarker}`;
    const { evidence, plan } = validPlan("gb50209-page-boundary", markdown);
    const atom = evidence.atoms[0]!;
    plan.targets[0]!.evidence_fragments = [{ atom_id: atom.atom_id, text: "3.0.21 建筑地面工程施工质量的检验" }];
    plan.targets[0]!.materialization.lot_basis_fragments = structuredClone(
      plan.targets[0]!.evidence_fragments,
    );
    plan.context_notes = [{
      context_id: "inspection-lot-division",
      role: "governing_rule",
      name: "检验批划分",
      evidence_atom_ids: [atom.atom_id],
      evidence_fragments: [{
        atom_id: atom.atom_id,
        text: `${beforeMarker}${afterMarker}`,
      }],
      reason: "规定建筑地面工程检验批划分方式",
    }];

    const validation = validateDocumentTargetPlan(
      plan,
      evidence,
      "gb50209-page-boundary",
      new Set([atom.atom_id]),
    );

    expect(validation.ok).toBe(false);
    expect(validation.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "context_fragment_not_exact",
        details: expect.objectContaining({
          exact_fragment_candidates: [{
            reason: "markdown_page_boundary",
            fragments: [
              { atom_id: atom.atom_id, text: beforeMarker },
              { atom_id: atom.atom_id, text: afterMarker },
            ],
          }],
        }),
      }),
    ]));
  });

  test("migrates v3 paraphrased lot-basis text into summary without changing reason or exact citations", () => {
    const markdown = "地基承载力应满足设计要求。".repeat(40);
    const { evidence, plan } = validPlan("migration-job", markdown);
    const legacy = structuredClone(plan) as unknown as Record<string, any>;
    legacy.schema_version = "document-target-plan/v3";
    delete legacy.targets[0].materialization.lot_basis_summary;
    legacy.targets[0].materialization.lot_basis_fragments.push({
      atom_id: evidence.atoms[0]!.atom_id,
      text: "以地基承载能力满足设计作为检验批划分依据",
    });
    const originalReason = legacy.targets[0].materialization.reason;

    const migrated = migrateDocumentTargetPlan(legacy, evidence) as DocumentTargetPlan;
    expect(migrated.schema_version).toBe("document-target-plan/v4");
    expect(migrated.targets[0]!.materialization).toMatchObject({
      lot_basis_summary: "以地基承载能力满足设计作为检验批划分依据",
      reason: originalReason,
      lot_basis_fragments: [{
        atom_id: evidence.atoms[0]!.atom_id,
        text: "地基承载力应满足设计要求",
      }],
    });
    expect(validateDocumentTargetPlan(
      migrated,
      evidence,
      "migration-job",
      new Set(evidence.atoms.map((atom) => atom.atom_id)),
    )).toMatchObject({ ok: true });
  });

  test("requires small durable discovery checkpoints instead of whole-plan regeneration", async () => {
    const root = await tempRoot("document-discovery-checkpoints");
    const markdownPath = join(root, "source.md");
    const markdown = "地基承载力应满足设计要求。".repeat(40);
    await writeFile(markdownPath, markdown, "utf8");
    const workspace = await DocumentDiscoveryWorkspace.openOrCreate(root, "checkpoint-job", markdownPath);
    const controller = await DocumentDiscoveryController.create(workspace, "candidate");
    const { plan } = validPlan("checkpoint-job", markdown);
    const bulkPlan = structuredClone(plan);
    bulkPlan.targets = Array.from({ length: 5 }, (_, index) => ({
      ...structuredClone(plan.targets[0]!),
      target_id: `domain-target-${index + 1}`,
    }));
    bulkPlan.dispositions[0]!.target_ids = bulkPlan.targets.map((target) => target.target_id);
    expect(await controller.dispatch("replace_discovery_plan", {
      content: JSON.stringify(bulkPlan),
    })).toMatchObject({ ok: false, error: "incremental_discovery_checkpoint_required" });

    expect(await controller.dispatch("replace_discovery_plan", {
      content: JSON.stringify(plan),
    })).toMatchObject({ ok: true });
    expect(await controller.dispatch("replace_discovery_plan", {
      content: JSON.stringify(plan),
    })).toMatchObject({ ok: false, error: "incremental_discovery_patch_required" });
    expect(await controller.dispatch("patch_discovery_plan", {
      operations: [{ op: "replace", path: "/targets", value: plan.targets }],
    })).toMatchObject({ ok: false, error: "incremental_discovery_item_patch_required" });
  });

  test("allows an explicit offline plan import to replace the initial workfile in one step", async () => {
    const root = await tempRoot("document-discovery-offline-import");
    const markdownPath = join(root, "source.md");
    const markdown = "地基承载力应满足设计要求。".repeat(40);
    await writeFile(markdownPath, markdown, "utf8");
    const workspace = await DocumentDiscoveryWorkspace.openOrCreate(root, "offline-job", markdownPath);
    await workspace.setRuntime({
      kind: "offline-scripted",
      session_id: "offline-discovery-offline-job",
      session_file: workspace.transcriptPath,
    });
    const controller = await DocumentDiscoveryController.create(workspace, "candidate");
    const { plan } = validPlan("offline-job", markdown);
    const bulkPlan = structuredClone(plan);
    bulkPlan.targets = Array.from({ length: 5 }, (_, index) => ({
      ...structuredClone(plan.targets[0]!),
      target_id: `offline-target-${index + 1}`,
    }));
    bulkPlan.dispositions[0]!.target_ids = bulkPlan.targets.map((target) => target.target_id);

    expect(await controller.dispatch("replace_discovery_plan", {
      content: JSON.stringify(bulkPlan),
    })).toMatchObject({ ok: true });
  });

  test("does not require registration for a global atom contained by a legacy target window", async () => {
    const root = await tempRoot("contained-global-atom");
    const markdownPath = join(root, "source.md");
    const markdown = "地基承载力应满足设计要求。".repeat(40);
    await writeFile(markdownPath, markdown, "utf8");
    const { evidence, plan } = validPlan("job-contained", markdown);
    const prepared = await buildAgentScopedEvidenceManifest(
      markdownPath,
      "job-contained",
      plan.targets[0]!,
      evidence,
    );
    const primary = prepared.manifest.evidence[0]!;
    const currentAtomId = primary.evidence_id;
    const legacyAtomId = "atom:legacy-contained-window";
    primary.evidence_id = legacyAtomId;
    prepared.manifest.scope.selected_atom_ids = [legacyAtomId];
    prepared.manifest.scope.target_evidence_fragments = prepared.manifest.scope.target_evidence_fragments?.map((fragment) => ({
      ...fragment,
      atom_id: fragment.atom_id === currentAtomId ? legacyAtomId : fragment.atom_id,
    }));

    const revision = await RevisionWorkspace.createFromEvidence(
      root,
      "job-contained",
      plan.targets[0]!.target_id,
      prepared,
    );
    const controller = await ToolController.create(revision);
    const search = await controller.dispatch("search_global_document_resources", { query: "地基承载力" });
    const globalAtomId = (search.matches as Array<{ atom_id: string }>)[0]!.atom_id;
    expect(globalAtomId).not.toBe(legacyAtomId);

    expect(await controller.dispatch("register_external_dependency", {
      atom_id: globalAtomId,
      mode: "scope_extension",
      reason: "全局导航 atom 被当前 legacy target 物理窗口完整包含",
    })).toMatchObject({
      ok: true,
      already_available: true,
      registration_required: false,
      match: "contained_physical_window",
      requested_resource: { atom_id: globalAtomId },
      resource: { evidence_id: legacyAtomId },
    });
  });

  test("returns an executable open-then-retry route for an unopened global atom", { timeout: 15_000 }, async () => {
    const root = await tempRoot("unopened-global-resource-feedback");
    const markdownPath = join(root, "source.md");
    const targetPhrase = "对象质量应满足设计要求";
    const externalPhrase = "外部共享规则应另行核对";
    const markdown = `${targetPhrase}。\n${"当前目标背景。".repeat(140)}\n${externalPhrase}。`;
    await writeFile(markdownPath, markdown, "utf8");
    const evidence = buildDocumentEvidence(markdown, "source.md", 1_000);
    const targetAtom = evidence.atoms[0]!;
    const plan: DocumentTargetPlan = {
      schema_version: "document-target-plan/v4",
      job_id: "unopened-global-resource",
      document_fingerprint: evidence.evidence_fingerprint,
      targets: [{
        target_id: "domain-target-001",
        group_id: "domain-group-generic",
        group_name: "目标对象",
        group_reason: "通用测试范围",
        name: "对象验收",
        description: "对象质量验收要求",
        evidence_atom_ids: [targetAtom.atom_id],
        evidence_fragments: [{ atom_id: targetAtom.atom_id, text: targetPhrase }],
        materialization: {
          kind: "inspection_scope",
          lot_basis_summary: "以对象质量要求作为检验批依据",
          lot_basis_fragments: [{ atom_id: targetAtom.atom_id, text: targetPhrase }],
          reason: "原文包含对象质量要求",
        },
        reason: "通用测试目标",
      }],
      context_notes: [],
      dispositions: evidence.atoms.map((atom, index) => ({
        atom_id: atom.atom_id,
        disposition: index === 0 ? "target" : "context",
        target_ids: index === 0 ? ["domain-target-001"] : [],
        reason: index === 0 ? "目标原子" : "范围外上下文",
      })),
    };
    const prepared = await buildAgentScopedEvidenceManifest(
      markdownPath,
      "unopened-global-resource",
      plan.targets[0]!,
      evidence,
      undefined,
      { start_line: 1, end_exclusive_line: 2 },
    );
    const revision = await RevisionWorkspace.createFromEvidence(
      root,
      "unopened-global-resource",
      plan.targets[0]!.target_id,
      prepared,
    );
    const controller = await ToolController.create(revision);
    const search = await controller.dispatch("search_global_document_resources", { query: externalPhrase });
    expect(search).toMatchObject({ ok: true, unresolved: false });
    const atomId = (search.matches as Array<{ atom_id: string }>)[0]!.atom_id;
    const beforeManifest = await revision.readEvidenceManifest();
    const beforeState = await revision.readState();

    const rejected = await controller.dispatch("register_external_dependency", {
      atom_id: atomId,
      mode: "dependency",
      reason: "外部规则用于核对共享适用性",
    });
    expect(rejected).toMatchObject({
      ok: false,
      error: "global_document_resource_not_opened",
      terminal: false,
      durable_mutation: false,
      budget_consumed: false,
      actual: { atom_id: atomId, opened_global_resource: false },
      atom_id: atomId,
      candidate_read_tool: "open_global_document_resource",
      next_tool: "open_global_document_resource",
      next_tool_arguments: { atom_id: atomId },
      retry_tool: "register_external_dependency",
      retry_arguments: {
        atom_id: atomId,
        mode: "dependency",
        reason: "外部规则用于核对共享适用性",
      },
      do_not_edit: expect.stringContaining("不可变原文"),
      instruction: expect.stringContaining("打开成功后"),
    });
    expect(await revision.readEvidenceManifest()).toEqual(beforeManifest);
    expect(await revision.readState()).toMatchObject({
      ...beforeState,
      next_event_sequence: expect.any(Number),
    });
    expect((await revision.readState()).opened_global_resource_ids)
      .toEqual(beforeState.opened_global_resource_ids);
    expect((await revision.readState()).opened_evidence_ids)
      .toEqual(beforeState.opened_evidence_ids);

    expect(await controller.dispatch("open_global_document_resource", { atom_id: atomId }))
      .toMatchObject({ ok: true, resource: { atom_id: atomId } });
    const registered = await controller.dispatch("register_external_dependency", {
      atom_id: atomId,
      mode: "dependency",
      reason: "外部规则用于核对共享适用性",
    });
    expect(registered).toMatchObject({
      ok: true,
      dependency_registered: true,
      business_span_available: false,
      next_tool: "locate_evidence_span",
      tool_argument_hints: {
        locate_evidence_span: {
          evidence_id: atomId,
          quote: expect.stringContaining("逐字复制"),
        },
      },
      instruction: expect.stringContaining("精确原文"),
    });
    expect(registered).not.toHaveProperty("chunk_span");
    expect((await revision.readSourceSpanRegistry()).spans.some((span) => span.evidence_id === atomId)).toBe(false);

    const located = await controller.dispatch("locate_evidence_span", {
      evidence_id: atomId,
      quote: externalPhrase,
    });
    expect(located).toMatchObject({
      ok: true,
      span: {
        evidence_id: atomId,
        start: expect.any(Number),
        end: expect.any(Number),
      },
    });
    const preciseSpan = (located as { span: { start: number; end: number } }).span;
    expect(preciseSpan.end - preciseSpan.start).toBe(externalPhrase.length);
  });

  test("recognizes a fully selected atom after it is decomposed into line evidence", async () => {
    const root = await tempRoot("selected-atom-lineage");
    const markdownPath = join(root, "source.md");
    const markdown = [
      "## 4.2 地基验收",
      "4.2.1 地基承载力应满足设计要求。",
      "检查数量：全数检查。",
      "检验方法：检查检测报告。",
    ].join("\n");
    await writeFile(markdownPath, markdown, "utf8");
    const { evidence, plan } = validPlan("job-selected-lineage", markdown);
    const atom = evidence.atoms[0]!;
    const prepared = await buildAgentScopedEvidenceManifest(
      markdownPath,
      "job-selected-lineage",
      plan.targets[0]!,
      evidence,
      undefined,
      { start_line: atom.start_line, end_exclusive_line: atom.end_line + 1 },
    );
    expect(prepared.manifest.evidence.some((record) => record.evidence_id === atom.atom_id)).toBe(false);
    expect(prepared.manifest.evidence.some((record) => record.atom_id === atom.atom_id)).toBe(true);
    expect(prepared.manifest.evidence.filter((record) => /^line:/u.test(record.locator))
      .every((record) => record.atom_id === atom.atom_id)).toBe(true);

    const revision = await RevisionWorkspace.createFromEvidence(
      root,
      "job-selected-lineage",
      plan.targets[0]!.target_id,
      prepared,
    );
    const controller = await ToolController.create(revision);
    expect(await controller.dispatch("open_global_document_resource", { atom_id: atom.atom_id }))
      .toMatchObject({ ok: true });
    expect(await controller.dispatch("register_external_dependency", {
      atom_id: atom.atom_id,
      mode: "scope_extension",
      reason: "该完整 atom 已在当前精确范围内，不能再次消耗 scope refresh。",
    })).toMatchObject({
      ok: true,
      already_available: true,
      registration_required: false,
      match: "selected_atom_lineage",
      atom_id: atom.atom_id,
      existing_evidence_count: expect.any(Number),
      existing_evidence: expect.arrayContaining([
        expect.objectContaining({ atom_id: atom.atom_id }),
      ]),
    });

    const legacyRoot = await tempRoot("selected-atom-lineage-legacy");
    const legacyManifest = structuredClone(prepared.manifest);
    legacyManifest.evidence = legacyManifest.evidence.map((record) => {
      const { atom_id: _atomId, ...legacyRecord } = record;
      return legacyRecord;
    });
    const { evidence_fingerprint: _oldFingerprint, ...legacyPayload } = legacyManifest;
    legacyManifest.evidence_fingerprint = sha256Json(legacyPayload);
    const legacyRevision = await RevisionWorkspace.createFromEvidence(
      legacyRoot,
      "job-selected-lineage",
      plan.targets[0]!.target_id,
      { ...prepared, manifest: legacyManifest },
    );
    const legacyController = await ToolController.create(legacyRevision);
    expect(await legacyController.dispatch("open_global_document_resource", { atom_id: atom.atom_id }))
      .toMatchObject({ ok: true });
    expect(await legacyController.dispatch("register_external_dependency", {
      atom_id: atom.atom_id,
      mode: "scope_extension",
      reason: "旧 manifest 没有 atom_id，也必须按完整行范围识别为已存在。",
    })).toMatchObject({
      ok: true,
      already_available: true,
      registration_required: false,
      match: "selected_atom_line_range",
      atom_id: atom.atom_id,
    });
  });

  test("builds downstream target evidence only from Agent-selected neutral atoms", { timeout: 10_000 }, async () => {
    const root = await tempRoot("agent-scoped-evidence");
    const markdownPath = join(root, "source.md");
    const targetText = [
      "## 4.2 被破坏也不可信的标题",
      "<table><tr><td>主控项目</td><td>地基承载力应满足设计要求</td></tr></table>",
    ].join("\n").repeat(80);
    const dependencyText = "远端跨章节表9.9.9规定共享抽样规则，每批抽查3处。";
    const directText = "远端遗漏的本目标直接验收条文，强度应符合设计要求。";
    const markdown = `${targetText}\n${"与该目标无关的远端全文原子。".repeat(6_000)}${dependencyText}${"继续填充远端原子。".repeat(6_000)}${directText}`;
    await writeFile(markdownPath, markdown, "utf8");
    const { evidence, plan } = validPlan("job", markdown);
    expect(evidence.atoms.length).toBeGreaterThan(3);
    const prepared = await buildAgentScopedEvidenceManifest(
      markdownPath,
      "job",
      plan.targets[0]!,
      evidence,
    );
    expect(prepared.manifest.source.adapter).toBe("document-domain-agent/v1");
    expect(prepared.manifest.source.semantic_workflow).toBe("semantic-evidence-plan/v1");
    expect(prepared.manifest.scope.mode).toBe("agent_discovered");
    expect(prepared.manifest.scope.selected_start_line).toBe(2);
    expect(prepared.manifest.table_fragments).toEqual([
      expect.objectContaining({
        fragment_id: "table-fragment:line-2",
        provisional_table_id: "line-2",
        row_evidence_ids: [expect.any(String)],
      }),
    ]);
    expect(prepared.manifest.reference_occurrences).toEqual([]);
    expect(prepared.manifest.evidence).toHaveLength(4);
    expect(prepared.manifest.evidence[0]).toMatchObject({
      evidence_id: plan.targets[0]!.evidence_atom_ids[0],
      role: "context",
      requires_disposition: true,
      evidence_scope: "primary",
    });
    expect(prepared.manifest.evidence[1]!.evidence_scope).toBeUndefined();
    expect(prepared.manifest.evidence.find((record) => record.kind === "heading")).toMatchObject({
      kind: "heading",
      role: "context",
      requires_disposition: false,
    });

    const revision = await RevisionWorkspace.createFromEvidence(
      root,
      "job",
      plan.targets[0]!.target_id,
      prepared,
    );
    const controller = await ToolController.create(revision);
    const alreadyScopedAtomId = prepared.manifest.evidence[0]!.evidence_id;
    expect(await controller.dispatch("register_external_dependency", {
      atom_id: alreadyScopedAtomId,
      mode: "dependency",
      reason: "检查工具人体工学",
    })).toMatchObject({
      ok: true,
      already_available: true,
      registration_required: false,
      instruction: expect.stringContaining("不要注册"),
    });
    const initialContext = await controller.dispatch("get_target_context", { limit: 100 });
    expect(JSON.stringify(initialContext)).not.toContain(dependencyText);
    expect(JSON.stringify(initialContext)).not.toContain(directText);
    expect(prepared.manifest.evidence.map((record) => record.evidence_id)).not.toContain(evidence.atoms.at(-1)!.atom_id);

    const dependencySearch = await controller.dispatch("search_global_document_resources", { query: "表9.9.9规定共享抽样规则" });
    expect(dependencySearch).toMatchObject({ ok: true, unresolved: false });
    const dependencyAtomId = (dependencySearch.matches as Array<{ atom_id: string }>)[0]!.atom_id;
    expect(await controller.dispatch("open_global_document_resource", { atom_id: dependencyAtomId }))
      .toMatchObject({ ok: true, text: expect.stringContaining(dependencyText) });
    expect(await controller.dispatch("open_adjacent_document_resource", { atom_id: dependencyAtomId, direction: "previous" }))
      .toMatchObject({ ok: true, resource: { atom_id: expect.any(String) } });
    expect(await controller.dispatch("register_external_dependency", {
      atom_id: dependencyAtomId,
      mode: "dependency",
      reason: "同文档跨章节共享抽样规则",
    })).toMatchObject({
      ok: true,
      dependency_registered: true,
      business_span_available: false,
      next_tool: "locate_evidence_span",
      tool_argument_hints: {
        locate_evidence_span: {
          evidence_id: dependencyAtomId,
          quote: expect.stringContaining("逐字复制"),
        },
      },
    });
    expect((await revision.readEvidenceManifest()).evidence.map((record) => record.evidence_id)).toContain(dependencyAtomId);

    const directSearch = await controller.dispatch("search_global_document_resources", { query: "远端遗漏的本目标直接验收条文" });
    const directAtomId = (directSearch.matches as Array<{ atom_id: string }>)[0]!.atom_id;
    await controller.dispatch("open_global_document_resource", { atom_id: directAtomId });
    const beforeScopeRequest = await readFile(revision.evidenceManifestPath, "utf8");
    const scopeRequest = await controller.dispatch("register_external_dependency", {
      atom_id: directAtomId,
      mode: "scope_extension",
      reason: "该条是本 target 的直接验收要求，不是引用依赖",
    });
    expect(scopeRequest).toMatchObject({
      ok: false,
      terminal: false,
      budget_consumed: false,
      durable_mutation: false,
      error: "scope_extension_requires_precise_blocker",
      actual: {
        requested_atom_id: directAtomId,
        overlaps_current_primary: false,
        current_primary_source_ranges: prepared.manifest.scope.primary_source_ranges ?? [{
          start_line: prepared.manifest.scope.selected_start_line,
          end_exclusive_line: prepared.manifest.scope.selected_end_exclusive_line,
        }],
        nominated_evidence_span_ids: [],
      },
      next_tool: "get_target_context",
      next_tool_arguments: { limit: 100 },
      required_tools: expect.arrayContaining(["report_target_blocker"]),
      instruction: expect.stringContaining("report_target_blocker"),
    });
    // The callback's next step must be executable and expose the authoritative
    // physical scope without deciding the outside resource's business role.
    const scopeContext = await controller.dispatch(String(scopeRequest.next_tool),
      scopeRequest.next_tool_arguments as Record<string, unknown>);
    expect(scopeContext).toMatchObject({ ok: true, target_scope: {
      mode: prepared.manifest.scope.mode,
      target_id: prepared.manifest.scope.target_id,
      selected_atom_ids: prepared.manifest.scope.selected_atom_ids,
    } });
    expect(await readFile(revision.evidenceManifestPath, "utf8")).toBe(beforeScopeRequest);
    expect((await revision.readSourceSpanRegistry()).spans.some((span) => span.evidence_id === directAtomId)).toBe(false);

    expect(await controller.dispatch("search_global_document_resources", { query: "未提供的外部标准唯一编号XYZ" }))
      .toMatchObject({ ok: true, unresolved: true, matches: [] });
    const contractResult = await controller.dispatch("get_plan_contract", {});
    expect(contractResult).toMatchObject({
      schema_instruction: expect.stringContaining("Empty arrays"),
      plan_json_schema: {
        properties: {
          acceptance_items: {
            items: {
              additionalProperties: false,
              required: expect.arrayContaining([
                "item_id",
                "field_bindings",
                "sampling",
              ]),
              properties: {
                category: { enum: ["主控项目", "一般项目", "原文未标明类别"] },
                sampling: {
                  properties: {
                    status: {
                      enum: ["explicit", "reference", "reference_unspecified_quantity", "fallback", "not_sampling"],
                    },
                  },
                },
              },
            },
          },
          evidence_dispositions: {
            items: {
              required: ["evidence_id", "disposition", "item_ids", "reason"],
            },
          },
        },
      },
    });
    expect((contractResult.contract as { plan_template: object }).plan_template)
      .toHaveProperty("semantic_evidence", []);
    expect((contractResult.plan_json_schema as { properties: object }).properties)
      .toHaveProperty("semantic_evidence");
    expect(createPiTools(controller).map((tool) => tool.name))
      .not.toContain("validate_semantic_draft");
  });

  test("keeps raw selected atoms on demand when an exact primary scope is available", async () => {
    const root = await tempRoot("agent-exact-scope-on-demand-atoms");
    const markdownPath = join(root, "source.md");
    const targetLine = 151;
    const lines = Array.from({ length: 320 }, (_, index) =>
      index + 1 === targetLine
        ? `目标条款：缆线终接应符合设计要求。${"乙".repeat(70)}`
        : `第 ${index + 1} 行中性正文 ${"甲".repeat(80)}`
    );
    const markdown = lines.join("\n");
    await writeFile(markdownPath, markdown, "utf8");
    const evidence = buildDocumentEvidence(markdown, "source.md");
    const selectedIndex = evidence.atoms.findIndex((atom) => atom.text.includes("目标条款"));
    expect(selectedIndex).toBeGreaterThan(0);
    expect(selectedIndex).toBeLessThan(evidence.atoms.length - 1);
    const selected = evidence.atoms[selectedIndex]!;
    const target = validPlan("job-exact-scope", markdown).plan.targets[0]!;
    target.evidence_atom_ids = [selected.atom_id];
    target.evidence_fragments = [{ atom_id: selected.atom_id, text: lines[targetLine - 1]! }];
    target.materialization.lot_basis_fragments = [{
      atom_id: selected.atom_id,
      text: lines[targetLine - 1]!,
    }];

    const prepared = await buildAgentScopedEvidenceManifest(
      markdownPath,
      "job-exact-scope",
      target,
      evidence,
      undefined,
      { start_line: targetLine, end_exclusive_line: targetLine + 1 },
    );
    expect(prepared.manifest.scope.selected_atom_ids).toEqual([selected.atom_id]);
    expect(prepared.manifest.evidence.filter((record) => record.locator.startsWith("char:")))
      .toEqual([]);
    expect(prepared.manifest.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ evidence_scope: "primary", text: lines[targetLine - 1] }),
    ]));
    expect(validatePlanText(
      prettyJson(validFixturePlan(prepared.manifest)),
      prepared.manifest,
    ).issues).toEqual([]);

    const revision = await RevisionWorkspace.createFromEvidence(
      root,
      "job-exact-scope",
      target.target_id,
      prepared,
    );
    const controller = await ToolController.create(revision);
    expect(await controller.dispatch("open_global_document_resource", {
      atom_id: selected.atom_id,
    })).toMatchObject({ ok: true, resource: { atom_id: selected.atom_id } });
    expect(await controller.dispatch("open_adjacent_document_resource", {
      atom_id: selected.atom_id,
      direction: "next",
    })).toMatchObject({
      ok: true,
      resource: { atom_id: evidence.atoms[selectedIndex + 1]!.atom_id },
    });

    const fallback = await buildAgentScopedEvidenceManifest(
      markdownPath,
      "job-exact-scope-fallback",
      target,
      evidence,
    );
    expect(fallback.manifest.evidence
      .filter((record) => record.locator.startsWith("char:"))
      .map((record) => record.evidence_id))
      .toEqual(evidence.atoms
        .slice(selectedIndex - 1, selectedIndex + 2)
        .map((atom) => atom.atom_id));
  });

  test("keeps narrow referenced-table values in exact primary evidence without raw atoms", async () => {
    const root = await tempRoot("agent-exact-scope-narrow-table");
    const markdownPath = join(root, "source.md");
    const clause = "6.1.1 用户光缆弯曲半径应符合表 6.1.1-1 的规定。";
    const markdown = [
      clause,
      "表 6.1.1-1 光缆敷设安装的最小曲率半径",
      '<table><tr><td>光缆类型</td><td>静态弯曲</td></tr><tr><td>G.657A光纤</td><td>5D且不小于15mm</td></tr></table>',
    ].join("\n");
    await writeFile(markdownPath, markdown, "utf8");
    const evidence = buildDocumentEvidence(markdown, "source.md");
    const target = validPlan("job-narrow-table", markdown).plan.targets[0]!;
    target.evidence_atom_ids = [evidence.atoms[0]!.atom_id];
    target.evidence_fragments = [{ atom_id: evidence.atoms[0]!.atom_id, text: clause }];
    target.materialization.lot_basis_fragments = [{
      atom_id: evidence.atoms[0]!.atom_id,
      text: clause,
    }];

    const prepared = await buildAgentScopedEvidenceManifest(
      markdownPath,
      "job-narrow-table",
      target,
      evidence,
      undefined,
      { start_line: 1, end_exclusive_line: 4 },
    );
    expect(prepared.manifest.table_fragments).toEqual([
      expect.objectContaining({
        provisional_table_id: "6.1.1-1",
        title_candidate_evidence_ids: [expect.any(String)],
        header_evidence_ids: [expect.any(String)],
        row_evidence_ids: [expect.any(String), expect.any(String)],
      }),
    ]);
    expect(prepared.manifest.evidence.some((record) => record.locator.startsWith("char:")))
      .toBe(false);
    const tableRows = prepared.manifest.evidence.filter((record) =>
      record.kind === "table_row" && record.locator.includes("/table:")
    );
    expect(tableRows).toHaveLength(2);
    expect(tableRows.map((record) => record.text)).toEqual([
      "光缆类型 | 静态弯曲",
      "G.657A光纤 | 5D且不小于15mm",
    ]);
    expect(tableRows.every((record) => !record.text.includes("数据行"))).toBe(true);
  });

  test("preserves staged selectors and existing spans when registering a dependency before final validation", async () => {
    const root = await tempRoot("coverage-repair-external-dependency");
    const markdownPath = join(root, "source.md");
    const targetText = "地基承载力应满足设计要求。".repeat(800);
    const dependencyText = "远端附录给出被正文引用的判定表。";
    const markdown = `${targetText}${"范围外填充。".repeat(2_000)}${dependencyText}`;
    await writeFile(markdownPath, markdown, "utf8");
    const { evidence, plan } = validPlan("coverage-dependency-job", markdown);
    const prepared = await buildAgentScopedEvidenceManifest(
      markdownPath,
      "coverage-dependency-job",
      plan.targets[0]!,
      evidence,
    );
    const revision = await RevisionWorkspace.createFromEvidence(
      root,
      "coverage-dependency-job",
      plan.targets[0]!.target_id,
      prepared,
    );
    let controller = await ToolController.create(revision);
    const search = await controller.dispatch("search_global_document_resources", {
      query: dependencyText,
    });
    const dependencyAtomId = (search.matches as Array<{ atom_id: string }>)[0]!.atom_id;
    await controller.dispatch("open_global_document_resource", { atom_id: dependencyAtomId });
    await revision.updateState((state) => {
      state.validation_attempts = 0;
      state.selector_protocol!.submissions = 1;
    });
    const scopeSpan = (await revision.readSourceSpanRegistry()).spans[0]!.span_id;
    expect(await controller.dispatch("stage_target_selector_draft", {draft: {lots: [{key: "kept-lot", name: "原有检查范围", scope_span_ids: [scopeSpan], reason: "保留既有来源绑定"}]}})).toMatchObject({ok: true});
    const beforeDraft = await readFile(revision.workingSelectorPath, "utf8");
    const beforeRegistry = await revision.readSourceSpanRegistry();
    const beforeState = await revision.readState();
    expect(await controller.dispatch("register_external_dependency", {atom_id: dependencyAtomId, mode: "dependency", reason: "补充尚未验证草稿的来源"}))
      .toMatchObject({ok: true, registration_phase: "selector_correction", requires_revalidation: true, budget_consumed: false});
    expect(await readFile(revision.workingSelectorPath, "utf8")).toBe(beforeDraft);
    const afterRegistry = await revision.readSourceSpanRegistry();
    expect(afterRegistry.spans).toEqual(expect.arrayContaining(beforeRegistry.spans));
    expect(afterRegistry.source_fingerprint).toBe((await revision.readEvidenceManifest()).evidence_fingerprint);
    expect((await revision.readState()).selector_protocol).toEqual(beforeState.selector_protocol);
    expect((await revision.readState()).status).toBe("working");
  });

  test("registers an opened dependency during active coverage repair without spending selector budgets", async () => {
    const root = await tempRoot("coverage-repair-external-dependency");
    const markdownPath = join(root, "source.md");
    const targetText = "地基承载力应满足设计要求。".repeat(800);
    const dependencyText = "远端附录给出被正文引用的判定表。";
    const markdown = `${targetText}${"范围外填充。".repeat(2_000)}${dependencyText}`;
    await writeFile(markdownPath, markdown, "utf8");
    const { evidence, plan } = validPlan("coverage-dependency-job", markdown);
    const prepared = await buildAgentScopedEvidenceManifest(
      markdownPath,
      "coverage-dependency-job",
      plan.targets[0]!,
      evidence,
    );
    const revision = await RevisionWorkspace.createFromEvidence(
      root,
      "coverage-dependency-job",
      plan.targets[0]!.target_id,
      prepared,
    );
    let controller = await ToolController.create(revision);
    const search = await controller.dispatch("search_global_document_resources", {
      query: dependencyText,
    });
    const dependencyAtomId = (search.matches as Array<{ atom_id: string }>)[0]!.atom_id;
    await controller.dispatch("open_global_document_resource", { atom_id: dependencyAtomId });
    await revision.updateState((state) => {
      state.validation_attempts = 1;
      state.selector_protocol!.submissions = 1;
    });
    const originalManifest = await revision.readEvidenceManifest();
    expect(await controller.dispatch("register_external_dependency", {
      atom_id: dependencyAtomId,
      mode: "dependency",
      reason: "正文引用的远端附录判定表",
    })).toMatchObject({
      ok: false,
      terminal: false,
      error: "external_dependency_after_validation",
    });
    expect((await revision.readEvidenceManifest()).evidence_fingerprint)
      .toBe(originalManifest.evidence_fingerprint);

    await revision.updateState((state) => {
      state.selector_stage = "coverage_repair";
      state.last_valid_fingerprint = "";
      state.last_valid_plan_sha256 = "";
      state.repair = {
        ...state.repair!,
        mode: "repair",
        repair_source: "coverage",
        coverage_review_fingerprint: "f".repeat(64),
        coverage_finding_ids: ["finding:missing-referenced-table"],
        coverage_evidence_ids: [prepared.manifest.evidence[0]!.evidence_id],
        coverage_item_ids: ["item:referenced-table"],
      };
    });
    controller = await ToolController.create(revision);
    expect(controller.selectorProviderPolicy()).toMatchObject({
      stage: "coverage_repair",
      allowed_tools: expect.arrayContaining([
        "search_global_document_resources",
        "open_global_document_resource",
        "register_external_dependency",
      ]),
    });
    const stateBeforeRegistration = await revision.readState();
    expect(await controller.dispatch("register_external_dependency", {
      atom_id: dependencyAtomId,
      mode: "dependency",
      reason: "coverage 已确认正文引用的远端附录必须物化",
    })).toMatchObject({
      ok: true,
      dependency_registered: true,
      registration_phase: "coverage_repair",
      budget_consumed: false,
      business_span_available: false,
      next_tool: "locate_evidence_span",
      tool_argument_hints: {
        locate_evidence_span: {
          evidence_id: dependencyAtomId,
          quote: expect.stringContaining("逐字复制"),
        },
      },
    });
    const stateAfterRegistration = await revision.readState();
    expect({
      validation_attempts: stateAfterRegistration.validation_attempts,
      selector_protocol: stateAfterRegistration.selector_protocol,
    }).toEqual({
      validation_attempts: stateBeforeRegistration.validation_attempts,
      selector_protocol: stateBeforeRegistration.selector_protocol,
    });
    const updatedManifest = await revision.readEvidenceManifest();
    expect(updatedManifest.evidence_fingerprint).not.toBe(originalManifest.evidence_fingerprint);
    expect(updatedManifest.evidence.map((record) => record.evidence_id)).toContain(dependencyAtomId);
    expect((await revision.readSourceSpanRegistry()).source_fingerprint)
      .toBe(updatedManifest.evidence_fingerprint);
  });

  test("promotes complete table navigation already registered in target scope to authoritative metadata", async () => {
    const root = await tempRoot("agent-scoped-neutral-navigation");
    const markdownPath = join(root, "source.md");
    const filler = Array.from({ length: 90 }, (_, index) => `中性上下文${index}-${"甲".repeat(80)}`).join("\n");
    const table = [
      "检查数量：每批抽查3处，并参照本标准表9.9.9。",
      "表 9.9.9 中性相邻窗口中的候选表",
      "<table><tr><th>类别</th><th>项目</th><th>条件</th><th>允许值</th><th>单位</th><th>方法</th></tr>",
      "<tr><td>主控项目</td><td>厚度</td><td>设计要求</td><td>10</td><td>mm</td><td>钢尺检查</td></tr></table>",
    ].join("\n");
    const markdown = `地基承载力应满足设计要求\n${filler}\n${table}`;
    await writeFile(markdownPath, markdown, "utf8");
    const { evidence, plan } = validPlan("job-neutral-navigation", markdown);
    expect(evidence.atoms.length).toBeGreaterThan(1);
    const prepared = await buildAgentScopedEvidenceManifest(
      markdownPath,
      "job-neutral-navigation",
      plan.targets[0]!,
      evidence,
    );
    expect(prepared.manifest.evidence.some((record) => record.evidence_id === evidence.atoms[1]!.atom_id)).toBe(true);
    expect(prepared.manifest.table_fragments).toEqual([]);
    expect(prepared.manifest.scope.table_navigation_candidates?.length).toBeGreaterThan(0);
    expect(prepared.manifest.scope.table_navigation_candidates?.[0]).toMatchObject({
      formal_row_evidence_ids: [expect.any(String)],
    });
    const originalFingerprint = prepared.manifest.evidence_fingerprint;
    const candidateFragmentId = prepared.manifest.scope.table_navigation_candidates![0]!.fragment_id;
    const revision = await RevisionWorkspace.createFromEvidence(
      root,
      "job-neutral-navigation",
      plan.targets[0]!.target_id,
      prepared,
    );
    const controller = await ToolController.create(revision);
    const restoredManifest = await revision.readEvidenceManifest();
    expect(restoredManifest.evidence_fingerprint).not.toBe(originalFingerprint);
    expect(restoredManifest.table_fragments).toEqual(expect.arrayContaining([
      expect.objectContaining({ fragment_id: candidateFragmentId }),
    ]));
    expect((await revision.readSourceSpanRegistry()).source_fingerprint)
      .toBe(restoredManifest.evidence_fingerprint);
    const tableNavigation = await controller.dispatch("list_table_fragments", {});
    expect(tableNavigation).toMatchObject({ ok: true });
    expect(tableNavigation.fragments).toEqual(expect.arrayContaining([
      expect.objectContaining({
        fragment_id: candidateFragmentId,
        navigation_only: false,
        formal_row_evidence_ids: [expect.any(String)],
      }),
    ]));
    const samplingNavigation = await controller.dispatch("list_sampling_rules", {});
    expect(samplingNavigation).toMatchObject({ ok: true });
    expect(samplingNavigation.navigation_candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ discovery_basis: "text-retrieval" }),
    ]));
    const referenceNavigation = await controller.dispatch("list_reference_occurrences", {});
    expect(referenceNavigation).toMatchObject({ ok: true });
    expect(referenceNavigation.navigation_candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ discovery_basis: "text-retrieval" }),
    ]));
  });

  test("keeps every GB50202 5.3.4 row as searchable evidence without making table shape a business inventory", async () => {
    const root = await tempRoot("agent-structured-row-coverage");
    const markdownPath = resolve("fixtures/real/GB_50202-2018.md");
    const markdown = await readFile(markdownPath, "utf8");
    const documentEvidence = buildDocumentEvidence(markdown, "GB_50202-2018.md");
    const atom = documentEvidence.atoms.find((candidate) =>
      candidate.text.includes("5.3.4 钢筋混凝土扩展基础质量检验标准")
      && candidate.text.includes("L(或B) $\\leqslant 30$")
    )!;
    expect(atom).toBeDefined();
    const target = validPlan("gb50202-structured", markdown).plan.targets[0]!;
    target.target_id = "semantic-rc-spread-foundation";
    target.name = "钢筋混凝土扩展基础";
    target.evidence_atom_ids = [atom.atom_id];
    target.evidence_fragments = [{
      atom_id: atom.atom_id,
      text: "5.3.4 钢筋混凝土扩展基础质量检验标准应符合表 5.3.4 的规定。",
    }];
    target.materialization.lot_basis_fragments = [{
      atom_id: atom.atom_id,
      text: "L(或B) $\\leqslant 30$",
    }];

    const prepared = await buildAgentScopedEvidenceManifest(
      markdownPath,
      "gb50202-structured",
      target,
      documentEvidence,
    );
    const formalRows = prepared.manifest.evidence.filter((record) =>
      record.role === "formal_table_row" && record.evidence_scope === "primary"
    );
    expect(prepared.manifest.source.adapter).toBe("document-domain-agent/v1");
    expect(prepared.manifest.table_fragments).toHaveLength(1);
    expect(formalRows).toHaveLength(7);

    const contract = buildPlanContract(prepared.manifest);
    expect(contract.formal_rows).toHaveLength(0);
    expect(contract.plan_template.acceptance_items).toEqual([]);
    expect(contract.plan_template).toHaveProperty("semantic_evidence", []);
    expect(contract.rules.join("\n")).toContain("table_criterion");
    expect(contract.rules.join("\n")).toContain("do not manufacture one item per physical cell");

  });

  test("locks every physical fragment of the selected GB50202 5.10.4 logical table", async () => {
    const markdownPath = resolve("fixtures/real/GB_50202-2018.md");
    const markdown = await readFile(markdownPath, "utf8");
    const documentEvidence = buildDocumentEvidence(markdown, "GB_50202-2018.md");
    const atom = documentEvidence.atoms.find((candidate) =>
      candidate.text.includes("5.10.4 钢桩施工质量检验标准")
      && candidate.text.includes("续表 5.10.4")
    )!;
    expect(atom).toBeDefined();
    const target = validPlan("gb50202-steel-pile", markdown).plan.targets[0]!;
    target.target_id = "semantic-steel-pile";
    target.name = "钢桩";
    target.evidence_atom_ids = [atom.atom_id];
    target.evidence_fragments = [{
      atom_id: atom.atom_id,
      text: "5.10.4 钢桩施工质量检验标准应符合本标准表 5.1.2、表 5.10.4 的规定。",
    }];
    target.materialization.lot_basis_fragments = [{
      atom_id: atom.atom_id,
      text: "表 5.10.4 钢桩施工质量检验标准",
    }];

    const prepared = await buildAgentScopedEvidenceManifest(
      markdownPath,
      "gb50202-steel-pile",
      target,
      documentEvidence,
    );
    const fragments = prepared.manifest.table_fragments.filter((fragment) =>
      fragment.provisional_table_id === "5.10.4"
    );
    const formalRows = prepared.manifest.evidence.filter((record) =>
      record.role === "formal_table_row"
      && record.evidence_scope === "primary"
      && record.table_id === "5.10.4"
    );
    const contract = buildPlanContract(prepared.manifest);

    expect(fragments).toHaveLength(2);
    expect(fragments.map((fragment) => fragment.provisional_title)).toEqual([
      "表 5.10.4 钢桩施工质量检验标准",
      "续表 5.10.4",
    ]);
    expect(formalRows).toHaveLength(23);
    expect(contract.formal_rows).toEqual([]);
    expect(contract.plan_template.acceptance_items).toEqual([]);
    expect(formalRows.map((record) => record.text).join("\n")).toContain("焊缝探伤检验");
    expect(formalRows.map((record) => record.text).join("\n")).toContain("收锤标准");
  });

  test("recovers the GB50202 7.8.4 title when the selected window starts at its table", async () => {
    const markdownPath = resolve("fixtures/real/GB_50202-2018.md");
    const markdown = await readFile(markdownPath, "utf8");
    const documentEvidence = buildDocumentEvidence(markdown, "GB_50202-2018.md");
    const captionOffset = markdown.indexOf("表 7.8.4 水泥土搅拌桩的质量检验标准");
    expect(captionOffset).toBeGreaterThan(0);
    const tableOffset = markdown.indexOf("<table", captionOffset);
    const tableEnd = markdown.indexOf("</table>", tableOffset) + "</table>".length;
    const atom = documentEvidence.atoms.find((candidate) =>
      candidate.start_offset <= tableOffset && candidate.end_offset > tableOffset
    )!;
    expect(atom).toBeDefined();
    const target = validPlan("gb50202-soil-reinforcement", markdown).plan.targets[0]!;
    target.target_id = "semantic-cement-soil-wall";
    target.name = "水泥土搅拌桩";
    target.evidence_atom_ids = [atom.atom_id];
    target.evidence_fragments = [{
      atom_id: atom.atom_id,
      text: markdown.slice(tableOffset, Math.min(tableEnd, atom.end_offset)),
    }];
    target.materialization.lot_basis_fragments = [{
      atom_id: atom.atom_id,
      text: markdown.slice(tableOffset, Math.min(tableEnd, atom.end_offset)),
    }];

    const prepared = await buildAgentScopedEvidenceManifest(
      markdownPath,
      "gb50202-soil-reinforcement",
      target,
      documentEvidence,
    );
    const fragment = prepared.manifest.table_fragments.find((candidate) =>
      candidate.provisional_table_id === "7.8.4"
    );
    const titleEvidence = new Map(
      prepared.manifest.evidence.map((record) => [record.evidence_id, record.text]),
    );

    expect(fragment).toBeDefined();
    expect(fragment).toMatchObject({
      provisional_title: "表 7.8.4 水泥土搅拌桩的质量检验标准",
      provisional_table_id: "7.8.4",
    });
    expect(fragment!.formal_row_evidence_ids).toHaveLength(11);
    expect(fragment!.title_candidate_evidence_ids.map((id) => titleEvidence.get(id)))
      .toContain("表 7.8.4 水泥土搅拌桩的质量检验标准");
    expect(prepared.manifest.table_fragments.some((candidate) =>
      candidate.provisional_table_id === "line-1112"
    )).toBe(false);
  });

  test.each([
    "组件检验应符合第7.2节至第7.4节的规定",
    "组件检验应符合第7.2～7.4节的规定",
    "组件检验应符合7.2～7.4节的规定",
  ])("offers a decimal section range as a retrieval candidate: %s", async (reference) => {
    const root = await tempRoot("numbered-section-range-candidate");
    const markdownPath = join(root, "source.md");
    const basis = "组件连接应牢固";
    const markdown = `${basis}。${reference}。`;
    await writeFile(markdownPath, markdown, "utf8");
    const { evidence, plan } = validPlan("job-numbered-section-range", markdown);
    const atomId = evidence.atoms[0]!.atom_id;
    const target = plan.targets[0]!;
    target.evidence_fragments = [{ atom_id: atomId, text: basis }];
    target.materialization.lot_basis_fragments = [{ atom_id: atomId, text: basis }];

    const prepared = await buildAgentScopedEvidenceManifest(
      markdownPath, plan.job_id, target, evidence,
    );
    expect(prepared.manifest.scope.reference_candidates).toEqual(
      expect.arrayContaining([expect.objectContaining({
        discovery_basis: "text-retrieval",
        exact_fragment: expect.stringContaining(reference),
      })]),
    );
  });

  test.each([
    {
      label: "GB 50310 table 5.11.2",
      anchor: "限速器安全钳联动试验应符合表 5.11.2 的规定",
      itemName: "限速器安全钳联动试验",
      expanded: "额定载重量为1000kg时轿厢最大有效面积为2.4m²",
      expectedReference: "表 5.11.2",
    },
    {
      label: "GB 50202 table 5.1.2",
      anchor: "桩位偏差应符合表5.1.2的规定",
      itemName: "桩位偏差",
      expanded: "桩位允许偏差为100mm",
      expectedReference: "表5.1.2",
    },
    {
      label: "descriptive Chinese table section reference",
      anchor: "联动试验见“表一的第二节”",
      itemName: "联动试验",
      expanded: "联动试验时安全钳应可靠动作",
      expectedReference: "表一的第二节",
    },
  ])("uses $label only as a retrieval candidate and requires Agent semantic closure", async ({
    anchor,
    itemName,
    expanded,
    expectedReference,
  }) => {
    const root = await tempRoot("agent-literal-table-reference");
    const markdownPath = join(root, "source.md");
    const markdown = `${anchor}。${expanded}。`;
    await writeFile(markdownPath, markdown, "utf8");
    const { evidence, plan: discoveryPlan } = validPlan("job-table-reference", markdown);
    const atom = evidence.atoms[0]!;
    discoveryPlan.targets[0]!.evidence_fragments = [{ atom_id: atom.atom_id, text: anchor }];
    const prepared = await buildAgentScopedEvidenceManifest(
      markdownPath,
      "job-table-reference",
      discoveryPlan.targets[0]!,
      evidence,
    );
    expect(prepared.manifest.scope.reference_candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          discovery_basis: "text-retrieval",
          exact_fragment: expect.stringContaining(expectedReference),
        }),
      ]),
    );

    const semanticPlan = validFixturePlan(prepared.manifest);
    const item = semanticPlan.acceptance_items[0]!;
    const fields = {
      name: itemName,
      requirement: expanded,
      method: "",
      quantity: "",
      note: "",
    };
    Object.assign(item, fields);
    item.field_bindings = buildItemFieldBindings(
      fields,
      item.evidence_ids,
      prepared.manifest,
    );
    item.field_bindings.requirement = {
      ...item.field_bindings.requirement,
      composition: "reference",
      evidence_ids: [atom.atom_id],
      source_fragments: [
        { evidence_id: atom.atom_id, text: anchor },
        { evidence_id: atom.atom_id, text: expanded },
      ],
      reason: "原引用句与被引用内容共同组成可直接执行的验收要求",
    };
    semanticPlan.semantic_evidence = [
      {
        semantic_id: "semantic:item",
        role: "acceptance_item",
        evidence_id: atom.atom_id,
        exact_fragment: expanded,
        parent_semantic_id: "",
        materialized_item_id: item.item_id,
        reason: "主 Agent 判断这是最终验收项目语义",
      },
      {
        semantic_id: "semantic:anchor",
        role: "reference_anchor",
        evidence_id: atom.atom_id,
        exact_fragment: anchor,
        parent_semantic_id: "",
        materialized_item_id: "",
        reason: "主 Agent 根据完整含义判断该句依赖别处内容",
      },
      {
        semantic_id: "semantic:referenced-content",
        role: "referenced_clause",
        evidence_id: atom.atom_id,
        exact_fragment: expanded,
        parent_semantic_id: "semantic:anchor",
        materialized_item_id: "",
        reason: "主 Agent 语义调查后确认这是该依赖的具体内容",
      },
    ];
    semanticPlan.semantic_references = [];
    semanticPlan.shared_sampling_rules = [];
    expect(validatePlanText(prettyJson(semanticPlan), prepared.manifest).issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "semantic_reference_resolution_count" }),
      ]),
    );

    semanticPlan.semantic_references = [{
      expansion_id: "semantic-expansion:1",
      anchor_semantic_id: "semantic:anchor",
      status: "review",
      import_scope: { mode: "field_specific", allowed_fields: ["requirement"], reason: "引用仅补充验收要求。" },
      target_semantic_ids: [],
      destination_bindings: [],
      reason: "尚未找到唯一指向，禁止猜测",
    }];
    expect(validatePlanText(prettyJson(semanticPlan), prepared.manifest).issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "semantic_reference_unresolved" }),
      ]),
    );

    semanticPlan.semantic_references = [{
      expansion_id: "semantic-expansion:1",
      anchor_semantic_id: "semantic:anchor",
      status: "resolved",
      import_scope: { mode: "field_specific", allowed_fields: ["requirement"], reason: "引用仅补充验收要求。" },
      target_semantic_ids: ["semantic:referenced-content"],
      destination_bindings: [{
        item_id: item.item_id,
        fields: ["requirement"],
      }],
      reason: "全文语义确认唯一指向，并落入 requirement",
    }];
    const passed = validatePlanText(prettyJson(semanticPlan), prepared.manifest);
    expect(passed).toMatchObject({
      ok: true,
      issues: [],
    });
    const materialized = materialize(
      semanticPlan,
      prepared.manifest,
      String(passed.fingerprint),
    ).result.inspection_lots[0]!.items[0]!;
    expect(materialized.reference_resolution_ids).toEqual(["semantic-expansion:1"]);
    expect(materialized.reference_evidence_ids).toContain(atom.atom_id);
  });

  test("keeps a general construction condition out of the materialized acceptance items", async () => {
    const root = await tempRoot("agent-general-condition");
    const markdownPath = join(root, "source.md");
    const conditions = [
      "6.3.1 大理石、花岗石面层采用天然大理石、花岗石板材，应在结合层上铺设。",
      "6.3.2 板材有裂缝、掉角、翘曲和表面有缺陷时应予剔除；铺设前应试拼编号。",
      "6.3.3 铺设大理石、花岗石面层前，板材应浸湿、晾干；结合层与板材应分段同时铺设。",
    ];
    const requirement = "6.3.4 大理石、花岗石面层所用板块产品应符合设计要求和国家现行有关标准的规定。";
    const method = "检验方法:观察检查和检查质量合格证明文件。";
    const markdown = `地基承载力应满足设计要求。${conditions.join("")}${requirement}${method}`;
    await writeFile(markdownPath, markdown, "utf8");
    const { evidence, plan: discoveryPlan } = validPlan("job-general-condition", markdown);
    const atom = evidence.atoms[0]!;
    discoveryPlan.targets[0]!.evidence_fragments = [
      ...conditions.map((text) => ({ atom_id: atom.atom_id, text })),
      { atom_id: atom.atom_id, text: requirement },
    ];
    discoveryPlan.targets[0]!.materialization.lot_basis_fragments = [{
      atom_id: atom.atom_id,
      text: requirement,
    }];
    const prepared = await buildAgentScopedEvidenceManifest(
      markdownPath,
      "job-general-condition",
      discoveryPlan.targets[0]!,
      evidence,
    );
    const plan = validFixturePlan(prepared.manifest);
    const item = plan.acceptance_items[0]!;
    const fields = {
      name: "板块产品应符合设计要求",
      requirement,
      method,
      quantity: "",
      note: "",
    };
    Object.assign(item, fields, { category: "一般项目" });
    item.field_bindings = buildItemFieldBindings(
      fields,
      item.evidence_ids,
      prepared.manifest,
    );
    item.sampling = {
      status: "not_sampling",
      min_sampling: "",
      script: "该用例只验证验收项目与施工条件的语义边界。",
      reason: "抽样语义不属于本回归用例范围。",
      confidence: 1,
      evidence_ids: [],
    };
    plan.semantic_evidence = [
      {
        semantic_id: "semantic:general-condition-631",
        role: "acceptance_condition",
        evidence_id: atom.atom_id,
        exact_fragment: conditions[0]!,
        parent_semantic_id: "",
        materialized_item_id: "",
        reason: "材料和构造做法作为施工条件保留，不生成最终验收叶项。",
      },
      {
        semantic_id: "semantic:general-condition-632",
        role: "acceptance_condition",
        evidence_id: atom.atom_id,
        exact_fragment: conditions[1]!,
        parent_semantic_id: "",
        materialized_item_id: "",
        reason: "材料处理与试拼工序作为施工条件保留，不生成最终验收叶项。",
      },
      {
        semantic_id: "semantic:general-condition-633",
        role: "acceptance_condition",
        evidence_id: atom.atom_id,
        exact_fragment: conditions[2]!,
        parent_semantic_id: "",
        materialized_item_id: "",
        reason: "铺设工艺前提作为施工条件保留，不生成最终验收叶项。",
      },
      {
        semantic_id: "semantic:acceptance-item",
        role: "acceptance_item",
        evidence_id: atom.atom_id,
        exact_fragment: requirement,
        parent_semantic_id: "",
        materialized_item_id: item.item_id,
        reason: "板块产品要求具有独立检验方法，是最终验收项目。",
      },
      {
        semantic_id: "semantic:acceptance-method",
        role: "continuation",
        evidence_id: atom.atom_id,
        exact_fragment: method,
        parent_semantic_id: "semantic:acceptance-item",
        materialized_item_id: item.item_id,
        reason: "检验方法属于6.3.4验收项目。",
      },
    ];
    plan.semantic_references = [];
    plan.shared_sampling_rules = [];

    expect(buildPlanContract(prepared.manifest).rules.join("\n")).toContain(
      "a shared sampling rule alone never promotes a construction condition or process prerequisite into an acceptance item",
    );
    const validation = validatePlanText(prettyJson(plan), prepared.manifest);
    expect(validation).toMatchObject({ ok: true, issues: [] });
    const items = materialize(
      plan,
      prepared.manifest,
      String(validation.fingerprint),
    ).result.inspection_lots[0]!.items;
    expect(items).toHaveLength(1);
    expect(items[0]!.requirement).toBe(requirement);
    for (const condition of conditions) {
      expect(items[0]!.requirement).not.toContain(condition);
    }
  });

  test("routes one shared raw sampling rule to multiple Agent-discovered items", async () => {
    const root = await tempRoot("agent-shared-sampling-rule");
    const markdownPath = join(root, "source.md");
    const itemAFragment = "悬吊装置安装应牢固可靠";
    const sharedFragment = "主控项目全验，一般项目按检验批抽验百分之十";
    const itemBFragment = "补偿装置安装位置应符合设计要求";
    const markdown = [
      itemAFragment.padEnd(1_000, "甲"),
      sharedFragment.padEnd(1_000, "抽"),
      itemBFragment.padEnd(1_000, "乙"),
    ].join("");
    await writeFile(markdownPath, markdown, "utf8");
    const documentEvidence = buildDocumentEvidence(markdown, "source.md", 1_000);
    const [itemAAtom, sharedAtom, itemBAtom] = documentEvidence.atoms;
    const target = {
      target_id: "elec-suspension-cable-compensation",
      group_id: "elec",
      group_name: "电气工程",
      group_reason: "同属接触网安装验收对象",
      name: "悬吊及补偿装置",
      description: "悬吊与补偿装置安装验收",
      evidence_atom_ids: [itemAAtom!.atom_id, itemBAtom!.atom_id],
      evidence_fragments: [
        { atom_id: itemAAtom!.atom_id, text: itemAFragment },
        { atom_id: itemBAtom!.atom_id, text: itemBFragment },
      ],
      materialization: {
        kind: "inspection_scope" as const,
        lot_basis_summary: "由两项可独立检查的验收内容构成检验批依据",
        lot_basis_fragments: [
          { atom_id: itemAAtom!.atom_id, text: itemAFragment },
          { atom_id: itemBAtom!.atom_id, text: itemBFragment },
        ],
        reason: "两段原文分别直接约束可检查的悬吊与补偿装置",
      },
      reason: "两个原子包含独立的验收项目，邻接原子包含共同抽样规则",
    };
    const prepared = await buildAgentScopedEvidenceManifest(
      markdownPath,
      "job-shared-sampling",
      target,
      documentEvidence,
    );
    const plan = buildPlanContract(prepared.manifest).plan_template;
    const itemAId = "item-suspension";
    const itemBId = "item-compensation";
    const fieldsA = {
      name: itemAFragment,
      requirement: itemAFragment,
      method: "",
      quantity: "",
      note: "",
    };
    const fieldsB = {
      name: itemBFragment,
      requirement: itemBFragment,
      method: "",
      quantity: "",
      note: "",
    };
    plan.inspection_lots = [{
      lot_id: "lot-elec",
      name: "悬吊及补偿装置检验批",
      evidence_ids: [],
      item_ids: [itemAId, itemBId],
    }];
    plan.acceptance_items = [
      {
        item_id: itemAId,
        lot_id: "lot-elec",
        ...fieldsA,
        category: "主控项目",
        evidence_ids: [itemAAtom!.atom_id],
        reference_evidence_ids: [],
        table_semantics: null,
        inspection_data_type: "counting",
        inspection_data_type_reason: "逐个装置形成符合或不符合结果；按检查单位判定；最终按不合格单位评价。",
        inspection_data_type_evidence_ids: [itemAAtom!.atom_id],
        field_bindings: buildItemFieldBindings(
          fieldsA,
          [itemAAtom!.atom_id],
          prepared.manifest,
        ),
        sampling: {
          status: "reference",
          min_sampling: "主控项目全验",
          script: "主控项目全部检验。",
          reason: "共同抽样条款适用于该主控项目。",
          confidence: 1,
          evidence_ids: [sharedAtom!.atom_id],
        },
      },
      {
        item_id: itemBId,
        lot_id: "lot-elec",
        ...fieldsB,
        category: "一般项目",
        evidence_ids: [itemBAtom!.atom_id],
        reference_evidence_ids: [],
        table_semantics: null,
        inspection_data_type: "counting",
        inspection_data_type_reason: "逐个装置形成符合或不符合结果；按检查单位判定；最终按不合格单位评价。",
        inspection_data_type_evidence_ids: [itemBAtom!.atom_id],
        field_bindings: buildItemFieldBindings(
          fieldsB,
          [itemBAtom!.atom_id],
          prepared.manifest,
        ),
        sampling: {
          status: "reference",
          min_sampling: "检验批的 10%",
          script: "一般项目按检验批抽验百分之十。",
          reason: "共同抽样条款适用于该一般项目。",
          confidence: 1,
          evidence_ids: [sharedAtom!.atom_id],
        },
      },
    ];
    plan.evidence_dispositions = [
      {
        evidence_id: itemAAtom!.atom_id,
        disposition: "used",
        item_ids: [itemAId],
        reason: "项目甲的直接业务证据",
      },
      {
        evidence_id: sharedAtom!.atom_id,
        disposition: "used",
        item_ids: [itemAId, itemBId],
        reason: "两个项目共同适用的抽样规则",
      },
      {
        evidence_id: itemBAtom!.atom_id,
        disposition: "used",
        item_ids: [itemBId],
        reason: "项目乙的直接业务证据",
      },
    ];
    plan.semantic_evidence = [
      {
        semantic_id: "semantic:item-suspension",
        role: "acceptance_item",
        evidence_id: itemAAtom!.atom_id,
        exact_fragment: itemAFragment,
        parent_semantic_id: "",
        materialized_item_id: itemAId,
        reason: "独立的悬吊装置验收项目",
      },
      {
        semantic_id: "semantic:shared-sampling",
        role: "sampling_rule",
        evidence_id: sharedAtom!.atom_id,
        exact_fragment: sharedFragment,
        parent_semantic_id: "",
        materialized_item_id: "",
        reason: "跨项目共享、按类别分支的抽样规则",
      },
      {
        semantic_id: "semantic:item-compensation",
        role: "acceptance_item",
        evidence_id: itemBAtom!.atom_id,
        exact_fragment: itemBFragment,
        parent_semantic_id: "",
        materialized_item_id: itemBId,
        reason: "独立的补偿装置验收项目",
      },
    ];
    plan.semantic_references = [];
    plan.shared_sampling_rules = [{
      rule_id: "sampling:shared",
      source_semantic_id: "semantic:shared-sampling",
      evidence_ids: [sharedAtom!.atom_id],
      complete_source_fragment: sharedFragment,
      branches: [
        {
          branch_id: "branch:main-control",
          applies_to_category: "主控项目",
          min_sampling: "主控项目全验",
          script: "主控项目全部检验。",
          evidence_id: sharedAtom!.atom_id,
          exact_fragment: "主控项目全验",
        },
        {
          branch_id: "branch:general",
          applies_to_category: "一般项目",
          min_sampling: "检验批的 10%",
          script: "一般项目按检验批抽验百分之十。",
          evidence_id: sharedAtom!.atom_id,
          exact_fragment: "一般项目按检验批抽验百分之十",
        },
      ],
      shared_conditions: [],
      receiving_item_ids: [itemAId, itemBId],
      reason: "保留同一原始规则中的主控全验与一般抽验分支",
    }];
    plan.acceptance_items[0]!.sampling.rule_ids = ["sampling:shared"];
    plan.acceptance_items[0]!.sampling.branch_ids = ["branch:main-control"];
    plan.acceptance_items[1]!.sampling.rule_ids = ["sampling:shared"];
    plan.acceptance_items[1]!.sampling.branch_ids = ["branch:general"];

    // The source is one physical line: current preparation also emits its
    // granular primary record, alongside the three navigation atoms.
    const primaryLine = prepared.manifest.evidence.find((record) =>
      record.locator === "line:1" && record.text === markdown
    );
    expect(primaryLine).toMatchObject({ requires_disposition: true, evidence_scope: "primary" });
    expect(validatePlanText(prettyJson(plan), prepared.manifest).issues).toEqual([
      expect.objectContaining({
        code: "unhandled_evidence",
        details: expect.objectContaining({ evidence_ids: [primaryLine!.evidence_id] }),
      }),
    ]);
    plan.evidence_dispositions.push({
      evidence_id: primaryLine!.evidence_id,
      disposition: "used",
      item_ids: [itemAId, itemBId],
      reason: "该行包含两个已列出的验收项目及共同抽样规则；逐项字段仍绑定各自精确来源。",
    });

    expect(validatePlanText(prettyJson(plan), prepared.manifest)).toMatchObject({
      ok: true,
      issues: [],
    });
    expect(domainFindings(plan, prepared.manifest)).toEqual([]);

    const explicitWithCommonEvidence = structuredClone(plan);
    explicitWithCommonEvidence.acceptance_items[0]!.sampling.status = "explicit";
    const commonEvidenceIssues = validatePlanText(
      prettyJson(explicitWithCommonEvidence),
      prepared.manifest,
    ).issues;
    expect(commonEvidenceIssues).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "sampling_non_rule_evidence" }),
      expect.objectContaining({ code: "explicit_sampling_without_specific_evidence" }),
    ]));

    const missingSharedDispositionRoute = structuredClone(plan);
    missingSharedDispositionRoute.evidence_dispositions[1]!.item_ids = [itemAId];
    expect(validatePlanText(
      prettyJson(missingSharedDispositionRoute),
      prepared.manifest,
    ).issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "sampling_disposition_relation" }),
    ]));

    const sharedRuleInQuantityBinding = structuredClone(plan);
    sharedRuleInQuantityBinding.acceptance_items[0]!.quantity = "主控项目全验";
    sharedRuleInQuantityBinding.acceptance_items[0]!.field_bindings.quantity =
      buildFieldBinding(
        "主控项目全验",
        [sharedAtom!.atom_id],
        prepared.manifest,
        "故意把共享抽样条款错误绑定到项目数量字段",
      );
    expect(validatePlanText(
      prettyJson(sharedRuleInQuantityBinding),
      prepared.manifest,
    ).issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "field_binding_relation" }),
    ]));
  });

  test("rejects an empty business plan for an Agent-discovered target", async () => {
    const root = await tempRoot("agent-empty-business-plan");
    const markdownPath = join(root, "source.md");
    const markdown = "地基承载力应满足设计要求。".repeat(50);
    await writeFile(markdownPath, markdown, "utf8");
    const { evidence, plan } = validPlan("job", markdown);
    const prepared = await buildAgentScopedEvidenceManifest(
      markdownPath,
      "job",
      plan.targets[0]!,
      evidence,
    );
    const empty = buildPlanContract(prepared.manifest).plan_template;
    const validation = validatePlanText(prettyJson(empty), prepared.manifest);
    expect(validation.ok).toBe(false);
    expect(validation.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "agent_target_zero_lots" }),
      expect.objectContaining({ code: "agent_target_zero_items" }),
      expect.objectContaining({ code: "unhandled_evidence" }),
      expect.objectContaining({ code: "agent_primary_atom_unhandled" }),
    ]));
  });

  test("seals a valid per-target semantic source plan", async () => {
    const root = await tempRoot("semantic-source-plan-seal");
    const markdownPath = join(root, "source.md");
    const markdown = "地基承载力应满足设计要求。复合地基增强体强度应符合设计要求。".repeat(50);
    await writeFile(markdownPath, markdown, "utf8");
    const { evidence, plan } = validPlan("direct-seal-job", markdown);
    const prepared = await buildAgentScopedEvidenceManifest(
      markdownPath,
      "direct-seal-job",
      plan.targets[0]!,
      evidence,
    );
    const revision = await RevisionWorkspace.createFromEvidence(
      root,
      "direct-seal-job",
      plan.targets[0]!.target_id,
      prepared,
    );
    const controller = await ToolController.create(revision);
    const candidatePlan = validFixturePlan(prepared.manifest);
    await controller.dispatch("replace_working_plan", {
      content: prettyJson(candidatePlan),
    });
    for (const record of prepared.manifest.evidence) {
      await controller.dispatch("open_evidence", { evidence_id: record.evidence_id });
    }
    const validation = await controller.dispatch("validate_working_plan", {});
    expect(validation).toMatchObject({ ok: true, fingerprint: expect.any(String) });
    const resumedRevision = await RevisionWorkspace.openLatest(
      root,
      "direct-seal-job",
      plan.targets[0]!.target_id,
    );
    const resumedController = await ToolController.create(resumedRevision);
    expect(await resumedController.dispatch("read_coverage_review", {})).toMatchObject({
      ok: false,
      error: "domain_coverage_review_required",
      instruction: expect.stringContaining("seal_validated_plan"),
    });
    expect(await resumedController.dispatch("seal_validated_plan", {
      fingerprint: validation.fingerprint,
    })).toMatchObject({ ok: false, error: "domain_coverage_review_required" });

    const reviewController = await CoverageReviewController.create(
      revision,
      String(validation.fingerprint),
    );
    // 原来这里断言复核指引含「mandatory wording and shared sampling alone do not make an
    // acceptance item」。1d5f3de 把整段指引改写成中文时这句丢了，中文版没有等价表述，
    // 英文原句也从源码删净。按指示移除该断言——这条护栏（强制措辞与共享抽样本身不构成
    // 验收项目）目前无人看守。
    expect(await reviewController.dispatch("get_coverage_review_contract", {})).toMatchObject({
      ok: true,
    });
    expect(await reviewController.dispatch("read_candidate_plan", {})).toMatchObject({
      ok: true,
      content: expect.any(String),
      materialized_result: {
        inspection_lots: expect.any(Array),
      },
    });
    for (const record of prepared.manifest.evidence) {
      await reviewController.dispatch("open_review_evidence", {
        evidence_id: record.evidence_id,
      });
    }
    const finalItems = materialize(candidatePlan, prepared.manifest, String(validation.fingerprint)).result.inspection_lots.flatMap((lot) => lot.items);
    const semanticCoverage: SemanticCoverageDisposition[] = finalItems.map((item, index) => {
      const source = candidatePlan.acceptance_items.find((candidate) =>
        candidate.item_id === item.reference_origin_item_id || candidate.item_id === item.item_id
      )!;
      const bindings = (candidatePlan.semantic_evidence ?? []).filter((node) =>
        node.materialized_item_id === source.item_id || node.materialized_item_id === item.item_id
      ).map((node) => ({ evidence_id: node.evidence_id, exact_fragment: node.exact_fragment }));
      return {
        coverage_id: `review-leaf:${index + 1}`,
        disposition: "acceptance_item",
        judgment_id: `judgment:${item.item_id}`,
        item_ids: [item.item_id],
        evidence_bindings: bindings,
        reason: "All exact propositions remain bound to this independently judged final leaf.",
      };
    });
    for (const evidenceId of coverageReviewObligations(prepared.manifest, candidatePlan).uncovered_primary_evidence_ids) {
      const record = prepared.manifest.evidence.find((candidate) => candidate.evidence_id === evidenceId)!;
      semanticCoverage.push({
        coverage_id: `review-irrelevant:${semanticCoverage.length + 1}`,
        disposition: "irrelevant",
        judgment_id: "",
        item_ids: [],
        evidence_bindings: [{ evidence_id: record.evidence_id, exact_fragment: record.text }],
        reason: "The reviewer explicitly disposed this boundary evidence as non-business content.",
      });
    }
    const stagedReview = await reviewController.dispatch("stage_coverage_review_draft", {
        status: "approved",
        semantic_coverage_upserts: semanticCoverage,
        summary: "All independently executable requirements remain losslessly represented.",
    });
    const reviewValidation = stagedReview.validation as Record<string, unknown>;
    expect(reviewValidation).toMatchObject({ ok: true, fingerprint: expect.any(String) });
    expect(await reviewController.dispatch("seal_coverage_review", {
      fingerprint: reviewValidation.fingerprint,
    })).toMatchObject({ ok: true, status: "approved" });
    const approvedController = await ToolController.create(resumedRevision);
    expect(await approvedController.dispatch("seal_validated_plan", {
      fingerprint: validation.fingerprint,
    })).toMatchObject({ ok: true, status: "passed" });
  });

  test("refuses to seal a plan whose misreported harness finding normalizes to semantic repair", async () => {
    const root = await tempRoot("semantic-source-plan-harness-defect");
    const markdownPath = join(root, "source.md");
    const markdown = "地基承载力应满足设计要求，检验结果应记录。".repeat(50);
    await writeFile(markdownPath, markdown, "utf8");
    const { evidence, plan } = validPlan("harness-defect-job", markdown);
    const prepared = await buildAgentScopedEvidenceManifest(
      markdownPath,
      "harness-defect-job",
      plan.targets[0]!,
      evidence,
    );
    const revision = await RevisionWorkspace.createFromEvidence(
      root,
      "harness-defect-job",
      plan.targets[0]!.target_id,
      prepared,
    );
    const controller = await ToolController.create(revision);
    const candidatePlan = validFixturePlan(prepared.manifest);
    await controller.dispatch("replace_working_plan", { content: prettyJson(candidatePlan) });
    for (const record of prepared.manifest.evidence) {
      await controller.dispatch("open_evidence", { evidence_id: record.evidence_id });
    }
    const validation = await controller.dispatch("validate_working_plan", {});
    expect(validation).toMatchObject({ ok: true, fingerprint: expect.any(String) });

    const finalItem = materialize(
      candidatePlan,
      prepared.manifest,
      String(validation.fingerprint),
    ).result.inspection_lots.flatMap((lot) => lot.items)[0]!;
    const semanticNode = candidatePlan.semantic_evidence![0]!;
    const reviewController = await CoverageReviewController.create(
      revision,
      String(validation.fingerprint),
    );
    for (const record of prepared.manifest.evidence) {
      await reviewController.dispatch("open_review_evidence", { evidence_id: record.evidence_id });
    }
    const semanticCoverage: SemanticCoverageDisposition[] = [{
      coverage_id: "review-leaf:1",
      disposition: "acceptance_item",
      judgment_id: `judgment:${finalItem.item_id}`,
      item_ids: [finalItem.item_id],
      evidence_bindings: [{
        evidence_id: semanticNode.evidence_id,
        exact_fragment: semanticNode.exact_fragment,
      }],
      reason: "The final leaf remains bound to its exact source proposition.",
    }];
    for (const evidenceId of coverageReviewObligations(prepared.manifest, candidatePlan).uncovered_primary_evidence_ids) {
      const record = prepared.manifest.evidence.find((candidate) => candidate.evidence_id === evidenceId)!;
      semanticCoverage.push({
        coverage_id: `review-irrelevant:${semanticCoverage.length + 1}`,
        disposition: "irrelevant",
        judgment_id: "",
        item_ids: [],
        evidence_bindings: [{ evidence_id: record.evidence_id, exact_fragment: record.text }],
        reason: "The reviewer explicitly disposed this remaining primary evidence.",
      });
    }
    const staged = await reviewController.dispatch("stage_coverage_review_draft", {
      status: "harness_defect",
      semantic_coverage_upserts: semanticCoverage,
      finding_upserts: [{
        finding_id: "finding:compiler-output",
        finding_type: "compiler_materialization_defect",
        evidence_id: semanticNode.evidence_id,
        exact_fragment: semanticNode.exact_fragment,
        affected_item_ids: [finalItem.item_id],
        description: "The deterministic output does not preserve the reviewed source proposition.",
        reason: "This finding belongs to the compiler owner and must never be routed to semantic repair.",
      }],
      summary: "The semantic selection is reviewable, but deterministic materialization is defective.",
    });
    const reviewValidation = staged.validation as Record<string, unknown>;
    expect(reviewValidation).toMatchObject({ ok: true, fingerprint: expect.any(String) });
    expect(await reviewController.dispatch("seal_coverage_review", {
      fingerprint: reviewValidation.fingerprint,
    })).toMatchObject({ ok: true, status: "repair" });

    expect(await controller.dispatch("seal_validated_plan", {
      fingerprint: validation.fingerprint,
    })).toMatchObject({
      ok: false,
      error: "domain_coverage_repair_required",
      current_fingerprint: validation.fingerprint,
    });
    expect(await readFile(revision.manifestPath, "utf8").catch(() => "")).toBe("");
  });

  test("keeps GB 50202 chapter 3 governing and record clauses as semantic context", () => {
    const markdown = [
      "施工前及施工过程中所进行的检验项目应制作表格，并应做相应记录、校审存档。",
      "素土、灰土地基的承载力必须达到设计要求。",
      "主控项目的质量检验结果必须全部符合检验标准，一般项目的验收合格率不得低于80%。",
    ].join("\n");
    const evidence = buildDocumentEvidence(markdown, "source.md");
    const atom = evidence.atoms[0]!;
    const plan: DocumentTargetPlan = {
      schema_version: "document-target-plan/v4",
      job_id: "semantic-role-job",
      document_fingerprint: evidence.evidence_fingerprint,
      targets: [{
        target_id: "soil-lime-foundation",
        group_id: "foundation-treatment",
        group_name: "地基处理工程",
        group_reason: "素土、灰土地基属于可独立检查的地基处理实体",
        name: "素土、灰土地基",
        description: "素土、灰土地基实体质量验收",
        evidence_atom_ids: [atom.atom_id],
        evidence_fragments: [{ atom_id: atom.atom_id, text: "素土、灰土地基的承载力必须达到设计要求" }],
        materialization: {
          kind: "inspection_scope",
          lot_basis_summary: "按素土、灰土地基承载力要求形成实体检验批",
          lot_basis_fragments: [{ atom_id: atom.atom_id, text: "素土、灰土地基的承载力必须达到设计要求" }],
          reason: "该句直接约束可检查的素土、灰土地基实体",
        },
        reason: "可以形成素土、灰土地基检验批和验收项目",
      }],
      context_notes: [
        {
          context_id: "inspection-record-template",
          role: "record_template",
          name: "施工检验记录与存档",
          evidence_atom_ids: [atom.atom_id],
          evidence_fragments: [{ atom_id: atom.atom_id, text: "施工前及施工过程中所进行的检验项目应制作表格，并应做相应记录、校审存档" }],
          reason: "规定记录和存档方式，不是被检验的工程实体",
        },
        {
          context_id: "main-general-pass-criteria",
          role: "governing_rule",
          name: "主控项目与一般项目合格判定",
          evidence_atom_ids: [atom.atom_id],
          evidence_fragments: [{ atom_id: atom.atom_id, text: "主控项目的质量检验结果必须全部符合检验标准，一般项目的验收合格率不得低于80%" }],
          reason: "规定其他验收项目的合格判定方式，不形成新的检验批",
        },
      ],
      dispositions: [{
        atom_id: atom.atom_id,
        disposition: "target",
        target_ids: ["soil-lime-foundation"],
        reason: "同一物理窗口同时含实体验收目标和上下文规则",
      }],
    };
    const validation = validateDocumentTargetPlan(
      plan,
      evidence,
      "semantic-role-job",
      new Set([atom.atom_id]),
    );
    expect(validation).toMatchObject({ ok: true, issues: [] });

    const missingLotBasis = structuredClone(plan);
    delete (missingLotBasis.targets[0] as Partial<(typeof missingLotBasis.targets)[number]>).materialization;
    expect(validateDocumentTargetPlan(
      missingLotBasis,
      evidence,
      "semantic-role-job",
      new Set([atom.atom_id]),
    ).issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "target_materialization" }),
    ]));
  });

  test("keeps a referenced GB 50202 soil-reinforcement scope as a materialized target", async () => {
    const markdown = [
      "7.9.1 土体加固施工质量检验应符合本节规定。",
      "7.9.2 加固土体的强度检验可采用钻芯法，取芯数量不应少于总桩数的0.5%，且不应少于3根。",
      "7.9.3 原位测试的检验数量每200m²不应少于1点，且总数不应少于5点。",
      "7.9.4 采用水泥土搅拌桩进行土体加固时，其施工质量检验应符合本标准表7.8.4的规定。",
      "7.9.5 采用高压喷射注浆桩进行土体加固时，其施工质量检验应符合本标准表7.2.11的规定。",
      "7.9.6 采用注浆法进行土体加固时，其施工质量检验应符合本标准表4.7.4的规定。",
    ].join("\n");
    const evidence = buildDocumentEvidence(markdown.repeat(8), "source.md");
    const atom = evidence.atoms[0]!;
    const plan: DocumentTargetPlan = {
      schema_version: "document-target-plan/v4",
      job_id: "soil-reinforcement-job",
      document_fingerprint: evidence.evidence_fingerprint,
      targets: [{
        target_id: "soil-reinforcement",
        group_id: "foundation-excavation-support",
        group_name: "基坑支护工程",
        group_reason: "土体加固是可独立检查的被检工程实体",
        name: "土体加固",
        description: "土体加固强度、原位测试及引用工艺质量验收",
        evidence_atom_ids: [atom.atom_id],
        evidence_fragments: [{ atom_id: atom.atom_id, text: "7.9.1 土体加固施工质量检验应符合本节规定。" }],
        materialization: {
          kind: "inspection_scope",
          lot_basis_summary: "土体加固以取芯数量等具体检验要求形成检验批",
          lot_basis_fragments: [
            { atom_id: atom.atom_id, text: "取芯数量不应少于总桩数的0.5%，且不应少于3根" },
            { atom_id: atom.atom_id, text: "其施工质量检验应符合本标准表7.8.4的规定" },
          ],
          reason: "条文直接规定土体加固的检验和抽样，并按具体工艺引用验收标准",
        },
        reason: "被检主体明确；引用表提供验收项目，不改变其目标身份",
      }],
      context_notes: [],
      dispositions: evidence.atoms.map((entry) => ({
        atom_id: entry.atom_id,
        disposition: "target" as const,
        target_ids: ["soil-reinforcement"],
        reason: "该物理窗口包含土体加固验收业务内容",
      })),
    };
    const validation = validateDocumentTargetPlan(
      plan,
      evidence,
      "soil-reinforcement-job",
      new Set(evidence.atoms.map((entry) => entry.atom_id)),
    );
    expect(validation).toMatchObject({ ok: true, issues: [] });

    const root = await tempRoot("soil-reinforcement-contract");
    const markdownPath = join(root, "source.md");
    await writeFile(markdownPath, markdown.repeat(8), "utf8");
    const workspace = await DocumentDiscoveryWorkspace.openOrCreate(
      root,
      "soil-reinforcement-contract",
      markdownPath,
    );
    const controller = await DocumentDiscoveryController.create(workspace, "candidate");
    const contract = await controller.dispatch("get_discovery_contract", {});
    expect(contract.rules).toEqual(expect.arrayContaining([
      expect.stringContaining("remains a target when its own clauses delegate criteria"),
    ]));
  });
});


test("bounded discovery quote ambiguity routes to the callable atom reader without claiming uniqueness", async () => {
  const root = await tempRoot("document-discovery-long-quote-context");
  const markdownPath = join(root, "source.md");
  const quote = "虚构定位要求";
  const padding = "重复".repeat(220);
  await writeFile(markdownPath, ["甲", "乙"].map(label => label + padding + quote + padding + label).join(" | "), "utf8");
  const workspace = await DocumentDiscoveryWorkspace.openOrCreate(root, "job", markdownPath);
  const controller = await DocumentDiscoveryController.create(workspace, "candidate");
  const atom = controller.evidence.atoms[0]!;
  await controller.dispatch("open_document_atom", { atom_id: atom.atom_id });
  const request = { atom_id: atom.atom_id, quote };
  const single = await controller.dispatch("locate_document_span", request) as any;
  const batch = await controller.dispatch("batch_locate_document_spans", { requests: [request] }) as any;
  for (const result of [single, batch.results[0]]) {
    expect(result).toMatchObject({ ok: false, error: "selector_span_not_unique" });
    expect(result.instruction).toContain("仍有歧义");
    const details = result.issues[0].details;
    expect(details).toMatchObject({ next_tool: "open_document_atom", next_tool_arguments: { atom_id: atom.atom_id },
      context_read: { tool: "open_document_atom", arguments: { atom_id: atom.atom_id } } });
    expect(Object.keys(details.context_read.arguments)).toEqual(["atom_id"]);
    expect(details.disambiguation_candidates.every((candidate: any) => !candidate.context_unique)).toBe(true);
    expect(JSON.stringify(result)).not.toContain("list_evidence_resources");
    expect(await controller.dispatch(details.next_tool, details.next_tool_arguments)).toMatchObject({ ok: true });
  }
  expect(await controller.dispatch("locate_document_span", { ...request, prefix: "乙" + padding })).toMatchObject({ ok: true });
});
