import { describe, expect, test } from "vitest";

import {
  coalesceFieldBindingDiagnostics,
  coalesceReferenceToolDiagnostics,
  coalesceSelectorIssueDiagnostics,
  coalesceUnhandledEvidenceDiagnostics,
} from "../src/selector-issue-diagnostics.js";
import { selectorIssueToolPage } from "../src/tools.js";

describe("selector issue diagnostics", () => {
  test("shares source-disposition recipes without losing actual evidence, routes or raw counts", () => {
    const source = Array.from({ length: 33 }, (_, index) => {
      const actual = { evidence_ids: [`e:${index}`], candidate_spans: [{ span_id: `s:${index}`, evidence_id: `e:${index}`, start: 0, end: index + 1 }], reference_anchor_bindings: [] };
      const args = { evidence_id: `e:${index}`, cursor: index };
      return { code: "compiler_unhandled_evidence", path: "/source_dispositions", owner: "selector_input_error", actual,
        details: { actual, evidence_ids: actual.evidence_ids, candidate_span_ids: [`s:${index}`],
          source_access: [{ evidence_id: `e:${index}`, read_tool: "open_evidence", tool_arguments: args }],
          next_tool: "open_evidence", next_tool_arguments: args, tool_argument_hints: { open_evidence: args },
          writable_paths: ["/items", "/source_dispositions"], required_action: "bind_or_explain_source",
          how_to_pass: "按实际原文选择字段接收者或非业务处置，保留可写路径外的正确记录。".repeat(40),
          repair_identity: { kind: "evidence_id", values: actual.evidence_ids } } };
    });
    const before = structuredClone(source);
    const grouped = coalesceUnhandledEvidenceDiagnostics(source) as any[];
    expect(grouped).toHaveLength(3);
    expect(grouped.flatMap(issue => issue.details.members ?? [issue.details]).map(member => member.actual)).toEqual(source.map(issue => issue.actual));
    expect(grouped.flatMap(issue => issue.details.members ?? [issue.details]).map(member => member.source_access[0].tool_arguments)).toEqual(source.map(issue => issue.details.next_tool_arguments));
    const page = selectorIssueToolPage(source);
    expect(page.page).toMatchObject({ raw_issue_count: 33, diagnostic_group_count: 3, remaining_issue_count: 0 });
    expect(Buffer.byteLength(JSON.stringify(grouped))).toBeLessThan(Buffer.byteLength(JSON.stringify(source)) / 2);
    expect(coalesceUnhandledEvidenceDiagnostics(grouped)).toEqual(grouped);
    expect(source).toEqual(before);
    const changed = structuredClone(source.slice(0, 2));
    changed[1]!.details.how_to_pass = "不同的通过条件不能归并。";
    expect(coalesceUnhandledEvidenceDiagnostics(changed)).toHaveLength(2);
    changed[1]!.details.how_to_pass = changed[0]!.details.how_to_pass;
    changed[1]!.details.next_tool = "read_reference_facts";
    expect(coalesceUnhandledEvidenceDiagnostics(changed)).toHaveLength(2);
  });

  test("reference tool feedback groups repeated destinations without changing progress diagnostics", () => {
    const source = [0, 1, 2].map(index => ({ code: "reference_origin_relation", path: `/references/0/destinations/${index}/item_key`, message: "来源缺失",
      details: { occurrence_id: "occurrence:a", item_id: "item:a", origin_evidence_ids: ["e:a"], writable_path: "/items/0/fields", writable_paths: ["/items/0/fields", `/references/0/destinations/${index}/item_key`] },
      how_to_pass: "读取来源后补正确字段", next_tool: "stage_target_selector_draft" }));
    const before = structuredClone(source);
    const result = coalesceReferenceToolDiagnostics(source) as typeof source;
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ details: { original_issue_count: 3, affected_paths: source.map(x=>x.path), writable_paths: expect.arrayContaining(source.map(x=>x.path)) } });
    expect(source).toEqual(before);
    expect(coalesceSelectorIssueDiagnostics(source)).toEqual(source);
    expect(coalesceReferenceToolDiagnostics(result)).toEqual(result);
    const page = selectorIssueToolPage(source);
    expect(page.issues).toEqual(result);
    expect(page.page).toMatchObject({ raw_issue_count: 3, diagnostic_group_count: 1,
      reported_issue_count: 1, total_issue_count: 1, remaining_issue_count: 0, count_unit: "diagnostic_group" });
    expect(page.page.count_note).toContain("不是独立业务错误数");
    expect(selectorIssueToolPage(result).page.raw_issue_count).toBe(3);
    expect(source).toEqual(before);
  });

  test("pagination counts undisplayed diagnostic groups separately from raw checks", () => {
    const source = Array.from({ length: 35 }, (_, i) => ({ code: "source_problem", path: `/items/${i}`, message: "来源未绑定" }));
    expect(selectorIssueToolPage(source).page).toMatchObject({ raw_issue_count: 35, diagnostic_group_count: 35,
      reported_issue_count: 32, remaining_issue_count: 3, count_unit: "diagnostic_group" });
    expect(selectorIssueToolPage([]).page).toMatchObject({ raw_issue_count: 0, diagnostic_group_count: 0, remaining_issue_count: 0 });
    const page = selectorIssueToolPage(source);
    expect(page.page.index_complete).toBe(true);
    expect(page.page.issue_index).toHaveLength(35);
    expect(page.page.issue_index[34]).toMatchObject({ code: "source_problem", path: "/items/34", detail_in_page: false });
    const large = selectorIssueToolPage(Array.from({ length: 1000 }, (_, i) => ({ code: "problem", path: `/items/${i}`, message: "核对来源" })));
    expect(large.page.index_complete).toBe(false);
    expect(Buffer.byteLength(JSON.stringify(large.page.issue_index))).toBeLessThanOrEqual(16 * 1024 + 256);
  });

  test("shares one repair explanation across receivers of the exact same source without merging decisions", () => {
    const routes = [{ path: "/references/0", occurrence_id: "reference:shared", target_span_ids: ["span:source"],
      destination_snapshot: [0, 1, 2, 3, 4, 5].map(i => ({ item_key: `receiver-${i}`, target_fields: ["note"] })) }];
    const source = [0, 1, 2, 3, 4, 5].map(i => ({ code: "field_binding_relation", path: `/items/${i}/fields/note/span_ids/0`,
      message: "来源尚未关联", owner: "selector_input_error", details: {
        affected_item_key: `receiver-${i}`, affected_field: "note",
        actual: { item_key: `receiver-${i}`, evidence_id: "evidence:shared", span_id: "span:shared", start: 0, end: 100 },
        matching_reference_routes: routes.map(route => ({ ...route, matching_destination_indexes: [i] })),
        local_evidence_ids: [`evidence:local-${i}`], required_action: "verify_source_applicability",
        allowed_actions: ["repair_route", "remove_only_inapplicable_span"], how_to_pass: "按原文分别判断适用性，不预设结论。".repeat(100),
        next_tool: "open_evidence", next_tool_arguments: { evidence_id: "evidence:shared", cursor: 0 },
        save_tool: "stage_target_selector_draft", writable_path: `/items/${i}/fields/note`,
      } }));
    const before = structuredClone(source);
    const page = selectorIssueToolPage(source);
    expect(page.page).toMatchObject({ raw_issue_count: 6, diagnostic_group_count: 1 });
    const issue = page.issues[0] as any;
    expect(issue.details.affected_item_keys).toEqual(source.map(x => x.details.affected_item_key));
    expect(issue.details.members).toHaveLength(6);
    expect(issue.details.members[5]).toMatchObject({ actual: source[5]!.details.actual,
      local_evidence_ids: ["evidence:local-5"], matching_reference_destinations: [{ path: "/references/0", matching_destination_indexes: [5] }] });
    expect(Buffer.byteLength(JSON.stringify(page.issues))).toBeLessThan(Buffer.byteLength(JSON.stringify(source)) / 2);
    expect(source).toEqual(before);
    expect(selectorIssueToolPage(page.issues).page.raw_issue_count).toBe(6);
    const different = structuredClone(source);
    different[5]!.details.next_tool = "read_reference_facts";
    expect(selectorIssueToolPage(different).page.diagnostic_group_count).toBe(2);
    different[4]!.details.actual.end = 99;
    expect(selectorIssueToolPage(different).page.diagnostic_group_count).toBe(3);
    different[3]!.details.next_tool_arguments.cursor = 10;
    expect(selectorIssueToolPage(different).page.diagnostic_group_count).toBe(4);
    const malformed = structuredClone(source[0]) as any;
    malformed.details.matching_reference_routes = [null];
    expect(() => selectorIssueToolPage([malformed])).not.toThrow();
  });

  test("reference feedback retains every receiver and cannot swallow another occurrence or field error", () => {
    const issue = (occurrence: string, item: string, code = "reference_import_scope_exceeded") => ({ code, path: "/references/0/import_scope/allowed_fields", message: "导入超范围",
      details: { occurrence_id: occurrence, item_id: item, allowed_fields: ["requirement"], imported_fields: ["name", "requirement"], outside_import_scope: ["name"] } });
    const source = [issue("a", "one"), issue("a", "one"), issue("a", "two"), issue("b", "one"), issue("a", "one", "field_binding_relation")];
    const result = coalesceReferenceToolDiagnostics(source);
    expect(result).toHaveLength(3);
    expect(result[0]).toMatchObject({ details: { original_issue_count: 3, receiver_imports: [expect.objectContaining({ item_id: "one" }), expect.objectContaining({ item_id: "two" })] } });
    expect(result.slice(1)).toEqual(source.slice(3));
  });

  test("reference feedback preserves distinct field failures even on the same receiver", () => {
    const issue = (field: string) => ({ code: "reference_import_scope_exceeded", path: "/references/0/import_scope/allowed_fields",
      details: { occurrence_id: "a", item_id: "one", allowed_fields: ["requirement"], imported_fields: [field], outside_import_scope: [field] } });
    const result = coalesceReferenceToolDiagnostics([issue("name"), issue("sampling"), issue("name")]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ details: { original_issue_count: 3, receiver_imports: [
      { item_id: "one", imported_fields: ["name"], outside_import_scope: ["name"] },
      { item_id: "one", imported_fields: ["sampling"], outside_import_scope: ["sampling"] },
    ] } });
  });

  test("groups repeated field-binding spans without repeating the common repair route", () => {
    const howToPass = "先核对当前 span 的不可变原文，再依据现有引用关系选择作者修复路径。".repeat(300);
    const route = [{
      path: "/references/2",
      key: "shared-reference",
      occurrence_id: "occurrence:shared",
      target_span_ids: ["span:target"],
      import_scope: { mode: "field_specific", allowed_fields: ["requirement"] },
      destination_snapshot: [
        { destination_index: 0, item_key: "receiver", target_fields: ["requirement"] },
      ],
      matching_destination_indexes: [0],
    }];
    const routeWithDifferentPropertyOrder = [{
      matching_destination_indexes: [0],
      destination_snapshot: [
        { target_fields: ["requirement"], item_key: "receiver", destination_index: 0 },
      ],
      import_scope: { allowed_fields: ["requirement"], mode: "field_specific" },
      target_span_ids: ["span:target"],
      occurrence_id: "occurrence:shared",
      key: "shared-reference",
      path: "/references/2",
    }];
    const source = Array.from({ length: 12 }, (_, index) => {
      const path = `/items/0/fields/requirement/span_ids/${index}`;
      return {
        code: "field_binding_relation",
        path,
        message: "该字段来源尚未关联到当前字段",
        owner: "selector_input_error",
        details: {
          affected_item_key: "receiver",
          affected_field: "requirement",
          matching_reference_routes: index % 2 === 0 ? route : routeWithDifferentPropertyOrder,
          required_action: "verify_then_repair_only_this_source",
          allowed_actions: ["repair_reference_route", "remove_only_this_span"],
          how_to_pass: howToPass,
          actual: {
            span_id: `span:bad-${index}`,
            evidence_id: `evidence:bad-${index}`,
            start: index,
            end: index + 1,
          },
          writable_path: path,
          writable_paths: [path, "/references"],
          writable_collections: ["items", "references"],
          candidate_read_tools: ["open_evidence", "read_target_selectors"],
          next_tool: "open_evidence",
          next_tool_arguments: { evidence_id: `evidence:bad-${index}`, cursor: 0 },
          next_tools: ["open_evidence", "read_target_selectors", "stage_target_selector_draft"],
          save_tool: "stage_target_selector_draft",
          do_not_edit: "不可变原文",
        },
      };
    });
    const before = structuredClone(source);
    const grouped = coalesceFieldBindingDiagnostics(source) as any[];
    const page = selectorIssueToolPage(source);
    const surfaced = page.issues[0] as any;
    const serialized = JSON.stringify(surfaced);

    expect(grouped).toHaveLength(1);
    expect(page.issues).toHaveLength(1);
    expect(surfaced).toMatchObject({
      code: "field_binding_relation",
      details: {
        original_issue_count: 12,
        original_issue_codes: source.map((issue) => issue.code),
        original_issue_paths: source.map((issue) => issue.path),
        matching_reference_routes: route,
        members: source.map((issue, index) => ({
          code: issue.code,
          path: issue.path,
          actual: issue.details.actual,
          writable_path: issue.path,
          writable_paths: [issue.path, "/references"],
          next_tool_arguments: { evidence_id: `evidence:bad-${index}`, cursor: 0 },
        })),
      },
      required_action: "verify_then_repair_only_this_source",
      allowed_actions: ["repair_reference_route", "remove_only_this_span"],
      next_tool: "open_evidence",
      save_tool: "stage_target_selector_draft",
    });
    expect((serialized.match(/matching_reference_routes/gu) ?? [])).toHaveLength(1);
    expect(serialized.split(howToPass)).toHaveLength(2);
    expect(Buffer.byteLength(JSON.stringify(source), "utf8")).toBeGreaterThan(48 * 1024);
    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThan(48 * 1024);
    expect(page.page).toMatchObject({
      raw_issue_count: 12,
      diagnostic_group_count: 1,
      reported_issue_count: 1,
      total_issue_count: 1,
      remaining_issue_count: 0,
    });
    expect(selectorIssueToolPage(page.issues).page.raw_issue_count).toBe(12);
    expect(source).toEqual(before);
  });

  test("keeps field-binding groups separate across code, field, route, or repair instructions", () => {
    const makeIssue = (
      index: number,
      code = "field_binding_relation",
      field = "requirement",
      referencePath = "/references/0",
      requiredAction = "verify_then_repair",
    ) => ({
      code,
      path: `/items/0/fields/${field}/span_ids/${index}`,
      owner: "selector_input_error",
      details: {
        affected_item_key: "receiver",
        affected_field: field,
        matching_reference_routes: [{ path: referencePath, matching_destination_indexes: [0] }],
        required_action: requiredAction,
        allowed_actions: ["repair_route", "remove_span"],
        how_to_pass: "read, decide, and save",
        actual: { span_id: `span:${index}`, evidence_id: `evidence:${index}` },
        writable_path: `/items/0/fields/${field}/span_ids/${index}`,
        next_tool: "open_evidence",
        next_tool_arguments: { evidence_id: `evidence:${index}`, cursor: 0 },
        save_tool: "stage_target_selector_draft",
      },
    });
    expect(coalesceFieldBindingDiagnostics([
      makeIssue(0),
      makeIssue(1, "field_binding_reference_route"),
    ])).toHaveLength(2);
    expect(coalesceFieldBindingDiagnostics([
      makeIssue(0),
      makeIssue(1, "field_binding_relation", "method"),
    ])).toHaveLength(2);
    expect(coalesceFieldBindingDiagnostics([
      makeIssue(0),
      makeIssue(1, "field_binding_relation", "requirement", "/references/1"),
    ])).toHaveLength(2);
    expect(coalesceFieldBindingDiagnostics([
      makeIssue(0),
      makeIssue(1, "field_binding_relation", "requirement", "/references/0", "different_repair"),
    ])).toHaveLength(2);
  });

  test("coalesces the three manifestations of one invalid method source", () => {
    const issues = coalesceSelectorIssueDiagnostics([
      {
        code: "selector_source_fact_summary_forbidden",
        path: "/items/2/fields/method/composition",
        message: "Only item name may be a semantic summary",
        owner: "selector_input_error",
      },
      {
        code: "selector_display_field_span_role_overlap",
        path: "/items/2",
        message: "display roles overlap",
        details: {
          item_key: "item-c",
          affected_paths: [
            "/items/2/fields/requirement/span_ids/0",
            "/items/2/fields/method/span_ids/0",
          ],
          conflicting_role_pairs: [["requirement", "method"]],
          conflicting_bindings: [{ span_id: "method-container" }],
        },
      },
      {
        code: "selector_method_span_conflates_display_roles",
        path: "/items/2",
        message: "method contains requirement",
        details: {
          item_key: "item-c",
          affected_paths: [
            "/items/2/fields/method/span_ids/0",
            "/items/2/fields/requirement/span_ids/0",
          ],
        },
      },
      { code: "selector_nonexplicit_sampling_has_inline_spans", path: "/items/2/sampling" },
    ]);

    expect(issues).toHaveLength(2);
    expect(issues[0]).toMatchObject({
      code: "selector_method_source_invalid",
      path: "/items/2/fields/method",
      owner: "selector_input_error",
      details: {
        item_key: "item-c",
        original_issue_count: 3,
        original_issue_codes: [
          "selector_source_fact_summary_forbidden",
          "selector_display_field_span_role_overlap",
          "selector_method_span_conflates_display_roles",
        ],
        affected_paths: expect.arrayContaining([
          "/items/2/fields/method/composition",
          "/items/2/fields/method/span_ids/0",
          "/items/2/fields/requirement/span_ids/0",
        ]),
      },
      how_to_pass: expect.stringContaining("shared_inheritance"),
      do_not_edit: expect.any(String),
      next_tool: "stage_target_selector_draft",
    });
    expect(issues[1]).toMatchObject({ code: "selector_nonexplicit_sampling_has_inline_spans" });
  });

  test("groups mutually exclusive reference placeholder repairs without selecting a business route", () => {
    const source = [
      {
        code: "selector_reference_placeholder_has_item_destination",
        path: "/references/0/destinations",
        message: "placeholder destinations must be empty",
        details: { required_action: "clear_destinations", original_detail_marker: "keep-first-details" },
        actual: { application_mode: "reference_placeholder", destinations: [{ item_key: "item-a" }] },
        writable_path: "/references/0/destinations",
        writable_paths: ["/references/0/destinations"],
        allowed_actions: ["clear_destinations"],
        next_tool: "read_target_selectors",
        next_tool_arguments: { collection: "references", key: "reference-a" },
        next_tools: ["read_target_selectors", "stage_target_selector_draft"],
        save_tool: "stage_target_selector_draft",
      },
      {
        code: "selector_reference_placeholder_local_requirement",
        path: "/references/0/application_mode",
        message: "local requirement is still bound",
        details: {
          occurrence_id: "occurrence:a",
          writable_paths: ["/references/0/application_mode", "/items/0/fields"],
        },
      },
      {
        code: "selector_reference_placeholder_target_uncovered",
        path: "/references/0/target_span_ids",
        message: "target spans are not covered",
        details: {
          occurrence_id: "occurrence:a",
          writable_paths: ["/references/0/target_span_ids", "/items"],
        },
      },
      { code: "independent_selector_issue", path: "/items/4", message: "keep me" },
    ];
    const before = structuredClone(source);
    expect(coalesceSelectorIssueDiagnostics(source)).toEqual(source);
    const surfaced = selectorIssueToolPage(source);

    expect(surfaced.issues).toHaveLength(2);
    expect(surfaced.issues[0]).toMatchObject({
      code: source[0]!.code,
      path: source[0]!.path,
      message: source[0]!.message,
      actual: source[0]!.actual,
      writable_path: source[0]!.writable_path,
      required_action: expect.stringMatching(/只选择.*一个合法分支/u),
      allowed_actions: ["promote_reference_only", "retain_reference_placeholder"],
      next_tool: source[0]!.next_tool,
      next_tool_arguments: source[0]!.next_tool_arguments,
      save_tool: source[0]!.save_tool,
      details: {
        original_detail_marker: "keep-first-details",
        occurrence_id: "occurrence:a",
        original_issue_count: 3,
        original_issue_codes: source.slice(0, 3).map((issue) => issue.code),
        original_issue_paths: source.slice(0, 3).map((issue) => issue.path),
        original_issues: source.slice(0, 3),
        resolution_group_code: "selector_reference_placeholder_resolution_branch_required",
        resolution_mode: "choose_exactly_one",
        resolution_branches: [
          expect.objectContaining({
            branch: "promote_reference_only",
            application_mode: "reference_only",
            writable_fields: ["application_mode", "destinations", "import_scope", "component_dispositions"],
          }),
          expect.objectContaining({
            branch: "retain_reference_placeholder",
            application_mode: "reference_placeholder",
            destinations: [],
            writable_fields: ["destinations", "target_span_ids", "items", "sampling_rules"],
          }),
        ],
        required_actions: [
          expect.stringContaining("reference_only"),
          expect.stringContaining("destinations 为空"),
        ],
      },
      how_to_pass: expect.stringMatching(/两种合法方向.*只选择/su),
      writable_paths: expect.arrayContaining([
        "/references/0/destinations",
        "/references/0/application_mode",
        "/references/0/target_span_ids",
      ]),
      next_tools: expect.arrayContaining(source[0]!.next_tools),
    });
    expect((surfaced.issues[0] as any).details.original_issues[0].details.required_action)
      .toBe("clear_destinations");
    expect((surfaced.issues[0] as any).details.original_issues[0].allowed_actions)
      .toEqual(source[0]!.allowed_actions);
    expect(surfaced.issues[1]).toEqual(source[3]);
    expect(surfaced.page).toMatchObject({
      raw_issue_count: 4,
      diagnostic_group_count: 2,
      reported_issue_count: 2,
      total_issue_count: 2,
      remaining_issue_count: 0,
    });
    expect(selectorIssueToolPage(surfaced.issues).page.raw_issue_count).toBe(4);
    expect(source).toEqual(before);
  });

  test("groups the two core placeholder branch diagnostics without a destination issue", () => {
    const source = [
      {
        code: "selector_reference_placeholder_local_requirement",
        path: "/references/0/application_mode",
        details: { occurrence_id: "occurrence:a" },
      },
      {
        code: "selector_reference_placeholder_target_uncovered",
        path: "/references/0/target_span_ids",
        details: { occurrence_id: "occurrence:a" },
      },
    ];
    expect(coalesceSelectorIssueDiagnostics(source)).toEqual(source);
    const surfaced = selectorIssueToolPage(source);
    expect(surfaced.issues).toHaveLength(1);
    expect(surfaced.issues[0]).toMatchObject({
      code: source[0]!.code,
      path: source[0]!.path,
      details: {
        original_issue_count: 2,
        original_issue_codes: source.map((issue) => issue.code),
        original_issue_paths: source.map((issue) => issue.path),
        resolution_group_code: "selector_reference_placeholder_resolution_branch_required",
        resolution_mode: "choose_exactly_one",
      },
      how_to_pass: expect.stringContaining("两种合法方向"),
    });
    expect(surfaced.page).toMatchObject({
      raw_issue_count: 2,
      diagnostic_group_count: 1,
      reported_issue_count: 1,
      total_issue_count: 1,
      remaining_issue_count: 0,
    });
  });

  test("does not group placeholder diagnostics from different references or incomplete branch pairs", () => {
    const source = [
      { code: "selector_reference_placeholder_local_requirement", path: "/references/0/application_mode" },
      { code: "selector_reference_placeholder_has_item_destination", path: "/references/0/destinations" },
      { code: "selector_reference_placeholder_target_uncovered", path: "/references/1/target_span_ids" },
    ];
    expect(coalesceSelectorIssueDiagnostics(source)).toEqual(source);
    expect(selectorIssueToolPage(source).issues).toEqual(source);
  });

  test("preserves independent checks when the full root-cause cluster is absent", () => {
    const issue = {
      code: "selector_display_field_span_role_overlap",
      path: "/items/0",
      details: { conflicting_role_pairs: [["requirement", "quantity"]] },
    };
    expect(coalesceSelectorIssueDiagnostics([issue])).toEqual([issue]);
  });

  test("does not swallow a quantity conflict inside a mixed method/quantity diagnostic", () => {
    const issues = [
      { code: "selector_source_fact_summary_forbidden", path: "/items/0/fields/method/composition" },
      { code: "selector_display_field_span_role_overlap", path: "/items/0", details: {
        conflicting_role_pairs: [["requirement", "method"], ["requirement", "quantity"]],
        affected_paths: ["/items/0/fields/method", "/items/0/fields/quantity"],
      } },
      { code: "selector_method_span_conflates_display_roles", path: "/items/0" },
    ];
    expect(coalesceSelectorIssueDiagnostics(issues)).toEqual(issues);
  });
});
