import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";

import { prettyJson } from "../src/canonical.js";
import {
  buildDocumentEvidence,
  DocumentDiscoveryController,
  DocumentDiscoveryWorkspace,
} from "../src/document-discovery.js";
import {
  compileDocumentSelectors,
  initialDocumentSelectorPlan,
} from "../src/document-selector-compiler.js";
import {
  locateAndRegisterSourceQuote,
  registryWithFullSourceSpans,
} from "../src/source-span-registry.js";

// 两条互相独立的条文，各自可成 target：一条保持完好，另一条故意跨块引用验收依据，
// 复现 selector_semantic_evidence_unbound 的最小形态。
const firstClause = "7.2.1 传感装置的外壳应完整。\n检查数量：全数检查。";
const secondClause = "7.2.2 传动装置的噪声应达标。\n检查数量：按批抽检。";
const thirdClause = "7.2.3 控制装置的指示应正确。\n检查数量：全数检查。";
const markdown = `# 7 检测设施\n## 7.2 传动与传感\n${firstClause}\n${secondClause}`;

function buildEvidenceAndRegistry(source = markdown) {
  const evidence = buildDocumentEvidence(source, "synthetic.md");
  let registry = registryWithFullSourceSpans(
    evidence.evidence_fingerprint,
    evidence.atoms.map(atom => ({ source_id: atom.atom_id, atom_id: atom.atom_id, text: atom.text })),
  );
  const locate = (quote: string) => {
    const result = locateAndRegisterSourceQuote(
      registry,
      { source_id: evidence.atoms[0]!.atom_id, atom_id: evidence.atoms[0]!.atom_id, text: evidence.atoms[0]!.text },
      quote,
    );
    registry = result.registry;
    return result.spans[0]!.span_id;
  };
  return { evidence, getRegistry: () => registry, locate };
}

async function brokenPairScenario(withPendingTarget = false) {
  const source = withPendingTarget ? `${markdown}\n${thirdClause}` : markdown;
  const { evidence, getRegistry, locate } = buildEvidenceAndRegistry(source);
  const spans = [locate(firstClause), locate(secondClause)];
  const selectors = initialDocumentSelectorPlan("repair-pair");
  selectors.targets = ["sensor", "drive"].map((key, index) => ({
    key, name: index === 0 ? "传感装置" : "传动装置", group_key: "facilities", group_name: "检测设施", group_reason: "按受检设施分组",
    lot_basis_summary: "独立条文验收", scope_span_ids: [spans[index]!], lot_basis_span_ids: [spans[index]!], reason: "独立受检对象",
    source_blocks: [{ kind: "explicit_range", anchor_span_id: spans[index]!, start_span_id: spans[index]!, end_span_id: spans[index]!, reason: "本条完整的实体要求" }],
    semantic_basis: { subject: key, subject_kind: "product", acceptance_kind: "direct_criterion", acceptance_span_ids: [spans[1 - index]!], acceptance_reason: "夹具故意误引另一条文", boundary_reason: "独立条文自成一体" },
  }));
  if (withPendingTarget) {
    const span = locate(thirdClause);
    const pending = structuredClone(selectors.targets[0]!);
    delete pending.semantic_basis;
    Object.assign(pending, {
      key: "control", name: "控制装置", scope_span_ids: [span], lot_basis_span_ids: [span],
      source_blocks: [{ kind: "explicit_range", anchor_span_id: span, start_span_id: span, end_span_id: span, reason: "控制装置独立条文" }],
    });
    selectors.targets.push(pending);
  }
  selectors.dispositions = [{
    atom_span_id: getRegistry().spans.find(span => span.start === 0 && span.end === evidence.atoms[0]!.text.length)!.span_id,
    disposition: "target", target_keys: ["sensor", "drive"], reason: "两条文分别归属两个目标",
  }];
  const root = resolve(".tmp-tests", `discovery-repair-pair-${randomUUID()}`);
  await mkdir(root, { recursive: true });
  const path = join(root, "synthetic.md");
  await writeFile(path, source, "utf8");
  const workspace = await DocumentDiscoveryWorkspace.openOrCreate(root, "repair-pair", path);
  if (withPendingTarget) await workspace.setRuntime({ kind: "pi-sdk", session_id: "mixed-draft-author", session_file: "mixed-draft-author.jsonl" });
  await writeFile(workspace.sourceSpanRegistryPath, prettyJson(getRegistry()), "utf8");
  await workspace.writeWorkingSelectors(prettyJson(selectors));
  const controller = await DocumentDiscoveryController.create(workspace);
  const fix = (index: number) => ({ collection: "targets", key: selectors.targets[index]!.key, op: "update",
    value: { semantic_basis: { ...selectors.targets[index]!.semantic_basis!, acceptance_span_ids: [spans[index]!] } } });
  return { controller, workspace, selectors, evidence, registry: getRegistry(), fix, spans };
}

describe("checkpoint receipt separates patch issues from pre-existing plan issues", () => {
  test.each([
    ["reference", "selector_unknown_span"],
    ["acceptance", "selector_semantic_evidence_unbound"],
    ["scope", "target_scope_revision_required"],
  ] as const)("live mixed drafts reject invalid %s even while another target lacks semantic proof", async (kind, code) => {
    const { controller, workspace, selectors, fix, spans } = await brokenPairScenario(true);
    selectors.targets[0]!.semantic_basis = fix(0).value.semantic_basis;
    selectors.targets[1]!.semantic_basis = fix(1).value.semantic_basis;
    await workspace.writeWorkingSelectors(prettyJson(selectors));
    const before = await readFile(workspace.workingSelectorPath, "utf8");
    const registryBefore = await readFile(workspace.sourceSpanRegistryPath, "utf8");
    const historyBefore = await readdir(workspace.historyDirectory);
    const stateBefore = await workspace.readState();
    const value = kind === "reference" ? { reference_span_ids: ["span:00000000000000000000000000000000"] }
      : kind === "scope" ? { scope_span_ids: [spans[1]] }
      : { semantic_basis: { ...selectors.targets[0]!.semantic_basis!, acceptance_span_ids: [spans[1]] } };
    for (const dry_run of [true, false]) {
      const receipt = await controller.dispatch("edit_document_selectors", {
        edits: [{ collection: "targets", key: "sensor", op: "update", value }], dry_run,
      });
      expect(receipt).toMatchObject({ ok: false, saved: false, selector_issues: expect.arrayContaining([
        expect.objectContaining({ code, in_this_patch: true }),
      ]) });
      expect(await readFile(workspace.workingSelectorPath, "utf8")).toBe(before);
      expect(await readFile(workspace.sourceSpanRegistryPath, "utf8")).toBe(registryBefore);
      expect(await readdir(workspace.historyDirectory)).toEqual(historyBefore);
      expect(await workspace.readState()).toMatchObject({ validation_attempts: stateBefore.validation_attempts });
      if (receipt.draft_id) expect(await controller.dispatch("discard_document_selector_draft", { draft_id: receipt.draft_id })).toMatchObject({ ok: true });
    }
  });

  test("live mixed drafts save strictly improving repairs but still block final compilation and sealing", async () => {
    const { controller, workspace, selectors, fix } = await brokenPairScenario(true);
    const before = await readFile(workspace.workingSelectorPath, "utf8");
    const registryBefore = await readFile(workspace.sourceSpanRegistryPath, "utf8");
    const historyBefore = await readdir(workspace.historyDirectory);
    const stateBefore = await workspace.readState();
    const prepared = await controller.dispatch("edit_document_selectors", { edits: [fix(0)], dry_run: true });
    expect(prepared)
      .toMatchObject({ ok: true, saved: false, dry_run: true, final_compile_ready: false,
        previous_issue_count: 2, remaining_issue_count: 1, pre_existing_target_keys: ["drive"] });
    expect(await readFile(workspace.workingSelectorPath, "utf8")).toBe(before);
    expect(await readFile(workspace.sourceSpanRegistryPath, "utf8")).toBe(registryBefore);
    expect(await readdir(workspace.historyDirectory)).toEqual(historyBefore);
    expect(await workspace.readState()).toMatchObject({ validation_attempts: stateBefore.validation_attempts });
    expect(await controller.dispatch("edit_document_selectors", { draft_id: prepared.draft_id, edits: [] }))
      .toMatchObject({ ok: true, saved: true, final_compile_ready: false,
        previous_issue_count: 2, remaining_issue_count: 1, pre_existing_target_keys: ["drive"] });
    const afterFirst = JSON.parse(await readFile(workspace.workingSelectorPath, "utf8"));
    expect(afterFirst.targets[1]).toEqual(selectors.targets[1]);
    expect(afterFirst.targets[2]).toEqual(selectors.targets[2]);
    expect(await controller.dispatch("edit_document_selectors", { edits: [fix(1)] }))
      .toMatchObject({ ok: true, saved: true, final_compile_ready: false, pending_semantic_target_count: 1 });
    const obligations = await controller.dispatch("read_discovery_obligations", {});
    const obligationIssues = obligations.selector_issues as Array<{ code: string; details?: { actual?: unknown } }>;
    expect(obligationIssues.filter(issue => issue.code !== "selector_target_semantic_basis_required"
      || issue.details?.actual !== null)).toEqual([]);
    await controller.dispatch("batch_open_document_atoms", { atom_ids: controller.evidence.atoms.map(atom => atom.atom_id) });
    expect(await controller.dispatch("compile_document_selectors", {}))
      .toMatchObject({ ok: false, error: "document_selector_compile_failed", selector_issues: expect.arrayContaining([
        expect.objectContaining({ code: "selector_target_semantic_basis_required" }),
      ]) });
    expect(await controller.dispatch("submit_discovery_candidate", {})).toMatchObject({ ok: false });
    const reviewer = await DocumentDiscoveryController.create(workspace, "review");
    await reviewer.dispatch("batch_open_document_atoms", { atom_ids: reviewer.evidence.atoms.map(atom => atom.atom_id) });
    expect(await reviewer.dispatch("seal_discovery_plan", {})).toMatchObject({ ok: false });
    expect((await workspace.readState()).status).not.toBe("sealed");
  });

  test.each([
    ["format", "selector_span_id_format"],
    ["unknown", "selector_unknown_span"],
    ["partial", "selector_atom_disposition_not_full_span"],
    ["duplicate", "selector_duplicate_atom_disposition"],
  ] as const)("live mixed drafts validate an authored %s disposition before accepting a checkpoint", async (kind, code) => {
    const { controller, workspace, selectors, fix, spans } = await brokenPairScenario(true);
    selectors.targets[0]!.semantic_basis = fix(0).value.semantic_basis;
    selectors.targets[1]!.semantic_basis = fix(1).value.semantic_basis;
    const disposition = selectors.dispositions[0]!;
    if (kind === "duplicate") selectors.dispositions.push(structuredClone(disposition));
    await workspace.writeWorkingSelectors(prettyJson(selectors));
    const before = await readFile(workspace.workingSelectorPath, "utf8");
    const registryBefore = await readFile(workspace.sourceSpanRegistryPath, "utf8");
    const historyBefore = await readdir(workspace.historyDirectory);
    const stateBefore = await workspace.readState();
    const key = kind === "format" ? "span:missing-disposition"
      : kind === "partial" ? spans[0]! : "span:00000000000000000000000000000000";
    const edits = kind === "duplicate"
      ? [{ collection: "targets", key: "sensor", op: "update", value: { reason: "按原文检查传感装置" } }]
      : [{ collection: "dispositions", key: disposition.atom_span_id, op: "remove" },
        { collection: "dispositions", key, op: "upsert", value: { disposition: "target", target_keys: [], reason: "待核对来源" } }];
    for (const dry_run of [true, false]) {
      const receipt = await controller.dispatch("edit_document_selectors", { edits, dry_run });
      expect(receipt)
        .toMatchObject({ ok: false, saved: false, selector_issues: expect.arrayContaining([
          expect.objectContaining({ code }),
        ]) });
      expect(await readFile(workspace.workingSelectorPath, "utf8")).toBe(before);
      expect(await readFile(workspace.sourceSpanRegistryPath, "utf8")).toBe(registryBefore);
      expect(await readdir(workspace.historyDirectory)).toEqual(historyBefore);
      expect(await workspace.readState()).toMatchObject({ validation_attempts: stateBefore.validation_attempts });
      if (receipt.draft_id) expect(await controller.dispatch("discard_document_selector_draft", { draft_id: receipt.draft_id })).toMatchObject({ ok: true });
    }
  });

  test("saves strictly improving repairs independently while final compilation still rejects remaining issues", async () => {
    const { controller, workspace, selectors, evidence, registry, fix } = await brokenPairScenario();
    const stateBefore = await workspace.readState();
    const registryBefore = await readFile(workspace.sourceSpanRegistryPath, "utf8");
    const first = await controller.dispatch("edit_document_selectors", { edits: [fix(0)] });
    expect(first).toMatchObject({ ok: true, saved: true, final_compile_ready: false, global_coverage_ready: false,
      previous_issue_count: 2, remaining_issue_count: 1, pre_existing_target_keys: ["drive"], next_tool: "read_document_selectors" });
    const afterFirst = JSON.parse(await readFile(workspace.workingSelectorPath, "utf8"));
    expect(afterFirst.targets[1]).toEqual(selectors.targets[1]);
    expect(() => compileDocumentSelectors(afterFirst, registry, evidence, "repair-pair")).toThrow();
    expect(await workspace.readState()).toMatchObject({ validation_attempts: stateBefore.validation_attempts });
    expect(await readFile(workspace.sourceSpanRegistryPath, "utf8")).toBe(registryBefore);
    expect(await controller.dispatch("compile_document_selectors", {}))
      .toMatchObject({ ok: false, error: "document_selector_compile_failed" });
    const second = await controller.dispatch("edit_document_selectors", { edits: [fix(1)] });
    expect(second).toMatchObject({ ok: true, saved: true });
    const finished = JSON.parse(await readFile(workspace.workingSelectorPath, "utf8"));
    expect(() => compileDocumentSelectors(finished, registry, evidence, "repair-pair")).not.toThrow();
  });

  test("dry-run reports an improving repair without writing a checkpoint or consuming validation budget", async () => {
    const { controller, workspace, fix } = await brokenPairScenario();
    const before = await readFile(workspace.workingSelectorPath, "utf8");
    const registryBefore = await readFile(workspace.sourceSpanRegistryPath, "utf8");
    const historyBefore = await readdir(workspace.historyDirectory);
    const stateBefore = await workspace.readState();
    expect(await controller.dispatch("edit_document_selectors", { edits: [fix(0)], dry_run: true }))
      .toMatchObject({ ok: true, saved: false, dry_run: true, final_compile_ready: false, remaining_issue_count: 1 });
    expect(await readFile(workspace.workingSelectorPath, "utf8")).toBe(before);
    expect(await readFile(workspace.sourceSpanRegistryPath, "utf8")).toBe(registryBefore);
    expect(await readdir(workspace.historyDirectory)).toEqual(historyBefore);
    expect(await workspace.readState()).toMatchObject({ validation_attempts: stateBefore.validation_attempts });
  });

  test("a repair that introduces another error still rejects the entire transaction", async () => {
    const { controller, workspace, selectors, fix } = await brokenPairScenario();
    const before = await readFile(workspace.workingSelectorPath, "utf8");
    const response = await controller.dispatch("edit_document_selectors", { edits: [fix(0), {
      collection: "targets", key: "drive", op: "update", value: {
        semantic_basis: { ...selectors.targets[1]!.semantic_basis!, acceptance_span_ids: ["span:does-not-exist"] },
      },
    }] });
    expect(response).toMatchObject({ ok: false, saved: false });
    expect(await readFile(workspace.workingSelectorPath, "utf8")).toBe(before);
  });

  test("editing a healthy target while another target is broken flags the broken one as pre-existing", async () => {
    const { evidence, getRegistry, locate } = buildEvidenceAndRegistry();
    const spanFirst = locate(firstClause);
    const spanSecond = locate(secondClause);
    const selectors = initialDocumentSelectorPlan("job");
    selectors.targets = [
      {
        key: "sensor", name: "传感装置", group_key: "facilities", group_name: "检测设施", group_reason: "按受检设施分组",
        lot_basis_summary: "检查外壳完整性", scope_span_ids: [spanFirst], lot_basis_span_ids: [spanFirst], reason: "外壳是具体受检对象",
        source_blocks: [{ kind: "explicit_range", anchor_span_id: spanFirst, start_span_id: spanFirst, end_span_id: spanFirst, reason: "本条完整的实体要求" }],
        semantic_basis: { subject: "传感装置", subject_kind: "product", acceptance_kind: "direct_criterion", acceptance_span_ids: [spanFirst], acceptance_reason: "原文规定外壳完整性", boundary_reason: "独立条文自成一体" },
      },
      {
        key: "drive", name: "传动装置", group_key: "facilities", group_name: "检测设施", group_reason: "按受检设施分组",
        lot_basis_summary: "检查噪声", scope_span_ids: [spanSecond], lot_basis_span_ids: [spanSecond], reason: "噪声是具体受检对象",
        source_blocks: [{ kind: "explicit_range", anchor_span_id: spanSecond, start_span_id: spanSecond, end_span_id: spanSecond, reason: "本条完整的实体要求" }],
        semantic_basis: { subject: "传动装置", subject_kind: "product", acceptance_kind: "direct_criterion", acceptance_span_ids: [spanFirst], acceptance_reason: "误引传感条文", boundary_reason: "夹具故意跨块引用" },
      },
    ];
    selectors.dispositions = [{
      atom_span_id: getRegistry().spans.find(span => span.start === 0 && span.end === evidence.atoms[0]!.text.length)!.span_id,
      disposition: "target", target_keys: ["sensor", "drive"], reason: "两条原子分别归属两个目标",
    }];

    const root = resolve(".tmp-tests", `discovery-preexisting-${randomUUID()}`);
    await mkdir(root, { recursive: true });
    const path = join(root, "synthetic.md");
    await writeFile(path, markdown, "utf8");
    const workspace = await DocumentDiscoveryWorkspace.openOrCreate(root, "job", path);
    await writeFile(workspace.sourceSpanRegistryPath, prettyJson(getRegistry()), "utf8");
    await workspace.writeWorkingSelectors(prettyJson(selectors));
    const controller = await DocumentDiscoveryController.create(workspace);

    // 只修订完好的 sensor 条目：drive 的 unbound span 是既有问题，仍会拒绝整个事务。
    const receipt = await controller.dispatch("edit_document_selectors", { edits: [
      { collection: "targets", key: "sensor", op: "upsert", value: {
        ...selectors.targets[0],
        name: "传感装置（改名）",
      } },
    ] });
    const body = receipt as { ok?: boolean; selector_issues?: Array<{ code?: string; details?: { target_key?: unknown }; in_this_patch?: boolean }>; pre_existing_issue_count?: number; pre_existing_target_keys?: string[]; instruction?: string };
    expect(body.ok).toBe(false);
    const issues = body.selector_issues ?? [];
    expect(issues.length).toBeGreaterThan(0);
    for (const issue of issues) {
      expect(typeof issue.in_this_patch, JSON.stringify(issue)).toBe("boolean");
      if (issue.details?.target_key === "drive") expect(issue.in_this_patch).toBe(false);
    }
    expect(body.pre_existing_issue_count ?? 0).toBeGreaterThan(0);
    expect(body.pre_existing_target_keys).toContain("drive");
    expect(body.instruction).toContain("pre_existing");
    expect(body.instruction).toContain("drive");
  });

  test("unreviewed atom receipts carry the excerpt, line range and the exact atom_span_id", () => {
    const { evidence, getRegistry, locate } = buildEvidenceAndRegistry();
    const spanFirst = locate(firstClause);
    const selectors = initialDocumentSelectorPlan("job");
    selectors.targets = [{
      key: "sensor", name: "传感装置", group_key: "facilities", group_name: "检测设施", group_reason: "按受检设施分组",
      lot_basis_summary: "检查外壳完整性", scope_span_ids: [spanFirst], lot_basis_span_ids: [spanFirst], reason: "外壳是具体受检对象",
      source_blocks: [{ kind: "explicit_range", anchor_span_id: spanFirst, start_span_id: spanFirst, end_span_id: spanFirst, reason: "本条完整的实体要求" }],
      semantic_basis: { subject: "传感装置", subject_kind: "product", acceptance_kind: "direct_criterion", acceptance_span_ids: [spanFirst], acceptance_reason: "原文规定外壳完整性", boundary_reason: "独立条文自成一体" },
    }];
    // 故意不提交任何 dispositions：全部原子都应报告为未处置。
    try {
      compileDocumentSelectors(selectors, getRegistry(), evidence, "job");
      throw new Error("expected compile to fail");
    } catch (error) {
      const issues = (error as { issues?: Array<{ code?: string; details?: { atom_id?: string; excerpt?: unknown; atom_span_id?: string; line_range?: { start_line?: number }; required_action?: string } }> }).issues ?? [];
      const unreviewed = issues.filter(issue => issue.code === "selector_atom_unreviewed");
      expect(unreviewed.length).toBe(evidence.atoms.length);
      for (const issue of unreviewed) {
        expect(issue.details?.excerpt).toBeTruthy();
        expect(issue.details?.line_range?.start_line).toBeGreaterThan(0);
        expect(issue.details?.atom_span_id).toMatch(/^span:/);
        expect(issue.details?.required_action).toContain("dispositions");
      }
      const firstAtom = unreviewed.find(issue => issue.details?.atom_id === evidence.atoms[0]!.atom_id);
      expect(firstAtom?.details?.excerpt).toContain("传感装置");
    }
  });

  test("inverted source-block intervals get their own actionable receipt instead of a misleading unbound", () => {
    const { evidence, getRegistry, locate } = buildEvidenceAndRegistry();
    const spanFirst = locate(firstClause);
    const spanSecond = locate(secondClause);
    const selectors = initialDocumentSelectorPlan("job");
    selectors.targets = [{
      key: "sensor", name: "传感装置", group_key: "facilities", group_name: "检测设施", group_reason: "按受检设施分组",
      lot_basis_summary: "检查外壳完整性", scope_span_ids: [spanFirst], lot_basis_span_ids: [spanFirst], reason: "外壳是具体受检对象",
      // start 选了靠后的条文、end_before 选了更靠前的条文（firstClause 在
      // markdown 中先于 secondClause），绝对位置构成区间倒挂——复现 GB 50210
      // run 20260928-230633-1e1a 的形态。
      source_blocks: [{ kind: "explicit_range", anchor_span_id: spanFirst, start_span_id: spanSecond, end_before_span_id: spanFirst, reason: "本条完整实体要求（夹具故意倒挂）" }],
      semantic_basis: { subject: "传感装置", subject_kind: "product", acceptance_kind: "direct_criterion", acceptance_span_ids: [spanFirst], acceptance_reason: "原文规定外壳完整性", boundary_reason: "独立条文自成一体" },
    }];
    selectors.dispositions = [{
      atom_span_id: getRegistry().spans.find(span => span.start === 0 && span.end === evidence.atoms[0]!.text.length)!.span_id,
      disposition: "target", target_keys: ["sensor"], reason: "原子归属该目标",
    }];
    try {
      compileDocumentSelectors(selectors, getRegistry(), evidence, "job");
      throw new Error("expected compile to fail");
    } catch (error) {
      const issues = (error as { issues?: Array<{ code?: string; details?: { start_absolute_offset?: number; end_absolute_offset?: number; target_key?: string }; path?: string }> }).issues ?? [];
      const inverted = issues.filter(issue => issue.code === "selector_block_interval_inverted");
      expect(inverted.length).toBe(1);
      expect(inverted[0]!.path).toContain("/source_blocks/0");
      const actual = inverted[0]!.details?.actual as { start_absolute_offset: number; end_absolute_offset: number };
      expect(actual.end_absolute_offset).toBeLessThan(actual.start_absolute_offset);
      expect(inverted[0]!.details?.required_action ?? "").toContain("locate_document_span");
      // 派生的 unbound 噪声被抑制：根因已单独成条。
      expect(issues.some(issue => issue.code === "selector_semantic_evidence_unbound")).toBe(false);
    }
  });
});
