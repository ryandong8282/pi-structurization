import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

import { SEMANTIC_EVIDENCE_SCHEMA_VERSION, type EvidenceManifest, type SemanticSourcePlan } from "../src/contracts.js";
import {
  locateAndRegisterSourceQuote,
  type ImmutableTextSource,
  type SourceSpanRegistry,
} from "../src/source-span-registry.js";
import { checkTargetCompilerInvariants } from "../src/target-compiler-invariants.js";
import {
  compileTargetSelectors,
  migrateTargetSelectorPlanForAuthoring,
  TargetSelectorCompileError,
  type TargetSelectorPlan,
} from "../src/target-selector-compiler.js";
import { hydrateSemanticSourcePlan } from "../src/plan-hydration.js";
import { validatePlanText } from "../src/validator.js";

const fixtureRoot = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "gray-soil-selector-failure-v1");

async function json<T>(...parts: string[]): Promise<T> {
  return JSON.parse(await readFile(join(fixtureRoot, ...parts), "utf8")) as T;
}

describe("target compiler invariant ownership", () => {
  let manifest: EvidenceManifest;
  let selector: TargetSelectorPlan;
  let compiled: SemanticSourcePlan;
  let registry: SourceSpanRegistry;

  beforeAll(async () => {
    manifest = await json<EvidenceManifest>("evidence.json");
    const legacySelector = await json<TargetSelectorPlan>("attempt-3", "selector.json");
    const migration = migrateTargetSelectorPlanForAuthoring(legacySelector);
    // This invariant fixture deliberately declares the four roles that its old
    // v2 source never modeled. Production migration keeps these roles as typed
    // authoring issues and never guesses the dispositions.
    selector = migration.plan;
    selector.items.forEach((item) => {
      item.fields.name.composition = "semantic_summary";
      // 归档夹具是 2026-08-17 语言校验上线之前录下来的，模型当时用英文写理由。
      // 那份归档连同它的指纹一起被 gray-soil-selector-replay 断言，不能改磁盘内容；
      // 这里只在内存里补一个汉字，让编译越过语言校验，露出本测试真正要验的
      // scalar 角色混用不变量。
      item.inspection_data_type_reason = `归档理由：${item.inspection_data_type_reason}`;
      item.sampling.reason = `归档理由：${item.sampling.reason}`;
    });
    selector.sampling_rules.forEach((rule) => {
      rule.components.push(
        { key: `${rule.key}:applicability`, role: "applicability", disposition: "absent", span_ids: [], reason: "不变量夹具未声明独立的共享适用性成分 fixture" },
        { key: `${rule.key}:acceptance`, role: "acceptance_criterion", disposition: "absent", span_ids: [], reason: "不变量夹具未声明抽样合格判据 fixture" },
        { key: `${rule.key}:exception`, role: "exception", disposition: "absent", span_ids: [], reason: "不变量夹具未声明抽样例外 fixture" },
        { key: `${rule.key}:note`, role: "note", disposition: "absent", span_ids: [], reason: "不变量夹具未声明抽样备注 fixture" },
      );
    });
    selector.references.forEach((reference) => {
      // v2 归档时还没有 import_scope；生产迁移不能替模型猜字段，
      // 但这个固定夹具的唯一 destination 明确就是 method。
      reference.import_scope = {
        mode: "field_specific",
        allowed_fields: ["method"],
        reason: "归档夹具显式保留原有 method 引用路由",
      };
      reference.reason = `归档理由：${reference.reason}`;
    });
    registry = await json<SourceSpanRegistry>("attempt-3", "source-span-registry.json");
    try {
      compileTargetSelectors(selector, registry, manifest);
      throw new Error("expected the legacy failure fixture's scalar role pollution to fail preflight");
    } catch (error) {
      expect(error).toBeInstanceOf(TargetSelectorCompileError);
      expect((error as TargetSelectorCompileError).issues.filter((issue) => (
        issue.code === "selector_scalar_span_conflates_item_roles"
      )).map((issue) => issue.path)).toEqual(["/items/0", "/items/1"]);
    }

    const evidenceId = registry.spans.find((span) => (
      span.span_id === selector.items[0]!.criterion_span_ids[0]
    ))!.evidence_id;
    const evidence = manifest.evidence.find((record) => record.evidence_id === evidenceId)!;
    const source: ImmutableTextSource = {
      source_id: evidence.evidence_id,
      evidence_id: evidence.evidence_id,
      atom_id: evidence.evidence_id,
      text: evidence.text,
    };
    const exactSpan = (quote: string, prefix: string): string => {
      const located = locateAndRegisterSourceQuote(registry, source, quote, { prefix });
      registry = located.registry;
      return located.spans[0]!.span_id;
    };
    const repairedRoles = [
      {
        method: exactSpan(
          "检验方法: 观察检查和检查配合比试验报告。",
          "4.3.6 灰土体积比应符合设计要求。\r\n\r\n",
        ),
        quantity: exactSpan(
          "检查数量: 同一工程、同一体积比检查一次。",
          "4.3.6 灰土体积比应符合设计要求。\r\n\r\n检验方法: 观察检查和检查配合比试验报告。\r\n\r\n",
        ),
      },
      {
        method: exactSpan(
          "检验方法: 观察检查和检查质量合格证明文件。",
          "4.3.7 熟化石灰颗粒粒径不应大于 5mm；粘土（或粉质粘土、粉土）内不得含有有机物质，颗粒粒径不应大于 16mm。\r\n\r\n",
        ),
        quantity: exactSpan(
          "检查数量: 按本规范第 3.0.21 条规定的检验批检查。",
          "4.3.7 熟化石灰颗粒粒径不应大于 5mm；粘土（或粉质粘土、粉土）内不得含有有机物质，颗粒粒径不应大于 16mm。\r\n\r\n检验方法: 观察检查和检查质量合格证明文件。\r\n\r\n",
        ),
      },
      {
        method: exactSpan(
          "检验方法:按本规范表 4.1.7 中的检验方法检验。",
          "4.3.8 灰土垫层表面的允许偏差应符合本规范表 4.1.7 的规定。\r\n\r\n",
        ),
        quantity: exactSpan(
          "检查数量:按本规范第 3.0.21 条规定的检验批和第 3.0.22 条的规定检查。",
          "4.3.8 灰土垫层表面的允许偏差应符合本规范表 4.1.7 的规定。\r\n\r\n检验方法:按本规范表 4.1.7 中的检验方法检验。\r\n\r\n",
        ),
      },
    ];
    selector.items.forEach((item, itemIndex) => {
      const repaired = repairedRoles[itemIndex]!;
      item.fields.method.span_ids = [repaired.method];
      item.fields.quantity.span_ids = [repaired.quantity];
      if (item.sampling.status === "explicit") {
        item.sampling.quantity_span_ids = [repaired.quantity];
        item.sampling.script_span_ids = [repaired.quantity];
      }
    });
    compiled = hydrateSemanticSourcePlan(
      compileTargetSelectors(selector, registry, manifest),
      manifest,
    );
  });

  const codes = (plan: SemanticSourcePlan) =>
    checkTargetCompilerInvariants(selector, plan, manifest).map((issue) => issue.code);

  it("does not use sampling ownership guesses as a compiler invariant", () => {
    const authored = structuredClone(selector);
    authored.items[1]!.fields.name.span_ids = [...authored.items[0]!.fields.quantity.span_ids];
    const compact = compileTargetSelectors(authored, registry, manifest);
    const plan = hydrateSemanticSourcePlan(compact, manifest);
    const issues = () => checkTargetCompilerInvariants(authored, plan, manifest, compact).map((issue) => issue.code);
    const strictManifest = {...manifest, source:{...manifest.source,semantic_workflow:SEMANTIC_EVIDENCE_SCHEMA_VERSION}};
    expect(issues()).not.toContain("compiler_semantic_context_emitted_as_item");
    expect(validatePlanText(JSON.stringify(compact), strictManifest).issues.map((issue) => issue.code))
      .not.toContain("semantic_context_emitted_as_item");
    const item = compact.acceptance_items.find((item) => item.name === authored.items[1]!.name)!;
    item.field_bindings.name.composition = "verbatim";
    expect(issues()).not.toContain("compiler_semantic_context_emitted_as_item");
    item.field_bindings.name.composition = "semantic_summary";
    const span = registry.spans.find((span) => span.span_id === authored.items[1]!.fields.name.span_ids[0])!;
    item.name = manifest.evidence.find((e) => e.evidence_id === span.evidence_id)!.text.slice(span.start, span.end);
    expect(issues()).not.toContain("compiler_semantic_context_emitted_as_item");
    authored.items[1]!.name = item.name;
    expect(issues()).not.toContain("compiler_semantic_context_emitted_as_item");
  });

  it("detects sampling receiver derivation drift", () => {
    const changed = structuredClone(compiled);
    changed.shared_sampling_rules![0]!.receiving_item_ids = [];
    expect(codes(changed)).toContain("compiler_sampling_receiver_mismatch");
  });

  it("matches compiled sampling items to selector keys after source-order sorting", () => {
    const reorderedSelectors = {
      ...selector,
      items: [...selector.items].reverse(),
    };
    expect(checkTargetCompilerInvariants(reorderedSelectors, compiled, manifest).map((issue) => issue.code))
      .not.toContain("compiler_sampling_branch_selection_mismatch");
  });

  it("detects reference parent/materialization drift", () => {
    const changed = structuredClone(compiled);
    changed.semantic_references![0]!.anchor_semantic_id = changed.semantic_evidence![0]!.semantic_id;
    expect(codes(changed)).toContain("compiler_semantic_reference_anchor_role");
  });

  it("detects missing role-specific table evidence", () => {
    const changed = structuredClone(compiled);
    changed.acceptance_items[0]!.table_semantics = {
      source_kind: "direct",
      table_id: "table:test",
      table_no: "",
      table_title: "",
      applicability: "",
      row_path: [],
      column_path: [],
      unit: "",
      condition: "",
      allowed_value: "5mm",
      inspection_method: "",
      cell_evidence: [],
      reference_fragments: [],
    };
    expect(codes(changed)).toContain("compiler_table_property_evidence_missing");
  });

  it("detects incomplete evidence disposition derivation", () => {
    const changed = structuredClone(compiled);
    const required = manifest.evidence.find((record) => record.requires_disposition)!;
    changed.evidence_dispositions = changed.evidence_dispositions.filter((row) => row.evidence_id !== required.evidence_id);
    expect(codes(changed)).toContain("compiler_unhandled_evidence");
  });
});
