function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

/** Display-only grouping. Do not use these counts/fingerprints for progress. */
export function coalesceReferenceToolDiagnostics(issues: readonly unknown[]): unknown[] {
  const groups = new Map<string, number[]>();
  const record = (value: unknown): Record<string, any> => value && typeof value === "object" && !Array.isArray(value) ? value : {};
  issues.forEach((issue, index) => {
    const value = record(issue), details = record(value.details);
    if (!["reference_import_scope_exceeded", "reference_origin_relation"].includes(value.code)
      || typeof details.occurrence_id !== "string" || typeof details.item_id !== "string"
      || typeof value.path !== "string" || details.original_issue_count) return;
    const prefix = /^\/(?:references|reference_resolutions)\/\d+/u.exec(value.path)?.[0];
    if (!prefix) return;
    const key = JSON.stringify([value.code, prefix, details.occurrence_id,
      value.code === "reference_origin_relation" ? details.item_id : [...(details.allowed_fields ?? [])].sort(),
      [...(details.origin_evidence_ids ?? [])].sort()]);
    groups.set(key, [...(groups.get(key) ?? []), index]);
  });
  const replacements = new Map<number, unknown>(), consumed = new Set<number>();
  for (const indexes of groups.values()) {
    if (indexes.length < 2) continue;
    const members = indexes.map(index => record(issues[index]));
    const first = members[0]!, details = record(first.details);
    const writablePaths = unique(members.flatMap(member => record(member.details).writable_paths ?? [record(member.details).writable_path ?? member.path]));
    const receiverImports = [...new Map(members.map(member => {
      const d = record(member.details);
      const receiver = { item_id: d.item_id, imported_fields: d.imported_fields, outside_import_scope: d.outside_import_scope };
      return [JSON.stringify(receiver), receiver];
    })).values()];
    replacements.set(indexes[0]!, { ...first,
      ...(first.writable_paths ? { writable_paths: writablePaths } : {}),
      details: { ...details, original_issue_count: indexes.length, affected_paths: unique(members.map(member => member.path)), writable_paths: writablePaths,
        ...(first.code === "reference_import_scope_exceeded" ? { receiver_imports: receiverImports } : {}) },
    });
    indexes.slice(1).forEach(index => consumed.add(index));
  }
  return issues.flatMap((issue, index) => consumed.has(index) ? [] : [replacements.get(index) ?? issue]);
}

const FIELD_BINDING_DISPLAY_CODES = new Set([
  "field_binding_relation",
  "field_binding_reference_route",
]);

function diagnosticRecord(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function diagnosticStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function diagnosticValue(record: Record<string, any>, key: string): unknown {
  return record[key] ?? diagnosticRecord(record.details)[key];
}

function canonicalDiagnosticJson(value: unknown): string | undefined {
  const normalize = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(normalize);
    if (!entry || typeof entry !== "object") return entry;
    return Object.fromEntries(
      Object.entries(entry as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, normalize(child)]),
    );
  };
  try {
    return JSON.stringify(normalize(value));
  } catch {
    return undefined;
  }
}

/** Share identical repair instructions while retaining every source's actual
 * values and executable read route. Display only; raw validation is untouched. */
export function coalesceUnhandledEvidenceDiagnostics(issues: readonly unknown[]): unknown[] {
  const localKeys = new Set(["evidence_ids", "candidate_span_ids", "actual", "repair_identity",
    "already_read_evidence_ids", "unread_evidence_ids", "source_access", "openable_evidence_ids",
    "registered_reference_routes", "missing_resolved_reference_routes", "tool_argument_hints", "next_tool_arguments"]);
  const split = (record: Record<string, any>, local: boolean) => Object.fromEntries(
    Object.entries(record).filter(([key]) => localKeys.has(key) === local));
  const groups = new Map<string, number[]>();
  issues.forEach((issue, index) => {
    const value = diagnosticRecord(issue), details = diagnosticRecord(value.details);
    if (value.code !== "compiler_unhandled_evidence" || details.original_issue_count
      || !diagnosticStringList(details.evidence_ids).length || typeof details.how_to_pass !== "string") return;
    const { details: _details, ...outer } = value;
    if (Object.entries(split(outer, true)).some(([key, child]) =>
      canonicalDiagnosticJson(child) !== canonicalDiagnosticJson(details[key]))) return;
    const actual = diagnosticRecord(details.actual);
    const { evidence_ids: _ids, candidate_spans: _spans, reference_anchor_bindings: _bindings, ...otherActual } = actual;
    const key = canonicalDiagnosticJson([split(outer, false), split(details, false), otherActual,
      diagnosticRecord(details.repair_identity).kind]);
    if (key) groups.set(key, [...(groups.get(key) ?? []), index]);
  });
  const replacements = new Map<number, unknown>(), consumed = new Set<number>();
  for (const indexes of groups.values()) {
    // Keep grouping bounded so the existing deterministic page can advance.
    for (let offset = 0; offset < indexes.length; offset += 16) {
      const chunk = indexes.slice(offset, offset + 16);
      if (chunk.length < 2) continue;
      const members = chunk.map(index => diagnosticRecord(issues[index]));
      const first = members[0]!, details = diagnosticRecord(first.details);
      const memberDetails = members.map(member => diagnosticRecord(member.details));
      const merge = (values: unknown[]) => [...new Map(values.map(value => [canonicalDiagnosticJson(value), value])).values()];
      const mergedArrays = Object.fromEntries([...localKeys].filter(key => Array.isArray(details[key]))
        .map(key => [key, merge(memberDetails.flatMap(detail => detail[key] ?? []))]));
      const actual = { ...diagnosticRecord(details.actual),
        ...Object.fromEntries(["evidence_ids", "candidate_spans", "reference_anchor_bindings"].map(key =>
          [key, merge(memberDetails.flatMap(detail => diagnosticRecord(detail.actual)[key] ?? []))])) };
      const toolArgumentHints = Object.fromEntries([...new Set(memberDetails.flatMap(detail => Object.keys(diagnosticRecord(detail.tool_argument_hints))))]
        .map(tool => [tool, merge(memberDetails.flatMap(detail => {
          const args = diagnosticRecord(detail.tool_argument_hints)[tool];
          return args === undefined ? [] : Array.isArray(args) ? args : [args];
        }))]));
      const grouped = { ...first, actual, tool_argument_hints: toolArgumentHints, details: {
        ...details, ...mergedArrays, actual, tool_argument_hints: toolArgumentHints,
        repair_identity: { ...diagnosticRecord(details.repair_identity), values: mergedArrays.evidence_ids },
        original_issue_count: chunk.length,
        members: memberDetails.map(detail => split(detail, true)),
        member_instruction: "公共修复说明仅列一次；按 members 分别核对每段来源的 actual、阅读状态、引用和 next_tool_arguments，不能因同类问题而作相同语义处置。",
      } };
      if (new TextEncoder().encode(JSON.stringify(grouped)).length > 48 * 1024) continue;
      replacements.set(chunk[0]!, grouped);
      chunk.slice(1).forEach(index => consumed.add(index));
    }
  }
  return issues.flatMap((issue, index) => consumed.has(index) ? [] : [replacements.get(index) ?? issue]);
}

function fieldBindingDisplayGroupKey(issue: unknown, bySource = false): string | undefined {
  const record = diagnosticRecord(issue);
  const details = diagnosticRecord(record.details);
  if (!FIELD_BINDING_DISPLAY_CODES.has(record.code) || details.original_issue_count !== undefined) return undefined;
  const affectedItemKey = diagnosticValue(record, "affected_item_key");
  const affectedField = diagnosticValue(record, "affected_field");
  const matchingRoutes = diagnosticValue(record, "matching_reference_routes");
  const requiredAction = diagnosticValue(record, "required_action");
  const howToPass = diagnosticValue(record, "how_to_pass");
  const allowedActions = diagnosticValue(record, "allowed_actions");
  const nextTool = diagnosticValue(record, "next_tool");
  const saveTool = diagnosticValue(record, "save_tool");
  if (bySource && Array.isArray(matchingRoutes)
    && matchingRoutes.some(route => !route || typeof route !== "object" || Array.isArray(route))) return undefined;
  const normalizedRoutes = canonicalDiagnosticJson(bySource && Array.isArray(matchingRoutes)
    ? matchingRoutes.map(({ matching_destination_indexes: _indexes, ...route }) => route)
    : matchingRoutes);
  const normalizedActions = canonicalDiagnosticJson(allowedActions);
  if (
    typeof affectedItemKey !== "string" || affectedItemKey.length === 0
    || typeof affectedField !== "string" || affectedField.length === 0
    || !Array.isArray(matchingRoutes) || normalizedRoutes === undefined
    || typeof requiredAction !== "string" || requiredAction.length === 0
    || typeof howToPass !== "string" || howToPass.length === 0
    || !Array.isArray(allowedActions) || normalizedActions === undefined
    || typeof nextTool !== "string" || nextTool.length === 0
    || typeof saveTool !== "string" || saveTool.length === 0
  ) return undefined;
  const actual = diagnosticRecord(diagnosticValue(record, "actual"));
  if (bySource && (typeof actual.evidence_id !== "string" || typeof actual.span_id !== "string"
    || !Number.isInteger(actual.start) || !Number.isInteger(actual.end))) return undefined;
  return JSON.stringify([
    record.code,
    typeof record.owner === "string" ? record.owner : "",
    bySource ? [actual.evidence_id, actual.span_id, actual.start, actual.end] : affectedItemKey,
    affectedField,
    normalizedRoutes,
    requiredAction,
    howToPass,
    normalizedActions,
    nextTool,
    saveTool,
    bySource ? canonicalDiagnosticJson(diagnosticValue(record, "next_tool_arguments")) : undefined,
    canonicalDiagnosticJson(diagnosticValue(record, "matching_placeholder_sources")),
  ]);
}

function fieldBindingMemberSummary(issue: unknown, bySource = false): Record<string, unknown> {
  const record = diagnosticRecord(issue);
  const details = diagnosticRecord(record.details);
  const writablePath = diagnosticValue(record, "writable_path");
  const writablePaths = unique([
    ...diagnosticStringList(record.writable_paths),
    ...diagnosticStringList(details.writable_paths),
  ]);
  const nextToolArguments = diagnosticValue(record, "next_tool_arguments");
  const actual = diagnosticValue(record, "actual");
  return {
    code: record.code,
    path: record.path,
    ...(actual === undefined ? {} : { actual }),
    ...(typeof writablePath === "string" ? { writable_path: writablePath } : {}),
    ...(writablePaths.length > 0 ? { writable_paths: writablePaths } : {}),
    ...(nextToolArguments === undefined ? {} : { next_tool_arguments: nextToolArguments }),
    ...(bySource ? {
      affected_item_key: diagnosticValue(record, "affected_item_key"),
      affected_field: diagnosticValue(record, "affected_field"),
      local_evidence_ids: diagnosticValue(record, "local_evidence_ids"),
      matching_reference_destinations: (diagnosticValue(record, "matching_reference_routes") as Record<string, unknown>[])
        .map(route => ({ path: route.path, matching_destination_indexes: route.matching_destination_indexes })),
    } : {}),
  };
}

/**
 * Display-only grouping for repeated source spans that share one field-binding
 * repair. Validator issues and fingerprints remain one-per-span.
 */
export function coalesceFieldBindingDiagnostics(issues: readonly unknown[], bySource = false): unknown[] {
  const groupedIndexes = new Map<string, number[]>();
  issues.forEach((issue, index) => {
    const key = fieldBindingDisplayGroupKey(issue, bySource);
    if (key === undefined) return;
    groupedIndexes.set(key, [...(groupedIndexes.get(key) ?? []), index]);
  });

  const replacements = new Map<number, unknown>();
  const consumed = new Set<number>();
  for (const indexes of groupedIndexes.values()) {
    if (indexes.length < 2) continue;
    const members = indexes.map((index) => diagnosticRecord(issues[index]));
    const first = members[0]!;
    const pickFirst = (key: string): unknown => diagnosticValue(first, key);
    const memberSummaries = members.map(member => fieldBindingMemberSummary(member, bySource));
    const writablePaths = unique(memberSummaries.flatMap((member) => [
      ...(typeof member.writable_path === "string" ? [member.writable_path] : []),
      ...diagnosticStringList(member.writable_paths),
    ]));
    const listsFor = (key: string): string[] => unique(members.flatMap((member) => [
      ...diagnosticStringList(member[key]),
      ...diagnosticStringList(diagnosticRecord(member.details)[key]),
    ]));
    const originalIssueCodes = members.flatMap((member) => (
      typeof member.code === "string" ? [member.code] : []
    ));
    const originalIssuePaths = members.flatMap((member) => (
      typeof member.path === "string" ? [member.path] : []
    ));
    const nextTool = pickFirst("next_tool") as string;
    const saveTool = pickFirst("save_tool") as string;
    const howToPass = pickFirst("how_to_pass") as string;
    const allowedActions = pickFirst("allowed_actions") as unknown[];
    const requiredAction = pickFirst("required_action") as string;
    const doNotEdit = pickFirst("do_not_edit");
    const nextTools = unique([nextTool, ...listsFor("next_tools")]);
    const candidateReadTools = listsFor("candidate_read_tools");
    const writableCollections = listsFor("writable_collections");
    replacements.set(indexes[0]!, {
      code: first.code,
      path: originalIssuePaths[0] ?? "/",
      message: bySource
        ? `同一来源在 ${indexes.length} 个接收项的相同字段触发同类问题；公共原文只需读取一次，按 details.members 分别判断适用性并同批修复，不得一律删除或绑定。`
        : `同一 item.field 的 ${indexes.length} 条来源触发相同修复路线；公共说明只执行一次，并按 details.members 逐条核对 span。`,
      ...(first.owner === undefined ? {} : { owner: first.owner }),
      details: {
        original_issue_count: indexes.length,
        original_issue_codes: originalIssueCodes,
        original_issue_paths: originalIssuePaths,
        affected_paths: unique(originalIssuePaths),
        ...(bySource ? { affected_item_keys: unique(members.map(member => diagnosticValue(member, "affected_item_key"))) }
          : { affected_item_key: pickFirst("affected_item_key") }),
        affected_field: pickFirst("affected_field"),
        matching_reference_routes: bySource
          ? (pickFirst("matching_reference_routes") as Record<string, unknown>[]).map(({ matching_destination_indexes: _indexes, ...route }) => route)
          : pickFirst("matching_reference_routes"),
        ...(pickFirst("matching_placeholder_sources") === undefined ? {} : { matching_placeholder_sources: pickFirst("matching_placeholder_sources") }),
        members: memberSummaries,
      },
      actual: {
        ...(bySource ? { evidence_id: diagnosticRecord(pickFirst("actual")).evidence_id,
          span_id: diagnosticRecord(pickFirst("actual")).span_id }
          : { affected_item_key: pickFirst("affected_item_key") }),
        affected_field: pickFirst("affected_field"),
        member_count: indexes.length,
      },
      required_action: requiredAction,
      allowed_actions: allowedActions,
      how_to_pass: howToPass,
      ...(writablePaths.length > 0
        ? { writable_path: writablePaths[0], writable_paths: writablePaths }
        : {}),
      ...(writableCollections.length > 0 ? { writable_collections: writableCollections } : {}),
      ...(candidateReadTools.length > 0 ? { candidate_read_tools: candidateReadTools } : {}),
      save_tool: saveTool,
      ...(typeof doNotEdit === "string" ? { do_not_edit: doNotEdit } : {}),
      next_tool: nextTool,
      next_tools: nextTools,
    });
    indexes.slice(1).forEach((index) => consumed.add(index));
  }
  const result = issues.flatMap((issue, index) => (
    consumed.has(index) ? [] : [replacements.get(index) ?? issue]
  ));
  return bySource ? result : coalesceFieldBindingDiagnostics(result, true);
}

const REFERENCE_PLACEHOLDER_LOCAL_REQUIREMENT = "selector_reference_placeholder_local_requirement";
const REFERENCE_PLACEHOLDER_TARGET_UNCOVERED = "selector_reference_placeholder_target_uncovered";
const REFERENCE_PLACEHOLDER_DESTINATION_CODES = new Set([
  "selector_reference_placeholder_has_item_destination",
  "reference_placeholder_has_item_destination",
]);

/**
 * Display-only grouping for mutually exclusive reference-placeholder repairs.
 * The compiler issues remain independent; this wrapper keeps every original
 * diagnostic and count while preventing their repair text from being read as
 * instructions that must all be applied at once.
 */
export function coalesceReferencePlaceholderResolutionDiagnostics(
  issues: readonly unknown[],
): unknown[] {
  const asRecord = (value: unknown): Record<string, any> => (
    value && typeof value === "object" && !Array.isArray(value) ? value : {}
  );
  const stringList = (value: unknown): string[] => (
    Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []
  );
  const referenceRoot = (value: unknown): string | undefined => (
    typeof value === "string" ? /^\/references\/\d+(?=\/|$)/u.exec(value)?.[0] : undefined
  );
  const eligibleCodes = new Set([
    REFERENCE_PLACEHOLDER_LOCAL_REQUIREMENT,
    REFERENCE_PLACEHOLDER_TARGET_UNCOVERED,
    ...REFERENCE_PLACEHOLDER_DESTINATION_CODES,
  ]);
  const groupedIndexes = new Map<string, number[]>();
  issues.forEach((issue, index) => {
    const record = asRecord(issue);
    if (!eligibleCodes.has(record.code)) return;
    const root = referenceRoot(record.path);
    if (!root) return;
    groupedIndexes.set(root, [...(groupedIndexes.get(root) ?? []), index]);
  });

  const replacements = new Map<number, unknown>();
  const consumed = new Set<number>();
  for (const [root, indexes] of groupedIndexes.entries()) {
    const members = indexes.map((index) => asRecord(issues[index]));
    const first = members[0]!;
    const codes = new Set(members.map((member) => member.code));
    if (!codes.has(REFERENCE_PLACEHOLDER_LOCAL_REQUIREMENT)
      || !codes.has(REFERENCE_PLACEHOLDER_TARGET_UNCOVERED)) continue;
    const memberDetails = members.map((member) => asRecord(member.details));
    const firstDetails = memberDetails[0]!;
    const firstValue = (key: string): unknown => first[key] ?? firstDetails[key];
    const occurrenceIds = unique(memberDetails.flatMap((details) => (
      typeof details.occurrence_id === "string" ? [details.occurrence_id] : []
    )));
    if (occurrenceIds.length > 1) continue;
    const originalIssueCount = memberDetails.reduce((sum, details) => (
      sum + (Number.isInteger(details.original_issue_count) && details.original_issue_count > 0
        ? details.original_issue_count
        : 1)
    ), 0);
    const originalIssueCodes = members.flatMap((member, memberIndex) => {
      const nested = stringList(memberDetails[memberIndex]!.original_issue_codes);
      return nested.length > 0 ? nested : typeof member.code === "string" ? [member.code] : [];
    });
    const originalIssuePaths = members.flatMap((member) => (
      typeof member.path === "string" ? [member.path] : []
    ));
    const affectedPaths = unique(members.flatMap((member, memberIndex) => [
      ...(typeof member.path === "string" ? [member.path] : []),
      ...stringList(memberDetails[memberIndex]!.affected_paths),
    ]));
    const writablePaths = unique(members.flatMap((member, memberIndex) => [
      ...(typeof member.path === "string" ? [member.path] : []),
      ...(typeof member.writable_path === "string" ? [member.writable_path] : []),
      ...stringList(member.writable_paths),
      ...(typeof memberDetails[memberIndex]!.writable_path === "string"
        ? [memberDetails[memberIndex]!.writable_path]
        : []),
      ...stringList(memberDetails[memberIndex]!.writable_paths),
    ]));
    const candidateReadTools = unique(members.flatMap((member, memberIndex) => [
      ...(typeof member.candidate_read_tool === "string" ? [member.candidate_read_tool] : []),
      ...stringList(member.candidate_read_tools),
      ...(typeof memberDetails[memberIndex]!.candidate_read_tool === "string"
        ? [memberDetails[memberIndex]!.candidate_read_tool]
        : []),
      ...stringList(memberDetails[memberIndex]!.candidate_read_tools),
    ]));
    const nextTools = unique(members.flatMap((member, memberIndex) => [
      ...(typeof member.next_tool === "string" ? [member.next_tool] : []),
      ...stringList(member.next_tools),
      ...(typeof memberDetails[memberIndex]!.next_tool === "string"
        ? [memberDetails[memberIndex]!.next_tool]
        : []),
      ...stringList(memberDetails[memberIndex]!.next_tools),
    ]));
    const writableCollections = unique([
      ...members.flatMap((member, memberIndex) => [
        ...stringList(member.writable_collections),
        ...stringList(memberDetails[memberIndex]!.writable_collections),
      ]),
      ...writablePaths.flatMap((writablePath) => {
        const collection = /^\/(lots|items|sampling_rules|references|source_dispositions)(?:\/|$)/u.exec(writablePath)?.[1];
        return collection ? [collection] : [];
      }),
    ]);
    const promoteRequiredAction = "保留承载本地要求的真实 item；将 reference 改为 reference_only，并按实际接收关系填写 destinations、import_scope 和适用的 component_dispositions。";
    const retainRequiredAction = "保持 destinations 为空，修正 occurrence 对应的精确 target spans 或真实 item 覆盖；只纠正确有证据表明错误的本地绑定。";
    const chooseRequiredAction = "依据已读原文，只选择并执行 resolution_branches 中一个合法分支。";
    const resolutionAllowedActions = ["promote_reference_only", "retain_reference_placeholder"];
    const howToPass = "先读取当前 reference、相关真实 items 和引用原文。这里给出两种合法方向，但必须依据原文只选择 resolution_branches 中一个分支：原文确有本地验收要求时走 promote_reference_only；只有本地绑定经证据确认错误、且被引内容已由其他真实 item 覆盖时才走 retain_reference_placeholder。不得同时执行两个分支，也不得由 harness 猜测业务路线。";
    const firstActual = firstValue("actual");
    const firstWritablePath = firstValue("writable_path");
    const firstNextTool = firstValue("next_tool");
    const firstNextToolArguments = firstValue("next_tool_arguments");
    const firstSaveTool = firstValue("save_tool");
    const firstDoNotEdit = firstValue("do_not_edit");
    const nextTool = typeof firstNextTool === "string"
      ? firstNextTool
      : nextTools[0] ?? "read_target_selectors";
    const saveTool = typeof firstSaveTool === "string"
      ? firstSaveTool
      : "stage_target_selector_draft";
    replacements.set(indexes[0]!, {
      ...first,
      owner: first.owner
        ?? members.find((member) => typeof member.owner === "string")?.owner
        ?? "selector_input_error",
      details: {
        ...firstDetails,
        required_action: chooseRequiredAction,
        allowed_actions: resolutionAllowedActions,
        ...(occurrenceIds.length === 1 ? { occurrence_id: occurrenceIds[0] } : {}),
        original_issue_count: originalIssueCount,
        original_issue_codes: originalIssueCodes,
        original_issue_paths: originalIssuePaths,
        affected_paths: affectedPaths,
        original_issues: members,
        resolution_group_code: "selector_reference_placeholder_resolution_branch_required",
        resolution_mode: "choose_exactly_one",
        selection_rule: "由模型依据已读原文选择；harness 不自动选择路线。",
        resolution_branches: [
          {
            branch: "promote_reference_only",
            when: "原文确有独立本地验收要求，或被引内容需要导入真实 item 字段。",
            application_mode: "reference_only",
            destinations: "可按原文填写真实 item 与实际接收字段。",
            writable_fields: ["application_mode", "destinations", "import_scope", "component_dispositions"],
            required_action: promoteRequiredAction,
          },
          {
            branch: "retain_reference_placeholder",
            when: "本地绑定经证据确认错误，且被引内容已由其他真实 item 完整覆盖。",
            application_mode: "reference_placeholder",
            destinations: [],
            writable_fields: ["destinations", "target_span_ids", "items", "sampling_rules"],
            required_action: retainRequiredAction,
          },
        ],
        required_actions: [promoteRequiredAction, retainRequiredAction],
        how_to_pass: howToPass,
      },
      ...(firstActual === undefined ? {} : { actual: firstActual }),
      required_action: chooseRequiredAction,
      how_to_pass: howToPass,
      writable_path: typeof firstWritablePath === "string"
        ? firstWritablePath
        : writablePaths[0] ?? root,
      writable_paths: writablePaths,
      writable_collections: writableCollections,
      allowed_actions: resolutionAllowedActions,
      candidate_read_tools: unique(["read_target_selectors", ...candidateReadTools]),
      save_tool: saveTool,
      do_not_edit: typeof firstDoNotEdit === "string"
        ? firstDoNotEdit
        : "不可变 occurrence、原文、编译产物或无证据表明错误的真实 item；不得为了消错虚构 destination、item、span 或覆盖关系。",
      next_tool: nextTool,
      ...(firstNextToolArguments === undefined
        ? { next_tool_arguments: { collection: "references" } }
        : { next_tool_arguments: firstNextToolArguments }),
      next_tools: unique([nextTool, ...nextTools, "stage_target_selector_draft"]),
    });
    indexes.slice(1).forEach((index) => consumed.add(index));
  }
  return issues.flatMap((issue, index) => consumed.has(index) ? [] : [replacements.get(index) ?? issue]);
}

export function coalesceSelectorIssueDiagnostics(issues: readonly unknown[]): unknown[] {
  const records = issues.map((issue) => (
    issue && typeof issue === "object" && !Array.isArray(issue)
      ? issue as Record<string, unknown>
      : undefined
  ));
  const consumed = new Set<number>();
  const replacements = new Map<number, unknown>();
  const detailsFor = (record: Record<string, unknown>): Record<string, unknown> => (
    record.details && typeof record.details === "object" && !Array.isArray(record.details)
      ? record.details as Record<string, unknown>
      : {}
  );

  for (const [index, record] of records.entries()) {
    if (!record || record.code !== "selector_source_fact_summary_forbidden") continue;
    const itemIndex = typeof record.path === "string"
      ? /^\/items\/(\d+)(?:\/|$)/u.exec(record.path)?.[1]
      : undefined;
    if (itemIndex === undefined || record.path !== `/items/${itemIndex}/fields/method/composition`) continue;
    const overlapIndex = records.findIndex((candidate) => {
      if (!candidate || candidate.code !== "selector_display_field_span_role_overlap") return false;
      if (candidate.path !== `/items/${itemIndex}`) return false;
      const pairs = detailsFor(candidate).conflicting_role_pairs;
      // Do not consume an overlap diagnostic that also owns an independent
      // quantity/note conflict: the method-only repair would hide that defect.
      return Array.isArray(pairs) && pairs.length > 0 && pairs.every((pair) => (
        Array.isArray(pair) && pair.length === 2 && pair.includes("requirement") && pair.includes("method")
      ));
    });
    const conflationIndex = records.findIndex((candidate) => (
      candidate?.code === "selector_method_span_conflates_display_roles"
      && candidate.path === `/items/${itemIndex}`
    ));
    if (overlapIndex < 0 || conflationIndex < 0) continue;

    const clusterIndexes = [index, overlapIndex, conflationIndex];
    const cluster = clusterIndexes.map((entry) => records[entry]!);
    const clusterDetails = cluster.map(detailsFor);
    const affectedPaths = unique(cluster.flatMap((entry, clusterIndex) => [
      ...(typeof entry.path === "string" ? [entry.path] : []),
      ...(Array.isArray(clusterDetails[clusterIndex]!.affected_paths)
        ? clusterDetails[clusterIndex]!.affected_paths as unknown[]
        : []),
    ]).filter((path): path is string => typeof path === "string"));
    const rootIndex = Math.min(...clusterIndexes);
    const requiredAction = "若原文及适用共享规定均未提供独立检验方法，将 method 设为 not_applicable 且不选 span；否则仅用 verbatim、shared_inheritance 或 reference 绑定精确的独立方法来源。保留正确的 requirement、quantity 和 note 绑定";
    replacements.set(rootIndex, {
      code: "selector_method_source_invalid",
      path: `/items/${itemIndex}/fields/method`,
      message: "method 使用了不允许的语义概括，且所选来源区间包含验收要求；请将其作为同一个方法来源错误修正。",
      owner: cluster.find((entry) => typeof entry.owner === "string")?.owner ?? "selector_input_error",
      details: {
        item_key: clusterDetails.find((details) => typeof details.item_key === "string")?.item_key ?? "",
        original_issue_codes: cluster.map((entry) => entry.code),
        original_issue_count: cluster.length,
        affected_paths: affectedPaths,
        conflicting_bindings: clusterDetails.find((details) => Array.isArray(details.conflicting_bindings))?.conflicting_bindings ?? [],
        required_action: requiredAction,
        repair_options: [
          { when: "source_has_no_independent_method", action: "set_method_not_applicable_and_clear_method_span_ids" },
          { when: "source_has_independent_method", action: "bind_exact_nonoverlapping_method_source" },
        ],
      },
      actual: "method.composition 为 semantic_summary，且所选来源包含 requirement 的来源",
      how_to_pass: requiredAction,
      writable_path: `/items/${itemIndex}/fields/method`,
      do_not_edit: "编译生成的语义计划或不可变原文",
      next_tool: "stage_target_selector_draft",
    });
    clusterIndexes.forEach((entry) => consumed.add(entry));
  }

  const coalesced = issues.flatMap((issue, index) => {
    const replacement = replacements.get(index);
    if (replacement !== undefined) return [replacement];
    return consumed.has(index) ? [] : [issue];
  });
  return coalesced;
}
