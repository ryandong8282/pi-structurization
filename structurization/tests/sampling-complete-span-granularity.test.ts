import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { sha256Text } from "../src/canonical.js";
import {
  EVIDENCE_SCHEMA_VERSION,
  EVIDENCE_SCOPE_SCHEMA_VERSION,
  SEMANTIC_EVIDENCE_SCHEMA_VERSION,
  type EvidenceManifest,
} from "../src/contracts.js";
import {
  compileTargetSelectors as compileTargetSelectorsPersisted,
  initialTargetSelectorPlan,
  migrateTargetSelectorPlanForAuthoring,
  TargetSelectorCompileError,
} from "../src/target-selector-compiler.js";
import {
  locateAndRegisterSourceQuote,
  registerSourceSpan,
  registryWithFullSourceSpans,
  type ImmutableTextSource,
  type SourceSpanRegistry,
} from "../src/source-span-registry.js";
import { hydrateSemanticSourcePlan } from "../src/plan-hydration.js";
import { validateSemanticDraft } from "../src/semantic-draft.js";
import { classifySelectorIssues } from "../src/selector-issue-ownership.js";
import { checkTargetCompilerInvariants } from "../src/target-compiler-invariants.js";
import { ToolController } from "../src/tools.js";
import { RevisionWorkspace } from "../src/workspace.js";

function compileTargetSelectors(
  selectors: Parameters<typeof compileTargetSelectorsPersisted>[0],
  registry: SourceSpanRegistry,
  manifest: EvidenceManifest,
) {
  return hydrateSemanticSourcePlan(
    compileTargetSelectorsPersisted(selectors, registry, manifest),
    manifest,
  );
}

const replayRevision = join(
  process.cwd(),
  "data", "jobs", "20260812-161216-c005", "pi-agent", "jobs", "20260812-161216-c005",
  "targets", "target_3A7e688bcba993771ab6475392", "revisions", "000003",
);

const e2bbRevision6 = join(
  process.cwd(),
  "data", "jobs", "20260814-091359-a3ad", "pi-agent", "jobs", "20260814-091359-a3ad",
  "targets", "target_3Ae2bb584cce3ce9dfcefceda3", "revisions", "000006",
);

const gb50576WeldingRevision1 = join(
  process.cwd(),
  "data", "jobs", "20260814-091359-a3ad", "pi-agent", "jobs", "20260814-091359-a3ad",
  "targets", "target_3A70cf05ca4ad6e078ff60b215", "revisions", "000001",
);

const gb50576FastenerRevision1 = join(
  process.cwd(),
  "data", "jobs", "20260814-091359-a3ad", "pi-agent", "jobs", "20260814-091359-a3ad",
  "targets", "target_3A587b3a30ad2b3c947120dd40", "revisions", "000001",
);

const gb50576CurtainWallRevision1 = join(
  process.cwd(),
  "data", "jobs", "20260814-091359-a3ad", "pi-agent", "jobs", "20260814-091359-a3ad",
  "targets", "target_3A730da785e9bc491500f23d84", "revisions", "000001",
);

function manifestForSources(sources: ImmutableTextSource[]): EvidenceManifest {
  const text = sources.map((source) => source.text).join("\n");
  return {
    schema_version: EVIDENCE_SCHEMA_VERSION,
    job_id: "sampling-container-job",
    target_id: "sampling-container-target",
    source: {
      adapter: "document-domain-agent/v1",
      file_name: "source.md",
      sha256: sha256Text(text),
      semantic_workflow: SEMANTIC_EVIDENCE_SCHEMA_VERSION,
    },
    scope: {
      schema_version: EVIDENCE_SCOPE_SCHEMA_VERSION,
      mode: "agent_discovered",
      target_id: "sampling-container-target",
      source_line_count: 1,
      selected_start_line: 1,
      selected_end_exclusive_line: 2,
      selected_heading: "",
      selection_reason: "全文语义选择",
      selected_atom_ids: sources.map((source) => source.evidence_id),
      target_evidence_fragments: sources.map((source) => ({ atom_id: source.atom_id, text: source.text })),
      candidates: [],
    },
    evidence: sources.map((source) => ({
      evidence_id: source.evidence_id,
      kind: "paragraph",
      role: "supporting_clause",
      locator: `char:0-${source.text.length}`,
      text: source.text,
      text_sha256: sha256Text(source.text),
      requires_disposition: true,
      evidence_scope: "primary",
    })),
    table_fragments: [],
    reference_occurrences: [],
    evidence_fingerprint: sha256Text(`sampling-container\0${text}`),
  };
}

function registerQuotes(
  manifest: EvidenceManifest,
  sources: ImmutableTextSource[],
  quotes: Array<{ evidence_id: string; quote: string }>,
): { registry: SourceSpanRegistry; ids: Map<string, string> } {
  let registry = registryWithFullSourceSpans(manifest.evidence_fingerprint, sources);
  const ids = new Map<string, string>();
  for (const request of quotes) {
    const source = sources.find((candidate) => candidate.evidence_id === request.evidence_id)!;
    const located = locateAndRegisterSourceQuote(registry, source, request.quote);
    registry = located.registry;
    ids.set(`${request.evidence_id}\0${request.quote}`, located.spans[0]!.span_id);
  }
  return { registry, ids };
}

function samplingFixture(secondEvidence = false) {
  const sourceA: ImmutableTextSource = {
    source_id: "atom:sampling-a",
    evidence_id: "atom:sampling-a",
    atom_id: "atom:sampling-a",
    text: "前置背景。抽样规则：每批随机抽取8套连接副进行复验。后续背景。",
  };
  const sourceB: ImmutableTextSource = {
    source_id: "atom:sampling-b",
    evidence_id: "atom:sampling-b",
    atom_id: "atom:sampling-b",
    text: "另一证据：采用轴力计逐套进行测试。",
  };
  const sources = secondEvidence ? [sourceA, sourceB] : [sourceA];
  const manifest = manifestForSources(sources);
  const requests = [
    { evidence_id: sourceA.evidence_id, quote: "前置背景。" },
    { evidence_id: sourceA.evidence_id, quote: "抽样规则：每批随机抽取8套连接副进行复验。" },
    { evidence_id: sourceA.evidence_id, quote: "每批随机抽取8套连接副" },
    { evidence_id: sourceA.evidence_id, quote: "随机抽取8套连接副进行复验" },
    ...(secondEvidence ? [{ evidence_id: sourceB.evidence_id, quote: "采用轴力计逐套进行测试" }] : []),
  ];
  const registered = registerQuotes(manifest, sources, requests);
  const id = (evidenceId: string, quote: string) => registered.ids.get(`${evidenceId}\0${quote}`)!;
  const fullA = registered.registry.spans.find((span) => (
    span.evidence_id === sourceA.evidence_id && span.start === 0 && span.end === sourceA.text.length
  ))!.span_id;
  const narrow = id(sourceA.evidence_id, "抽样规则：每批随机抽取8套连接副进行复验。");
  const criterion = id(sourceA.evidence_id, "前置背景。");
  const minimum = id(sourceA.evidence_id, "每批随机抽取8套连接副");
  const script = secondEvidence
    ? id(sourceB.evidence_id, "采用轴力计逐套进行测试")
    : id(sourceA.evidence_id, "随机抽取8套连接副进行复验");
  const selectors = initialTargetSelectorPlan(manifest);
  selectors.lots.push({ key: "lot", name: "检验批 lot", scope_span_ids: [fullA], reason: "目标范围 fixture" });
  selectors.items.push({
    key: "item",
    lot_key: "lot",
    name: "复验",
    category: "主控项目",
    criterion_span_ids: [criterion],
    continuation_span_ids: [],
    fields: {
      name: { composition: "semantic_summary", span_ids: [criterion], separator: "", reason: "被检事项 fixture" },
      requirement: { composition: "verbatim", span_ids: [criterion], separator: "", reason: "完整要求 fixture" },
      method: { composition: "not_applicable", span_ids: [], separator: "", reason: "由抽样脚本承载 fixture" },
      quantity: { composition: "not_applicable", span_ids: [], separator: "", reason: "由共享规则承载 fixture" },
      note: { composition: "not_applicable", span_ids: [], separator: "", reason: "无备注 fixture" },
    },
    table: null,
    inspection_data_type: "measurement",
    inspection_data_type_reason: "形成测量结果 fixture",
    inspection_data_type_span_ids: [criterion],
    sampling: {
      status: "reference",
      rule_key: "rule",
      branch_keys: ["branch"],
      quantity_span_ids: [],
      script_span_ids: [],
      condition_span_ids: [],
      reason: "引用共享规则 fixture",
      confidence: 1,
    },
    reason: "独立验收判断 fixture",
  });
  selectors.sampling_rules.push({
    key: "rule",
    complete_span_ids: [fullA, narrow],
    components: [
      { key: "shared-applicability", role: "applicability", disposition: "absent", span_ids: [], reason: "无共享适用条件 fixture" },
      { key: "shared-acceptance", role: "acceptance_criterion", disposition: "absent", span_ids: [], reason: "无共享判定标准 fixture" },
      { key: "shared-exception", role: "exception", disposition: "absent", span_ids: [], reason: "无例外 fixture" },
      { key: "shared-note", role: "note", disposition: "absent", span_ids: [], reason: "无备注 fixture" },
    ],
    branches: [{
      key: "branch",
      applies_to_category: "主控项目",
      components: [
        { key: "branch-quantity", role: "quantity", disposition: "present", span_ids: [minimum], reason: "抽样数量 fixture" },
        { key: "branch-method", role: "method", disposition: "present", span_ids: [script], reason: "执行方法 fixture" },
        { key: "branch-condition", role: "branch_condition", disposition: "absent", span_ids: [], reason: "无分支条件 fixture" },
      ],
      reason: "抽样分支 fixture",
    }],
    reason: "共享抽样规则 fixture",
  });
  return { manifest, registry: registered.registry, selectors, fullA, narrow, criterion, minimum, script };
}

function multiBranchSamplingFixture() {
  const samplingSource: ImmutableTextSource = {
    source_id: "atom:multi-branch-sampling",
    evidence_id: "atom:multi-branch-sampling",
    atom_id: "atom:multi-branch-sampling",
    text: "公共抽样范围。梁柱抽查10%且不少于3件。墙板抽查10%且不少于3间。大空间抽查10%且不少于3面。",
  };
  const itemSource: ImmutableTextSource = {
    source_id: "atom:multi-branch-item",
    evidence_id: "atom:multi-branch-item",
    atom_id: "atom:multi-branch-item",
    text: "钢筋安装偏差应符合要求。",
  };
  const sources = [samplingSource, itemSource];
  const manifest = manifestForSources(sources);
  const branchQuotes = [
    "梁柱抽查10%且不少于3件。",
    "墙板抽查10%且不少于3间。",
    "大空间抽查10%且不少于3面。",
  ];
  const registered = registerQuotes(manifest, sources, [
    ...branchQuotes.map((quote) => ({ evidence_id: samplingSource.evidence_id, quote })),
    { evidence_id: itemSource.evidence_id, quote: itemSource.text },
  ]);
  const spanId = (evidenceId: string, quote: string) => registered.ids.get(`${evidenceId}\0${quote}`)!;
  const samplingWhole = registered.registry.spans.find((span) => (
    span.evidence_id === samplingSource.evidence_id
    && span.start === 0
    && span.end === samplingSource.text.length
  ))!.span_id;
  const itemWhole = registered.registry.spans.find((span) => (
    span.evidence_id === itemSource.evidence_id
    && span.start === 0
    && span.end === itemSource.text.length
  ))!.span_id;
  const branchSpanIds = branchQuotes.map((quote) => spanId(samplingSource.evidence_id, quote));
  const selectors = initialTargetSelectorPlan(manifest);
  selectors.lots.push({
    key: "lot",
    name: "钢筋安装检验批",
    scope_span_ids: [itemWhole],
    reason: "验收项目范围 fixture",
  });
  selectors.items.push({
    key: "item",
    lot_key: "lot",
    name: "钢筋安装偏差",
    category: "一般项目",
    criterion_span_ids: [itemWhole],
    continuation_span_ids: [],
    fields: {
      name: { composition: "semantic_summary", span_ids: [itemWhole], separator: "", reason: "项目名称 fixture" },
      requirement: { composition: "verbatim", span_ids: [itemWhole], separator: "", reason: "验收要求 fixture" },
      method: { composition: "not_applicable", span_ids: [], separator: "", reason: "由共享抽样规则承载 fixture" },
      quantity: { composition: "not_applicable", span_ids: [], separator: "", reason: "由共享抽样规则承载 fixture" },
      note: { composition: "not_applicable", span_ids: [], separator: "", reason: "无备注 fixture" },
    },
    table: null,
    inspection_data_type: "measurement",
    inspection_data_type_reason: "形成测量结果 fixture",
    inspection_data_type_span_ids: [itemWhole],
    sampling: {
      status: "reference",
      rule_key: "multi-branch-rule",
      branch_keys: ["branch-components", "branch-rooms", "branch-large-space"],
      quantity_span_ids: [],
      script_span_ids: [],
      condition_span_ids: [],
      reason: "引用多分支共享抽样规则 fixture",
      confidence: 1,
    },
    reason: "独立验收判断 fixture",
  });
  selectors.sampling_rules.push({
    key: "multi-branch-rule",
    complete_span_ids: branchSpanIds,
    components: [
      { key: "shared-applicability", role: "applicability", disposition: "present", span_ids: [samplingWhole], reason: "公共适用范围覆盖完整抽样证据 fixture" },
      { key: "shared-method", role: "method", disposition: "present", span_ids: [samplingWhole], reason: "公共抽查方法 fixture" },
      { key: "shared-quantity", role: "quantity", disposition: "absent", span_ids: [], reason: "数量由分支规定 fixture" },
      { key: "shared-acceptance", role: "acceptance_criterion", disposition: "absent", span_ids: [], reason: "无共享判定标准 fixture" },
      { key: "shared-exception", role: "exception", disposition: "absent", span_ids: [], reason: "无共享例外 fixture" },
      { key: "shared-note", role: "note", disposition: "absent", span_ids: [], reason: "无共享备注 fixture" },
    ],
    branches: branchSpanIds.map((branchSpanId, index) => ({
      key: ["branch-components", "branch-rooms", "branch-large-space"][index]!,
      applies_to_category: "一般项目" as const,
      components: [
        { key: "applicability", role: "applicability" as const, disposition: "present" as const, span_ids: [branchSpanId], reason: "分支适用对象 fixture" },
        { key: "condition", role: "branch_condition" as const, disposition: "present" as const, span_ids: [branchSpanId], reason: "分支条件 fixture" },
        { key: "method", role: "method" as const, disposition: "present" as const, span_ids: [branchSpanId], reason: "分支抽查方法 fixture" },
        { key: "quantity", role: "quantity" as const, disposition: "present" as const, span_ids: [branchSpanId], reason: "分支抽查数量 fixture" },
        { key: "acceptance", role: "acceptance_criterion" as const, disposition: "absent" as const, span_ids: [], reason: "无分支判定标准 fixture" },
        { key: "exception", role: "exception" as const, disposition: "absent" as const, span_ids: [], reason: "无分支例外 fixture" },
        { key: "note", role: "note" as const, disposition: "absent" as const, span_ids: [], reason: "无分支备注 fixture" },
      ],
      reason: "独立抽样分支 fixture",
    })),
    reason: "公共成分加三个不重叠分支 fixture",
  });
  return {
    manifest,
    registry: registered.registry,
    selectors,
    samplingSource,
    samplingWhole,
    itemWhole,
    branchSpanIds,
  };
}

describe("sampling complete span granularity", () => {
  test.each(["same-source", "cross-source-selected", "cross-source-unselected"] as const)(
    "whole-source repair candidates are executable without changing components: %s",
    (mode) => {
      const fixture = samplingFixture(mode !== "same-source");
      const rule = fixture.selectors.sampling_rules[0]!;
      rule.components[0] = {
        ...rule.components[0]!, disposition: "present", span_ids: [fixture.fullA],
      };
      const wholeIds = [fixture.fullA];
      if (mode !== "same-source") {
        const source = fixture.manifest.evidence[1]!;
        const wholeB = fixture.registry.spans.find(span => (
          span.evidence_id === source.evidence_id && span.start === 0 && span.end === source.text.length
        ))!.span_id;
        wholeIds.push(wholeB);
        rule.branches[0]!.components[1]!.span_ids = [wholeB];
        if (mode === "cross-source-selected") rule.complete_span_ids.push(wholeB);
      }
      const before = structuredClone(fixture.selectors);
      let failure: TargetSelectorCompileError | undefined;
      try {
        compileTargetSelectorsPersisted(fixture.selectors, fixture.registry, fixture.manifest);
      } catch (error) {
        expect(error).toBeInstanceOf(TargetSelectorCompileError);
        failure = error as TargetSelectorCompileError;
      }
      const issue = failure?.issues.find(issue => issue.code === "selector_sampling_complete_span_overbroad");
      expect(issue).toBeDefined();
      const details = issue!.details as {
        actual: string[]; allowed_replacement_span_ids: string[]; how_to_pass: string;
        writable_path: string; next_tool: string;
      };
      expect(details.allowed_replacement_span_ids.length).toBeGreaterThan(0);
      expect(details.allowed_replacement_span_ids.filter(id => wholeIds.includes(id))).toEqual([]);
      expect(details).toMatchObject({
        actual: before.sampling_rules[0]!.complete_span_ids,
        writable_path: "/sampling_rules/0/complete_span_ids",
        next_tool: "stage_target_selector_draft",
        how_to_pass: expect.stringContaining("保留"),
      });
      // Follow only the returned repair, without inventing a narrower semantic split.
      rule.complete_span_ids = [...details.allowed_replacement_span_ids];
      const persisted = compileTargetSelectorsPersisted(fixture.selectors, fixture.registry, fixture.manifest);
      const plan = hydrateSemanticSourcePlan(persisted, fixture.manifest);
      expect(checkTargetCompilerInvariants(fixture.selectors, plan, fixture.manifest, persisted)).toEqual([]);
      expect(validateSemanticDraft(plan, fixture.manifest).issues).toEqual([]);
      expect({ ...rule, complete_span_ids: before.sampling_rules[0]!.complete_span_ids })
        .toEqual(before.sampling_rules[0]);
      expect(fixture.selectors.items).toEqual(before.items);
      expect(persisted.shared_sampling_rules![0]!.evidence_ids)
        .toEqual(expect.arrayContaining(fixture.manifest.evidence.map(source => source.evidence_id)));
    },
  );

  test("staging feedback can be followed by reading and saving the same complete sampling record", async () => {
    const fixture = samplingFixture(true);
    const rule = fixture.selectors.sampling_rules[0]!;
    rule.components[0] = { ...rule.components[0]!, disposition: "present", span_ids: [fixture.fullA] };
    const root = await mkdtemp(join(tmpdir(), "sampling-feedback-roundtrip-"));
    try {
      const workspace = await RevisionWorkspace.createFromEvidence(root, fixture.manifest.job_id, fixture.manifest.target_id, {
        manifest: fixture.manifest, markdown: Buffer.from(fixture.manifest.evidence.map(e => e.text).join("\n")),
      });
      await writeFile(workspace.sourceSpanRegistryPath, JSON.stringify(fixture.registry), "utf8");
      const controller = await ToolController.create(workspace);
      await controller.dispatch("read_target_selectors", {});
      for (const source of fixture.manifest.evidence) {
        await controller.dispatch("open_evidence", { evidence_id: source.evidence_id });
      }
      const first = await controller.dispatch("stage_target_selector_draft", { draft: {
        lots: fixture.selectors.lots, items: fixture.selectors.items, sampling_rules: [rule],
      } }) as any;
      expect(first).toMatchObject({ ok: true, local_validation: { ok: false } });
      const issue = first.local_validation.issues.find((issue: { code: string }) => (
        issue.code === "selector_sampling_complete_span_overbroad"
      ));
      expect(issue).toBeDefined();
      expect(issue.detail_fields_at_issue_level).toContain("how_to_pass");
      expect(issue.how_to_pass).toContain("complete_span_ids");
      expect(issue.details.how_to_pass).toBeUndefined();
      expect(issue.actual).toEqual(rule.complete_span_ids);
      const read = await controller.dispatch(issue.details.candidate_read_tool, {
        collection: "sampling_rules", key: issue.details.sampling_rule_key,
      }) as any;
      expect(read).toMatchObject({ ok: true, rows: [rule] });
      const replacement = { ...read.rows[0], complete_span_ids: issue.details.allowed_replacement_span_ids };
      const second = await controller.dispatch(issue.next_tool, {
        collection: "sampling_rules", operation: "upsert", draft: { sampling_rules: [replacement] },
      });
      expect(second, JSON.stringify(second)).toMatchObject({ ok: true, local_validation: { ok: true }, budget_consumed: false });
      const saved = JSON.parse(await readFile(workspace.workingSelectorPath, "utf8"));
      expect(saved.sampling_rules).toEqual([replacement]);
      expect(saved.items).toEqual(fixture.selectors.items);
      expect(saved.lots).toEqual(fixture.selectors.lots);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  test("sampling source semantic covers common components and three same-source branches deterministically", () => {
    const fixture = multiBranchSamplingFixture();
    const persisted = compileTargetSelectorsPersisted(fixture.selectors, fixture.registry, fixture.manifest);
    const plan = hydrateSemanticSourcePlan(persisted, fixture.manifest);
    const rule = persisted.shared_sampling_rules![0]!;
    const semantic = persisted.semantic_evidence!.find((node) => node.semantic_id === rule.source_semantic_id)!;
    const semanticSpan = persisted.source_spans.find((span) => span.span_id === semantic.span_id)!;
    const typedMemberSpanIds = [
      ...rule.components.filter((component) => component.disposition === "present")
        .flatMap((component) => component.source_span_ids),
      ...rule.branches.flatMap((branch) => [
        ...branch.components.filter((component) => component.disposition === "present")
          .flatMap((component) => component.source_span_ids),
        ...(branch.conditions ?? []).flatMap((condition) => condition.source_span_ids),
      ]),
      ...rule.shared_conditions.flatMap((condition) => condition.source_span_ids),
    ];

    expect(semanticSpan).toMatchObject({
      evidence_id: fixture.samplingSource.evidence_id,
      start: 0,
      end: fixture.samplingSource.text.length,
    });
    expect(typedMemberSpanIds.every((spanId) => {
      const member = persisted.source_spans.find((span) => span.span_id === spanId)!;
      return member.evidence_id === semanticSpan.evidence_id
        && member.start >= semanticSpan.start
        && member.end <= semanticSpan.end;
    })).toBe(true);
    expect(checkTargetCompilerInvariants(fixture.selectors, plan, fixture.manifest, persisted)).toEqual([]);

    const reorderedSelectors = structuredClone(fixture.selectors);
    reorderedSelectors.sampling_rules[0]!.branches.reverse();
    const reordered = compileTargetSelectorsPersisted(reorderedSelectors, fixture.registry, fixture.manifest);
    const reorderedRule = reordered.shared_sampling_rules![0]!;
    const reorderedSemantic = reordered.semantic_evidence!.find((node) => (
      node.semantic_id === reorderedRule.source_semantic_id
    ))!;
    const reorderedSemanticSpan = reordered.source_spans.find((span) => span.span_id === reorderedSemantic.span_id)!;
    const branchSemantics = (candidate: typeof rule) => candidate.branches.map((branch) => ({
      branch_id: branch.branch_id,
      min_sampling: branch.min_sampling,
      script: branch.script,
      source_span_ids: [...branch.source_span_ids].sort(),
    })).sort((left, right) => left.branch_id.localeCompare(right.branch_id));
    expect(reorderedSemanticSpan).toEqual(semanticSpan);
    expect(branchSemantics(reorderedRule)).toEqual(branchSemantics(rule));
    expect(checkTargetCompilerInvariants(
      reorderedSelectors,
      hydrateSemanticSourcePlan(reordered, fixture.manifest),
      fixture.manifest,
      reordered,
    )).toEqual([]);
  });

  test.each([
    ["omits later members", (fixture: ReturnType<typeof multiBranchSamplingFixture>) => fixture.branchSpanIds[0]!],
    ["attributes the semantic to another evidence source", (fixture: ReturnType<typeof multiBranchSamplingFixture>) => fixture.itemWhole],
  ])("sampling source invariant still rejects a compiler output that %s", (_label, driftSpan) => {
    const fixture = multiBranchSamplingFixture();
    const persisted = compileTargetSelectorsPersisted(fixture.selectors, fixture.registry, fixture.manifest);
    const drifted = structuredClone(persisted);
    const rule = drifted.shared_sampling_rules![0]!;
    drifted.semantic_evidence!.find((node) => node.semantic_id === rule.source_semantic_id)!.span_id = driftSpan(fixture);
    expect(checkTargetCompilerInvariants(
      fixture.selectors,
      hydrateSemanticSourcePlan(drifted, fixture.manifest),
      fixture.manifest,
      drifted,
    )).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "compiler_sampling_source_semantic_member_mismatch",
        owner: "compiler_invariant_violation",
      }),
    ]));
  });

  test("sampling ownership is not inferred from display-field overlap", () => {
    const f = samplingFixture();
    f.selectors.sampling_rules[0]!.complete_span_ids = [f.narrow];
    const other = structuredClone(f.selectors.items[0]!);
    other.key = "other";
    other.name = "另一检查项目";
    other.fields.name.span_ids = [f.minimum];
    other.sampling = {status:"fallback",rule_key:"",branch_keys:[],quantity_span_ids:[],script_span_ids:[],condition_span_ids:[],reason:"独立事项不采用该抽样规则",confidence:1};
    f.selectors.items.push(other);
    const plan = compileTargetSelectors(f.selectors,f.registry,f.manifest);
    const codes = () => validateSemanticDraft(plan,f.manifest).issues.map(i=>i.code);
    expect(codes()).not.toContain("semantic_context_emitted_as_item");
    const item = plan.acceptance_items.find(i=>i.name===other.name)!;
    item.field_bindings.name.composition = "verbatim";
    expect(codes()).not.toContain("semantic_context_emitted_as_item");
    item.field_bindings.name.composition = "semantic_summary";
    item.name = item.field_bindings.name.source_fragments[0]!.text;
    item.field_bindings.name.value_sha256 = sha256Text(item.name);
    expect(codes()).not.toContain("semantic_context_emitted_as_item");
  });
  test.skipIf(!existsSync(join(replayRevision, "evidence", "evidence.json")))(
    "replays 7e688 with an actionable whole-source replacement before compilation",
    async () => {
    const [manifest, registry, selectors] = await Promise.all([
      readFile(join(replayRevision, "evidence", "evidence.json"), "utf8").then(JSON.parse),
      readFile(join(replayRevision, "source-span-registry.json"), "utf8").then(JSON.parse),
      readFile(join(replayRevision, "target-selectors.json"), "utf8").then(JSON.parse),
    ]);
    const torque = selectors.sampling_rules.find((rule: { key: string }) => rule.key === "rule-appendix-b-torque");
    const wholeSourceId = "span:81520ca3c44e3d2ac25e8765cd8d6900";
    const expectedReplacementIds = [
      ...torque.complete_span_ids.filter((spanId: string) => spanId !== wholeSourceId),
      ...torque.branches.flatMap((branch: { minimum_span_ids: string[]; script_span_ids: string[]; condition_span_ids: string[] }) => [
        ...branch.minimum_span_ids,
        ...branch.script_span_ids,
        ...branch.condition_span_ids,
      ]),
      ...torque.shared_conditions.flatMap((condition: { span_ids: string[] }) => condition.span_ids),
    ];

    expect(() => compileTargetSelectors(selectors, registry, manifest)).toThrowError(
      expect.objectContaining({
        issues: expect.arrayContaining([
          expect.objectContaining({
            code: "selector_sampling_complete_span_overbroad",
            path: "/sampling_rules/0/complete_span_ids",
            details: expect.objectContaining({
              full_source_span_ids: [wholeSourceId],
              allowed_replacement_span_ids: expect.arrayContaining(expectedReplacementIds),
              required_action: "replace_complete_span_ids_with_registered_rule_components",
            }),
          }),
        ]),
      }) as TargetSelectorCompileError,
    );
    },
  );

  test.skipIf(!existsSync(join(e2bbRevision6, "evidence", "evidence.json")))(
    "allows the e2bb revision-6 exact inline-sampling fanout",
    async () => {
      const [manifest, registry, selectors] = await Promise.all([
        readFile(join(e2bbRevision6, "evidence", "evidence.json"), "utf8").then(JSON.parse),
        readFile(join(e2bbRevision6, "source-span-registry.json"), "utf8").then(JSON.parse),
        readFile(join(e2bbRevision6, "working.target-selectors.json"), "utf8").then(JSON.parse),
      ]);
      const persisted = compileTargetSelectorsPersisted(selectors, registry, manifest);
      const plan = hydrateSemanticSourcePlan(persisted, manifest);
      const issues = classifySelectorIssues(
        "compiler-invariant",
        checkTargetCompilerInvariants(selectors, plan, manifest, persisted),
      );

      expect(issues.filter((issue) => issue.code === "compiler_semantic_context_emitted_as_item"))
        .toEqual([]);
    },
  );

  test.skipIf(!existsSync(join(gb50576WeldingRevision1, "evidence", "evidence.json")))(
    "allows the GB50576 welding replay's shared explicit quantity with one receiver-specific condition",
    async () => {
      const [manifest, registry, selectors] = await Promise.all([
        readFile(join(gb50576WeldingRevision1, "evidence", "evidence.json"), "utf8").then(JSON.parse),
        readFile(join(gb50576WeldingRevision1, "source-span-registry.json"), "utf8").then(JSON.parse),
        readFile(join(gb50576WeldingRevision1, "working.target-selectors.json"), "utf8").then(JSON.parse),
      ]);
      const sharedExplicitQuantity = selectors.items
        .filter((item: { sampling: { status: string } }) => item.sampling.status === "explicit")
        .flatMap((item: {
          key: string;
          sampling: { quantity_span_ids: string[]; script_span_ids: string[]; condition_span_ids: string[] };
        }) => item.sampling.quantity_span_ids.map((spanId) => ({ item, spanId })))
        .find(({ spanId, item }: {
          spanId: string;
          item: { sampling: { condition_span_ids: string[] } };
        }) => (
          item.sampling.condition_span_ids.length > 0
          && selectors.items.filter((candidate: {
            sampling: { status: string; quantity_span_ids: string[]; script_span_ids: string[] };
          }) => (
            candidate.sampling.status === "explicit"
            && candidate.sampling.quantity_span_ids.includes(spanId)
            && candidate.sampling.script_span_ids.includes(spanId)
          )).length > 1
        ));
      expect(sharedExplicitQuantity).toBeDefined();

      const persisted = compileTargetSelectorsPersisted(selectors, registry, manifest);
      const receivingRules = (persisted.shared_sampling_rules ?? []).filter((rule) => (
        rule.branches.some((branch) => branch.source_span_ids.includes(sharedExplicitQuantity!.spanId))
      ));
      expect(receivingRules).toHaveLength(2);
      expect(new Set(receivingRules.flatMap((rule) => rule.receiving_item_ids)).size).toBe(2);

      const plan = hydrateSemanticSourcePlan(persisted, manifest);
      expect(checkTargetCompilerInvariants(selectors, plan, manifest, persisted).filter((issue) => (
        issue.code === "compiler_semantic_context_emitted_as_item"
      ))).toEqual([]);
    },
  );

  test.skipIf(!existsSync(join(gb50576FastenerRevision1, "evidence", "evidence.json")))(
    "allows the GB50576 fastener replay's shared quantity across distinct explicit methods",
    async () => {
      const [manifest, registry, selectors] = await Promise.all([
        readFile(join(gb50576FastenerRevision1, "evidence", "evidence.json"), "utf8").then(JSON.parse),
        readFile(join(gb50576FastenerRevision1, "source-span-registry.json"), "utf8").then(JSON.parse),
        readFile(join(gb50576FastenerRevision1, "working.target-selectors.json"), "utf8").then(JSON.parse),
      ]);
      const persisted = compileTargetSelectorsPersisted(selectors, registry, manifest);
      const plan = hydrateSemanticSourcePlan(persisted, manifest);

      expect(validateSemanticDraft(plan, manifest).issues.filter((issue) => (
        issue.code === "semantic_context_emitted_as_item"
      ))).toEqual([]);
    },
  );

  test.skipIf(!existsSync(join(gb50576CurtainWallRevision1, "evidence", "evidence.json")))(
    "allows the GB50576 curtain-wall replay's shared explicit quantity with distinct methods",
    async () => {
      const [manifest, registry, selectors] = await Promise.all([
        readFile(join(gb50576CurtainWallRevision1, "evidence", "evidence.json"), "utf8").then(JSON.parse),
        readFile(join(gb50576CurtainWallRevision1, "source-span-registry.json"), "utf8").then(JSON.parse),
        readFile(join(gb50576CurtainWallRevision1, "working.target-selectors.json"), "utf8").then(JSON.parse),
      ]);
      const persisted = compileTargetSelectorsPersisted(selectors, registry, manifest);
      const plan = hydrateSemanticSourcePlan(persisted, manifest);

      expect(checkTargetCompilerInvariants(selectors, plan, manifest, persisted).filter((issue) => (
        issue.code === "compiler_semantic_context_emitted_as_item"
      ))).toEqual([]);
    },
  );

  test("keeps sampling ownership out of compiler invariants while retaining source-span structure checks", () => {
    const source: ImmutableTextSource = {
      source_id: "atom:explicit-component-fanout",
      evidence_id: "atom:explicit-component-fanout",
      atom_id: "atom:explicit-component-fanout",
      text: "甲项应合格。乙项应合格。适用于复验。每批抽2件。",
    };
    const manifest = manifestForSources([source]);
    const registered = registerQuotes(manifest, [source], [
      { evidence_id: source.evidence_id, quote: "甲项应合格。" },
      { evidence_id: source.evidence_id, quote: "乙项应合格。" },
      { evidence_id: source.evidence_id, quote: "适用于复验。" },
      { evidence_id: source.evidence_id, quote: "每批抽2件。" },
    ]);
    const id = (quote: string) => registered.ids.get(`${source.evidence_id}\0${quote}`)!;
    const full = registered.registry.spans.find((span) => (
      span.evidence_id === source.evidence_id && span.start === 0 && span.end === source.text.length
    ))!.span_id;
    const quantity = id("每批抽2件。");
    const condition = id("适用于复验。");
    const selectors = initialTargetSelectorPlan(manifest);
    selectors.lots.push({ key: "lot", name: "检验批 lot", scope_span_ids: [full], reason: "完整范围 fixture" });
    const explicitItem = (key: string, criterion: string, conditionSpanIds: string[]) => ({
      key,
      lot_key: "lot",
      name: `验收项目 item ${key}`,
      category: "主控项目" as const,
      criterion_span_ids: [criterion],
      continuation_span_ids: [],
      fields: {
        name: { composition: "semantic_summary" as const, span_ids: [criterion], separator: "" as const, reason: "项目名 fixture" },
        requirement: { composition: "verbatim" as const, span_ids: [criterion], separator: "" as const, reason: "验收要求 fixture" },
        method: { composition: "not_applicable" as const, span_ids: [], separator: "" as const, reason: "无独立方法 fixture" },
        quantity: { composition: "verbatim" as const, span_ids: [quantity], separator: "" as const, reason: "共同抽样数量 fixture" },
        note: { composition: "not_applicable" as const, span_ids: [], separator: "" as const, reason: "无备注 fixture" },
      },
      table: null,
      inspection_data_type: "counting" as const,
      inspection_data_type_reason: "形成抽样计数记录 fixture",
      inspection_data_type_span_ids: [criterion],
      sampling: {
        status: "explicit" as const,
        rule_key: "",
        branch_keys: [],
        quantity_span_ids: [quantity],
        script_span_ids: [quantity],
        condition_span_ids: conditionSpanIds,
        reason: "显式抽样 fixture",
        confidence: 1,
      },
      reason: "独立验收项 fixture",
    });
    selectors.items.push(
      explicitItem("first", id("甲项应合格。"), []),
      explicitItem("second", id("乙项应合格。"), [condition]),
    );

    const persisted = compileTargetSelectorsPersisted(selectors, registered.registry, manifest);
    const plan = hydrateSemanticSourcePlan(persisted, manifest);
    expect(validateSemanticDraft(plan, manifest).issues.filter((issue) => (
      issue.code === "semantic_context_emitted_as_item"
    ))).toEqual([]);
    expect(checkTargetCompilerInvariants(selectors, plan, manifest, persisted).filter((issue) => (
      issue.code === "compiler_semantic_context_emitted_as_item"
    ))).toEqual([]);

    const nodeDrift = structuredClone(persisted);
    const conditionedRule = nodeDrift.shared_sampling_rules!.find((rule) => (
      rule.branches.some((branch) => (branch.conditions ?? []).length > 0)
    ))!;
    nodeDrift.semantic_evidence!.find((node) => (
      node.semantic_id === conditionedRule.source_semantic_id
    ))!.span_id = selectors.items[0]!.criterion_span_ids[0]!;
    const nodeDriftPlan = hydrateSemanticSourcePlan(nodeDrift, manifest);
    expect(checkTargetCompilerInvariants(selectors, nodeDriftPlan, manifest, nodeDrift)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "compiler_sampling_source_semantic_member_mismatch",
          owner: "compiler_invariant_violation",
        }),
      ]),
    );

    const drifted = structuredClone(persisted);
    drifted.acceptance_items[0]!.field_bindings.quantity.source_span_ids.push(condition);
    const driftedPlan = hydrateSemanticSourcePlan(drifted, manifest);
    expect(validateSemanticDraft(driftedPlan, manifest).issues.map((issue) => issue.code))
      .not.toContain("semantic_context_emitted_as_item");
    expect(checkTargetCompilerInvariants(selectors, driftedPlan, manifest, drifted).map((issue) => issue.code))
      .not.toContain("compiler_semantic_context_emitted_as_item");
  });

  test("does not reject a field because a declared sampling interval has a different receiver", () => {
    const fixture = samplingFixture();
    fixture.selectors.sampling_rules[0]!.complete_span_ids = [fixture.narrow];
    const nonreceiver = structuredClone(fixture.selectors.items[0]!);
    nonreceiver.key = "nonreceiver";
    nonreceiver.name = "非接收项目";
    nonreceiver.criterion_span_ids = [fixture.minimum];
    nonreceiver.fields.name.span_ids = [fixture.minimum];
    nonreceiver.fields.requirement.span_ids = [fixture.minimum];
    nonreceiver.inspection_data_type_span_ids = [fixture.minimum];
    nonreceiver.sampling = {
      status: "fallback",
      rule_key: "",
      branch_keys: [],
      quantity_span_ids: [],
      script_span_ids: [],
      condition_span_ids: [],
      reason: "该项目不接收共享抽样规则 fixture",
      confidence: 1,
    };
    fixture.selectors.items.push(nonreceiver);

    try {
      compileTargetSelectors(fixture.selectors, fixture.registry, fixture.manifest);
    } catch (error) {
      expect((error as TargetSelectorCompileError).issues.map((issue) => issue.code))
        .not.toContain("selector_sampling_source_projected_to_nonreceiver_item");
    }
  });

  test("does not reject a field using another item's explicit sampling interval", () => {
    const fixture = samplingFixture();
    fixture.selectors.sampling_rules = [];
    const receiver = fixture.selectors.items[0]!;
    receiver.fields.quantity = {
      composition: "verbatim",
      span_ids: [fixture.minimum],
      separator: "",
      reason: "显式抽样数量 fixture",
    };
    receiver.sampling = {
      status: "explicit",
      rule_key: "",
      branch_keys: [],
      quantity_span_ids: [fixture.minimum],
      script_span_ids: [fixture.script],
      condition_span_ids: [],
      reason: "项目内显式抽样 fixture",
      confidence: 1,
    };
    const nonreceiver = structuredClone(receiver);
    nonreceiver.key = "nonreceiver";
    nonreceiver.name = "非接收项目";
    nonreceiver.sampling = {
      status: "fallback",
      rule_key: "",
      branch_keys: [],
      quantity_span_ids: [],
      script_span_ids: [],
      condition_span_ids: [],
      reason: "该项目不接收显式抽样区间 fixture",
      confidence: 1,
    };
    fixture.selectors.items.push(nonreceiver);

    try {
      compileTargetSelectors(fixture.selectors, fixture.registry, fixture.manifest);
    } catch (error) {
      expect((error as TargetSelectorCompileError).issues.map((issue) => issue.code))
        .not.toContain("selector_sampling_source_projected_to_nonreceiver_item");
    }
  });

  test("allows a declared sampling envelope to fan out across all explicit receivers", () => {
    const fixture = samplingFixture();
    fixture.selectors.sampling_rules[0]!.complete_span_ids = [fixture.narrow];
    const source = fixture.manifest.evidence[0]!;
    const preciseMethod = locateAndRegisterSourceQuote(
      fixture.registry,
      {
        source_id: source.evidence_id,
        evidence_id: source.evidence_id,
        atom_id: source.evidence_id,
        text: source.text,
      },
      "进行复验",
    );
    fixture.registry = preciseMethod.registry;
    fixture.selectors.sampling_rules[0]!.branches[0]!.components
      .find((component) => component.role === "method")!.span_ids = [preciseMethod.spans[0]!.span_id];
    const first = fixture.selectors.items[0]!;
    first.fields.quantity = {
      composition: "verbatim",
      span_ids: [fixture.minimum],
      separator: "",
      reason: "共享规则数量 fixture",
    };
    const second = structuredClone(first);
    second.key = "second-receiver";
    second.name = "第二接收项目";
    fixture.selectors.items.push(second);

    const persisted = compileTargetSelectorsPersisted(fixture.selectors, fixture.registry, fixture.manifest);
    const plan = hydrateSemanticSourcePlan(persisted, fixture.manifest);
    expect(checkTargetCompilerInvariants(fixture.selectors, plan, fixture.manifest, persisted)).toEqual([]);
  });

  test("does not infer field ownership from shared-rule branch selection", () => {
    const fixture = samplingFixture();
    fixture.selectors.sampling_rules[0]!.complete_span_ids = [fixture.narrow];
    const source = fixture.manifest.evidence[0]!;
    const branchTwoSource = locateAndRegisterSourceQuote(
      fixture.registry,
      {
        source_id: source.evidence_id,
        evidence_id: source.evidence_id,
        atom_id: source.evidence_id,
        text: source.text,
      },
      "抽样规则：",
    );
    fixture.registry = branchTwoSource.registry;
    const branchTwoSpan = branchTwoSource.spans[0]!.span_id;
    fixture.selectors.sampling_rules[0]!.branches.push({
      key: "branch-two",
      applies_to_category: "主控项目",
      components: [
        { key: "branch-two-quantity", role: "quantity", disposition: "present", span_ids: [branchTwoSpan], reason: "第二分支数量 fixture" },
        { key: "branch-two-method", role: "method", disposition: "present", span_ids: [branchTwoSpan], reason: "第二分支方法 fixture" },
        { key: "branch-two-condition", role: "branch_condition", disposition: "absent", span_ids: [], reason: "无分支条件 fixture" },
      ],
      reason: "第二抽样分支 fixture",
    });
    const first = fixture.selectors.items[0]!;
    first.fields.quantity = {
      composition: "verbatim",
      span_ids: [branchTwoSpan],
      separator: "",
      reason: "错误投影了另一分支的数量 fixture",
    };
    const second = structuredClone(first);
    second.key = "second-branch-receiver";
    second.name = "第二分支接收项";
    second.sampling.branch_keys = ["branch-two"];
    fixture.selectors.items.push(second);

    try {
      compileTargetSelectorsPersisted(fixture.selectors, fixture.registry, fixture.manifest);
    } catch (error) {
      expect((error as TargetSelectorCompileError).issues.map((issue) => issue.code))
        .not.toContain("selector_sampling_source_projected_to_nonreceiver_item");
    }
  });

  test("does not merge identical sampling text from disjoint source intervals", () => {
    const source: ImmutableTextSource = {
      source_id: "atom:repeated-sampling",
      evidence_id: "atom:repeated-sampling",
      atom_id: "atom:repeated-sampling",
      text: "每批抽8套。独立要求。每批抽8套。",
    };
    const manifest = manifestForSources([source]);
    let registry = registryWithFullSourceSpans(manifest.evidence_fingerprint, [source]);
    const quote = "每批抽8套。";
    const firstStart = source.text.indexOf(quote);
    const secondStart = source.text.lastIndexOf(quote);
    const firstRegistered = registerSourceSpan(registry, source, firstStart, firstStart + quote.length);
    registry = firstRegistered.registry;
    const secondRegistered = registerSourceSpan(registry, source, secondStart, secondStart + quote.length);
    registry = secondRegistered.registry;
    const criterionRegistered = locateAndRegisterSourceQuote(registry, source, "独立要求。");
    registry = criterionRegistered.registry;
    const full = registry.spans.find((span) => span.start === 0 && span.end === source.text.length)!.span_id;
    const criterion = criterionRegistered.spans[0]!.span_id;
    const selectors = initialTargetSelectorPlan(manifest);
    selectors.lots.push({ key: "lot", name: "检验批 lot", scope_span_ids: [full], reason: "完整范围 fixture" });
    const item = (key: string, samplingSpanId: string, receivesSampling: boolean) => ({
      key,
      lot_key: "lot",
      name: `验收项目 item ${key}`,
      category: "主控项目" as const,
      criterion_span_ids: [receivesSampling ? criterion : samplingSpanId],
      continuation_span_ids: [],
      fields: {
        name: { composition: "semantic_summary" as const, span_ids: [receivesSampling ? criterion : samplingSpanId], separator: "", reason: "项目名 fixture" },
        requirement: { composition: "verbatim" as const, span_ids: [receivesSampling ? criterion : samplingSpanId], separator: "", reason: "验收要求 fixture" },
        method: { composition: "not_applicable" as const, span_ids: [], separator: "", reason: "无方法 fixture" },
        quantity: { composition: "verbatim" as const, span_ids: [samplingSpanId], separator: "", reason: "数量 fixture" },
        note: { composition: "not_applicable" as const, span_ids: [], separator: "", reason: "无备注 fixture" },
      },
      table: null,
      inspection_data_type: "measurement" as const,
      inspection_data_type_reason: "形成数量记录 fixture",
      inspection_data_type_span_ids: [receivesSampling ? criterion : samplingSpanId],
      sampling: receivesSampling ? {
        status: "explicit" as const,
        rule_key: "",
        branch_keys: [],
        quantity_span_ids: [samplingSpanId],
        script_span_ids: [samplingSpanId],
        condition_span_ids: [],
        reason: "显式抽样 fixture",
        confidence: 1,
      } : {
        status: "fallback" as const,
        rule_key: "",
        branch_keys: [],
        quantity_span_ids: [],
        script_span_ids: [],
        condition_span_ids: [],
        reason: "不形成抽样规则 fixture",
        confidence: 1,
      },
      reason: "独立项目 fixture",
    });
    selectors.items.push(
      item("receiver", firstRegistered.span.span_id, true),
      item("disjoint-nonreceiver", secondRegistered.span.span_id, false),
    );

    const persisted = compileTargetSelectorsPersisted(selectors, registry, manifest);
    const plan = hydrateSemanticSourcePlan(persisted, manifest);
    expect(checkTargetCompilerInvariants(selectors, plan, manifest, persisted)).toEqual([]);

    const compilerMutation = structuredClone(persisted);
    compilerMutation.acceptance_items[1]!.field_bindings.quantity.source_span_ids = [
      firstRegistered.span.span_id,
    ];
    const mutatedPlan = hydrateSemanticSourcePlan(compilerMutation, manifest);
    const mutationIssues = classifySelectorIssues(
      "compiler-invariant",
      checkTargetCompilerInvariants(selectors, mutatedPlan, manifest, compilerMutation),
    );
    expect(mutationIssues.map((issue) => issue.code))
      .not.toContain("compiler_semantic_context_emitted_as_item");
  });

  test("selects the narrowest listed complete container when no whole-source binding is mixed in", () => {
    const fixture = samplingFixture();
    fixture.selectors.sampling_rules[0]!.complete_span_ids = [fixture.narrow];
    const narrowed = compileTargetSelectors(fixture.selectors, fixture.registry, fixture.manifest);
    const narrowSpan = fixture.registry.spans.find((span) => span.span_id === fixture.narrow)!;
    expect(narrowed.shared_sampling_rules[0]!.complete_source_fragment)
      .toBe(fixture.manifest.evidence[0]!.text.slice(narrowSpan.start, narrowSpan.end));

  });

  test("keeps a sole whole-source container compatible for plain text", () => {
    const fixture = samplingFixture();
    fixture.selectors.sampling_rules[0]!.complete_span_ids = [fixture.fullA];
    const wholeOnly = compileTargetSelectors(fixture.selectors, fixture.registry, fixture.manifest);
    expect(wholeOnly.shared_sampling_rules[0]!.complete_source_fragment)
      .toBe(fixture.manifest.evidence[0]!.text);
  });

  test("preserves one typed sampling rule whose members span multiple evidence atoms", () => {
    const fixture = samplingFixture(true);
    fixture.selectors.sampling_rules[0]!.complete_span_ids = [fixture.narrow];
    const persisted = compileTargetSelectorsPersisted(
      fixture.selectors,
      fixture.registry,
      fixture.manifest,
    );
    const plan = hydrateSemanticSourcePlan(persisted, fixture.manifest);

    expect(plan.shared_sampling_rules![0]!.evidence_ids).toEqual(expect.arrayContaining([
      "atom:sampling-a",
      "atom:sampling-b",
    ]));
    expect(plan.shared_sampling_rules![0]!.branches[0]).toMatchObject({
      min_sampling: "每批随机抽取8套连接副",
      script: "",
      exact_fragment: "采用轴力计逐套进行测试",
    });
    expect(validateSemanticDraft(plan, fixture.manifest).issues).toEqual([]);
    expect(checkTargetCompilerInvariants(
      fixture.selectors,
      plan,
      fixture.manifest,
      persisted,
    )).toEqual([]);
  });

  test("returns a structural branch repair contract for cross-evidence explicit sampling", () => {
    const fixture = samplingFixture(true);
    fixture.selectors.sampling_rules = [];
    fixture.selectors.items[0]!.sampling = {
      status: "explicit",
      rule_key: "",
      branch_keys: [],
      quantity_span_ids: [fixture.minimum],
      script_span_ids: [fixture.script],
      condition_span_ids: [],
      reason: "跨 evidence 的抽样决定必须改用 typed rule",
      confidence: 1,
    };

    expect(() => compileTargetSelectorsPersisted(
      fixture.selectors,
      fixture.registry,
      fixture.manifest,
    )).toThrowError(expect.objectContaining({
      issues: expect.arrayContaining([
        expect.objectContaining({
          code: "selector_explicit_sampling_cross_evidence",
          path: "/items/0/sampling",
          details: expect.objectContaining({
            item_key: "item",
            required_action: "choose_the_source_faithful_repair_option; do_not_discard_real_method_or_sampling_evidence",
            repair_options: expect.arrayContaining([
              expect.stringContaining("在 sampling_rules 声明完整 complete_span_ids"),
            ]),
            writable_paths: ["/items/0/sampling", "/sampling_rules"],
            next_tool: "stage_target_selector_draft",
            expected_structure: expect.objectContaining({ applies_when: "choosing_the_shared_rule_repair", other_items: "preserve_unchanged" }),
            do_not_create_acceptance_items_for_sampling_conditions: true,
          }),
        }),
      ]),
    }) as TargetSelectorCompileError);
  });

  test("inherits shared present components when a branch declares no local override", () => {
    const fixture = samplingFixture();
    fixture.selectors.sampling_rules[0]!.complete_span_ids = [fixture.narrow];
    const rule = fixture.selectors.sampling_rules[0]!;
    const branch = rule.branches[0]!;
    const sharedRoles = new Set(["quantity", "method"]);
    rule.components.push(...branch.components
      .filter((component) => sharedRoles.has(component.role))
      .map((component) => ({ ...component })));
    branch.components = branch.components.map((component) => sharedRoles.has(component.role)
      ? { ...component, disposition: "absent" as const, span_ids: [], reason: "本分支无更窄覆盖，继承共享成分" }
      : component);

    const persisted = compileTargetSelectorsPersisted(
      fixture.selectors,
      fixture.registry,
      fixture.manifest,
    );
    const plan = hydrateSemanticSourcePlan(persisted, fixture.manifest);
    expect(plan.acceptance_items[0]!.sampling).toMatchObject({
      min_sampling: "每批随机抽取8套连接副",
      script: "",
    });
    expect(plan.acceptance_items[0]!.sampling.applied_branches![0]!.components)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ role: "quantity", disposition: "present" }),
        expect.objectContaining({ role: "method", disposition: "present" }),
      ]));
    expect(checkTargetCompilerInvariants(
      fixture.selectors,
      plan,
      fixture.manifest,
      persisted,
    )).toEqual([]);
  });
});

describe("target selector v5 sampling components", () => {
  test("migrates only mechanically known v4 roles and reports every unknown disposition", () => {
    const fixture = samplingFixture();
    const rule = fixture.selectors.sampling_rules[0]!;
    const legacy = {
      ...fixture.selectors,
      schema_version: "target-selector-plan/v4",
      sampling_rules: [{
        key: rule.key,
        complete_span_ids: rule.complete_span_ids,
        branches: [{
          key: "branch",
          applies_to_category: "主控项目",
          minimum_span_ids: [rule.branches[0]!.components.find((component) => component.role === "quantity")!.span_ids[0]],
          script_span_ids: [rule.branches[0]!.components.find((component) => component.role === "method")!.span_ids[0]],
          condition_span_ids: [],
          reason: "历史分支 fixture",
        }],
        shared_conditions: [],
        reason: rule.reason,
      }],
    };

    const migrated = migrateTargetSelectorPlanForAuthoring(legacy);
    expect(migrated.plan.schema_version).toBe("target-selector-plan/v6");
    expect(migrated.plan.sampling_rules[0]!.branches[0]!.components).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "quantity", disposition: "present" }),
      expect.objectContaining({ role: "method", disposition: "present" }),
      expect.objectContaining({ role: "branch_condition", disposition: "absent", span_ids: [] }),
    ]));
    expect(migrated.issues).toEqual([
      expect.objectContaining({
        code: "selector_sampling_component_migration_required",
        details: expect.objectContaining({
          missing_roles: ["applicability", "acceptance_criterion", "exception", "note"],
          required_action: "stage_explicit_sampling_component_dispositions",
        }),
      }),
    ]);
  });

  test("rejects component disposition/span contradictions before semantic compilation", () => {
    const fixture = samplingFixture();
    fixture.selectors.sampling_rules[0]!.branches[0]!.components
      .find((component) => component.role === "quantity")!.span_ids = [];

    expect(() => compileTargetSelectors(fixture.selectors, fixture.registry, fixture.manifest)).toThrowError(
      expect.objectContaining({
        issues: expect.arrayContaining([
          expect.objectContaining({ code: "selector_sampling_component_binding_invalid" }),
        ]),
      }) as TargetSelectorCompileError,
    );
  });

  test("keeps shared present evidence when a branch records a local absent disposition", () => {
    const fixture = samplingFixture();
    const rule = fixture.selectors.sampling_rules[0]!;
    const branch = rule.branches[0]!;
    const method = branch.components.find((component) => component.role === "method")!;
    rule.components.push({
      key: "shared-method",
      role: "method",
      disposition: "present",
      span_ids: [...method.span_ids],
      reason: "共享执行方法 fixture",
    });
    method.disposition = "absent";
    method.span_ids = [];
    rule.complete_span_ids = [fixture.narrow];

    const compiled = compileTargetSelectors(fixture.selectors, fixture.registry, fixture.manifest) as any;
    expect(compiled.shared_sampling_rules[0].branches[0].script).toBe("");
    const plan = hydrateSemanticSourcePlan(compiled, fixture.manifest);
    expect(plan.acceptance_items[0]!.sampling.applied_branches![0]!.components).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "method", source_fragments: [expect.objectContaining({ text: "随机抽取8套连接副进行复验" })] }),
    ]));
  });

  test("uses the executable rule members when a sampling table has no separate method", () => {
    const fixture = samplingFixture();
    const method = fixture.selectors.sampling_rules[0]!.branches[0]!.components
      .find((component) => component.role === "method")!;
    method.disposition = "not_applicable";
    method.span_ids = [];
    fixture.selectors.sampling_rules[0]!.complete_span_ids = [fixture.narrow];

    const compiled = compileTargetSelectors(fixture.selectors, fixture.registry, fixture.manifest) as any;
    expect(compiled.shared_sampling_rules[0].branches[0].script).toBe("");
    expect(compiled.acceptance_items[0].sampling.script).toBe("");
    expect(compiled.acceptance_items[0].sampling.min_sampling).toBe("每批随机抽取8套连接副");
  });
});
