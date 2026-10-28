import { describe, expect, test } from "vitest";
import { rm } from "node:fs/promises";

import type { EvidenceManifest } from "../src/contracts.js";
import {
  COVERAGE_REPAIR_DELTA_KINDS,
  buildCoverageRepairWorklist,
} from "../src/tools.js";
import {
  TARGET_SELECTOR_SYSTEM_PROMPT,
  targetSelectorStartupPrompt,
} from "../src/pi-runtime.js";
import { LEGACY_COVERAGE_PROTOCOL, TARGET_SELECTOR_PROTOCOLS } from "../src/acceptance-prompt-suite.js";
import { buildSelectorStageScenario } from "./selector-stage-fixture.js";

function manifest(): EvidenceManifest {
  return {
    evidence: [{
      evidence_id: "e-gap",
      kind: "prose",
      role: "acceptance_clause",
      locator: "line:100",
      text: "示例验收条文，应符合规定。检查数量：全数检查。检验方法：观察检查。",
      text_sha256: "fixture",
      requires_disposition: true,
      evidence_scope: "primary",
      clause_id: "x.y.z",
    }],
  } as unknown as EvidenceManifest;
}

describe("coverage repair semantic compiler handoff", () => {
  test("an unmapped semantic gap explicitly permits a new evidence-backed selector item", () => {
    const worklist = buildCoverageRepairWorklist({
      findings: [{
        finding_id: "gap:missing-leaf",
        finding_type: "semantic_coverage_gap",
        evidence_id: "e-gap",
        exact_fragment: "示例验收条文，应符合规定。",
        affected_item_ids: [],
        description: "Source acceptance meaning has no materialized leaf.",
        reason: "The independent reviewer found an uncovered judgment.",
      }],
    }, manifest(), []);

    expect(worklist).toHaveLength(1);
    expect(worklist[0]).toMatchObject({
      finding_id: "gap:missing-leaf",
      evidence_id: "e-gap",
      new_item_allowed: true,
      required_decision: "compile_to_minimal_selector_delta",
      selector_bindings: [],
    });
    expect((worklist[0]?.source_resource as Record<string, unknown>)?.clause_id).toBe("x.y.z");
    expect(worklist[0]?.allowed_delta_kinds).toContain("add_new_item");
    expect(COVERAGE_REPAIR_DELTA_KINDS).toContain("bind_reference");
    expect(COVERAGE_REPAIR_DELTA_KINDS).toContain("bind_sampling");
  });

  test("a mapped gap preserves the current selector as a starting point without making it semantic authority", () => {
    const binding = {
      finding_ids: ["gap:update-leaf"],
      final_item_id: "final:item:1",
      reference_origin_item_id: "item:1",
      selector_key: "item:1",
      selector_path: "/items/0",
      current_span_ids: ["span:1"],
      mapping_status: "mapped",
    };
    const worklist = buildCoverageRepairWorklist({
      findings: [{
        finding_id: "gap:update-leaf",
        finding_type: "semantic_coverage_gap",
        evidence_id: "e-gap",
        exact_fragment: "示例验收条文，应符合规定。",
        affected_item_ids: ["final:item:1"],
        description: "Existing leaf lost a source condition.",
        reason: "Repair the source-backed meaning.",
      }],
    }, manifest(), [binding]);

    expect(worklist).toHaveLength(1);
    expect(worklist[0]?.new_item_allowed).toBe(false);
    expect(worklist[0]?.selector_bindings).toEqual([binding]);
    expect(String(worklist[0]?.instruction)).toContain("opened immutable evidence");
  });

  test("coverage-repair prompts tell the model to compile findings rather than wait for a pre-existing path", () => {
    expect(LEGACY_COVERAGE_PROTOCOL).toContain("durable review");
    expect(LEGACY_COVERAGE_PROTOCOL).toContain("缺项无现存 item 映射时允许有据最小新增修复");
    expect(TARGET_SELECTOR_PROTOCOLS.reference_routes).toContain("import_scope.allowed_fields 不扩大");
    // Per-occurrence authoritative routes remain in the real review/leaf
    // contract (covered by coverage-review-v4), rather than every author system.
    expect(TARGET_SELECTOR_SYSTEM_PROMPT).toContain("get_target_selector_contract");
    const startup = targetSelectorStartupPrompt({
      job_id: "job",
      target_id: "target",
      recovering_coverage_failure: true,
      resume: true,
      current_selector_state: "current_existing",
      current_selector_checkpoint: "unvalidated_draft",
    });
    expect(startup).toContain("读取绑定的 read_coverage_review");
    expect(startup).toContain("只修有据 findings");
    expect(startup).toContain("真实缺项可新增");
    expect(startup).toContain("保留其他记录");
    expect(startup).toContain("不启动新的常规 Coverage 流程");
  });

  test("the actual sampling contract distinguishes source precedence from field conditions", async () => {
    const { workspace, controller } = await buildSelectorStageScenario([
      "# 2 虚构器件", "", "## 2.1 连接完整性", "",
      "2.1.1 接口应完整。检验方法：观察。检验数量：全数检查。", "",
    ].join("\n"));
    try {
      const contract = await controller.dispatch("get_target_selector_contract", {});
      const protocols = contract.authoring_protocols as typeof TARGET_SELECTOR_PROTOCOLS;
      expect(protocols.sampling).toBe(TARGET_SELECTOR_PROTOCOLS.sampling);
      expect(protocols.sampling).toContain("根据实际对象和条件选择最具体的适用抽样规则");
      expect(protocols.sampling).toMatch(/本地规则与默认规则的选源先后.*不是两个现场业务条件/);
      expect(protocols.sampling).toMatch(/不得.*本地.*默认.*捏造条件分支/);
      expect(protocols.sampling).toContain("不把本地规则覆盖后不再适用的默认规则并用");
    } finally {
      await rm(workspace.root, { recursive: true, force: true });
    }
  });

  test("sampling, method, workflow and applicability alone never manufacture an acceptance judgment", () => {
    const authorPolicy = [TARGET_SELECTOR_SYSTEM_PROMPT, ...Object.values(TARGET_SELECTOR_PROTOCOLS)].join("\n");
    const supportingRoleRule = authorPolicy.split(/[。\n]/u).find(sentence =>
      ["抽样", "方法", "流程", "适用条件"].every(role => sentence.includes(role))
      && /(?:不能|不得|不生成|不形成|不制造|不创建).*(?:验收叶|验收项|独立判断)/u.test(sentence));
    expect(supportingRoleRule, "supporting roles must not create their own acceptance leaf").toBeDefined();
  });
});
