import { sha256Json } from "./canonical.js";
import { isModelReviewIssue } from "./validation-boundary.js";
import { selectorWorkNextStep } from "./selector-feedback.js";

type RecordValue = Record<string, any>;
const object = (value: unknown): RecordValue => value && typeof value === "object" && !Array.isArray(value)
  ? value as RecordValue : {};

function location(issue: RecordValue) {
  const details = object(issue.details), actual = object(issue.actual ?? details.actual);
  const path = String(issue.path ?? "/");
  const collection = path.split("/")[1] ?? "";
  const key = object(issue.record_identity).key ?? object(object(issue.record_read).arguments).key
    ?? details.item_key ?? details.writable_item_key ?? details.writable_record_key
    ?? details.reference_key ?? details.sampling_rule_key ?? details.rule_key ?? details.lot_key
    ?? actual.item_key ?? actual.reference_key ?? actual.sampling_rule_key ?? actual.lot_key;
  const occurrence_id = actual.occurrence_id ?? details.occurrence_id;
  return { collection, ...(key ? { key } : {}), ...(occurrence_id ? { occurrence_id } : {}),
    field: path.replace(/^\/(items|references|sampling_rules|lots|source_dispositions)\/\d+/, "") };
}

/** A presentation projection only: full canonical errors stay in the persisted snapshot. */
export function selectorFieldDiagnostic(value: unknown, modelReview = false): RecordValue {
  const issue = object(value), details = object(issue.details), record = location(issue);
  const describedActual = issue.actual ?? details.actual ?? {
    ...(details.actual_path ? { path: details.actual_path } : {}),
    ...(details.item_key ? { item_key: details.item_key } : {}),
    ...(details.evidence_ids ? { evidence_ids: details.evidence_ids } : {}),
    ...(details.matching_reference_keys ? { matching_reference_keys: details.matching_reference_keys } : {}),
  };
  const actual = details.quote_match_count === undefined ? describedActual : {
    ...object(describedActual), match_count: details.match_count, quote_match_count: details.quote_match_count,
  };
  const code = String(issue.code ?? "unknown");
  const expected = issue.expected ?? details.expected
    ?? (code === "selector_registered_reference_receipt_missing" ? { record_count: 1 }
      : code === "selector_sampling_decision_pending" ? { status: details.allowed_statuses }
      : code === "compiler_unhandled_evidence" ? { disposition: "explicit_source_decision_or_declared_binding" }
      : details.allowed_values ?? details.allowed_statuses ?? details.required_action ?? issue.message);
  const readonly = ["compiler_invariant_violation", "final_contract_violation"].includes(issue.owner) || issue.terminal === true;
  const advisory = modelReview || isModelReviewIssue(issue);
  const evidence_ids = object(actual).evidence_ids ?? details.evidence_ids;
  return {
    diagnostic_id: sha256Json({ code, record, evidence_ids,
      // Stable record keys replace array positions in diagnostic identity.
      path: record.key || record.occurrence_id ? record.field : issue.path }),
    code, severity: advisory ? "information" : "error",
    decision_owner: advisory ? "model" : "program",
    path: issue.path ?? "/", record, message: issue.message ?? code,
    actual, expected,
    writable_paths: readonly ? [] : issue.writable_paths ?? details.writable_paths
      ?? [issue.writable_path ?? details.writable_path ?? issue.path].filter(Boolean),
    ...(evidence_ids || details.disambiguation_candidates || details.source_access || issue.source_access ? { related_information: {
      ...(evidence_ids ? { evidence_ids } : {}),
      ...(details.disambiguation_candidates ? { disambiguation_candidates: details.disambiguation_candidates } : {}),
      ...(issue.source_access ?? details.source_access ? { source_access: issue.source_access ?? details.source_access } : {}),
    } } : {}),
    ...(issue.next_tool ?? details.next_tool ? {
      next_tool: issue.next_tool ?? details.next_tool,
      next_tool_arguments: issue.next_tool_arguments ?? details.next_tool_arguments ?? {},
    } : {}),
    ...(issue.save_tool ?? details.save_tool ? { save_tool: issue.save_tool ?? details.save_tool } : {}),
    ...(issue.how_to_pass ? { how_to_pass: issue.how_to_pass } : {}),
    ...Object.fromEntries(["allowed_actions", "next_tools", "candidate_read_tools", "writable_collections"]
      .filter(key => issue[key] !== undefined).map(key => [key, issue[key]])),
    ...(issue.record_read ? { record_read: issue.record_read } : {}),
    ...(issue.record_reads ?? details.record_reads ? { record_reads: issue.record_reads ?? details.record_reads } : {}),
    ...(issue.write_mode ?? details.write_mode ? { write_mode: issue.write_mode ?? details.write_mode } : {}),
    ...(issue.diagnostic_array_pages ? {
      diagnostic_arrays_complete: issue.diagnostic_arrays_complete,
      diagnostic_array_pages: issue.diagnostic_array_pages,
      diagnostic_array_instruction: issue.diagnostic_array_instruction,
    } : {}),
    ...(readonly || issue.do_not_edit || details.do_not_edit ? {
      do_not_edit: issue.do_not_edit ?? details.do_not_edit ?? "程序生成结果和不可变来源；该错误须由维护者处理。",
    } : {}),
  };
}

function diagnosticList(values: unknown[], parent: RecordValue, advisory = false): RecordValue[] {
  const receipts = values.filter(v => object(v).code === "selector_registered_reference_receipt_missing");
  const coveredOrigins = new Set(receipts.flatMap(v => object(object(v).actual ?? object(object(v).details).actual).origin_evidence_ids ?? []));
  return values.flatMap((v, index) => {
    const issue = object(v), details = object(issue.details);
    const origins = object(issue.actual ?? details.actual).evidence_ids ?? details.evidence_ids ?? [];
    // Same missing reference surfaced as both unhandled source and missing receipt.
    // Suppress only a fully covered symptom, retaining the canonical raw count.
    if (issue.code === "compiler_unhandled_evidence" && origins.length
      && origins.every((id: string) => coveredOrigins.has(id))) return [];
    const result = selectorFieldDiagnostic(v, advisory);
    const page = object(parent.selector_issue_page);
    const entry = (page.issue_index ?? []).find((row: RecordValue) => row.index === (page.cursor ?? 0) + index);
    const fingerprint = parent.draft_fingerprint ?? parent.current_draft_fingerprint;
    if (!advisory && parent.field_diagnostic_read) result.full_details = {
      tool: parent.field_diagnostic_read.tool,
      arguments: { ...parent.field_diagnostic_read.arguments,
        field_diagnostic_cursor: (page.cursor ?? 0) + index, field_diagnostic_detail_mode: "full" },
    };
    else if (!advisory && fingerprint && entry?.issue_key) result.full_details = {
      tool: "read_target_selector_issues",
      arguments: { draft_fingerprint: fingerprint, issue_key: entry.issue_key, detail_mode: "full" },
    };
    return [result];
  });
}

/** Keep SDK text and details identical so reply accounting measures what the model sees. */
export function selectorDiagnosticToolResponse(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(selectorDiagnosticToolResponse);
  const source = value as RecordValue;
  if (source.diagnostic_detail_mode === "full") return source;
  const result: RecordValue = {};
  for (const [key, child] of Object.entries(source)) {
    if (key === "saved_records" && child && typeof child === "object" && !Array.isArray(child)) {
      result.saved_records = Object.fromEntries(Object.entries(child).map(([collection, rows]) => [collection,
        Array.isArray(rows) ? rows.map(row => ({ key: object(row).key ?? object(row).read_key ?? null })) : rows]));
      result.saved_records_instruction = "保存回执只列记录身份，完整内容已持久化；需回读时用 read_target_selectors 的 collection/key。";
      continue;
    }
    if (["selector_issues", "deferred_issues", "issues", "observations"].includes(key)
      && Array.isArray(child) && child.every(row => typeof object(row).code === "string")) {
      result[key] = diagnosticList(child, source, key === "observations");
      continue;
    }
    if (key === "selector_blocker_handoff") continue; // historical counts remain in state and explicit reads
    result[key] = selectorDiagnosticToolResponse(child);
  }
  if (Array.isArray(result.selector_issues)) result.diagnostic_display_count = result.selector_issues.length;
  if (source.selector_repair_work && !source.terminal) {
    if (!result.next_tool) Object.assign(result, selectorWorkNextStep(source.selector_repair_work));
    const work = object(result.selector_repair_work), diagnostic = object(work.diagnostic);
    const local = object(result.local_validation);
    // One full current diagnostic; duplicate occurrences point to that body.
    for (const [list, page] of [["issues", "issue_page"], ["deferred_issues", "deferred_issue_page"]] as const) {
      if (!diagnostic.diagnostic_id || !Array.isArray(local[list])) continue;
      local[list] = local[list].map((row: RecordValue) => row.diagnostic_id === diagnostic.diagnostic_id
        ? { diagnostic_id: row.diagnostic_id, code: row.code, severity: row.severity, path: row.path,
          record: row.record, diagnostic_ref: "/selector_repair_work/diagnostic" } : row);
      if (local[page]) local[page].reported_issue_utf8_bytes = local[list].reduce((n: number, row: unknown) => n + Buffer.byteLength(JSON.stringify(row), "utf8"), 0);
    }
  }
  return result;
}
