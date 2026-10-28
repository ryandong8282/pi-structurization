import { existsSync } from "node:fs";
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
import {
  compileTargetSelectors,
  initialTargetSelectorPlan,
  TargetSelectorCompileError,
  type TargetSelectorPlan,
} from "../src/target-selector-compiler.js";
import {
  locateAndRegisterSourceQuote,
  registryWithFullSourceSpans,
  type ImmutableTextSource,
  type SourceSpanRegistry,
} from "../src/source-span-registry.js";

const replayRevision = join(
  process.cwd(),
  "data", "jobs", "20260812-161216-c005", "pi-agent", "jobs", "20260812-161216-c005",
  "targets", "target_3A056505dae2e7e713c865f3fe", "revisions", "000004",
);

const replayClauseSpanId = "span:d5d6241a933a3ef49c30fba482d7f9b3";

const displayFieldReplayRevisions = [
  join(
    process.cwd(),
    "data", "jobs", "20260812-161216-c005", "pi-agent", "jobs", "20260812-161216-c005",
    "targets", "target_3A1893310725969c77989893bb", "revisions", "000009",
  ),
  join(
    process.cwd(),
    "data", "jobs", "20260812-161216-c005", "pi-agent", "jobs", "20260812-161216-c005",
    "targets", "target_3A4be29c5eca44dc4deda45cae", "revisions", "000004",
  ),
];

const overlappingDisplayFieldReplayRevisions = [
  join(
    process.cwd(),
    "data", "jobs", "20260812-161216-c005", "pi-agent", "jobs", "20260812-161216-c005",
    "targets", "target_3A1893310725969c77989893bb", "revisions", "000010",
  ),
  join(
    process.cwd(),
    "data", "jobs", "20260812-161216-c005", "pi-agent", "jobs", "20260812-161216-c005",
    "targets", "target_3A8c4a81e09e641fa8a42f032b", "revisions", "000007",
  ),
];

const visibleMethodReplayRevision = join(
  process.cwd(),
  "data", "jobs", "20260814-091359-a3ad", "pi-agent", "jobs", "20260814-091359-a3ad",
  "targets", "target_3A218be19f0ee4910103d1387c", "revisions", "000002",
);

function manifestFor(text: string): EvidenceManifest {
  const evidenceId = "atom:same-item-scalar";
  return {
    schema_version: EVIDENCE_SCHEMA_VERSION,
    job_id: "same-item-scalar-job",
    target_id: "same-item-scalar-target",
    source: {
      adapter: "document-domain-agent/v1",
      file_name: "source.md",
      sha256: sha256Text(text),
      semantic_workflow: SEMANTIC_EVIDENCE_SCHEMA_VERSION,
    },
    scope: {
      schema_version: EVIDENCE_SCOPE_SCHEMA_VERSION,
      mode: "agent_discovered",
      target_id: "same-item-scalar-target",
      source_line_count: text.split("\n").length,
      selected_start_line: 1,
      selected_end_exclusive_line: text.split("\n").length + 1,
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
    evidence_fingerprint: sha256Text(`same-item-scalar\0${text}`),
  };
}

function registerQuotes(
  manifest: EvidenceManifest,
  quotes: string[],
): { registry: SourceSpanRegistry; ids: Map<string, string> } {
  const record = manifest.evidence[0]!;
  const source: ImmutableTextSource = {
    source_id: record.evidence_id,
    evidence_id: record.evidence_id,
    atom_id: record.evidence_id,
    text: record.text,
  };
  let registry = registryWithFullSourceSpans(manifest.evidence_fingerprint, [source]);
  const ids = new Map<string, string>();
  for (const quote of quotes) {
    const located = locateAndRegisterSourceQuote(registry, source, quote);
    registry = located.registry;
    ids.set(quote, located.spans[0]!.span_id);
  }
  return { registry, ids };
}

function addItem(
  selectors: TargetSelectorPlan,
  input: {
    criterion_span_id: string;
    method_span_id: string;
    quantity_span_id: string;
    sampling_script_span_id?: string;
    condition_span_id?: string;
  },
): void {
  selectors.items.push({
    key: "item",
    lot_key: "lot",
    name: "验收项目",
    category: "主控项目",
    criterion_span_ids: [input.criterion_span_id],
    continuation_span_ids: [],
    fields: {
      name: { composition: "semantic_summary", span_ids: [input.criterion_span_id], separator: "", reason: "验收对象" },
      requirement: { composition: "verbatim", span_ids: [input.criterion_span_id], separator: "", reason: "验收要求" },
      method: { composition: "verbatim", span_ids: [input.method_span_id], separator: "", reason: "检验方法" },
      quantity: { composition: "verbatim", span_ids: [input.quantity_span_id], separator: "", reason: "检查数量" },
      note: { composition: "not_applicable", span_ids: [], separator: "", reason: "无备注" },
    },
    table: null,
    inspection_data_type: "measurement",
    inspection_data_type_reason: "形成检查结果",
    inspection_data_type_span_ids: [input.method_span_id],
    sampling: {
      status: "explicit",
      rule_key: "",
      branch_keys: [],
      quantity_span_ids: [input.quantity_span_id],
      script_span_ids: [input.sampling_script_span_id ?? input.quantity_span_id],
      condition_span_ids: input.condition_span_id ? [input.condition_span_id] : [],
      reason: "项内明确规定抽样",
      confidence: 1,
    },
    reason: "独立验收判断",
  });
}

describe("same-item scalar role granularity", () => {
  test.runIf(existsSync(replayRevision))(
    "rejects the real 056 rev4 clause reused across requirement, method, quantity, and sampling",
    async () => {
      const [manifest, registry, selectors] = await Promise.all([
        readFile(join(replayRevision, "evidence", "evidence.json"), "utf8").then(JSON.parse) as Promise<EvidenceManifest>,
        readFile(join(replayRevision, "source-span-registry.json"), "utf8").then(JSON.parse) as Promise<SourceSpanRegistry>,
        readFile(join(replayRevision, "working.target-selectors.json"), "utf8").then(JSON.parse) as Promise<TargetSelectorPlan>,
      ]);

      try {
        compileTargetSelectors(selectors, registry, manifest);
        throw new Error("expected same-item scalar role conflation to fail preflight");
      } catch (error) {
        expect(error).toBeInstanceOf(TargetSelectorCompileError);
        const issues = (error as TargetSelectorCompileError).issues.filter((issue) => (
          issue.code === "selector_scalar_span_conflates_item_roles"
        ));
        expect(issues).toHaveLength(1);
        const details = issues[0]!.details as {
          offending_binding: { span_id: string };
          affected_paths: string[];
          contained_role_bindings: Array<{ role: string; relation: string }>;
          registered_subspan_candidates: Array<{ span_id: string }>;
          required_action: string;
        };
        expect(details.offending_binding.span_id).toBe(replayClauseSpanId);
        expect(details.affected_paths).toEqual([
          "/items/1/fields/quantity/span_ids/0",
          "/items/1/sampling/quantity_span_ids/0",
          "/items/1/sampling/script_span_ids/0",
        ]);
        expect(details.contained_role_bindings).toEqual(expect.arrayContaining([
          expect.objectContaining({ role: "field:requirement", relation: "equal" }),
          expect.objectContaining({ role: "field:method", relation: "equal" }),
        ]));
        expect(details.registered_subspan_candidates.map((entry) => entry.span_id)).toEqual(
          expect.arrayContaining([
            "span:76bfe4afef035f0b2253c381773eec7d",
            "span:887057b5ab6729aa109911317aa6cb8d",
            "span:a4821e9f74375b0dd9794f8164e6af32",
          ]),
        );
        expect(details.required_action).toBe("replace_scalar_bindings_with_exact_role_spans");
      }
    },
  );

  test("rejects a scalar container that strictly contains bound criterion and method regions", () => {
    const criterion = "构件不得有缺陷。";
    const quantity = "每批抽查五件。";
    const method = "使用量具检查。";
    const text = `${criterion}\n${quantity}\n${method}`;
    const manifest = manifestFor(text);
    const registered = registerQuotes(manifest, [criterion, quantity, method]);
    const fullSpanId = registered.registry.spans.find((span) => (
      span.start === 0 && span.end === text.length
    ))!.span_id;
    const selectors = initialTargetSelectorPlan(manifest);
    selectors.lots.push({ key: "lot", name: "检验批 lot", scope_span_ids: [fullSpanId], reason: "单项范围" });
    addItem(selectors, {
      criterion_span_id: registered.ids.get(criterion)!,
      method_span_id: registered.ids.get(method)!,
      quantity_span_id: fullSpanId,
    });

    expect(() => compileTargetSelectors(selectors, registered.registry, manifest)).toThrowError(
      expect.objectContaining({
        issues: expect.arrayContaining([
          expect.objectContaining({ code: "selector_scalar_span_conflates_item_roles" }),
        ]),
      }),
    );
  });

  test("rejects one exact span reused as both visible method and quantity", () => {
    const criterion = "构件不得有缺陷。";
    const quantity = "检查数量:全数检查。";
    const method = "检验方法:观察检查。";
    const combined = `${quantity}\n${method}`;
    const text = `${criterion}\n${combined}`;
    const manifest = manifestFor(text);
    const registered = registerQuotes(manifest, [criterion, combined, quantity, method]);
    const fullSpanId = registered.registry.spans.find((span) => (
      span.start === 0 && span.end === text.length
    ))!.span_id;
    const selectors = initialTargetSelectorPlan(manifest);
    selectors.lots.push({ key: "lot", name: "检验批 lot", scope_span_ids: [fullSpanId], reason: "单项范围" });
    addItem(selectors, {
      criterion_span_id: registered.ids.get(criterion)!,
      method_span_id: registered.ids.get(combined)!,
      quantity_span_id: registered.ids.get(combined)!,
    });

    try {
      compileTargetSelectors(selectors, registered.registry, manifest);
      throw new Error("expected a display-field role conflict");
    } catch (error) {
      expect(error).toBeInstanceOf(TargetSelectorCompileError);
      const issue = (error as TargetSelectorCompileError).issues.find(row => row.code === "selector_display_field_span_role_conflict") as any;
      expect(issue).toMatchObject({
        message: expect.stringMatching(/[\u3400-\u9fff]/),
        details: {
          required_action: "locate_exact_method_and_quantity_spans_and_replace_conflicting_fields",
          actual: expect.objectContaining({ item_key: "item", roles: ["method", "quantity"] }),
          candidate_spans: expect.arrayContaining([
            expect.objectContaining({ span_id: registered.ids.get(quantity), exact_fragment: quantity }),
            expect.objectContaining({ span_id: registered.ids.get(method), exact_fragment: method }),
          ]),
          candidate_read_tools: expect.arrayContaining(["read_target_selectors", "open_evidence", "locate_evidence_span"]),
          next_tool: "read_target_selectors",
          save_tool: "stage_target_selector_draft",
          writable_paths: expect.arrayContaining([
            "/items/0/fields/method/span_ids/0",
            "/items/0/fields/quantity/span_ids/0",
          ]),
          how_to_pass: expect.stringContaining("candidate_spans"),
        },
      });
    }
  });

  test("rejects a visible requirement span that contains exact quantity and method regions", () => {
    const criterion = "构件不得有缺陷。";
    const quantity = "检查数量:全数检查。";
    const method = "检验方法:观察检查。";
    const text = `${criterion}\n${quantity}\n${method}`;
    const manifest = manifestFor(text);
    const registered = registerQuotes(manifest, [criterion, quantity, method]);
    const fullSpanId = registered.registry.spans.find((span) => (
      span.start === 0 && span.end === text.length
    ))!.span_id;
    const selectors = initialTargetSelectorPlan(manifest);
    selectors.lots.push({ key: "lot", name: "检验批 lot", scope_span_ids: [fullSpanId], reason: "单项范围" });
    addItem(selectors, {
      criterion_span_id: registered.ids.get(criterion)!,
      method_span_id: registered.ids.get(method)!,
      quantity_span_id: registered.ids.get(quantity)!,
    });
    selectors.items[0]!.fields.requirement.span_ids = [fullSpanId];

    expect(() => compileTargetSelectors(selectors, registered.registry, manifest)).toThrow(TargetSelectorCompileError);
    try {
      compileTargetSelectors(selectors, registered.registry, manifest);
    } catch (error) {
      const issue = (error as TargetSelectorCompileError).issues.find((entry) => (
        entry.code === "selector_display_field_span_role_overlap"
      ))!;
      const affectedPaths = [
        "/items/0/fields/requirement/span_ids/0",
        "/items/0/fields/method/span_ids/0",
      ];
      expect(issue).toMatchObject({
        message: "逐字判据的来源区间与其他可见字段角色部分重叠，或包含了已经分配给检验方法的来源文字；精确的检查数量子区间可以保留在完整判据原句内。",
        details: {
          item_key: selectors.items[0]!.key,
          affected_paths: affectedPaths,
          writable_paths: affectedPaths,
          candidate_read_tool: "read_target_selectors",
          candidate_read_tools: ["read_target_selectors", "open_evidence", "locate_evidence_span"],
          next_tool: "read_target_selectors",
          next_tool_arguments: { collection: "items", key: selectors.items[0]!.key },
          next_tools: ["read_target_selectors", "open_evidence", "locate_evidence_span", "stage_target_selector_draft"],
          save_tool: "stage_target_selector_draft",
          replacement_constraints: {
            affected_paths_only: affectedPaths,
            complete_requirement_may_contain_exact_quantity_subspan: true,
            no_text_length_or_heading_heuristic: true,
          },
        },
      });
      expect(issue.details).not.toHaveProperty("replacement_span_ids");
      expect(issue.details).not.toHaveProperty("answer");
      expect(issue.details).not.toHaveProperty("canonical_quantity");
      expect(issue.message).not.toMatch(/[A-Za-z]/u);
    }
  });

  test("rejects a visible method container when a bound quantity proves separable roles", () => {
    const requirement = "构件表面应洁净。";
    const quantity = "抽查五件。";
    const method = "观察检查。";
    const combined = `${requirement}\n${quantity}\n${method}`;
    const manifest = manifestFor(combined);
    const registered = registerQuotes(manifest, [requirement, quantity, method]);
    const fullSpanId = registered.registry.spans.find((span) => (
      span.start === 0 && span.end === combined.length
    ))!.span_id;
    const selectors = initialTargetSelectorPlan(manifest);
    selectors.lots.push({ key: "lot", name: "检验批 lot", scope_span_ids: [fullSpanId], reason: "单项范围" });
    addItem(selectors, {
      criterion_span_id: fullSpanId,
      method_span_id: fullSpanId,
      quantity_span_id: registered.ids.get(quantity)!,
    });

    expect(() => compileTargetSelectors(selectors, registered.registry, manifest)).toThrowError(
      expect.objectContaining({
        issues: expect.arrayContaining([
          expect.objectContaining({ code: "selector_method_span_conflates_display_roles" }),
        ]),
      }),
    );

    selectors.items[0]!.fields.method.span_ids = [registered.ids.get(method)!];
    selectors.items[0]!.fields.requirement.span_ids = [registered.ids.get(requirement)!];
    expect(() => compileTargetSelectors(selectors, registered.registry, manifest)).not.toThrow();
  });

  test.runIf(existsSync(join(visibleMethodReplayRevision, "working.target-selectors.json")))(
    "rejects the real 218 rev2 method container with an exact quantity child",
    async () => {
      const [manifest, registry, selectors] = await Promise.all([
        readFile(join(visibleMethodReplayRevision, "evidence", "evidence.json"), "utf8").then(JSON.parse) as Promise<EvidenceManifest>,
        readFile(join(visibleMethodReplayRevision, "source-span-registry.json"), "utf8").then(JSON.parse) as Promise<SourceSpanRegistry>,
        readFile(join(visibleMethodReplayRevision, "working.target-selectors.json"), "utf8").then(JSON.parse) as Promise<TargetSelectorPlan>,
      ]);
      const itemIndex = selectors.items.findIndex((item) => item.key === "node-and-member-surface-cleanliness");
      expect(itemIndex).toBeGreaterThanOrEqual(0);
      const polluted = structuredClone(selectors);
      const item = polluted.items[itemIndex]!;
      const quantitySpanId = item.fields.quantity.span_ids[0] ?? item.sampling.quantity_span_ids[0];
      const quantitySpan = registry.spans.find((span) => span.span_id === quantitySpanId)!;
      const container = registry.spans.filter((span) => (
        span.evidence_id === quantitySpan.evidence_id
        && span.start <= quantitySpan.start
        && span.end >= quantitySpan.end
        && (span.start < quantitySpan.start || span.end > quantitySpan.end)
      )).sort((left, right) => (
        (left.end - left.start) - (right.end - right.start)
        || left.start - right.start
      ))[0]!;
      expect(container).toBeDefined();
      item.fields.requirement = {
        composition: "verbatim",
        span_ids: [container.span_id],
        separator: "",
        reason: "构造完整条文容器回放",
      };
      item.fields.method = {
        composition: "verbatim",
        span_ids: [container.span_id],
        separator: "",
        reason: "构造把数量子句混入可见方法的回放",
      };
      try {
        compileTargetSelectors(polluted, registry, manifest);
        throw new Error("expected the visible method container to fail preflight");
      } catch (error) {
        expect(error).toBeInstanceOf(TargetSelectorCompileError);
        const issues = (error as TargetSelectorCompileError).issues.filter((issue) => (
          issue.code === "selector_method_span_conflates_display_roles"
        ));
        expect(issues).toHaveLength(1);
        expect(issues[0]).toMatchObject({
          path: `/items/${itemIndex}`,
          details: {
            item_key: "node-and-member-surface-cleanliness",
            affected_paths: expect.arrayContaining([
              `/items/${itemIndex}/fields/method/span_ids/0`,
            ]),
          },
        });
      }
    },
  );

  test.runIf(displayFieldReplayRevisions.every(existsSync))(
    "rejects the real 189 rev9 and 4be rev4 method-quantity display copies",
    async () => {
      const issues = [];
      for (const revision of displayFieldReplayRevisions) {
        const [manifest, registry, selectors] = await Promise.all([
          readFile(join(revision, "evidence", "evidence.json"), "utf8").then(JSON.parse) as Promise<EvidenceManifest>,
          readFile(join(revision, "source-span-registry.json"), "utf8").then(JSON.parse) as Promise<SourceSpanRegistry>,
          readFile(join(revision, "target-selectors.json"), "utf8").then(JSON.parse) as Promise<TargetSelectorPlan>,
        ]);
        try {
          compileTargetSelectors(selectors, registry, manifest);
          throw new Error("expected display-field span role conflicts to fail preflight");
        } catch (error) {
          expect(error).toBeInstanceOf(TargetSelectorCompileError);
          issues.push(...(error as TargetSelectorCompileError).issues.filter((issue) => (
            issue.code === "selector_display_field_span_role_conflict"
          )));
        }
      }

      expect(issues).toHaveLength(20);
      expect(issues.every((issue) => {
        const details = issue.details as { roles?: string[] };
        return details.roles?.join(",") === "method,quantity";
      })).toBe(true);
    },
  );

  test.runIf(overlappingDisplayFieldReplayRevisions.every(existsSync))(
    "rejects the real 189 rev10 and 8c4 rev7 visible requirement role overlaps",
    async () => {
      const issues = [];
      for (const revision of overlappingDisplayFieldReplayRevisions) {
        const [manifest, registry, selectors] = await Promise.all([
          readFile(join(revision, "evidence", "evidence.json"), "utf8").then(JSON.parse) as Promise<EvidenceManifest>,
          readFile(join(revision, "source-span-registry.json"), "utf8").then(JSON.parse) as Promise<SourceSpanRegistry>,
          readFile(join(revision, "target-selectors.json"), "utf8").then(JSON.parse) as Promise<TargetSelectorPlan>,
        ]);
        try {
          compileTargetSelectors(selectors, registry, manifest);
          throw new Error("expected visible display-field overlaps to fail preflight");
        } catch (error) {
          expect(error).toBeInstanceOf(TargetSelectorCompileError);
          issues.push(...(error as TargetSelectorCompileError).issues.filter((issue) => (
            issue.code === "selector_display_field_span_role_overlap"
          )));
        }
      }

      expect(issues).toHaveLength(27);
      expect(issues.every((issue) => {
        const details = issue.details as { conflicting_role_pairs?: string[][] };
        return details.conflicting_role_pairs?.every(([left, right]) => (
          left === "requirement" && (right === "method" || right === "quantity")
        ));
      })).toBe(true);
    },
  );

  test("allows one long exact quantity span reused by inline sampling quantity and script", () => {
    const criterion = "构件不得有缺陷。";
    const quantity = `每批按约定方案抽查：${"独立数量条件".repeat(600)}。`;
    const method = "使用量具检查。";
    const text = `${criterion}\n${quantity}\n${method}`;
    const manifest = manifestFor(text);
    const registered = registerQuotes(manifest, [
      criterion,
      quantity,
      "每批按约定方案抽查：",
      method,
    ]);
    const fullSpanId = registered.registry.spans.find((span) => (
      span.start === 0 && span.end === text.length
    ))!.span_id;
    const selectors = initialTargetSelectorPlan(manifest);
    selectors.lots.push({ key: "lot", name: "检验批 lot", scope_span_ids: [fullSpanId], reason: "单项范围" });
    addItem(selectors, {
      criterion_span_id: registered.ids.get(criterion)!,
      method_span_id: registered.ids.get(method)!,
      quantity_span_id: registered.ids.get(quantity)!,
    });

    expect(() => compileTargetSelectors(selectors, registered.registry, manifest)).not.toThrow();
  });

  test("does not treat criterion and requirement sharing as a scalar role conflict", () => {
    const criterion = "构件不得有缺陷。";
    const quantity = "每批抽查五件。";
    const method = "使用量具检查。";
    const text = `${criterion}\n${quantity}\n${method}`;
    const manifest = manifestFor(text);
    const registered = registerQuotes(manifest, [criterion, quantity, method]);
    const fullSpanId = registered.registry.spans.find((span) => (
      span.start === 0 && span.end === text.length
    ))!.span_id;
    const selectors = initialTargetSelectorPlan(manifest);
    selectors.lots.push({ key: "lot", name: "检验批 lot", scope_span_ids: [fullSpanId], reason: "单项范围" });
    addItem(selectors, {
      criterion_span_id: registered.ids.get(criterion)!,
      method_span_id: registered.ids.get(method)!,
      quantity_span_id: registered.ids.get(quantity)!,
    });

    expect(() => compileTargetSelectors(selectors, registered.registry, manifest)).not.toThrow();
  });

  test("allows a complete sampling condition to contain the item's acceptance action", () => {
    const criterion = "采用扭矩法或转角法进行终拧。";
    const condition = `对所有未完成处理的连接副应${criterion}`;
    const quantity = "按节点数抽查百分之十。";
    const method = "观察检查。";
    const text = `${condition}\n${quantity}\n${method}`;
    const manifest = manifestFor(text);
    const registered = registerQuotes(manifest, [condition, criterion, quantity, method]);
    const fullSpanId = registered.registry.spans.find((span) => (
      span.start === 0 && span.end === text.length
    ))!.span_id;
    const selectors = initialTargetSelectorPlan(manifest);
    selectors.lots.push({ key: "lot", name: "检验批 lot", scope_span_ids: [fullSpanId], reason: "单项范围" });
    addItem(selectors, {
      criterion_span_id: registered.ids.get(criterion)!,
      method_span_id: registered.ids.get(method)!,
      quantity_span_id: registered.ids.get(quantity)!,
      condition_span_id: registered.ids.get(condition)!,
    });

    expect(() => compileTargetSelectors(selectors, registered.registry, manifest)).not.toThrow();
  });
});
