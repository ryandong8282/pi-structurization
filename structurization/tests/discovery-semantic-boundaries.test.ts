import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import { buildDocumentEvidence } from "../src/document-discovery.js";
import { compileDocumentSelectors, discoveryScopeReviewHints, initialDocumentSelectorPlan } from "../src/document-selector-compiler.js";
import { DISCOVERY_SCOPE_SEMANTICS_GUIDANCE } from "../src/discovery-semantic-guidance.js";
import { DISCOVERY_SYSTEM_PROMPT, DISCOVERY_REVIEW_SYSTEM_PROMPT } from "../src/acceptance-prompt-suite.js";
import { locateAndRegisterSourceQuote, registryWithFullSourceSpans } from "../src/source-span-registry.js";

// Replay the kind of semantic decision made in GB 50202 section 6.2. These
// shortened, synthetic requirements exercise the contract, not model accuracy.
function specialSoilFixture(chapter: number) {
  const base = "素土、灰土地基的承载力应满足设计要求。";
  const additional = "湿陷性黄土场地上的素土、灰土地基除应符合原验收要求外，尚应检验外放尺寸和垫层总厚度。";
  const organization = "组合地基处理工程应对已有地基处理和后续桩基分别验收。";
  const independent = "预浸水法的浸水坑尺寸及湿陷变形应符合设计要求。";
  const source = `## ${chapter}.2 素土、灰土地基\n${base}\n\n## ${chapter + 2}.2 湿陷性黄土\n${additional}\n${organization}\n${independent}\n`;
  const evidence = buildDocumentEvidence(source, "special-soil.md");
  const atom = evidence.atoms[0]!;
  let registry = registryWithFullSourceSpans(evidence.evidence_fingerprint, [{ source_id: atom.atom_id, atom_id: atom.atom_id, text: atom.text }]);
  const fullSpan = registry.spans[0]!.span_id;
  const locate = (quote: string) => {
    const located = locateAndRegisterSourceQuote(registry, { source_id: atom.atom_id, atom_id: atom.atom_id, text: atom.text }, quote);
    registry = located.registry;
    return located.spans[0]!.span_id;
  };
  const spans = { base: locate(base), additional: locate(additional), organization: locate(organization), independent: locate(independent) };
  const selectors = initialDocumentSelectorPlan("special-soil");
  const block = (span: string) => ({ kind: "explicit_range" as const, anchor_span_id: span, start_span_id: span, end_span_id: span, reason: "具体对象的精确主资料，不包含相邻对象或组织规则" });
  selectors.targets = [
    { key: "soil", name: "素土、灰土地基", group_key: "foundation", group_name: "地基", group_reason: "按工程组织",
      lot_basis_summary: "基本要求和特殊土附加要求", scope_span_ids: [spans.base, spans.additional], lot_basis_span_ids: [spans.base, spans.additional],
      source_blocks: [block(spans.base), block(spans.additional)], reason: "同一受检对象在特殊条件下的附加判据",
      semantic_basis: { subject: "素土、灰土地基", subject_kind: "work", acceptance_kind: "direct_criterion", acceptance_span_ids: [spans.base, spans.additional],
        acceptance_reason: "承载力以及特殊条件下的尺寸均约束该对象", boundary_reason: "多个不连续来源共同约束同一对象；预浸水法是不同方法，组织规则不是新对象" } },
    { key: "prewater", name: "预浸水法地基处理", group_key: "foundation", group_name: "地基", group_reason: "按工程组织",
      lot_basis_summary: "浸水坑与湿陷变形验收", scope_span_ids: [spans.independent], lot_basis_span_ids: [spans.independent],
      source_blocks: [block(spans.independent)], reason: "原文明确规定独立方法的验收",
      semantic_basis: { subject: "预浸水法地基处理", subject_kind: "work", acceptance_kind: "direct_criterion", acceptance_span_ids: [spans.independent],
        acceptance_reason: "浸水坑及湿陷变形为此方法的直接判据", boundary_reason: "不因为同处特殊土章节就与素土灰土地基合并" } },
  ];
  selectors.contexts = [{ key: "separate-acceptance", role: "governing_rule", name: "分别验收规则", span_ids: [spans.organization], reason: "组织关系，不另造受检对象" }];
  selectors.dispositions = [{ atom_span_id: fullSpan, disposition: "target", target_keys: ["soil", "prewater"], reason: "本原子同时含两个对象及一条组织规则" }];
  const windows = [
    { window_id: "base-window", number: `${chapter}.2`, title: "素土、灰土地基", start_line: 1, end_exclusive_line: 4 },
    { window_id: "special-window", number: `${chapter + 2}.2`, title: "湿陷性黄土", start_line: 4, end_exclusive_line: source.split("\n").length },
  ];
  return { evidence, registry, selectors, windows, spans, additional, organization };
}

describe("selector contract preserves author-chosen applicability, objects and organization", () => {
  test.each([4, 14])("replays special-soil decisions independently of chapter numbers (%i)", chapter => {
    const f = specialSoilFixture(chapter);
    const plan = compileDocumentSelectors(f.selectors, f.registry, f.evidence, "special-soil", { requireSemanticBasis: true, discoveryScopeCandidates: f.windows });
    expect(plan.targets).toHaveLength(2);
    expect(plan.targets.map(target => target.name)).toEqual(["素土、灰土地基", "预浸水法地基处理"]);
    expect(plan.targets[0]!.work_scope?.primary_fragments.map(fragment => fragment.text).join("\n")).toContain(f.additional);
    expect(plan.targets.flatMap(target => target.work_scope?.primary_fragments ?? []).map(fragment => fragment.text).join("\n")).not.toContain(f.organization);
    expect(plan.context_notes).toHaveLength(1);
    expect(discoveryScopeReviewHints(plan, f.selectors, f.evidence, f.windows)).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "target_crosses_candidate_windows", target: expect.objectContaining({ key: "soil" }) }),
    ]));
    // Consolidation never grants permission to duplicate primary ownership.
    f.selectors.targets[1]!.source_blocks.push({ kind: "explicit_range", anchor_span_id: f.spans.additional, start_span_id: f.spans.additional, end_span_id: f.spans.additional, reason: "故意重复用于反例" });
    expect(() => compileDocumentSelectors(f.selectors, f.registry, f.evidence, "special-soil", { requireSemanticBasis: true })).toThrow();
  });

  test("author and reviewer share semantics instead of forbidding cross-window evidence", async () => {
    const runtime = await readFile(new URL("../src/pi-runtime.ts", import.meta.url), "utf8");
    for (const prompt of [DISCOVERY_SYSTEM_PROMPT, DISCOVERY_REVIEW_SYSTEM_PROMPT]) {
      expect(prompt).toContain(DISCOVERY_SCOPE_SEMANTICS_GUIDANCE);
    }
    expect(runtime).not.toContain("一个 target 不得跨越多个窗口");
    expect(DISCOVERY_SCOPE_SEMANTICS_GUIDANCE).toContain("由你依当前原文判断");
    expect(DISCOVERY_SCOPE_SEMANTICS_GUIDANCE).toContain("原文版本、来源坐标、block 边界、连续覆盖及 primary 不重叠");
    // Regression fixtures above are evaluator-only, never author/reviewer hints.
    for (const leakedExample of ["50202", "6.2", "特殊土", "预浸水", "湿陷性黄土", "素土", "灰土"]) {
      expect(DISCOVERY_SCOPE_SEMANTICS_GUIDANCE).not.toContain(leakedExample);
      expect(runtime).not.toContain(leakedExample);
      expect(DISCOVERY_SYSTEM_PROMPT + DISCOVERY_REVIEW_SYSTEM_PROMPT).not.toContain(leakedExample);
    }
    expect(DISCOVERY_SCOPE_SEMANTICS_GUIDANCE).not.toContain("组织规则归 context");
  });
});
