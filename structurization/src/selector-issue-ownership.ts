import { ACCEPTANCE_NAME_REVIEW_PREFIX, canAnchorStaticTableReference, COMPACT_PLAN_SCHEMA_VERSION, referenceOccurrenceLiteralSpanIds, referenceOccurrenceOriginEvidenceIds } from "./contracts.js";
import type {
  AcceptanceItemField,
  EvidenceManifest,
  PersistedSemanticSourcePlan,
  ValidationIssue,
} from "./contracts.js";
import { ensureActionableIssue } from "./actionable-error.js";
import {
  semanticItemIdForSelectorKey,
  semanticLotIdForSelectorKey,
  semanticResolutionIdForSelectorKey,
} from "./semantic-decision-compiler.js";
import type { SourceSpanRegistry } from "./source-span-registry.js";
import type { TargetSelectorPlan } from "./target-selector-compiler.js";

export type SelectorIssueOwner =
  | "selector_input_error"
  | "compiler_invariant_violation"
  | "final_contract_violation"
  | "coverage_finding";

export type SelectorIssueStage =
  | "selector-local"
  | "compiler-invariant"
  | "strict-validator"
  | "coverage-review";

export interface OwnedSelectorIssue extends ValidationIssue {
  owner: SelectorIssueOwner;
}

export { ACCEPTANCE_NAME_REVIEW_PREFIX } from "./contracts.js";
export const SOURCE_LANGUAGE_REVIEW_PREFIX = ACCEPTANCE_NAME_REVIEW_PREFIX;
export const REFERENCE_ORIGIN_CONTEXT_SCOPE_GUIDANCE = "本 reference_origin_relation 诊断检查 item 来源归属及所有可见字段片段的并集，不要求把来源放进某个指定字段。occurrence.origin_fields 不限制本诊断的上下文显示字段，不能据此推断必须写 method 或需要上游改不可变 occurrence；具体字段仍由作者按原文判断。origin_binding、destinations 和导入范围的其他约束独立校验，本说明不授予它们通过。历史诊断不表示修改后的记录仍有同一错误，先读取当前准确作者记录；已保存的真实修复最终由完整检查判定。";
export const REFERENCE_IMPORT_SCOPE_REPAIR_GUIDANCE = "当前引用的授权按它选中的目标 evidence 在接收项字段及 sampling 中实际被使用的范围检查，allowed_fields 不是 destinations 或锚点字段的副本。各引用独立核对：另一条引用的授权或接收路由，不会替当前引用授权，也不会从当前引用选中的 evidence 集合扣除相同来源的实际用途。quantity 与 sampling 是独立授权：同一数量来源同时用于数量显示和抽样决定时，quantity 授权不隐含 sampling 授权；仍须分别核对实际用途。按原文在三种合法修法中选择：精确补缺失授权、纠正误用字段，或纠正当前引用过宽的 target_span_ids 并同步 component_dispositions，保留其他引用合法承载的字段。只改 reason、component_dispositions 或 destinations 不会移除 item 中仍实际使用的来源。补齐授权不要求新增 destination；不得为去重机械缩小仍需的授权、扩大为 all_fields 或删除合法内容。该合同不指定应选目标子集，历史问题代码不表示当前仍有同一错误；读取当前作者记录、保存有原文依据的真实修复后再完整验证。";
export const INSPECTION_DATA_TYPE_SOURCE_REPAIR_GUIDANCE = "inspection_data_type 仅允许 measurement/counting/mixed/review；由模型依据原文判断，不能仅为消错改类型。inspection_data_type_span_ids 是作者字段，完整检查要求至少一条已登记且真实支持本项分类的精确来源；需要时先读取原文再用 locate_evidence_span 登记。修改分类、inspection_data_type_reason 与支撑 span 必须保持一致，以 stage_target_selector_draft upsert 完整记录，保留其他正确字段。尚未核实来源时继续调查或保留检查点报告实际缺失，不能伪造来源或封存。不得填写编译字段 inspection_data_type_evidence_ids。该通用合同不指定业务类型或来源，不证明当前记录仍有历史错误；先读取当前 keyed 记录。";

const REFERENCE_AUTHORIZATION_ROUTE_INSTRUCTION = "import_scope.allowed_fields 是允许实际使用被引内容的字段范围，destinations 才是当前引用的接收路由；补齐授权不要求新增 destination。另一条显式引用已向同一 item.field 路由相同证据时，不要为使两份列表一致而重复添加路由，也不要仅为去重缩小仍被实际使用的授权。";

export interface SourceLanguageReviewMarker {
  path: string;
  item_key: string;
  original_name: string;
  /** Legacy field name: new markers retain the reviewed business name unchanged. */
  marked_name: string;
}

export interface VerdictNameReviewMarker extends SourceLanguageReviewMarker {
  signals: string[];
}

interface NameReviewPolicyResult<TMarker extends SourceLanguageReviewMarker> {
  selectors: TargetSelectorPlan;
  correction_attempts: Record<string, string>;
  markers: TMarker[];
}

/**
 * One blocking correction round per issue path, then an internal review mark:
 * the first report records the selector fingerprint; a changed resubmission
 * that still carries the same finding is recorded without rewriting the name,
 * while an unchanged resubmission stays blocked without spending more rounds.
 */
function applyRepeatedNameReviewPolicy<TMarker extends SourceLanguageReviewMarker>(
  selectors: TargetSelectorPlan,
  issues: readonly ValidationIssue[],
  correctionAttempts: Readonly<Record<string, string>>,
  selectorFingerprint: string,
  code: string,
  buildMarker: (path: string, itemKey: string, originalName: string, issue: ValidationIssue) => TMarker,
  reportedIssueCount: number,
): NameReviewPolicyResult<TMarker> {
  const nextSelectors = structuredClone(selectors);
  const nextAttempts = { ...correctionAttempts };
  const markers: TMarker[] = [];
  const reportedPaths = new Set(
    issues.slice(0, reportedIssueCount)
      .filter((issue) => issue.code === code)
      .map((issue) => issue.path),
  );
  const seenPaths = new Set<string>();
  for (const issue of issues) {
    if (issue.code !== code || seenPaths.has(issue.path)) continue;
    const match = /^\/items\/(\d+)\/name$/u.exec(issue.path);
    if (!match) continue;
    seenPaths.add(issue.path);
    const item = nextSelectors.items[Number(match[1])];
    if (!item) continue;
    const previousFingerprint = nextAttempts[issue.path];
    if (previousFingerprint && previousFingerprint !== selectorFingerprint) {
      markers.push(buildMarker(issue.path, item.key, item.name, issue));
      continue;
    }
    if (!previousFingerprint && reportedPaths.has(issue.path)) {
      nextAttempts[issue.path] = selectorFingerprint;
    }
  }
  return {
    selectors: nextSelectors,
    correction_attempts: nextAttempts,
    markers,
  };
}

export function applyRepeatedSourceLanguageNamePolicy(
  selectors: TargetSelectorPlan,
  issues: readonly ValidationIssue[],
  correctionAttempts: Readonly<Record<string, string>>,
  selectorFingerprint: string,
  reportedIssueCount = 8,
): NameReviewPolicyResult<SourceLanguageReviewMarker> {
  return applyRepeatedNameReviewPolicy(
    selectors,
    issues,
    correctionAttempts,
    selectorFingerprint,
    "selector_source_language_mismatch",
    (path, item_key, original_name) => ({
      path,
      item_key,
      original_name,
      marked_name: original_name,
    }),
    reportedIssueCount,
  );
}

export function applyRepeatedVerdictNamePolicy(
  selectors: TargetSelectorPlan,
  issues: readonly ValidationIssue[],
  correctionAttempts: Readonly<Record<string, string>>,
  selectorFingerprint: string,
  reportedIssueCount = 8,
): NameReviewPolicyResult<VerdictNameReviewMarker> {
  return applyRepeatedNameReviewPolicy(
    selectors,
    issues,
    correctionAttempts,
    selectorFingerprint,
    "selector_name_verdict_sentence",
    (path, item_key, original_name, issue) => ({
      path,
      item_key,
      original_name,
      marked_name: original_name,
      signals: (() => {
        const signals = (issue.details as { signals?: unknown } | undefined)?.signals;
        return Array.isArray(signals)
          ? signals.filter((signal): signal is string => typeof signal === "string")
          : [];
      })(),
    }),
    reportedIssueCount,
  );
}

const MECHANICAL_STRICT_CODES = new Set([
  "schema",
  "unhandled_evidence",
  "semantic_continuation_relation",
  "semantic_continuation_not_merged",
  "semantic_referenced_clause_parent",
  "semantic_reference_anchor_role",
  "semantic_reference_destination_missing",
  "semantic_reference_target_role",
  "semantic_reference_not_materialized",
]);

const HARNESS_OWNED_SELECTOR_CODES = new Set([
  "selector_evidence_mismatch",
  "selector_registry_mismatch",
]);

const ACTIONABLE_COMPILER_INPUT_CODES = new Set([
  "compiler_unhandled_evidence",
  "compiler_semantic_item_fragment_not_materialized",
  "compiler_semantic_primary_atom_unclassified",
  "compiler_semantic_reference_destination_missing",
  "compiler_semantic_reference_empty_expansion",
  "compiler_semantic_reference_unresolved",
  "compiler_semantic_reference_unresolved_targets",
  "compiler_duplicate_table_title_fragment",
  "compiler_table_assembly_evidence_out_of_scope",
]);

const SOURCE_DISPOSITION_REPAIR_CODES = new Set([
  "unhandled_evidence",
  "compiler_unhandled_evidence",
  "agent_primary_atom_unhandled",
  "compiler_semantic_primary_atom_unclassified",
]);

export function isSourceDispositionRepairIssueCode(code: string): boolean {
  return SOURCE_DISPOSITION_REPAIR_CODES.has(code);
}

const ACTIONABLE_COMPILER_DEFAULT_SELECTOR: Record<string, {
  path: string;
  writable_collection: string;
  required_action: string;
}> = {
  compiler_semantic_item_fragment_not_materialized: {
    path: "/items",
    writable_collection: "items",
    required_action: "bind_the_exact_semantic_fragment_to_this_item_criterion_and_one_visible_field",
  },
  compiler_semantic_reference_destination_missing: {
    path: "/references",
    writable_collection: "references",
    required_action: "bind_resolved_reference_destinations_or_change_review_action",
  },
  compiler_semantic_reference_empty_expansion: {
    path: "/references",
    writable_collection: "references",
    required_action: "select_resolved_target_spans_or_change_review_action",
  },
  compiler_semantic_reference_unresolved: {
    path: "/references",
    writable_collection: "references",
    required_action: "change_review_to_an_applicable_resolved_reference_action_or_remove_unproven_targets",
  },
  compiler_semantic_reference_unresolved_targets: {
    path: "/references",
    writable_collection: "references",
    required_action: "change_review_to_an_applicable_resolved_reference_action_or_remove_unproven_targets",
  },
  compiler_duplicate_table_title_fragment: {
    path: "/items",
    writable_collection: "items",
    required_action: "select_distinct_registered_title_candidate_spans_for_this_table",
  },
  compiler_table_assembly_evidence_out_of_scope: {
    path: "/items",
    writable_collection: "items",
    required_action: "select_only_table_evidence_attached_to_this_items_physical_fragments",
  },
};

const PLACEHOLDER_COVERAGE_CODES = new Set([
  "reference_placeholder_item_coverage_missing",
  "reference_placeholder_table_leaf_missing",
]);

const AUTHORED_REFERENCE_SELECTOR_CODES = new Set([
  "reference_destination_required",
  "reference_resolved_target_required",
  "reference_scalar_target_count",
  "reference_literal_retained",
  "reference_destination_field_mismatch",
  "reference_placeholder_item_coverage_missing",
  "reference_placeholder_table_leaf_missing",
  "reference_placeholder_has_item_destination",
  "reference_placeholder_requires_resolved_reference",
]);

function issueDetailsRecord(issue: { details?: unknown }): Record<string, unknown> {
  return issue.details && typeof issue.details === "object" && !Array.isArray(issue.details)
    ? issue.details as Record<string, unknown>
    : {};
}

function evidenceIdsFromIssue(issue: { details?: unknown }): string[] {
  const details = issueDetailsRecord(issue);
  const nested = details.actual && typeof details.actual === "object" && !Array.isArray(details.actual)
    ? details.actual as Record<string, unknown>
    : {};
  const ids: string[] = [];
  for (const bag of [details, nested]) {
    if (typeof bag.evidence_id === "string" && bag.evidence_id) ids.push(bag.evidence_id);
    if (Array.isArray(bag.evidence_ids)) {
      for (const entry of bag.evidence_ids) {
        if (typeof entry === "string" && entry) ids.push(entry);
      }
    }
  }
  return [...new Set(ids)];
}

function remapSourceDispositionIssue(
  selectors: TargetSelectorPlan | undefined,
  registry: SourceSpanRegistry | undefined,
  issue: { code: string; path: string; message: string; details?: unknown },
): OwnedSelectorIssue {
  const details = issueDetailsRecord(issue);
  const evidenceIds = evidenceIdsFromIssue(issue);
  const registeredById = new Map((registry?.spans ?? []).map((span) => [span.span_id, span]));
  const candidateSpans = evidenceIds.flatMap((evidenceId) =>
    (registry?.spans ?? [])
      .filter((span) => span.evidence_id === evidenceId)
      .map((span) => ({
        span_id: span.span_id,
        evidence_id: span.evidence_id,
        atom_id: span.atom_id,
        start: span.start,
        end: span.end,
      }))
  );
  let selectorPath = "/source_dispositions";
  if (selectors && evidenceIds.length === 1) {
    const evidenceId = evidenceIds[0]!;
    const matchingDispositionIndex = (selectors.source_dispositions ?? []).findIndex((disposition) =>
      disposition.span_ids.some((spanId) => registeredById.get(spanId)?.evidence_id === evidenceId)
    );
    if (matchingDispositionIndex >= 0) selectorPath = `/source_dispositions/${matchingDispositionIndex}`;
  }
  const compilerUnhandled = issue.code === "compiler_unhandled_evidence";
  const sourceUnhandled = isSourceDispositionRepairIssueCode(issue.code);
  const referenceAnchorBindings = sourceUnhandled
    ? (selectors?.references ?? []).flatMap((reference, referenceIndex) =>
      reference.anchor_span_ids.flatMap((spanId, spanIndex) => {
        const span = registeredById.get(spanId);
        return span && evidenceIds.includes(span.evidence_id) ? [{
          reference_key: reference.key,
          evidence_id: span.evidence_id,
          span_id: spanId,
          path: `/references/${referenceIndex}/anchor_span_ids/${spanIndex}`,
        }] : [];
      })
    )
    : [];
  const authorFieldBindings = sourceUnhandled
    ? (selectors?.items ?? []).flatMap((item, itemIndex) =>
      Object.entries(item.fields ?? {}).flatMap(([field, binding]) => binding.span_ids.flatMap((spanId, spanIndex) => {
        const span = registeredById.get(spanId);
        return span && evidenceIds.includes(span.evidence_id) ? [{ item_key: item.key, field,
          composition: binding.composition, evidence_id: span.evidence_id, span_id: spanId,
          path: `/items/${itemIndex}/fields/${field}/span_ids/${spanIndex}`,
          item_basis_contains_source: [...(item.criterion_span_ids ?? []), ...(item.continuation_span_ids ?? [])]
            .some(id => registeredById.get(id)?.evidence_id === span.evidence_id),
        }] : [];
      }))
    ) : [];
  return {
    ...issue,
    ...(compilerUnhandled ? {
      message: "编译器未能物化所有必须处理的来源；请依据原文补齐真实业务绑定或显式来源处置。",
    } : {}),
    path: selectorPath,
    details: {
      ...details,
      compiled_path: issue.path,
      ...(evidenceIds.length ? { evidence_ids: evidenceIds } : {}),
      ...(registry ? { candidate_span_ids: candidateSpans.map((span) => span.span_id) } : {}),
      ...(sourceUnhandled ? {
        actual: { evidence_ids: evidenceIds, candidate_spans: candidateSpans, reference_anchor_bindings: referenceAnchorBindings,
          ...(authorFieldBindings.length ? { author_field_bindings: authorFieldBindings } : {}) },
        expected: { explicit_compiled_disposition: "used_with_real_receiver_or_explicit_context_or_ignored" },
        writable_paths: ["/items", "/sampling_rules", "/references", "/lots", "/source_dispositions"],
        writable_collections: ["items", "sampling_rules", "references", "lots", "source_dispositions"],
        allowed_actions: [
          "若模型依据原文确认来源包含真实业务内容，将所选 span 绑定到既有或真实 item、sampling_rules 或 references 的实际适用字段。",
          "若模型依据原文确认来源仅是实际验收范围或分组依据，读取完整 lot 后把精确 span 保留在 lots[].scope_span_ids；不能替代叶项实际字段中的适用条件、共同义务或验收判据，也不能仅凭栏目标题另造检验批。",
          "若模型依据原文确认来源确为非业务上下文，按 source_disposition_schema 在 draft.source_dispositions 中显式登记 context 或 ignored 及理由。",
        ],
        binding_requirement: "来源须按原文进入接收项实际业务字段或被采用的抽样组件；仅用于实际组织范围或分组的来源可以绑定 lots[].scope_span_ids；其他非业务来源由作者显式 source_disposition 处置。父级范围不能替代叶项的条件、共同义务或判据。actual.reference_anchor_bindings 列出当前已保存的引用锚点；仅有 anchor_span_ids 或 origin_binding 定位，不代表该来源已进入接收项。依据原文核对实际业务字段或被接收项采用的抽样规则，不要重复追加已保存的锚点，也不要把业务来源改成 context/ignored 来消错。",
        ...(authorFieldBindings.length ? {
          saved_field_binding_instruction: "actual.author_field_bindings 是已经保存的真实字段路径，不是建议接收者，重复保存相同 span 或只改 reason 不会补来源归属。reference 字段中的 span 若既未进入该 item 的真实 criterion/continuation 来源，也不是该 item 已注册引用的本地 origin 或实际路由目标，不会仅因显示在字段里就成为编译来源。由模型核对原文：仅本地字段时选择符合原文的非 reference composition；确实混合被引内容时保留实际 reference 路由，并按原文补该 item 的真实来源归属。不得伪造 criterion、引用 origin、destination，或把真实业务来源降成背景。",
          affected_author_reads: [...new Set(authorFieldBindings.map(binding => binding.item_key))]
            .map(key => ({ tool: "read_target_selectors", arguments: { collection: "items", key } })),
        } : {}),
        source_disposition_schema: {
          required: ["span_ids", "disposition", "reason"],
          span_ids: "已登记 span_id 的非空数组",
          disposition: ["context", "ignored"],
          reason: "依据已打开原文填写的非空语义理由",
          additional_properties: false,
        },
        repair_identity: {
          kind: "evidence_id",
          evidence_ids: evidenceIds,
        },
        post_save_verification: {
          tool: "advance_target_selector_stage",
          same_identity_meaning: "若保存后同一 evidence_id 再次出现，表示该来源仍未形成有效的来源处置，不表示 span 没有保存。核对 actual.reference_anchor_bindings 和 binding_requirement；仅有引用定位不保证业务来源已进入接收项。",
          required_action: "重新核对 actual.evidence_ids 与 actual.candidate_spans，及已有 author_field_bindings；只修改模型依据原文选择的真实业务绑定、仅组织范围的 lots[].scope_span_ids 或该 evidence 的显式 source_disposition。逐条及时保存并处理当前已知诊断组，table/commit 可用 get_target_context({source_repair_cursor:0}) 只读刷新有限诊断；完成已知修复后才重试原完整验证，有限诊断为空不表示完整通过。",
        },
        // This pure classifier has no access-policy state. The controller replaces
        // this directory fallback with exact per-source routes before returning it.
        candidate_read_tools: ["list_evidence_resources", "read_target_selectors", "locate_evidence_span"],
        next_tool: "list_evidence_resources",
        next_tool_arguments: { cursor: 0, limit: 100 },
        next_tools: ["list_evidence_resources", "read_target_selectors", "locate_evidence_span", "stage_target_selector_draft"],
        tool_argument_hints: {
          list_evidence_resources: { cursor: 0, limit: 100 },
          read_target_selectors: [
            { collection: "items" },
            { collection: "sampling_rules" },
            { collection: "references" },
            { collection: "lots" },
            { collection: "source_dispositions", evidence_ids: evidenceIds },
          ],
        },
        author_record_read_policy: "作者集合读取参数是按模型所选修法使用的备选入口，不是要求依次通读四个集合。",
        save_tool: "stage_target_selector_draft",
        save_tool_instruction: "用 stage_target_selector_draft 的 operation=upsert 保存完整记录；仅组织范围应读取完整 lot 并保存精确 scope_span_ids，不能代替叶项条件、共同义务或判据；来源处置集合必须放在 draft.source_dispositions 内。span_ids 只能使用模型从已打开来源中选择的登记 span；disposition 由模型依据原文在 context/ignored 中选择，reason 填写真实语义依据。不要把说明文字当作参数值。",
        how_to_pass: "先按 next_tool_arguments 读取；若有 source_access，严格按 source_access 中每项的 read_tool 和 tool_arguments 读取对应来源，否则先从 list_evidence_resources 的目录取得 access_mode/read_tool，不能把所有来源交给 open_evidence。核对 actual.evidence_ids 与 candidate_spans；原文打开后才可用 locate_evidence_span 定位精确原文。由模型仅依据原文选择与来源含义一致的合法路径，再按所选修法读取相关作者记录，不要求依次通读四个集合：(1) 真实业务来源先读取要修改的 items、sampling_rules 或 references 完整记录，将所选 span 绑定到实际适用字段并满足 binding_requirement；(2) 仅组织范围可按 key 读取完整 lot 后保存 draft.lots.scope_span_ids；(3) 确为非业务上下文时，仅按点名 evidence_ids 核对现有 source_dispositions，再按 source_disposition_schema 用 stage_target_selector_draft 在 draft.source_dispositions 中增量保存完整处置。tool_argument_hints 中的集合是备选入口，当前来源不涉及的集合和已读且未变的正确记录不用重复读取。回条不替模型决定来源含义、接收项、字段或处置值。确认一条真实修复就及时保存并继续当前已知诊断组；table/commit 可用 get_target_context({source_repair_cursor:0}) 只读刷新有限诊断，有限诊断为空不表示完整通过。完成已知修复后才重新执行原完整验证，不要逐条保存后逐条重检；若同一 evidence_id 再次出现，核对已保存字段、引用定位与实际接收来源之间的差别，不要重复追加锚点或转而修改其他来源。",
        do_not_edit: "不可变原文、编译生成的 evidence_dispositions、未列入 actual.evidence_ids 的其他来源或无关且已正确的 selector 记录。",
      } : {}),
      writable_collection: "source_dispositions",
      candidate_read_tool: sourceUnhandled ? "list_evidence_resources" : "open_evidence",
      next_tool: sourceUnhandled ? "list_evidence_resources" : "stage_target_selector_draft",
      required_action: "bind_semantically_or_stage_an_explicit_source_disposition",
    } as OwnedSelectorIssue["details"],
    owner: "selector_input_error",
  };
}

const MECHANICAL_STRICT_PREFIXES = [
  "duplicate_",
  "evidence_",
  "field_",
  "inspection_lot_",
  "item_",
  "logical_table_",
  "missing_",
  "reference_",
  "sampling_",
  "semantic_",
  "table_",
  "unknown_",
];

export function classifySelectorIssue(
  stage: SelectorIssueStage,
  raw: { code: string; path: string; message: string; details?: unknown; selector_path?: string },
): OwnedSelectorIssue {
  const issue: OwnedSelectorIssue = {
    ...ensureActionableIssue(raw),
    owner: "selector_input_error",
  };
  if (raw.selector_path) (issue as { selector_path?: string }).selector_path = raw.selector_path;
  if (stage === "selector-local") {
    return {
      ...issue,
      owner: HARNESS_OWNED_SELECTOR_CODES.has(issue.code)
        ? "compiler_invariant_violation"
        : "selector_input_error",
    };
  }
  if (stage === "compiler-invariant") {
    const selectorPath = (issue as { selector_path?: unknown }).selector_path;
    if (SOURCE_DISPOSITION_REPAIR_CODES.has(issue.code) && typeof selectorPath !== "string") {
      return remapSourceDispositionIssue(undefined, undefined, issue);
    }
    const defaultSelector = ACTIONABLE_COMPILER_DEFAULT_SELECTOR[issue.code];
    const faithfulTitleProjection = ["compiler_table_title_fragment_mismatch", "compiler_noncanonical_table_title"].includes(issue.code)
      && typeof selectorPath === "string"
      && issue.details !== null
      && typeof issue.details === "object"
      && !Array.isArray(issue.details)
      && (issue.details as { faithful_selector_projection?: unknown }).faithful_selector_projection === true;
    const owner = ACTIONABLE_COMPILER_INPUT_CODES.has(issue.code) || faithfulTitleProjection
      ? "selector_input_error" as const
      : "compiler_invariant_violation" as const;
    if (owner === "selector_input_error" && typeof selectorPath === "string") {
      return {
        ...issue,
        path: selectorPath,
        details: {
          required_action: issue.details.required_action,
          ...(issue.details && typeof issue.details === "object" && !Array.isArray(issue.details)
            ? issue.details
            : {}),
          compiled_path: issue.path,
        },
        owner,
      };
    }
    if (owner === "selector_input_error" && defaultSelector) {
      return {
        ...issue,
        path: defaultSelector.path,
        details: {
          ...issueDetailsRecord(issue),
          compiled_path: issue.path,
          writable_collection: defaultSelector.writable_collection,
          required_action: defaultSelector.required_action,
          next_tool: "stage_target_selector_draft",
        },
        owner,
      };
    }
    return { ...issue, owner };
  }
  if (stage === "coverage-review") return { ...issue, owner: "coverage_finding" };
  // Authored reference mistakes must bounce to the writable selector. Do not let
  // the mechanical reference_* prefix terminalize them as compiler defects when
  // the v8 plan is absent or the occurrence cannot be matched.
  if (AUTHORED_REFERENCE_SELECTOR_CODES.has(issue.code)) {
    return { ...issue, owner: "selector_input_error" };
  }
  const mechanical = MECHANICAL_STRICT_CODES.has(issue.code)
    || MECHANICAL_STRICT_PREFIXES.some((prefix) => issue.code.startsWith(prefix));
  return {
    ...issue,
    owner: mechanical ? "compiler_invariant_violation" : "final_contract_violation",
  };
}

export function classifySelectorIssues(
  stage: SelectorIssueStage,
  issues: ReadonlyArray<{ code: string; path: string; message: string; details?: unknown; selector_path?: string }>,
): OwnedSelectorIssue[] {
  return issues.map((issue) => classifySelectorIssue(stage, issue));
}

export function classifyCompilerInvariantIssues(
  selectors: TargetSelectorPlan,
  registry: SourceSpanRegistry,
  issues: ReadonlyArray<{ code: string; path: string; message: string; details?: unknown; selector_path?: string }>,
): OwnedSelectorIssue[] {
  return issues.map((issue) => (
    SOURCE_DISPOSITION_REPAIR_CODES.has(issue.code)
      ? remapSourceDispositionIssue(selectors, registry, issue)
      : classifySelectorIssue("compiler-invariant", issue)
  ));
}

const STRICT_FIELD_RELATION_CODES = new Set([
  "field_binding_relation",
  "field_binding_reference_route",
]);

const STRICT_TABLE_PATH_CODES = new Set([
  "table_semantic_path_missing",
]);

const STRICT_SAMPLING_ROUTE_CODES = new Set([
  "sampling_non_rule_evidence",
  "explicit_sampling_without_specific_evidence",
]);

const ACCEPTANCE_ITEM_FIELDS = new Set<AcceptanceItemField>([
  "name",
  "requirement",
  "method",
  "quantity",
  "note",
]);

interface AuthoredFieldProjection {
  composition: string;
  span_ids: string[];
  span_path: string;
  destination_path?: string;
}

function authoredFieldProjection(
  selectors: TargetSelectorPlan,
  selectorItemIndex: number,
  field: AcceptanceItemField,
): AuthoredFieldProjection {
  const item = selectors.items[selectorItemIndex]!;
  let projection: AuthoredFieldProjection = {
    composition: item.fields[field].composition,
    span_ids: [...item.fields[field].span_ids],
    span_path: `/items/${selectorItemIndex}/fields/${field}/span_ids`,
  };
  if (item.table?.source_kind === "reference") return projection;
  selectors.references.forEach((reference, referenceIndex) => {
    if ((reference.application_mode as string) !== "replace_field") return;
    reference.destinations.forEach((destination, destinationIndex) => {
      if (destination.item_key !== item.key || destination.target_field !== field) return;
      projection = {
        composition: "reference",
        span_ids: [...reference.target_span_ids],
        span_path: `/references/${referenceIndex}/target_span_ids`,
        destination_path: `/references/${referenceIndex}/destinations/${destinationIndex}/target_field`,
      };
    });
  });
  return projection;
}

function intervalKey(span: { evidence_id: string; start: number; end: number }): string {
  return `${span.evidence_id}\0${span.start}\0${span.end}`;
}

function sameIntervals(left: readonly string[], right: readonly string[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

function compiledResolutionAt(
  compiled: PersistedSemanticSourcePlan,
  path: string,
  suffix: string,
): PersistedSemanticSourcePlan["reference_resolutions"][number] | undefined {
  const match = new RegExp(`^/reference_resolutions/(\\d+)/${suffix}$`, "u").exec(path);
  return compiled.reference_resolutions[Number(match?.[1] ?? -1)];
}

function selectorReferenceIndexByOccurrence(
  selectors: TargetSelectorPlan,
  occurrenceId: string | undefined,
): number {
  if (!occurrenceId) return -1;
  return selectors.references.findIndex((reference) => reference.occurrence_id === occurrenceId);
}

function remapAuthoredReferenceIssue(
  issue: ValidationIssue,
  path: string,
  occurrenceId: string,
  requiredAction: string,
): OwnedSelectorIssue {
  return {
    ...issue,
    path,
    details: {
      ...issueDetailsRecord(issue),
      compiled_path: issue.path,
      occurrence_id: occurrenceId,
      writable_collection: "references",
      required_action: requiredAction,
    } as OwnedSelectorIssue["details"],
    owner: "selector_input_error",
  };
}

function compilerDroppedReferenceBinding(issue: ValidationIssue): OwnedSelectorIssue {
  return {
    ...classifySelectorIssue("strict-validator", issue),
    owner: "compiler_invariant_violation",
  };
}

/**
 * A strict relation error is selector-owned only when the persisted compiler
 * output is an exact interval-for-interval projection of the authored field.
 * Any missing/mutated/reordered ownership relation remains harness-owned.
 */
export function classifyStrictSelectorIssues(
  selectors: TargetSelectorPlan,
  compiled: PersistedSemanticSourcePlan,
  registry: SourceSpanRegistry,
  issues: readonly ValidationIssue[],
  manifest?: EvidenceManifest,
  options?: { canRegisterDocumentReferences?: boolean },
): OwnedSelectorIssue[] {
  if (compiled.schema_version !== "semantic-source-plan/v8") {
    return classifySelectorIssues("strict-validator", issues);
  }
  const selectorItemByCompiledId = new Map(selectors.items.map((item, index) => [
    semanticItemIdForSelectorKey(selectors.target_id, item.key),
    index,
  ]));
  const selectorLotByCompiledId = new Map((selectors.lots ?? []).map((lot, index) => [
    semanticLotIdForSelectorKey(selectors.target_id, lot.key),
    index,
  ]));
  const registeredById = new Map(registry.spans.map((span) => [span.span_id, span]));
  const compiledSpanById = new Map(compiled.source_spans.map((span) => [span.span_id, span]));
  const itemHasReferenceDestination = (itemKey: string): boolean =>
    (selectors.references ?? []).some((reference) =>
      reference.application_mode !== "reference_placeholder"
      && reference.destinations.some((destination) => destination.item_key === itemKey)
    );

  const owned = issues.flatMap((issue): OwnedSelectorIssue[] => {
    if (issue.code === "reference_only_mode_with_field" && options?.canRegisterDocumentReferences && manifest) {
      const match = /^\/reference_resolutions\/(\d+)\/destination_bindings\/(\d+)$/u.exec(issue.path);
      const resolution = compiled.reference_resolutions[Number(match?.[1] ?? -1)];
      const destination = resolution?.destination_bindings[Number(match?.[2] ?? -1)];
      const authorIndex = resolution ? selectors.references.findIndex(reference =>
        reference.occurrence_id === resolution.occurrence_id
        && semanticResolutionIdForSelectorKey(selectors.target_id, reference.key) === resolution.resolution_id) : -1;
      const author = selectors.references[authorIndex];
      const occurrence = manifest.reference_occurrences.find(entry => entry.occurrence_id === resolution?.occurrence_id);
      const source = occurrence ? manifest.evidence.find(entry => entry.evidence_id === occurrence.origin_evidence_id) : undefined;
      const raw = occurrence?.raw_reference ?? "", start = raw ? source?.text.indexOf(raw) ?? -1 : -1;
      // This is the resolver's proven same-identity static-table enrichment,
      // not permission to relax arbitrary reference_* or rewrite a manifest.
      const proposed = occurrence?.reference_kind === "table" && source && start >= 0 ? { ...occurrence,
        target_address: { source_id: manifest.source.sha256, locator_kind: "table" as const, locator: `table:${occurrence.target_table_id}` },
        reference_literal: { evidence_id: source.evidence_id, start, end: start + raw.length },
      } : undefined;
      const candidates = proposed ? manifest.reference_occurrences.filter(entry => canAnchorStaticTableReference(entry, proposed, manifest)) : [];
      const targetSpans = author?.target_span_ids.map(id => registeredById.get(id)) ?? [];
      const originSpans = source ? registry.spans.filter(span => span.evidence_id === source.evidence_id
        && span.start <= start && span.end >= start + raw.length) : [];
      const authoredDestinations = author?.destinations.map(entry => ({
        item_id: semanticItemIdForSelectorKey(selectors.target_id, entry.item_key), target_field: entry.target_field,
      }));
      const faithful = author && resolution && destination && occurrence && candidates.length === 1
        && candidates[0]!.occurrence_id === occurrence.occurrence_id && originSpans.length > 0
        && selectors.references.filter(entry => entry.occurrence_id === occurrence.occurrence_id).length === 1
        && compiled.reference_resolutions.filter(entry => entry.occurrence_id === occurrence.occurrence_id).length === 1
        && author.application_mode === "reference_only" && resolution.application_mode === author.application_mode
        && resolution.action === author.action && resolution.origin_evidence_id === occurrence.origin_evidence_id
        && JSON.stringify(resolution.import_scope) === JSON.stringify(author.import_scope)
        && author.destinations.every(entry => selectors.items.filter(item => item.key === entry.item_key).length === 1)
        && JSON.stringify(resolution.destination_bindings.map(entry => ({ item_id: entry.item_id, target_field: entry.target_field }))) === JSON.stringify(authoredDestinations)
        && !["reference_only", "note"].includes(destination.target_field)
        && targetSpans.every(Boolean)
        && sameStringSet([...new Set(targetSpans.map(span => span!.evidence_id))], resolution.target_evidence_ids);
      if (faithful) {
        return [{ ...issue, path: `/references/${authorIndex}/occurrence_id`, owner: "selector_input_error", details: {
          ...issueDetailsRecord(issue), compiled_path: issue.path, occurrence_id: occurrence.occurrence_id, reference_key: author.key,
          actual: { reference_literal_span_ids: referenceOccurrenceLiteralSpanIds(occurrence),
            application_mode: author.application_mode, destinations: author.destinations, origin_span_candidates: originSpans.map(span => span.span_id) },
          expected: { registered_occurrence_literal: true, same_occurrence_id: occurrence.occurrence_id,
            model_selected_resolve_fields: ["origin_field", "target", "relation", ...(originSpans.length !== 1 ? ["origin_span_id"] : [])] },
          writable_paths: [], writable_input_fields: { resolve_document_reference: ["origin_span_id", "raw_reference", "origin_field", "target", "relation"] },
          next_tool: "resolve_document_reference", next_tool_arguments: { raw_reference: raw,
            ...(originSpans.length === 1 ? { origin_span_id: originSpans[0]!.span_id } : {}) },
          next_tools: ["resolve_document_reference", "open_evidence", "read_target_selectors"], save_tool: "resolve_document_reference",
          required_action: "register_the_existing_static_occurrence_literal_through_the_resolver",
          how_to_pass: "该静态表引用缺少登记的精确 literal，当前检查点允许正常登记，编译内容忠实保留了作者选择。不能只 locate 得到普通 span：使用包含原引用的 origin_span_id、raw_reference，并由模型依据原文确认 origin_field、target 和 relation，调用 resolve_document_reference，为同一 occurrence_id 补登记 reference_literal_span_id；随后复用现有作者记录重试完整检查。多个 origin_span_candidates 时先核对原文再选，不能为消错改接收字段或伪造引用。此修复不批准业务语境与其他诊断。",
          do_not_edit: "不要手改 manifest、occurrence_id、编译产物或无关正确作者字段；只通过正常 resolve_document_reference 登记，保留检查点、历史计数与预算。",
        } }];
      }
      return [compilerDroppedReferenceBinding(issue)];
    }
    if (issue.code === "reference_resolution_missing") {
      const details = issueDetailsRecord(issue);
      const occurrenceId = details.occurrence_id;
      const occurrenceIndex = manifest?.reference_occurrences.findIndex(entry => entry.occurrence_id === occurrenceId) ?? -1;
      const occurrence = manifest?.reference_occurrences[occurrenceIndex];
      const authored = selectors.references.filter(reference => {
        if (reference.occurrence_id) return reference.occurrence_id === occurrenceId;
        // Legacy selectors may identify an occurrence by its origin anchors.
        // Do not recommend a duplicate when such a declaration already exists.
        const anchorEvidence = new Set(reference.anchor_span_ids.flatMap(id => {
          const span = registeredById.get(id);
          return span ? [span.evidence_id] : [];
        }));
        return occurrence && referenceOccurrenceOriginEvidenceIds(occurrence).every(id => anchorEvidence.has(id));
      });
      const resolutions = compiled.reference_resolutions.filter(resolution => resolution.occurrence_id === occurrenceId);
      // A missing declaration is author work. A declaration already present in
      // selectors but absent from the compiled plan is still a compiler defect.
      if (typeof occurrenceId === "string" && occurrence && authored.length === 0 && resolutions.length === 0) {
        return [{
          ...issue,
          path: "/references",
          owner: "selector_input_error",
          details: {
            ...details,
            compiled_path: issue.path,
            actual: { occurrence_id: occurrenceId, authored_reference_count: 0, compiled_resolution_count: 0 },
            expected: { authored_reference_count: 1, compiled_resolution_count: 1 },
            writable_collection: "references",
            writable_path: "/references",
            writable_paths: ["/references"],
            required_action: "author_the_missing_registered_reference_resolution",
            next_tool: "list_reference_occurrences",
            next_tool_arguments: { cursor: occurrenceIndex, limit: 1 },
            next_tools: ["list_reference_occurrences", "read_target_selectors", "read_document_reference_evidence", "read_reference_facts", "stage_target_selector_draft"],
            save_tool: "stage_target_selector_draft",
            how_to_pass: "先用 list_reference_occurrences 按 occurrence_id 核对已登记的原引用、来源、目标和 analysis_mode，复用该行的编号与来源句柄；已有有效阅读回执可复用。尚未读过的目标按目录指定工具读取：inline 用 read_document_reference_evidence，isolated 用 read_reference_facts。由模型依据原文判断适用字段和接收项，在 draft.references 中保存这一处引用的完整记录，以 operation=upsert 调用 stage_target_selector_draft，再重试完整验证。通过条件是这处真实 occurrence 恰有一条作者引用并被编译为解析记录；保留已有正确引用，不重复登记 occurrence，不编造编号或业务归属。",
            do_not_edit: "reference_resolutions 是只读编译产物；不得修改原文、不可变 occurrence 或已封存文件。",
          },
        }];
      }
      return [{
        ...compilerDroppedReferenceBinding(issue),
        details: {
          occurrence_id: occurrenceId,
          actual: { authored_reference_keys: authored.map(reference => reference.key), compiled_resolution_count: resolutions.length },
          expected: { compiled_resolution_count: 1 },
          writable_paths: [], next_tools: [], next_tool_scope: "none",
          required_action: "inspect_missing_compiled_reference_resolution",
          how_to_pass: "无法确认是缺少作者声明：已有声明被编译遗漏，或诊断与当前 occurrence/编译快照不一致。保留检查点并由程序排查，不能要求模型重复新增引用或修改编译产物。",
        },
      }];
    }
    // Optional nested pointers become active through authored target selection.
    // A faithful projection lets the author repair that selection; a required
    // pointer or a compiler/source mismatch still belongs to the harness.
    const missingOccurrence = issue.code === "reference_target_not_found"
      ? /^\/reference_occurrences\/(\d+)$/u.exec(issue.path)
      : null;
    const occurrence = missingOccurrence ? manifest?.reference_occurrences[Number(missingOccurrence[1])] : undefined;
    if (occurrence?.required === false && occurrence.status === "target_not_found") {
      const origins = new Set(referenceOccurrenceOriginEvidenceIds(occurrence));
      const activeResolutions = (compiled.reference_resolutions ?? []).filter(resolution =>
        resolution.target_evidence_ids.some(id => origins.has(id)),
      );
      const activators = activeResolutions.flatMap(resolution => {
        const index = selectors.references.findIndex(reference =>
          reference.occurrence_id === resolution.occurrence_id
          && semanticResolutionIdForSelectorKey(selectors.target_id, reference.key) === resolution.resolution_id,
        );
        const reference = selectors.references[index];
        if (!reference) return [];
        const spans = reference.target_span_ids.map(id => registeredById.get(id));
        const faithful = spans.every(Boolean)
          && sameStringSet([...new Set(spans.map(span => span!.evidence_id))], resolution.target_evidence_ids);
        return faithful ? [{ reference_key: reference.key, occurrence_id: reference.occurrence_id,
          path: `/references/${index}/target_span_ids`,
          matching_span_ids: spans.filter(span => origins.has(span!.evidence_id)).map(span => span!.span_id) }] : [];
      });
      if (activators.length > 0 && activators.length === activeResolutions.length) {
        const writablePaths = [...new Set(activators.map(activator => activator.path))];
        return [{
          ...issue, path: writablePaths[0]!, owner: "selector_input_error",
          details: {
            compiled_path: issue.path, actual: occurrence, activating_references: activators,
            writable_collection: "references", writable_paths: writablePaths,
            required_action: "verify_authored_target_selection_activating_unresolved_nested_reference",
            next_tool: "read_target_selectors",
            next_tool_arguments: { collection: "references", key: activators[0]!.reference_key },
            next_tools: ["read_target_selectors", "list_reference_occurrences", "open_evidence", "resolve_document_reference", "stage_target_selector_draft"],
            save_tool: "stage_target_selector_draft",
            how_to_pass: "这条非必需嵌套引用因 activating_references 的实际 target_span_ids 选中了其来源而激活；该列表只证明来源关联，不证明内容不适用。先读取对应 references 完整记录，用 list_reference_occurrences 和来源读取工具核对父引用目标、选中 span 及嵌套引用原文。若模型确认选错来源，只改列出的 target_span_ids，保留其他正确来源、接收字段及适用条件，用 stage_target_selector_draft 保存完整记录后重检。若选中来源确实适用，不能为消错排除真实适用内容；通过 resolve_document_reference 核对并解析真实目标，仍缺失时保留检查点与实际缺失回条，不能封存。",
            do_not_edit: "不可变 reference occurrence、原文、编译产物及已封存文件；本回条不替模型选择业务来源或宣布校验通过。",
          },
        }];
      }
    }
    // An authored empty basis is repairable only when all classification
    // values were projected unchanged. Compiler loss or mutation stays fatal.
    const emptyInspectionBasis = issue.code === "schema" && issueDetailsRecord(issue).limit === 1
      ? /^\/acceptance_items\/(\d+)\/inspection_data_type_evidence_ids$/u.exec(issue.path)
      : null;
    if (emptyInspectionBasis) {
      const compiledItem = compiled.acceptance_items[Number(emptyInspectionBasis[1])];
      const selectorItemIndex = compiledItem ? selectorItemByCompiledId.get(compiledItem.item_id) : undefined;
      const item = selectorItemIndex === undefined ? undefined : selectors.items[selectorItemIndex];
      if (selectorItemIndex !== undefined && item && compiledItem
        && Array.isArray(item.inspection_data_type_span_ids) && item.inspection_data_type_span_ids.length === 0
        && Array.isArray(compiledItem.inspection_data_type_evidence_ids) && compiledItem.inspection_data_type_evidence_ids.length === 0
        && item.inspection_data_type === compiledItem.inspection_data_type
        && item.inspection_data_type_reason === compiledItem.inspection_data_type_reason) {
        const itemPath = "/items/" + selectorItemIndex;
        return [{
          ...issue,
          path: itemPath + "/inspection_data_type_span_ids",
          details: {
            ...issueDetailsRecord(issue),
            compiled_path: issue.path,
            required_action: "bind_exact_inspection_data_type_source_and_keep_classification_consistent",
            item_key: item.key,
            current_type: item.inspection_data_type,
            actual: {
              item_key: item.key,
              inspection_data_type: item.inspection_data_type,
              inspection_data_type_reason: item.inspection_data_type_reason,
              inspection_data_type_span_ids: [],
              compiled_evidence_ids: [],
            },
            required_min_evidence_count: 1,
            expected: { inspection_data_type_allowed_values: ["measurement", "counting", "mixed", "review"],
              inspection_data_type_span_ids_min_items: 1, source_relation: "registered_exact_source_supporting_this_item_classification" },
            writable_path: itemPath + "/inspection_data_type_span_ids",
            writable_collections: ["items"],
            writable_paths: [itemPath + "/inspection_data_type", itemPath + "/inspection_data_type_reason", itemPath + "/inspection_data_type_span_ids"],
            next_tool: "read_target_selectors",
            next_tool_arguments: { collection: "items", key: item.key },
            next_tools: ["read_target_selectors", "list_evidence_resources", "open_evidence", "locate_evidence_span", "stage_target_selector_draft"],
            save_tool: "stage_target_selector_draft",
            how_to_pass: `先按 next_tool_arguments 读取当前完整 item，再读取该项原文；需要新来源时用 list_evidence_resources 核对读取路由并用 locate_evidence_span 定位。${INSPECTION_DATA_TYPE_SOURCE_REPAIR_GUIDANCE} 空数组可暂存，不满足最终严格契约。`,
            do_not_edit: "不可变原文、编译产物及其他已经正确的字段；回条不自动选择类型或来源。",
          },
          owner: "selector_input_error" as const,
        }];
      }
    }
    const emptySharedMinSampling = issue.code === "schema"
      ? /^\/shared_sampling_rules\/(\d+)\/branches\/(\d+)\/min_sampling$/u.exec(issue.path)
      : null;
    if (emptySharedMinSampling) {
      const ruleIndex = Number(emptySharedMinSampling[1]);
      const branchIndex = Number(emptySharedMinSampling[2]);
      const rule = selectors.sampling_rules[ruleIndex];
      const branch = rule?.branches[branchIndex];
      if (rule && branch) {
        return [{
          ...issue,
          path: `/sampling_rules/${ruleIndex}/branches/${branchIndex}`,
          details: {
            ...issueDetailsRecord(issue),
            compiled_path: issue.path,
            rule_key: rule.key,
            branch_key: branch.key,
            writable_collection: "sampling_rules",
            required_action: "remove_source_routing_branch_or_bind_an_executable_quantity",
            candidate_read_tool: "list_sampling_rules",
            next_tool: "stage_target_selector_draft",
            how_to_pass: "If this item already has a local executable quantity, bind that quantity (explicit or that clause's rule) and omit a pointer branch. If it has none, keep one unbranched default inspection-lot rule. Every remaining branch must have a present non-empty quantity.",
          },
          owner: "selector_input_error" as const,
        }];
      }
    }
    if (issue.code === "agent_target_zero_lots") {
      return [{
        ...issue,
        path: "/lots",
        details: {
          compiled_path: issue.path,
          required_action: "add_at_least_one_evidence_backed_inspection_lot",
        },
        owner: "selector_input_error" as const,
      }];
    }
    const emptyInspectionDataEvidence = issue.code === "schema"
      ? /^\/acceptance_items\/(\d+)\/inspection_data_type_evidence_ids$/u.exec(issue.path)
      : null;
    if (emptyInspectionDataEvidence) {
      const compiledItem = compiled.acceptance_items[Number(emptyInspectionDataEvidence[1] ?? -1)];
      const selectorItemIndex = compiledItem
        ? selectorItemByCompiledId.get(compiledItem.item_id)
        : undefined;
      const selectorItem = selectorItemIndex !== undefined ? selectors.items[selectorItemIndex] : undefined;
      if (selectorItem && compiledItem && Array.isArray(compiledItem.inspection_data_type_evidence_ids)
        && compiledItem.inspection_data_type_evidence_ids.length === 0
        && selectorItem.inspection_data_type_span_ids.length > 0
        && selectorItem.inspection_data_type_span_ids.every(id => registeredById.has(id))) {
        return [{ ...issue, owner: "compiler_invariant_violation" as const, details: {
          ...issueDetailsRecord(issue), compiled_path: issue.path,
          actual: { item_key: selectorItem.key, authored_span_ids: selectorItem.inspection_data_type_span_ids,
            compiled_evidence_ids: compiledItem.inspection_data_type_evidence_ids },
          expected: { evidence_ids: [...new Set(selectorItem.inspection_data_type_span_ids.map(id => registeredById.get(id)!.evidence_id))] },
          writable_paths: [], next_tool_scope: "none", next_tools: [],
          required_action: "report_compiler_dropped_inspection_data_type_evidence",
          how_to_pass: "作者记录已有已登记的检查类型来源，但编译结果未保留该来源；这是编译投影错误，不能由作者填写编译字段或清空正确 span 来修复。保留检查点并报告编译缺陷，在投影修复且完整验证通过前不能封存。",
          do_not_edit: "inspection_data_type_evidence_ids 是编译字段；不可变原文及已确认的作者来源不可为消错改写。",
        } }];
      }
    }
    if (issue.code === "agent_target_zero_items") {
      return [{
        ...issue,
        path: "/items",
        details: {
          compiled_path: issue.path,
          required_action: "add_at_least_one_evidence_backed_acceptance_item",
        },
        owner: "selector_input_error" as const,
      }];
    }
    if (issue.code === "agent_empty_lot") {
      const match = /^\/inspection_lots\/(\d+)\/item_ids$/u.exec(issue.path);
      const compiledLot = compiled.inspection_lots[Number(match?.[1] ?? -1)];
      const selectorLotIndex = compiledLot
        ? selectorLotByCompiledId.get(compiledLot.lot_id)
        : undefined;
      if (selectorLotIndex !== undefined && compiledLot?.item_ids.length === 0) {
        return [{
          ...issue,
          path: `/lots/${selectorLotIndex}`,
          details: {
            compiled_path: issue.path,
            lot_key: selectors.lots[selectorLotIndex]!.key,
            required_action: "add_at_least_one_acceptance_item_to_this_lot_or_remove_the_unsupported_lot",
          },
          owner: "selector_input_error" as const,
        }];
      }
      return [classifySelectorIssue("strict-validator", issue)];
    }
    if (issue.code === "used_evidence_without_item") {
      const match = /^\/evidence_dispositions\/(\d+)\/item_ids$/u.exec(issue.path);
      const disposition = compiled.evidence_dispositions[Number(match?.[1] ?? -1)];
      const selectorLotIndexes = disposition?.disposition === "used"
        && disposition.item_ids.length === 0
        ? compiled.inspection_lots.flatMap((lot) => {
            if (lot.item_ids.length !== 0 || !lot.evidence_ids.includes(disposition.evidence_id)) return [];
            const selectorLotIndex = selectorLotByCompiledId.get(lot.lot_id);
            return selectorLotIndex === undefined ? [] : [selectorLotIndex];
          })
        : [];
      if (selectorLotIndexes.length > 0) {
        return [...new Set(selectorLotIndexes)].map((selectorLotIndex) => ({
          ...issue,
          path: `/lots/${selectorLotIndex}`,
          details: {
            compiled_path: issue.path,
            evidence_id: disposition!.evidence_id,
            lot_key: selectors.lots[selectorLotIndex]!.key,
            required_action: "add_at_least_one_acceptance_item_to_this_lot_or_remove_the_unsupported_lot",
          },
          owner: "selector_input_error" as const,
        }));
      }
      return [classifySelectorIssue("strict-validator", issue)];
    }
    if (SOURCE_DISPOSITION_REPAIR_CODES.has(issue.code)) {
      if (evidenceIdsFromIssue(issue).length === 0) {
        return [classifySelectorIssue("strict-validator", issue)];
      }
      return [remapSourceDispositionIssue(selectors, registry, issue)];
    }
    if (issue.code === "agent_primary_atom_not_used") {
      const details = issueDetailsRecord(issue);
      const evidenceId = typeof details.evidence_id === "string" ? details.evidence_id : "";
      if (evidenceId) {
        return [{
          ...issue,
          path: "/items",
          details: {
            ...details,
            compiled_path: issue.path,
            candidate_span_ids: registry.spans
              .filter((span) => span.evidence_id === evidenceId)
              .map((span) => span.span_id),
            required_action: "bind_the_selected_primary_atom_to_at_least_one_acceptance_item",
          },
          owner: "selector_input_error" as const,
        }];
      }
      return [classifySelectorIssue("strict-validator", issue)];
    }
    if (STRICT_SAMPLING_ROUTE_CODES.has(issue.code)) {
      const match = /^\/acceptance_items\/(\d+)\/sampling\/evidence_ids$/u.exec(issue.path);
      const compiledItem = compiled.acceptance_items[Number(match?.[1] ?? -1)];
      const selectorItemIndex = compiledItem
        ? selectorItemByCompiledId.get(compiledItem.item_id)
        : undefined;
      if (selectorItemIndex !== undefined) {
        return [{
          ...issue,
          path: `/items/${selectorItemIndex}/sampling/status`,
          details: {
            ...(issue.details && typeof issue.details === "object" && !Array.isArray(issue.details)
              ? issue.details
              : {}),
            compiled_path: issue.path,
            sampling_rule_selector_path: "/sampling_rules",
            required_action: "use_explicit_only_for_one_unbranched_decision_or_model_multiple_conditional_outcomes_as_one_sampling_rule_with_typed_branches",
          },
          owner: "selector_input_error" as const,
        }];
      }
      return [classifySelectorIssue("strict-validator", issue)];
    }
    if (
      issue.code === "reference_target_outside_occurrence"
      || issue.code === "reference_target_not_data_row"
    ) {
      const match = /^\/reference_resolutions\/(\d+)\/target_evidence_ids$/u.exec(issue.path);
      const compiledResolution = compiled.reference_resolutions[Number(match?.[1] ?? -1)];
      const selectorReferenceIndex = compiledResolution
        ? selectors.references.findIndex((reference) => reference.occurrence_id === compiledResolution.occurrence_id)
        : -1;
      if (selectorReferenceIndex >= 0) {
        const selectorReference = selectors.references[selectorReferenceIndex]!;
        const authoredEvidenceIds = selectorReference.target_span_ids.flatMap((spanId) => {
          const span = registeredById.get(spanId);
          return span ? [span.evidence_id] : [];
        });
        const faithful = authoredEvidenceIds.length === selectorReference.target_span_ids.length
          && sameStringSet([...new Set(authoredEvidenceIds)], compiledResolution!.target_evidence_ids);
        const issueDetails = issueDetailsRecord(issue);
        const noAllowedTarget = Array.isArray(issueDetails.allowed_target_evidence_ids)
          && issueDetails.allowed_target_evidence_ids.length === 0;
        if (faithful && noAllowedTarget && issueDetails.occurrence_status === "target_not_found") {
          const correctedReference = structuredClone(selectorReference);
          correctedReference.target_span_ids = [];
          correctedReference.action = "keep_reference";
          correctedReference.application_mode = "reference_only";
          return [{
            ...issue,
            path: `/references/${selectorReferenceIndex}/target_span_ids`,
            details: {
              ...issueDetails,
              compiled_path: issue.path,
              reference_key: selectorReference.key,
              occurrence_id: compiledResolution!.occurrence_id,
              writable_collection: "references",
              writable_paths: [
                `/references/${selectorReferenceIndex}/target_span_ids`,
                `/references/${selectorReferenceIndex}/action`,
                `/references/${selectorReferenceIndex}/application_mode`,
              ],
              required_action: "clear_unresolved_occurrence_targets_and_retain_its_reference_receipt",
              next_tool: "read_target_selectors",
              next_tool_arguments: { collection: "references", key: selectorReference.key },
              next_tools: ["read_target_selectors", "list_reference_occurrences", "resolve_document_reference", "stage_target_selector_draft"],
              tool_argument_hints: {
                stage_target_selector_draft: { operation: "upsert", draft: { references: [correctedReference] } },
              },
              save_tool: "stage_target_selector_draft",
              how_to_pass: "先读取当前 reference 和 list_reference_occurrences 回执。若该 occurrence 仍为 target_not_found，清空本条 target_span_ids，使用 keep_reference/reference_only，保留原 anchor、真实接收路由和未解状态；通过 stage_target_selector_draft 按 key 保存完整记录，再重试验证。不要把其他 occurrence 的被引证据挂到本条。若表格项目仍要求已解析路由，必须继续核对目标定位；清空目标本身不能生成 resolved route。",
              do_not_edit: "不可变 occurrence、原文、其他 reference 或编译产物。",
            },
            owner: "selector_input_error" as const,
          }];
        }
        if (faithful) {
          const referencePath = `/references/${selectorReferenceIndex}`;
          const writablePath = `${referencePath}/target_span_ids`;
          const rejectedEvidenceIds = new Set(
            (issue.code === "reference_target_outside_occurrence"
              ? issueDetails.outside_target_evidence_ids
              : issueDetails.non_data_row_evidence_ids) as string[] | undefined,
          );
          const offendingTargetSpans = selectorReference.target_span_ids.flatMap((spanId, index) => {
            const span = registeredById.get(spanId)!;
            if (!rejectedEvidenceIds.has(span.evidence_id)) return [];
            return [{
              index,
              span_id: spanId,
              evidence_id: span.evidence_id,
              atom_id: span.atom_id,
              start: span.start,
              end: span.end,
              writable_path: `${writablePath}/${index}`,
              save_template_path: `/draft/references/0/target_span_ids/${index}`,
            }];
          });
          return [{
            ...issue,
            path: writablePath,
            details: {
              ...(issue.details && typeof issue.details === "object" && !Array.isArray(issue.details)
                ? issue.details
                : {}),
              compiled_path: issue.path,
              reference_key: selectorReference.key,
              occurrence_id: compiledResolution!.occurrence_id,
              offending_target_spans: offendingTargetSpans,
              writable_collection: "references",
              writable_path: writablePath,
              writable_paths: [writablePath],
              candidate_read_tool: "read_target_selectors",
              candidate_read_tools: [
                "read_target_selectors",
                "list_reference_occurrences",
                "read_document_reference_evidence",
                "read_reference_facts",
                "locate_evidence_span",
              ],
              next_tool: "read_target_selectors",
              next_tool_arguments: { collection: "references", key: selectorReference.key },
              next_tools: [
                "read_target_selectors",
                "list_reference_occurrences",
                "read_document_reference_evidence",
                "read_reference_facts",
                "locate_evidence_span",
                "stage_target_selector_draft",
              ],
              tool_argument_hints: {
                read_target_selectors: { collection: "references", key: selectorReference.key },
                list_reference_occurrences: { cursor: 0, limit: 100 },
                read_document_reference_evidence: { target_key: "从 occurrence 公开回条逐字复制 inline target_key", cursor: 0, limit: 24 },
                read_reference_facts: { target_key: "从 occurrence 公开回条逐字复制 isolated target_key" },
                locate_evidence_span: {
                  evidence_id: "只从 allowed_target_evidence_ids 中选择已读证据",
                  quote: "仅填写已打开原文中由模型选择的精确子串",
                  prefix: "可选",
                  suffix: "可选",
                },
                stage_target_selector_draft: {
                  operation: "upsert",
                  draft: { references: [structuredClone(selectorReference)] },
                },
              },
              required_edit_before_save: {
                path: "/draft/references/0/target_span_ids",
                instruction: "保存模板保留当前完整 reference，尚未修正目标 span。offending_target_spans 按当前作者数组给出被拒绝的 span、索引、坐标及模板位置；坐标不是可互换来源。先由模型按已读原文与 allowed_target_evidence_ids 修正这些位置，保留其他正确 span，再提交完整记录；upsert 按 key 替换完整记录，不是字段级补丁。",
              },
              save_tool: "stage_target_selector_draft",
              immutable_path: issue.path,
              required_action: issue.code === "reference_target_outside_occurrence"
                ? "select_only_spans_from_the_occurrence_allowed_target_evidence"
                : "select_only_exact_data_row_spans_from_the_resolved_table_occurrence",
              how_to_pass: "先按 next_tool_arguments 读取当前 reference，再用 list_reference_occurrences 按 occurrence_id 找到公开 target_key。inline 引用调用 read_document_reference_evidence，isolated 引用调用 read_reference_facts；只在 allowed_target_evidence_ids 的已读原文内用 locate_evidence_span 登记精确 span。用 stage_target_selector_draft 保存同一 reference_key 的 target_span_ids 后重试原验证；保留未被本条点名的 anchor、destination、import_scope 和其他正确字段。",
              do_not_edit: "不可变 occurrence、编译生成的 target_evidence_ids、原文、其他 reference，以及当前 reference 中未被本条点名的正确字段。",
            },
            owner: "selector_input_error" as const,
          }];
        }
      }
      return [classifySelectorIssue("strict-validator", issue)];
    }
    if (issue.code === "clause_reference_replace_would_discard_local_requirement") {
      const occurrenceId = issue.details && typeof issue.details === "object" && !Array.isArray(issue.details)
        ? (issue.details as { occurrence_id?: unknown }).occurrence_id
        : undefined;
      const selectorReferenceIndex = typeof occurrenceId === "string"
        ? selectors.references.findIndex((reference) => reference.occurrence_id === occurrenceId)
        : -1;
      if (selectorReferenceIndex >= 0 && typeof occurrenceId === "string") {
        const details = issueDetailsRecord(issue);
        const requiredAction = typeof details.required_action === "string" && details.required_action.trim()
          ? details.required_action
          : "set_application_mode_to_reference_only_and_keep_local_field";
        return [remapAuthoredReferenceIssue(
          issue,
          `/references/${selectorReferenceIndex}/application_mode`,
          occurrenceId,
          requiredAction,
        )];
      }
      return [classifySelectorIssue("strict-validator", issue)];
    }
    if (issue.code === "duplicate_reference_route") {
      const match = /^\/reference_resolutions\/(\d+)\/destination_bindings\/(\d+)$/u.exec(issue.path);
      const compiledResolution = compiled.reference_resolutions[Number(match?.[1] ?? -1)];
      const compiledDestination = compiledResolution?.destination_bindings[Number(match?.[2] ?? -1)];
      const selectorReferenceIndex = compiledResolution
        ? selectors.references.findIndex((reference) => reference.occurrence_id === compiledResolution.occurrence_id)
        : -1;
      const selectorItemIndex = compiledDestination
        ? selectorItemByCompiledId.get(compiledDestination.item_id)
        : undefined;
      const selectorItem = selectorItemIndex === undefined ? undefined : selectors.items[selectorItemIndex];
      const selectorDestinationIndex = selectorReferenceIndex >= 0 && selectorItem
        ? selectors.references[selectorReferenceIndex]!.destinations.findIndex((destination) =>
          destination.item_key === selectorItem.key
          && destination.target_field === compiledDestination?.target_field
        )
        : -1;
      if (selectorReferenceIndex >= 0 && selectorDestinationIndex >= 0) {
        const reference = selectors.references[selectorReferenceIndex]!;
        const details = issueDetailsRecord(issue);
        const evidenceIds = compiledResolution!.target_evidence_ids.filter(evidenceId =>
          details.route === `${compiledDestination!.item_id}|${compiledDestination!.target_field}|${evidenceId}`
        );
        const resolutionIndex = Number(match![1]);
        const destinationIndex = Number(match![2]);
        const conflictingRoutes = compiled.reference_resolutions.slice(0, resolutionIndex + 1).flatMap((prior, priorIndex) => {
          const authorIndex = selectors.references.findIndex(candidate => candidate.occurrence_id === prior.occurrence_id);
          if (authorIndex < 0) return [];
          const author = selectors.references[authorIndex]!;
          const matchingEvidenceIds = evidenceIds.filter(id => prior.target_evidence_ids.includes(id));
          if (matchingEvidenceIds.length === 0) return [];
          return prior.destination_bindings.flatMap((destination, priorDestinationIndex) => {
            if ((priorIndex === resolutionIndex && priorDestinationIndex >= destinationIndex)
              || destination.item_id !== compiledDestination!.item_id
              || destination.target_field !== compiledDestination!.target_field) return [];
            const authorDestinationIndex = author.destinations.findIndex(candidate =>
              candidate.item_key === selectorItem!.key && candidate.target_field === destination.target_field
            );
            if (authorDestinationIndex < 0) return [];
            return [{
              reference_key: author.key,
              occurrence_id: author.occurrence_id,
              path: `/references/${authorIndex}/destinations/${authorDestinationIndex}`,
              reference_index: authorIndex,
              matching_evidence_ids: matchingEvidenceIds,
              matching_target_span_ids: author.target_span_ids.filter(id => matchingEvidenceIds.includes(registeredById.get(id)?.evidence_id ?? "")),
            }];
          });
        });
        const affectedReferences = [...new Set([selectorReferenceIndex, ...conflictingRoutes.map(route => route.reference_index)])];
        const writablePaths = affectedReferences.flatMap(index => [
          `/references/${index}/destinations`,
          `/references/${index}/target_span_ids`,
          `/references/${index}/import_scope/allowed_fields`,
          ...(selectors.references[index]!.component_dispositions !== undefined ? [`/references/${index}/component_dispositions`] : []),
        ]);
        return [{
          ...issue,
          path: `/references/${selectorReferenceIndex}/destinations/${selectorDestinationIndex}/target_field`,
          details: {
            ...(issue.details && typeof issue.details === "object" && !Array.isArray(issue.details)
              ? issue.details
              : {}),
            compiled_path: issue.path,
            occurrence_id: compiledResolution!.occurrence_id,
            reference_key: reference.key,
            affected_item_key: selectorItem!.key,
            affected_field: compiledDestination!.target_field,
            actual: {
              evidence_ids: evidenceIds,
              current_destination: structuredClone(reference.destinations[selectorDestinationIndex]),
              import_scope: structuredClone(reference.import_scope),
              matching_target_span_ids: reference.target_span_ids.filter(id => evidenceIds.includes(registeredById.get(id)?.evidence_id ?? "")),
            },
            conflicting_reference_routes: conflictingRoutes,
            required_action: "remove_or_retarget_the_duplicate_selector_reference",
            writable_paths: writablePaths,
            writable_collections: ["references"],
            route_instruction: REFERENCE_AUTHORIZATION_ROUTE_INSTRUCTION,
            allowed_actions: [
              "按原文比较当前引用与 conflicting_reference_routes：为同一 item.field 的同一被引证据保留一条真实路由，只移除重复 destination，保留其他正确接收字段和引用关系。可以修改冲突双方中实际重复的一方，不限于报错的后一条引用。",
              "若 target_span_ids 误选了不应由当前引用导入的来源，仅纠正这些错误来源并同步对应 component_dispositions；若接收项或字段确实选错，才按原文纠正 destination。不得为消错随意改字段或删除真实判据。",
            ],
            candidate_read_tool: "read_target_selectors",
            candidate_read_tools: ["read_target_selectors", "list_reference_occurrences", "open_evidence"],
            next_tool: "read_target_selectors",
            next_tool_arguments: { collection: "references", key: reference.key },
            next_tools: ["read_target_selectors", "list_reference_occurrences", "open_evidence", "stage_target_selector_draft"],
            tool_argument_hints: {
              read_target_selectors: [
                ...affectedReferences.map(index => ({ collection: "references", key: selectors.references[index]!.key })),
                { collection: "items", key: selectorItem!.key },
              ],
            },
            save_tool: "stage_target_selector_draft",
            save_tool_instruction: "读取冲突双方完整记录，只修改列出的作者路径；以 operation=upsert 调用 stage_target_selector_draft，把修改后的完整记录放入 draft.references，可同时保存双方。保留未点名的正确字段，诊断路径不是工具参数。",
            how_to_pass: "先用 read_target_selectors 读取当前 reference、conflicting_reference_routes 所列引用及接收 item，按 occurrence_id 核对引用原文和实际用途。依据原文选择保留哪条真实路由，只改重复或误选部分；去重不要求把普通引用降为 placeholder，也不要求删除本地判据。核对 route_instruction，保留实际使用字段的授权，避免补授权时重建重复 destination。按 save_tool_instruction 保存完整记录，再重试原完整验证。",
            do_not_edit: "不可变 occurrence、原文、编译产物和已经正确的 item 字段；不得删除真实业务内容或任意改变接收字段来消错。",
          },
          owner: "selector_input_error" as const,
        }];
      }
      return [classifySelectorIssue("strict-validator", issue)];
    }
    if (issue.code === "reference_origin_relation") {
      const match = /^\/reference_resolutions\/(\d+)\/destination_bindings\/(\d+)$/u.exec(issue.path);
      const compiledResolution = compiled.reference_resolutions[Number(match?.[1] ?? -1)];
      const compiledDestination = compiledResolution?.destination_bindings[Number(match?.[2] ?? -1)];
      const selectorReferenceIndex = compiledResolution
        ? selectors.references.findIndex((reference) => reference.occurrence_id === compiledResolution.occurrence_id)
        : -1;
      const selectorItemIndex = compiledDestination
        ? selectorItemByCompiledId.get(compiledDestination.item_id)
        : undefined;
      const selectorItem = selectorItemIndex === undefined ? undefined : selectors.items[selectorItemIndex];
      const selectorDestinationIndex = selectorReferenceIndex >= 0 && selectorItem
        ? selectors.references[selectorReferenceIndex]!.destinations.findIndex((destination) =>
          destination.item_key === selectorItem.key
          && destination.target_field === compiledDestination?.target_field
        )
        : -1;
      if (selectorReferenceIndex >= 0 && selectorDestinationIndex >= 0) {
        const issueDetails = issue.details && typeof issue.details === "object" && !Array.isArray(issue.details)
          ? issue.details as Record<string, unknown>
          : {};
        const originEvidenceIds = Array.isArray(issueDetails.origin_evidence_ids)
          ? issueDetails.origin_evidence_ids.map(String)
          : typeof issueDetails.origin_evidence_id === "string"
            ? [issueDetails.origin_evidence_id]
            : [];
        const literalSpanIds = new Set(Array.isArray(issueDetails.reference_literal_span_ids)
          ? issueDetails.reference_literal_span_ids.map(String)
          : typeof issueDetails.reference_literal_span_id === "string"
            ? [issueDetails.reference_literal_span_id]
            : []);
        // Criterion/table provenance is not the delivered field or sampling context checked
        // by the strict validator. Never recommend the same failing receiver
        // merely because its criterion points at this origin.
        const contextSpanIds = originEvidenceIds.flatMap((originEvidenceId) => {
          const originSpans = registry.spans.filter((span) => span.evidence_id === originEvidenceId);
          const originLength = Math.max(0, ...originSpans.map((span) => span.end));
          return originSpans.filter((span) =>
            span.start === 0 && span.end === originLength && !literalSpanIds.has(span.span_id)
          ).map((span) => span.span_id);
        });
        const currentOriginFieldSpans = Object.entries(selectorItem!.fields).flatMap(([field, decision]) =>
          decision.span_ids.flatMap((spanId, spanIndex) => {
            const span = registeredById.get(spanId);
            if (!span || !originEvidenceIds.includes(span.evidence_id)) return [];
            const coversReferenceLiteral = [...literalSpanIds].some((literalSpanId) => {
              const literalSpan = registeredById.get(literalSpanId);
              return literalSpan?.evidence_id === span.evidence_id
                && span.start <= literalSpan.start
                && span.end >= literalSpan.end;
            });
            return [{
              field,
              path: `/items/${selectorItemIndex}/fields/${field}/span_ids/${spanIndex}`,
              span_id: span.span_id,
              evidence_id: span.evidence_id,
              start: span.start,
              end: span.end,
              covers_reference_literal: coversReferenceLiteral,
            }];
          })
        );
        const originChecks = issueDetails.actual && typeof issueDetails.actual === "object" && !Array.isArray(issueDetails.actual)
          ? issueDetails.actual as Record<string, unknown> : {};
        const provenanceOnly = originChecks.origin_context_retained === true;
        const missingOriginProvenance = Array.isArray(originChecks.missing_origin_evidence_ids)
          && originChecks.missing_origin_evidence_ids.length > 0;
        const primaryWritablePath = provenanceOnly
          ? `/items/${selectorItemIndex}/criterion_span_ids` : `/items/${selectorItemIndex}/fields`;
        const selectedRuleIndex = (selectors.sampling_rules ?? []).findIndex((rule) =>
          rule.key === selectorItem!.sampling?.rule_key);
        const selectedRule = selectors.sampling_rules?.[selectedRuleIndex];
        const samplingComponentGroups = selectedRule ? [
          { path: `/sampling_rules/${selectedRuleIndex}/components`, components: selectedRule.components },
          ...selectedRule.branches.flatMap((branch, branchIndex) =>
            selectorItem!.sampling.branch_keys.includes(branch.key)
              ? [{ path: `/sampling_rules/${selectedRuleIndex}/branches/${branchIndex}/components`, components: branch.components }]
              : []),
        ] : [];
        const deliveredSamplingSpanIds = new Set(compiled.schema_version === COMPACT_PLAN_SCHEMA_VERSION
          ? (compiled.acceptance_items.find((item) => item.item_id === compiledDestination!.item_id)?.sampling.applied_branches ?? [])
            .flatMap((branch) => branch.effective_components
              .filter((component) => component.disposition === "present")
              .flatMap((component) => component.source_span_ids))
          : []);
        const currentOriginSamplingSpans = samplingComponentGroups.flatMap((group) =>
          group.components.flatMap((component, componentIndex) => component.disposition === "present"
            ? component.span_ids.flatMap((spanId, spanIndex) => {
                const span = registeredById.get(spanId);
                if (!span || !originEvidenceIds.includes(span.evidence_id) || !deliveredSamplingSpanIds.has(spanId)) return [];
                return [{
                  component_key: component.key,
                  role: component.role,
                  path: `${group.path}/${componentIndex}/span_ids/${spanIndex}`,
                  span_id: span.span_id,
                  evidence_id: span.evidence_id,
                  start: span.start,
                  end: span.end,
                  covers_reference_literal: [...literalSpanIds].some((literalSpanId) => {
                    const literal = registeredById.get(literalSpanId);
                    return literal?.evidence_id === span.evidence_id
                      && span.start <= literal.start && span.end >= literal.end;
                  }),
                }];
              })
            : []));
        return [{
          ...issue,
          path: `/references/${selectorReferenceIndex}/destinations/${selectorDestinationIndex}/item_key`,
          details: {
            ...issueDetails,
            compiled_path: issue.path,
            occurrence_id: compiledResolution!.occurrence_id,
            candidate_item_keys: [],
            affected_item_key: selectorItem!.key,
            affected_field_path: `/items/${selectorItemIndex}/fields`,
            writable_path: primaryWritablePath,
            writable_paths: [
              primaryWritablePath,
              ...(missingOriginProvenance ? [
                `/items/${selectorItemIndex}/criterion_span_ids`, `/items/${selectorItemIndex}/continuation_span_ids`,
              ].filter(path => path !== primaryWritablePath) : []),
              ...samplingComponentGroups.map(group => group.path),
              ...(selectedRule ? [`/items/${selectorItemIndex}/sampling`] : []),
              `/references/${selectorReferenceIndex}/destinations/${selectorDestinationIndex}/item_key`,
            ],
            actual: { ...originChecks, item_key: selectorItem!.key, fields: selectorItem!.fields, sampling: selectorItem!.sampling, origin_evidence_ids: originEvidenceIds },
            origin_context_span_ids: contextSpanIds,
            full_origin_span_ids: contextSpanIds,
            current_origin_field_spans: currentOriginFieldSpans,
            current_origin_sampling_spans: currentOriginSamplingSpans,
            tool_argument_hints: { read_target_selectors: [
              { collection: "items", key: selectorItem!.key },
              ...(selectedRule ? [{ collection: "sampling_rules", key: selectedRule.key }] : []),
            ] },
            required_action: "inspect_origin_and_repair_visible_field_provenance_or_select_the_real_receiver",
            candidate_read_tool: "open_evidence",
            candidate_read_tools: ["open_evidence", "read_target_selectors"],
            next_tool: "open_evidence",
            save_tool: "stage_target_selector_draft",
            how_to_pass: (provenanceOnly
              ? "actual.origin_context_retained=true 表示显示字段已保留这处引用的来源上下文；当前只缺 actual.missing_origin_evidence_ids 指出的 item 来源归属。先读取完整作者 item 并核对缺失来源，接收项正确时按原文在 criterion_span_ids 或 continuation_span_ids 保留真实归属，不要重复显示已有字段内容；接收项选错时才修正真实 destinations。用 stage_target_selector_draft 保存完整记录后重检，不能改原文或编译产物。"
              : "通过条件是 item 来源归属和显示字段上下文同时成立；actual 分别报告两者，missing_origin_evidence_ids 非空时还须按原文补真实 criterion/continuation 来源。本回条已对 actual.fields 与该接收项实际选中分支的 present 抽样组件完成严格验证；只改 reason、criterion_span_ids、origin_binding，或在同一字段追加与 current_origin_field_spans 区间重叠的 span，均不能修复当前问题。先用 open_evidence 核对 origin_evidence_ids 的原文，再用 read_target_selectors 读取 affected_item_key 的完整记录。若接收项正确，由模型根据原文在该 item 的 fields 或实际选中 sampling_rules 分支的 present 组件中保留同一引用来源的引用文字及适用的本地上下文；需要采用 origin_context_span_ids 所示的完整已登记来源范围时，应替换同一字段内被其覆盖的 span，而不是追加重叠 span。仅登记 criterion/table、complete_span_ids、未选分支、absent 组件或只绑定引用锚点不够；按 tool_argument_hints 读取完整 item/rule，只修改列出的实际交付路径。若接收项选错，才修改 destinations[].item_key 指向真实接收项；candidate_item_keys 为空不是要求从空列表选择。保存后重试原验证工具。") + " " + REFERENCE_ORIGIN_CONTEXT_SCOPE_GUIDANCE,
            instruction: provenanceOnly
              ? "显示上下文已通过，保留已有正确字段，不要重复显示原引用或条件。这里只补真实 item 来源归属或纠正误选接收者；不能修改编译产物，也不能为了消错新增不适用的来源。"
              : "引用文字与本地上下文可以分布在 name、requirement、method 等不同字段；保留已有正确片段，仅补缺失来源。origin_context_span_ids 只说明已登记的完整来源范围，不是强制复制答案；由模型根据原文判断是否适用于当前接收项。选择较大 span 时应替换同一字段内与它重叠的片段，不要追加后重复显示，也不要重复已有条件。保持独立子项名称，不得删除判据、条件或引用来消除报错；不可修改原文或编译产物。",
          },
          owner: "selector_input_error" as const,
        }];
      }
      return [classifySelectorIssue("strict-validator", issue)];
    }
    if (issue.code === "duplicate_reference_occurrence_resolution") {
      const occurrenceId = issueDetailsRecord(issue).occurrence_id;
      const count = issueDetailsRecord(issue).count;
      const matchingResolutions = compiled.reference_resolutions.filter((resolution) =>
        resolution.occurrence_id === occurrenceId
      );
      const resolutionIds = new Set(matchingResolutions.map((resolution) => resolution.resolution_id));
      const matchingReferences = selectors.references.flatMap((reference, index) =>
        resolutionIds.has(semanticResolutionIdForSelectorKey(selectors.target_id, reference.key))
          ? [{ reference, index }]
          : []
      );
      if (typeof occurrenceId === "string"
        && typeof count === "number"
        && count > 1
        && matchingResolutions.length === count
        && matchingReferences.length === count
      ) {
        return [{
          ...issue,
          path: "/references",
          details: {
            ...issueDetailsRecord(issue),
            compiled_path: issue.path,
            matching_reference_keys: matchingReferences.map(({ reference }) => reference.key),
            matching_reference_paths: matchingReferences.map(({ index }) => `/references/${index}`),
            writable_collection: "references",
            writable_path: "/references",
            writable_paths: matchingReferences.map(({ index }) => `/references/${index}`),
            required_action: "keep_one_faithful_selector_reference_per_registered_occurrence",
            next_tool: "read_target_selectors",
            next_tool_arguments: { collection: "references" },
            next_tools: ["read_target_selectors", "list_reference_occurrences", "stage_target_selector_draft"],
            save_tool: "stage_target_selector_draft",
            how_to_pass: "先用 read_target_selectors 读取 matching_reference_keys 中每条完整记录，再用 list_reference_occurrences 核对当前 occurrence 的原引用和目标。若一条是冗余记录，保留真实且完整的一条，调用 stage_target_selector_draft，传 collection=references、remove_keys=[核对后确认冗余的 reference key] 删除另一条；若两条属于不同的真实 occurrence，纠正误选记录的 occurrence_id 与 anchor 后重试。保留所有真实接收字段及未被点名的引用，不能直接编辑 reference_resolutions。",
            do_not_edit: "不可变 occurrence、原文、编译产物和其他正确引用；不要仅为消错删除真实业务字段。",
          },
          owner: "selector_input_error" as const,
        }];
      }
      return [classifySelectorIssue("strict-validator", issue)];
    }
    if (issue.code === "table_reference_route_missing") {
      const match = /^\/acceptance_items\/(\d+)\/table_semantics$/u.exec(issue.path);
      const compiledItem = compiled.acceptance_items[Number(match?.[1] ?? -1)];
      const selectorItemIndex = compiledItem
        ? selectorItemByCompiledId.get(compiledItem.item_id)
        : undefined;
      const selectorItem = selectorItemIndex === undefined
        ? undefined
        : selectors.items[selectorItemIndex];
      if (selectorItemIndex !== undefined && selectorItem?.table?.source_kind === "reference") {
        const tableAnchors = (selectorItem.table.reference_span_ids ?? []).flatMap((id) => {
          const span = registeredById.get(id);
          return span ? [span] : [];
        });
        const matchingRoutes = (selectors.references ?? []).flatMap((reference, index) => {
          if (!reference.destinations.some((destination) => destination.item_key === selectorItem.key)) return [];
          const anchorMatches = (reference.anchor_span_ids ?? []).some((id) => {
            const span = registeredById.get(id);
            return span && tableAnchors.some((tableAnchor) =>
              tableAnchor.evidence_id === span.evidence_id
              && tableAnchor.start < span.end
              && span.start < tableAnchor.end
            );
          });
          const occurrence = manifest?.reference_occurrences.find((entry) => entry.occurrence_id === reference.occurrence_id);
          return anchorMatches && occurrence ? [{ reference, index, occurrence }] : [];
        });
        const unresolvedRoutes = matchingRoutes.filter(({ occurrence }) =>
          occurrence.status === "target_not_found" && occurrence.target_evidence_ids.length === 0
        );
        if (unresolvedRoutes.length && matchingRoutes.every(({ occurrence }) => occurrence.status !== "resolved")) {
          return [{
            ...issue,
            path: `/items/${selectorItemIndex}/table/reference_span_ids`,
            details: {
              ...issueDetailsRecord(issue),
              compiled_path: issue.path,
              affected_item_key: selectorItem.key,
              unresolved_reference_routes: unresolvedRoutes.map(({ reference, index, occurrence }) => ({
                reference_key: reference.key,
                selector_path: `/references/${index}`,
                occurrence_id: occurrence.occurrence_id,
                occurrence_status: occurrence.status,
              })),
              required_action: "repair_unresolved_reference_target_before_sealing_its_table_route",
              how_to_pass: "已关联的引用 occurrence 没有已解析目标，增加或重定向 destinations 不能生成本项需要的 resolved route。用 list_reference_occurrences 核对回执，按原引用调用 resolve_document_reference 复核目标定位；仍为 target_not_found 时，保留原引用、anchor 和空 target_span_ids，并将 occurrence_id、原文位置及定位失败回执交给来源解析修复。不得把其他 occurrence 的目标行改挂到本引用，也不能修改编译产物来绕过校验。",
            },
            owner: "compiler_invariant_violation" as const,
          }];
        }
        return [{
          ...issue,
          path: `/items/${selectorItemIndex}/table/reference_span_ids`,
          details: {
            compiled_path: issue.path,
            affected_item_key: selectorItem.key,
            actual: {
              item_key: selectorItem.key,
              reference_span_ids: selectorItem.table.reference_span_ids ?? [],
              destination_reference_keys: (selectors.references ?? []).filter(reference =>
                reference.destinations.some(destination => destination.item_key === selectorItem.key)
              ).map(reference => reference.key),
            },
            required_condition: "存在 status=resolved 且 destination 指向当前 item_key 的真实语义引用路由",
            writable_collection: "references",
            writable_paths: ["/references", `/items/${selectorItemIndex}/table/reference_span_ids`],
            candidate_read_tool: "read_target_selectors",
            next_tool: "read_target_selectors",
            next_tool_arguments: { collection: "items", key: selectorItem.key },
            next_tools: ["read_target_selectors", "list_reference_occurrences", "read_document_reference_evidence", "read_reference_facts", "stage_target_selector_draft"],
            save_tool: "stage_target_selector_draft",
            required_action: "add_or_retarget_the_resolved_reference_destination_to_this_table_item",
            how_to_pass: "先读取本 item 和 references 完整记录，再用 list_reference_occurrences 及对应来源工具核对 table.reference_span_ids、引用目标和接收字段。若原文支持该引用接收本项，补齐真实 resolved 引用的 destinations，使 item_key 指向本项；若 anchor 选错，只纠正本项的 reference_span_ids。reference_placeholder 要求 destinations=[]，不能直接向它追加 destination；先依据原文核对 application_mode 和当前叶项的表格来源。用 stage_target_selector_draft 保存完整记录后重检，保留未被点名的正确来源和字段。",
            do_not_edit: "不可变 occurrence、来源原文及编译产物；回条不替模型决定引用适用性或接收字段。",
          },
          owner: "selector_input_error" as const,
        }];
      }
      return [classifySelectorIssue("strict-validator", issue)];
    }
    if (issue.code === "table_evidence_relation") {
      const match = /^\/acceptance_items\/(\d+)\/table_semantics$/u.exec(issue.path);
      const compiledItem = compiled.acceptance_items[Number(match?.[1] ?? -1)];
      const selectorItemIndex = compiledItem
        ? selectorItemByCompiledId.get(compiledItem.item_id)
        : undefined;
      const selectorItem = selectorItemIndex === undefined
        ? undefined
        : selectors.items[selectorItemIndex];
      const implicatedEvidenceIds = new Set((() => {
        if (Array.isArray(issue.details)) {
          return issue.details.filter((value): value is string => typeof value === "string");
        }
        const actual = issueDetailsRecord(issue).actual;
        return Array.isArray(actual)
          ? actual.filter((value): value is string => typeof value === "string")
          : [];
      })());
      if (
        selectorItemIndex !== undefined
        && selectorItem?.table?.source_kind === "reference"
        && !itemHasReferenceDestination(selectorItem.key)
      ) {
        return [{
          ...issue,
          path: `/items/${selectorItemIndex}/table/reference_span_ids`,
          details: {
            compiled_path: issue.path,
            affected_item_key: selectorItem.key,
            writable_collection: "references",
            candidate_read_tool: "list_reference_occurrences",
            next_tool: "list_reference_occurrences",
            required_action: "add_or_retarget_the_resolved_reference_destination_to_this_table_item",
            companion_issue: "table_reference_route_missing",
            how_to_pass: "在 references[].destinations 增加本子项的 item_key；不要只留在拆前的父项。",
          },
          owner: "selector_input_error" as const,
        }];
      }
      if (selectorItemIndex !== undefined && selectorItem?.table && implicatedEvidenceIds.size > 0) {
        const allTableSourceBindings: Array<{ path: string; span_id: string; evidence_id: string; start: number; end: number }> = [];
        const collectTableSourceBindings = (value: unknown, path: string): void => {
          if (typeof value === "string") {
            const span = registeredById.get(value);
            if (span) allTableSourceBindings.push({ path, span_id: value, evidence_id: span.evidence_id, start: span.start, end: span.end });
          } else if (Array.isArray(value)) {
            value.forEach((child, index) => collectTableSourceBindings(child, `${path}/${index}`));
          } else if (value && typeof value === "object") {
            Object.entries(value).forEach(([key, child]) => collectTableSourceBindings(child, `${path}/${key}`));
          }
        };
        // Reference anchors and nested acceptance branches are authored table sources too.
        collectTableSourceBindings(selectorItem.table, `/items/${selectorItemIndex}/table`);
        const tableSpanIds = allTableSourceBindings.map(binding => binding.span_id);
        const tableEvidenceIds = new Set(tableSpanIds.flatMap((spanId) => {
          const span = registeredById.get(spanId);
          return span ? [span.evidence_id] : [];
        }));
        const itemCarrierSpanIds = [
          ...selectorItem.criterion_span_ids,
          ...selectorItem.continuation_span_ids,
          ...Object.values(selectorItem.fields).flatMap((field) =>
            field.composition === "reference" ? [] : field.span_ids
          ),
          ...selectors.references.flatMap((reference) =>
            reference.destinations.some((destination) => destination.item_key === selectorItem.key)
              ? reference.target_span_ids
              : []
          ),
        ];
        const itemCarrierEvidenceIds = new Set(itemCarrierSpanIds.flatMap((spanId) => {
          const span = registeredById.get(spanId);
          return span ? [span.evidence_id] : [];
        }));
        const unownedEvidenceIds = [...implicatedEvidenceIds].filter((evidenceId) =>
          tableEvidenceIds.has(evidenceId) && !itemCarrierEvidenceIds.has(evidenceId)
        );
        if (unownedEvidenceIds.length > 0) {
          const matchingTableSpanIds = [...new Set(tableSpanIds.filter((spanId) => {
            const span = registeredById.get(spanId);
            return span ? unownedEvidenceIds.includes(span.evidence_id) : false;
          }))];
          const tableSourceBindings = allTableSourceBindings.filter(binding =>
            unownedEvidenceIds.includes(binding.evidence_id)
          );
          const referenceRoutesToItem = (selectors.references ?? []).flatMap((reference, referenceIndex) => {
            const matchingDestinationIndexes = reference.destinations.flatMap((destination, destinationIndex) => (
              destination.item_key === selectorItem.key ? [destinationIndex] : []
            ));
            if (reference.application_mode === "reference_placeholder" || matchingDestinationIndexes.length === 0) {
              return [];
            }
            const targetEvidenceIds = [...new Set(reference.target_span_ids.flatMap((spanId) => {
              const span = registeredById.get(spanId);
              return span ? [span.evidence_id] : [];
            }))];
            return [{
              path: `/references/${referenceIndex}`,
              key: reference.key,
              occurrence_id: reference.occurrence_id,
              target_span_ids: reference.target_span_ids,
              target_evidence_ids: targetEvidenceIds,
              matching_unowned_evidence_ids: targetEvidenceIds.filter((evidenceId) =>
                unownedEvidenceIds.includes(evidenceId)
              ),
              import_scope: reference.import_scope,
              matching_destination_indexes: matchingDestinationIndexes,
              destination_snapshot: reference.destinations.map((destination, destinationIndex) => ({
                destination_index: destinationIndex,
                item_key: destination.item_key,
                target_field: destination.target_field,
              })),
            }];
          });
          const primaryWritablePath = `/items/${selectorItemIndex}/criterion_span_ids`;
          const writablePaths = [
            primaryWritablePath,
            `/items/${selectorItemIndex}/continuation_span_ids`,
            `/items/${selectorItemIndex}/fields`,
            "/references",
            ...tableSourceBindings.map(binding => binding.path),
          ];
          return [{
            ...issue,
            path: `/items/${selectorItemIndex}/criterion_span_ids`,
            message: "表格结构使用的来源尚未由同一验收项的作者来源或指向该项的显式引用路由承载。",
            details: {
              compiled_path: issue.path,
              actual: {
                item_key: selectorItem.key,
                item_index: selectorItemIndex,
                table_source_kind: selectorItem.table.source_kind,
                unowned_table_evidence_ids: unownedEvidenceIds,
                current_item_carrier_span_ids: [...new Set(itemCarrierSpanIds)],
                current_table_source_bindings: tableSourceBindings,
              },
              affected_item_key: selectorItem.key,
              unowned_table_evidence_ids: unownedEvidenceIds,
              matching_table_span_ids: matchingTableSpanIds,
              reference_routes_to_item: referenceRoutesToItem,
              writable_path: primaryWritablePath,
              writable_paths: writablePaths,
              writable_collections: ["items", "references"],
              required_action: "由模型核对原文后，纠正表格角色中误选的来源；若当前角色来源正确，则补齐同一 item 的真实作者来源或显式引用路由。",
              allowed_actions: [
                "若 current_table_source_bindings 显示表格角色误选了不适用的来源，按其中 path 纠正该角色的 span 绑定；保留仍适用的真实来源及其他正确表格角色。不要把误选来源补入 criterion 或 references 来消错。",
                "若报错表格来源就是当前 item 的直接业务来源，在 criterion_span_ids、continuation_span_ids 或 composition 非 reference 的可见字段中绑定实际适用的已登记 span；不要为过校验重复显示原文。",
                "若报错表格来源属于被引内容，在 references 中保留或补齐指向 affected_item_key 的真实 destination、target_span_ids 和 import_scope；不得虚构引用关系或接收字段。",
              ],
              how_to_pass: "先用 read_target_selectors(collection=items, key=affected_item_key) 读取当前 item，再用 read_target_selectors(collection=references) 读取现有引用。先按 actual.current_table_source_bindings 的 path/span_id 核对表格角色是否选对来源，再判断归属：direct 来源用 open_evidence；inline 或 isolated 引用先从 list_reference_occurrences 取得公开 target_key，再分别使用 read_document_reference_evidence 或 read_reference_facts。需要精确子区间时，只能对已读原文调用 locate_evidence_span。若角色错绑，纠正列出的 table 属性；若来源正确，才补齐作者来源或显式引用路由。由模型依据原文选择 allowed_actions 中适用的一条，保留未被点名的正确来源，按 save_tool_instruction 用 stage_target_selector_draft 保存完整记录后重试原验证；回条不替模型决定业务归属、接收字段或答案。",
              candidate_read_tool: "read_target_selectors",
              candidate_read_tools: [
                "read_target_selectors",
                "list_table_fragments",
                "read_table_summary",
                "read_table_rows",
                "open_evidence",
                "list_reference_occurrences",
                "read_document_reference_evidence",
                "read_reference_facts",
                "locate_evidence_span",
              ],
              next_tool: "read_target_selectors",
              next_tool_arguments: { collection: "items", key: selectorItem.key },
              next_tools: [
                "read_target_selectors",
                "list_table_fragments",
                "read_table_summary",
                "read_table_rows",
                "open_evidence",
                "list_reference_occurrences",
                "read_document_reference_evidence",
                "read_reference_facts",
                "locate_evidence_span",
                "stage_target_selector_draft",
              ],
              tool_argument_hints: {
                read_target_selectors: [
                  { collection: "items", key: selectorItem.key },
                  { collection: "references" },
                ],
                list_table_fragments: { cursor: 0, limit: 100 },
                read_table_summary: { table_key: "从 list_table_fragments 返回值逐字复制" },
                read_table_rows: { table_key: "从 list_table_fragments 返回值逐字复制", cursor: 0, limit: 50 },
                list_reference_occurrences: { cursor: 0, limit: 100 },
                read_document_reference_evidence: { target_key: "从 occurrence 读取的 inline target_key", cursor: 0, limit: 24 },
                read_reference_facts: { target_key: "从 occurrence 读取的 isolated target_key" },
                locate_evidence_span: {
                  evidence_id: "从 unowned_table_evidence_ids 选择已读来源",
                  quote: "仅填写已打开原文中由模型选择的精确子串",
                  prefix: "可选",
                  suffix: "可选",
                },
              },
              save_tool_instruction: "先用 read_target_selectors 读取并保留待修改的完整记录，只改 writable_paths 指定字段；以 operation=upsert 调用 stage_target_selector_draft，将修改后的完整记录按集合放入 draft.items 或 draft.references（两者可同次提交），保留未被点名的正确字段。writable_paths 是诊断元数据，不是工具参数。",
              save_tool: "stage_target_selector_draft",
              do_not_edit: "编译生成的 evidence_ids、table_semantics 和不可变原文；保留未被本条报错点名的正确来源。",
            },
            owner: "selector_input_error" as const,
          }];
        }
      }
      return [classifySelectorIssue("strict-validator", issue)];
    }
    if (issue.code === "reference_import_scope_exceeded") {
      const match = /^\/reference_resolutions\/(\d+)\/import_scope\/allowed_fields$/u.exec(issue.path);
      const resolution = compiled.reference_resolutions[Number(match?.[1] ?? -1)];
      const selectorReferenceIndex = resolution
        ? selectors.references.findIndex((reference) =>
            reference.occurrence_id === resolution.occurrence_id
          )
        : -1;
      if (selectorReferenceIndex >= 0) {
        const details = issue.details && typeof issue.details === "object" && !Array.isArray(issue.details)
          ? issue.details as Record<string, unknown>
          : {};
        const compiledItemId = typeof details.item_id === "string" ? details.item_id : undefined;
        const selectorItemIndex = compiledItemId === undefined ? undefined : selectorItemByCompiledId.get(compiledItemId);
        const selectorItem = selectorItemIndex === undefined ? undefined : selectors.items[selectorItemIndex];
        const importedFields = Array.isArray(details.imported_fields)
          ? details.imported_fields.filter((field): field is string => typeof field === "string")
          : [];
        const outsideImportScope = Array.isArray(details.outside_import_scope)
          ? details.outside_import_scope.filter((field): field is string => typeof field === "string")
          : [];
        const allowedFields = selectors.references[selectorReferenceIndex]!.import_scope.allowed_fields;
        const reference = selectors.references[selectorReferenceIndex]!;
        const selectedTargetEvidenceIds = new Set(resolution!.target_evidence_ids ?? []);
        const matchingAuthorFieldSpans = Object.entries(selectorItem?.fields ?? {}).flatMap(([field, binding]) =>
          binding.span_ids.flatMap(spanId => {
            const span = registeredById.get(spanId);
            return span && selectedTargetEvidenceIds.has(span.evidence_id)
              ? [{ field, span_id: spanId, evidence_id: span.evidence_id, start: span.start, end: span.end }] : [];
          })
        );
        const otherReceiverRoutes = compiled.reference_resolutions.flatMap(other => {
          if (other === resolution) return [];
          const otherReference = selectors.references.find(row => row.occurrence_id === other.occurrence_id);
          const destinations = (other.destination_bindings ?? []).filter(row => row.item_id === compiledItemId);
          const overlappingEvidenceIds = (other.target_evidence_ids ?? []).filter(id => selectedTargetEvidenceIds.has(id));
          return otherReference?.key && destinations.length && overlappingEvidenceIds.length
            ? [{ reference_key: otherReference.key, occurrence_id: other.occurrence_id,
              destination_fields: destinations.map(row => row.target_field), overlapping_evidence_ids: overlappingEvidenceIds }] : [];
        });
        const receiverPaths = selectorItemIndex === undefined ? [] : outsideImportScope.map((field) => (
          field === "sampling"
            ? `/items/${selectorItemIndex}/sampling`
            : `/items/${selectorItemIndex}/fields/${field}`
        ));
        const importScopePath = `/references/${selectorReferenceIndex}/import_scope/allowed_fields`;
        return [{
          ...issue,
          path: importScopePath,
          message: `引用 ${resolution!.occurrence_id} 的实际导入字段超出了作者声明的 import_scope.allowed_fields。授权范围必须精确覆盖确实需要导入的内容，且不能保留不应导入的引用来源。`,
          details: {
            ...details,
            compiled_path: issue.path,
            occurrence_id: resolution!.occurrence_id,
            required_action: "align_import_scope_allowed_fields_with_the_exact_reference_content_used_by_each_destination_field_or_remove_the_unauthorized_import",
            actual: {
              allowed_fields: allowedFields,
              imported_fields: importedFields,
              outside_import_scope: outsideImportScope,
              item_id: compiledItemId,
              item_key: selectorItem?.key,
              selected_target_span_ids: reference.target_span_ids ?? [],
              selected_target_evidence_ids: [...selectedTargetEvidenceIds],
              current_destinations: reference.destinations ?? [],
              direct_matching_author_field_spans: matchingAuthorFieldSpans,
              other_same_receiver_reference_routes: otherReceiverRoutes,
            },
            expected: "当前引用所选目标 evidence 在接收 item 的实际字段及 sampling 用途中均获精确授权；误选目标或误用字段须按原文纠正。授权不是 destinations 的副本，也不由引用锚点所在字段独自决定。",
            allowed_actions: [
              "确认超范围字段确实应接收该引用内容时，把这些实际导入字段加入 import_scope.allowed_fields，使授权与用途精确一致。",
              "确认超范围字段不应接收该引用内容时，从对应 item 字段或 sampling 删除该引用来源，并同步修正 reference 的 destinations/component_dispositions。",
              "当前引用误选了过宽的被引目标时，按原文纠正它的 target_span_ids，并同步 component_dispositions；保留其他真实引用正确承载的 item 字段，不为修当前引用删除它们。",
            ],
            writable_paths: [
              importScopePath,
              `/references/${selectorReferenceIndex}/target_span_ids`,
              `/references/${selectorReferenceIndex}/destinations`,
              `/references/${selectorReferenceIndex}/component_dispositions`,
              ...receiverPaths,
            ],
            candidate_read_tool: "read_target_selectors",
            candidate_read_tools: ["read_target_selectors"],
            next_tool: "read_target_selectors",
            next_tool_arguments: reference.key ? { collection: "references", key: reference.key } : { collection: "references", cursor: 0 },
            tool_argument_hints: { read_target_selectors: [
              ...(reference.key ? [{ collection: "references", key: reference.key }] : [{ collection: "references", cursor: 0 }]),
              ...(selectorItem ? [{ collection: "items", key: selectorItem.key }] : []),
              ...otherReceiverRoutes.map(route => ({ collection: "references", key: route.reference_key })),
              ...(selectorItem?.sampling?.rule_key && importedFields.includes("sampling")
                && selectors.sampling_rules?.filter(rule => rule.key === selectorItem.sampling.rule_key).length === 1
                ? [{ collection: "sampling_rules", key: selectorItem.sampling.rule_key }] : []),
            ] },
            next_tools: ["read_target_selectors", "stage_target_selector_draft"],
            save_tool: "stage_target_selector_draft",
            route_instruction: REFERENCE_AUTHORIZATION_ROUTE_INSTRUCTION,
            how_to_pass: "先按 tool_argument_hints 读取当前 reference、接收 item、共享 sampling 和同接收项的其他真实引用。direct_matching_author_field_spans 只展示直接字段绑定，sampling 或 typed table 用途另读完整作者记录。" + REFERENCE_IMPORT_SCOPE_REPAIR_GUIDANCE + "每确认一条真实记录就及时保存，继续完成当前已知修复组后再完整验证，不为刷新详情重检未改草稿。",
            do_not_edit: "不可变原文、编译产物和已获合法授权的其他字段。",
          },
          owner: "selector_input_error" as const,
        }];
      }
      return [classifySelectorIssue("strict-validator", issue)];
    }
    if (issue.code === "reference_resolved_target_required") {
      const resolution = compiledResolutionAt(compiled, issue.path, "target_evidence_ids");
      const selectorReferenceIndex = selectorReferenceIndexByOccurrence(selectors, resolution?.occurrence_id);
      if (selectorReferenceIndex >= 0 && resolution) {
        const faithful = selectors.references[selectorReferenceIndex]!.target_span_ids.length === 0
          && resolution.target_evidence_ids.length === 0;
        if (faithful) {
          return [remapAuthoredReferenceIssue(
            issue,
            `/references/${selectorReferenceIndex}/target_span_ids`,
            resolution.occurrence_id,
            "select_resolved_target_spans_or_keep_target_not_found_receipt",
          )];
        }
        return [compilerDroppedReferenceBinding(issue)];
      }
      return [classifySelectorIssue("strict-validator", issue)];
    }
    if (issue.code === "reference_scalar_target_count") {
      const resolution = compiledResolutionAt(compiled, issue.path, "target_evidence_ids");
      const selectorReferenceIndex = selectorReferenceIndexByOccurrence(selectors, resolution?.occurrence_id);
      if (selectorReferenceIndex >= 0 && resolution) {
        const selectorReference = selectors.references[selectorReferenceIndex]!;
        const faithful = (selectorReference.application_mode as string) === "replace_field"
          && resolution.application_mode === "replace_field"
          && selectorReference.target_span_ids.length !== 1
          && resolution.target_evidence_ids.length !== 1;
        if (faithful) {
          return [remapAuthoredReferenceIssue(
            issue,
            `/references/${selectorReferenceIndex}/application_mode`,
            resolution.occurrence_id,
            "set_application_mode_to_reference_only_or_keep_exactly_one_target_span",
          )];
        }
        return [compilerDroppedReferenceBinding(issue)];
      }
      return [classifySelectorIssue("strict-validator", issue)];
    }
    if (issue.code === "reference_literal_retained") {
      const match = /^\/acceptance_items\/(\d+)\/([^/]+)$/u.exec(issue.path);
      const compiledItem = compiled.acceptance_items[Number(match?.[1] ?? -1)];
      const field = match?.[2];
      const resolution = compiledItem && field
        ? compiled.reference_resolutions.find((entry) =>
            entry.application_mode === "replace_field"
            && entry.destination_bindings.some((destination) =>
              destination.item_id === compiledItem.item_id
              && destination.target_field === field
            )
          )
        : undefined;
      const selectorReferenceIndex = selectorReferenceIndexByOccurrence(selectors, resolution?.occurrence_id);
      if (selectorReferenceIndex >= 0 && resolution) {
        const faithful = (selectors.references[selectorReferenceIndex]!.application_mode as string) === "replace_field"
          && resolution.application_mode === "replace_field";
        if (faithful) {
          return [remapAuthoredReferenceIssue(
            issue,
            `/references/${selectorReferenceIndex}/application_mode`,
            resolution.occurrence_id,
            "set_application_mode_to_reference_only_and_keep_local_field",
          )];
        }
        return [compilerDroppedReferenceBinding(issue)];
      }
      return [classifySelectorIssue("strict-validator", issue)];
    }
    if (issue.code === "reference_destination_field_mismatch") {
      const resolution = compiledResolutionAt(compiled, issue.path, "destination_bindings");
      const selectorReferenceIndex = selectorReferenceIndexByOccurrence(selectors, resolution?.occurrence_id);
      const details = issueDetailsRecord(issue);
      const itemId = typeof details.item_id === "string" ? details.item_id : "";
      const selectorItemIndex = itemId ? selectorItemByCompiledId.get(itemId) : undefined;
      const selectorItem = selectorItemIndex === undefined ? undefined : selectors.items[selectorItemIndex];
      if (selectorReferenceIndex >= 0 && resolution && selectorItem) {
        const compiledFields = resolution.destination_bindings
          .filter((destination) => destination.item_id === itemId)
          .map((destination) => destination.target_field)
          .sort();
        const authoredFields = selectors.references[selectorReferenceIndex]!.destinations
          .filter((destination) => destination.item_key === selectorItem.key)
          .map((destination) => destination.target_field)
          .sort();
        const faithful = JSON.stringify(compiledFields) === JSON.stringify(authoredFields);
        if (faithful) {
          const expected = Array.isArray(details.expected)
            ? details.expected.filter((value): value is string => typeof value === "string")
            : [];
          const actual = Array.isArray(details.actual)
            ? details.actual.filter((value): value is string => typeof value === "string")
            : authoredFields;
          const selectorDestinationIndex = selectors.references[selectorReferenceIndex]!.destinations.findIndex((destination) =>
            destination.item_key === selectorItem.key
            && actual.includes(destination.target_field)
            && !expected.includes(destination.target_field)
          );
          const originField = expected.length === 1 ? expected[0] : undefined;
          return [remapAuthoredReferenceIssue(
            issue,
            selectorDestinationIndex >= 0
              ? `/references/${selectorReferenceIndex}/destinations/${selectorDestinationIndex}/target_field`
              : `/references/${selectorReferenceIndex}/destinations`,
            resolution.occurrence_id,
            originField
              ? `bind_destination_to_origin_field_${originField}`
              : "bind_destinations_to_the_registered_origin_fields",
          )];
        }
        return [compilerDroppedReferenceBinding(issue)];
      }
      return [classifySelectorIssue("strict-validator", issue)];
    }
    if (
      PLACEHOLDER_COVERAGE_CODES.has(issue.code)
      || issue.code === "reference_placeholder_has_item_destination"
      || issue.code === "reference_placeholder_requires_resolved_reference"
    ) {
      const match = /^\/reference_resolutions\/(\d+)\//u.exec(issue.path);
      const resolution = compiled.reference_resolutions[Number(match?.[1] ?? -1)];
      const selectorReferenceIndex = selectorReferenceIndexByOccurrence(selectors, resolution?.occurrence_id);
      if (selectorReferenceIndex >= 0 && resolution) {
        const selectorReference = selectors.references[selectorReferenceIndex]!;
        const requiredAction = PLACEHOLDER_COVERAGE_CODES.has(issue.code)
          ? "account_for_uncovered_referenced_content_from_actual_source"
          : issue.code === "reference_placeholder_has_item_destination"
            ? "remove_placeholder_item_destinations_or_stop_using_placeholder"
            : "resolve_the_referenced_occurrence_or_stop_using_placeholder";
        const mapped = remapAuthoredReferenceIssue(
          issue,
          issue.code === "reference_placeholder_has_item_destination"
            ? `/references/${selectorReferenceIndex}/destinations`
            : `/references/${selectorReferenceIndex}/application_mode`,
          resolution.occurrence_id,
          requiredAction,
        );
        if (PLACEHOLDER_COVERAGE_CODES.has(issue.code)) {
          const referencePath = `/references/${selectorReferenceIndex}`;
          const nextToolArguments = selectorReference.key
            ? { collection: "references", key: selectorReference.key }
            : { collection: "references" };
          return [{
            ...mapped,
            details: {
              ...issueDetailsRecord(mapped),
              required_action: requiredAction,
              actual: {
                reference_key: selectorReference.key,
                occurrence_id: resolution.occurrence_id,
                application_mode: selectorReference.application_mode,
              },
              writable_collections: ["references", "items", "sampling_rules", "lots", "source_dispositions"],
              writable_paths: [
                `${referencePath}/application_mode`,
                `${referencePath}/destinations`,
                `${referencePath}/component_dispositions`,
                `${referencePath}/import_scope`,
                "/items",
                "/sampling_rules",
                "/lots",
                "/source_dispositions",
              ],
              allowed_actions: [
                "保留 reference_placeholder；实际判据由真实验收 item 承载，抽样内容由真实 item 选中的 sampling_rules 分支组件承载，绑定精确来源。规则 complete_span_ids 或未选分支不能证明已接收。",
                "非项目内容在 lots[].scope_span_ids 或 source_dispositions 中保留完整精确来源与具体理由；已有真实接收者无需另造验收项。",
                "若原文关系并非纯占位，改用适合的 application_mode，并同步对应 destinations、import_scope 或 component_dispositions。",
              ],
              candidate_read_tool: "read_target_selectors",
              candidate_read_tools: [
                "read_target_selectors",
                "list_reference_occurrences",
                "read_reference_facts",
                "read_document_reference_evidence",
              ],
              next_tool: "read_target_selectors",
              next_tool_arguments: nextToolArguments,
              next_tools: [
                "read_target_selectors",
                "list_reference_occurrences",
                "read_reference_facts",
                "read_document_reference_evidence",
                "stage_target_selector_draft",
              ],
              save_tool: "stage_target_selector_draft",
              how_to_pass: "先按 next_tool_arguments 读取当前 reference，再用 read_target_selectors 的 collection=items 取得目录并按 key 读取可能相关的完整 item；抽样接收关系读取 collection=sampling_rules，非项目来源读取 collection=lots 或 collection=source_dispositions。用 list_reference_occurrences 核对该 occurrence 的 analysis_mode 和 target_key；inline 目标用 read_document_reference_evidence，isolated 目标先只传 target_key 调用 read_reference_facts 取得目录，再复制实际 entry_id 打开必要原文。由模型依据原文逐段处理 uncovered_evidence_ids 或 uncovered_data_row_evidence_ids：真实判据、被选中的抽样组件或有理由的非项目来源保留须覆盖全部缺失内容；纯占位保持空 destinations，并非纯占位才修改 application_mode 并同步实际引用关系。用 stage_target_selector_draft 保存所改集合的完整记录，再执行原验证。",
              do_not_edit: "不可变引用原文、编译生成的语义计划或无关且已正确的 selector 记录。",
            } as OwnedSelectorIssue["details"],
          }];
        }
        return [mapped];
      }
      return [classifySelectorIssue("strict-validator", issue)];
    }
    if (issue.code === "reference_destination_required") {
      const match = /^\/reference_resolutions\/(\d+)\/destination_bindings$/u.exec(issue.path);
      const resolution = compiled.reference_resolutions[Number(match?.[1] ?? -1)];
      const selectorReferenceIndex = resolution
        ? selectors.references.findIndex((reference) =>
            reference.occurrence_id === resolution.occurrence_id
          )
        : -1;
      if (selectorReferenceIndex >= 0) {
        const issueDetails = issue.details && typeof issue.details === "object" && !Array.isArray(issue.details)
          ? issue.details as Record<string, unknown>
          : {};
        const originField = typeof issueDetails.origin_field === "string"
          ? issueDetails.origin_field
          : undefined;
        return [{
          ...issue,
          path: `/references/${selectorReferenceIndex}/destinations`,
          details: {
            ...issueDetails,
            compiled_path: issue.path,
            occurrence_id: resolution!.occurrence_id,
            required_action: originField
              ? `bind_destination_to_origin_field_${originField}`
              : "bind_destination_to_the_registered_origin_field_keep_reference_may_leave_target_span_ids_empty",
          },
          owner: "selector_input_error" as const,
        }];
      }
      return [classifySelectorIssue("strict-validator", issue)];
    }
    if (STRICT_TABLE_PATH_CODES.has(issue.code)) {
      const match = /^\/acceptance_items\/(\d+)\/table_semantics$/u.exec(issue.path);
      const compiledItemIndex = Number(match?.[1] ?? -1);
      const compiledItem = compiled.acceptance_items[compiledItemIndex];
      const selectorItemIndex = compiledItem
        ? selectorItemByCompiledId.get(compiledItem.item_id)
        : undefined;
      const selectorTable = selectorItemIndex === undefined
        ? undefined
        : selectors.items[selectorItemIndex]?.table;
      const compiledTable = compiledItem?.table_semantics;
      const authoredPathMissing = selectorTable !== null
        && selectorTable !== undefined
        && selectorTable.properties.row_path_span_ids.length === 0
        && selectorTable.properties.column_path_span_ids.length === 0;
      const compiledPathMissing = compiledTable !== null
        && compiledTable !== undefined
        && compiledTable.row_path.length === 0
        && compiledTable.column_path.length === 0;
      if (selectorItemIndex !== undefined && authoredPathMissing && compiledPathMissing) {
        return [{
          ...issue,
          path: `/items/${selectorItemIndex}/table/properties/row_path_span_ids`,
          details: {
            compiled_path: issue.path,
            alternative_selector_path: `/items/${selectorItemIndex}/table/properties/column_path_span_ids`,
            required_action: "bind_at_least_one_exact_semantic_row_or_column_path_cell",
          },
          owner: "selector_input_error" as const,
        }];
      }
      return [classifySelectorIssue("strict-validator", issue)];
    }
    if (issue.code === "inspection_data_type_evidence_relation") {
      const match = /^\/acceptance_items\/(\d+)\/inspection_data_type_evidence_ids$/u.exec(issue.path);
      const compiledItem = compiled.acceptance_items[Number(match?.[1] ?? -1)];
      const selectorItemIndex = compiledItem
        ? selectorItemByCompiledId.get(compiledItem.item_id)
        : undefined;
      const selectorItem = selectorItemIndex === undefined ? undefined : selectors.items[selectorItemIndex];
      if (selectorItemIndex !== undefined && selectorItem && compiledItem) {
        const authoredEvidenceIds = selectorItem.inspection_data_type_span_ids.flatMap((spanId) => {
          const span = registeredById.get(spanId);
          return span ? [span.evidence_id] : [];
        });
        const faithful = authoredEvidenceIds.length === selectorItem.inspection_data_type_span_ids.length
          && sameIntervals([...new Set(authoredEvidenceIds)], compiledItem.inspection_data_type_evidence_ids);
        if (faithful) {
          const strictDetails = issueDetailsRecord(issue);
          const actualEvidenceIds = Array.isArray(issue.details) ? issue.details : strictDetails.actual;
          const implicatedEvidenceIds = new Set(Array.isArray(actualEvidenceIds)
            ? actualEvidenceIds.filter((value): value is string => typeof value === "string")
            : []);
          const implicatedBindings = selectorItem.inspection_data_type_span_ids.flatMap((spanId, spanIndex) => {
            const span = registeredById.get(spanId);
            return span && (implicatedEvidenceIds.size === 0 || implicatedEvidenceIds.has(span.evidence_id))
              ? [{
                  path: `/items/${selectorItemIndex}/inspection_data_type_span_ids/${spanIndex}`,
                  span_id: spanId,
                  evidence_id: span.evidence_id,
                }]
              : [];
          });
          const bindings = implicatedBindings.length
            ? implicatedBindings
            : [{
                path: `/items/${selectorItemIndex}/inspection_data_type_span_ids`,
                span_id: "",
                evidence_id: "",
              }];
          const writablePaths = [
            `/items/${selectorItemIndex}/inspection_data_type`,
            `/items/${selectorItemIndex}/inspection_data_type_reason`,
            `/items/${selectorItemIndex}/inspection_data_type_span_ids`,
          ];
          return bindings.map((binding) => ({
              ...issue,
              path: binding.path,
              details: {
                compiled_path: issue.path,
                strict_issue_details: issue.details,
                required_action: "select_only_exact_evidence_that_supports_this_item_inspection_data_type",
                actual: {
                  item_key: selectorItem.key,
                  inspection_data_type: selectorItem.inspection_data_type,
                  invalid_evidence_ids: [...implicatedEvidenceIds],
                  current_span_id: binding.span_id,
                  current_evidence_id: binding.evidence_id,
                },
                allowed_actions: [
                  "检查类型正确时，仅从 inspection_data_type_span_ids 移除无关来源，并定位、登记真正支持该类型的精确原文 span。",
                  "检查类型本身不符合原文时，同时修正 inspection_data_type、inspection_data_type_reason 和支撑 span_ids，使三者重新一致。",
                ],
                writable_paths: writablePaths,
                writable_collections: ["items"],
                candidate_read_tool: "read_target_selectors",
                candidate_read_tools: ["read_target_selectors", "open_evidence", "locate_evidence_span"],
                next_tool: "read_target_selectors",
                next_tools: ["read_target_selectors", "open_evidence", "locate_evidence_span", "stage_target_selector_draft"],
                save_tool: "stage_target_selector_draft",
                how_to_pass: "先用 read_target_selectors 读取当前 item 的检查类型、理由和全部支撑 span，再用 open_evidence 打开 invalid_evidence_ids 对应原文；需要新 span 时用 locate_evidence_span 从实际原文定位。由模型依据原文选择 allowed_actions，使用 stage_target_selector_draft 同步保存检查类型、理由和 span_ids 后重试。不得仅为消错更改业务类型或借用其他 item 的证据。",
                do_not_edit: "不可变原文、编译产物、其他 item 的来源和已经正确的字段。",
              },
              owner: "selector_input_error" as const,
            }));
        }
      }
      return [classifySelectorIssue("strict-validator", issue)];
    }
    if (!STRICT_FIELD_RELATION_CODES.has(issue.code)) {
      return [classifySelectorIssue("strict-validator", issue)];
    }
    const match = /^\/acceptance_items\/(\d+)\/field_bindings\/([^/]+)\/evidence_ids$/u.exec(issue.path);
    const compiledItemIndex = Number(match?.[1] ?? -1);
    const field = match?.[2] as AcceptanceItemField | undefined;
    const compiledItem = compiled.acceptance_items[compiledItemIndex];
    const selectorItemIndex = compiledItem
      ? selectorItemByCompiledId.get(compiledItem.item_id)
      : undefined;
    if (
      selectorItemIndex === undefined
      || field === undefined
      || !ACCEPTANCE_ITEM_FIELDS.has(field)
      || !compiledItem
    ) {
      return [classifySelectorIssue("strict-validator", issue)];
    }
    const projection = authoredFieldProjection(selectors, selectorItemIndex, field);
    const binding = compiledItem.field_bindings[field];
    const authoredIntervals = projection.span_ids.flatMap((spanId) => {
      const span = registeredById.get(spanId);
      return span ? [intervalKey(span)] : [];
    });
    const compiledIntervals = binding.source_span_ids.flatMap((spanId) => {
      const span = compiledSpanById.get(spanId);
      return span ? [intervalKey(span)] : [];
    });
    const faithful = authoredIntervals.length === projection.span_ids.length
      && compiledIntervals.length === binding.source_span_ids.length
      && projection.composition === binding.composition
      && sameIntervals(authoredIntervals, compiledIntervals);
    if (!faithful) return [classifySelectorIssue("strict-validator", issue)];

    const actualEvidenceIds = Array.isArray(issue.details) ? issue.details : issueDetailsRecord(issue).actual;
    const implicatedEvidenceIds = new Set(
      Array.isArray(actualEvidenceIds)
        ? actualEvidenceIds.filter((value): value is string => typeof value === "string")
        : [],
    );
    const implicatedSpanIndexes = projection.span_ids.flatMap((spanId, spanIndex) => {
      const span = registeredById.get(spanId);
      return span && (implicatedEvidenceIds.size === 0 || implicatedEvidenceIds.has(span.evidence_id))
        ? [spanIndex]
        : [];
    });
    const selectorPaths = implicatedSpanIndexes.length > 0
      ? implicatedSpanIndexes.map((spanIndex) => `${projection.span_path}/${spanIndex}`)
      : [projection.span_path];
    const selectorItem = selectors.items[selectorItemIndex]!;
    const fieldRoutes = (selectors.references ?? []).flatMap((reference, referenceIndex) => {
      const matchingDestinationIndexes = reference.destinations.flatMap((destination, destinationIndex) => (
        destination.item_key === selectorItem.key && destination.target_field === field
          ? [destinationIndex]
          : []
      ));
      return reference.application_mode !== "reference_placeholder" && matchingDestinationIndexes.length > 0
        ? [{
            path: `/references/${referenceIndex}`,
            key: reference.key,
            occurrence_id: reference.occurrence_id,
            target_span_ids: reference.target_span_ids,
            import_scope: reference.import_scope,
            destination_snapshot: reference.destinations.map((destination, destinationIndex) => ({
              destination_index: destinationIndex,
              item_key: destination.item_key,
              target_fields: [destination.target_field],
            })),
            matching_destination_indexes: matchingDestinationIndexes,
          }]
        : [];
    });
    return selectorPaths.map((selectorPath, index) => {
      const currentSpan = implicatedSpanIndexes.length
        ? registeredById.get(projection.span_ids[implicatedSpanIndexes[index]!]!)
        : undefined;
      const placeholderSources = currentSpan ? selectors.references.flatMap((reference, referenceIndex) => {
        if (reference.application_mode !== "reference_placeholder") return [];
        const matchingTargetSpanIds = reference.target_span_ids.filter(id => {
          const target = registeredById.get(id);
          return target && target.evidence_id === currentSpan.evidence_id
            && target.start <= currentSpan.start && target.end >= currentSpan.end;
        });
        return matchingTargetSpanIds.length ? [{
          reference_key: reference.key, path: `/references/${referenceIndex}`, occurrence_id: reference.occurrence_id,
          matching_target_span_ids: matchingTargetSpanIds, destinations: reference.destinations,
          match_basis: "authored_target_span_contains_rejected_span",
        }] : [];
      }) : [];
      return {
        ...issue,
        path: selectorPath,
        message: "该字段选择了尚未关联到本项及该字段的来源；只修复列出的 span，不要把同字段的其他来源一起删掉。",
        details: {
        compiled_path: issue.path,
        strict_issue_details: issue.details,
        selector_destination_path: projection.destination_path,
        actual: implicatedSpanIndexes.length
          ? {
              item_key: selectorItem.key,
              item_index: selectorItemIndex,
              field,
              span_id: currentSpan?.span_id,
              evidence_id: currentSpan?.evidence_id,
              atom_id: currentSpan?.atom_id,
              start: currentSpan?.start,
              end: currentSpan?.end,
              text_sha256: currentSpan?.text_sha256,
            }
          : {
              item_key: selectorItem.key,
              item_index: selectorItemIndex,
              field,
              span_ids: projection.span_ids,
              unrelated_evidence_ids: [...implicatedEvidenceIds],
            },
        affected_item_key: selectorItem.key,
        affected_field: field,
        local_evidence_ids: compiledItem.evidence_ids,
        matching_reference_routes: fieldRoutes,
        matching_reference_routes_basis: "same_item_and_field_destination_only_not_source_membership",
        matching_placeholder_sources: placeholderSources,
        writable_path: selectorPath,
        writable_paths: [projection.span_path, "/references", ...(placeholderSources.length
          ? [`/items/${selectorItemIndex}/criterion_span_ids`, `/items/${selectorItemIndex}/continuation_span_ids`, ...(selectorItem.table ? [`/items/${selectorItemIndex}/table`] : [])] : [])],
        writable_collection: "items",
        required_action: "核对这条来源：若确实属于当前 item.field 的被引内容则补齐同 item_key、target_field 的引用路由；若来源选错则仅移除或改选该 span。",
        allowed_actions: [
          "若模型依据原文确认该来源确实属于当前 item.field 的被引内容，保留或补齐 matching_reference_routes 中同 item_key、target_field 的真实 destination、target spans 和 import_scope；只替换当前报错 span，保留同字段其他正确来源。",
          "若模型依据原文确认该来源选错或不属于当前字段，只从当前字段移除或改选该报错 span；不要删除同字段其他正确来源，也不要修改不可变原文。",
          ...(placeholderSources.length ? ["matching_placeholder_sources 只表示当前 target span 包含报错片段，尚不证明归属。核对对应 occurrence、精确本地 table anchor 及本叶已承载的来源；placeholder destinations 必须保持为空，不得为消错填入 destination。"] : []),
        ],
        writable_collections: ["items", "references"],
        how_to_pass: "先用 open_evidence(evidence_id=actual.evidence_id, cursor=0) 核对当前报错 span 的不可变原文，再用 read_target_selectors(collection=items, key=affected_item_key) 读取该 item 的完整字段，并用 read_target_selectors(collection=references) 读取 references。若原文确实属于被引内容，再按 occurrence_id 用 list_reference_occurrences 核对引用；inline 目标用 read_document_reference_evidence(target_key=...)，isolated 目标用 read_reference_facts(target_key=...)，必要时用 locate_evidence_span(evidence_id=..., quote=...) 定位模型从已读原文选择的精确子区间。由模型依据原文选择作者路径：普通引用先确认报错来源确属该 occurrence，再补齐同 item_key、target_field、target spans 和 import_scope；placeholder 按 matching_placeholder_sources 读取对应记录，保持 destinations=[] 并核对本叶精确来源和表格 anchor；来源选错时只移除或改选当前报错 span。matching_reference_routes 仅按 destination 匹配，不证明来源属于该引用。不得替模型判断引用适用性、item、字段或答案；保留同字段其他正确来源，最后用 stage_target_selector_draft 保存 writable_paths 后重试原验证。",
        candidate_read_tool: "open_evidence",
        candidate_read_tools: [
          "open_evidence",
          "read_target_selectors",
          "list_reference_occurrences",
          "read_document_reference_evidence",
          "read_reference_facts",
          "locate_evidence_span",
        ],
        next_tool: "open_evidence",
        next_tool_arguments: { evidence_id: currentSpan?.evidence_id ?? "actual.evidence_id", cursor: 0 },
        next_tools: [
          "open_evidence",
          "read_target_selectors",
          "list_reference_occurrences",
          "read_document_reference_evidence",
          "read_reference_facts",
          "locate_evidence_span",
          "stage_target_selector_draft",
        ],
        tool_argument_hints: {
          open_evidence: { evidence_id: currentSpan?.evidence_id ?? "actual.evidence_id", cursor: 0 },
          read_target_selectors: [
            { collection: "items", key: selectorItem.key },
            { collection: "references", key: "按 matching_reference_routes 或 occurrence_id 读取；可省略 key 读取目录" },
          ],
          list_reference_occurrences: { cursor: 0, limit: 100 },
          read_document_reference_evidence: { target_key: "从 occurrence 读取的 inline target_key", cursor: 0, limit: 24 },
          read_reference_facts: { target_key: "从 occurrence 读取的 isolated target_key", entry_ids: ["只填写模型确认需要核对的条目"] },
          locate_evidence_span: {
            evidence_id: currentSpan?.evidence_id ?? "actual.evidence_id",
            quote: "仅填写已打开原文中由模型选择的精确子串",
            prefix: "可选",
            suffix: "可选",
          },
        },
        save_tool_instruction: "先用 read_target_selectors 读取并保留待修改的完整记录，只改 writable_paths 指定字段；以 operation=upsert 调用 stage_target_selector_draft，将修改后的完整记录按集合放入 draft.items 或 draft.references（两者可同次提交），保留未被点名的正确字段。writable_paths 是诊断元数据，不是工具参数。",
        reference_source_instruction: "matching_reference_routes 仅按 destination 匹配，并不保证当前报错来源属于这些 occurrence。先核对实际目标归属；不能把另一 occurrence 的来源塞入已有上游引用。若 matching_placeholder_sources 非空，按该 reference_key 读取完整记录并核对真实叶 criterion/continuation、typed table 或选中共享抽样组件的精确来源；表头或 table_key 本身不能代替实际数据行归属。完成真实绑定后保存完整记录并重试原验证。",
        save_tool: "stage_target_selector_draft",
        do_not_edit: "编译生成的 evidence_ids、field_bindings 和不可变原文；保留未被本条报错点名的正确来源。",
      },
        owner: "selector_input_error" as const,
      };
    });
  });
  return pairReferencedTableRouteTwins(owned);
}

function pairReferencedTableRouteTwins(issues: OwnedSelectorIssue[]): OwnedSelectorIssue[] {
  const routeCompiledPaths = new Set(
    issues.flatMap((issue) => {
      if (issue.code !== "table_reference_route_missing" || issue.owner !== "selector_input_error") return [];
      const compiledPath = issueDetailsRecord(issue).compiled_path;
      return typeof compiledPath === "string" ? [compiledPath, issue.path] : [issue.path];
    }),
  );
  const routeItemKeys = new Set(
    issues.flatMap((issue) => {
      if (issue.code !== "table_reference_route_missing" || issue.owner !== "selector_input_error") return [];
      const itemKey = issueDetailsRecord(issue).affected_item_key;
      return typeof itemKey === "string" && itemKey ? [itemKey] : [];
    }),
  );
  return issues.map((issue) => {
    if (issue.code !== "table_evidence_relation" || issue.owner !== "compiler_invariant_violation") return issue;
    const details = issueDetailsRecord(issue);
    const compiledPath = typeof details.compiled_path === "string" ? details.compiled_path : issue.path;
    const itemKey = typeof details.affected_item_key === "string" ? details.affected_item_key : "";
    if (!routeCompiledPaths.has(compiledPath) && !routeCompiledPaths.has(issue.path) && !routeItemKeys.has(itemKey)) {
      return issue;
    }
    return {
      ...issue,
      owner: "selector_input_error" as const,
      details: {
        ...details,
        required_action: "add_or_retarget_the_resolved_reference_destination_to_this_table_item",
        writable_collection: "references",
        next_tool: "list_reference_occurrences",
        companion_issue: "table_reference_route_missing",
      },
    };
  });
}

export function decideStrictSelectorPreflight(ownedIssues: readonly OwnedSelectorIssue[]): {
  selectorOwned: boolean;
  issueOwner: "selector_input_error" | "compiler_invariant_violation" | "final_contract_violation";
  reportedIssues: OwnedSelectorIssue[];
} {
  const selectorIssues = ownedIssues.filter((issue) => issue.owner === "selector_input_error");
  const compilerIssues = ownedIssues.filter((issue) => issue.owner === "compiler_invariant_violation");
  const otherIssues = ownedIssues.filter((issue) =>
    issue.owner !== "selector_input_error" && issue.owner !== "compiler_invariant_violation"
  );
  const pairedEvidenceOnly = compilerIssues.length > 0
    && compilerIssues.every((issue) => issue.code === "table_evidence_relation")
    && selectorIssues.some((issue) => issue.code === "table_reference_route_missing");
  if (selectorIssues.length > 0 && compilerIssues.length === 0 && otherIssues.length === 0) {
    return {
      selectorOwned: true,
      issueOwner: "selector_input_error",
      reportedIssues: [...ownedIssues],
    };
  }
  if (selectorIssues.length > 0 && pairedEvidenceOnly && otherIssues.length === 0) {
    return {
      selectorOwned: true,
      issueOwner: "selector_input_error",
      reportedIssues: pairReferencedTableRouteTwins([...ownedIssues]),
    };
  }
  if (compilerIssues.length > 0) {
    return {
      selectorOwned: false,
      issueOwner: "compiler_invariant_violation",
      reportedIssues: [...ownedIssues],
    };
  }
  return {
    selectorOwned: false,
    issueOwner: "final_contract_violation",
    reportedIssues: [...ownedIssues],
  };
}

export function hasIssueOwner(
  issues: readonly OwnedSelectorIssue[],
  owner: SelectorIssueOwner,
): boolean {
  return issues.some((issue) => issue.owner === owner);
}
