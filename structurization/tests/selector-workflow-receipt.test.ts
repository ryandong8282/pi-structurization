import { describe, expect, test } from "vitest";
import { selectorDiagnosticToolResponse, selectorFieldDiagnostic } from "../src/selector-diagnostics.js";
import { TARGET_SELECTOR_PROTOCOLS, TARGET_SELECTOR_SYSTEM_PROMPT, LIFECYCLE_PROTOCOL,
  targetSelectorStartupPrompt, targetCompletedContinuationPrompt, preflightContinuationPrompt } from "../src/acceptance-prompt-suite.js";
import { ACCEPTANCE_TOOL_DESCRIPTIONS } from "../src/acceptance-tool-text.js";
import { FEEDBACK_ACTIONS } from "../src/acceptance-feedback-text.js";

describe("author work and whole request contract", () => {
  test("one current diagnostic supplies the next action without repeating its large body or losing paging", () => {
    const issue = { code: "selector_neutral_reference_incomplete", path: "/references/0/components", message: "虚构温控规程的引用组件待处置。",
      actual: { unresolved_count: 67 }, expected: "write_source_grounded_component_decisions", writable_paths: ["/references/0"],
      record_identity: { key: "temperature-reference" }, record_read: { tool: "read_target_selectors", arguments: { collection: "references", key: "temperature-reference" } },
      details: { source_access: Array.from({ length: 18 }, (_, i) => ({ evidence_id: `neutral-e-${i}`, target_key: "neutral-ref-target", read_tool: "read_reference_facts" })) },
      diagnostic_arrays_complete: false,
      diagnostic_array_pages: [{ path: "/related_information/source_access", total_count: 67, returned_count: 18, remaining_count: 49,
        next_page: { next_tool: "get_target_context", next_tool_arguments: { diagnostic_detail_cursor: 18 } } }],
      diagnostic_array_instruction: "复制下一页参数，只读完整诊断。" };
    const diagnostic = selectorFieldDiagnostic(issue);
    const response = { ok: true, saved_records: { items: [{ key: "repaired-item", text: "只确认保存身份。" }] },
      local_validation: { ok: true, issue_count: 0, deferred_nonlocal_issue_count: 2,
        deferred_issues: [issue, { code: "selector_sampling_decision_pending", path: "/items/1/sampling/status", message: "另一虚构项仍待决定。", actual: "pending" }],
        deferred_issue_page: { reported_issue_count: 2, total_issue_count: 2 } },
      selector_repair_work: { diagnostic, remaining_diagnostic_count: 2, record_read: issue.record_read,
        diagnostic_read: { tool: "get_target_context", arguments: { field_diagnostic_cursor: 0 } } } };
    const before = JSON.stringify(response);
    const delivered = selectorDiagnosticToolResponse(response) as any;
    expect(JSON.stringify(response)).toBe(before);
    expect(delivered).toMatchObject({ next_tool: "read_target_selectors", next_tool_arguments: issue.record_read.arguments });
    expect(delivered.local_validation.deferred_issues[0]).toMatchObject({ diagnostic_id: diagnostic.diagnostic_id,
      diagnostic_ref: "/selector_repair_work/diagnostic" });
    expect(delivered.local_validation.deferred_issues[0]).not.toHaveProperty("related_information");
    expect(delivered.selector_repair_work.diagnostic.actual).toEqual(issue.actual);
    expect(delivered.selector_repair_work.diagnostic.writable_paths).toEqual(issue.writable_paths);
    expect(delivered.selector_repair_work.diagnostic.diagnostic_array_pages).toEqual(issue.diagnostic_array_pages);
    expect(delivered.local_validation.deferred_issues[1]).toMatchObject({ actual: "pending" });
    expect(delivered.local_validation.deferred_issue_page).toMatchObject({ reported_issue_count: 2, total_issue_count: 2 });
    expect(delivered.local_validation.deferred_issue_page.reported_issue_utf8_bytes).toBe(Buffer.byteLength(JSON.stringify(delivered.local_validation.deferred_issues[0])) + Buffer.byteLength(JSON.stringify(delivered.local_validation.deferred_issues[1])));
    expect(JSON.stringify(delivered).split('"source_access":').length - 1).toBe(1);
  });

  test("system, complete user protocol, startup, continuation, tools and save feedback share one lifecycle", () => {
    expect(TARGET_SELECTOR_PROTOCOLS.lifecycle).toBe(LIFECYCLE_PROTOCOL);
    expect(TARGET_SELECTOR_SYSTEM_PROMPT).toContain(LIFECYCLE_PROTOCOL);
    const startup = targetSelectorStartupPrompt({ job_id: "neutral-workflow", target_id: "neutral-target", resume: true,
      recovering_coverage_failure: false, current_selector_state: "inherited_existing",
      inherited_stage_retry: { stage: "sampling", best_stage_rank: 1, best_issue_count: 2, consecutive_non_improvements: 3 } });
    const continuation = targetCompletedContinuationPrompt({ stage: "sampling", current_work: { code: "neutral_pending" } });
    const preflight = preflightContinuationPrompt({ state: "current", navigation: { next_tool: "read_target_selectors" } });
    const pack = [TARGET_SELECTOR_SYSTEM_PROMPT, ...Object.values(TARGET_SELECTOR_PROTOCOLS), startup, continuation, preflight,
      ACCEPTANCE_TOOL_DESCRIPTIONS.advance_target_selector_stage!, ACCEPTANCE_TOOL_DESCRIPTIONS.commit_target_selector_draft!, FEEDBACK_ACTIONS.saved_local_ok];
    for (const text of pack) expect(text).not.toContain("已知同组");
    expect(startup).toContain("当前作者待办清空");
    expect(LIFECYCLE_PROTOCOL).toContain("不消耗其次数，也不清零已有计数");
    expect(TARGET_SELECTOR_PROTOCOLS.diagnostics).toContain("deferred 表示未触及作者记录");
    expect(TARGET_SELECTOR_PROTOCOLS.diagnostics).toContain("diagnostic_ref");
    expect(ACCEPTANCE_TOOL_DESCRIPTIONS.advance_target_selector_stage).toContain("next_stage不是当前阶段");
  });
});
