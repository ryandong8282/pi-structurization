import { expect, test } from "vitest";
import { actionableSelectorIssue } from "../src/tools.js";
import { selectorPatchReceipt } from "../src/selector-feedback.js";
import type { TargetSelectorPlan } from "../src/target-selector-compiler.js";
import { ensureActionableIssue } from "../src/actionable-error.js";

const selectors = { items: [{ key: "other", sampling: null }, { key: "wanted", sampling: { status: "fallback" } }],
  lots: [], sampling_rules: [], references: [], source_dispositions: [] } as unknown as TargetSelectorPlan;

test("collection diagnostics report actual counts without embedding every saved record", () => {
  const items = Array.from({ length: 200 }, (_, index) => ({ key: `item-${index}`, name: "现有项目",
    reason: "记录正文".repeat(200), fields: {} }));
  const selectors = { items } as unknown as TargetSelectorPlan;
  const result = actionableSelectorIssue({ code: "selector_table_expansion_obligations_pending", path: "/items",
    details: { unresolved_row_count: 2, next_tool: "open_evidence", next_tool_arguments: { evidence_id: "evidence:pending-row", cursor: 0 },
      how_to_pass: "核对实际数据行并保存完整 item，再重检。" } }, selectors) as any;
  expect(result.actual).toEqual({ collection: "items", record_count: 200, records_read_tool: "read_target_selectors" });
  expect(result).toMatchObject({ next_tool: "open_evidence", next_tool_arguments: { evidence_id: "evidence:pending-row", cursor: 0 },
    details: { unresolved_row_count: 2 } });
  expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThan(4096);
  expect(JSON.stringify(result)).not.toContain("记录正文");
  expect(selectors.items).toEqual(items);
});

test("normalization preserves producer repair facts even without required_action", () => {
  const details = { item_key: "wanted", actual: null, expected: { type: "object" },
    writable_path: "/items/1/sampling", how_to_pass: "提供完整抽样结构。",
    next_tool: "read_target_selectors", next_tool_arguments: { collection: "items", key: "wanted" } };
  const normalized = ensureActionableIssue({ code: "example", path: "/items/1/sampling", message: "缺少结构。", details });
  expect(normalized.details).toEqual({ ...details, required_action: "缺少结构。" });
  expect(actionableSelectorIssue(normalized, selectors)).toMatchObject({ actual: null,
    how_to_pass: details.how_to_pass, writable_path: details.writable_path, next_tool_arguments: details.next_tool_arguments });
  expect(details).not.toHaveProperty("required_action");
});

test.each([null, ["a"], "literal"])("non-object diagnostic payloads retain their actual value: %s", details => {
  expect(ensureActionableIssue({ code: "example", path: "/", message: "不符。", details }).details)
    .toEqual({ actual: details, required_action: "不符。" });
});

test("feedback resolves stable author identity before array position and supplies an executable read", () => {
  const issue = { code: "example", path: "/items/0/sampling", message: "抽样结构不符。",
    details: { item_key: "wanted", writable_collection: "items", how_to_pass: "修正抽样结构。" } };
  const result = actionableSelectorIssue(issue, selectors) as any;
  expect(result).toMatchObject({ path: "/items/0/sampling", writable_path: "/items/1/sampling",
    record_identity: { collection: "items", key: "wanted" }, actual: { status: "fallback" },
    next_tool: "read_target_selectors", next_tool_arguments: { collection: "items", key: "wanted" },
    save_tool: "stage_target_selector_draft", how_to_pass: "修正抽样结构。" });
  expect(issue.path).toBe("/items/0/sampling");
});

test.each([null, false, 0, ""])("feedback preserves the actual value %s supplied by its producer", actual => {
  const result = actionableSelectorIssue({ code: "example", path: "/items/0/sampling", details: { actual } }, selectors) as any;
  expect(result.actual).toBe(actual);
});

test("unknown identities and compiled paths do not manufacture current values or writable locations", () => {
  const result = actionableSelectorIssue({ code: "example", path: "/acceptance_items/4/min_sampling",
    message: "需要来源依据。" }, selectors) as any;
  expect(result).not.toHaveProperty("actual");
  expect(result).not.toHaveProperty("writable_path");
  expect(result).not.toHaveProperty("save_tool");
  expect(result).toMatchObject({ actual_unavailable: true, next_tool: "get_target_selector_contract", next_tool_arguments: {} });
  const stale = actionableSelectorIssue({ code: "example", path: "/items/0/sampling", details: { item_key: "deleted" } }, selectors) as any;
  expect(stale).not.toHaveProperty("actual");
  expect(stale).not.toHaveProperty("record_identity");
});

test("producer-provided source-reading routes and explicit actual facts take precedence", () => {
  const result = actionableSelectorIssue({ code: "example", path: "/items/1/sampling", details: {
    actual: { receipt_missing: true }, next_tool: "read_reference_facts", next_tool_arguments: { target_key: "reference" },
  } }, selectors) as any;
  expect(result).toMatchObject({ actual: { receipt_missing: true }, next_tool: "read_reference_facts",
    next_tool_arguments: { target_key: "reference" }, record_identity: { collection: "items", key: "wanted" } });
});

test("duplicate author keys cannot be presented as a unique read address", () => {
  const duplicate = { ...selectors, items: [selectors.items[0], selectors.items[0]] } as TargetSelectorPlan;
  const result = actionableSelectorIssue({ code: "example", path: "/items/1/sampling" }, duplicate) as any;
  expect(result.actual).toBeNull();
  expect(result).not.toHaveProperty("record_identity");
  expect(result).not.toHaveProperty("record_read");
});

test("sampling_rule_key is preserved as the stable owner of a reordered rule", () => {
  const draft = { ...selectors, sampling_rules: [{ key: "other-rule", reason: "other" }, { key: "wanted-rule", reason: "wanted" }] } as unknown as TargetSelectorPlan;
  const issue = actionableSelectorIssue({ code: "example", path: "/sampling_rules/0/reason",
    details: { sampling_rule_key: "wanted-rule" } }, draft) as any;
  expect(issue).toMatchObject({ actual: "wanted", writable_path: "/sampling_rules/1/reason",
    record_read: { tool: "read_target_selectors", arguments: { collection: "sampling_rules", key: "wanted-rule" } } });
});

test("batch receipts list every submitted key, not only faulty records, and keep deletion intent", () => {
  const args = { operation: "upsert", collection: "items", remove_keys: ["old"],
    draft: { items: [{ key: "first" }, { key: "second" }], source_dispositions: [{ span_ids: ["s1"] }] } };
  const receipt = selectorPatchReceipt(args, "not_applied");
  expect(receipt).toEqual({ status: "not_applied", operation: "upsert", remove_keys: ["old"], remove_collection: "items",
    collections: [
      { collection: "items", submitted_keys: ["first", "second"], unkeyed_record_paths: [] },
      { collection: "source_dispositions", submitted_keys: [], unkeyed_record_paths: ["/draft/source_dispositions/0"] },
    ] });
  expect(selectorPatchReceipt({ operation: "replace_collection", draft: { items: [] } }, "saved"))
    .toMatchObject({ status: "saved", operation: "replace_collection", collections: [{ collection: "items", submitted_keys: [] }] });
});
