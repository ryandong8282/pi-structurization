import { sha256Json } from "./canonical.js";
import type { ConfirmedTableRowRole, EvidenceManifest, LogicalTableAssembly } from "./contracts.js";
import type { SourceSpanRegistry } from "./source-span-registry.js";

export const TABLE_STRUCTURE_SCHEMA_VERSION = "table-structure-decisions/v1" as const;

export type TableStructureStatus = "review" | "confirmed";
export type TableStructureRowRole =
  | "header"
  | "data"
  | "repeated_header"
  | "note"
  | "context"
  | "review";

export interface TableStructureDecision {
  table_key: string;
  status: TableStructureStatus;
  source_version: string;
  formal_title_span_ids: string[];
  fragment_ids: string[];
  header_rows: string[];
  data_rows: string[];
  repeated_header_rows: string[];
  note_rows: string[];
  context_rows: string[];
  review_rows: string[];
  row_role_overrides: Array<{
    row_id: string;
    program_hint: "header_candidate" | "data_candidate" | "context_candidate";
    selected_role: Exclude<TableStructureRowRole, "review">;
    reason: string;
  }>;
  continuation_caption_span_ids: string[];
  note_span_ids: string[];
  reason: string;
}

export interface TableStructurePlan {
  schema_version: typeof TABLE_STRUCTURE_SCHEMA_VERSION;
  source_version: string;
  evidence_fingerprint: string;
  tables: TableStructureDecision[];
}

export interface TableStructureIssue {
  code: string;
  path: string;
  message: string;
  details: Record<string, unknown>;
}

export function confirmedTableRowRoles(
  plan: TableStructurePlan | undefined,
  fragmentIds: readonly string[],
  manifest: EvidenceManifest,
  registry: SourceSpanRegistry,
): NonNullable<LogicalTableAssembly["row_roles"]> {
  const fragments = new Set(fragmentIds);
  return (plan?.tables ?? []).filter(table => table.status === "confirmed"
    && table.fragment_ids.every(id => fragments.has(id))
    && validateTableStructurePlan({ ...plan!, tables: [table] }, manifest, registry).length === 0).flatMap(table => (
    ([
      ["header", table.header_rows], ["data", table.data_rows],
      ["repeated_header", table.repeated_header_rows], ["note", table.note_rows],
      ["context", table.context_rows],
    ] as const).flatMap(([role, ids]) => ids.map(evidence_id => ({
      evidence_id, role,
      reason: table.row_role_overrides.find(override => override.row_id === evidence_id)?.reason ?? table.reason,
    })))
  ));
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function completeSpanId(
  evidenceId: string,
  manifest: EvidenceManifest,
  registry: SourceSpanRegistry,
): string {
  const evidence = manifest.evidence.find((record) => record.evidence_id === evidenceId);
  if (!evidence) return "";
  const matches = registry.spans.filter((span) =>
    span.evidence_id === evidenceId
    && span.start === 0
    && span.end === evidence.text.length
  );
  return matches.length === 1 ? matches[0]!.span_id : "";
}

/**
 * Structural fallback only: when the parser found no title candidate, the
 * domain Agent may explicitly select a complete paragraph from the same
 * immutable source atom as the table rows.  This does not infer that the
 * paragraph is a title; it only keeps that semantic decision in scope.
 */
export function fallbackTableTitleEvidenceIds(
  fragmentIds: readonly string[],
  manifest: EvidenceManifest,
): Set<string> {
  const fragmentById = new Map(manifest.table_fragments.map((fragment) => [fragment.fragment_id, fragment]));
  const evidenceById = new Map(manifest.evidence.map((record) => [record.evidence_id, record]));
  const fragments = fragmentIds.flatMap((fragmentId) => {
    const fragment = fragmentById.get(fragmentId);
    return fragment ? [fragment] : [];
  });
  if (fragments.some((fragment) => fragment.title_candidate_evidence_ids.length > 0)) return new Set();

  const memberAtomIds = new Set(fragments.flatMap((fragment) =>
    unique([
      ...(fragment.header_evidence_ids ?? []),
      ...(fragment.row_evidence_ids ?? []),
      ...(fragment.formal_row_evidence_ids ?? []),
    ]).flatMap((evidenceId) => {
      const atomId = evidenceById.get(evidenceId)?.atom_id;
      return atomId ? [atomId] : [];
    })
  ));
  if (memberAtomIds.size === 0) return new Set();

  return new Set(manifest.evidence.flatMap((record) =>
    record.kind === "paragraph"
    && Boolean(record.atom_id && memberAtomIds.has(record.atom_id))
    && Boolean(record.text.trim())
    && !/^\s*续表/u.test(record.text)
    && !/^\s*表@line(?::|-)/u.test(record.text)
      ? [record.evidence_id]
      : []
  ));
}

export function initialTableStructurePlan(
  manifest: EvidenceManifest,
  registry: SourceSpanRegistry,
): TableStructurePlan {
  const grouped = new Map<string, EvidenceManifest["table_fragments"]>();
  for (const fragment of manifest.table_fragments) {
    const key = fragment.provisional_table_id || fragment.fragment_id;
    grouped.set(key, [...(grouped.get(key) ?? []), fragment]);
  }
  const tables = [...grouped.entries()].map(([tableKey, fragments]) => {
    const rowIds = unique(fragments.flatMap((fragment) => fragment.row_evidence_ids));
    const titleSpans = unique(fragments.flatMap((fragment) =>
      fragment.title_candidate_evidence_ids.flatMap((evidenceId) => {
        const evidence = manifest.evidence.find((record) => record.evidence_id === evidenceId);
        return evidence?.role === "formal_table_title"
          && !/^\s*续表/u.test(evidence.text)
          && !/^\s*表@line(?::|-)/u.test(evidence.text)
          ? [completeSpanId(evidenceId, manifest, registry)]
          : [];
      })
    ).filter(Boolean));
    const continuationSpans = unique(fragments.flatMap((fragment) =>
      unique([
        ...(fragment.continuation_caption_evidence_ids ?? []),
        ...fragment.title_candidate_evidence_ids.filter((evidenceId) =>
          /^\s*续表/u.test(manifest.evidence.find((record) => record.evidence_id === evidenceId)?.text ?? "")
        ),
      ])
        .map((evidenceId) => completeSpanId(evidenceId, manifest, registry))
    ).filter(Boolean));
    return {
      table_key: tableKey,
      status: "review" as const,
      source_version: manifest.source.sha256,
      formal_title_span_ids: titleSpans.length === 1 ? titleSpans : [],
      fragment_ids: fragments.map((fragment) => fragment.fragment_id),
      header_rows: [],
      data_rows: [],
      repeated_header_rows: [],
      note_rows: [],
      context_rows: [],
      review_rows: rowIds,
      row_role_overrides: [],
      continuation_caption_span_ids: continuationSpans,
      note_span_ids: [],
      reason: "程序仅预填 fragment、题注候选和行角色导航；需根据单元格、合并关系、续表及表注明确确认。",
    } satisfies TableStructureDecision;
  });
  return {
    schema_version: TABLE_STRUCTURE_SCHEMA_VERSION,
    source_version: manifest.source.sha256,
    evidence_fingerprint: manifest.evidence_fingerprint,
    tables,
  };
}

export function validateTableStructurePlan(
  plan: TableStructurePlan,
  manifest: EvidenceManifest,
  registry: SourceSpanRegistry,
): TableStructureIssue[] {
  const issues: TableStructureIssue[] = [];
  if (plan.schema_version !== TABLE_STRUCTURE_SCHEMA_VERSION || plan.source_version !== manifest.source.sha256) {
    issues.push({
      code: "table_structure_source_version_mismatch",
      path: "/evidence_fingerprint",
      message: "表结构决定必须绑定当前不可变文档版本。",
      details: {
        actual: plan.source_version,
        expected: manifest.source.sha256,
        how_to_pass: "重新读取 table summary/rows，并从当前 source version 建立结构决定。",
        writable_path: "/evidence_fingerprint",
        next_tool: "read_table_summary",
      },
    });
    return issues;
  }
  const fragmentById = new Map(manifest.table_fragments.map((fragment) => [fragment.fragment_id, fragment]));
  const evidenceById = new Map(manifest.evidence.map((record) => [record.evidence_id, record]));
  const spanById = new Map(registry.spans.map((span) => [span.span_id, span]));
  const fragmentOwners = new Map<string, string[]>();
  plan.tables.forEach((table, tableIndex) => {
    const base = `/tables/${tableIndex}`;
    if (table.source_version !== manifest.source.sha256) issues.push({
      code: "table_structure_table_source_version_mismatch",
      path: `${base}/source_version`,
      message: "逻辑表决定必须绑定当前源文档 SHA，而不是会随引用扩展变化的 evidence fingerprint。",
      details: {
        table_key: table.table_key,
        actual: table.source_version,
        expected: manifest.source.sha256,
        writable_path: `${base}/source_version`,
        tool_writable_path: "table.source_version",
        next_tool: "read_table_summary",
        next_tool_arguments: { table_key: table.table_key },
        save_tool: "stage_table_structure",
        how_to_pass: "按 next_tool_arguments 读取这张表；保留返回的 saved_decision，只将其 source_version 改为同一回条顶层的 source_version，再以 {table: 完整决定} 调用 stage_table_structure。数组下标只用于诊断路径，定位及保存始终使用本条 table_key；不要修改其他表来消除本表的错误。",
        do_not_edit: "不可变原文、编译产物、其他 table_key 的决定，以及当前表已正确的行角色、题注和来源绑定。",
      },
    });
    table.fragment_ids.forEach((fragmentId) => {
      fragmentOwners.set(fragmentId, [...(fragmentOwners.get(fragmentId) ?? []), table.table_key]);
      if (!fragmentById.has(fragmentId)) issues.push({
        code: "table_structure_unknown_fragment",
        path: `${base}/fragment_ids`,
        message: "结构决定引用了不存在的物理 fragment。",
        details: { actual: fragmentId, how_to_pass: "从 list_table_fragments 复制 fragment_id。", writable_path: `${base}/fragment_ids`, next_tool: "list_table_fragments" },
      });
    });
    const allowedTitleEvidenceIds = new Set(table.fragment_ids.flatMap((fragmentId) =>
      fragmentById.get(fragmentId)?.title_candidate_evidence_ids ?? []
    ));
    const fallbackTitleEvidence = allowedTitleEvidenceIds.size === 0
      ? fallbackTableTitleEvidenceIds(table.fragment_ids, manifest)
      : new Set<string>();
    const allowedContinuationEvidenceIds = new Set(table.fragment_ids.flatMap((fragmentId) => {
      const fragment = fragmentById.get(fragmentId);
      return fragment ? unique([
        ...(fragment.continuation_caption_evidence_ids ?? []),
        ...fragment.title_candidate_evidence_ids.filter((evidenceId) =>
          /^\s*续表/u.test(evidenceById.get(evidenceId)?.text ?? "")
        ),
      ]) : [];
    }));
    table.formal_title_span_ids.forEach((spanId, spanIndex) => {
      const span = spanById.get(spanId);
      const evidence = span ? evidenceById.get(span.evidence_id) : undefined;
      if (
        span
        && evidence
        && (
          (allowedTitleEvidenceIds.has(evidence.evidence_id) && evidence.role === "formal_table_title")
          || fallbackTitleEvidence.has(evidence.evidence_id)
        )
        && !/^\s*续表/u.test(evidence.text)
        && !/^\s*表@line(?::|-)/u.test(evidence.text)
        && span.start === 0
        && span.end === evidence.text.length
      ) return;
      issues.push({
        code: "table_structure_formal_title_invalid",
        path: `${base}/formal_title_span_ids/${spanIndex}`,
        message: "有登记候选时，正式表题必须来自当前 fragment 的完整 title candidate；无登记候选时，可由模型从同一不可变来源原子选择完整非表格段落。表头、数据行、续表标记和占位符均不允许。",
        details: {
          actual: { span_id: spanId, evidence_id: span?.evidence_id ?? "", role: evidence?.role ?? "unknown", text: evidence && span ? evidence.text.slice(span.start, span.end) : "" },
          allowed_title_evidence_ids: [...allowedTitleEvidenceIds],
          fallback_title_evidence_ids: [...fallbackTitleEvidence],
          how_to_pass: allowedTitleEvidenceIds.size
            ? "从 read_table_summary 的正式题注候选选择完整 span；确认后把完整 table 决定交给 stage_table_structure 保存。"
            : "当前没有登记题注候选。读取相邻来源；若原文能证明某个同源完整段落是表题，选择其完整 span；若表格确实无题名则保持为空，禁止臆造。",
          writable_path: `${base}/formal_title_span_ids`,
          next_tool: allowedTitleEvidenceIds.size ? "read_table_summary" : "read_adjacent_source",
          next_tool_arguments: allowedTitleEvidenceIds.size ? { table_key: table.table_key } : { fragment_id: table.fragment_ids[0] ?? "" },
          next_tools: allowedTitleEvidenceIds.size
            ? ["read_table_summary", "stage_table_structure"]
            : ["read_adjacent_source", "stage_table_structure"],
          save_tool: "stage_table_structure",
        },
      });
    });
    table.continuation_caption_span_ids.forEach((spanId, spanIndex) => {
      const span = spanById.get(spanId);
      const evidence = span ? evidenceById.get(span.evidence_id) : undefined;
      if (
        span
        && evidence
        && allowedContinuationEvidenceIds.has(evidence.evidence_id)
        && /^\s*续表/u.test(evidence.text)
        && span.start === 0
        && span.end === evidence.text.length
      ) return;
      issues.push({
        code: "table_structure_continuation_invalid",
        path: `${base}/continuation_caption_span_ids/${spanIndex}`,
        message: "续表 provenance 必须来自当前逻辑表的完整续表题注，且不能充当第二正式表题。",
        details: { actual: { span_id: spanId, evidence_id: span?.evidence_id ?? "", text: evidence && span ? evidence.text.slice(span.start, span.end) : "" }, how_to_pass: "从 read_table_summary/read_adjacent_source 选择续表题注完整 span。", writable_path: `${base}/continuation_caption_span_ids`, next_tool: "stage_table_structure" },
      });
    });
    table.note_span_ids.forEach((spanId, spanIndex) => {
      const span = spanById.get(spanId);
      const evidence = span ? evidenceById.get(span.evidence_id) : undefined;
      if (span && evidence?.role === "table_note") return;
      issues.push({
        code: "table_structure_note_span_invalid",
        path: `${base}/note_span_ids/${spanIndex}`,
        message: "表注只接受已登记的 table_note 原文 span。",
        details: { actual: { span_id: spanId, evidence_id: span?.evidence_id ?? "", role: evidence?.role ?? "unknown" }, how_to_pass: "读取相邻来源并选择 table_note 的精确 span。", writable_path: `${base}/note_span_ids`, next_tool: "read_adjacent_source" },
      });
    });
    const rowCollections: Array<[TableStructureRowRole, string[]]> = [
      ["header", table.header_rows],
      ["data", table.data_rows],
      ["repeated_header", table.repeated_header_rows],
      ["note", table.note_rows],
      ["context", table.context_rows],
      ["review", table.review_rows],
    ];
    const expectedRows = unique(table.fragment_ids.flatMap((fragmentId) =>
      fragmentById.get(fragmentId)?.row_evidence_ids ?? []
    )).filter((evidenceId) => Boolean(evidenceById.get(evidenceId)?.text.trim()));
    const assignments = new Map<string, TableStructureRowRole[]>();
    rowCollections.forEach(([role, rowIds]) => rowIds.forEach((rowId) =>
      assignments.set(rowId, [...(assignments.get(rowId) ?? []), role])
    ));
    const missing = expectedRows.filter((rowId) => !assignments.has(rowId));
    const duplicates = [...assignments].filter(([, roles]) => roles.length !== 1)
      .map(([row_id, roles]) => ({ row_id, roles }));
    const foreign = [...assignments.keys()].filter((rowId) => !expectedRows.includes(rowId));
    if (missing.length || duplicates.length || foreign.length) issues.push({
      code: "table_structure_row_partition_invalid",
      path: base,
      message: "当前 fragment_ids 的每个非空物理行必须且只能属于一个行角色；表外来源不能放入任何 *_rows 数组。",
      details: {
        table_key: table.table_key,
        actual: { missing_rows: missing, duplicate_rows: duplicates, foreign_rows: foreign },
        readable_rows: unique([...missing, ...duplicates.map((row) => row.row_id), ...foreign]).flatMap((rowId) => {
          const row = evidenceById.get(rowId);
          return row ? [{ row_id: rowId, role: row.role, text: row.text, cells: row.cells ?? [], locator: row.locator }] : [];
        }),
        how_to_pass: [
          "先按 table_key 读取 read_table_summary 的 saved_decision 和 fragment 行目录，再按实际错误分别修正。",
          missing.length ? "missing_rows：依据原文把漏分的物理行放入且只放入一个 *_rows 数组；无法判断时暂放入 review_rows 并保持 status=review，封存前仍须明确角色。" : "",
          duplicates.length ? "duplicate_rows：核对列出的 roles，只保留一个有原文依据的行角色，移除同一行的其他重复分配。" : "",
          foreign.length ? "foreign_rows：从当前表所有 *_rows 数组移除这些表外来源；挪到 note_rows、context_rows 或 review_rows 仍不能通过。若来源已登记为 table_note 且原文支持它与本表关联，可用 locate_evidence_span 定位后保留或填写 note_span_ids，不能用 evidence_id 代替 span_id。移除误填的行角色不等于删除来源或其业务内容。" : "",
          "保留其他正确决定，以 {table: 完整决定} 调用 stage_table_structure，再重试原验证。",
        ].filter(Boolean).join(" "),
        writable_path: base,
        tool_writable_path: "table",
        next_tool: "read_table_summary",
        next_tool_arguments: { table_key: table.table_key },
        next_tools: ["read_table_summary", "locate_evidence_span", "stage_table_structure"],
        save_tool: "stage_table_structure",
        do_not_edit: "不可变原文和编译产物；不得为消错删除来源、selector 业务记录或其他 table_key 的决定。",
      },
    });
    const roleByRow = new Map([...assignments].flatMap(([rowId, roles]) =>
      roles.length === 1 ? [[rowId, roles[0]!] as const] : []
    ));
    const overrideByRow = new Map((table.row_role_overrides ?? []).map((override) => [override.row_id, override]));
    const requiredOverrides = expectedRows.flatMap((rowId) => {
      const record = evidenceById.get(rowId);
      const selectedRole = roleByRow.get(rowId);
      if (!record || !selectedRole || selectedRole === "review") return [];
      const programHint = record.role === "formal_table_header" ? "header_candidate" as const
        : record.table_row_kind === "data" ? "data_candidate" as const
        : "context_candidate" as const;
      const contradictsHint = programHint === "header_candidate"
        ? !["header", "repeated_header"].includes(selectedRole)
        : programHint === "data_candidate"
          ? ["header", "repeated_header"].includes(selectedRole)
          : false;
      if (!contradictsHint) return [];
      const override = overrideByRow.get(rowId);
      return override
        && override.program_hint === programHint
        && override.selected_role === selectedRole
        && override.reason.trim()
        ? []
        : [{ row_id: rowId, program_hint: programHint, selected_role: selectedRole, text: record.text, cells: record.cells ?? [], locator: record.locator }];
    });
    if (requiredOverrides.length) issues.push({
      code: "table_structure_program_hint_override_required",
      path: `${base}/row_role_overrides`,
      message: "程序行角色只是候选，可以推翻；但 confirmed 结构必须对每个反向分类逐行保存 override 理由，不能静默把表头变成数据行或反之。",
      details: {
        actual: requiredOverrides,
        how_to_pass: "若 program hint 正确，把行移回 header/repeated_header/data；若确需推翻，新增对应 row_role_overrides 并说明单元格、合并关系或相邻题注依据。",
        writable_path: `${base}/row_role_overrides`,
        next_tool: "stage_table_structure",
      },
    });
    const invalidOverrides = (table.row_role_overrides ?? []).filter((override) =>
      !expectedRows.includes(override.row_id)
      || roleByRow.get(override.row_id) !== override.selected_role
      || !override.reason.trim()
    );
    if (invalidOverrides.length) issues.push({
      code: "table_structure_role_override_invalid",
      path: `${base}/row_role_overrides`,
      message: "role override 必须指向当前逻辑表中的行，并与实际 selected_role 一致且有证据理由。",
      details: { actual: invalidOverrides, how_to_pass: "删除过期 override，或同步 row_id、selected_role 和理由。", writable_path: `${base}/row_role_overrides`, next_tool: "stage_table_structure" },
    });
    if (table.status === "confirmed" && table.review_rows.length > 0) issues.push({
      code: "table_structure_review_rows_pending",
      path: `${base}/review_rows`,
      message: "仍有无法确定结构角色的物理行，不能确认或封存。",
      details: {
        actual: table.review_rows.flatMap((rowId) => {
          const row = evidenceById.get(rowId);
          return row ? [{ row_id: rowId, text: row.text, cells: row.cells ?? [] }] : [{ row_id: rowId }];
        }),
        how_to_pass: "读取这些行及相邻来源，确认角色；确实无法唯一判断则保持 status=review。",
        writable_path: `${base}/status`,
        next_tool: "read_table_rows",
      },
    });
    if (table.status === "confirmed" && !table.reason.trim()) issues.push({
      code: "table_structure_reason_missing",
      path: `${base}/reason`,
      message: "确认结构必须说明题注、表头、续表和数据行的判断依据。",
      details: { actual: table.reason, how_to_pass: "填写基于单元格内容和相邻题注的简短理由。", writable_path: `${base}/reason`, next_tool: "stage_table_structure" },
    });
  });
  for (const [fragmentId, owners] of fragmentOwners) {
    if (owners.length <= 1) continue;
    issues.push({
      code: "table_structure_fragment_overlap",
      path: "/tables",
      message: "一个物理 fragment 不能同时属于多个逻辑表。",
      details: { actual: { fragment_id: fragmentId, table_keys: owners }, how_to_pass: "只保留一个逻辑表归属；无法判断时保留一个 review 决定。", writable_path: "/tables", next_tool: "stage_table_structure" },
    });
  }
  return issues;
}

export function pendingComplexTableStructureIssues(
  plan: TableStructurePlan,
  manifest: EvidenceManifest,
): TableStructureIssue[] {
  return plan.tables.flatMap((table, index) => {
    const dataRowCount = unique(table.fragment_ids.flatMap((fragmentId) =>
      manifest.table_fragments.find((fragment) => fragment.fragment_id === fragmentId)?.row_evidence_ids ?? []
    )).filter((evidenceId) => manifest.evidence.find((record) => record.evidence_id === evidenceId)?.table_row_kind === "data").length;
    if (dataRowCount <= 1 || table.status === "confirmed") return [];
    return [{
      code: "table_structure_confirmation_pending",
      path: `/table_structure/tables/${index}/status`,
      message: "复杂多行表格的结构决定仍为 review；不得进入 commit/seal。",
      details: {
        table_key: table.table_key,
        fragment_ids: table.fragment_ids,
        data_row_count: dataRowCount,
        unresolved_row_ids: table.review_rows,
        actual: table.status,
        how_to_pass: "先按 table_key 读取 read_table_summary 的完整 saved_decision，再用 read_table_rows/相邻来源核对行角色，以 {table: 完整决定} 调用 stage_table_structure。status=confirmed 只确认结构，不表示该表属于当前业务，也不自动建项。若原文支持某些行只作当前 target 的上下文，可选择 context_rows，并为与 program_hint 不同的角色填写 row_role_overrides 的原文理由；业务来源未采用的部分仍通过 source_dispositions 明确处置。程序不替模型决定适用性；无法唯一判断则保持 review 并停止封存。",
        writable_path: `/tables/${index}`,
        next_tool: "read_table_summary",
        next_tool_arguments: { table_key: table.table_key },
        next_tools: ["read_table_summary", "read_table_rows", "read_adjacent_source", "stage_table_structure", "stage_target_selector_draft"],
        save_tool: "stage_table_structure",
      },
    }];
  });
}

export function tableStructureFingerprint(plan: TableStructurePlan): string {
  return sha256Json(plan);
}

/** Progress identity only. Explanations and set ordering do not constitute a
 * new structural decision; invalid or unconfirmed records grant no progress. */
export function tableStructureProgress(plan: TableStructurePlan, manifest: EvidenceManifest, registry: SourceSpanRegistry) {
  const issues = validateTableStructurePlan(plan, manifest, registry);
  const tables = plan.tables.filter((table, index) => table.status === "confirmed"
    && !issues.some(issue => !issue.path.startsWith("/tables/")
      || issue.path === `/tables/${index}` || issue.path.startsWith(`/tables/${index}/`)))
    .map(({ reason: _reason, row_role_overrides, ...table }) => ({
      ...Object.fromEntries(Object.entries(table).map(([key, value]) => [key,
        Array.isArray(value) ? [...new Set(value)].sort() : value])),
      table_key: table.table_key,
      row_role_overrides: row_role_overrides.map(({ reason: _reason, ...row }) => row)
        .sort((left, right) => left.row_id.localeCompare(right.row_id)),
    })).sort((left, right) => String(left.table_key).localeCompare(String(right.table_key)));
  return { fingerprint: tables.length ? sha256Json(tables) : "",
    confirmed_keys: tables.map(table => String(table.table_key)) };
}
