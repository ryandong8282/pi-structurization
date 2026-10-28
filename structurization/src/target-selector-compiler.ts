import { Type, type Static, type TSchema } from "typebox";
import { Check, Errors } from "typebox/value";
import { partitionValidationIssues, STRUCTURAL_VALIDATION_BOUNDARY, type ValidationBoundary } from "./validation-boundary.js";

import { canonicalize, sha256Text } from "./canonical.js";
import { ACCEPTANCE_BRANCH_SOURCE_COVERAGE_GUIDANCE, ITEM_CATEGORY_GUIDANCE, ITEM_NAME_PATH_GUIDANCE, isDirectFullInspectionQuantity, MULTI_SOURCE_REFERENCE_FIELD_GUIDANCE, SAMPLING_COMPLETE_SPAN_GUIDANCE, SELECTOR_SAMPLING_GUIDANCE, SELECTOR_PENDING_SAMPLING_REPAIR_GUIDANCE, TABLE_SOURCE_OWNERSHIP_GUIDANCE } from "./acceptance-delivery-contract.js";
import { independentItemMergeIssues } from "./independent-item-boundaries.js";
import { projectReferencedTableDestinations } from "./reference-table-destination-projection.js";
import {
  ACCEPTANCE_NAME_REVIEW_PREFIX,
  UNLABELED_ITEM_CATEGORY,
  referenceOccurrenceLiteralSpanIds,
  referenceOccurrenceOriginEvidenceIds,
  type AcceptanceItemField,
  type EvidenceManifest,
  type PersistedSemanticSourcePlan,
  type ReferenceApplicationMode,
  type ReferenceImportScope,
  type ReferenceResolutionAction,
  type ReferenceTargetField,
  type SourceBindingComposition,
  type TableReferenceOccurrence,
  type TableCellEvidenceRole,
  type TableCriterionSourceKind,
} from "./contracts.js";
import {
  compileSemanticDecisionsV8,
  SemanticDecisionCompileError,
  type EvidenceSpanDecision,
  type SemanticDecisionPlan,
  type SemanticFieldDecision,
} from "./semantic-decision-compiler.js";
import {
  htmlTableCellSpans,
  tableEvidenceCellSpans,
  locateSourceQuote,
  resolveSourceSpan,
  sourceSpanCoveredBy as coveredBySpans,
  sourceSpanGaps,
  type HtmlTableCellSpan,
  type ImmutableTextSource,
  type SourceSpanIssue,
  type SourceSpanRegistry,
} from "./source-span-registry.js";
import {
  dominantSourceLanguage,
  sourceLanguageMismatch,
} from "./source-language.js";
import { collectSelectorSpanIds, selectorDispositionCoverage } from "./evidence-disposition-coverage.js";
import { selectorHasContextReference, selectorContextReferenceOrigins, selectorContextReferenceFacts } from "./context-reference.js";
import { nonItemReferenceSpans, resolvedReferenceComponentCoverageIssues } from "./reference-component-coverage.js";
import { confirmedTableRowRoles, type TableStructurePlan } from "./table-structure.js";
import { clauseReferenceGroupLocalResidual } from "./validator.js";
import { mergeSamplingComponents } from "./sampling-components.js";
import {
  deriveSamplingScript,
  samplingConfidenceForStatus,
  samplingScriptForStatus,
} from "./sampling-script.js";

export const TARGET_SELECTOR_PLAN_SCHEMA_VERSION = "target-selector-plan/v6" as const;
export const REFERENCE_APPLICATION_MODE_SEMANTICS = {
  reference_only: {
    explicit_name: "retain_local_field_and_attach_reference",
    effect: "完整保留本地字段和原引用文字，永久保存 occurrence/provenance，并把全部被引内容关联到真实业务字段中的精确引用位置。若模型确认引用只属背景，全部 origin 原文已显式 source_dispositions=context 且未用于任何业务来源，可用 action=mention、精确 target_span_ids、destinations=[]、省略 origin_binding 保存背景回执，不导入验收内容；不能用此路径排除实际使用的来源。",
  },
  reference_placeholder: {
    explicit_name: "retain_non_item_reference_placeholder",
    effect: "仅保留纯指针父条款的 occurrence、原文位置和被引目标 provenance；不形成验收叶，destinations 必须为空。适用于已解析且全部被引内容已有明确去向的内部引用：适用判据由真实验收项承载，非项目内容以精确 span 绑定 lots[].scope_span_ids 或逐段 source_dispositions（context/ignored 及具体理由）；单写组件 not_applicable/reason 或 residual 不能代替来源保留。真实叶字段可用 reference 组合多个引用的来源，但必须由该叶的 criterion/continuation、typed table 或选中共享抽样分支的有效 present 组件证明片段归属，不向占位记录补 destination。共享抽样不能代替真实验收判据或表格 anchor。表格 target_span_ids 可留空并由编译器绑定合法数据行，章节/条款必须保留已覆盖的精确 target_span_ids。",
  },
} as const;

const REFERENCE_APPLICATION_MODE_DESCRIPTION = [
  "application_mode 对应以下完整语义：",
  ...Object.entries(REFERENCE_APPLICATION_MODE_SEMANTICS).map(([wire, semantics]) =>
    `${wire} = ${semantics.explicit_name}: ${semantics.effect}`
  ),
].join(" ");
export const LEGACY_TARGET_SELECTOR_PLAN_SCHEMA_VERSION_V4 = "target-selector-plan/v4" as const;
export const LEGACY_TARGET_SELECTOR_PLAN_SCHEMA_VERSION_V3 = "target-selector-plan/v3" as const;
export const LEGACY_TARGET_SELECTOR_PLAN_SCHEMA_VERSION_V2 = "target-selector-plan/v2" as const;

const strictObject = <T extends Parameters<typeof Type.Object>[0]>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });

export const SOURCE_SPAN_ID_PATTERN = "^span:[a-f0-9]{32}$";
const SpanIdSchema = Type.String({ pattern: SOURCE_SPAN_ID_PATTERN });
const SpanIdsSchema = Type.Array(SpanIdSchema);
const RequiredSpanIdsSchema = Type.Array(SpanIdSchema, { minItems: 1 });
const TablePathSchema = Type.Array(Type.Array(SpanIdSchema, {
  minItems: 1,
  description: "每个行/列路径元素至少绑定一个真实来源 span。未选择该方向的路径时使用外层 []，不能用 [[]] 或空数组占位；由模型依据原文决定省略该方向或绑定实际路径，保留其他正确字段。",
}));
const OptionalSpanIdsSchema = Type.Optional(SpanIdsSchema);
const SemanticTextSchema = Type.String();
const ReferenceImportFieldSchema = Type.Union([
  Type.Literal("name"),
  Type.Literal("requirement"),
  Type.Literal("method"),
  Type.Literal("quantity"),
  Type.Literal("note"),
  Type.Literal("sampling"),
]);
const ReferenceImportScopeSchema = strictObject({
  mode: Type.Union([
    Type.Literal("field_specific"),
    Type.Literal("full_acceptance_procedure"),
  ]),
  allowed_fields: Type.Array(ReferenceImportFieldSchema, { minItems: 1, uniqueItems: true }),
  reason: Type.String({ minLength: 1 }),
});

export const SAMPLING_COMPONENT_ROLES = [
  "applicability",
  "branch_condition",
  "method",
  "quantity",
  "acceptance_criterion",
  "exception",
  "note",
] as const;
export type SamplingComponentRole = typeof SAMPLING_COMPONENT_ROLES[number];

const SamplingComponentRoleSchema = Type.Union([
  Type.Literal("applicability"),
  Type.Literal("branch_condition"),
  Type.Literal("method"),
  Type.Literal("quantity"),
  Type.Literal("acceptance_criterion"),
  Type.Literal("exception"),
  Type.Literal("note"),
]);

const SAMPLING_COMPONENT_ROLE_DESCRIPTION = "组件的语义角色：applicability、branch_condition、method、quantity、acceptance_criterion、exception、note。来源不存在时仍保留对应 role，只把 disposition 设为 absent/not_applicable；absent 不是 role。";
const SamplingComponentSchema = strictObject({
  key: Type.String({ minLength: 1 }),
  role: Type.Union(SamplingComponentRoleSchema.anyOf, { description: SAMPLING_COMPONENT_ROLE_DESCRIPTION }),
  disposition: Type.Union([
    Type.Literal("present"),
    Type.Literal("absent"),
    Type.Literal("not_applicable"),
  ]),
  span_ids: SpanIdsSchema,
  reason: SemanticTextSchema,
});

const FieldSelectorSchema = strictObject({
  composition: Type.Union([
    Type.Literal("verbatim"),
    Type.Literal("semantic_summary"),
    Type.Literal("shared_inheritance"),
    Type.Literal("reference"),
    Type.Literal("not_applicable"),
  ], { description: "semantic_summary 仅适用于 item.fields.name。其他字段精确绑定原文，未规定时用 not_applicable、span_ids=[]；不能从验收要求推断检验方法。引用接收细则见 authoring_protocols.reference_routes。" }),
  span_ids: SpanIdsSchema,
  separator: Type.Union([Type.Literal(""), Type.Literal(" "), Type.Literal("\n")]),
  reason: SemanticTextSchema,
});

const TablePropertiesSchema = strictObject({
  table_no_span_ids: SpanIdsSchema,
  table_title_span_ids: SpanIdsSchema,
  applicability_span_ids: SpanIdsSchema,
  row_path_span_ids: TablePathSchema,
  column_path_span_ids: TablePathSchema,
  unit_span_ids: Type.Array(SpanIdSchema, { description: "仅绑定实际计量单位，如 mm、%、MPa。合并的单位/数值单元格可能在单位列下重复要求，该列标签不会把设计值、限值或完整条件变成单位。有单位时仅绑定其子串，否则按原文语义填 []。" }),
  condition_span_ids: SpanIdsSchema,
  allowed_value_span_ids: RequiredSpanIdsSchema,
  acceptance_branches: Type.Optional(Type.Array(strictObject({
    key: Type.String({ minLength: 1 }),
    condition_span_ids: RequiredSpanIdsSchema,
    requirement_span_ids: RequiredSpanIdsSchema,
    allowed_value_span_ids: RequiredSpanIdsSchema,
    reason: SemanticTextSchema,
  }), {
    minItems: 2,
    description: `当前唯一验收维度的互斥情况，以权威的 condition → 完整 requirement/allowed-value 映射表达，不能把情况藏在 note。仅当同一维度确实存在至少两个互斥分支时才提交本字段；单一、无分支条件的判据必须整体省略本字段，信息放平铺的 condition_span_ids/allowed_value_span_ids，不要提交空数组。完整保留共同条件、单位、方法和抽样时，也允许无损拆成独立项目。${ACCEPTANCE_BRANCH_SOURCE_COVERAGE_GUIDANCE}`,
  })),
  inspection_method_span_ids: SpanIdsSchema,
});

export const SELECTOR_TABLE_KEY_GUIDANCE = "item.table.table_key 是作者为同一逻辑表选定并复用的非空分组键，不要求存在于导航目录；它本身不证明来源或覆盖。read_table_summary/read_table_rows 的 table_key 则必须来自可访问的导航目录。隔离引用表用 read_reference_facts 读取目录及选定条目，再对已读 evidence_id 用 locate_evidence_span 取得精确来源，在 item.table 填写 source_kind=reference、properties 和本地 reference_span_ids；不需要取得隐藏的 table-structure 键，也不会获得其读取或写入权限。";

export const TARGET_SELECTOR_ITEM_JSON_SCHEMA = strictObject({
  key: Type.String({ minLength: 1 }),
  lot_key: Type.String({
    minLength: 1,
    description: "指向父验收组/检验批。分组标题放父批 scope_span_ids，不放本项 continuation_span_ids。原文分别列出的验收项应保持独立，可进一步拆分，禁止合并独立项目。",
  }),
  name: SemanticTextSchema,
  name_path: Type.Optional(Type.Array(Type.String({
    minLength: 1, pattern: "^[^\\\\]+$", description: "单个名称层级，不含反斜杠；上级到下级分别放数组元素，不填空白占位。",
  }), { minItems: 1, description: ITEM_NAME_PATH_GUIDANCE })),
  category: Type.Union([
    Type.Literal("主控项目"), Type.Literal("一般项目"), Type.Literal(UNLABELED_ITEM_CATEGORY),
  ], { description: ITEM_CATEGORY_GUIDANCE }),
  criterion_span_ids: Type.Array(SpanIdSchema, {
    description: `仅绑定当前一个验收项的精确来源，不得汇集原文分别列出的独立项目；同项可由多个片段支持。共同条件、方法和引用证据不允许合并独立项目。${TABLE_SOURCE_OWNERSHIP_GUIDANCE}`,
  }),
  continuation_span_ids: Type.Array(SpanIdSchema, {
    description: "仅用于真正延续或补充同一验收要求的后续正文，每个 span 都须进入本项可见字段。禁止章节/分组标题及可独立执行的兄弟条款。",
  }),
  fields: strictObject({
    name: FieldSelectorSchema,
    requirement: FieldSelectorSchema,
    method: FieldSelectorSchema,
    quantity: FieldSelectorSchema,
    note: FieldSelectorSchema,
  }),
  table: Type.Union([
    Type.Null(),
    strictObject({
      source_kind: Type.Union([Type.Literal("direct"), Type.Literal("reference")]),
      table_key: Type.String({ minLength: 1, description: SELECTOR_TABLE_KEY_GUIDANCE }),
      properties: TablePropertiesSchema,
      reference_span_ids: SpanIdsSchema,
      reason: SemanticTextSchema,
    }),
  ], {
    description: "只要项目内容来自表格行（包括已解析引用表行），此字段就必须非空。范围内表用 source_kind=direct，引用表用 source_kind=reference；绑定精确角色属性 span。引用表还须绑定本地 reference_span_ids 及实际目标行/列入口 row/column_path_span_ids。仅无表格来源的项目可为 null。",
  }),
  inspection_data_type: Type.Union([
    Type.Literal("measurement"),
    Type.Literal("counting"),
    Type.Literal("mixed"),
    Type.Literal("review"),
  ], {
    description: "完整 item 的检查数据类型分类。必须与 inspection_data_type_reason、inspection_data_type_span_ids 同时保留；upsert 即使只修改其他字段也不能遗漏。",
  }),
  inspection_data_type_reason: Type.String({
    description: "说明 inspection_data_type 分类依据的必填理由。必须与 inspection_data_type 及 inspection_data_type_span_ids 同时保留；upsert 即使只修改其他字段也不能遗漏。",
  }),
  inspection_data_type_span_ids: Type.Array(SpanIdSchema, {
    description: "支撑 inspection_data_type 分类的已登记来源 span_ids；按既有字段契约允许时可为 []，但完整 item 中不得省略本字段。必须与 inspection_data_type 及 inspection_data_type_reason 同时保留；upsert 即使只修改其他字段也不能遗漏。",
  }),
  sampling: Type.Object({
    status: Type.Union([
      Type.Literal("pending"),
      Type.Literal("explicit"),
      Type.Literal("reference"),
      Type.Literal("reference_unspecified_quantity"),
      Type.Literal("fallback"),
      Type.Literal("not_sampling"),
    ]),
    rule_key: Type.String({ description: "reference/reference_unspecified_quantity 必填共享规则 key；pending/explicit/fallback/not_sampling 必须为空字符串。共享规则保存抽样依据，不在项目内重复填写。" }),
    branch_keys: Type.Array(Type.String({ minLength: 1 }), { description: "共享引用模式必须选择已声明的适用分支；没有业务条件时也选择规则中的默认结构分支。规则尚无分支时先补 sampling_rules[].branches，不从空列表选择。其他模式填 []。" }),
    quantity_span_ids: Type.Array(SpanIdSchema, { description: "仅 explicit 填直接数量来源；所有其他模式必须填 []。共享引用的数量依据保存在 sampling_rules 的选中分支或共同 components 中。" }),
    script_span_ids: Type.Array(SpanIdSchema, { description: "仅 explicit 填完整抽样依据原文的来源标识（兼容字段名，不是生成脚本），可复用 quantity_span_ids 对应的数量句；与 quantity/condition 必须属于同一 evidence_id。不是必须再找检验方法行；真实方法保留 fields.method，跨证据组合用 sampling_rules。所有其他模式必须填 []。" }),
    condition_span_ids: Type.Array(SpanIdSchema, { description: "explicit 可填直接适用条件来源；not_sampling 必须绑定原文明示不做数量抽样的适用依据，未单列数量不能证明不抽样。其他模式必须填 []，共享模式在规则 components 中保存条件。" }),
    reason: SemanticTextSchema,
    confidence: Type.Number({ minimum: 0, maximum: 1 }),
  }, { additionalProperties: false, description: SELECTOR_SAMPLING_GUIDANCE }),
  reason: Type.String({
    description: "每个完整 item 记录必填的顶层业务依据，用于说明该验收项为何这样组织来源与字段。它独立于 fields.*.reason、table.reason 和 sampling.reason；任何内层 reason 都不能代替本字段。",
  }),
});

const ReferenceComponentDispositionSchema = strictObject({
  component_span_ids: RequiredSpanIdsSchema,
  decision: Type.Union([
    Type.Literal("independent_item"),
    Type.Literal("same_judgment"),
    Type.Literal("acceptance_branch"),
    Type.Literal("not_applicable"),
  ]),
  item_keys: Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true }),
  reason: SemanticTextSchema,
});

export const TARGET_SELECTOR_PLAN_JSON_SCHEMA = strictObject({
  schema_version: Type.Literal(TARGET_SELECTOR_PLAN_SCHEMA_VERSION),
  job_id: Type.String({ minLength: 1 }),
  target_id: Type.String({ minLength: 1 }),
  lots: Type.Array(strictObject({
    key: Type.String({ minLength: 1 }),
    name: SemanticTextSchema,
    scope_span_ids: Type.Array(SpanIdSchema, {
      description: "检验批的精确范围/分组 span。“AAAA 应符合下列规定”等父标题只在此登记一次，原文独立列出的各验收项仍分别建子项并以 lot_key 关联。",
    }),
    reason: Type.String({ description: "说明这些项目为何属于同一实际验收范围；target 名称、预填分组或主控/一般栏目本身不是检验批成立依据。" }),
  })),
  items: Type.Array(TARGET_SELECTOR_ITEM_JSON_SCHEMA),
  sampling_rules: Type.Array(strictObject({
    key: Type.String({ minLength: 1 }),
    complete_span_ids: Type.Array(SpanIdSchema, { description: SAMPLING_COMPLETE_SPAN_GUIDANCE }),
    components: Type.Array(SamplingComponentSchema),
    branches: Type.Array(strictObject({
      key: Type.String({ minLength: 1 }),
      applies_to_category: Type.Union([
        Type.Literal("主控项目"),
        Type.Literal("一般项目"),
        Type.Literal("all_items"),
      ]),
      components: Type.Array(SamplingComponentSchema),
      reason: Type.String({
        description: "每个完整 branch 必填，用于说明该分支的适用范围和 components 组织依据；独立于 sampling_rules[].reason 和该分支 components[].reason，二者不能代替。",
      }),
    })),
    reason: SemanticTextSchema,
  })),
  references: Type.Array(strictObject({
    key: Type.String({ minLength: 1 }),
    anchor_span_ids: Type.Array(SpanIdSchema, {
      description: "引用原话在原始文档中的位置，不是被引内容导入的业务字段。已解析引用必须包含 resolve_document_reference 返回的全部精确 reference_literal_span_ids（旧单段回执为 reference_literal_span_id），不能漏段或只使用引用所在的整句 span。填写 anchor 不代表 origin_binding 指向的业务字段已包含引用原话。",
    }),
    target_span_ids: SpanIdsSchema,
    /**
     * 可选：直接点名要解析的那个不可变 occurrence。
     *
     * 一条条文引两张表时（`表格形式与内容宜符合表 8.0.7-1 和表 8.0.7-2 的规定`），
     * 两个 occurrence 的 origin_evidence_id 是同一条，锚点无从区分；退而用
     * target_span_ids 消歧也不成，因为作者能选的跨度落在 6000 字的原始原子上
     * （char:18080-24415），而 occurrence.target_evidence_ids 是表的行级证据
     * （line:657/table:8.0.7-2/row:N），两套坐标对不上，恒取不到交集。
     * 实测 GB/T 50312 两个目标各撞 12、14 次。
     *
     * occurrence_id 本来就是清单里的不可变事实，歧义提示也已经把候选 id 列出来了，
     * 却没有字段能填回去。给一个——点名比猜跨度归属可靠。
     * 它只在锚点已命中的候选里做选择，不能拿来指认没锚到的 occurrence。
     */
    occurrence_id: Type.Optional(Type.String({ minLength: 1 })),
    component_dispositions: Type.Optional(Type.Array(ReferenceComponentDispositionSchema, {
      description: "逐项处置 read_document_reference_evidence/read_reference_facts 返回的组件。每个 target span 必须恰好出现一次；映射到同一 item 的多个组件必须显式选择 same_judgment 或 acceptance_branch，不能只声明引用已闭合。",
    })),
    action: Type.Union([
      Type.Literal("adopt"),
      Type.Literal("conditional"),
      Type.Literal("compare"),
      Type.Literal("mention"),
      Type.Literal("keep_reference"),
      Type.Literal("review"),
    ]),
    application_mode: Type.Union([
      Type.Literal("reference_only"),
      Type.Literal("reference_placeholder"),
    ], { description: REFERENCE_APPLICATION_MODE_DESCRIPTION }),
    import_scope: ReferenceImportScopeSchema,
    origin_binding: Type.Optional(strictObject({
      item_key: Type.String({ minLength: 1 }),
      target_field: Type.Union(ReferenceImportFieldSchema.anyOf, {
        description: "实际包含本地引用原话的字段，不表示该字段的判据来自这次引用。reference_only 下，所选 item/field 的 span_ids 必须实际覆盖精确引用 literal；仅有 anchor 或被引判据不能代替。整句 span 已包含 literal 时，字段内不要再添加内部 literal span，避免重复显示；精确 literal 仍放在 anchor_span_ids。找不到这样的字段时，不要虚填 origin_binding：先核对 application_mode。只有纯指针引用已解析、适用判据由真实 item 承载、非项目内容由 lot.scope/source_dispositions 完整保留时，才考虑 reference_placeholder，并清空 destinations、保留 anchor/occurrence/target spans/provenance，通过 preflight 确认。不要为过校验把整段被引正文复制到每个 requirement，也不要删除必要条件。",
      }),
    },)),
    destinations: Type.Array(strictObject({
      item_key: Type.String({ minLength: 1 }),
      target_field: Type.Union([
        Type.Literal("name"),
        Type.Literal("requirement"),
        Type.Literal("method"),
        Type.Literal("quantity"),
        Type.Literal("note"),
        Type.Literal("sampling"),
      ], {
        description: "被引内容要补充到的业务字段，即内容导入位置，不是引用原话在原文中的 anchor，也不证明本字段包含引用原话。它独立于引用文字实际出现的 origin_binding，可按 component_dispositions/import_scope 分别导入 requirement、method 等字段；reference_placeholder 的 destinations 必须为空。",
      }),
    })),
    reason: Type.String({
      description: "必填的引用顶层说明。reference_only 至少用八个非空白字符具体说明为何保留引用而不替换权威字段；独立于 import_scope.reason 和组件处置理由。",
    }),
  })),
  source_dispositions: Type.Array(strictObject({
    span_ids: SpanIdsSchema,
    disposition: Type.Union([Type.Literal("context"), Type.Literal("ignored")]),
    reason: SemanticTextSchema,
  })),
  /**
   * 兜底交代：绑定与逐条 source_dispositions 之后仍未分类的主证据，一次性按此声明处置。
   *
   * 正文路的目标动辄有两三百条主证据，草稿批次只受统一的
   * 序列化字节上限约束，不再用固定记录数把本来很小的条目拆成数十次工具调用。
   *
   * 这是让作业跑得动的兜底，不是免检：它只覆盖「没被任何项目绑走」的那部分，
   * 条文覆盖仍由底账闸门单独把关。
   */
  /**
   * 兜底交代：绑定与逐条 source_dispositions 之后仍未分类的主证据，一次性按此处置。
   *
   * 使用字节上限保护工具传输；记录数随实际记录大小动态变化。
   *
   * 做成「至多一条的键控集合」而不是单对象：草稿工具整套是按键控数组设计的
   * （upsert / remove / replace_collection / 收敛跟踪），单对象塞不进去——
   * 实测模型照指引去写，被 selector_draft_requires_exactly_one_collection 挡了三次。
   *
   * 可选：已封存的 v5 计划没有这个字段，必填会让它们校验失败。
   */
  residual_source_dispositions: Type.Optional(Type.Array(strictObject({
    key: Type.String({ minLength: 1 }),
    disposition: Type.Union([Type.Literal("context"), Type.Literal("ignored")]),
    reason: SemanticTextSchema,
  }), { maxItems: 1 })),
  rationale: Type.Optional(SemanticTextSchema),
});

export type TargetSelectorPlan = Static<typeof TARGET_SELECTOR_PLAN_JSON_SCHEMA>;

// Keep persisted plans readable so old checkpoints can still be diagnosed and
// repaired. New author input cannot select a composition forbidden by the field.
const SourceFactFieldSelectorSchema = strictObject({
  ...FieldSelectorSchema.properties,
  composition: Type.Union([
    Type.Literal("verbatim"), Type.Literal("shared_inheritance"),
    Type.Literal("reference"), Type.Literal("not_applicable"),
  ], { description: "精确来源事实；原文未规定时用 not_applicable、span_ids=[]。引用接收细则见 authoring_protocols.reference_routes。" }),
});
export const TARGET_SELECTOR_AUTHOR_ITEM_JSON_SCHEMA = strictObject({
  ...TARGET_SELECTOR_ITEM_JSON_SCHEMA.properties,
  fields: strictObject({ name: FieldSelectorSchema, requirement: SourceFactFieldSelectorSchema,
    method: SourceFactFieldSelectorSchema, quantity: SourceFactFieldSelectorSchema, note: SourceFactFieldSelectorSchema }),
});
export const TARGET_SELECTOR_AUTHOR_PLAN_JSON_SCHEMA = strictObject({
  ...TARGET_SELECTOR_PLAN_JSON_SCHEMA.properties,
  items: Type.Array(TARGET_SELECTOR_AUTHOR_ITEM_JSON_SCHEMA),
});

const TARGET_SELECTOR_DRAFT_PLACEMENT_DESCRIPTION = "草稿业务集合容器。lots、items、sampling_rules、references、source_dispositions、residual_source_dispositions 都只能作为 draft 的子字段。业务参数顶层只允许 operation、draft_fingerprint、reference_selections、draft、quote_bindings、collection、remove_keys。普通完整记录写入 draft；已有项目的引用字段选择使用独立的 reference_selections 与当前 draft_fingerprint，不与 draft/remove_keys/replace_collection 混用。source_handle_scope 是模型短来源句柄包装追加的顶层会话参数，不属于业务字段；使用短句柄时必须携带，使用 canonical IDs 时可省略，不能放进 draft。";

export const TARGET_SELECTOR_DRAFT_JSON_SCHEMA = Type.Object({
  lots: Type.Optional(Type.Array(TARGET_SELECTOR_PLAN_JSON_SCHEMA.properties.lots.items, {
    description: "lots 草稿集合，只能写在 draft.lots，不能写在工具参数顶层。",
  })),
  items: Type.Optional(Type.Array(TARGET_SELECTOR_AUTHOR_ITEM_JSON_SCHEMA, {
    description: "items 草稿集合，只能写在 draft.items，不能写在工具参数顶层。",
  })),
  sampling_rules: Type.Optional(Type.Array(TARGET_SELECTOR_PLAN_JSON_SCHEMA.properties.sampling_rules.items, {
    description: "sampling_rules 草稿集合，只能写在 draft.sampling_rules，不能写在工具参数顶层。",
  })),
  references: Type.Optional(Type.Array(TARGET_SELECTOR_PLAN_JSON_SCHEMA.properties.references.items, {
    description: "references 草稿集合，只能写在 draft.references，不能写在工具参数顶层。",
  })),
  source_dispositions: Type.Optional(Type.Array(TARGET_SELECTOR_PLAN_JSON_SCHEMA.properties.source_dispositions.items, {
    description: "source_dispositions 草稿集合，只能写在 draft.source_dispositions，不能写在工具参数顶层。",
  })),
  residual_source_dispositions: Type.Optional(Type.Array(
    TARGET_SELECTOR_PLAN_JSON_SCHEMA.properties.residual_source_dispositions.items,
    {
      maxItems: 1,
      description: "residual_source_dispositions 草稿集合，只能写在 draft.residual_source_dispositions，不能写在工具参数顶层。",
    },
  )),
}, { additionalProperties: false, description: TARGET_SELECTOR_DRAFT_PLACEMENT_DESCRIPTION });

export type TargetSelectorDraft = Static<typeof TARGET_SELECTOR_DRAFT_JSON_SCHEMA>;

// Local quote aliases exist only in a staging call, never in saved selectors.
function draftQuoteAliasSchema<T>(value: T): T {
  if (Array.isArray(value)) return value.map(draftQuoteAliasSchema) as T;
  if (!value || typeof value !== "object") return value;
  const result = { ...value } as Record<string, unknown>;
  for (const [key, child] of Object.entries(result)) result[key] = draftQuoteAliasSchema(child);
  if (result.pattern === SOURCE_SPAN_ID_PATTERN) result.pattern = "^(?:span:[a-f0-9]{32}|\\$[A-Za-z][A-Za-z0-9_-]*)$";
  return result as T;
}

const ReferenceSelectionFieldSchema = Type.Union([
  Type.Literal("name"), Type.Literal("requirement"), Type.Literal("method"), Type.Literal("quantity"), Type.Literal("note"),
]);
export const REFERENCE_FIELD_SELECTION_SCHEMA = strictObject({
  occurrence_id: Type.String({ minLength: 1, description: "从已登记引用目录选择真实 occurrence，不猜测或重新登记。" }),
  action: Type.Union([Type.Literal("adopt"), Type.Literal("conditional"), Type.Literal("compare")]),
  reason: SemanticTextSchema,
  bindings: Type.Array(strictObject({
    item_key: Type.String({ minLength: 1 }),
    target_field: ReferenceSelectionFieldSchema,
    target_span_ids: RequiredSpanIdsSchema,
    component_decision: Type.Union([Type.Literal("independent_item"), Type.Literal("same_judgment"), Type.Literal("acceptance_branch")]),
    local_context_fields: Type.Array(strictObject({
      field: ReferenceSelectionFieldSchema,
      span_ids: RequiredSpanIdsSchema,
      reason: SemanticTextSchema,
    }), { description: "模型明确决定应保留在哪个显示字段的精确本地条件/引文片段；[] 只表示保持已有本地字段，不表示未规定或无条件。程序不自动复制整句。" }),
    reason: SemanticTextSchema,
  }), { minItems: 1, description: "仅列本次修改的项目/字段。未点名接收者和正确字段保留。程序同步确定的字段来源、目标、导入范围及接收关系，无须重复填写这些记录。" }),
  origin_binding: Type.Optional(strictObject({ item_key: Type.String({ minLength: 1 }), target_field: ReferenceSelectionFieldSchema })),
});

export const TARGET_SELECTOR_DRAFT_PATCH_JSON_SCHEMA = strictObject({
  draft_fingerprint: Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$", description: "reference_selections 必须携带当前草稿指纹；过期请求不保存。" })),
  reference_selections: Type.Optional(Type.Array(draftQuoteAliasSchema(REFERENCE_FIELD_SELECTION_SCHEMA), { minItems: 1,
    description: "引用字段选择事务：模型一次指定真实接收字段、精确目标片段及业务决定，程序原子同步旧选择器结构。只编辑已有项目；不与 draft、remove_keys 或 replace_collection 混用。" })),
  operation: Type.Optional(Type.Union([
    Type.Literal("upsert"),
    Type.Literal("replace_collection"),
  ], { description: "默认 upsert，按 key 替换完整记录；replace_collection 替换所提交集合的全部记录。修正未保存的参数错误时保留原操作意图，不能为修字段而清空集合。" })),
  draft: Type.Optional(draftQuoteAliasSchema(TARGET_SELECTOR_DRAFT_JSON_SCHEMA)),
  quote_bindings: Type.Optional(Type.Array(strictObject({
    key: Type.String({
      pattern: "^\\$[A-Za-z][A-Za-z0-9_-]*$",
      description: "摘录别名使用 $seal_requirement 等描述性名称。$s9、$e9、$a9、$r9、$t9 及其大写形式与系统来源句柄相似，属于保留名，会被拒绝。draft 的 span 字段使用精确 $alias，不能删除 $ 前缀。",
    }),
    evidence_id: Type.String({ minLength: 1 }),
    quote: Type.String({ minLength: 1 }),
    prefix: Type.Optional(Type.String()),
    suffix: Type.Optional(Type.String()),
  }), { maxItems: 100 })),
  collection: Type.Optional(Type.Union([
    Type.Literal("lots"),
    Type.Literal("items"),
    Type.Literal("sampling_rules"),
    Type.Literal("references"),
    Type.Literal("source_dispositions"),
    Type.Literal("residual_source_dispositions"),
  ])),
  remove_keys: Type.Optional(Type.Array(Type.String({ minLength: 1 }), {
    minItems: 1,
    description: "仅 upsert 可用，须指定 collection 且 draft 只含该集合；可原子删除旧项并提交完整子项。source_dispositions 用 read_target_selectors 目录返回的当前内容读取键；草稿记录本身不填 key。未保存的调用重试须保留待删除 key，已保存的删除不要重放；读取键过期先重新读取。",
  })),
});

const TargetSelectorToolSamplingComponentSchema = strictObject({
  ...SamplingComponentSchema.properties,
  role: Type.String({ description: SAMPLING_COMPONENT_ROLE_DESCRIPTION }),
});
const TargetSelectorToolDraftSchema = Type.Object({
  ...TARGET_SELECTOR_DRAFT_JSON_SCHEMA.properties,
  items: Type.Optional(Type.Array(TARGET_SELECTOR_AUTHOR_ITEM_JSON_SCHEMA, {
    description: "items 草稿集合，只能写在 draft.items，不能写在工具参数顶层。",
  })),
  sampling_rules: Type.Optional(Type.Array(strictObject({
    ...TARGET_SELECTOR_PLAN_JSON_SCHEMA.properties.sampling_rules.items.properties,
    // Transport-only tolerance for actionable role/ disposition diagnostics.
    // The persisted selector schema remains strict and the controller rejects
    // invalid roles before any source registration or draft write.
    components: Type.Array(TargetSelectorToolSamplingComponentSchema),
    branches: Type.Array(strictObject({
      ...TARGET_SELECTOR_PLAN_JSON_SCHEMA.properties.sampling_rules.items.properties.branches.items.properties,
      components: Type.Array(TargetSelectorToolSamplingComponentSchema),
    })),
  }), {
    description: "sampling_rules 草稿集合，只能写在 draft.sampling_rules，不能写在工具参数顶层。",
  })),
}, { additionalProperties: false, description: TARGET_SELECTOR_DRAFT_PLACEMENT_DESCRIPTION });
export const TARGET_SELECTOR_TOOL_DRAFT_PATCH_JSON_SCHEMA = strictObject({
  // Publish only writable fields. Misplacement diagnostics run in the SDK's
  // prepareArguments hook, not through misleading transport-only properties.
  operation: TARGET_SELECTOR_DRAFT_PATCH_JSON_SCHEMA.properties.operation,
  draft_fingerprint: TARGET_SELECTOR_DRAFT_PATCH_JSON_SCHEMA.properties.draft_fingerprint,
  reference_selections: TARGET_SELECTOR_DRAFT_PATCH_JSON_SCHEMA.properties.reference_selections,
  draft: Type.Optional(draftQuoteAliasSchema(TargetSelectorToolDraftSchema)),
  quote_bindings: TARGET_SELECTOR_DRAFT_PATCH_JSON_SCHEMA.properties.quote_bindings,
  collection: TARGET_SELECTOR_DRAFT_PATCH_JSON_SCHEMA.properties.collection,
  remove_keys: TARGET_SELECTOR_DRAFT_PATCH_JSON_SCHEMA.properties.remove_keys,
});

export type TargetSelectorDraftPatch = Static<typeof TARGET_SELECTOR_DRAFT_PATCH_JSON_SCHEMA>;

export interface TargetSelectorPlanMigrationResult {
  plan: TargetSelectorPlan;
  source_schema_version: string;
  migrated: boolean;
  issues: TargetSelectorIssue[];
}

function legacySamplingComponent(
  key: string,
  role: typeof SAMPLING_COMPONENT_ROLES[number],
  spanIds: unknown,
  reason: unknown,
): Record<string, unknown> {
  return {
    key,
    role,
    disposition: Array.isArray(spanIds) && spanIds.length > 0 ? "present" : "absent",
    span_ids: spanIds,
    reason,
  };
}

function migratedSamplingComponentIssues(
  plan: Record<string, unknown>,
  sourceSchemaVersion: string,
): TargetSelectorIssue[] {
  if (!Array.isArray(plan.sampling_rules)) return [];
  return plan.sampling_rules.flatMap((rawRule, ruleIndex) => {
    if (!rawRule || typeof rawRule !== "object" || Array.isArray(rawRule)) return [];
    const rule = rawRule as Record<string, unknown>;
    const sharedRoles = new Set(
      Array.isArray(rule.components)
        ? rule.components.flatMap((component) => (
            component && typeof component === "object" && !Array.isArray(component)
              && typeof (component as Record<string, unknown>).role === "string"
              ? [(component as Record<string, unknown>).role as string]
              : []
          ))
        : [],
    );
    if (!Array.isArray(rule.branches)) return [];
    return rule.branches.flatMap((rawBranch, branchIndex) => {
      if (!rawBranch || typeof rawBranch !== "object" || Array.isArray(rawBranch)) return [];
      const branch = rawBranch as Record<string, unknown>;
      const localRoles = new Set(
        Array.isArray(branch.components)
          ? branch.components.flatMap((component) => (
              component && typeof component === "object" && !Array.isArray(component)
                && typeof (component as Record<string, unknown>).role === "string"
                ? [(component as Record<string, unknown>).role as string]
                : []
            ))
          : [],
      );
      const missingRoles = SAMPLING_COMPONENT_ROLES.filter((role) => (
        !sharedRoles.has(role) && !localRoles.has(role)
      ));
      return missingRoles.length ? [{
        code: "selector_sampling_component_migration_required",
        path: `/sampling_rules/${ruleIndex}/branches/${branchIndex}/components`,
        message: "The legacy working draft cannot prove every typed sampling component role; stage explicit evidence-bound dispositions before commit",
        details: {
          source_schema_version: sourceSchemaVersion,
          rule_key: typeof rule.key === "string" ? rule.key : "",
          branch_key: typeof branch.key === "string" ? branch.key : "",
          missing_roles: missingRoles,
          allowed_locations: [
            `/sampling_rules/${ruleIndex}/components`,
            `/sampling_rules/${ruleIndex}/branches/${branchIndex}/components`,
          ],
          required_action: "stage_explicit_sampling_component_dispositions",
          component_contract: {
            disposition_present: "bind one or more registered span_ids",
            disposition_absent_or_not_applicable: "use an empty span_ids array",
          },
        },
      }] : [];
    });
  });
}

export function migrateTargetSelectorPlanForAuthoring(value: unknown): TargetSelectorPlanMigrationResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { plan: value as TargetSelectorPlan, source_schema_version: "", migrated: false, issues: [] };
  }
  const source = value as Record<string, unknown>;
  const sourceSchemaVersion = typeof source.schema_version === "string" ? source.schema_version : "";
  const isV2 = source.schema_version === LEGACY_TARGET_SELECTOR_PLAN_SCHEMA_VERSION_V2;
  const isV3 = source.schema_version === LEGACY_TARGET_SELECTOR_PLAN_SCHEMA_VERSION_V3;
  const isV4 = source.schema_version === LEGACY_TARGET_SELECTOR_PLAN_SCHEMA_VERSION_V4;
  if (!isV2 && !isV3 && !isV4) {
    return {
      plan: value as TargetSelectorPlan,
      source_schema_version: sourceSchemaVersion,
      migrated: false,
      issues: sourceSchemaVersion === TARGET_SELECTOR_PLAN_SCHEMA_VERSION
        ? migratedSamplingComponentIssues(source, sourceSchemaVersion)
        : [],
    };
  }
  const migrated = structuredClone(source) as Record<string, unknown>;
  migrated.schema_version = TARGET_SELECTOR_PLAN_SCHEMA_VERSION;
  if ((isV2 || isV3) && Array.isArray(migrated.items)) {
    migrated.items = migrated.items.map((rawItem) => {
      if (!rawItem || typeof rawItem !== "object" || Array.isArray(rawItem)) return rawItem;
      const item = rawItem as Record<string, unknown>;
      const sampling = item.sampling;
      if (sampling && typeof sampling === "object" && !Array.isArray(sampling)) {
        const legacySampling = sampling as Record<string, unknown>;
        const branchKey = typeof legacySampling.branch_key === "string" ? legacySampling.branch_key : "";
        legacySampling.branch_keys = branchKey ? [branchKey] : [];
        delete legacySampling.branch_key;
      }
      if (isV2 && item.table && typeof item.table === "object" && !Array.isArray(item.table)) {
        const table = item.table as Record<string, unknown>;
        const properties = table.properties;
        if (properties && typeof properties === "object" && !Array.isArray(properties)) {
          const legacy = properties as Record<string, unknown>;
          table.properties = {
            table_no_span_ids: legacy.table_no ?? [],
            table_title_span_ids: legacy.table_title ?? [],
            applicability_span_ids: legacy.applicability ?? [],
            row_path_span_ids: legacy.row_path ?? [],
            column_path_span_ids: legacy.column_path ?? [],
            unit_span_ids: legacy.unit ?? [],
            condition_span_ids: legacy.condition ?? [],
            allowed_value_span_ids: legacy.allowed_value ?? [],
            inspection_method_span_ids: legacy.inspection_method ?? [],
          };
        }
      }
      return item;
    });
  }
  if (Array.isArray(migrated.sampling_rules)) {
    migrated.sampling_rules = migrated.sampling_rules.map((rawRule, ruleIndex) => {
      if (!rawRule || typeof rawRule !== "object" || Array.isArray(rawRule)) return rawRule;
      const legacyRule = rawRule as Record<string, unknown>;
      const sharedConditions = Array.isArray(legacyRule.shared_conditions)
        ? legacyRule.shared_conditions
        : [];
      const components = sharedConditions.map((rawCondition, conditionIndex) => {
        if (!rawCondition || typeof rawCondition !== "object" || Array.isArray(rawCondition)) return rawCondition;
        const condition = rawCondition as Record<string, unknown>;
        return legacySamplingComponent(
          typeof condition.key === "string" ? condition.key : `legacy-shared-${conditionIndex}`,
          "branch_condition",
          condition.span_ids,
          condition.reason,
        );
      });
      const branches = Array.isArray(legacyRule.branches)
        ? legacyRule.branches.map((rawBranch, branchIndex) => {
            if (!rawBranch || typeof rawBranch !== "object" || Array.isArray(rawBranch)) return rawBranch;
            const branch = rawBranch as Record<string, unknown>;
            const branchKey = typeof branch.key === "string" ? branch.key : `legacy-branch-${branchIndex}`;
            return {
              key: branch.key,
              applies_to_category: branch.applies_to_category,
              components: [
                legacySamplingComponent(`${branchKey}:quantity`, "quantity", branch.minimum_span_ids, branch.reason),
                legacySamplingComponent(`${branchKey}:method`, "method", branch.script_span_ids, branch.reason),
                legacySamplingComponent(`${branchKey}:condition`, "branch_condition", branch.condition_span_ids, branch.reason),
              ],
              reason: branch.reason,
            };
          })
        : legacyRule.branches;
      return {
        key: legacyRule.key,
        complete_span_ids: legacyRule.complete_span_ids,
        components,
        branches,
        reason: legacyRule.reason,
      };
    });
  }
  const plan = migrated as TargetSelectorPlan;
  return {
    plan,
    source_schema_version: sourceSchemaVersion,
    migrated: true,
    issues: migratedSamplingComponentIssues(migrated, sourceSchemaVersion),
  };
}

export function migrateTargetSelectorPlan(value: unknown): TargetSelectorPlan {
  return migrateTargetSelectorPlanForAuthoring(value).plan;
}

export interface TargetSelectorIssue extends SourceSpanIssue {}

function schemaPointerValue(value: unknown, pointer: string): unknown {
  return pointer.replace(/^#/, "").split("/").slice(1).reduce<unknown>((current, key) => {
    if (!current || typeof current !== "object") return undefined;
    return (current as Record<string, unknown>)[key.replace(/~1/g, "/").replace(/~0/g, "~")];
  }, value);
}

function selectorSchemaExpectation(schema: Record<string, any> | undefined): Record<string, unknown> {
  if (!schema) return {};
  const expected = Object.fromEntries(Object.entries(schema).filter(([key]) =>
    ["type", "const", "enum", "pattern", "minLength", "maxLength", "minItems", "maxItems", "required", "additionalProperties"].includes(key)
  ));
  const alternatives = schema.anyOf;
  if (Array.isArray(alternatives)) {
    if (alternatives.every(part => Object.hasOwn(part, "const"))) expected.allowed_values = alternatives.map(part => part.const);
    else expected.alternatives = alternatives.map(selectorSchemaExpectation);
  }
  if (schema.properties) expected.allowed_fields = Object.keys(schema.properties);
  return expected;
}

/** The authoring tools and compiler report the same structural contract. */
export function targetSelectorSchemaIssues(
  value: unknown,
  schema: TSchema = TARGET_SELECTOR_PLAN_JSON_SCHEMA,
): TargetSelectorIssue[] {
  if (Check(schema, value)) return [];
  const errors = Errors(schema, value).map(error => {
    // TypeBox bounds diagnostics: a long enum can exhaust the budget before
    // its parent anyOf receipt. Collapse each literal failure to the full union
    // instead of dropping it and accidentally treating invalid input as valid.
    const unionPath = error.schemaPath.replace(/\/anyOf\/\d+$/, "");
    const union = schemaPointerValue(schema, unionPath) as Record<string, any> | undefined;
    return error.keyword === "const" && Array.isArray(union?.anyOf)
      && union.anyOf.every(part => Object.hasOwn(part, "const"))
      ? { ...error, schemaPath: unionPath, keyword: "anyOf" as const, params: {}, message: "must match one of the allowed values" }
      : error;
  });
  // A nullable union also reports "must be null" and anyOf. Prefer its precise
  // child diagnostics rather than suggesting deletion of the whole table.
  const leaves = errors.filter((error, index) => {
    if (errors.findIndex(other => other.keyword === error.keyword && other.instancePath === error.instancePath
      && other.schemaPath === error.schemaPath) !== index) return false;
    if ((error.keyword === "anyOf" || (error.keyword === "type" && error.params.type === "null"))
      && errors.some(other => other.instancePath.startsWith(`${error.instancePath}/`))) return false;
    return true;
  });
  return leaves.flatMap(error => {
    const node = schemaPointerValue(schema, error.schemaPath) as Record<string, any> | undefined;
    const keys = error.keyword === "required" ? error.params.requiredProperties
      : error.keyword === "additionalProperties" ? error.params.additionalProperties : undefined;
    return (Array.isArray(keys) ? keys : [undefined]).map(key => {
      const path = (key === undefined ? error.instancePath
        : `${error.instancePath}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`) || "/";
      const actual = schemaPointerValue(value, path === "/" ? "" : path);
      const encodedActual = JSON.stringify(actual);
      const expectedSchema = error.keyword === "required" ? node?.properties?.[key!] : node;
      return {
        code: "selector_schema", path, message: error.message,
        details: {
          actual: encodedActual && encodedActual.length > 400
            ? { preview: encodedActual.slice(0, 400), truncated: true } : actual === undefined ? null : actual,
          actual_present: actual !== undefined,
          keyword: error.keyword, constraint: error.params, expected: selectorSchemaExpectation(expectedSchema),
          writable_path: path,
          writable_collection: path.replace(/^\/draft(?=\/)/, "").split("/")[1] ?? "",
          required_action: typeof expectedSchema?.description === "string"
            ? expectedSchema.description
            : "按 expected 和 constraint 修正该作者端字段，保留其他正确记录及原操作意图；缺失字段须补齐，不能修改编译产物来消错。",
          next_tools: ["get_target_selector_contract", "read_target_selectors", "stage_target_selector_draft"],
          do_not_edit: "不可变原文、来源登记及编译产物；本次结构错误不会自动修正或删除模型选择。",
        },
      };
    });
  });
}

export function authoredReplaceFieldSelectorIssues(value: unknown): TargetSelectorIssue[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const references = (value as { references?: unknown }).references;
  if (!Array.isArray(references)) return [];
  return references.flatMap((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    if ((raw as { application_mode?: unknown }).application_mode !== "replace_field") return [];
    return [{
      code: "selector_reference_replace_field_forbidden",
      path: `/references/${index}/application_mode`,
      message: "replace_field（replace_entire_destination_field）已取消。新引用只能使用 reference_only 或 reference_placeholder；不得整字段替换本地内容。",
      details: {
        writable_collection: "references",
        actual: "replace_field",
        allowed_application_modes: ["reference_only", "reference_placeholder"],
        required_action: "set_application_mode_to_reference_only_and_keep_local_field",
        do_not: "replace_entire_destination_field",
      },
    }];
  });
}

export class TargetSelectorCompileError extends Error {
  constructor(public readonly issues: TargetSelectorIssue[]) {
    const preview = issues.slice(0, 3).map(issue => `${issue.code} at ${issue.path}: ${issue.message}`).join("; ");
    super(`Target selector compilation failed with ${issues.length} issue(s)${preview ? `: ${preview}` : ""}`);
  }
}

export function initialTargetSelectorPlan(manifest: EvidenceManifest): TargetSelectorPlan {
  return {
    schema_version: TARGET_SELECTOR_PLAN_SCHEMA_VERSION,
    job_id: manifest.job_id,
    target_id: manifest.target_id,
    lots: [],
    items: [],
    sampling_rules: [],
    references: [],
    source_dispositions: [],
    residual_source_dispositions: [],
  };
}

function exactKeys(
  value: unknown,
  expected: string[],
  path: string,
  issues: TargetSelectorIssue[],
): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    issues.push({ code: "selector_schema", path, message: "Expected an object" });
    return false;
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    issues.push({
      code: "selector_schema",
      path,
      message: "Selector object keys must match the contract exactly",
      details: { expected: wanted, actual },
    });
    return false;
  }
  return true;
}

function validateSamplingComponentShape(
  value: unknown,
  path: string,
  issues: TargetSelectorIssue[],
): void {
  if (!exactKeys(value, ["key", "role", "disposition", "span_ids", "reason"], path, issues)) return;
  const component = value as Record<string, unknown>;
  if (!SAMPLING_COMPONENT_ROLES.includes(component.role as typeof SAMPLING_COMPONENT_ROLES[number])) {
    issues.push({
      code: "selector_schema",
      path: `${path}/role`,
      message: "Sampling component role is not supported",
      details: { allowed_roles: SAMPLING_COMPONENT_ROLES },
    });
  }
  if (!["present", "absent", "not_applicable"].includes(component.disposition as string)) {
    issues.push({
      code: "selector_schema",
      path: `${path}/disposition`,
      message: "Sampling component disposition is not supported",
      details: { allowed_dispositions: ["present", "absent", "not_applicable"] },
    });
  }
  if (!Array.isArray(component.span_ids)) {
    issues.push({ code: "selector_schema", path: `${path}/span_ids`, message: "span_ids must be an array" });
    return;
  }
  if (component.disposition === "present" && component.span_ids.length === 0) {
    issues.push({
      code: "selector_sampling_component_binding_invalid",
      path: `${path}/span_ids`,
      message: "A present sampling component must bind at least one registered source span",
      details: { required_action: "add_registered_span_ids_or_change_disposition" },
    });
  }
  if (
    (component.disposition === "absent" || component.disposition === "not_applicable")
    && component.span_ids.length > 0
  ) {
    issues.push({
      code: "selector_sampling_component_binding_invalid",
      path: `${path}/span_ids`,
      message: "An absent or not_applicable sampling component must not bind source spans",
      details: { required_action: "clear_span_ids_or_change_disposition_to_present" },
    });
  }
}

function validateShape(value: unknown): TargetSelectorIssue[] {
  const replaceFieldIssues = authoredReplaceFieldSelectorIssues(value);
  if (replaceFieldIssues.length) return replaceFieldIssues;
  const issues = targetSelectorSchemaIssues(value);
  if (issues.length) return issues;
  if (!exactKeys(value, [
    "schema_version", "job_id", "target_id",
    "lots", "items", "sampling_rules",
    "references", "source_dispositions",
    ...(value && typeof value === "object" && "residual_source_dispositions" in value
      ? ["residual_source_dispositions"] : []),
    ...(value && typeof value === "object" && "rationale" in value ? ["rationale"] : []),
  ], "/", issues)) return issues;
  const plan = value as Record<string, unknown>;
  for (const field of ["lots", "items", "sampling_rules", "references", "source_dispositions"]) {
    if (!Array.isArray(plan[field])) issues.push({ code: "selector_schema", path: `/${field}`, message: `${field} must be an array` });
  }
  if (issues.length) return issues;
  (plan.lots as unknown[]).forEach((entry, index) => exactKeys(entry, ["key", "name", "scope_span_ids", "reason"], `/lots/${index}`, issues));
  (plan.items as unknown[]).forEach((entry, index) => {
    const path = `/items/${index}`;
    if (!exactKeys(entry, [
      "key", "lot_key", "name", "category", "criterion_span_ids", "continuation_span_ids",
      ...(entry && typeof entry === "object" && "name_path" in entry ? ["name_path"] : []),
      "fields", "table", "inspection_data_type", "inspection_data_type_reason",
      "inspection_data_type_span_ids", "sampling", "reason",
    ], path, issues)) return;
    const item = entry as Record<string, unknown>;
    if (exactKeys(item.fields, ["name", "requirement", "method", "quantity", "note"], `${path}/fields`, issues)) {
      for (const field of ["name", "requirement", "method", "quantity", "note"]) {
        exactKeys((item.fields as Record<string, unknown>)[field], ["composition", "span_ids", "separator", "reason"], `${path}/fields/${field}`, issues);
      }
    }
    exactKeys(item.sampling, [
      "status", "rule_key", "branch_keys", "quantity_span_ids", "script_span_ids",
      "condition_span_ids", "reason", "confidence",
    ], `${path}/sampling`, issues);
    if (item.table !== null && exactKeys(item.table, ["source_kind", "table_key", "properties", "reference_span_ids", "reason"], `${path}/table`, issues)) {
      const properties = (item.table as Record<string, unknown>).properties;
      exactKeys(properties, [
        "table_no_span_ids", "table_title_span_ids", "applicability_span_ids",
        "row_path_span_ids", "column_path_span_ids", "unit_span_ids",
        "condition_span_ids", "allowed_value_span_ids", "inspection_method_span_ids",
        ...(properties && typeof properties === "object" && "acceptance_branches" in properties
          ? ["acceptance_branches"] : []),
      ], `${path}/table/properties`, issues);
      const acceptanceBranches = properties && typeof properties === "object"
        ? (properties as Record<string, unknown>).acceptance_branches
        : undefined;
      if (acceptanceBranches !== undefined) {
        if (!Array.isArray(acceptanceBranches)) {
          issues.push({ code: "selector_schema", path: `${path}/table/properties/acceptance_branches`, message: "acceptance_branches must be an array" });
        } else {
          acceptanceBranches.forEach((branch, branchIndex) => exactKeys(branch, [
            "key", "condition_span_ids", "requirement_span_ids", "allowed_value_span_ids", "reason",
          ], `${path}/table/properties/acceptance_branches/${branchIndex}`, issues));
        }
      }
    }
  });
  (plan.sampling_rules as unknown[]).forEach((entry, index) => {
    const path = `/sampling_rules/${index}`;
    if (!exactKeys(entry, ["key", "complete_span_ids", "components", "branches", "reason"], path, issues)) return;
    const rule = entry as Record<string, unknown>;
    if (!Array.isArray(rule.components)) issues.push({ code: "selector_schema", path: `${path}/components`, message: "components must be an array" });
    else rule.components.forEach((component, componentIndex) => validateSamplingComponentShape(component, `${path}/components/${componentIndex}`, issues));
    if (!Array.isArray(rule.branches)) issues.push({ code: "selector_schema", path: `${path}/branches`, message: "branches must be an array" });
    else rule.branches.forEach((branch, branchIndex) => {
      const branchPath = `${path}/branches/${branchIndex}`;
      if (!exactKeys(branch, ["key", "applies_to_category", "components", "reason"], branchPath, issues)) return;
      const components = (branch as Record<string, unknown>).components;
      if (!Array.isArray(components)) issues.push({ code: "selector_schema", path: `${branchPath}/components`, message: "components must be an array" });
      else components.forEach((component, componentIndex) => validateSamplingComponentShape(component, `${branchPath}/components/${componentIndex}`, issues));
    });
  });
  (plan.references as unknown[]).forEach((entry, index) => {
    const path = `/references/${index}`;
    const referenceKeys = ["key", "anchor_span_ids", "target_span_ids", "action", "application_mode", "import_scope", "destinations", "reason"];
    if (!exactKeys(
      entry,
      entry && typeof entry === "object"
        ? [
            ...referenceKeys,
            ...("occurrence_id" in entry ? ["occurrence_id"] : []),
            ...("component_dispositions" in entry ? ["component_dispositions"] : []),
            ...("origin_binding" in entry ? ["origin_binding"] : []),
          ]
        : referenceKeys,
      path,
      issues,
    )) return;
    const destinations = (entry as Record<string, unknown>).destinations;
    if (!Array.isArray(destinations)) issues.push({ code: "selector_schema", path: `${path}/destinations`, message: "destinations must be an array" });
    else destinations.forEach((destination, destinationIndex) => exactKeys(destination, ["item_key", "target_field"], `${path}/destinations/${destinationIndex}`, issues));
    const originBinding = (entry as Record<string, unknown>).origin_binding;
    if (originBinding !== undefined) exactKeys(originBinding, ["item_key", "target_field"], `${path}/origin_binding`, issues);
    const componentDispositions = (entry as Record<string, unknown>).component_dispositions;
    if (componentDispositions !== undefined) {
      if (!Array.isArray(componentDispositions)) issues.push({ code: "selector_schema", path: `${path}/component_dispositions`, message: "component_dispositions must be an array" });
      else componentDispositions.forEach((disposition, dispositionIndex) => exactKeys(
        disposition,
        ["component_span_ids", "decision", "item_keys", "reason"],
        `${path}/component_dispositions/${dispositionIndex}`,
        issues,
      ));
    }
    const importScope = (entry as Record<string, unknown>).import_scope;
    if (!exactKeys(importScope, ["mode", "allowed_fields", "reason"], `${path}/import_scope`, issues)) return;
    if (!Array.isArray(importScope.allowed_fields) || importScope.allowed_fields.length === 0) {
      issues.push({ code: "selector_reference_import_scope_invalid", path: `${path}/import_scope/allowed_fields`, message: "import_scope.allowed_fields must explicitly name at least one supported imported field" });
    }
  });
  (plan.source_dispositions as unknown[]).forEach((entry, index) => exactKeys(entry, ["span_ids", "disposition", "reason"], `/source_dispositions/${index}`, issues));
  ((plan.residual_source_dispositions as unknown[] | undefined) ?? []).forEach((entry, index) =>
    exactKeys(entry, ["key", "disposition", "reason"], `/residual_source_dispositions/${index}`, issues));
  return issues;
}

function evidenceSources(manifest: EvidenceManifest): Map<string, ImmutableTextSource> {
  return new Map(manifest.evidence.map((record) => [record.evidence_id, {
    source_id: record.evidence_id,
    evidence_id: record.evidence_id,
    atom_id: record.evidence_id,
    text: record.text,
  }]));
}

function resolvedSpans(
  spanIds: readonly string[],
  registry: SourceSpanRegistry,
  sources: Map<string, ImmutableTextSource>,
  path: string,
  issues: TargetSelectorIssue[],
): Array<{ selector: EvidenceSpanDecision; text: string; evidence_id: string }> {
  if (!Array.isArray(spanIds)) {
    issues.push({ code: "selector_schema", path, message: "span_ids must be an array" });
    return [];
  }
  return spanIds.flatMap((spanId, index) => {
    const span = resolveSourceSpan(registry, spanId, sources, `${path}/${index}`, issues);
    return span ? [{
      selector: { evidence_id: span.evidence_id, start: span.start, end: span.end },
      text: span.text,
      evidence_id: span.evidence_id,
    }] : [];
  });
}

function containingHtmlCell(
  cells: HtmlTableCellSpan[],
  start: number,
  end: number,
): { cell: HtmlTableCellSpan; index: number } | undefined {
  const index = cells.findIndex((cell) => start >= cell.start && end <= cell.end);
  return index >= 0 ? { cell: cells[index]!, index } : undefined;
}

interface HtmlTableNavigationLine {
  table_index: number;
  start: number;
  end: number;
}

/**
 * Returns the immutable non-empty line immediately preceding each HTML table.
 * Callers must additionally prove that registered sibling spans partition the
 * line; adjacency alone is not enough to classify an arbitrary prose clause.
 */
function htmlTableNavigationLines(source: string): HtmlTableNavigationLine[] {
  const lines: HtmlTableNavigationLine[] = [];
  const tablePattern = /<table\b[^>]*>/giu;
  let tableIndex = 0;
  for (const match of source.matchAll(tablePattern)) {
    const tableStart = match.index ?? -1;
    if (tableStart < 0) continue;
    let end = tableStart;
    while (end > 0 && /\s/u.test(source[end - 1]!)) end -= 1;
    if (end === 0) {
      tableIndex += 1;
      continue;
    }
    const previousBreak = Math.max(source.lastIndexOf("\n", end - 1), source.lastIndexOf("\r", end - 1));
    let start = previousBreak + 1;
    while (start < end && /[\t ]/u.test(source[start]!)) start += 1;
    while (end > start && /[\t ]/u.test(source[end - 1]!)) end -= 1;
    if (end > start) lines.push({ table_index: tableIndex, start, end });
    tableIndex += 1;
  }
  return lines;
}

function tableCellAllowedBindings(
  registry: SourceSpanRegistry,
  evidenceId: string,
  source: ImmutableTextSource,
  cells: HtmlTableCellSpan[],
  cellIndices: number[],
): Array<{
  span_id: string;
  text: string;
  table_index: number;
  row_index: number;
  column_index: number;
}> {
  return [...new Set(cellIndices)].slice(0, 32).flatMap((cellIndex) => {
    const cell = cells[cellIndex];
    if (!cell) return [];
    return registry.spans
      .filter((candidate) =>
        candidate.evidence_id === evidenceId
        && candidate.start === cell.start
        && candidate.end === cell.end
      )
      .map((candidate) => ({
        span_id: candidate.span_id,
        text: source.text.slice(cell.start, cell.end),
        table_index: cell.table_index,
        row_index: cell.row_index,
        column_index: cell.column_index,
      }));
  });
}

function selectorSpans(
  spanIds: readonly string[],
  registry: SourceSpanRegistry,
  sources: Map<string, ImmutableTextSource>,
  path: string,
  issues: TargetSelectorIssue[],
): EvidenceSpanDecision[] {
  return resolvedSpans(spanIds, registry, sources, path, issues).map((span) => span.selector);
}

function safeJoinTextValues(values: readonly string[], separator = ""): string {
  if (values.length === 0) return "";
  if (values.length === 1) return values[0]!;
  let result = values[0]!;
  for (let i = 1; i < values.length; i++) {
    const prev = result;
    const next = values[i]!;
    let currentSep = separator;
    if (!currentSep && /[\da-zA-Z.]$/u.test(prev) && /^[\da-zA-Z.]/u.test(next)) {
      currentSep = " ";
    }
    result += currentSep + next;
  }
  return result;
}

function selectorText(
  spanIds: readonly string[],
  registry: SourceSpanRegistry,
  sources: Map<string, ImmutableTextSource>,
  path: string,
  issues: TargetSelectorIssue[],
  separator = "",
): string {
  const seen = new Set<string>();
  const displayValues: string[] = [];
  for (const span of resolvedSpans(spanIds, registry, sources, path, issues)) {
    const value = span.text.trim();
    const key = value.replace(/\s+/g, " ");
    if (!value || seen.has(key)) continue;
    seen.add(key);
    displayValues.push(value);
  }
  return safeJoinTextValues(displayValues, separator);
}

function normalizedLogicalTableTitle(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/^\s*续?表\s*\d+(?:\s*[.．。·\-－—]\s*\d+)*(?:\s*号)?/u, "")
    .replace(/[\s,，.。;；:：!！?？、·・'"“”‘’()（）\[\]【】《》〈〉{}]/gu, "");
}

function selectorTableFragmentIds(
  owners: readonly TargetSelectorPlan["items"][number][],
  registry: SourceSpanRegistry,
  manifest: EvidenceManifest,
  eligibleTableEvidenceIds?: ReadonlySet<string>,
): string[] {
  const evidenceIds = new Set(owners.flatMap((item) => {
    if (!item.table) return [];
    const spanIds = unique([
      ...(item.table.source_kind === "reference" ? [] : item.criterion_span_ids),
      ...(item.table.source_kind === "reference" ? [] : item.continuation_span_ids),
      ...Object.entries(item.table.properties)
        .filter(([role]) => item.table!.source_kind !== "reference"
          || !["applicability_span_ids", "condition_span_ids"].includes(role))
        .map(([, value]) => value)
        .flat(3)
        .filter((value): value is string => typeof value === "string"),
    ]);
    return spanIds.flatMap((spanId) => {
      const evidenceId = registry.spans.find((span) => span.span_id === spanId)?.evidence_id;
      return evidenceId && (!eligibleTableEvidenceIds || eligibleTableEvidenceIds.has(evidenceId))
        ? [evidenceId]
        : [];
    });
  }));
  const candidates = manifest.table_fragments.filter((fragment) => [
    ...fragment.title_candidate_evidence_ids,
    ...(fragment.continuation_caption_evidence_ids ?? []),
    ...fragment.header_evidence_ids,
    ...fragment.row_evidence_ids,
  ].some((evidenceId) => evidenceIds.has(evidenceId)));
  // Readers can register alternate row representations at one physical
  // location. A shared title alone must not import the unused representation
  // into the row partition. Preserve every fragment whose rows were selected,
  // and title-only fragments at other locations (including continuations).
  const hasSelectedRows = (fragment: EvidenceManifest["table_fragments"][number]): boolean =>
    fragment.row_evidence_ids.some(id => evidenceIds.has(id));
  return candidates.filter(fragment => hasSelectedRows(fragment)
    || !candidates.some(other => other !== fragment
      && hasSelectedRows(other)
      && Boolean(fragment.locator)
      && other.locator === fragment.locator
      && fragment.title_candidate_evidence_ids.some(id => evidenceIds.has(id)
        && other.title_candidate_evidence_ids.includes(id))))
    .map(fragment => fragment.fragment_id);
}

function formalTitleCandidates(
  fragmentIds: readonly string[],
  registry: SourceSpanRegistry,
  manifest: EvidenceManifest,
): Array<{ evidence_id: string; text: string; span_id: string }> {
  const fragmentsById = new Map(manifest.table_fragments.map((fragment) => [fragment.fragment_id, fragment]));
  const evidenceById = new Map(manifest.evidence.map((record) => [record.evidence_id, record]));
  return unique(fragmentIds.flatMap((fragmentId) =>
    fragmentsById.get(fragmentId)?.title_candidate_evidence_ids ?? []
  )).flatMap((evidenceId) => {
    const evidence = evidenceById.get(evidenceId);
    if (
      !evidence
      || evidence.role !== "formal_table_title"
      || /^\s*续表/u.test(evidence.text)
      || /^\s*表@line(?::|-)/u.test(evidence.text)
    ) return [];
    const complete = registry.spans.filter((span) =>
      span.evidence_id === evidenceId
      && span.start === 0
      && span.end === evidence.text.length
    );
    return complete.length === 1
      ? [{ evidence_id: evidenceId, text: evidence.text, span_id: complete[0]!.span_id }]
      : [];
  });
}

function tableStructureForTitle(
  tableKey: string,
  fragmentIds: readonly string[],
  tableStructure?: TableStructurePlan,
): TableStructurePlan["tables"][number] | undefined {
  const exact = tableStructure?.tables.find((table) => table.table_key === tableKey);
  if (exact) return exact;
  // Imported field provenance can overlap several tables. It does not change
  // the authored table identity or permit choosing an arbitrary structure.
  const overlapping = tableStructure?.tables.filter((table) =>
    table.fragment_ids.some((fragmentId) => fragmentIds.includes(fragmentId))
  ) ?? [];
  return overlapping.length === 1
    && fragmentIds.every((fragmentId) => overlapping[0]!.fragment_ids.includes(fragmentId))
    ? overlapping[0] : undefined;
}

function tableTitleBindingIssues(
  selectors: TargetSelectorPlan,
  registry: SourceSpanRegistry,
  manifest: EvidenceManifest,
  tableStructure?: TableStructurePlan,
  eligibleTableEvidenceIds?: ReadonlySet<string>,
): TargetSelectorIssue[] {
  const spanById = new Map(registry.spans.map((span) => [span.span_id, span]));
  const evidenceById = new Map(manifest.evidence.map((record) => [record.evidence_id, record]));
  const issues: TargetSelectorIssue[] = [];
  for (const tableKey of unique(selectors.items.flatMap((item) => item.table ? [item.table.table_key] : []))) {
    const owners = selectors.items.flatMap((item, index) => item.table?.table_key === tableKey
      ? [{ item, index }]
      : []);
    const fragmentIds = selectorTableFragmentIds(
      owners.map(({ item }) => item),
      registry,
      manifest,
      eligibleTableEvidenceIds,
    );
    const candidates = formalTitleCandidates(fragmentIds, registry, manifest);
    if (fragmentIds.length === 0 && candidates.length === 0) continue;
    const structureDecision = tableStructureForTitle(tableKey, fragmentIds, tableStructure);
    // An exact confirmed structure identifies the row navigation. Referenced
    // limits/methods may come from other tables and must not be confined here.
    if (structureDecision?.table_key === tableKey && structureDecision.status === "confirmed") {
      const structureFragments = new Set(structureDecision.fragment_ids);
      for (const { item, index } of owners) {
        const offendingBindings = item.table!.properties.row_path_span_ids.flatMap((rowPath, rowIndex) =>
          rowPath.flatMap((spanId, spanIndex) => {
            const span = spanById.get(spanId);
            if (!span) return [];
            const rowFragments = manifest.table_fragments.filter((fragment) =>
              fragment.row_evidence_ids.includes(span.evidence_id)
            ).map((fragment) => fragment.fragment_id);
            if (!rowFragments.length || rowFragments.some((id) => structureFragments.has(id))) return [];
            return [{
              span_id: spanId, evidence_id: span.evidence_id, fragment_ids: rowFragments,
              path: `/items/${index}/table/properties/row_path_span_ids/${rowIndex}/${spanIndex}`,
            }];
          })
        );
        if (!offendingBindings.length) continue;
        const rowPath = `/items/${index}/table/properties/row_path_span_ids`;
        issues.push({
          code: "selector_table_navigation_outside_structure",
          path: rowPath,
          message: "当前 table_key 已确认的物理表与 row_path_span_ids 的数据行归属不一致；请核对行导航或表身份。",
          details: {
            actual: {
              item_key: item.key, table_key: tableKey,
              structure_fragment_ids: structureDecision.fragment_ids,
              offending_bindings: offendingBindings,
            },
            affected_item_key: item.key,
            writable_collection: "items",
            writable_paths: [rowPath, `/items/${index}/table/table_key`,
              `/items/${index}/table/properties/table_title_span_ids`,
              `/items/${index}/table/properties/table_no_span_ids`],
            candidate_read_tools: ["read_target_selectors", "read_saved_table_structure", "read_table_summary"],
            next_tool: "read_target_selectors",
            next_tool_arguments: { collection: "items", key: item.key },
            tool_argument_hints: {
              read_saved_table_structure: { table_key: tableKey },
              read_table_summary: { table_key: tableKey },
            },
            save_tool: "stage_target_selector_draft",
            allowed_actions: ["correct_row_navigation", "correct_table_identity"],
            how_to_pass: "先读取当前完整 item，再按 table_key 读取已确认结构和表摘要，核对 actual.offending_bindings。由模型依据原文选择：表身份正确时，只把误选的行导航换成本表实际适用的数据行；行导航正确而表身份选错时，改为该数据行实际归属的已登记 table_key，并使表号、题注一致。用 stage_target_selector_draft 以 upsert 保存完整 item，再重试原校验。跨表引用的允许值、方法和条件可保留其真实来源，本条不要求把它们改成本表，也不要求拆分业务项。",
            do_not_edit: "不可变原文、编译产物、已经正确的字段或表结构；不得把无关物理表并入正确结构来消错。",
            required_action: "align_row_navigation_with_the_confirmed_table_identity",
          },
        });
      }
    }
    const candidateSpanIds = new Set(candidates.map((candidate) => candidate.span_id));
    const authored = owners.flatMap(({ item, index }) =>
      (item.table?.properties.table_title_span_ids ?? []).map((spanId, spanIndex) => ({
        item_key: item.key,
        item_name: item.name,
        path: `/items/${index}/table/properties/table_title_span_ids/${spanIndex}`,
        collection_path: `/items/${index}/table/properties/table_title_span_ids`,
        span_id: spanId,
      }))
    );
    const offending = authored.flatMap((binding) => {
      if (candidateSpanIds.has(binding.span_id)) return [];
      const span = spanById.get(binding.span_id);
      const evidence = span ? evidenceById.get(span.evidence_id) : undefined;
      return [{
        ...binding,
        evidence_id: span?.evidence_id ?? "",
        evidence_role: evidence?.role ?? "unknown",
        text: span && evidence ? evidence.text.slice(span.start, span.end) : "",
      }];
    });
    const affectedPaths = unique(owners.map(({ index }) =>
      `/items/${index}/table/properties/table_title_span_ids`
    ));
    if (offending.length > 0) {
      // A shared logical table is context, not the set of records needing repair.
      // Previously repaired owners must disappear from the next repair receipt.
      const offendingPaths = unique(offending.map(binding => binding.collection_path));
      issues.push({
        code: "selector_table_title_role_invalid",
        path: offending[0]!.collection_path,
        message: "table_title_span_ids 只接受该逻辑表已登记的正式题注；表头、数据行、续表标记和行号占位符不能充当表名。",
        details: {
          table_key: tableKey,
          fragment_ids: fragmentIds,
          offending_bindings: offending,
          formal_title_candidates: candidates,
          affected_item_keys: unique(offending.map(binding => binding.item_key)),
          affected_paths: offendingPaths,
          actual: { table_key: tableKey, offending_bindings: offending },
          writable_collection: "items",
          writable_paths: offendingPaths,
          next_tool: "read_target_selectors",
          next_tool_arguments: { collection: "items", key: offending[0]!.item_key },
          save_tool: "stage_target_selector_draft",
          how_to_pass: "先用 read_target_selectors 按 affected_item_keys 读取完整 items，核对 offending_bindings 和 formal_title_candidates。只修改点名项的 table.properties.table_title_span_ids；引用窄表题注须与本项实际绑定的数据行属于同一已登记表。用 stage_target_selector_draft 以 operation=upsert、draft.items 保存完整记录，保留其他正确字段，再重试原校验。不得把表头、续表标记或无关题注作为表名。",
          batch_repair: {
            operation: "clear_invalid_item_table_titles_and_rely_on_logical_table_inheritance",
            writable_paths: offendingPaths,
            unique_candidate_is_automatic: new Set(candidates.map((candidate) => normalizedLogicalTableTitle(candidate.text))).size === 1,
          },
          required_action: "remove_all_offending_title_spans_in_one_patch; when one formal candidate exists the compiler inherits it for every item sharing table_key",
        },
      });
      continue;
    }
    const candidateTitleGroups = new Set(candidates.map((candidate) => normalizedLogicalTableTitle(candidate.text)));
    const selectedTitleGroups = new Set([
      ...authored.map((binding) => binding.span_id),
      ...(structureDecision?.formal_title_span_ids ?? []),
    ].flatMap((spanId) => {
      const candidate = candidates.find((entry) => entry.span_id === spanId);
      return candidate ? [normalizedLogicalTableTitle(candidate.text)] : [];
    }));
    if (candidateTitleGroups.size > 1 && selectedTitleGroups.size !== 1) {
      const representative = owners[0];
      issues.push({
        code: "selector_table_title_selection_required",
        path: representative
          ? `/items/${representative.index}/table/properties/table_title_span_ids`
          : "/items",
        message: "该逻辑表的 item 选择与已保存表结构合计须指向一个正式题注；先核对回条中的两边实际选值，再修正有误的一边。共享 table_key 的 item 自动继承。",
        details: {
          table_key: tableKey,
          fragment_ids: fragmentIds,
          formal_title_candidates: candidates,
          authored_title_bindings: authored,
          selected_title_group_count: selectedTitleGroups.size,
          selected_structure: structureDecision ? {
            table_key: structureDecision.table_key,
            formal_title_span_ids: structureDecision.formal_title_span_ids,
            fragment_ids: structureDecision.fragment_ids,
            match_basis: structureDecision.table_key === tableKey ? "exact_table_key" : "unique_fragment_overlap",
          } : null,
          affected_item_keys: owners.map(({ item }) => item.key),
          affected_paths: affectedPaths,
          writable_collection: "items",
          writable_paths: affectedPaths,
          next_tool: "read_target_selectors",
          save_tool: "stage_target_selector_draft",
          required_action: "make_item_title_bindings_and_the_selected_structure_agree_on_exactly_one_formal_title; if_structure_is_correct_clear_conflicting_item_titles_and_inherit_it; otherwise_repair_the_structure_from_source_then_align_item_titles",
          how_to_pass: "先按 affected_item_keys 用 read_target_selectors 读取完整 items。保留未点名字段，只修改 table.properties.table_title_span_ids，以 operation=upsert、draft.items 保存完整记录。结构已选对时可清空 item 表题并继承；没有结构选择时，在一个代表 item 选一个正式题注，其余同表 item 留空。",
          structure_repair: {
            next_tool: "read_saved_table_structure",
            evidence_read_tool: "read_table_summary",
            save_tool: "stage_table_structure",
            table_key: structureDecision?.table_key ?? tableKey,
            writable_path: "/table/formal_title_span_ids",
            instruction: "仅当原文证明已保存结构题注有误时，读取完整 table 决定，核对正式候选后修改 formal_title_span_ids，以 {table:完整决定} 保存；保留其余正确分组、行角色、source_version 与字段。没有唯一结构归属时，不要为消除本错误改写任意重叠表。",
          },
          preserve_instruction: "保留跨表字段来源、其他正确 item 和表结构；不要改写编译产物。上述 writable_paths 是诊断位置，不是保存工具的参数。",
        },
      });
    }
  }
  return issues;
}

function logicalTableTitleSpanIds(
  authoredSpanIds: readonly string[],
  fragmentIds: readonly string[],
  registry: SourceSpanRegistry,
  manifest: EvidenceManifest,
  sources: Map<string, ImmutableTextSource>,
  path: string,
  issues: TargetSelectorIssue[],
): string[] {
  const authoredIds = unique([...authoredSpanIds]);
  if (fragmentIds.length === 0) return authoredIds;
  const candidates = formalTitleCandidates(fragmentIds, registry, manifest);
  if (candidates.length === 0) return authoredIds;
  const candidateBySpanId = new Map(candidates.map((candidate) => [candidate.span_id, candidate]));
  const authoredCandidates = authoredIds.flatMap((spanId) => {
    const candidate = candidateBySpanId.get(spanId);
    return candidate ? [candidate] : [];
  });
  const authoredGroups = new Set(authoredCandidates.map((candidate) => normalizedLogicalTableTitle(candidate.text)));
  if (authoredIds.length > 0 && authoredCandidates.length === authoredIds.length && authoredGroups.size === 1) {
    return [authoredCandidates[0]!.span_id];
  }
  const candidateGroups = new Map<string, typeof candidates>();
  for (const candidate of candidates) {
    const key = normalizedLogicalTableTitle(candidate.text);
    candidateGroups.set(key, [...(candidateGroups.get(key) ?? []), candidate]);
  }
  if (candidateGroups.size === 1) return [[...candidateGroups.values()][0]![0]!.span_id];
  if (authoredIds.length === 0) return [];
  const authoredTitle = selectorText(authoredIds, registry, sources, path, issues);
  const authoredKey = normalizedLogicalTableTitle(authoredTitle);
  if (!authoredKey) return authoredIds;
  const matches = candidates
    .filter((candidate) => normalizedLogicalTableTitle(candidate.text) === authoredKey)
    .map((candidate) => candidate.span_id);
  return matches.length === 1 ? matches : authoredIds;
}

function normalizedBusinessTableId(value: string): string {
  return value.normalize("NFKC").replace(/^\s*表\s*/u, "").trim();
}

/** Proves each resolved data row has an authored business leaf. The opaque
 * selector table_key is only a grouping key and cannot establish coverage. */
function referencedTableItemCoverage(
  selectors: TargetSelectorPlan,
  occurrence: TableReferenceOccurrence,
  registry: SourceSpanRegistry,
  manifest: EvidenceManifest,
  tableStructurePlan?: TableStructurePlan,
): { data_row_evidence_ids: string[]; uncovered_data_row_evidence_ids: string[] } {
  const targetTableId = normalizedBusinessTableId(occurrence.target_table_id);
  if (!targetTableId || occurrence.target_evidence_ids.length === 0) {
    return { data_row_evidence_ids: [], uncovered_data_row_evidence_ids: [] };
  }
  const targetEvidenceIds = new Set(occurrence.target_evidence_ids);
  const spanById = new Map(registry.spans.map((span) => [span.span_id, span]));
  const evidenceById = new Map(manifest.evidence.map((record) => [record.evidence_id, record]));
  const fragmentById = new Map(manifest.table_fragments.map((fragment) => [fragment.fragment_id, fragment]));
  const formalRowEvidenceIds = new Set(manifest.table_fragments
    .filter((fragment) => normalizedBusinessTableId(fragment.provisional_table_id) === targetTableId)
    .flatMap((fragment) => fragment.formal_row_evidence_ids));
  // Parser row kinds are navigation hints. A confirmed, source-bound structure
  // decision can correct them without inventing a business item for a header.
  const rowRoles = confirmedTableRowRoles(tableStructurePlan, manifest.table_fragments.map(fragment => fragment.fragment_id), manifest, registry);
  const confirmedDataRows = new Set(rowRoles.filter(row => row.role === "data").map(row => row.evidence_id));
  const confirmedStructuralRows = new Set(rowRoles.filter(row => row.role !== "data").map(row => row.evidence_id));
  const fragmentIdsByEvidenceId = new Map<string, Set<string>>();
  for (const fragment of manifest.table_fragments) {
    for (const evidenceId of [
      ...fragment.title_candidate_evidence_ids,
      ...fragment.header_evidence_ids,
      ...fragment.row_evidence_ids,
      ...fragment.formal_row_evidence_ids,
    ]) {
      const fragmentIds = fragmentIdsByEvidenceId.get(evidenceId) ?? new Set<string>();
      fragmentIds.add(fragment.fragment_id);
      fragmentIdsByEvidenceId.set(evidenceId, fragmentIds);
    }
  }
  const evidenceBelongsToTargetTable = (evidenceId: string): boolean => {
    if (!targetEvidenceIds.has(evidenceId)) return false;
    const evidence = evidenceById.get(evidenceId);
    if (evidence?.table_id && normalizedBusinessTableId(evidence.table_id) === targetTableId) return true;
    const fragmentIds = new Set(fragmentIdsByEvidenceId.get(evidenceId) ?? []);
    if (evidence?.table_fragment_id) fragmentIds.add(evidence.table_fragment_id);
    return [...fragmentIds].some((fragmentId) => {
      const fragment = fragmentById.get(fragmentId);
      return Boolean(fragment
        && normalizedBusinessTableId(fragment.provisional_table_id) === targetTableId);
    });
  };
  const confirmedRoles = new Map(confirmedTableRowRoles(tableStructurePlan,
    manifest.table_fragments.map(fragment => fragment.fragment_id), manifest, registry)
    .map(row => [row.evidence_id, row.role]));
  // Retain the legacy exact-header fallback when no confirmed decision exists.
  const normalizeRowText = (text: string): string => text.replace(/\s+/g, "");
  const headerTexts = new Set(manifest.table_fragments
    .filter((fragment) => normalizedBusinessTableId(fragment.provisional_table_id) === targetTableId)
    .flatMap((fragment) => fragment.header_evidence_ids)
    .map((evidenceId) => normalizeRowText(evidenceById.get(evidenceId)?.text ?? ""))
    .filter((text) => text.length > 0));
  const dataRowEvidenceIds = unique(occurrence.target_evidence_ids.filter((evidenceId) => {
    const evidence = evidenceById.get(evidenceId);
    const confirmedRole = confirmedRoles.get(evidenceId);
    return evidence?.kind === "table_row"
      && (confirmedRole ? confirmedRole === "data"
        : (evidence.table_row_kind === "data" || formalRowEvidenceIds.has(evidenceId)))
      && evidenceBelongsToTargetTable(evidenceId)
      && (confirmedRole === "data" || !headerTexts.has(normalizeRowText(evidence?.text ?? "")));
  }));
  const coveredEvidenceIds = new Set(selectors.items.flatMap((item) => {
    if (!item.table) return [];
    const properties = item.table.properties;
    const businessSpanIds = unique([
      ...item.criterion_span_ids,
      ...item.continuation_span_ids,
      ...properties.row_path_span_ids.flat(),
      ...properties.column_path_span_ids.flat(),
      ...properties.unit_span_ids,
      ...properties.condition_span_ids,
      ...properties.allowed_value_span_ids,
      ...properties.inspection_method_span_ids,
    ]);
    return businessSpanIds.flatMap((spanId) => {
      const evidenceId = spanById.get(spanId)?.evidence_id;
      return evidenceId && evidenceBelongsToTargetTable(evidenceId) ? [evidenceId] : [];
    });
  }));
  return {
    data_row_evidence_ids: dataRowEvidenceIds,
    uncovered_data_row_evidence_ids: dataRowEvidenceIds.filter((evidenceId) => !coveredEvidenceIds.has(evidenceId)),
  };
}

export function selectorItemsMaterializeReferencedTable(
  selectors: TargetSelectorPlan,
  occurrence: TableReferenceOccurrence,
  registry: SourceSpanRegistry,
  manifest: EvidenceManifest,
  tableStructurePlan?: TableStructurePlan,
): boolean {
  const coverage = referencedTableItemCoverage(selectors, occurrence, registry, manifest, tableStructurePlan);
  return coverage.data_row_evidence_ids.length > 0
    && coverage.uncovered_data_row_evidence_ids.length === 0;
}

function withAutomaticReferencePlaceholderTargets(
  selectors: TargetSelectorPlan,
  registry: SourceSpanRegistry,
  manifest: EvidenceManifest,
): TargetSelectorPlan {
  const normalized = structuredClone(selectors);
  const evidenceById = new Map(manifest.evidence.map((record) => [record.evidence_id, record]));
  const spansByEvidenceId = new Map<string, SourceSpanRegistry["spans"]>();
  for (const span of registry.spans) {
    const spans = spansByEvidenceId.get(span.evidence_id) ?? [];
    spans.push(span);
    spansByEvidenceId.set(span.evidence_id, spans);
  }
  for (const reference of normalized.references) {
    if (reference.application_mode !== "reference_placeholder" || !reference.occurrence_id) continue;
    const occurrence = manifest.reference_occurrences.find((entry) =>
      entry.occurrence_id === reference.occurrence_id
    );
    if (occurrence?.status !== "resolved" || occurrence.reference_kind !== "table") continue;
    const rowEvidenceIds = unique(occurrence.target_evidence_ids.filter((evidenceId) => {
      const record = evidenceById.get(evidenceId);
      return record?.kind === "table_row"
        && record.table_row_kind === "data"
        && (record.cells?.length ?? 0) > 0;
    }));
    const rowSpanIds = rowEvidenceIds.flatMap((evidenceId) => {
      const record = evidenceById.get(evidenceId);
      const candidates = [...(spansByEvidenceId.get(evidenceId) ?? [])].sort((left, right) => {
        const leftComplete = left.start === 0 && left.end === (record?.text.length ?? -1);
        const rightComplete = right.start === 0 && right.end === (record?.text.length ?? -1);
        if (leftComplete !== rightComplete) return leftComplete ? -1 : 1;
        return (right.end - right.start) - (left.end - left.start) || left.start - right.start;
      });
      return candidates[0] ? [candidates[0].span_id] : [];
    });
    if (rowEvidenceIds.length > 0 && rowSpanIds.length === rowEvidenceIds.length) {
      reference.target_span_ids = unique(rowSpanIds);
    }
  }
  return normalized;
}

function compactNavigationText(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= 120) return normalized;
  return `${normalized.slice(0, 72)} … ${normalized.slice(-24)} [${sha256Text(normalized).slice(0, 12)}]`;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function proseDuplicatePayloadIssues(selectors: TargetSelectorPlan): TargetSelectorIssue[] {
  const withoutExplanations = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(withoutExplanations);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => key !== "reason" && !key.endsWith("_reason"))
      .map(([key, child]) => [key, withoutExplanations(child)]));
  };
  // Compare only authored prose payloads. Table projections and reference
  // routes can distinguish otherwise equal item records and stay out of this
  // narrow check. Different source IDs, lots, fields or sampling remain distinct.
  const routedKeys = new Set(selectors.references.flatMap(reference => reference.destinations.map(destination => destination.item_key)));
  const groups = new Map<string, Array<{ key: string; index: number }>>();
  selectors.items.forEach((item, index) => {
    if (item.table || routedKeys.has(item.key)) return;
    const { key, ...payload } = item;
    const signature = canonicalize(withoutExplanations(payload));
    groups.set(signature, [...(groups.get(signature) ?? []), { key, index }]);
  });
  return [...groups.values()].filter(group => group.length > 1).map(group => ({
    code: "selector_duplicate_item_payload", path: `/items/${group[0]!.index}`,
    message: "多条正文 item 除 key 和说明文字外，作者业务记录及来源完全相同；不同 key 不能创造独立验收判断。",
    details: {
      actual: { item_keys: group.map(item => item.key), duplicate_count: group.length,
        author_paths: group.map(item => `/items/${item.index}`),
        comparison: "exact_authored_payload_excluding_root_key_and_explanations" },
      expected: { distinct_source_backed_item_payloads: true, different_key_or_reason_is_not_a_business_difference: true },
      writable_collection: "items", writable_paths: group.map(item => `/items/${item.index}`),
      writable_argument_paths: ["/collection", "/operation", "/remove_keys", "/draft/items"],
      candidate_read_tool: "read_target_selectors", next_tool: "read_target_selectors",
      candidate_read_tools: ["read_target_selectors", "open_evidence", "locate_evidence_span", "batch_locate_evidence_spans"],
      next_tool_arguments: { collection: "items", key: group[0]!.key },
      read_arguments: group.map(item => ({ collection: "items", key: item.key })),
      save_tool: "stage_target_selector_draft",
      required_action: "preserve_each_real_judgment_once_or_bind_its_actual_source_backed_distinction",
      how_to_pass: "按 read_arguments 读取全部重复 item，核对原文及真实对象、条件、字段、分类和抽样。若确为同一判断，作者选择保留完整有效记录，用 stage_target_selector_draft 的 collection=items、operation=upsert、remove_keys 删除真实重复 key；若存在原文支持的不同判断，则把实际区别绑定到对应业务字段和精确来源，再保存完整 item。保留其他正确记录及所有真实条件、判据和来源，不仅改 key、name 或 reason 来消错。删改已保存回条成功后不要重放删除，按原阶段 advance/commit 重验。",
      do_not_edit: "不可变原文、既有来源登记、编译产物或无关正确记录；新精确片段须通过定位工具登记。harness 不自动选择保留项、不按相同名称或显示文本去重。",
    },
  }));
}

export interface TableFragmentCandidate {
  fragmentIds: string[];
  [key: string]: unknown;
}

export function groupTableCandidatesByFragment(
  candidates: readonly TableFragmentCandidate[],
): TableFragmentCandidate[][] {
  const groups: TableFragmentCandidate[][] = [];
  for (const candidate of candidates) {
    const matchingGroups = groups.filter((group) => candidate.fragmentIds.some((fragmentId) =>
      group.some((member) => member.fragmentIds.includes(fragmentId))
    ));
    if (!matchingGroups.length) {
      groups.push([candidate]);
      continue;
    }
    const destination = matchingGroups[0]!;
    destination.push(candidate);
    for (const extra of matchingGroups.slice(1)) {
      destination.push(...extra);
      groups.splice(groups.indexOf(extra), 1);
    }
  }
  return groups;
}

// The harness only checks an unambiguous formatting property here: a concise
// item name must not end with Chinese sentence-terminating punctuation. Internal
// punctuation and whether wording forms a verdict sentence are semantic matters
// for the model, not keyword/length/number heuristics for the compiler.
const ACCEPTANCE_ITEM_NAME_SENTENCE_PUNCTUATION_RE = /[。；！？]$/u;

export type AcceptanceItemNameShapeSignal = "sentence_punctuation";

export function acceptanceItemNameShapeIssues(name: string): AcceptanceItemNameShapeSignal[] {
  const trimmed = name.trim();
  if (!trimmed) return [];
  const signals: AcceptanceItemNameShapeSignal[] = [];
  if (ACCEPTANCE_ITEM_NAME_SENTENCE_PUNCTUATION_RE.test(trimmed)) signals.push("sentence_punctuation");
  return signals;
}

function validateItemScalarSpanGranularity(
  selectors: TargetSelectorPlan,
  registry: SourceSpanRegistry,
  sources: Map<string, ImmutableTextSource>,
  issues: TargetSelectorIssue[],
): void {
  const registeredById = new Map(registry.spans.map((span) => [span.span_id, span]));
  const modelVisibleSpanCandidates = (spans: SourceSpanRegistry["spans"]): Array<Record<string, unknown>> => (
    spans.slice(0, 32).map((span) => ({
      span_id: span.span_id,
      evidence_id: span.evidence_id,
      start: span.start,
      end: span.end,
      exact_fragment: sources.get(span.evidence_id)?.text.slice(span.start, span.end) ?? "",
    }))
  );
  const sameInterval = (
    left: SourceSpanRegistry["spans"][number],
    right: SourceSpanRegistry["spans"][number],
  ): boolean => (
    left.evidence_id === right.evidence_id
    && left.start === right.start
    && left.end === right.end
  );
  const strictlyContains = (
    container: SourceSpanRegistry["spans"][number],
    member: SourceSpanRegistry["spans"][number],
  ): boolean => (
    container.evidence_id === member.evidence_id
    && member.start >= container.start
    && member.end <= container.end
    && (member.start > container.start || member.end < container.end)
  );
  const crossesIntervalBoundary = (
    left: SourceSpanRegistry["spans"][number],
    right: SourceSpanRegistry["spans"][number],
  ): boolean => (
    left.evidence_id === right.evidence_id
    && Math.min(left.end, right.end) > Math.max(left.start, right.start)
    && !sameInterval(left, right)
    && !strictlyContains(left, right)
    && !strictlyContains(right, left)
  );
  const itemBoundaryBindings = selectors.items.flatMap((item, itemIndex) => [
    ...item.criterion_span_ids.map((spanId, spanIndex) => ({
      item_index: itemIndex,
      item_key: item.key,
      role: "criterion" as const,
      path: `/items/${itemIndex}/criterion_span_ids/${spanIndex}`,
      span_id: spanId,
    })),
    ...item.continuation_span_ids.map((spanId, spanIndex) => ({
      item_index: itemIndex,
      item_key: item.key,
      role: "continuation" as const,
      path: `/items/${itemIndex}/continuation_span_ids/${spanIndex}`,
      span_id: spanId,
    })),
  ]).flatMap((binding) => {
    const span = registeredById.get(binding.span_id);
    return span ? [{ ...binding, span }] : [];
  });

  selectors.items.forEach((item, itemIndex) => {
    const itemRoleBindings = [
      ...item.criterion_span_ids.map((spanId, spanIndex) => ({
        role: "criterion" as const,
        path: `/items/${itemIndex}/criterion_span_ids/${spanIndex}`,
        span_id: spanId,
      })),
      ...item.continuation_span_ids.map((spanId, spanIndex) => ({
        role: "continuation" as const,
        path: `/items/${itemIndex}/continuation_span_ids/${spanIndex}`,
        span_id: spanId,
      })),
      ...(["name", "requirement", "method", "note"] as const).flatMap((field) => (
        item.fields[field].span_ids.map((spanId, spanIndex) => ({
          role: `field:${field}` as const,
          path: `/items/${itemIndex}/fields/${field}/span_ids/${spanIndex}`,
          span_id: spanId,
        }))
      )),
    ].flatMap((binding) => {
      const span = registeredById.get(binding.span_id);
      return span ? [{ ...binding, span }] : [];
    });
    const nameSourceProjection = selectorText(
      item.fields.name.span_ids,
      registry,
      sources,
      `/items/${itemIndex}/fields/name/span_ids`,
      issues,
      item.fields.name.separator,
    ).trim();
    const nameUsesExactSourceProjection = item.fields.name.composition === "verbatim"
      || (
        item.fields.name.composition === "semantic_summary"
        && item.name.trim() !== ""
        && item.name.trim() === nameSourceProjection
      );
    if (nameUsesExactSourceProjection) {
      const appliedRule = item.sampling.rule_key
        ? selectors.sampling_rules.find((rule) => rule.key === item.sampling.rule_key)
        : undefined;
      const appliedBranchKeys = new Set(item.sampling.branch_keys);
      const samplingRoleBindings = [
        ...(item.sampling.status === "explicit"
          ? [
              ...item.sampling.quantity_span_ids.map((spanId, spanIndex) => ({
                role: "sampling:quantity" as const,
                path: `/items/${itemIndex}/sampling/quantity_span_ids/${spanIndex}`,
                span_id: spanId,
              })),
              ...item.sampling.script_span_ids.map((spanId, spanIndex) => ({
                role: "sampling:script" as const,
                path: `/items/${itemIndex}/sampling/script_span_ids/${spanIndex}`,
                span_id: spanId,
              })),
              ...item.sampling.condition_span_ids.map((spanId, spanIndex) => ({
                role: "sampling:condition" as const,
                path: `/items/${itemIndex}/sampling/condition_span_ids/${spanIndex}`,
                span_id: spanId,
              })),
            ]
          : []),
        ...(appliedRule?.components.flatMap((component, componentIndex) => (
          component.disposition === "present"
            ? component.span_ids.map((spanId, spanIndex) => ({
                role: `sampling:${component.role}` as const,
                path: `/sampling_rules/${selectors.sampling_rules.indexOf(appliedRule)}/components/${componentIndex}/span_ids/${spanIndex}`,
                span_id: spanId,
              }))
            : []
        )) ?? []),
        ...(appliedRule?.branches.flatMap((branch, branchIndex) => (
          appliedBranchKeys.has(branch.key)
            ? branch.components.flatMap((component, componentIndex) => (
                component.disposition === "present"
                  ? component.span_ids.map((spanId, spanIndex) => ({
                      role: `sampling:${component.role}` as const,
                      path: `/sampling_rules/${selectors.sampling_rules.indexOf(appliedRule)}/branches/${branchIndex}/components/${componentIndex}/span_ids/${spanIndex}`,
                      span_id: spanId,
                    }))
                  : []
              ))
            : []
        )) ?? []),
      ].flatMap((binding) => {
        const span = registeredById.get(binding.span_id);
        return span ? [{ ...binding, span }] : [];
      });
      const heterogeneousNameBindings = [
        ...itemRoleBindings.filter((binding) => (
          binding.role === "field:method"
          || binding.role === "field:note"
        )).map((binding) => ({
          ...binding,
          role: binding.role.slice("field:".length),
        })),
        ...item.fields.quantity.span_ids.flatMap((spanId, spanIndex) => {
          const span = registeredById.get(spanId);
          return span ? [{
            role: "quantity" as const,
            path: `/items/${itemIndex}/fields/quantity/span_ids/${spanIndex}`,
            span_id: spanId,
            span,
          }] : [];
        }),
        ...samplingRoleBindings,
      ];
      item.fields.name.span_ids.forEach((spanId, spanIndex) => {
        const selected = registeredById.get(spanId);
        if (!selected) return;
        const crossedItemBindings = itemBoundaryBindings.filter((binding) => (
          binding.span.evidence_id === selected.evidence_id
          && binding.span.start >= selected.start
          && binding.span.end <= selected.end
        ));
        const crossedItemKeys = unique(crossedItemBindings.map((binding) => binding.item_key));
        const crossedBoundaryRanges = unique(crossedItemBindings.map((binding) => (
          `${binding.span.evidence_id}\0${binding.span.start}\0${binding.span.end}`
        )));
        const containedHeterogeneousRoles = heterogeneousNameBindings.filter((binding) => (
          sameInterval(selected, binding.span) || strictlyContains(selected, binding.span)
        ));
        const crossesItemBoundaries = crossedItemKeys.length > 1 && crossedBoundaryRanges.length > 1;
        if (!crossesItemBoundaries && containedHeterogeneousRoles.length === 0) return;
        issues.push({
          code: "selector_name_short_form_required",
          path: `/items/${itemIndex}/fields/name/span_ids/${spanIndex}`,
          message: "A verbatim inspection-point name span structurally includes source assigned to another item or to method, quantity, note, or sampling roles",
          details: {
            item_key: item.key,
            offending_binding: {
              span_id: selected.span_id,
              evidence_id: selected.evidence_id,
              start: selected.start,
              end: selected.end,
            },
            crossed_item_keys: crossedItemKeys,
            contained_roles: unique(containedHeterogeneousRoles.map((binding) => binding.role)),
            conflicting_bindings: [
              ...crossedItemBindings.map((binding) => ({
                role: binding.role,
                item_key: binding.item_key,
                path: binding.path,
                span_id: binding.span_id,
                start: binding.span.start,
                end: binding.span.end,
              })),
              ...containedHeterogeneousRoles.map((binding) => ({
                role: binding.role,
                item_key: item.key,
                path: binding.path,
                span_id: binding.span_id,
                start: binding.span.start,
                end: binding.span.end,
              })),
            ],
            required_action: "bind_an_exact_single_role_name_span_or_use_name_semantic_summary",
            replacement_constraints: {
              must_be_registered: true,
              must_preserve_exact_source_text_when_verbatim: true,
              must_not_cross_independent_item_boundaries: true,
              must_not_include_method_quantity_note_or_sampling_role_regions: true,
              name_requirement_equality_is_not_rejected_by_this_check: true,
              exact_table_row_or_column_name_is_allowed: true,
              no_text_length_target_id_clause_number_or_keyword_heuristic: true,
            },
            name_composition: item.fields.name.composition,
            output_matches_exact_source_projection: item.name.trim() === nameSourceProjection,
          },
        });
      });
    }
    const methodBindings = item.fields.method.span_ids.flatMap((spanId, spanIndex) => {
      const span = registeredById.get(spanId);
      return span ? [{
        path: `/items/${itemIndex}/fields/method/span_ids/${spanIndex}`,
        span_id: spanId,
        span,
      }] : [];
    });
    const quantityBindings = item.fields.quantity.span_ids.flatMap((spanId, spanIndex) => {
      const span = registeredById.get(spanId);
      return span ? [{
        path: `/items/${itemIndex}/fields/quantity/span_ids/${spanIndex}`,
        span_id: spanId,
        span,
      }] : [];
    });
    const requirementBindings = item.fields.requirement.span_ids.flatMap((spanId, spanIndex) => {
      const span = registeredById.get(spanId);
      return span ? [{
        role: "requirement" as const,
        path: `/items/${itemIndex}/fields/requirement/span_ids/${spanIndex}`,
        span_id: spanId,
        span,
      }] : [];
    });
    const noteBindings = item.fields.note.span_ids.flatMap((spanId, spanIndex) => {
      const span = registeredById.get(spanId);
      return span ? [{
        role: "note" as const,
        path: `/items/${itemIndex}/fields/note/span_ids/${spanIndex}`,
        span_id: spanId,
        span,
      }] : [];
    });
    const visibleRoleBindings = [
      ...methodBindings.map((binding) => ({ ...binding, role: "method" as const })),
      ...quantityBindings.map((binding) => ({ ...binding, role: "quantity" as const })),
    ];
    const overlappingRequirementBindings = requirementBindings.flatMap((requirementBinding) => (
      visibleRoleBindings.flatMap((otherBinding) => {
        if (
          requirementBinding.span.evidence_id !== otherBinding.span.evidence_id
          || sameInterval(requirementBinding.span, otherBinding.span)
          || Math.min(requirementBinding.span.end, otherBinding.span.end)
            <= Math.max(requirementBinding.span.start, otherBinding.span.start)
        ) return [];
        if (
          otherBinding.role === "quantity"
          && strictlyContains(requirementBinding.span, otherBinding.span)
        ) return [];
        return [{ requirement: requirementBinding, other: otherBinding }];
      })
    ));
    if (
      item.fields.requirement.composition === "verbatim"
      && overlappingRequirementBindings.length > 0
    ) {
      const conflictingSpans = unique(overlappingRequirementBindings.flatMap(({ requirement, other }) => (
        [requirement.span_id, other.span_id]
      ))).flatMap((spanId) => {
        const span = registeredById.get(spanId);
        return span ? [span] : [];
      });
      const registeredProperSubspans = registry.spans.filter((candidate) => (
        conflictingSpans.some((span) => strictlyContains(span, candidate))
      ));
      const affectedPaths = unique(overlappingRequirementBindings.flatMap(({ requirement, other }) => (
        [requirement.path, other.path]
      )));
      issues.push({
        code: "selector_display_field_span_role_overlap",
        path: `/items/${itemIndex}`,
        message: "逐字判据的来源区间与其他可见字段角色部分重叠，或包含了已经分配给检验方法的来源文字；精确的检查数量子区间可以保留在完整判据原句内。",
        details: {
          item_key: item.key,
          conflicting_role_pairs: unique(overlappingRequirementBindings.map(({ other }) => (
            `requirement\0${other.role}`
          ))).map((pair) => pair.split("\0")),
          affected_paths: affectedPaths,
          conflicting_bindings: conflictingSpans.map((span) => ({
            span_id: span.span_id,
            evidence_id: span.evidence_id,
            start: span.start,
            end: span.end,
          })),
          registered_subspan_candidates: registeredProperSubspans.slice(0, 64).map((candidate) => ({
            span_id: candidate.span_id,
            evidence_id: candidate.evidence_id,
            start: candidate.start,
            end: candidate.end,
          })),
          required_action: "locate_exact_requirement_method_and_quantity_spans_and_replace_overlapping_fields",
          writable_paths: affectedPaths,
          candidate_read_tool: "read_target_selectors",
          candidate_read_tools: ["read_target_selectors", "open_evidence", "locate_evidence_span"],
          next_tool: "read_target_selectors",
          next_tool_arguments: { collection: "items", key: item.key },
          next_tools: ["read_target_selectors", "open_evidence", "locate_evidence_span", "stage_target_selector_draft"],
          save_tool: "stage_target_selector_draft",
          how_to_pass: "先用 read_target_selectors 读取当前 item，再按 conflicting_bindings 的 evidence_id 用 open_evidence 核对原文；已有 registered_subspan_candidates 时逐一核对其真实区间，候选缺失或不足时才用 locate_evidence_span 登记模型从已打开原文中选择的精确子串。最后只替换 affected_paths 列出的字段绑定，用 stage_target_selector_draft 保存并重试验证；不得由 harness 指定角色答案或替代 span。",
          do_not_edit: "不可变原文、编译产物、未列入 affected_paths 的字段和已有 replacement_constraints。",
          replacement_constraints: {
            affected_paths_only: affectedPaths,
            must_be_registered: true,
            must_preserve_exact_source_text: true,
            nonidentical_visible_requirement_method_and_quantity_intervals_must_not_partially_overlap: true,
            complete_requirement_may_contain_exact_quantity_subspan: true,
            quantity_must_not_contain_requirement_method_or_note: true,
            one_indivisible_exact_interval_may_be_reused_across_visible_roles: true,
            criterion_and_requirement_sharing_is_not_rejected_by_this_check: true,
            note_and_sampling_condition_bindings_are_not_checked_by_this_rule: true,
            no_text_length_or_heading_heuristic: true,
          },
        },
      });
    }
    if (item.table === null) {
      const heterogeneousMethodBindings = [
        ...requirementBindings,
        ...quantityBindings.map((binding) => ({ ...binding, role: "quantity" as const })),
        ...noteBindings,
        ...(item.sampling.status === "explicit"
          ? item.sampling.quantity_span_ids.flatMap((spanId, spanIndex) => {
              const span = registeredById.get(spanId);
              return span ? [{
                role: "sampling:quantity" as const,
                path: `/items/${itemIndex}/sampling/quantity_span_ids/${spanIndex}`,
                span_id: spanId,
                span,
              }] : [];
            })
          : []),
      ];
      const methodRoleConflations = methodBindings.flatMap((methodBinding) => {
        const equal = heterogeneousMethodBindings.filter((binding) => (
          sameInterval(methodBinding.span, binding.span)
        ));
        const contained = heterogeneousMethodBindings.filter((binding) => (
          strictlyContains(methodBinding.span, binding.span)
        ));
        return contained.length > 0 ? [{ methodBinding, equal, contained }] : [];
      });
      if (methodRoleConflations.length > 0) {
        issues.push({
          code: "selector_method_span_conflates_display_roles",
          path: `/items/${itemIndex}`,
          message: "A visible method interval strictly contains source already bound to a distinguishable requirement, quantity, note, or sampling role",
          details: {
            item_key: item.key,
            affected_paths: unique(methodRoleConflations.flatMap(({ methodBinding, equal, contained }) => [
              methodBinding.path,
              ...equal.map((binding) => binding.path),
              ...contained.map((binding) => binding.path),
            ])),
            conflicting_bindings: methodRoleConflations.map(({ methodBinding, equal, contained }) => ({
              method: {
                span_id: methodBinding.span_id,
                evidence_id: methodBinding.span.evidence_id,
                start: methodBinding.span.start,
                end: methodBinding.span.end,
              },
              equal_roles: equal.map((binding) => ({
                role: binding.role,
                path: binding.path,
                span_id: binding.span_id,
              })),
              contained_roles: contained.map((binding) => ({
                role: binding.role,
                path: binding.path,
                span_id: binding.span_id,
                start: binding.span.start,
                end: binding.span.end,
              })),
            })),
            required_action: "replace_method_container_with_exact_visible_role_spans",
            replacement_constraints: {
              must_be_registered: true,
              must_preserve_exact_source_text: true,
              exact_indivisible_requirement_method_reuse_is_allowed: true,
              complete_requirement_may_contain_exact_quantity_subspan: true,
              typed_table_fields_are_checked_by_the_table_cell_granularity_rule: true,
              no_target_id_clause_number_keyword_title_format_or_length_heuristic: true,
            },
          },
        });
      }
    }
    const reportedDisplayIntervals = new Set<string>();
    for (const methodBinding of methodBindings) {
      const matchingQuantities = quantityBindings.filter((binding) => (
        sameInterval(methodBinding.span, binding.span)
      ));
      if (matchingQuantities.length === 0) continue;
      const intervalKey = [
        methodBinding.span.evidence_id,
        methodBinding.span.start,
        methodBinding.span.end,
      ].join("\0");
      if (reportedDisplayIntervals.has(intervalKey)) continue;
      reportedDisplayIntervals.add(intervalKey);
      const affectedPaths = unique([
        ...methodBindings.filter((binding) => sameInterval(methodBinding.span, binding.span)).map((binding) => binding.path),
        ...matchingQuantities.map((binding) => binding.path),
      ]);
      const registeredProperSubspans = registry.spans.filter((candidate) => (
        strictlyContains(methodBinding.span, candidate)
      ));
      issues.push({
        code: "selector_display_field_span_role_conflict",
        path: `/items/${itemIndex}`,
        message: `item ${item.key} 的可见检查方法和检查数量错误地复用了同一个精确来源区间；若原文能够区分两种角色，必须分别绑定各自的精确 span。`,
        details: {
          item_key: item.key,
          roles: ["method", "quantity"],
          offending_binding: {
            span_id: methodBinding.span.span_id,
            evidence_id: methodBinding.span.evidence_id,
            start: methodBinding.span.start,
            end: methodBinding.span.end,
          },
          affected_paths: affectedPaths,
          registered_subspan_candidates: registeredProperSubspans.slice(0, 32).map((candidate) => ({
            span_id: candidate.span_id,
            evidence_id: candidate.evidence_id,
            start: candidate.start,
            end: candidate.end,
          })),
          candidate_spans: modelVisibleSpanCandidates(registeredProperSubspans),
          required_action: "locate_exact_method_and_quantity_spans_and_replace_conflicting_fields",
          replacement_constraints: {
            must_be_registered: true,
            must_preserve_exact_source_text: true,
            method_and_quantity_must_not_resolve_to_the_same_interval: true,
            no_text_length_or_heading_heuristic: true,
          },
          actual: {
            item_key: item.key,
            roles: ["method", "quantity"],
            offending_binding: {
              span_id: methodBinding.span.span_id,
              evidence_id: methodBinding.span.evidence_id,
              start: methodBinding.span.start,
              end: methodBinding.span.end,
            },
            affected_paths: affectedPaths,
            registered_subspan_candidates_count: registeredProperSubspans.length,
          },
          writable_paths: affectedPaths,
          candidate_read_tools: ["read_target_selectors", "open_evidence", "locate_evidence_span"],
          next_tool: "read_target_selectors",
          next_tool_arguments: { collection: "items", key: item.key },
          save_tool: "stage_target_selector_draft",
          how_to_pass: "先用 read_target_selectors 读取当前 item，再核对 offending_binding 对应原文。candidate_spans 非空时逐一核对其 exact_fragment，选择真正属于 method 和 quantity 的已登记 span；候选为空或不完整时，先用 open_evidence 打开 offending_binding.evidence_id，再由模型从原文选择精确子串并调用 locate_evidence_span。最后只替换 affected_paths 指向的字段绑定，用 stage_target_selector_draft 保存并重试验证；不要编造文本，也不要用标题、长度或关键词猜角色。",
          do_not_edit: "不可变原文、编译产物和未列入 affected_paths 的正确字段。",
        },
      });
    }
    const quantityScalarBindings = [
      ...item.fields.quantity.span_ids.map((spanId, spanIndex) => ({
        span_id: spanId,
        path: `/items/${itemIndex}/fields/quantity/span_ids/${spanIndex}`,
      })),
      ...(item.sampling.status === "explicit"
        ? [
            ...item.sampling.quantity_span_ids.map((spanId, spanIndex) => ({
              span_id: spanId,
              path: `/items/${itemIndex}/sampling/quantity_span_ids/${spanIndex}`,
            })),
          ]
        : []),
    ];
    const scalarBindings = [
      ...quantityScalarBindings,
      ...(item.sampling.status === "explicit"
        ? [
            ...item.sampling.script_span_ids.map((spanId, spanIndex) => ({
              span_id: spanId,
              path: `/items/${itemIndex}/sampling/script_span_ids/${spanIndex}`,
            })),
          ]
        : []),
    ];
    const appliedSamplingRule = item.sampling.rule_key
      ? selectors.sampling_rules.find((rule) => rule.key === item.sampling.rule_key)
      : undefined;
    const selectedBranchKeys = new Set(item.sampling.branch_keys);
    const crossingRoleBindings = [
      ...itemRoleBindings.filter((binding) => (
        binding.role === "criterion"
        || binding.role === "continuation"
        || binding.role === "field:method"
        || binding.role === "field:note"
      )),
      ...(item.sampling.status === "explicit"
        ? [
            ...item.sampling.quantity_span_ids.map((spanId, spanIndex) => ({
              role: "sampling:quantity" as const,
              path: `/items/${itemIndex}/sampling/quantity_span_ids/${spanIndex}`,
              span_id: spanId,
            })),
            ...item.sampling.script_span_ids.map((spanId, spanIndex) => ({
              role: "sampling:script" as const,
              path: `/items/${itemIndex}/sampling/script_span_ids/${spanIndex}`,
              span_id: spanId,
            })),
            ...item.sampling.condition_span_ids.map((spanId, spanIndex) => ({
              role: "sampling:condition" as const,
              path: `/items/${itemIndex}/sampling/condition_span_ids/${spanIndex}`,
              span_id: spanId,
            })),
          ]
        : []),
      ...(appliedSamplingRule?.components.flatMap((component, componentIndex) => (
        component.disposition === "present"
          ? component.span_ids.map((spanId, spanIndex) => ({
              role: `sampling:${component.role}` as const,
              path: `/sampling_rules/${selectors.sampling_rules.indexOf(appliedSamplingRule)}/components/${componentIndex}/span_ids/${spanIndex}`,
              span_id: spanId,
            }))
          : []
      )) ?? []),
      ...(appliedSamplingRule?.branches.flatMap((branch, branchIndex) => (
        selectedBranchKeys.has(branch.key)
          ? branch.components.flatMap((component, componentIndex) => (
              component.disposition === "present"
                ? component.span_ids.map((spanId, spanIndex) => ({
                    role: `sampling:${component.role}` as const,
                    path: `/sampling_rules/${selectors.sampling_rules.indexOf(appliedSamplingRule)}/branches/${branchIndex}/components/${componentIndex}/span_ids/${spanIndex}`,
                    span_id: spanId,
                  }))
                : []
            ))
          : []
      )) ?? []),
      ...itemBoundaryBindings.filter((binding) => binding.item_key !== item.key).map((binding) => ({
        role: `other_item:${binding.role}` as const,
        path: binding.path,
        span_id: binding.span_id,
      })),
    ].flatMap((binding) => {
      const span = registeredById.get(binding.span_id);
      return span ? [{ ...binding, span }] : [];
    });
    const reportedCrossingQuantityIntervals = new Set<string>();
    for (const quantityBinding of quantityScalarBindings) {
      const quantitySpan = registeredById.get(quantityBinding.span_id);
      if (!quantitySpan) continue;
      const intervalKey = [
        quantitySpan.evidence_id,
        quantitySpan.start,
        quantitySpan.end,
      ].join("\0");
      if (reportedCrossingQuantityIntervals.has(intervalKey)) continue;
      const conflicts = crossingRoleBindings.filter((binding) => (
        crossesIntervalBoundary(quantitySpan, binding.span)
      ));
      if (conflicts.length === 0) continue;
      reportedCrossingQuantityIntervals.add(intervalKey);
      const quantityPaths = quantityScalarBindings.flatMap((binding) => {
        const span = registeredById.get(binding.span_id);
        return span && sameInterval(quantitySpan, span) ? [binding.path] : [];
      });
      issues.push({
        code: "selector_scalar_span_crosses_typed_role_boundary",
        path: `/items/${itemIndex}`,
        message: "A quantity interval cuts across a typed role or another item's source boundary without exactly matching or containing it",
        details: {
          item_key: item.key,
          offending_binding: {
            span_id: quantitySpan.span_id,
            evidence_id: quantitySpan.evidence_id,
            start: quantitySpan.start,
            end: quantitySpan.end,
          },
          affected_paths: unique([
            ...quantityPaths,
            ...conflicts.map((binding) => binding.path),
          ]),
          conflicting_bindings: conflicts.map((binding) => ({
            role: binding.role,
            path: binding.path,
            span_id: binding.span_id,
            start: binding.span.start,
            end: binding.span.end,
            relation: "crossing",
          })),
          required_action: "locate_exact_non_crossing_quantity_and_typed_role_spans",
          replacement_constraints: {
            must_be_registered: true,
            must_preserve_exact_source_text: true,
            exact_reuse_is_allowed: true,
            complete_requirement_or_sampling_script_may_contain_exact_quantity: true,
            quantity_must_not_cut_across_typed_or_other_item_boundaries: true,
            no_target_id_clause_number_keyword_title_format_or_length_heuristic: true,
          },
        },
      });
    }
    const pathsBySpanId = new Map<string, string[]>();
    for (const binding of scalarBindings) {
      pathsBySpanId.set(binding.span_id, unique([
        ...(pathsBySpanId.get(binding.span_id) ?? []),
        binding.path,
      ]));
    }

    for (const [spanId, affectedPaths] of pathsBySpanId) {
      const selected = registeredById.get(spanId);
      if (!selected) continue;

      const containedBoundaries = itemBoundaryBindings.filter((binding) => (
        binding.span.evidence_id === selected.evidence_id
        && binding.span.start >= selected.start
        && binding.span.end <= selected.end
      ));
      const containedItemKeys = unique(containedBoundaries.map((binding) => binding.item_key));
      const containedBoundaryRanges = unique(containedBoundaries.map((binding) => (
        `${binding.span.evidence_id}\0${binding.span.start}\0${binding.span.end}`
      )));
      const crossesItemBoundaries = containedItemKeys.length > 1
        && containedBoundaryRanges.length > 1;

      const containedItemRoles = itemRoleBindings.filter((binding) => (
        sameInterval(selected, binding.span) || strictlyContains(selected, binding.span)
      ));
      const strictlyContainedItemRoles = containedItemRoles.filter((binding) => (
        strictlyContains(selected, binding.span)
      ));
      const quantityUsesSelected = quantityScalarBindings.some((binding) => {
        const quantitySpan = registeredById.get(binding.span_id);
        return Boolean(quantitySpan && sameInterval(selected, quantitySpan));
      });
      const strictlyContainedSamplingRoles = quantityUsesSelected && item.sampling.status === "explicit"
        ? [
            ...item.sampling.script_span_ids.map((spanId, spanIndex) => ({
              role: "sampling:script" as const,
              path: `/items/${itemIndex}/sampling/script_span_ids/${spanIndex}`,
              span_id: spanId,
            })),
            ...item.sampling.condition_span_ids.map((spanId, spanIndex) => ({
              role: "sampling:condition" as const,
              path: `/items/${itemIndex}/sampling/condition_span_ids/${spanIndex}`,
              span_id: spanId,
            })),
          ].flatMap((binding) => {
            const span = registeredById.get(binding.span_id);
            return span && strictlyContains(selected, span) ? [{ ...binding, span }] : [];
          })
        : [];
      const strictlyContainedTypedRoles = [
        ...strictlyContainedItemRoles,
        ...strictlyContainedSamplingRoles,
      ];
      const fieldQuantityUsesSelected = item.fields.quantity.span_ids.some((quantitySpanId) => {
        const quantitySpan = registeredById.get(quantitySpanId);
        return Boolean(quantitySpan && sameInterval(selected, quantitySpan));
      });
      const equalConflictingDisplayRoles = containedItemRoles.filter((binding) => (
        sameInterval(selected, binding.span)
        && (
          binding.role === "field:requirement"
          || binding.role === "field:method"
          || binding.role === "field:note"
        )
      ));
      const registeredProperSubspans = registry.spans.filter((candidate) => (
        strictlyContains(selected, candidate)
      ));
      const hasSameItemRoleConflict = strictlyContainedTypedRoles.length > 0
        || (
          fieldQuantityUsesSelected
          && equalConflictingDisplayRoles.length > 0
          && registeredProperSubspans.length > 0
        );
      if (
        hasSameItemRoleConflict
        && !crossesItemBoundaries
      ) {
        issues.push({
          code: "selector_scalar_span_conflates_item_roles",
          path: `/items/${itemIndex}`,
          message: `item ${item.key} 的数量或项内抽样来源区间混入了同一 item 的其他可区分角色，而 registry 中已有更精确的来源区间。`,
          details: {
            item_key: item.key,
            offending_binding: {
              span_id: selected.span_id,
              evidence_id: selected.evidence_id,
              start: selected.start,
              end: selected.end,
            },
            affected_paths: affectedPaths,
            contained_role_bindings: [
              ...containedItemRoles,
              ...strictlyContainedSamplingRoles,
            ].map((binding) => ({
              role: binding.role,
              path: binding.path,
              span_id: binding.span_id,
              start: binding.span.start,
              end: binding.span.end,
              relation: strictlyContains(selected, binding.span) ? "strictly_contained" : "equal",
            })),
            registered_subspan_candidates: registeredProperSubspans.slice(0, 32).map((candidate) => ({
              span_id: candidate.span_id,
              evidence_id: candidate.evidence_id,
              start: candidate.start,
              end: candidate.end,
            })),
            candidate_spans: modelVisibleSpanCandidates(registeredProperSubspans),
            required_action: "replace_scalar_bindings_with_exact_role_spans",
            replacement_constraints: {
              affected_paths_only: affectedPaths,
              must_be_registered: true,
              must_preserve_exact_source_text: true,
              must_not_contain_bound_criterion_or_display_role_regions: true,
              may_reuse_one_exact_span_across_quantity_and_inline_sampling: true,
              criterion_and_requirement_sharing_is_not_rejected_by_this_check: true,
            },
            actual: {
              item_key: item.key,
              offending_binding: {
                span_id: selected.span_id,
                evidence_id: selected.evidence_id,
                start: selected.start,
                end: selected.end,
              },
              affected_paths: affectedPaths,
              contained_role_bindings: [
                ...containedItemRoles,
                ...strictlyContainedSamplingRoles,
              ].map((binding) => ({ role: binding.role, path: binding.path, span_id: binding.span_id })),
              registered_subspan_candidates_count: registeredProperSubspans.length,
            },
            writable_paths: affectedPaths,
            candidate_read_tools: ["read_target_selectors", "open_evidence", "locate_evidence_span"],
            next_tool: "read_target_selectors",
            next_tool_arguments: { collection: "items", key: item.key },
            save_tool: "stage_target_selector_draft",
            how_to_pass: "先用 read_target_selectors 读取当前 item，再核对 offending_binding、contained_role_bindings 和 candidate_spans。只为 affected_paths 选择对应标量角色的精确已登记 span；candidate_spans 为空或不完整时，先用 open_evidence 打开 offending_binding.evidence_id，再由模型从原文选择精确子串并调用 locate_evidence_span。数量和项内抽样可在确属同一精确原句时复用，但不得包含已分配给判据、要求、方法或备注的其他区间。用 stage_target_selector_draft 保存后重试验证。",
            do_not_edit: "不可变原文、编译产物、criterion/requirement 共享关系和未列入 affected_paths 的正确绑定。",
          },
        });
      }

      if (crossesItemBoundaries) {
        const bindingsByItem = new Map<string, typeof containedBoundaries>();
        for (const binding of containedBoundaries) {
          bindingsByItem.set(binding.item_key, [
            ...(bindingsByItem.get(binding.item_key) ?? []),
            binding,
          ]);
        }
        issues.push({
          code: "selector_scalar_span_crosses_item_boundaries",
          path: `/items/${itemIndex}`,
          message: "A scalar quantity or inline sampling span contains source boundaries selected for multiple independent items; locate and bind the exact role span instead of a multi-item source window",
          details: {
            item_key: item.key,
            offending_binding: {
              span_id: selected.span_id,
              evidence_id: selected.evidence_id,
              start: selected.start,
              end: selected.end,
            },
            affected_paths: affectedPaths,
            contained_item_bindings: [...bindingsByItem.entries()].map(([itemKey, bindings]) => ({
              item_key: itemKey,
              item_index: bindings[0]!.item_index,
              boundaries: bindings.map((binding) => ({
                role: binding.role,
                path: binding.path,
                span_id: binding.span_id,
                start: binding.span.start,
                end: binding.span.end,
              })),
            })),
            required_action: "locate_exact_role_spans_and_replace_affected_bindings",
            replacement_constraints: {
              must_be_registered: true,
              must_preserve_exact_source_text: true,
              must_not_contain_distinct_boundaries_from_multiple_items: true,
              may_reuse_one_exact_span_across_quantity_and_script: true,
            },
          },
        });
      }
    }
  });
}

type SamplingRuleSelector = TargetSelectorPlan["sampling_rules"][number];
type SamplingComponentSelector = SamplingRuleSelector["components"][number];

function presentSamplingComponents(
  components: readonly SamplingComponentSelector[],
  role?: SamplingComponentRole,
): SamplingComponentSelector[] {
  return components.filter((component) => (
    component.disposition === "present" && (role === undefined || component.role === role)
  ));
}

function samplingComponentSpanIds(
  components: readonly SamplingComponentSelector[],
  role?: SamplingComponentRole,
): string[] {
  return unique(presentSamplingComponents(components, role).flatMap((component) => component.span_ids));
}

function samplingScriptSpanIds(
  components: readonly SamplingComponentSelector[],
): string[] {
  const methodSpanIds = samplingComponentSpanIds(components, "method");
  const quantitySpanIds = samplingComponentSpanIds(components, "quantity");
  if (methodSpanIds.length > 0) {
    // A line-broken sampling sentence is sometimes selected once as the
    // complete quantity and again, incompletely, as a method prefix.  The
    // narrower duplicate must not truncate the executable script.  A genuinely
    // separate method still wins because it contains at least one span outside
    // the quantity component.
    const methodIsStrictQuantitySubset = quantitySpanIds.length > methodSpanIds.length
      && methodSpanIds.every((spanId) => quantitySpanIds.includes(spanId));
    return methodIsStrictQuantitySubset ? quantitySpanIds : methodSpanIds;
  }

  // Some source sampling tables define only applicability, quantity, and an
  // acceptance threshold. They still form an executable sampling rule even
  // though they do not prescribe a separate inspection method. Preserve the
  // present rule members as the script instead of compiling an invalid empty
  // string that the semantic-plan schema will reject.
  return unique(presentSamplingComponents(components)
    .filter((component) => component.role !== "method")
    .flatMap((component) => component.span_ids));
}

function effectiveSamplingComponents(
  rule: SamplingRuleSelector,
  branch: SamplingRuleSelector["branches"][number],
): SamplingComponentSelector[] {
  // A branch-local absent/not_applicable disposition records local semantics;
  // it never removes independently bound shared evidence.
  return [...rule.components, ...branch.components];
}

/** Only effective components received by this item, never the whole rule envelope. */
function receivedSamplingSourceSpanIds(selectors: TargetSelectorPlan, item: TargetSelectorPlan["items"][number]): string[] {
  const rule = ["reference", "reference_unspecified_quantity"].includes(item.sampling.status)
    ? selectors.sampling_rules.find(rule => rule.key === item.sampling.rule_key) : undefined;
  if (!rule) return [];
  const bind = (component: SamplingComponentSelector) => ({ ...component, source_span_ids: component.span_ids });
  return unique(rule.branches.filter(branch => item.sampling.branch_keys.includes(branch.key))
    .flatMap(branch => mergeSamplingComponents(rule.components.map(bind), branch.components.map(bind), "/sampling_rules")
      .components.filter(component => component.disposition === "present")
      .flatMap(component => component.source_span_ids)));
}

function samplingBranchQuantityMissingIssue(
  rule: SamplingRuleSelector,
  branch: SamplingRuleSelector["branches"][number],
  ruleIndex: number,
  branchIndex: number,
): TargetSelectorIssue {
  const branchPath = `/sampling_rules/${ruleIndex}/branches/${branchIndex}`;
  const branchComponentsPath = `${branchPath}/components`;
  return {
    code: "selector_sampling_branch_quantity_missing",
    path: branchPath,
    message: "当前分支没有可执行数量，也没有由 reference_unspecified_quantity 接收项目声明的有来源例外。先区分原文确实未给数量、漏绑数量和仅表示来源选择的空分支。",
    details: {
      rule_key: rule.key,
      branch_key: branch.key,
      writable_collection: "sampling_rules",
      writable_collections: ["sampling_rules", "items"],
      required_action: "bind_source_quantity_or_declare_supported_unspecified_exception; remove_only_source_routing_branches",
      candidate_read_tool: "list_sampling_rules",
      candidate_read_tools: ["read_target_selectors", "list_sampling_rules", "open_evidence"],
      next_tool: "stage_target_selector_draft",
      actual: { rule_key: rule.key, branch_key: branch.key, components: branch.components },
      allowed_actions: [
        "原文为当前分支给出可执行数量时，只在当前 branch.components 绑定真实的 present quantity。",
        "原文确实要求抽验但未给比例、件数或范围时，由模型依据原文选择对应真实 item，并让其 item.sampling 使用 reference_unspecified_quantity、选择当前 rule_key 和 branch_key。",
      ],
      writable_path: branchComponentsPath,
      writable_paths: [branchComponentsPath, "/items"],
      how_to_pass: "先用 read_target_selectors 分别读取当前 sampling rule 和 items 候选；需要核对抽样来源时，再用 list_sampling_rules 查找候选并以 open_evidence 打开原文。然后由模型依据原文二选一：原文为当前分支给出可执行数量时，只在当前 branch.components 绑定真实的 present quantity；原文确实要求抽验但未给比例、件数或范围时，保留精确抽验义务和 quantity=absent，并选择对应真实 item，让其 item.sampling 使用 reference_unspecified_quantity、选择当前 rule_key 和 branch_key。最后用 stage_target_selector_draft 保存涉及的 sampling_rules 或 items 完整记录并重试验证。来源选择不应制造空的替代分支；无业务条件也必须保留一个默认结构分支，item.sampling.branch_keys 选择它，不能把 branches 清空。不得由 harness 指定接收 item，不得补造数量或改为 not_sampling。",
      related_writable_path: "/items",
      do_not_edit: "编译产物、不可变原文和已正确的验收判据",
    },
  };
}

function duplicateKeys(values: string[]): string[] {
  const seen = new Set<string>();
  const duplicate = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicate.add(value);
    seen.add(value);
  }
  return [...duplicate].sort();
}

export function targetSelectorReferenceCycleIssues(
  plan: Pick<TargetSelectorPlan, "references">,
  registry: SourceSpanRegistry,
): TargetSelectorIssue[] {
  // A cited source containing another citation creates a dependency. Sharing
  // an acceptance item (or a span reused by several items) does not.
  const spans = new Map(registry.spans.map(span => [span.span_id, span]));
  const graph = plan.references.map(reference => plan.references.flatMap((next, index) => {
    const bindings = reference.target_span_ids.flatMap(targetId => {
      const target = spans.get(targetId);
      return next.anchor_span_ids.flatMap(anchorId => {
        const anchor = spans.get(anchorId);
        return target && anchor && target.evidence_id === anchor.evidence_id
          && target.start <= anchor.start && target.end >= anchor.end
          ? [{ target_span_id: targetId, anchor_span_id: anchorId }] : [];
      });
    });
    return bindings.length ? [{ next: index, bindings }] : [];
  }));
  const visiting = new Set<number>(), visited = new Set<number>();
  let cycle: number[] | undefined;
  const visit = (node: number, path: number[]): boolean => {
    if (visiting.has(node)) {
      cycle = [...path.slice(path.indexOf(node)), node];
      return true;
    }
    if (visited.has(node)) return false;
    visiting.add(node);
    for (const edge of graph[node]!) if (visit(edge.next, [...path, node])) return true;
    visiting.delete(node);
    visited.add(node);
    return false;
  };
  for (let node = 0; node < graph.length; node++) if (visit(node, [])) break;
  if (!cycle) return [];
  const edges = cycle.slice(0, -1).map((from, i) => {
    const to = cycle![i + 1]!;
    return { reference_key: plan.references[from]!.key, reference_path: `/references/${from}`,
      next_reference_key: plan.references[to]!.key,
      bindings: graph[from]!.find(edge => edge.next === to)!.bindings };
  });
  return [{ code: "selector_reference_cycle", path: "/references",
    message: "被引来源又包含回到前序引用的入口，形成来源引用环；同一 item 同时使用引用原话和被引内容本身不构成环。",
    details: {
      cycle: cycle.map(index => plan.references[index]!.key), edges,
      actual: { edges }, writable_collection: "references",
      writable_paths: edges.flatMap(edge => [`${edge.reference_path}/anchor_span_ids`, `${edge.reference_path}/target_span_ids`]),
      how_to_pass: "按 edges 读取对应 reference，核对 anchor 是否精确引用原话、target 是否确属被引内容；仅纠正选错或过宽的来源 span。不要改 item 名称或移动正确来源来消环。若原文确有循环，保留原文并报告来源阻塞，不能编造无环来源。",
      next_tool: "read_target_selectors", repair_tool: "stage_target_selector_draft",
      do_not_edit: "不可变原文、正确的 item 内容及编译产物",
    } }];
}

/** Attribute authored spans, never split prose or choose business applicability. */
function placeholderFieldSourceProof(
  selectors: TargetSelectorPlan,
  item: TargetSelectorPlan["items"][number],
  field: AcceptanceItemField,
  manifest: EvidenceManifest,
  registry: SourceSpanRegistry,
) {
  const spanById = new Map(registry.spans.map(span => [span.span_id, span]));
  const primary = [...item.criterion_span_ids, ...item.continuation_span_ids].flatMap(id => spanById.get(id) ?? []);
  const typedSpans = item.table ? Object.values(item.table.properties).flat(2).filter((id): id is string => typeof id === "string") : [];
  const typedSources = typedSpans.flatMap(id => spanById.get(id) ?? []);
  const evidenceById = new Map(manifest.evidence.map(evidence => [evidence.evidence_id, evidence]));
  const owned = [...primary, ...[...typedSpans, ...receivedSamplingSourceSpanIds(selectors, item)].flatMap(id => spanById.get(id) ?? [])];
  const candidates = selectors.references.flatMap(reference => {
    if (reference.application_mode !== "reference_placeholder") return [];
    const occurrence = manifest.reference_occurrences.find(entry => entry.occurrence_id === reference.occurrence_id);
    const failures: string[] = [];
    if (reference.destinations.length) failures.push("placeholder_destinations_not_empty");
    if (!occurrence || occurrence.status !== "resolved") failures.push("occurrence_not_resolved");
    const literals = occurrence ? referenceOccurrenceLiteralSpanIds(occurrence) : [];
    if (!literals.length || !literals.every(id => reference.anchor_span_ids.includes(id))) failures.push("reference_anchor_missing");
    const targets = new Set(occurrence?.target_evidence_ids ?? []);
    // A real typed data row is also authored leaf source. Structural cells alone
    // cannot establish this connection, and the exact table anchor is checked below.
    const typedTargetRow = occurrence?.reference_kind === "table" && typedSources.some(span => {
      const evidence = evidenceById.get(span.evidence_id);
      return targets.has(span.evidence_id) && evidence?.table_row_kind === "data"
        && evidence.table_id === occurrence.target_table_id;
    });
    if (!item.criterion_span_ids.length || (!primary.some(span => targets.has(span.evidence_id)) && !typedTargetRow)) failures.push("item_source_not_bound_to_target");
    if (occurrence?.reference_kind === "table") {
      if (item.table?.source_kind !== "reference" || !literals.every(id => item.table!.reference_span_ids.includes(id))) failures.push("table_reference_anchor_missing");
      // Same-fragment structural cells can supply a unit or heading, not an unrelated table.
      for (const fragment of manifest.table_fragments) {
        if (![...fragment.row_evidence_ids, ...fragment.formal_row_evidence_ids].some(id => targets.has(id))) continue;
        [...fragment.title_candidate_evidence_ids, ...fragment.header_evidence_ids].forEach(id => targets.add(id));
      }
    }
    return [{ reference, occurrence, targets, failures }];
  });
  const sources = item.fields[field].span_ids.map(span_id => {
    const span = spanById.get(span_id);
    const ownedByItem = Boolean(span && owned.some(source =>
      source.evidence_id === span.evidence_id && source.start <= span.start && source.end >= span.end));
    const matches = span && ownedByItem ? candidates.filter(candidate => !candidate.failures.length && candidate.targets.has(span.evidence_id)) : [];
    return { span_id, span, ownedByItem, matches };
  });
  const references = candidates.flatMap(candidate => {
    const span_ids = unique(sources.filter(source => source.matches.includes(candidate)).map(source => source.span_id));
    return span_ids.length ? [{ reference: candidate.reference, span_ids }] : [];
  });
  const activeReferences = new Set(references.map(route => route.reference));
  const sourceChecks = sources.map(source => {
    const localOrigins = source.span && source.ownedByItem ? candidates.filter(candidate =>
      activeReferences.has(candidate.reference) && candidate.occurrence
      && referenceOccurrenceOriginEvidenceIds(candidate.occurrence).includes(source.span!.evidence_id)) : [];
    const resolvedTargetOccurrences = source.span ? manifest.reference_occurrences.flatMap((occurrence, manifestIndex) =>
      occurrence.status === "resolved" && occurrence.target_evidence_ids.includes(source.span!.evidence_id) ? [{
        occurrence_id: occurrence.occurrence_id,
        matching_reference_keys: selectors.references.filter(reference => reference.occurrence_id === occurrence.occurrence_id)
          .map(reference => reference.key),
        catalog_read: { tool: "list_reference_occurrences", arguments: { cursor: manifestIndex, limit: 1,
          candidate_cursor: manifest.scope.reference_candidates?.length ?? 0, candidate_limit: 1 } },
      }] : []) : [];
    return { span_id: source.span_id, evidence_id: source.span?.evidence_id ?? "", owned_by_item: source.ownedByItem,
      source_scope: source.span ? evidenceById.get(source.span.evidence_id)?.evidence_scope ?? "unknown" : "unknown",
      resolved_target_occurrences: resolvedTargetOccurrences,
      status_basis: "saved_placeholder_reference_bindings",
      target_reference_keys: source.matches.map(candidate => candidate.reference.key),
      local_origin_reference_keys: localOrigins.map(candidate => candidate.reference.key),
      status: !source.span ? "unknown_span" : !source.ownedByItem ? "item_source_not_bound"
        : source.matches.length ? "target_source" : localOrigins.length ? "local_origin" : "outside_reference_targets" };
  });
  return { references, source_checks: sourceChecks,
    reference_checks: candidates.map(candidate => ({ reference_key: candidate.reference.key,
      occurrence_id: candidate.reference.occurrence_id, failed_conditions: candidate.failures })),
    complete: references.length > 0 && sourceChecks.length > 0
      && sourceChecks.every(source => source.status === "target_source" || source.status === "local_origin") };
}

function referenceLiteralDisplayIssues(
  selectors: TargetSelectorPlan,
  manifest: EvidenceManifest,
  registry: SourceSpanRegistry,
): TargetSelectorIssue[] {
  const spanById = new Map(registry.spans.map(span => [span.span_id, span]));
  const literals = unique(manifest.reference_occurrences.flatMap(referenceOccurrenceLiteralSpanIds))
    .flatMap(id => spanById.get(id) ?? []);
  return selectors.items.flatMap((item, itemIndex) => Object.entries(item.fields).flatMap(([field, binding]) => {
    if (binding.composition === "semantic_summary" || binding.composition === "not_applicable") return [];
    const path = `/items/${itemIndex}/fields/${field}/span_ids`;
    const duplicates = literals.flatMap(literal => {
      const bindings = binding.span_ids.flatMap((id, index) => {
        const span = spanById.get(id);
        return span && span.evidence_id === literal.evidence_id && span.start <= literal.start && span.end >= literal.end
          ? [{ ...span, path: `${path}/${index}` }] : [];
      });
      return bindings.length > 1 ? [{ literal, bindings }] : [];
    });
    return duplicates.length ? [{
      code: "selector_reference_literal_display_duplicate", path,
      message: "同一字段的多个 span 重复覆盖了同一处引用原话，逐段拼接会重复显示；anchor 与显示字段不要求重复选取。",
      details: {
        actual: { item_key: item.key, field, duplicates },
        writable_collection: "items", writable_path: path,
        required_action: "让每处引用原话在同一显示字段中只被一个 span 覆盖；保留必要的本地上下文。",
        how_to_pass: "若整句 span 已包含引用原话，从该字段移除重复的内部 literal span 即可；不必在 fields 中另选 literal。若需部分原文，先用 locate_evidence_span 定位不重叠片段。references[].anchor_span_ids 仍必须保留全部精确 literal；不要删除 anchor、条件、判据或改 composition 绕过检查。然后保存本项并重试验证。",
        next_tool: "stage_target_selector_draft", candidate_read_tool: "read_target_selectors",
        do_not_edit: "不可变原文、编译产物、引用 occurrence/anchor 和无关的正确字段。",
      },
    }] : [];
  }));
}

function unresolvedReferenceDestinationDetails(
  reference: TargetSelectorPlan["references"][number],
  occurrence: EvidenceManifest["reference_occurrences"][number],
  index: number,
): Record<string, unknown> {
  return {
    reference_key: reference.key,
    actual: { status: occurrence.status, required: occurrence.required, action: reference.action,
      application_mode: reference.application_mode, target_span_count: reference.target_span_ids.length,
      destination_count: reference.destinations.length, origin_binding: reference.origin_binding ?? null,
      origin_fields: occurrence.origin_fields },
    expected: { destination_count: "at_least_one_real_local_origin_field", target_span_ids: [],
      action: "keep_reference", application_mode: "reference_only" },
    allowed_actions: ["目标未找到时，keep_reference 接收本地原引用文字，不导入被引内容；由模型依据原文把 destinations 绑定到原引用实际所在的真实 item 字段。目标来源为空不等于本地接收者不存在，origin_binding 不能替代 destinations。"],
    allowed_empty_target_when: { action: "keep_reference", application_mode: "reference_only", target_span_ids: [] },
    writable_paths: [`/references/${index}/action`, `/references/${index}/application_mode`, `/references/${index}/destinations`, "/items"],
    writable_collections: ["references", "items"],
    next_tool: "read_target_selectors", next_tool_arguments: { collection: "references", key: reference.key },
    candidate_read_tools: ["read_target_selectors", "list_reference_occurrences", "open_evidence", "locate_evidence_span"],
    save_tool: "stage_target_selector_draft",
    how_to_pass: "先读取当前 reference、occurrence 和本地原文，以及模型判断的原引用所在 item 的完整作者记录。target_span_ids=[] 只表示没有被引目标来源；destinations 仍须保留原引用实际所在的本地业务字段，origin_binding 不是接收回执，不能代替它。由模型依据原文判断真实接收者，原字段缺引用文字或 item 来源时，修正该 draft.items 的字段及 criterion/continuation 归属，再同次保存完整 draft.references 的 keep_reference/reference_only、精确 anchor 和真实 destinations。不要读取不存在的目标，不要求虚造被引验收叶或 target spans；不得把无目标改为已解析、背景或 placeholder 来消错。此修复只闭合本地引用回执，required/status 与完整阶段校验仍按原合同执行。",
    do_not_edit: "不可变 occurrence、原文、编译产物和已正确的真实 items；harness 不替模型指定接收项。",
  };
}

/** A saved reference locator alone does not materialize its required origin source. */
export function requiredReferenceAnchorOnlyEvidenceIds(
  selectors: TargetSelectorPlan, manifest: EvidenceManifest, registry: SourceSpanRegistry,
): string[] {
  const anchorIds = collectSelectorSpanIds(selectors.references.map(reference => ({ anchor_span_ids: reference.anchor_span_ids })));
  const otherIds = collectSelectorSpanIds({ ...selectors,
    references: selectors.references.map(reference => ({ ...reference, anchor_span_ids: [] })) });
  const anchorSources = new Set(registry.spans.filter(span => anchorIds.has(span.span_id)).map(span => span.evidence_id));
  const otherSources = new Set(registry.spans.filter(span => otherIds.has(span.span_id)).map(span => span.evidence_id));
  return manifest.evidence.filter(row => row.requires_disposition && anchorSources.has(row.evidence_id)
    && !otherSources.has(row.evidence_id)).map(row => row.evidence_id);
}

/** A reference-composed display alone does not give an unrelated source a receiver.
 * Mirrors the compiler's source accounting only; it neither compiles a stage nor
 * decides whether the author's field, item ownership or reference route is right. */
export function requiredReferenceFieldOnlyEvidenceIds(
  selectors: TargetSelectorPlan, manifest: EvidenceManifest, registry: SourceSpanRegistry,
): string[] {
  const fieldIds = collectSelectorSpanIds(selectors.items.flatMap(item =>
    Object.values(item.fields).filter(field => field.composition === "reference")));
  const otherIds = collectSelectorSpanIds({ ...selectors, items: selectors.items.map(item => ({
    ...item, fields: Object.fromEntries(Object.entries(item.fields).map(([key, field]) =>
      [key, field.composition === "reference" ? { ...field, span_ids: [] } : field])),
  })), references: selectors.references.map(reference => ({ ...reference, anchor_span_ids: [] })) });
  const fieldSources = new Set(registry.spans.filter(span => fieldIds.has(span.span_id)).map(span => span.evidence_id));
  const otherSources = new Set(registry.spans.filter(span => otherIds.has(span.span_id)).map(span => span.evidence_id));
  for (const reference of selectors.references) {
    if (reference.application_mode === "reference_placeholder" || (!reference.destinations.length && !reference.origin_binding)) continue;
    const occurrence = manifest.reference_occurrences.find(row => row.occurrence_id === reference.occurrence_id);
    if (occurrence) referenceOccurrenceOriginEvidenceIds(occurrence).forEach(id => otherSources.add(id));
  }
  return manifest.evidence.filter(row => row.requires_disposition && fieldSources.has(row.evidence_id)
    && !otherSources.has(row.evidence_id)).map(row => row.evidence_id);
}

/** Limited current author-receipt check; never compiles or approves the full stage. */
export function unresolvedReferenceDestinationIssues(
  selectors: TargetSelectorPlan, manifest: EvidenceManifest, registry: SourceSpanRegistry,
): TargetSelectorIssue[] {
  return selectors.references.flatMap((reference, index) => {
    const occurrence = manifest.reference_occurrences.find(row => row.occurrence_id === reference.occurrence_id);
    if (!occurrence || occurrence.status !== "target_not_found" || occurrence.target_evidence_ids.length
      || occurrence.external_standard || reference.action !== "keep_reference" || reference.application_mode !== "reference_only"
      || reference.destinations.length || selectorHasContextReference(selectors, registry, manifest, reference, occurrence)) return [];
    return [{ code: "selector_reference_destination_required", path: `/references/${index}/destinations`,
      message: "未解析引用仍须保留原引用实际所在的本地业务接收字段。",
      details: { occurrence_id: occurrence.occurrence_id, ...unresolvedReferenceDestinationDetails(reference, occurrence, index) } }];
  });
}

function contextReferenceAlternative(
  reference: TargetSelectorPlan["references"][number],
  facts: ReturnType<typeof selectorContextReferenceFacts>,
): Record<string, unknown> {
  return {
    condition: "模型仅依据原文确认完整原引用来源属于背景；不是依据空 destinations、重复路由或被引内容不适用推断。现有业务来源必须保留。",
    actual: facts,
    expected: { action: "mention", application_mode: "reference_only", origin_context_coverage: "all_complete_and_explicit", business_origin_bindings: [], destinations: [], origin_binding: "omit", target_span_ids: "nonempty_exact_spans_inside_this_occurrence", component_dispositions: "if_present_not_applicable_with_empty_item_keys" },
    next_tool: "read_target_selectors", next_tool_arguments: { collection: "references", key: reference.key },
    source_read_tool: "read_target_selectors", source_read_tool_arguments: { collection: "source_dispositions", evidence_ids: facts.origin_evidence_ids },
    save_tool: "stage_target_selector_draft",
    instruction: "先读取当前完整 reference 和点名来源的处置，核对原文及 actual 中的完整背景覆盖、实际业务绑定。由模型选择有据的路线；背景路线须同时满足 expected 全部条件，业务来源仍须真实接收字段。只修改 reason、保留 origin_binding 或仅处置部分来源不能通过。完整保存涉及的 references/source_dispositions 后重试原验证；此备选说明不修改来源分类，不授予背景回执通过。",
  };
}

/** Current empty-receiver repair facts only; no compilation or background approval. */
export function resolvedReferenceDestinationIssues(
  selectors: TargetSelectorPlan, manifest: EvidenceManifest, registry: SourceSpanRegistry,
): TargetSelectorIssue[] {
  return selectors.references.flatMap((reference, index) => {
    const occurrence = manifest.reference_occurrences.find(row => row.occurrence_id === reference.occurrence_id);
    if (!occurrence || occurrence.status !== "resolved" || occurrence.external_standard || reference.destinations.length
      || reference.application_mode === "reference_placeholder"
      || selectorHasContextReference(selectors, registry, manifest, reference, occurrence)) return [];
    const facts = selectorContextReferenceFacts(selectors, registry, manifest, occurrence);
    return [{ code: "selector_reference_destination_required", path: `/references/${index}/destinations`,
      message: "当前非占位引用缺少业务接收字段，也尚未满足完整背景回执条件。",
      details: {
        occurrence_id: occurrence.occurrence_id, reference_key: reference.key,
        actual: { status: occurrence.status, current_reference: reference, ...facts },
        context_reference_alternative: contextReferenceAlternative(reference, facts),
        writable_paths: [`/references/${index}`, "/source_dispositions", "/items"],
        writable_collections: ["references", "source_dispositions", "items"],
        next_tool: "read_target_selectors", next_tool_arguments: { collection: "references", key: reference.key },
        save_tool: "stage_target_selector_draft",
        how_to_pass: "先读取当前完整 reference，再核对原文及 actual 的来源分类事实。真实业务来源须恢复其实际接收 item/字段，保留其他正确记录；只有模型依据原文确认完整原引用来源仅为背景且不被业务记录使用时，才按 context_reference_alternative 同时满足全部背景条件。无 destinations、重复路由或被引内容不适用本身不能证明背景；不得虚造接收项，也不得把真实业务改成 context。保存有据的完整作者记录后再执行原阶段检查；本回条未重检完整阶段、不批准引用或重置预算。",
        do_not_edit: "不可变 occurrence、原文、编译产物、已正确的真实业务绑定及阶段预算。",
      },
    }];
  });
}

export function registeredDocumentReferenceReceiptIssues(
  selectors: TargetSelectorPlan,
  manifest: EvidenceManifest,
  registry: SourceSpanRegistry,
): TargetSelectorIssue[] {
  const issues: TargetSelectorIssue[] = referenceLiteralDisplayIssues(selectors, manifest, registry);
  const exactDocumentOccurrences = manifest.reference_occurrences.filter((occurrence) =>
    referenceOccurrenceLiteralSpanIds(occurrence).length > 0
  );
  exactDocumentOccurrences.forEach((occurrence) => {
    const occurrenceIndex = manifest.reference_occurrences.indexOf(occurrence);
    const selectorBindings = selectors.references.filter((reference) =>
      reference.occurrence_id === occurrence.occurrence_id
    );
    if (selectorBindings.length === 1) return;
    const literalSpanIds = referenceOccurrenceLiteralSpanIds(occurrence);
    const exactAnchorRecords = selectors.references.filter(reference => reference.anchor_span_ids.length === literalSpanIds.length
      && reference.anchor_span_ids.every((id, index) => id === literalSpanIds[index]));
    const hasExistingAnchorRecord = selectorBindings.length === 0 && exactAnchorRecords.length > 0;
    const unresolvedTarget = occurrence.status === "target_not_found" && occurrence.target_evidence_ids.length === 0;
    issues.push({
      code: selectorBindings.length === 0
        ? "selector_registered_reference_receipt_missing"
        : "selector_registered_reference_receipt_duplicate",
      path: "/references",
      message: selectorBindings.length === 0
        ? "resolve_document_reference 已登记这处引用，但 selector 尚未逐条提交对应 occurrence_id；缺少回执不得进入下一阶段。"
        : "同一处已登记引用只能提交一次，不能把同一个 occurrence_id 重复路由。",
      details: {
        occurrence_id: occurrence.occurrence_id,
        manifest_index: occurrenceIndex,
        status: occurrence.status,
        reference_literal_span_id: occurrence.reference_literal_span_id,
        reference_literal_span_ids: referenceOccurrenceLiteralSpanIds(occurrence),
        matching_reference_keys: selectorBindings.map((reference) => reference.key),
        required_action: selectorBindings.length === 0
          ? "若被引业务组件缺真实接收项，先按原文补齐 draft.items；再新增 draft.references，逐字复制 occurrence_id 和全部有序 reference_literal_span_ids 作 anchor，并按原文绑定真实字段。纯占位须已有完整真实项覆盖。"
          : "删除重复 references 记录，仅保留一条与原字段和原位置一致的绑定",
        actual: {
          occurrence_id: occurrence.occurrence_id,
          manifest_index: occurrenceIndex,
          status: occurrence.status,
          required: occurrence.required,
          target_evidence_count: occurrence.target_evidence_ids.length,
          ...(unresolvedTarget ? { target_evidence_ids: [] } : {}),
          reference_literal_span_ids: referenceOccurrenceLiteralSpanIds(occurrence),
          matching_reference_keys: selectorBindings.map((reference) => reference.key),
          exact_anchor_author_records: exactAnchorRecords.map(reference => ({ key: reference.key,
            current_occurrence_id: reference.occurrence_id ?? null })),
          origin_evidence_ids: referenceOccurrenceOriginEvidenceIds(occurrence),
          context_receipt_available: selectorContextReferenceOrigins(selectors, registry, manifest, occurrence),
        },
        ...(selectorBindings.length === 0 && unresolvedTarget ? {
          allowed_unresolved_values: { action: "keep_reference", application_mode: "reference_only", target_span_ids: [] },
          required_action: "核对现有 target_not_found 回执和原引用，提交保留真实引用的作者记录；不猜目标或虚造业务接收项",
        } : {}),
        ...(selectorContextReferenceOrigins(selectors, registry, manifest, occurrence) ? {
          context_receipt_values: { action: "mention", application_mode: "reference_only", destinations: [], origin_binding: "omit" },
          context_receipt_condition: "仅在模型确认当前 context 处置正确时：全部 origin 原文已由显式 source_dispositions=context 完整覆盖，且未进入任何项目、检验批、抽样规则或业务引用目标。保留 occurrence_id、全部精确 anchor 和已读目标的真实 target_span_ids；没有业务组件接收者，component_dispositions（如提供）只能是有依据的 not_applicable 且 item_keys=[]。不改变不可变 required/status，不导入验收字段。",
        } : {}),
        ...(hasExistingAnchorRecord ? {
          required_action: "先读取精确同 anchor 的已有作者记录并核对原文及 occurrence；同一引用时在完整记录中补回明确 occurrence_id，保留其他正确字段，不默认新增重复 reference。",
        } : {}),
        writable_path: "/references",
        writable_paths: selectorBindings.length === 0 ? ["/items", "/references"] : ["/references"],
        candidate_read_tools: ["list_reference_occurrences", "read_target_selectors", "read_document_reference_evidence", "read_reference_facts", "open_evidence", "locate_evidence_span"],
        next_tool: selectorBindings.length === 0 && exactAnchorRecords.length !== 1 ? "list_reference_occurrences" : "read_target_selectors",
        next_tool_arguments: selectorBindings.length === 0 && exactAnchorRecords.length === 1
          ? { collection: "references", key: exactAnchorRecords[0]!.key }
          : selectorBindings.length === 0 ? { cursor: occurrenceIndex, limit: 1, candidate_cursor: manifest.scope.reference_candidates?.length ?? 0, candidate_limit: 1 } : { collection: "references" },
        save_tool: "stage_target_selector_draft",
        ...(selectorBindings.length === 0 ? {
          save_tool_instruction: hasExistingAnchorRecord
            ? "先核对已有作者记录；同一引用时以 operation=upsert、draft.references 保存带明确 occurrence_id 的完整原 key 记录并保留其他有效字段。缺真实接收项时按原文修正 draft.items，不默认另增 reference。writable_paths 是可修改集合提示，不是工具参数。"
            : "依据已读原文，必要时先以 operation=upsert、draft.items 保存完整的真实接收项，再以 draft.references 保存该 occurrence 的完整引用记录；可同次提交。writable_paths 是可修改集合提示，不是工具参数。",
        } : {}),
        how_to_pass: hasExistingAnchorRecord
          ? "actual.exact_anchor_author_records 是精确同 anchor 的已有作者记录，尚不证明业务路由正确。先读取这些真实 key，再用 list_reference_occurrences 核对 occurrence_id、全部有序字面 span 与原文；若仍是同一引用，在原 key 完整记录中补回明确 occurrence_id，保留其他正确字段，不重复造 reference。若记录实际属于不同引用，先按原文澄清身份及合法路由，不得自动合并或改换业务接收者。以 stage_target_selector_draft 保存完整 references 记录后依据新校验回条继续；补回身份不证明 action、来源或接收字段通过。"
          : (selectorBindings.length === 0
          ? unresolvedTarget
            ? "先用 list_reference_occurrences 核对当前 occurrence_id、原文 literal、required 和 target_not_found 回执，再按原来源读取原文及现有作者 records。当前没有可展开目标，不要调用目标读取工具或猜 target_span_ids。由模型核对真实接收项及原引用实际所在字段，保存 keep_reference/reference_only、target_span_ids=[]、精确 anchor 和有依据的完整 references 记录。空 target spans 不允许空 destinations：这里接收的是本地原引用文字，接收项不必来自未找到的目标；origin_binding 也不能代替 destinations。原引用字段尚未保留文字和来源时，依据原文修正对应 draft.items 记录，不能虚造被引判据。这只补作者回执，不会把未解析目标变成通过。若原文支持定位参数有误，才用 resolve_document_reference 重新定位真实目标；required、status 和原文不可改，缺接收依据或目标仍不可恢复时保留检查点，不能虚造验收项。保存后依据新校验回条继续。"
            : selectorContextReferenceOrigins(selectors, registry, manifest, occurrence)
            ? "先读取当前 source_dispositions 和 occurrence 的原文，复核 context_receipt_condition。若模型确认只属背景，用 context_receipt_values 保存完整 draft.references：保留 occurrence_id、全部精确 anchor、合法且已读的 target_span_ids 和真实说明，destinations=[]，省略 origin_binding，不选 placeholder。若发现 context 分类错误，恢复实际业务来源并建立真实字段路由。不得删除已登记 occurrence 来消错，不得虚造接收项或改变原文适用性。保存后重试验证。"
            : "先用 list_reference_occurrences 核对 occurrence_id、字面 span、analysis_mode、target_key；inline 用 read_document_reference_evidence，isolated 用 read_reference_facts 读组件，并用 read_target_selectors 读现有 items。若适用组件缺接收项，先按原文补齐 draft.items 及精确来源，不得猜不适用或接收字段。再增 draft.references，复制 occurrence_id 和全部 reference_literal_span_ids 作 anchor，按原文绑定目标、真实字段。仅在真实项完整覆盖时可用 reference_placeholder。用 stage_target_selector_draft 保存 items/references 后重试。"
          : "先用 read_target_selectors 读取 references，按 occurrence_id 找出重复记录；保留唯一且与原字段、原位置一致的绑定，删除其余重复记录。用 stage_target_selector_draft 保存后重试验证，不得合并不同 occurrence。"),
        do_not_edit: "不可变引用 occurrence、原文、编译产物和无关 references。",
      },
    });
  });
  if (exactDocumentOccurrences.length === 0) return issues;
  const businessFields = ["name", "requirement", "method", "quantity", "note"] as const;
  selectors.items.forEach((item, itemIndex) => {
    businessFields.forEach((field) => {
      if (item.fields[field].composition !== "reference") return;
      const hasResolvedReceipt = selectors.references.some((reference) =>
        Boolean(reference.occurrence_id)
        && reference.destinations.some((destination) =>
          destination.item_key === item.key && destination.target_field === field
        )
      );
      const placeholderProof = placeholderFieldSourceProof(selectors, item, field, manifest, registry);
      if (hasResolvedReceipt || placeholderProof.complete) return;
      const registeredReferences = selectors.references.map((reference, referenceIndex) => ({
        path: `/references/${referenceIndex}`, key: reference.key, occurrence_id: reference.occurrence_id,
        application_mode: reference.application_mode, destinations: reference.destinations,
      }));
      issues.push({
        code: "selector_reference_composition_without_resolve_receipt",
        path: `/items/${itemIndex}/fields/${field}/composition`,
        message: "该字段尚未证明被引来源归属；已解析引用不等于已绑定本字段。普通引用须有同 item/field 路由；placeholder 则按真实叶的 criterion/continuation、typed table 或选中共享抽样分支的有效组件逐片段证明，不能给占位记录填 destinations。",
        details: {
          item_key: item.key,
          field,
          actual: item.fields[field], registered_references: registeredReferences,
          source_checks: placeholderProof.source_checks,
          reference_checks: placeholderProof.reference_checks,
          writable_paths: ["/references", `/items/${itemIndex}/fields/${field}`, `/items/${itemIndex}/criterion_span_ids`, `/items/${itemIndex}/continuation_span_ids`, `/items/${itemIndex}/sampling`, "/sampling_rules", ...(item.table ? [`/items/${itemIndex}/table`] : [])],
          writable_collections: ["references", "items", "sampling_rules"],
          registered_occurrences: exactDocumentOccurrences.map(entry => ({ occurrence_id: entry.occurrence_id, status: entry.status })),
          required_action: "inspect_the_current_field_sources_then_choose_local_composition_or_a_proved_reference_route",
          allowed_actions: [
            field === "name"
              ? "若 source_checks 表明这些 span 是当前 item 自己的本地原文、并非被引目标内容，当前 name 字段可把 composition 改为与实际文本一致的 verbatim 或 semantic_summary；保留原 span、业务内容和 provenance。"
              : `若 source_checks 表明这些 span 是当前 item 自己的本地原文、并非被引目标内容，当前 ${field} 字段应把 composition 改为保持精确原文绑定的 verbatim；semantic_summary 仅适用于 name。保留原 span、业务内容和 provenance。`,
            "若该字段确实使用已解析的被引内容，保留 composition=reference，并建立同 item/field 的普通 reference_only destination、准确 import_scope 和来源关系。",
            "仅当既有 placeholder 契约确实成立时，保持 placeholder destinations=[]，并用真实叶的 criterion/continuation、typed table 或已选共享抽样组件逐片段证明来源。",
          ],
          candidate_read_tool: "read_target_selectors",
          candidate_read_tools: ["read_target_selectors", "list_reference_occurrences", "open_evidence", "locate_evidence_span", "read_document_reference_evidence", "read_reference_facts"],
          next_tool: "read_target_selectors",
          next_tools: ["read_target_selectors", "list_reference_occurrences", "open_evidence", "locate_evidence_span", "read_document_reference_evidence", "read_reference_facts", "stage_target_selector_draft"],
          save_tool: "stage_target_selector_draft",
          how_to_pass: "先用 read_target_selectors 读取报错 item 字段和现有 references，再按 source_checks 逐个核对 span：unknown_span 用 locate_evidence_span 或 quote_bindings 重新定位；outside_reference_targets 仅说明当前已保存的 placeholder 绑定尚未证明该片段，owned_by_item 仅说明片段属于本 item，二者不判定本地来源。按 source_scope 与 resolved_target_occurrences 核对实际来源；存在已解析 target 关联时，先按其 catalog_read 精确读取 occurrence，再依目录的 analysis_mode 用对应 inline/isolated 工具核对被引正文及真实接收路由。matching_reference_keys 只列已保存记录，不表示字段绑定已获批准。只有原文确认字段实际使用本地内容、没有采用被引内容时，才选择保持精确来源的非 reference composition。item_source_not_bound 或 reference_checks 非空时同样核对归属与路由。然后从 allowed_actions 中选择实际成立的路线，用 save_tool 保存并重试。不得把所有字段机械改成同一种 composition，也不得为保留 reference 伪造 destination、criterion 或引用来源。",
          do_not_edit: "不可变原文和编译产物；不要删除正确来源、改换无关 table_key，或给 placeholder 填 destinations。",
        },
      });
    });
  });
  return issues;
}

function validateAcceptanceBranchContract(
  selectors: TargetSelectorPlan,
  registry: SourceSpanRegistry,
  sources: Map<string, ImmutableTextSource>,
  issues: TargetSelectorIssue[],
): void {
  const spanById = new Map(registry.spans.map((span) => [span.span_id, span]));
  const spanText = (spanId: string): string => {
    const span = spanById.get(spanId);
    const source = span ? sources.get(span.evidence_id) : undefined;
    return span && source ? source.text.slice(span.start, span.end).trim() : "";
  };
  const sameSet = (left: readonly string[], right: readonly string[]): boolean => (
    left.length === right.length && left.every((value) => right.includes(value))
  );
  const covers = (ids: readonly string[], targetId: string): boolean => {
    const target = spanById.get(targetId);
    return Boolean(target && coveredBySpans(target, ids.flatMap(id => spanById.get(id) ?? [])));
  };
  const describeSpans = (ids: readonly string[]) => ids.map(span_id => {
    const span = spanById.get(span_id);
    return { span_id, evidence_id: span?.evidence_id, start: span?.start, end: span?.end, text: spanText(span_id) };
  });
  const acceptanceBranchAuthoringAlternatives = (
    itemIndex: number,
    itemKey: string,
    tableKey: string,
    primaryWritablePaths: readonly string[],
    trueBranchRepair: string,
  ) => {
    const itemPath = `/items/${itemIndex}`;
    return {
      legal_paths: [
        {
          when: "same_core_property_with_mutually_exclusive_acceptance_conditions",
          required_action: "keep_acceptance_branches_and_complete_their_visible_acceptance_requirements",
        },
        {
          when: "different_acceptance_properties_or_formulas",
          required_action: "split_into_multiple_items_and_map_each_acceptance_row",
        },
        {
          when: "selected_rows_are_sampling_method_or_non_item_context",
          required_action: "remove_misclassified_acceptance_branch_bindings_and_use_the_existing_matching_author_contract",
        },
      ],
      allowed_actions: [
        `核对原文确认这些行确属同一核心检查属性的互斥验收条件时，保留 acceptance_branches，${trueBranchRepair}`,
        "核对原文确认这些行属于不同验收属性或公式时，拆成多个真实 items，并让每项只绑定自己的验收行、条件和允许值。",
        "核对原文确认这些行实际属于抽样、检验方法或非项目上下文而不是验收判据分支时，移出 item.table.properties 及 criterion_span_ids/continuation_span_ids 中误分类的判据绑定，并按现有契约分别改入 item.sampling 与 sampling_rules、item.fields.method 或 source_dispositions；保留仍适用的全部原文事实和真实判据。",
      ],
      writable_paths: unique([
        ...primaryWritablePaths,
        `${itemPath}/table`,
        `${itemPath}/criterion_span_ids`,
        `${itemPath}/continuation_span_ids`,
        `${itemPath}/fields/method`,
        `${itemPath}/sampling`,
        "/sampling_rules",
        "/source_dispositions",
        "/items",
      ]),
      writable_collections: ["items", "sampling_rules", "source_dispositions"],
      item_key: itemKey,
      table_key: tableKey,
      candidate_read_tool: "read_target_selectors",
      candidate_read_tools: [
        "read_target_selectors",
        "list_table_fragments",
        "read_table_summary",
        "read_table_rows",
        "list_sampling_rules",
        "open_evidence",
        "locate_evidence_span",
      ],
      next_tool: "read_target_selectors",
      next_tool_arguments: { collection: "items", key: itemKey },
      next_tools: [
        "read_target_selectors",
        "list_table_fragments",
        "read_table_summary",
        "read_table_rows",
        "list_sampling_rules",
        "open_evidence",
        "locate_evidence_span",
        "stage_target_selector_draft",
      ],
      save_tool: "stage_target_selector_draft",
      how_to_pass: `先用 read_target_selectors（collection=items, key=${itemKey}）读取当前完整 item；再用 list_table_fragments 定位逻辑表，并用 read_table_summary、read_table_rows（table_key=${tableKey}）核对 fragment、表头、数据行和单元格来源，需要精确子区间时才用 open_evidence、locate_evidence_span。若可能属于抽样，再用 list_sampling_rules 核对现有规则。由模型根据原文从 allowed_actions 选择合法作者路径：若是真实验收分支，${trueBranchRepair}若是不同验收属性则拆项；若不是验收判据分支，则移除错误的 acceptance branch 角色绑定，并核对 criterion_span_ids/continuation_span_ids，移出其中同样误分类的判据来源，使用现有 sampling、method 或 context 契约保存真实含义。只删除 table 而保留这些判据绑定仍会触发表格来源校验；真实判据来源必须保留。不得仅为消错删除仍适用事实，也不得由 harness 指定具体分类、接收 item、分支数量、允许值或业务结果。最后用 save_tool 指定的 stage_target_selector_draft 保存涉及的完整记录并重新验证。`,
      do_not_edit: "不可变原文和编译产物；不得为消错丢弃仍适用事实，也不得由 harness 替模型选择业务容器。",
    };
  };
  selectors.items.forEach((item, itemIndex) => {
    if (!item.table) return;
    const properties = item.table.properties;
    const branches = properties.acceptance_branches ?? [];
    const branchPath = `/items/${itemIndex}/table/properties/acceptance_branches`;
    if (branches.length === 0 && properties.row_path_span_ids.length >= 2
      && new Set(properties.condition_span_ids).size >= 2) {
      issues.push({
        code: "selector_acceptance_branches_required",
        path: branchPath,
        message: `item ${item.key} 的表格字段同时绑定了多组行、条件和允许值，但尚未说明它们属于同一验收属性的互斥条件、不同验收属性或公式，还是并非验收判据而应由抽样、检验方法或上下文契约承载。不能把多组来源只放在并列数组中。`,
        details: {
          condition_span_ids: properties.condition_span_ids,
          condition_rows: properties.condition_span_ids.map(span_id => ({ span_id, text: spanText(span_id) })),
          allowed_value_span_ids: properties.allowed_value_span_ids,
          allowed_value_rows: properties.allowed_value_span_ids.map(span_id => ({ span_id, text: spanText(span_id) })),
          actual: {
            item_key: item.key,
            table_key: item.table.table_key,
            acceptance_branches: branches,
            row_path_span_ids: properties.row_path_span_ids,
            condition_span_ids: properties.condition_span_ids,
            allowed_value_span_ids: properties.allowed_value_span_ids,
          },
          required_action: "choose_acceptance_branch_split_or_reclassify_non_acceptance_rows",
          note_is_not_a_branch_carrier: true,
          ...acceptanceBranchAuthoringAlternatives(
            itemIndex,
            item.key,
            item.table.table_key,
            [branchPath],
            "在当前 item.table.properties.acceptance_branches 中逐分支绑定完整条件、要求和允许值；",
          ),
        },
      });
    }
    if (branches.length > 0) {
      const duplicateBranchKeys = duplicateKeys(branches.map((branch) => branch.key));
      if (duplicateBranchKeys.length) {
        issues.push({
          code: "selector_acceptance_branch_duplicate",
          path: branchPath,
          message: "Acceptance branch keys must be unique within one item",
          details: {
            duplicate_branch_keys: duplicateBranchKeys,
            actual: { item_key: item.key, duplicate_branch_keys: duplicateBranchKeys },
            writable_collection: "items",
            writable_path: branchPath,
            required_action: "make_true_acceptance_branch_keys_unique_or_choose_another_lossless_authoring_path",
            ...acceptanceBranchAuthoringAlternatives(
              itemIndex,
              item.key,
              item.table.table_key,
              [branchPath],
              "为每个真实分支保留唯一 key，同时保持其条件、要求、允许值和来源不变；",
            ),
          },
        });
      }
      const branchConditions = branches.flatMap((branch) => branch.condition_span_ids);
      const branchAllowedValues = branches.flatMap((branch) => branch.allowed_value_span_ids);
      if (!sameSet([...new Set(branchConditions)], [...new Set(properties.condition_span_ids)])) {
        const branchSet = new Set(branchConditions);
        const tableSet = new Set(properties.condition_span_ids);
        issues.push({
          code: "selector_acceptance_branch_condition_coverage",
          path: branchPath,
          message: "验收分支必须完整且仅覆盖当前验收项的权威表格条件来源区间。",
          details: {
            branch_condition_span_ids: [...branchSet],
            table_condition_span_ids: properties.condition_span_ids,
            missing_from_branches: [...tableSet].filter(id => !branchSet.has(id)),
            extra_in_branches: [...branchSet].filter(id => !tableSet.has(id)),
            required_action: "make_branch_condition_span_union_equal_table_condition_span_ids_or_split_independent_rows_into_items",
            ...acceptanceBranchAuthoringAlternatives(
              itemIndex,
              item.key,
              item.table.table_key,
              [branchPath, `/items/${itemIndex}/table/properties/condition_span_ids`],
              "让分支条件来源与当前 table condition 来源完整对应，并保留每个真实分支的条件—要求—允许值关系；",
            ),
          },
        });
      }
      if (!sameSet([...new Set(branchAllowedValues)], [...new Set(properties.allowed_value_span_ids)])) {
        const branchSet = new Set(branchAllowedValues);
        const tableSet = new Set(properties.allowed_value_span_ids);
        issues.push({
          code: "selector_acceptance_branch_allowed_value_coverage",
          path: branchPath,
          message: "Acceptance branches must cover exactly the item's authoritative table allowed-value spans",
          details: {
            branch_allowed_value_span_ids: [...branchSet],
            table_allowed_value_span_ids: properties.allowed_value_span_ids,
            missing_from_branches: [...tableSet].filter(id => !branchSet.has(id)),
            extra_in_branches: [...branchSet].filter(id => !tableSet.has(id)),
            required_action: "make_branch_allowed_value_span_union_equal_table_allowed_value_span_ids_or_split_independent_rows_into_items",
            ...acceptanceBranchAuthoringAlternatives(
              itemIndex,
              item.key,
              item.table.table_key,
              [branchPath, `/items/${itemIndex}/table/properties/allowed_value_span_ids`],
              "让分支允许值来源与当前 table allowed-value 来源完整对应，并保留每个真实分支的条件—要求—允许值关系；",
            ),
          },
        });
      }
      const noteIds = new Set(item.fields.note.span_ids);
      branches.forEach((branch, branchIndex) => {
        const path = `${branchPath}/${branchIndex}`;
        const missingMembers = [...branch.condition_span_ids, ...branch.allowed_value_span_ids]
          .filter((spanId) => !covers(branch.requirement_span_ids, spanId));
        if (missingMembers.length) {
          issues.push({
            code: "selector_acceptance_branch_requirement_incomplete",
            path: `${path}/requirement_span_ids`,
            message: "本分支要求未完整覆盖你已选择的条件或允许值原文区间。",
            details: {
              actual: { item_key: item.key, branch_key: branch.key, uncovered_spans: describeSpans(unique(missingMembers)), selected_requirement_spans: describeSpans(branch.requirement_span_ids) },
              writable_collection: "items", writable_path: `${path}/requirement_span_ids`,
              required_action: "complete_true_acceptance_branch_requirement_or_reclassify_misclassified_content",
              ...acceptanceBranchAuthoringAlternatives(
                itemIndex,
                item.key,
                item.table!.table_key,
                [`${path}/requirement_span_ids`],
                "在该分支 requirement_span_ids 补齐缺少的同源条件、判据和允许值区间；",
              ),
            },
          });
        }
        const hiddenRequirementIds = branch.requirement_span_ids.filter((spanId) => !covers(item.fields.requirement.span_ids, spanId));
        if (hiddenRequirementIds.length) {
          issues.push({
            code: "selector_acceptance_branch_requirement_not_visible",
            path: `/items/${itemIndex}/fields/requirement/span_ids`,
            message: "本项可见 requirement 未完整覆盖你已选择的分支要求原文区间。",
            details: {
              actual: { item_key: item.key, branch_key: branch.key, uncovered_spans: describeSpans(hiddenRequirementIds), selected_requirement_spans: describeSpans(item.fields.requirement.span_ids) },
              writable_collection: "items", writable_path: `/items/${itemIndex}/fields/requirement/span_ids`,
              required_action: "make_true_acceptance_branch_requirement_visible_or_reclassify_misclassified_content",
              ...acceptanceBranchAuthoringAlternatives(
                itemIndex,
                item.key,
                item.table!.table_key,
                [`/items/${itemIndex}/fields/requirement/span_ids`, path],
                "在 fields.requirement.span_ids 完整呈现该分支实际要求，且同源整段已经覆盖时不重复追加子 span；",
              ),
            },
          });
        }
        const noteMisuse = [...branch.condition_span_ids, ...branch.allowed_value_span_ids]
          .filter((spanId) => noteIds.has(spanId));
          if (noteMisuse.length) {
            issues.push({
              code: "selector_acceptance_branch_note_misuse",
              path: `/items/${itemIndex}/fields/note/span_ids`,
              message: "A condition or allowed value that selects an acceptance branch belongs in requirement/table semantics, not note",
              details: {
                offending_span_ids: [...new Set(noteMisuse)],
                actual: { item_key: item.key, branch_key: branch.key, offending_spans: describeSpans(unique(noteMisuse)) },
                writable_collection: "items",
                writable_path: `/items/${itemIndex}/fields/note/span_ids`,
                required_action: "remove_duplicate_note_role_or_reclassify_content_without_discarding_source_facts",
                ...acceptanceBranchAuthoringAlternatives(
                  itemIndex,
                  item.key,
                  item.table!.table_key,
                  [`/items/${itemIndex}/fields/note/span_ids`, path],
                  "保留真实分支的条件、要求和允许值来源，并从 note 中移除重复的分支角色绑定；",
                ),
              },
            });
          }
      });
      const conditionSignatures = branches.map((branch) => branch.condition_span_ids.map(spanText).join("\u0000"));
      if (new Set(conditionSignatures).size !== conditionSignatures.length) {
        const duplicateGroups = [...new Set(conditionSignatures)].flatMap(signature => {
          const indexes = conditionSignatures.flatMap((value, index) => value === signature ? [index] : []);
          return indexes.length > 1 ? [{
            condition_text: signature,
            branches: indexes.map(index => ({
              index,
              key: branches[index]!.key,
              condition_span_ids: branches[index]!.condition_span_ids,
              allowed_value_span_ids: branches[index]!.allowed_value_span_ids,
            })),
          }] : [];
        });
          issues.push({
            code: "selector_acceptance_branch_condition_duplicate",
            path: branchPath,
            message: "互斥的验收分支不得重复使用同一条件。",
            details: {
              duplicate_condition_groups: duplicateGroups,
              required_action: "add_the_missing_distinguishing_row_path_condition_or_split_independent_table_rows_into_separate_items",
              ...acceptanceBranchAuthoringAlternatives(
                itemIndex,
                item.key,
                item.table.table_key,
                [branchPath, `/items/${itemIndex}/table/properties/condition_span_ids`],
                "让每个真实分支保留足以区分其适用情形的条件来源，并保持条件—要求—允许值配对完整；",
              ),
            },
          });
      }
    }

  });
}

export interface TableExpansionRowObligation {
  row_id: string;
  evidence_id: string;
  locator: string;
  table_id: string;
  parent_property: string;
  row_path: string[];
  applicability_or_condition: string[];
  allowed_value: string;
  unit: string;
  method: string;
  disposition: "pending" | "item" | "branch" | "context" | "not_applicable";
  item_keys: string[];
}

export interface TableExpansionWorkPackage {
  obligation_id: string;
  table_id: string;
  row_count: number;
  candidate_core_property_groups: Array<{ core_property: string; row_ids: string[] }>;
  rows: TableExpansionRowObligation[];
}

function tableRowMatrix(record: EvidenceManifest["evidence"][number]): Omit<TableExpansionRowObligation, "disposition" | "item_keys"> {
  const cells = record.cells ?? [];
  const columns = record.columns ?? [];
  const valueIndex = columns.findIndex(column => /允许|偏差|限值|规定值|数值/u.test(column));
  const methodIndex = columns.findIndex(column => /方法/u.test(column));
  // Administrative form headers (e.g. construction organization) are not measurement units.
  const unitIndex = columns.findIndex(column => /^(?:计量)?单位(?:[（(][^()（）]*[）)])?$/u.test(column.replace(/\s+/gu, "")));
  const boundaryIndexes = [valueIndex, methodIndex, unitIndex].filter(index => index >= 0);
  const semanticEnd = boundaryIndexes.length ? Math.min(...boundaryIndexes) : cells.length;
  const rowPath = cells.slice(0, semanticEnd).filter(Boolean)
    .filter((value, index, values) => index === 0 || value !== values[index - 1]);
  return {
    row_id: `table-row-obligation:${sha256Text(`${record.evidence_id}\0${record.locator}`)}`,
    evidence_id: record.evidence_id,
    locator: record.locator,
    table_id: record.table_id ?? "",
    parent_property: rowPath[0] ?? record.text,
    row_path: rowPath,
    applicability_or_condition: rowPath.slice(1),
    allowed_value: valueIndex >= 0 ? cells[valueIndex] ?? "" : "",
    unit: unitIndex >= 0 ? cells[unitIndex] ?? "" : "",
    method: methodIndex >= 0 ? cells[methodIndex] ?? "" : "",
  };
}

function selectorItemSpanIds(item: TargetSelectorPlan["items"][number]): string[] {
  return [...new Set([
    ...item.criterion_span_ids,
    ...item.continuation_span_ids,
    ...item.inspection_data_type_span_ids,
    ...Object.values(item.fields).flatMap(field => field.span_ids),
    // Shared units retain provenance but do not by themselves own the source row's inspection property.
    ...(item.table ? Object.entries(item.table.properties)
      .filter(([property]) => property !== "unit_span_ids")
      .map(([, value]) => value).flat(3).filter((value): value is string => typeof value === "string") : []),
    ...(item.table?.properties.acceptance_branches ?? []).flatMap(branch => [
      ...branch.condition_span_ids, ...branch.requirement_span_ids, ...branch.allowed_value_span_ids,
    ]),
    ...(item.sampling.status === "explicit"
      ? [...item.sampling.condition_span_ids, ...item.sampling.quantity_span_ids, ...item.sampling.script_span_ids]
      : []),
  ])];
}

export function tableExpansionState(
  manifest: EvidenceManifest,
  registry?: SourceSpanRegistry,
  selectors?: TargetSelectorPlan,
  tableStructure?: TableStructurePlan,
  eligibleEvidenceIds?: ReadonlySet<string>,
): { work_packages: TableExpansionWorkPackage[]; issues: TargetSelectorIssue[] } {
  const confirmedDataRows = new Set((tableStructure?.tables ?? [])
    .filter((table) => table.status === "confirmed")
    .flatMap((table) => table.data_rows));
  const confirmedStructuralRows = new Set((tableStructure?.tables ?? [])
    .filter((table) => table.status === "confirmed")
    .flatMap((table) => [
      ...table.header_rows,
      ...table.repeated_header_rows,
      ...table.note_rows,
      ...table.context_rows,
    ]));
  const rows = manifest.evidence.filter(record => record.evidence_scope === "primary"
    && record.table_id && (record.cells?.length ?? 0) > 0
    && (!eligibleEvidenceIds || eligibleEvidenceIds.has(record.evidence_id))
    && (confirmedDataRows.has(record.evidence_id)
      || (!confirmedStructuralRows.has(record.evidence_id) && record.table_row_kind === "data")));
  const spanById = new Map(registry?.spans.map(span => [span.span_id, span]) ?? []);
  const itemEvidence = new Map((selectors?.items ?? []).map(item => [item.key, new Set(
    selectorItemSpanIds(item).flatMap(spanId => {
      const span = spanById.get(spanId);
      return span ? [span.evidence_id] : [];
    }),
  )]));
  const sourceDispositionByEvidence = new Map<string, "context" | "not_applicable">();
  for (const disposition of selectors?.source_dispositions ?? []) {
    for (const spanId of disposition.span_ids) {
      const span = spanById.get(spanId);
      if (span) sourceDispositionByEvidence.set(span.evidence_id,
        disposition.disposition === "ignored" ? "not_applicable" : "context");
    }
  }
  const branchEvidenceByItem = new Map((selectors?.items ?? []).map(item => [item.key, new Set(
    (item.table?.properties.acceptance_branches ?? []).flatMap(branch => [
      ...branch.condition_span_ids, ...branch.requirement_span_ids, ...branch.allowed_value_span_ids,
    ]).flatMap(spanId => {
      const span = spanById.get(spanId); return span ? [span.evidence_id] : [];
    }),
  )]));
  const workPackages = [...new Set(rows.map(row => row.table_id!))].map(tableId => {
    const matrix = rows.filter(row => row.table_id === tableId).map(row => {
      const owners = [...itemEvidence].filter(([, evidenceIds]) => evidenceIds.has(row.evidence_id)).map(([itemKey]) => itemKey);
      const branchOwners = owners.filter(itemKey => branchEvidenceByItem.get(itemKey)?.has(row.evidence_id));
      return {
        ...tableRowMatrix(row),
        disposition: sourceDispositionByEvidence.get(row.evidence_id)
          ?? (branchOwners.length ? "branch" as const
          : owners.length ? "item" as const
          : "pending" as const),
        item_keys: owners,
      };
    });
    const byCore = new Map<string, string[]>();
    for (const row of matrix) byCore.set(row.parent_property, [...(byCore.get(row.parent_property) ?? []), row.row_id]);
    return {
      obligation_id: `table-expansion:${sha256Text(eligibleEvidenceIds
        ? `${tableId}\0${matrix.map((row) => row.row_id).sort().join("\0")}`
        : `${manifest.evidence_fingerprint}\0${tableId}`)}`,
      table_id: tableId,
      row_count: matrix.length,
      candidate_core_property_groups: [...byCore].map(([core_property, row_ids]) => ({ core_property, row_ids })),
      rows: matrix,
    };
  });
  const issues: TargetSelectorIssue[] = [];
  for (const workPackage of workPackages) {
    const pending = workPackage.rows.filter(row => row.disposition === "pending");
    if (pending.length) issues.push({
      code: "selector_table_expansion_obligations_pending",
      path: "/items",
      message: "多行表格仍有未处置语义行；program_prefill 的条款壳不能代替逐行展开。",
      details: {
        table_id: workPackage.table_id,
        // 大表的完整行矩阵可达数十 KB，整包内联会撑爆单工具响应预算
        // （实测 143KB 触发 modeling 预算终止，会话被掐）。回条只留样例与
        // 紧凑 id 清单；逐行数据走 read_table_rows / read_table_summary。
        unresolved_row_count: pending.length,
        unresolved_rows: pending.slice(0, 3),
        unresolved_rows_reported_count: Math.min(pending.length, 3),
        unresolved_rows_complete: pending.length <= 3,
        pending_evidence_ids: pending.map((row) => row.evidence_id),
        candidate_core_property_groups: workPackage.candidate_core_property_groups,
        current_item_groups: (selectors?.items ?? []).filter(item => workPackage.rows.some(row => row.item_keys.includes(item.key))).slice(0, 10).map(item => ({ key: item.key, name: item.name })),
        current_item_groups_role: "existing_source_receivers_for_navigation_not_suggested_repair_targets",
        writable_paths: ["/items", "/source_dispositions"],
        writable_collections: ["items", "source_dispositions"],
        required_action: "map_each_row_to_an_item_or_same_core_property_branch_or_explicit_context",
        candidate_read_tool: "open_evidence",
        candidate_read_tools: ["open_evidence", "read_target_selectors", "list_table_fragments", "read_table_summary", "read_table_rows", "locate_evidence_span"],
        next_tool: "open_evidence",
        next_tool_arguments: { evidence_id: pending[0]!.evidence_id, cursor: 0 },
        next_tools: ["open_evidence", "read_target_selectors", "list_table_fragments", "read_table_summary", "read_table_rows", "locate_evidence_span", "stage_target_selector_draft"],
        save_tool: "stage_target_selector_draft",
        save_tool_instruction: "读取现有相关 item 的完整记录后，只用 operation=upsert 和 draft.items 或 draft.source_dispositions 保存经原文核实的完整记录；新增真实 item 时也须填写完整来源与 typed table。writable_paths 是诊断元数据，不是工具参数。",
        how_to_pass: "unresolved_rows 是有界样例，unresolved_rows_complete=false 时不是完整待办；pending_evidence_ids 才是本条诊断的完整未处置来源清单。先按 next_tool_arguments 打开首个待办，再按 pending_evidence_ids 逐行核对；用 list_table_fragments 的 table_expansion_work_packages.rows 按精确 evidence_id 查看当前 disposition/item_keys，并找到实际 table_key，按需用 read_table_summary/read_table_rows 核对原文表头、条件、单位及方法。current_item_groups 仅是已写入来源的作者记录导航，不是待修项或建议接收者，也不证明严格校验通过；不要把已承载行误当缺行或按相似名字猜记录。用 read_target_selectors 读取你依据原文判断的真实接收项。独立检查属性写入真实 item；同一属性条件分支写入该 item 的 typed table；确属非验收上下文或不适用时才保存有依据的 source_dispositions。每确认一条完整真实作者记录就增量暂存，不等整个反馈组完成才保存；调查笔记不代替作者记录。按原上限在实质修复后重检，不得遗漏、虚构或把整表合成一个项目。",
        do_not_edit: "不可变表格原文、编译产物、与待处理行无关且已正确的 item。",
      },
    });
    const owners = new Map<string, TableExpansionRowObligation[]>();
    for (const row of workPackage.rows) for (const itemKey of row.item_keys) owners.set(itemKey, [...(owners.get(itemKey) ?? []), row]);
    for (const [itemKey, ownedRows] of owners) {
      const coreProperties = [...new Set(ownedRows.map(row => row.parent_property))];
      if (coreProperties.length <= 1) continue;
      const itemIndex = selectors?.items.findIndex(item => item.key === itemKey) ?? -1;
      issues.push({
        code: "selector_table_distinct_core_properties_merged",
        path: itemIndex >= 0 ? `/items/${itemIndex}` : "/items",
        message: "一个 item 合并了多个独立检查属性。acceptance_branches 只允许同一核心属性的互斥条件，不能把整张表包装成一个项目。",
        details: {
          table_id: workPackage.table_id,
          item_key: itemKey,
          core_properties: coreProperties,
          readable_row_matrix: ownedRows,
          candidate_core_property_groups: workPackage.candidate_core_property_groups,
          writable_paths: ["/items", itemIndex >= 0 ? `/items/${itemIndex}/table/properties/acceptance_branches` : "/items"],
          required_action: "split_distinct_core_properties_into_items_or_keep_only_one_core_property_with_complete_branches",
        },
      });
    }
  }
  return { work_packages: workPackages, issues };
}

export function compileTargetSelectors(
  rawSelectors: TargetSelectorPlan | unknown,
  registry: SourceSpanRegistry,
  manifest: EvidenceManifest,
  options: {
    acceptedSourceLanguageReviews?: readonly { item_key: string; name: string }[];
    acceptedVerdictNameReviews?: readonly { item_key: string; name: string }[];
    tableStructurePlan?: TableStructurePlan;
    eligibleTableEvidenceIds?: ReadonlySet<string>;
    confirmedTableRowRoles?: boolean;
    /** Heuristic business observations are for the author, never compiler errors. */
    onModelReview?: (issues: TargetSelectorIssue[]) => void;
    /** Historical compiler contexts retain their original contract when absent. */
    validationBoundary?: ValidationBoundary;
  } = {},
): PersistedSemanticSourcePlan {
  const migration = migrateTargetSelectorPlanForAuthoring(rawSelectors);
  const authoredSelectors = migration.plan;
  const shapeIssues = validateShape(authoredSelectors);
  if (shapeIssues.length) throw new TargetSelectorCompileError([...migration.issues, ...shapeIssues]);
  const selectors = projectReferencedTableDestinations(
    withAutomaticReferencePlaceholderTargets(authoredSelectors, registry, manifest),
  ).plan;
  const issues = [...migration.issues];
  issues.push(...tableExpansionState(
    manifest,
    registry,
    selectors,
    options.tableStructurePlan,
    options.eligibleTableEvidenceIds,
  ).issues);
  const acceptedSourceLanguageReviews = new Set(
    (options.acceptedSourceLanguageReviews ?? []).map((entry) => `${entry.item_key}\0${entry.name}`),
  );
  const acceptedVerdictNameReviews = new Set(
    (options.acceptedVerdictNameReviews ?? []).map((entry) => `${entry.item_key}\0${entry.name}`),
  );
  if (selectors.schema_version !== TARGET_SELECTOR_PLAN_SCHEMA_VERSION) issues.push({ code: "selector_schema", path: "/schema_version", message: `Expected ${TARGET_SELECTOR_PLAN_SCHEMA_VERSION}` });
  if (selectors.job_id !== manifest.job_id) issues.push({ code: "selector_job_mismatch", path: "/job_id", message: "job_id does not match immutable evidence" });
  if (selectors.target_id !== manifest.target_id) issues.push({ code: "selector_target_mismatch", path: "/target_id", message: "target_id does not match immutable evidence" });
  const allKeys = [
    ["lot", selectors.lots.map((entry) => entry.key)],
    ["item", selectors.items.map((entry) => entry.key)],
    ["sampling_rule", selectors.sampling_rules.map((entry) => entry.key)],
    ["reference", selectors.references.map((entry) => entry.key)],
  ] as const;
  for (const [kind, keys] of allKeys) {
    const duplicates = duplicateKeys(keys);
    if (duplicates.length) issues.push({ code: `selector_duplicate_${kind}_key`, path: `/${kind}`, message: `${kind} keys must be unique`, details: duplicates });
  }
  issues.push(...proseDuplicatePayloadIssues(authoredSelectors));
  issues.push(...targetSelectorReferenceCycleIssues(selectors, registry));
  issues.push(...independentItemMergeIssues(selectors, registry, manifest));
  issues.push(...registeredDocumentReferenceReceiptIssues(selectors, manifest, registry));
  const selectedSamplingRuleKeys = new Set(selectors.items.flatMap((item) =>
    (item.sampling.status === "reference" || item.sampling.status === "reference_unspecified_quantity")
      && item.sampling.rule_key ? [item.sampling.rule_key] : []
  ));
  selectors.sampling_rules.forEach((rule, ruleIndex) => {
    if (!selectedSamplingRuleKeys.has(rule.key)) {
      const rulePath = `/sampling_rules/${ruleIndex}`;
      issues.push({
        code: "selector_sampling_rule_unreferenced",
        path: rulePath,
        message: "已声明的共享抽样规则没有被任何真实验收项选择。只有实际适用于验收项的共享规则才能保留；否则应删除该未使用规则，并把仍需保留的原文作为相应的引用或条件证据处理。",
        details: {
          rule_key: rule.key,
          required_action: "select_the_rule_from_each_semantic_receiver_or_remove_the_unused_rule",
          receiver_contract: "至少一个真实验收项选择该规则即可；带条件的多分支规则不得因此拆成多个验收项。",
          allowed_actions: [
            "确认该规则不应保留时，按 rule_key 删除未使用的 sampling_rules 记录。",
            "确认该规则确实适用于现有真实验收项时，由模型依据原文选择接收项，并修改该 item 的 sampling 以选择当前 rule_key 及实际适用的 branch_keys。",
          ],
          writable_paths: [rulePath, "/items"],
          writable_collections: ["sampling_rules", "items"],
          candidate_read_tool: "read_target_selectors",
          candidate_read_tools: ["read_target_selectors"],
          next_tool: "read_target_selectors",
          next_tools: ["read_target_selectors", "stage_target_selector_draft"],
          save_tool: "stage_target_selector_draft",
          how_to_pass: "先用 read_target_selectors 分别读取 sampling_rules 中当前 rule_key 的完整记录和 items 候选，再二选一完成修复：一是调用 stage_target_selector_draft，以 collection=sampling_rules、remove_keys=[当前 rule_key] 删除确认不应保留的规则；二是由你根据原文判断现有哪个真实 item 接收该规则，并只修改该 item.sampling，选择当前 rule_key 和实际适用的 branch_keys。不要为消错新建接收项、改写验收判据或让 harness 替你指定接收者。保存后重新执行原验证。",
          do_not_edit: "不可变原文、编译产物、已正确的验收判据；不要仅为消错新增验收项。",
        },
      });
    }
    const duplicateSharedComponentKeys = duplicateKeys(rule.components.map((component) => component.key));
    if (duplicateSharedComponentKeys.length > 0) {
      issues.push({
        code: "selector_sampling_component_duplicate",
        path: `/sampling_rules/${ruleIndex}/components`,
        message: "Shared sampling component keys must be unique within one rule",
        details: { duplicate_component_keys: duplicateSharedComponentKeys },
      });
    }
    rule.branches.forEach((branch, branchIndex) => {
      const duplicateLocalComponentKeys = duplicateKeys(branch.components.map((component) => component.key));
      if (duplicateLocalComponentKeys.length > 0) {
        issues.push({
          code: "selector_sampling_component_duplicate",
          path: `/sampling_rules/${ruleIndex}/branches/${branchIndex}/components`,
          message: "Branch-local sampling component keys must be unique within one branch",
          details: { duplicate_component_keys: duplicateLocalComponentKeys },
        });
      }
      if (!migration.migrated) {
        const declaredRoles = new Set([
          ...rule.components.map((component) => component.role),
          ...branch.components.map((component) => component.role),
        ]);
        const missingRoles = SAMPLING_COMPONENT_ROLES.filter((role) => !declaredRoles.has(role));
        if (missingRoles.length > 0) {
          issues.push({
            code: "selector_sampling_component_required",
            path: `/sampling_rules/${ruleIndex}/branches/${branchIndex}/components`,
            message: "Every sampling branch must explicitly disposition each typed component role using shared or branch-local components",
            details: {
              missing_roles: missingRoles,
              allowed_locations: [
                `/sampling_rules/${ruleIndex}/components`,
                `/sampling_rules/${ruleIndex}/branches/${branchIndex}/components`,
              ],
              required_action: "add_explicit_component_dispositions",
            },
          });
        }
      }
      const selectedByUnspecifiedQuantityItem = selectors.items.some((item) =>
        item.sampling.status === "reference_unspecified_quantity"
        && item.sampling.rule_key === rule.key
        && item.sampling.branch_keys.includes(branch.key)
      );
      const selectedByQuantityBearingItem = selectors.items.some((item) =>
        item.sampling.status === "reference"
        && item.sampling.rule_key === rule.key
        && item.sampling.branch_keys.includes(branch.key)
      );
      if (
        samplingComponentSpanIds(effectiveSamplingComponents(rule, branch), "quantity").length === 0
        && (!selectedByUnspecifiedQuantityItem || selectedByQuantityBearingItem)
      ) {
        issues.push(samplingBranchQuantityMissingIssue(rule, branch, ruleIndex, branchIndex));
      }
    });
  });
  selectors.items.forEach((item, itemIndex) => {
    if (item.criterion_span_ids.length === 0) {
      issues.push({
        code: "selector_item_semantic_node_required",
        path: `/items/${itemIndex}/criterion_span_ids`,
        message: "Every final item must bind at least one criterion span so preflight can create its acceptance_item or table_criterion semantic node. A pure reference parent must be removed from items and retained only as reference_placeholder.",
        details: {
          item_key: item.key,
          required_action: "bind_a_real_acceptance_criterion_or_remove_this_non_item_and_keep_its_reference_placeholder",
        },
      });
    }
    if (item.table && item.table.properties.allowed_value_span_ids.length === 0) {
      issues.push({
        code: "selector_table_allowed_value_missing",
        path: `/items/${itemIndex}/table/properties/allowed_value_span_ids`,
        message: "A selected table criterion must bind at least one exact allowed-value span; compiler never infers a business cell from table shape",
      });
    }
    if (item.table?.source_kind === "reference" && item.table.reference_span_ids.length === 0) {
      issues.push({
        code: "selector_table_reference_anchor_missing",
        path: `/items/${itemIndex}/table/reference_span_ids`,
        message: "A referenced table criterion must bind the exact in-scope clause that invokes the referenced table",
      });
    }
    if (
      item.table?.source_kind === "reference"
      && item.table.properties.row_path_span_ids.length === 0
      && item.table.properties.column_path_span_ids.length === 0
    ) {
      issues.push({
        code: "selector_reference_table_entry_path_required",
        path: `/items/${itemIndex}/table/properties`,
        message: "A referenced table criterion must identify an actual row or column entry; a table number or caption alone is not an acceptance item",
        details: {
          required_action: "locate_and_bind_each_applicable_table_entry_then_create_one_item_per_independent_judgment",
          required_properties: ["row_path_span_ids", "column_path_span_ids"],
          preserve_properties: ["table_no_span_ids", "table_title_span_ids", "reference_span_ids"],
        },
      });
    }
  });
  const registeredReferenceSpansById = new Map(registry.spans.map((span) => [span.span_id, span]));
  const evidenceRecordsById = new Map(manifest.evidence.map((record) => [record.evidence_id, record]));
  const selectorSpanById = new Map(registry.spans.map((span) => [span.span_id, span]));
  const realItemCoverageSpansByKey = new Map(selectors.items
    .filter((item) => item.criterion_span_ids.length > 0)
    .map((item) => {
      const spanIds = new Set<string>();
      const visit = (value: unknown, key = ""): void => {
        if (Array.isArray(value)) {
          if (key === "span_ids" || key.endsWith("_span_ids")) {
            value.flat(Infinity).forEach((entry) => {
              if (typeof entry === "string") spanIds.add(entry);
            });
          } else {
            value.forEach((entry) => visit(entry));
          }
          return;
        }
        if (!value || typeof value !== "object") return;
        Object.entries(value as Record<string, unknown>).forEach(([childKey, child]) => visit(child, childKey));
      };
      visit(item);
      const spans = [...spanIds].flatMap((spanId) => {
        const span = selectorSpanById.get(spanId);
        return span ? [span] : [];
      });
      return [item.key, spans] as const;
    }));
  // Coverage may include the sampling components the item actually receives.
  // Keep this separate from direct item ownership used to authorize table routes.
  const effectiveItemCoverageSpansByKey = new Map(selectors.items
    .filter(item => realItemCoverageSpansByKey.has(item.key))
    .map(item => {
      const direct = realItemCoverageSpansByKey.get(item.key)!;
      return [item.key, [...direct, ...receivedSamplingSourceSpanIds(selectors, item).flatMap(id => selectorSpanById.get(id) ?? [])]] as const;
    }));
  const realItemCoverageSpans = [...effectiveItemCoverageSpansByKey.values()].flat();
  const receivedSamplingEvidenceIds = new Set(selectors.items
    .filter(item => realItemCoverageSpansByKey.has(item.key))
    .flatMap(item => receivedSamplingSourceSpanIds(selectors, item)
      .flatMap(id => selectorSpanById.get(id)?.evidence_id ?? [])));
  issues.push(...resolvedReferenceComponentCoverageIssues(selectors, manifest, registry, effectiveItemCoverageSpansByKey));
  const coveredByRealItems = (target: SourceSpanRegistry["spans"][number]): boolean =>
    coveredBySpans(target, realItemCoverageSpans);
  const nonItemSpans = nonItemReferenceSpans(selectors, registry);
  const coveredByNonItems = (target: { evidence_id: string; start: number; end: number }): boolean =>
    coveredBySpans(target, nonItemSpans);
  const nonItemEvidenceCovered = (evidenceId: string): boolean => {
    const record = evidenceRecordsById.get(evidenceId);
    return Boolean(record && coveredByNonItems({ evidence_id: evidenceId, start: 0, end: record.text.length }));
  };
  selectors.items.forEach((item, itemIndex) => {
    if (item.table) return;
    const triggeringSourceBindings = (["criterion_span_ids", "continuation_span_ids"] as const).flatMap(role =>
      item[role].flatMap((spanId, spanIndex) => {
        const span = selectorSpanById.get(spanId);
        const record = span ? evidenceRecordsById.get(span.evidence_id) : undefined;
        return span && record?.kind === "table_row" && record.table_row_kind === "data"
          ? [{ path: `/items/${itemIndex}/${role}/${spanIndex}`, span_id: spanId, evidence_id: record.evidence_id,
            start: span.start, end: span.end, text: record.text.slice(span.start, span.end) }]
          : [];
      }),
    );
    const tableRowEvidenceIds = unique(triggeringSourceBindings.map(binding => binding.evidence_id));
    if (tableRowEvidenceIds.length === 0) return;
    issues.push({
      code: "selector_table_block_required_for_table_origin_items",
      path: `/items/${itemIndex}/table`,
      message: "该 item 把正式表格数据行绑定在 criterion_span_ids/continuation_span_ids 中。若这些来源确属验收判据，必须填写带精确角色来源的 typed table 块：当前范围内表格使用 source_kind=direct，被引表格使用 source_kind=reference，并绑定本地引用锚点 reference_span_ids 及实际目标行或列入口。若原文属于其他语义角色，须修正误分类的判据绑定并用现有对应契约保留事实，不能只删除 table。",
      details: {
        item_key: item.key,
        table_row_evidence_ids: tableRowEvidenceIds,
        actual: { item_key: item.key, table: item.table, triggering_source_bindings: triggeringSourceBindings },
        required_action: "author_typed_table_block_or_reclassify_non_criterion_sources",
        candidate_read_tool: "read_target_selectors",
        candidate_read_tools: [
          "read_target_selectors",
          "list_table_fragments",
          "read_table_summary",
          "read_table_rows",
          "open_evidence",
          "locate_evidence_span",
        ],
        next_tool: "read_target_selectors",
        next_tool_arguments: { collection: "items", key: item.key },
        next_tools: [
          "read_target_selectors",
          "list_table_fragments",
          "read_table_summary",
          "read_table_rows",
          "open_evidence",
          "locate_evidence_span",
          "stage_target_selector_draft",
        ],
        writable_path: `/items/${itemIndex}/table`,
        writable_paths: [`/items/${itemIndex}/table`, `/items/${itemIndex}/criterion_span_ids`, `/items/${itemIndex}/continuation_span_ids`,
          `/items/${itemIndex}/fields/method`, `/items/${itemIndex}/sampling`, "/sampling_rules", "/source_dispositions"],
        writable_collections: ["items", "sampling_rules", "source_dispositions"],
        tool_argument_hints: {
          read_target_selectors: { collection: "items", key: item.key },
          list_table_fragments: { cursor: 0, limit: 100 },
          read_table_summary: { table_key: "复制 list_table_fragments 返回的逻辑表 table_key" },
          read_table_rows: { table_key: "复制 read_table_summary 返回的 table_key", cursor: 0, limit: 50 },
          open_evidence: { evidence_id: "来自 table_row_evidence_ids 或已读表格行的 evidence_id", cursor: 0 },
          locate_evidence_span: {
            evidence_id: "来自已打开原文的 evidence_id",
            quote: "仅填写已打开原文中由模型选择的精确子串",
            prefix: "可选",
            suffix: "可选",
          },
        },
        save_tool: "stage_target_selector_draft",
        save_tool_instruction: "先读取完整记录，保留未点名的正确字段；修改后以 operation=upsert、draft.items=[完整 item] 保存。sampling_rules 或 source_dispositions 的修改同样提交对应完整记录。writable_paths 是定位元数据，不是保存工具参数。",
        how_to_pass: "先用 read_target_selectors（collection=items、key=当前 item_key）读取完整 item，按 actual.triggering_source_bindings 核对触发此检查的 criterion_span_ids/continuation_span_ids 及精确原文。再用 list_table_fragments、read_table_summary、read_table_rows 读取表格上下文；必要时按 evidence_id 用 open_evidence、locate_evidence_span 核对精确来源。由模型根据原文选择：若这些来源确属验收判据，保留判据绑定，在 item.table 按实际来源填写 source_kind 和精确角色 spans，被引表格还要保留本地 reference_span_ids；若属于抽样、方法或非项目上下文，则从 criterion_span_ids/continuation_span_ids 移出误分类来源，并以现有 item.sampling 与 sampling_rules、item.fields.method 或 source_dispositions 契约完整承载。只删除 table 而不修正误分类的判据绑定仍会触发本检查。真实判据不能删除或移入其他容器来规避 typed table；不得由 harness 决定角色或业务语义。按 save_tool_instruction 保存涉及的完整记录，再执行原验证。",
        do_not_edit: "不可变原文、编译产物及其他已正确的 item；真实表格验收判据不得用普通文字字段代替 typed table 绑定。",
      },
    });
  });
  const tableNavigationLinesByEvidenceId = new Map<string, HtmlTableNavigationLine[]>();
  const tableNavigationLinesFor = (evidenceId: string): HtmlTableNavigationLine[] => {
    const cached = tableNavigationLinesByEvidenceId.get(evidenceId);
    if (cached) return cached;
    const lines = htmlTableNavigationLines(evidenceRecordsById.get(evidenceId)?.text ?? "");
    tableNavigationLinesByEvidenceId.set(evidenceId, lines);
    return lines;
  };
  const occurrenceById = new Map(manifest.reference_occurrences.map((occurrence) => [occurrence.occurrence_id, occurrence]));
  const clauseReferenceEntries = selectors.references.flatMap((reference, referenceIndex) => {
    const occurrence = reference.occurrence_id ? occurrenceById.get(reference.occurrence_id) : undefined;
    return occurrence?.status === "resolved" && occurrence.reference_kind === "clause"
      ? [{ reference, referenceIndex, occurrence }]
      : [];
  });
  const clauseGroupsByOrigin = new Map<string, typeof clauseReferenceEntries>();
  for (const entry of clauseReferenceEntries) {
    const originKey = referenceOccurrenceOriginEvidenceIds(entry.occurrence).join("\0");
    const group = clauseGroupsByOrigin.get(originKey) ?? [];
    group.push(entry);
    clauseGroupsByOrigin.set(originKey, group);
  }
  for (const group of clauseGroupsByOrigin.values()) {
    if (group.length < 2) continue;
    const assignmentsByItem = new Map<string, Array<{
      decision: "independent_item" | "same_judgment" | "acceptance_branch" | "not_applicable";
      component_span_ids: string[];
      referenceIndex: number;
    }>>();
    for (const { reference, referenceIndex, occurrence } of group) {
      const dispositions = reference.component_dispositions ?? [];
      const requiredSpanIds = new Set(reference.target_span_ids);
      const dispositionCounts = new Map<string, number>();
      for (const [dispositionIndex, disposition] of dispositions.entries()) {
        const path = `/references/${referenceIndex}/component_dispositions/${dispositionIndex}`;
        disposition.component_span_ids.forEach((spanId) => {
          dispositionCounts.set(spanId, (dispositionCounts.get(spanId) ?? 0) + 1);
        });
        const invalidSpanIds = disposition.component_span_ids.filter((spanId) => !requiredSpanIds.has(spanId));
        if (invalidSpanIds.length > 0) {
          const componentSpanIdsPath = `${path}/component_span_ids`;
          issues.push({
            code: "selector_reference_component_outside_target",
            path: componentSpanIdsPath,
            message: "组件处置只能使用本 reference 已登记的 target_span_ids。",
            details: {
              required_action: "组件处置只能使用本 reference 已登记的 target_span_ids。",
              invalid_span_ids: invalidSpanIds,
              occurrence_id: occurrence.occurrence_id,
              actual: {
                reference_key: reference.key,
                occurrence_id: occurrence.occurrence_id,
                component_span_ids: disposition.component_span_ids,
                invalid_span_ids: invalidSpanIds,
                declared_target_span_ids: reference.target_span_ids,
              },
              allowed_actions: [
                "当前 component_span_ids 点错时，删除或替换不属于本 reference 的 span，只保留已登记 target spans。",
                "该 span 确实属于当前已解析 occurrence、只是 reference.target_span_ids 漏登时，先核对引用事实，再补全当前 reference 的 target_span_ids。",
              ],
              writable_paths: [componentSpanIdsPath, `/references/${referenceIndex}/target_span_ids`],
              candidate_read_tools: ["read_target_selectors", "list_reference_occurrences", "read_reference_facts"],
              next_tool: "read_target_selectors",
              next_tool_arguments: { collection: "references", key: reference.key },
              save_tool: "stage_target_selector_draft",
              how_to_pass: "先用 read_target_selectors 读取当前 reference，并通过 occurrence_id 核对引用事实。若 invalid_span_ids 不属于该 occurrence，从当前 component_span_ids 删除或替换它们；若确属当前 occurrence 但 target_span_ids 漏登，则只补全当前 reference.target_span_ids。不得把其他引用的 span 搬入本 reference，也不得修改不可变引用内容。用 stage_target_selector_draft 保存后重试验证。",
              do_not_edit: "不可变引用原文、编译产物、其他 references 和无关 component dispositions。",
            },
          });
        }
        if (disposition.decision === "not_applicable") {
          if (disposition.item_keys.length > 0) {
            issues.push({
              code: "selector_reference_component_not_applicable_has_item",
              path: `${path}/item_keys`,
              message: "not_applicable 组件不能同时映射到 item。",
            });
          }
          continue;
        }
        if (disposition.item_keys.length === 0) {
          issues.push({
            code: "selector_reference_component_item_required",
            path: `${path}/item_keys`,
            message: "被引组件选择 materialized decision 时必须映射到至少一个真实 item。",
          });
          continue;
        }
        const componentSpans = disposition.component_span_ids.flatMap((spanId) => {
          const span = selectorSpanById.get(spanId);
          return span ? [span] : [];
        });
        const itemSpans = disposition.item_keys.flatMap((itemKey) => effectiveItemCoverageSpansByKey.get(itemKey) ?? []);
        const unknownItemKeys = disposition.item_keys.filter((itemKey) => !realItemCoverageSpansByKey.has(itemKey));
        const uncoveredSpanIds = componentSpans
          .filter((span) => !coveredBySpans(span, itemSpans))
          .map((span) => span.span_id);
        if (unknownItemKeys.length > 0 || uncoveredSpanIds.length > 0) {
          const namedItemCoverage = disposition.item_keys.map((itemKey) => {
            const namedItemIndex = selectors.items.findIndex((item) => item.key === itemKey);
            return {
              item_key: itemKey,
              item_index: namedItemIndex >= 0 ? namedItemIndex : null,
              exists: namedItemIndex >= 0,
              coverage_span_ids: unique((effectiveItemCoverageSpansByKey.get(itemKey) ?? []).map((span) => span.span_id)),
            };
          });
          const namedItemProvenancePaths = namedItemCoverage.flatMap((entry) => entry.item_index === null ? [] : [
            `/items/${entry.item_index}/criterion_span_ids`,
            `/items/${entry.item_index}/continuation_span_ids`,
            `/items/${entry.item_index}/fields`,
            `/items/${entry.item_index}/table`,
            `/items/${entry.item_index}/sampling`,
          ]);
          const componentItemKeysPath = `${path}/item_keys`;
          // A partly covered range may have been selected too broadly. Offer
          // that authoring correction without changing coverage or choosing it
          // for the model. A missing/wrong-source receiver needs its own repair.
          const canReviewComponentRange = unknownItemKeys.length === 0 && componentSpans.some(component =>
            itemSpans.some(span => span.evidence_id === component.evidence_id
              && span.start < component.end && component.start < span.end));
          const componentRangeInstruction = canReviewComponentRange
            ? " 若核对原文确认组件范围选得过宽，可用 locate_evidence_span 定位实际采用的精确片段，由模型同步更正当前 component_span_ids 和 reference.target_span_ids，并保留其他正确处置。程序不自动缩小范围；原 occurrence 的其余组件仍须交代，不得删去仍适用的判据、条件、方法或数量来消错。"
            : "";
          issues.push({
            code: "selector_reference_component_item_mismatch",
            path: componentItemKeysPath,
            message: "组件处置点名的真实 item 必须用自身 provenance 完整覆盖这些 component spans。",
            details: {
              required_action: "组件处置点名的真实 item 必须用自身 provenance 完整覆盖这些 component spans。",
              unknown_item_keys: unknownItemKeys,
              uncovered_span_ids: uncoveredSpanIds,
              actual: {
                reference_key: reference.key,
                occurrence_id: occurrence.occurrence_id,
                disposition_index: dispositionIndex,
                decision: disposition.decision,
                component_span_ids: disposition.component_span_ids,
                item_keys: disposition.item_keys,
                unknown_item_keys: unknownItemKeys,
                uncovered_span_ids: uncoveredSpanIds,
                named_item_coverage: namedItemCoverage,
              },
              allowed_actions: [
                "当前 item_keys 点名错误时，只把 component disposition 改为实际由自身 provenance 覆盖这些 component spans 的真实 item；不要为了消错创建替代 item。",
                "若原文核实当前 item_keys 确实对应应接收这些 component spans 的真实 item，只在 /items 写入完整真实 item 及其 criterion、continuation、可见字段、typed table 或生效 sampling provenance；是否存在或需要创建该 item 由模型依据原文判断，harness 不决定。",
                ...(canReviewComponentRange ? [componentRangeInstruction.trim()] : []),
              ],
              writable_paths: [componentItemKeysPath,
                ...(canReviewComponentRange ? [`${path}/component_span_ids`, `/references/${referenceIndex}/target_span_ids`] : []),
                ...namedItemProvenancePaths, ...(unknownItemKeys.length ? ["/items"] : [])],
              writable_collections: ["references", "items"],
              candidate_read_tools: [
                "read_target_selectors",
                "list_reference_occurrences",
                "read_document_reference_evidence",
                "read_reference_facts",
                "open_evidence",
                "locate_evidence_span",
              ],
              next_tool: "read_target_selectors",
              next_tool_arguments: { collection: "references", key: reference.key },
              save_tool: "stage_target_selector_draft",
              next_tools: [
                "read_target_selectors",
                "list_reference_occurrences",
                "read_document_reference_evidence",
                "read_reference_facts",
                "open_evidence",
                "locate_evidence_span",
                "stage_target_selector_draft",
              ],
              tool_argument_hints: {
                read_target_selectors: [
                  { collection: "references", key: reference.key },
                  { collection: "items", key: "按 actual.item_keys 逐一读取；不存在的 key 不要臆造" },
                ],
                list_reference_occurrences: { cursor: 0, limit: 100, candidate_cursor: 0, candidate_limit: 25 },
                read_document_reference_evidence: { target_key: "从 list_reference_occurrences 返回的 inline target_key", cursor: 0, limit: 24 },
                read_reference_facts: { target_key: "从 list_reference_occurrences 返回的 isolated target_key", entry_ids: ["只填写模型确认需要核对的条目"] },
                open_evidence: { evidence_id: "来自 component_span_ids 或已读引用行的 evidence_id", cursor: 0 },
                locate_evidence_span: {
                  evidence_id: "来自已打开原文的 evidence_id",
                  quote: "仅填写已打开原文中由模型选择的精确子串",
                  prefix: "可选",
                  suffix: "可选",
                },
              },
              save_tool_instruction: "先用 read_target_selectors 读取并保留待修改的完整记录，只改 writable_paths 指定字段；以 operation=upsert 调用 stage_target_selector_draft，将修改后的完整记录按集合放入 draft.items 或 draft.references（两者可同次提交），保留未被点名的正确字段。writable_paths 是诊断元数据，不是工具参数。",
              how_to_pass: "先用 read_target_selectors 分别读取当前 reference（collection=references、key=当前 reference_key）和 actual.item_keys 中存在的 items（collection=items、key=真实 item_key）；不存在的 key 不要臆造。再用 list_reference_occurrences 按 occurrence_id 核对引用；inline 目标用 read_document_reference_evidence(target_key=...)，isolated 目标用 read_reference_facts(target_key=...)，必要时用 open_evidence(evidence_id=...) 查看不可变原文，并由模型依据原文选择精确区间。若 item_keys 点名错误，只修改当前 component disposition 的 item_keys，删除错误 key；若原文核实这些 item_keys 确实应接收 component spans，才在 /items 写入或补足完整真实 item provenance。不得替模型决定应创建哪些 item，不得虚构 item、span 或业务归属。最后用 stage_target_selector_draft 只保存 writable_paths 中列出的 references/items 路径并重试原验证。" + componentRangeInstruction,
              do_not_edit: "不可变引用原文、编译产物、其他 component dispositions 和未涉及的正确 items。",
            },
          });
        }
        if (disposition.decision === "independent_item" && disposition.item_keys.length !== 1) {
          const componentItemKeysPath = `${path}/item_keys`;
          const componentDecisionPath = `${path}/decision`;
          issues.push({
            code: "selector_reference_component_independent_item_count",
            path: componentItemKeysPath,
            message: "independent_item 组件必须只映射到一个独立真实 item。",
            details: {
              required_action: "verify_the_component_semantics_then_choose_one_real_independent_item_or_a_different_truthful_decision",
              actual: {
                reference_key: reference.key,
                occurrence_id: occurrence.occurrence_id,
                disposition_index: dispositionIndex,
                component_span_ids: disposition.component_span_ids,
                item_keys: disposition.item_keys,
                decision: disposition.decision,
              },
              allowed_actions: [
                "若原文核实这组 component spans 确实形成一个独立验收项，保留 independent_item，并将 item_keys 修正为唯一一个真实接收 item。",
                "若原文显示这些 component spans 不属于单个独立 item，才修改 decision，并同步修正 item_keys 以符合所选决策的真实接收关系。",
              ],
              writable_paths: [componentItemKeysPath, componentDecisionPath],
              writable_collections: ["references"],
              candidate_read_tools: [
                "read_target_selectors",
                "list_reference_occurrences",
                "read_document_reference_evidence",
                "read_reference_facts",
              ],
              next_tool: "read_target_selectors",
              next_tool_arguments: { collection: "references", key: reference.key },
              next_tools: [
                "read_target_selectors",
                "list_reference_occurrences",
                "read_document_reference_evidence",
                "read_reference_facts",
                "stage_target_selector_draft",
              ],
              tool_argument_hints: {
                read_target_selectors: [
                  { collection: "references", key: reference.key },
                  { collection: "items", key: "按 actual.item_keys 逐一读取已存在的真实 item；不存在的 key 不要臆造" },
                ],
                list_reference_occurrences: { cursor: 0, limit: 100 },
                read_document_reference_evidence: { target_key: "从 list_reference_occurrences 返回的 inline target_key", cursor: 0, limit: 24 },
                read_reference_facts: { target_key: "从 list_reference_occurrences 返回的 isolated target_key" },
              },
              save_tool_instruction: "先用 read_target_selectors 读取并保留当前完整 reference，只改 writable_paths 指定字段；用 operation=upsert、draft.references=[修改后的完整记录] 调用 stage_target_selector_draft，保留未被点名的正确字段。writable_paths 是诊断元数据，不是工具参数。",
              save_tool: "stage_target_selector_draft",
              how_to_pass: "先用 read_target_selectors 读取当前 reference，再读取 actual.item_keys 中已存在的完整 items；不存在的 key 不要臆造。用 list_reference_occurrences 按 occurrence_id 核对 analysis_mode 和 target_key：inline 目标用 read_document_reference_evidence 读取原文，isolated 目标先只传 target_key 调用 read_reference_facts 取得目录，再打开模型确认需要的条目。然后由模型仅依原文在 allowed_actions 中选择：保留 independent_item 时 item_keys 必须恰好一个真实 item；否则修正 decision 并同步修正 item_keys。回条不指定 decision 或 item，不创建替代 item。最后只用 stage_target_selector_draft 保存 writable_paths 并重试验证。",
              do_not_edit: "不可变引用原文、编译产物、component_span_ids、其他 component dispositions 或无关且已正确的 items。",
            },
          });
        }
        if (disposition.decision === "acceptance_branch") {
          const branchContractSummary = disposition.item_keys.map((itemKey) => {
            const itemIndex = selectors.items.findIndex((candidate) => candidate.key === itemKey);
            const item = itemIndex >= 0 ? selectors.items[itemIndex] : undefined;
            const branches = item?.table?.properties.acceptance_branches ?? [];
            return {
              item_key: itemKey,
              item_index: itemIndex >= 0 ? itemIndex : null,
              exists: itemIndex >= 0,
              table_present: item?.table !== null && item?.table !== undefined,
              acceptance_branch_count: branches.length,
              branch_keys: branches.map((branch) => branch.key),
              has_complete_acceptance_branches_contract: branches.length >= 2,
            };
          });
          const hasBranchContract = branchContractSummary.some((entry) => entry.has_complete_acceptance_branches_contract);
          if (!hasBranchContract) {
            const branchWritablePaths = branchContractSummary.flatMap((entry) => entry.item_index === null
              ? []
              : [
                `/items/${entry.item_index}/table`,
                `/items/${entry.item_index}/table/properties/acceptance_branches`,
              ]);
            const componentItemKeysPath = `${path}/item_keys`;
            issues.push({
              code: "selector_reference_component_branch_contract_required",
              path: `${path}/decision`,
              message: "acceptance_branch 组件必须映射到已有完整 acceptance_branches 合同的 item。",
              details: {
                actual: {
                  reference_key: reference.key,
                  occurrence_id: occurrence.occurrence_id,
                  disposition_index: dispositionIndex,
                  component_span_ids: disposition.component_span_ids,
                  decision: disposition.decision,
                  item_keys: disposition.item_keys,
                  branch_contract_summary: branchContractSummary,
                },
                allowed_actions: [
                  "若原文核实当前 item_key 或 decision 点错，只修改当前 component disposition 的 item_keys 或 decision，使其映射到实际接收这些 component spans 的既有真实 item；不得为了消错创建替代 item。",
                  "若原文核实当前 item_key 与 acceptance_branch decision 正确，只补齐该真实 item.table.properties.acceptance_branches 的完整 typed 分支及精确来源；分支数量、条件、允许值和接收 item 均由模型依据原文判断，harness 不决定。",
                ],
                writable_paths: [
                  componentItemKeysPath,
                  `${path}/decision`,
                  ...branchWritablePaths,
                  ...(branchContractSummary.some((entry) => entry.item_index === null) ? ["/items"] : []),
                ],
                writable_collections: ["references", "items"],
                candidate_read_tool: "read_target_selectors",
                candidate_read_tools: [
                  "read_target_selectors",
                  "list_reference_occurrences",
                  "read_document_reference_evidence",
                  "read_reference_facts",
                  "list_table_fragments",
                  "read_table_summary",
                  "read_table_rows",
                  "open_evidence",
                  "locate_evidence_span",
                ],
                next_tool: "read_target_selectors",
                next_tool_arguments: { collection: "references", key: reference.key },
                next_tools: [
                  "read_target_selectors",
                  "list_reference_occurrences",
                  "read_document_reference_evidence",
                  "read_reference_facts",
                  "list_table_fragments",
                  "read_table_summary",
                  "read_table_rows",
                  "open_evidence",
                  "locate_evidence_span",
                  "stage_target_selector_draft",
                ],
                tool_argument_hints: {
                  read_target_selectors: [
                    { collection: "references", key: reference.key },
                    { collection: "items", key: "按 actual.item_keys 逐一读取；不存在的 key 不要臆造" },
                  ],
                  list_reference_occurrences: { cursor: 0, limit: 100 },
                  read_document_reference_evidence: { target_key: "从 list_reference_occurrences 返回的 inline target_key", cursor: 0, limit: 24 },
                  read_reference_facts: { target_key: "从 list_reference_occurrences 返回的 isolated target_key", entry_ids: ["只填写模型确认需要核对的条目"] },
                  list_table_fragments: { cursor: 0, limit: 100 },
                  read_table_summary: { table_key: "复制 list_table_fragments 返回的逻辑表 table_key" },
                  read_table_rows: { table_key: "复制 read_table_summary 返回的 table_key", cursor: 0, limit: 50 },
                  open_evidence: { evidence_id: "来自 component_span_ids 或已读表格/引用行的 evidence_id", cursor: 0 },
                  locate_evidence_span: {
                    evidence_id: "来自已打开原文的 evidence_id",
                    quote: "仅填写已打开原文中由模型选择的精确子串",
                    prefix: "可选",
                    suffix: "可选",
                  },
                },
                save_tool_instruction: "先用 read_target_selectors 读取并保留待修改的完整记录，只改 writable_paths 指定字段；以 operation=upsert 调用 stage_target_selector_draft，将修改后的完整记录按集合放入 draft.items 或 draft.references（两者可同次提交），保留未被点名的正确字段。writable_paths 是诊断元数据，不是工具参数。",
                save_tool: "stage_target_selector_draft",
                how_to_pass: "先用 read_target_selectors 读取当前 reference（collection=references、key=当前 reference_key）以及 actual.item_keys 中存在的 items（collection=items、key=真实 item_key）；不存在的 key 不要臆造。再用 list_reference_occurrences 按 occurrence_id 核对引用，inline 目标用 read_document_reference_evidence(target_key=...)、isolated 目标用 read_reference_facts(target_key=...)，必要时用 list_table_fragments 定位逻辑表、read_table_summary(table_key=...) 读取摘要、read_table_rows(table_key=..., cursor=0) 读取表头和数据行，并按需用 open_evidence(evidence_id=...) 或 locate_evidence_span(evidence_id=..., quote=...) 核对精确来源。若原文确认 item_key 或 decision 点错，只修正当前 disposition 的 item_keys/decision；若原文确认 item_key 与 acceptance_branch decision 正确，才补齐该真实 item 的完整 typed acceptance_branches 及精确来源。不得替模型决定接收 item、分支数量、条件或允许值，不得虚构 item、span 或语义。最后只用 stage_target_selector_draft 保存 writable_paths 指向的 references/items 路径，并重新执行原验证。",
                do_not_edit: "不可变引用原文、编译产物、其他 component dispositions、未涉及的正确 items 及已有正确分支。",
              },
            });
          }
        }
        for (const itemKey of disposition.item_keys) {
          const assignments = assignmentsByItem.get(itemKey) ?? [];
          assignments.push({
            decision: disposition.decision,
            component_span_ids: disposition.component_span_ids,
            referenceIndex,
          });
          assignmentsByItem.set(itemKey, assignments);
        }
      }
      const missingSpanIds = reference.target_span_ids.filter((spanId) => dispositionCounts.get(spanId) !== 1);
      if (reference.target_span_ids.length > 0 && (dispositions.length === 0 || missingSpanIds.length > 0)) {
        issues.push({
          code: "selector_reference_component_dispositions_required",
          path: `/references/${referenceIndex}/component_dispositions`,
          message: "同一来源句含多个已解析条款时，必须逐一处置每个 target component；引用闭合不能替代语义分解。",
          details: {
            reference_key: reference.key,
            occurrence_id: occurrence.occurrence_id,
            same_origin_occurrence_ids: group.map((entry) => entry.occurrence.occurrence_id),
            required_target_span_ids: reference.target_span_ids,
            missing_or_duplicate_span_ids: missingSpanIds,
            required_action: "为每个 target span 恰好填写一次 component_dispositions，并选择 independent_item、same_judgment、acceptance_branch 或 not_applicable",
            writable_paths: [`/references/${referenceIndex}/target_span_ids`, `/references/${referenceIndex}/component_dispositions`, "/items"],
            writable_collections: ["references", "items"],
            candidate_read_tools: ["read_target_selectors", "list_reference_occurrences", "read_document_reference_evidence", "read_reference_facts", "open_evidence", "locate_evidence_span"],
            next_tool: "read_target_selectors",
            next_tool_arguments: { collection: "references", key: reference.key },
            next_tools: ["read_target_selectors", "list_reference_occurrences", "read_document_reference_evidence", "read_reference_facts", "open_evidence", "locate_evidence_span", "stage_target_selector_draft"],
            save_tool: "stage_target_selector_draft",
            save_tool_instruction: "先读取当前完整 reference 和相关真实 items，只修正经原文核实的 target_span_ids、component_dispositions 或 items；以 operation=upsert、draft.references 和必要时 draft.items 提交完整记录。writable_paths 是诊断元数据，不是工具参数。",
            how_to_pass: "先读 reference/items；list_reference_occurrences 核对 analysis_mode/target_key；inline 用 read_document_reference_evidence、isolated 用 read_reference_facts 读原文。核对 target_span_ids 中每个 span：仅移除原文证实不承载要求的结构片段，保留实质要求；对保留的 span 逐项处置。有来源匹配的 item 则绑定，没有则按原文建立真实 item 并保留适用条件；仅有依据才选 not_applicable。填写 component_dispositions 和真实 destinations；用 stage_target_selector_draft(operation=upsert) 同次保存完整 draft.references、必要时 draft.items，再重试验证。",
            do_not_edit: "不可变引用原文、编译产物、无关 references 和已有正确的 items。",
          },
        });
      }
    }
    for (const [itemKey, assignments] of assignmentsByItem) {
      const componentSpanIds = new Set(assignments.flatMap((entry) => entry.component_span_ids));
      if (
        componentSpanIds.size > 1
        && assignments.every((entry) => entry.decision === "independent_item")
      ) {
        issues.push({
          code: "selector_multi_reference_merge_decision_required",
          path: "/references",
          message: "多个被引组件进入同一 item 时，不能继续标为 independent_item；必须拆分 item，或显式选择并证明 same_judgment/acceptance_branch。",
          details: {
            item_key: itemKey,
            reference_indexes: unique(assignments.map((entry) => entry.referenceIndex)),
            component_span_ids: [...componentSpanIds],
            required_action: "split_independent_components_or_author_an_explicit_merge_decision",
          },
        });
      }
    }
  }
  const referenceOriginBindings = new Map<number, { item_key: string; target_field: Exclude<ReferenceTargetField, "reference_only"> }>();
  selectors.references.forEach((reference, referenceIndex) => {
    if (reference.application_mode === "reference_only" && reference.reason.trim().length === 0) {
      issues.push({
        code: "selector_reference_only_reason_required",
        path: `/references/${referenceIndex}/reason`,
        message: "reference_only requires a non-empty top-level reason",
        details: {
          reference_key: reference.key,
          required_action: "write_a_top_level_reference_reason_before_commit",
          nested_reasons_are_not_substitutes: true,
        },
      });
    }
    if ((reference.application_mode as string) === "replace_field") {
      issues.push(...authoredReplaceFieldSelectorIssues({ references: [reference] }).map((issue) => ({
        ...issue,
        path: `/references/${referenceIndex}/application_mode`,
      })));
      return;
    }
    const immutableOccurrence = reference.occurrence_id
      ? manifest.reference_occurrences.find((occurrence) => occurrence.occurrence_id === reference.occurrence_id)
      : undefined;
    const unresolvedInternal = immutableOccurrence?.status === "target_not_found"
      && immutableOccurrence.target_evidence_ids.length === 0 && !immutableOccurrence.external_standard;
    const contextReference = selectorHasContextReference(selectors, registry, manifest, reference, immutableOccurrence);
    if (
      reference.target_span_ids.length === 0
      && (reference.action !== "keep_reference" || reference.application_mode !== "reference_only")
    ) {
      const targetResolved = immutableOccurrence?.status === "resolved";
      issues.push({
        code: "selector_reference_target_required",
        path: `/references/${referenceIndex}/target_span_ids`,
        message: targetResolved
          ? "引用目标已解析，但当前 reference 尚未绑定被引内容的精确 target_span_ids。"
          : "引用目标没有可展开证据时，只能在取得 target_not_found 回执后使用 keep_reference/reference_only，并完整保留原引用。",
        details: targetResolved
          ? {
            reference_key: reference.key,
            occurrence_id: immutableOccurrence.occurrence_id,
            status: immutableOccurrence.status,
            writable_path: `/references/${referenceIndex}/target_span_ids`,
            required_action: "read_resolved_reference_target_then_bind_applicable_spans",
            candidate_read_tools: ["list_reference_occurrences", "read_document_reference_evidence", "read_reference_facts", "read_target_selectors"],
            next_tool: "list_reference_occurrences",
            next_tool_arguments: { cursor: 0 },
            save_tool: "stage_target_selector_draft",
            how_to_pass: "先用 list_reference_occurrences 翻页找到当前 occurrence_id，逐字复制回条中的 target_key 并核对 analysis_mode。inline 目标用 read_document_reference_evidence(target_key=...) 读取组件；isolated 目标先用 read_reference_facts(target_key=...) 读取目录，再打开当前目标实际适用的 entry_ids，取得已核验的 span_id。依据已读原文选择适用的精确 target spans，并核对关联的组件处置和业务路由；用 stage_target_selector_draft 只保存当前 reference 的真实修正后重试验证。已解析目标无需重复调用 resolve_document_reference；不得猜 span 或将有证据的目标当作 target_not_found。",
          }
          : {
            reference_key: reference.key,
            occurrence_id: immutableOccurrence?.occurrence_id ?? null,
            actual: { status: immutableOccurrence?.status ?? "unregistered", required: immutableOccurrence?.required ?? null,
              action: reference.action, application_mode: reference.application_mode, target_span_ids: reference.target_span_ids,
              target_evidence_ids: immutableOccurrence?.target_evidence_ids ?? [], anchor_span_ids: reference.anchor_span_ids,
              destinations: reference.destinations, origin_binding: reference.origin_binding ?? null },
            required_action: unresolvedInternal
              ? "retain_the_registered_missing_target_and_repair_the_local_origin_receipt"
              : "调用 resolve_document_reference 定位目标；若工具返回 target_not_found，则保留原引用并按回执提交",
            allowed_unresolved_values: {
              action: "keep_reference",
              application_mode: "reference_only",
              target_span_ids: [],
            },
            writable_paths: [`/references/${referenceIndex}/action`, `/references/${referenceIndex}/application_mode`,
              `/references/${referenceIndex}/target_span_ids`, `/references/${referenceIndex}/destinations`, "/items"],
            writable_collections: ["references", "items"],
            next_tool: "read_target_selectors", next_tool_arguments: { collection: "references", key: reference.key },
            candidate_read_tools: ["read_target_selectors", "list_reference_occurrences", "open_evidence", "locate_evidence_span",
              ...(unresolvedInternal ? [] : ["resolve_document_reference"])],
            save_tool: "stage_target_selector_draft",
            how_to_pass: unresolvedInternal
              ? "先按 next_tool_arguments 读取当前完整 reference，再用 list_reference_occurrences 核对已有 target_not_found 回执，并核对本地原引用及真实接收 item。目标未找到时只允许 keep_reference/reference_only 和 target_span_ids=[]；mention 的背景回执要求已解析目标，不能在此使用。按原文恢复本地原引用实际所在字段的 destinations，必要时同次修正该真实 item 的显示字段与来源，用 stage_target_selector_draft 保存完整 draft.references 和必要的 draft.items。已有 target_not_found 不需重复解析，也不能读取或虚造不存在的 target spans。保留 required/status、原引用 anchor 和其他正确业务内容；这条回执不代替接收关系及完整阶段校验。"
              : "先读取当前完整 reference，并用 list_reference_occurrences 核对是否已有该处真实引用的不可变回执。尚无确定目标时，只根据已读原文的精确 literal/anchor 与真实 locator 调用 resolve_document_reference，不猜 span、条号或结果状态。若获得 target_not_found，按 allowed_unresolved_values 保留原引用并修复本地真实 destinations；若解析成功，读取工具登记的目标，按原文绑定精确 target_span_ids 及实际接收路由。用 stage_target_selector_draft 保存有据的完整记录后重试；不可在作者字段或 manifest 中伪造 target_not_found。",
            do_not_edit: "不可变 occurrence、required/status、冻结原文、编译产物及无关正确的作者记录。",
          },
      });
    }
    const placeholderTargetTableId = immutableOccurrence?.reference_kind === "table"
      ? immutableOccurrence.target_table_id
      : "";
    const rawReferencedTableCoverage = immutableOccurrence?.reference_kind === "table"
      ? referencedTableItemCoverage(selectors, immutableOccurrence, registry, manifest,
        options.confirmedTableRowRoles === false ? undefined : options.tableStructurePlan)
      : undefined;
    const referencedTableCoverage = rawReferencedTableCoverage ? {
      ...rawReferencedTableCoverage,
      uncovered_data_row_evidence_ids: rawReferencedTableCoverage.uncovered_data_row_evidence_ids
        .filter(id => !receivedSamplingEvidenceIds.has(id) && !nonItemEvidenceCovered(id)),
    } : undefined;
    const referencedTableIsAccounted = Boolean(referencedTableCoverage
      && referencedTableCoverage.data_row_evidence_ids.length > 0
      && referencedTableCoverage.uncovered_data_row_evidence_ids.length === 0);
    const placeholderClauseSpans = reference.target_span_ids.flatMap((spanId) => {
      const span = registeredReferenceSpansById.get(spanId);
      return span ? [span] : [];
    });
    const placeholderClauseCovered = immutableOccurrence?.status === "resolved"
      && immutableOccurrence.reference_kind === "clause"
      && placeholderClauseSpans.length === reference.target_span_ids.length
      && placeholderClauseSpans.length > 0
      && placeholderClauseSpans.every((span) => (
        immutableOccurrence.target_evidence_ids.includes(span.evidence_id)
        && (coveredByRealItems(span) || coveredByNonItems(span))
      ));
    const placeholderEligible = immutableOccurrence?.status === "resolved"
      && (
        referencedTableIsAccounted
        || placeholderClauseCovered
      );
    const resolvedNeedsRealReceiver = immutableOccurrence?.status === "resolved" && !placeholderEligible;
    if (
      reference.destinations.length === 0
      && reference.application_mode !== "reference_placeholder"
      && !contextReference
    ) {
      const originField = immutableOccurrence?.origin_fields.length === 1
        ? immutableOccurrence.origin_fields[0]
        : undefined;
      const externalPlaceholder = Boolean(immutableOccurrence?.external_standard);
      const contextFacts = reference.action === "mention" && immutableOccurrence?.status === "resolved"
        ? selectorContextReferenceFacts(selectors, registry, manifest, immutableOccurrence) : undefined;
      const contextAlternativeFacts = !contextFacts && immutableOccurrence?.status === "resolved"
        && !immutableOccurrence.external_standard
        ? selectorContextReferenceFacts(selectors, registry, manifest, immutableOccurrence) : undefined;
      const contextBinding = contextFacts?.business_origin_bindings[0];
      issues.push({
        code: "selector_reference_destination_required",
        path: `/references/${referenceIndex}/destinations`,
        message: contextFacts
          ? "当前 mention 回执尚未同时满足完整背景来源与无业务导入的全部条件。"
          : placeholderEligible
          ? "纯指针父引用没有业务字段接收者；被引内容已由其他真实验收项覆盖时应保留为纯引用占位。"
          : referencedTableCoverage?.uncovered_data_row_evidence_ids.length
            ? "被引表仍有数据行未由真实验收项承载；当前不能作为整表纯引用占位，须核对缺行及真实字段接收关系。"
          : externalPlaceholder
            ? "外部标准占位引用仍须绑定原引用实际所在的业务字段；不可用空 destinations 冒充内部纯指针占位。"
            : "非占位引用必须指定至少一个接收字段，并且是原引用实际所在的业务字段。",
        details: {
          ...(contextFacts ? {
            actual: { ...contextFacts, current_reference: reference },
            expected_context_receipt: { origin_context_coverage: "all_complete_and_explicit", business_origin_bindings: [], occurrence_status: "resolved", destinations: [], origin_binding: "omit", target_span_ids: "nonempty_exact_spans_inside_this_occurrence", component_dispositions: "if_present_not_applicable_with_empty_item_keys" },
          } : {}),
          required_action: "choose_a_valid_reference_receiver_route_from_the_source",
          reference_key: reference.key,
          ...(originField ? { origin_field: originField } : {}),
          ...(externalPlaceholder ? { external_reference_placeholder: true } : {}),
          ...(referencedTableCoverage?.uncovered_data_row_evidence_ids.length
            ? {
                uncovered_target_data_row_count: referencedTableCoverage.uncovered_data_row_evidence_ids.length,
                uncovered_target_data_row_evidence_ids: referencedTableCoverage.uncovered_data_row_evidence_ids.slice(0, 24),
              }
            : {}),
          ...(placeholderEligible
            ? {
                placeholder_values: {
                  application_mode: "reference_placeholder",
                  destinations: [],
                  target_table_id: placeholderTargetTableId,
                },
              }
            : immutableOccurrence?.status !== "resolved" ? {
                allowed_empty_target_when: {
                  action: "keep_reference",
                  application_mode: "reference_only",
                  target_span_ids: [],
                },
              } : {}),
          allowed_target_fields: ["name", "requirement", "method", "quantity", "note", "sampling", "reference_only"],
          allowed_actions: [
            "若该引用确实向一个或多个真实验收项提供内容，保留 reference_only，并把 destinations 绑定到模型依据原文判断出的真实接收 item 及实际字段。",
            ...(contextAlternativeFacts ? ["只有模型核实完整原引用来源仅为背景且未被业务记录使用时，才按 context_reference_alternative 核对完整显式 context 处置及 mention 回执；无 destinations 或被引内容不适用本身不证明来源属于背景。"] : []),
            ...(resolvedNeedsRealReceiver
              ? [
                  "若已解析内容有现有 items 尚未承载的独立验收判断，可依据原文新增真实 item，保留适用条件和精确来源，再将引用组件路由到该 item 的实际字段。",
                  "若规范列出备选工法，先按已确认目标和原文条件判断各分支是否属于范围；属于范围的分支保留条件性验收项及真实路由，不需推断现场最终采用哪支工法。",
                ]
              : []),
            ...(placeholderEligible
              ? ["若它只是父级纯指针且内容已有完整去向，可改为 reference_placeholder 并保持 destinations=[]：适用判据由真实 item 承载，非项目来源绑定 lots[].scope_span_ids 或逐段 source_dispositions。"]
              : referencedTableCoverage?.uncovered_data_row_evidence_ids.length
                ? ["若原文确为整表纯指针，先逐行核对 uncovered_target_data_row_evidence_ids：实际适用的验收属性补真实 item 和表来源；不适用于本目标的成分按证据作出处置，并保留真实接收路由，不得把部分覆盖冒充整表占位。"]
                : []),
          ],
          writable_paths: [
            `/references/${referenceIndex}/application_mode`,
            `/references/${referenceIndex}/destinations`,
            `/references/${referenceIndex}/component_dispositions`,
            ...(resolvedNeedsRealReceiver || unresolvedInternal ? ["/items"] : []),
            ...(contextAlternativeFacts ? [`/references/${referenceIndex}/action`, `/references/${referenceIndex}/origin_binding`, `/references/${referenceIndex}/target_span_ids`, "/source_dispositions"] : []),
          ],
          writable_collections: unique([...(resolvedNeedsRealReceiver || unresolvedInternal
            ? ["references", "items"] : ["references"]), ...(contextAlternativeFacts ? ["source_dispositions"] : [])]),
          ...(contextAlternativeFacts ? {
            context_reference_alternative: contextReferenceAlternative(reference, contextAlternativeFacts),
          } : {}),
          candidate_read_tool: resolvedNeedsRealReceiver
            ? "list_reference_occurrences" : "read_target_selectors",
          candidate_read_tools: resolvedNeedsRealReceiver
            ? ["read_target_selectors", "list_reference_occurrences", "read_document_reference_evidence", "read_reference_facts", "list_table_fragments", "read_table_summary", "read_table_rows", "open_evidence", "locate_evidence_span"]
            : ["read_target_selectors", "list_reference_occurrences", "open_evidence"],
          next_tool: resolvedNeedsRealReceiver
            ? "list_reference_occurrences" : "read_target_selectors",
          ...(resolvedNeedsRealReceiver
            ? { next_tool_arguments: { cursor: 0, limit: 100 } }
            : {}),
          next_tools: resolvedNeedsRealReceiver
            ? ["list_reference_occurrences", "read_document_reference_evidence", "read_reference_facts", "list_table_fragments", "read_table_summary", "read_table_rows", "open_evidence", "locate_evidence_span", "read_target_selectors", "stage_target_selector_draft"]
            : ["read_target_selectors", "list_reference_occurrences", "open_evidence", "stage_target_selector_draft"],
          save_tool: "stage_target_selector_draft",
          ...(resolvedNeedsRealReceiver
            ? { save_tool_instruction: "以 operation=upsert 同次保存经原文核实的完整 draft.references 和必要的 draft.items；保留其他已正确记录。" }
            : {}),
          how_to_pass: (referencedTableCoverage?.uncovered_data_row_evidence_ids.length
            ? "先 list_reference_occurrences 取 target_key/analysis_mode；inline 用 read_document_reference_evidence、isolated 用 read_reference_facts，按需 read_table_rows/open_evidence 核对未覆盖表行。再 read_target_selectors 读引用与 items。依据原文为适用且缺接收项的行新增完整 item 与表来源；已有项核对 provenance，不适用须有证据。同步填 component_dispositions/destinations，用 stage_target_selector_draft 保存 draft.items 与 draft.references 后重试 commit。整表未覆盖不可用 reference_placeholder，不猜业务内容。"
            : resolvedNeedsRealReceiver
              ? "先读当前 reference/items，用 list_reference_occurrences 取 target_key/analysis_mode；inline 用 read_document_reference_evidence，isolated 用 read_reference_facts 读组件。由模型按原文选择真实接收项；独立判据缺接收者时在已确认范围内新增保留适用条件的真实 item。同次保存完整 draft.items 与 draft.references 及精确来源、组件处置和实际路由后重试。范围内的规范备选工法分别保留条件和路由；现场工法未选定不阻止条件性抽取，不得虚构接收者。"
            : "先用 read_target_selectors 读取当前 reference 和现有 items，再用 list_reference_occurrences 核对 occurrence 的 origin_fields；必要时用 open_evidence 查看来源原文。然后由模型依据原文选择 allowed_actions 中实际成立的路线：有真实接收项时保留 reference_only 并填写真实 destinations；仅在回条明确提供 placeholder_values 且原文确为已覆盖的父级纯指针时，才使用 reference_placeholder。保存后重新执行原验证。不得为了消错虚构 item、接收字段或占位语义。")
            + (contextAlternativeFacts ? " 原引用完整来源仅属背景且无业务绑定时，才可按 context_reference_alternative 全部条件保存背景回执；空接收或被引内容不适用不证明背景。" : ""),
          do_not_edit: "不可变 occurrence、原文、编译产物和已正确的真实 items；harness 不替模型指定接收项。",
          ...(unresolvedInternal ? unresolvedReferenceDestinationDetails(reference, immutableOccurrence, referenceIndex) : {}),
          // Preserve the contextual intent's exact rejecting condition after
          // constructing the ordinary receiver diagnostic above.
          ...(contextFacts ? {
            required_action: "inspect_the_origin_classification_and_repair_conflicting_business_bindings_or_restore_a_real_receiver",
            writable_paths: [...contextFacts.business_origin_bindings.map(row => row.path), "/source_dispositions", `/references/${referenceIndex}`],
            writable_collections: unique([...contextFacts.business_origin_bindings.map(row => row.collection), "source_dispositions", "references"]),
            next_tool: "read_target_selectors",
            next_tool_arguments: contextBinding?.key ? { collection: contextBinding.collection, key: contextBinding.key }
              : { collection: "source_dispositions", evidence_ids: contextFacts.origin_evidence_ids },
            allowed_actions: ["模型确认来源只属背景时，纠正实际冲突的业务绑定或不合条件的回执字段，保留真实业务内容，达到 expected_context_receipt。", "模型确认来源实际属于业务时，纠正 context 处置，恢复该来源的真实字段接收路由。"],
            how_to_pass: "先按 next_tool_arguments 读取完整作者记录，对比 actual.current_reference 与 expected_context_receipt，并按 actual.business_origin_bindings 的 path/span_id 核对冲突位置及原文。由模型判断：原 context 分类正确且来源只属背景时，纠正列出的业务绑定并保留真实业务内容，再保存 mention/reference_only、精确 anchor/target spans、空 destinations、无 origin_binding；来源实际属于业务时，纠正 context 处置，恢复真实字段接收路由。incomplete_context_evidence_ids 非空时须逐项读原文核对分类，不能用 residual 或空说明代替完整显式处置。用 stage_target_selector_draft 保存涉及的完整记录后重检；不能靠追加 destination、修改理由或虚造验收项绕过背景条件。",
          } : {}),
        },
      });
    }
    if (
      reference.application_mode === "reference_placeholder"
      && reference.destinations.length > 0
    ) {
      issues.push({
        code: "selector_reference_placeholder_has_item_destination",
        path: `/references/${referenceIndex}/destinations`,
        message: "纯引用占位不是业务 item，不能再挂到某个验收叶字段。",
        details: {
          required_action: "清空 destinations；保留 occurrence_id、精确引用 anchor、已覆盖 target spans 和 provenance",
        },
      });
    }
    if (reference.application_mode === "reference_placeholder") {
      const targetTableId = immutableOccurrence?.reference_kind === "table"
        ? immutableOccurrence.target_table_id
        : "";
      const tableIsAccounted = referencedTableIsAccounted;
      if (
        immutableOccurrence?.status !== "resolved"
      ) {
        issues.push({
          code: "selector_reference_placeholder_requires_resolved_reference",
          path: `/references/${referenceIndex}/application_mode`,
          message: "纯引用占位只适用于已解析的当前文档表格、章节或条款引用。",
          details: {
            occurrence_id: immutableOccurrence?.occurrence_id ?? "",
            occurrence_status: immutableOccurrence?.status ?? "missing",
            reference_kind: immutableOccurrence?.reference_kind ?? "",
            required_action: "先解析内部引用；外部或未解析引用继续使用 keep_reference/reference_only",
          },
        });
      } else if (immutableOccurrence.reference_kind === "table" && (!targetTableId || !tableIsAccounted)) {
        const referencePath = `/references/${referenceIndex}`;
        issues.push({
          code: "selector_reference_placeholder_table_items_missing",
          path: `${referencePath}/target_span_ids`,
          message: "被引表仍有数据行未由真实验收项及其选中抽样组件、检验批范围或逐段来源处置完整承载。",
          details: {
            occurrence_id: immutableOccurrence.occurrence_id,
            target_table_id: targetTableId,
            target_evidence_ids: immutableOccurrence.target_evidence_ids,
            data_row_evidence_ids: referencedTableCoverage?.data_row_evidence_ids ?? [],
            uncovered_target_data_row_count: referencedTableCoverage?.uncovered_data_row_evidence_ids.length ?? 0,
            uncovered_target_data_row_evidence_ids: referencedTableCoverage?.uncovered_data_row_evidence_ids.slice(0, 24) ?? [],
            actual: {
              reference_key: reference.key,
              application_mode: reference.application_mode,
              target_table_id: targetTableId,
              table_is_materialized: tableIsAccounted,
            },
            required_action: "逐行核对来源用途：判据补真实叶，抽样绑定真实项目选中的分支组件，非项目内容绑定检验批范围或逐段来源处置；实际字段导入改用 reference_only。",
            allowed_actions: [
              "被引表对应的真实业务叶已经存在时，为这些 item.table 补齐该 occurrence 指向的同一逻辑表证据绑定，并用当前 reference.component_dispositions 将已登记组件映射到实际覆盖它们的真实 item。",
              "核对原文确认被引表仍有尚未建立的真实业务叶时，新增具备完整字段与 provenance 的 items，并补齐同一逻辑表证据绑定和 component_dispositions。",
              "抽样行在 sampling_rules 的分支组件中绑定精确来源，并由真实 item.sampling 选择对应 rule_key 和 branch_keys；complete_span_ids 或未选分支不能证明已接收。",
              "非项目行按原文完整绑定 lots[].scope_span_ids 或逐段 source_dispositions（context/ignored 和具体理由），保留引用 anchor 与完整 target spans；仅写组件 not_applicable/reason 不能代替来源保留。",
              "若当前误选 reference_placeholder，原文实际是向已有真实验收项的字段提供内容，改为 reference_only，并依据原文填写 origin_binding、destinations、import_scope 和 component_dispositions，保留适用的本地字段及已解析来源；无需为了维持占位模式扩展当前目标的检验范围。",
              "核对原文确认引用只属背景时，先核对全部 origin 的显式 context 处置及业务来源使用情况；只有全部 origin 原文完整处置为 context 且未被业务使用，才可改为 mention/reference_only，保留精确 anchor/target spans、空 destinations 并省略 origin_binding。删除 references 不会删除已登记 occurrence，不能靠删除引用消错；条件不成立时保留缺口并核对真实路由或来源定位。",
            ],
            writable_paths: [
              "/items",
              "/sampling_rules",
              "/lots",
              "/source_dispositions",
              `${referencePath}/target_span_ids`,
              `${referencePath}/component_dispositions`,
              `${referencePath}/application_mode`,
              `${referencePath}/destinations`,
              `${referencePath}/origin_binding`,
              `${referencePath}/import_scope`,
            ],
            writable_collections: ["items", "references", "sampling_rules", "lots", "source_dispositions"],
            candidate_read_tools: [
              "read_target_selectors",
              "list_reference_occurrences",
              "read_reference_facts",
              "read_document_reference_evidence",
              "list_table_fragments",
              "read_table_summary",
              "read_table_rows",
              "open_evidence",
              "locate_evidence_span",
            ],
            next_tool: "read_target_selectors",
            next_tool_arguments: { collection: "references", key: reference.key },
            next_tools: [
              "read_target_selectors",
              "list_reference_occurrences",
              "read_reference_facts",
              "read_document_reference_evidence",
              "list_table_fragments",
              "read_table_summary",
              "read_table_rows",
              "open_evidence",
              "locate_evidence_span",
              "stage_target_selector_draft",
            ],
            save_tool: "stage_target_selector_draft",
            how_to_pass: "先按 next_tool_arguments 读取完整 reference，再用 list_reference_occurrences 核对 target_key/analysis_mode；inline 用 read_document_reference_evidence，isolated 用 read_reference_facts 读取未覆盖表行。依据原文判断：适用验收行补真实 item/table 来源；组织范围绑定 lots[].scope_span_ids；其他非项目内容逐段写入 source_dispositions（context/ignored 和具体理由）。这些来源须覆盖完整行，单写 component_dispositions.not_applicable 或 reason 不足以通过。实际有字段接收者时用 reference_only 及真实路由。用 stage_target_selector_draft 保存 writable_paths 内的完整记录后重验，不为覆盖造项目。",
            do_not_edit: "不可变 occurrence、原文、编译产物、已正确的真实 items 和 placeholder 覆盖规则；不得仅为消错删除被引事实。",
          },
        });
      } else if (immutableOccurrence.reference_kind === "clause") {
        const allowedTargetEvidenceIds = new Set(immutableOccurrence.target_evidence_ids);
        const invalidTargetSpans = placeholderClauseSpans.filter((span) => !allowedTargetEvidenceIds.has(span.evidence_id));
        const uncoveredTargetSpans = placeholderClauseSpans.filter((span) => (
          allowedTargetEvidenceIds.has(span.evidence_id) && !coveredByRealItems(span) && !coveredByNonItems(span)
        ));
        const referenceLiteralSpans = referenceOccurrenceLiteralSpanIds(immutableOccurrence)
          .flatMap((spanId) => {
            const span = selectorSpanById.get(spanId);
            return span ? [span] : [];
          });
        const localCriterionBindings = referenceLiteralSpans.length > 0
          ? selectors.items.flatMap((item, itemIndex) => item.criterion_span_ids.flatMap((spanId) => {
              const span = selectorSpanById.get(spanId);
              if (!span) return [];
              const sameEvidenceLiterals = referenceLiteralSpans.filter((literal) => literal.evidence_id === span.evidence_id);
              return sameEvidenceLiterals.some((literal) => span.start < literal.start || span.end > literal.end)
                ? [{ item_key: item.key, item_index: itemIndex, span_id: spanId }]
                : [];
            }))
          : [];
        if (localCriterionBindings.length > 0) {
          const affectedItemKeys = new Set([
            ...localCriterionBindings.map((binding) => binding.item_key),
            ...reference.destinations.map((destination) => destination.item_key),
            ...(reference.origin_binding ? [reference.origin_binding.item_key] : []),
            ...(reference.component_dispositions ?? []).flatMap((disposition) => disposition.item_keys),
          ]);
          const currentReceiverFields = selectors.items.flatMap((item, itemIndex) =>
            affectedItemKeys.has(item.key)
              ? [{
                  item_key: item.key,
                  item_index: itemIndex,
                  readable_path: `/items/${itemIndex}`,
                }]
              : []
          );
          const referenceWritablePaths = [
            `/references/${referenceIndex}/application_mode`,
            `/references/${referenceIndex}/destinations`,
            `/references/${referenceIndex}/import_scope`,
            ...(reference.component_dispositions !== undefined
              ? [`/references/${referenceIndex}/component_dispositions`]
              : []),
          ];
          const receiverWritablePaths = selectors.items.flatMap((item, itemIndex) =>
            affectedItemKeys.has(item.key)
              ? [
                  `/items/${itemIndex}/criterion_span_ids`,
                  `/items/${itemIndex}/continuation_span_ids`,
                  `/items/${itemIndex}/fields`,
                  ...(item.table !== null ? [`/items/${itemIndex}/table`] : []),
                  `/items/${itemIndex}/sampling`,
                ]
              : []
          );
          issues.push({
            code: "selector_reference_placeholder_local_requirement",
            path: `/references/${referenceIndex}/application_mode`,
            message: "当前引用所在条文还包含独立本地要求，不能在保留这些本地绑定的同时把引用降级为非计数 placeholder。纯 placeholder 只能保存已由其他真实 item 覆盖的纯引用指针，不能自身携带本地 requirement、method、quantity 等验收内容。",
            details: {
              occurrence_id: immutableOccurrence.occurrence_id,
              local_criterion_bindings: localCriterionBindings,
              required_action: "keep_the_local_acceptance_item_and_route_the_resolved_reference_to_its_actual_field",
              actual: {
                reference_key: reference.key,
                occurrence_id: immutableOccurrence.occurrence_id,
                application_mode: reference.application_mode,
                origin_binding: reference.origin_binding ?? null,
                local_criterion_bindings: localCriterionBindings,
                destinations: reference.destinations,
                import_scope: reference.import_scope,
                component_dispositions: reference.component_dispositions ?? null,
                current_receiver_fields: currentReceiverFields,
              },
              allowed_actions: [
                "原文确有独立本地验收内容时，保留承载这些内容的真实 item；把当前 reference 改为普通 reference_only，并依据原文用 destinations、import_scope 以及现有 component_dispositions 精确路由到真实接收字段。",
                "回条中的本地绑定本身选错时，只在对应真实 item 的作者路径移除或纠正错误 span；不得为了保留 placeholder 而删除原文确有的本地要求。",
              ],
              writable_paths: [...referenceWritablePaths, ...receiverWritablePaths],
              writable_collections: ["references", "items"],
              candidate_read_tools: [
                "read_target_selectors",
                "list_reference_occurrences",
                "read_reference_facts",
                "read_document_reference_evidence",
                "open_evidence",
                "locate_evidence_span",
              ],
              next_tool: "read_target_selectors",
              next_tool_arguments: { collection: "references", key: reference.key },
              next_tools: [
                "read_target_selectors",
                "list_reference_occurrences",
                "read_reference_facts",
                "read_document_reference_evidence",
                "open_evidence",
                "locate_evidence_span",
                "stage_target_selector_draft",
              ],
              save_tool: "stage_target_selector_draft",
              how_to_pass: "先用 read_target_selectors 读取当前 reference；再对 actual.current_receiver_fields 中列出的每个 item_key 调用 read_target_selectors（collection=items, key=<item_key>）读取完整记录，不要把摘要当成完整 item。随后用 list_reference_occurrences 核对 occurrence 的 target_key 与 analysis_mode。isolated 引用用 read_reference_facts 读取已封存引用事实；inline 引用用 read_document_reference_evidence，并在需要精确来源时使用 open_evidence 和 locate_evidence_span。这些读取工具只提供原文，不替模型选择接收字段。然后按原文从两种合法方向选择：保留本地真实 item，并把引用改为 reference_only 后通过 destinations/import_scope/现有 component_dispositions 路由到实际字段；或者只纠正确实选错的本地 item 绑定。不要把本地要求搬进 placeholder。最后用 stage_target_selector_draft 只保存 writable_paths 涉及的记录并重试验证。",
              do_not_edit: "不可变原文、编译产物、引用 occurrence/anchor、未列入 writable_paths 的正确 item，以及原文确实存在的本地要求。",
            },
          });
        }
        if (
          reference.target_span_ids.length === 0
          || placeholderClauseSpans.length !== reference.target_span_ids.length
          || invalidTargetSpans.length > 0
          || uncoveredTargetSpans.length > 0
        ) {
          const referencePath = `/references/${referenceIndex}`;
          const firstUncoveredSource = uncoveredTargetSpans.find((span) => {
            const source = evidenceRecordsById.get(span.evidence_id);
            return source?.kind !== "heading"
              && (source?.kind !== "table_row" || source.table_row_kind === "data");
          }) ?? uncoveredTargetSpans[0];
          const uncoveredSourcePreview = uncoveredTargetSpans.slice(0, 8).map((span) => {
            const source = evidenceRecordsById.get(span.evidence_id);
            const disposition = reference.component_dispositions?.find((row) => row.component_span_ids.includes(span.span_id));
            return {
              span_id: span.span_id,
              evidence_id: span.evidence_id,
              source_kind: source?.kind ?? null,
              table_row_kind: source?.kind === "table_row" ? source.table_row_kind ?? null : null,
              locator: source?.locator ?? null,
              declared_decision: disposition?.decision ?? null,
              declared_item_keys: disposition?.item_keys ?? [],
            };
          });
          const uncoveredIntervals = uncoveredTargetSpans.flatMap(span =>
            sourceSpanGaps(span, realItemCoverageSpans).map(gap => ({
              span_id: span.span_id, evidence_id: span.evidence_id, ...gap,
            })));
          issues.push({
            code: "selector_reference_placeholder_target_uncovered",
            path: `${referencePath}/target_span_ids`,
            message: "纯引用占位必须保留属于该 occurrence 的精确 target spans；适用判据由真实验收项承载，非项目内容由检验批范围或逐段来源处置完整承载。",
            details: {
              reference_key: reference.key,
              occurrence_id: immutableOccurrence.occurrence_id,
              missing_or_unknown_span_count: reference.target_span_ids.length - placeholderClauseSpans.length,
              invalid_target_span_ids: invalidTargetSpans.map((span) => span.span_id),
              uncovered_target_span_ids: uncoveredTargetSpans.map((span) => span.span_id),
              uncovered_source_preview: uncoveredSourcePreview,
              uncovered_source_count: uncoveredTargetSpans.length,
              preferred_uncovered_source: firstUncoveredSource
                ? { span_id: firstUncoveredSource.span_id, evidence_id: firstUncoveredSource.evidence_id }
                : null,
              actual: {
                target_span_ids: reference.target_span_ids,
                uncovered_target_span_ids: uncoveredTargetSpans.map(span => span.span_id),
                uncovered_intervals: uncoveredIntervals.slice(0, 8),
                uncovered_interval_count: uncoveredIntervals.length,
                uncovered_intervals_complete: uncoveredIntervals.length <= 8,
              },
              expected: {
                for_reference_placeholder: "target_span_ids 非空、全部已登记且属于本 occurrence；每个声明的 target span 须由带 criterion 的真实 item 及其已选 sampling 来源完整覆盖。改为其他 application_mode 时仍须满足该模式现有的接收与处置契约。",
              },
              allowed_actions: [
                "确为纯指针时保留 reference_placeholder 和空 destinations；核对 target spans，仅修正错误登记，并用真实 item 或已选 sampling 分支完整覆盖适用内容。",
                "非项目内容按原文绑定到 lots[].scope_span_ids 或逐段 source_dispositions（context/ignored 及具体理由）；必须完整覆盖精确来源，单写 not_applicable/reason 不能代替来源保留。",
                "被引内容实际导入真实验收字段时改为 reference_only；按原文填写 origin_binding（如适用）、真实 destinations、import_scope 和 component_dispositions。",
                ...(selectorContextReferenceOrigins(selectors, registry, manifest, immutableOccurrence)
                  ? ["全部 origin 已有完整显式 context 处置且未被业务使用；若模型复核该分类正确，可改为 action=mention/application_mode=reference_only，保留精确 anchor/target spans，destinations=[]，省略 origin_binding；组件处置（如提供）须是有依据的 not_applicable、item_keys=[]。无需创建背景验收项，不改变 occurrence 的 required/status。"] : []),
              ],
              writable_paths: [
                `${referencePath}/target_span_ids`,
                `${referencePath}/application_mode`,
                `${referencePath}/origin_binding`,
                `${referencePath}/destinations`,
                `${referencePath}/import_scope`,
                `${referencePath}/component_dispositions`,
                "/items",
                "/sampling_rules",
                "/lots",
                "/source_dispositions",
              ],
              writable_path: `${referencePath}/application_mode`,
              writable_collections: ["references", "items", "sampling_rules", "lots", "source_dispositions"],
              candidate_read_tool: firstUncoveredSource ? "list_reference_occurrences" : "read_target_selectors",
              candidate_read_tools: ["read_target_selectors", "list_reference_occurrences", "read_document_reference_evidence", "read_reference_facts", "open_evidence", "locate_evidence_span", "list_sampling_rules"],
              next_tool: firstUncoveredSource ? "list_reference_occurrences" : "read_target_selectors",
              next_tool_arguments: firstUncoveredSource
                ? { cursor: 0, limit: 100 }
                : { collection: "references", key: reference.key },
              next_tools: ["read_target_selectors", "list_reference_occurrences", "read_document_reference_evidence", "read_reference_facts", "open_evidence", "locate_evidence_span", "list_sampling_rules", "stage_target_selector_draft"],
              save_tool: "stage_target_selector_draft",
              declared_receivers: (reference.component_dispositions ?? []).flatMap(component => component.item_keys),
              selected_sampling: selectors.items.filter(item => item.sampling.rule_key).map(item => ({ item_key: item.key, rule_key: item.sampling.rule_key, branch_keys: item.sampling.branch_keys })),
              required_action: "核对当前 reference、occurrence 与真实接收项，按原文选择继续纯占位并补足覆盖，或改为 reference_only 并路由实际导入字段。",
              how_to_pass: firstUncoveredSource
                ? "按 next_tool_arguments 查 occurrence 的 target_key/analysis_mode；inline 用 read_document_reference_evidence，isolated 用 read_reference_facts，勿跨隔离读取。读 reference 和声明接收 items，按 uncovered_source_preview 与 actual.uncovered_intervals 核对原文未覆盖区间 [start,end)；列出整段 span 不表示整段正文都缺失，完整标志为 false 时须核对剩余区间。坐标不判断片段的业务角色，不要重复添加已正确接收的内容。必要时定位精确子串。组织范围精确绑定 lots[].scope_span_ids，其他非项目内容逐段写入 source_dispositions（context/ignored 和具体理由）；引用来源及逐组件处置仍须完整。声明 item_key 或只写 note/reason 不等于真实接收；适用判断按原文补 item 或修正字段及组件处置。只对已证实无业务含义的结构片段同步调整 target_span_ids/处置，保留适用内容。真实字段导入则改 reference_only 并填写 destinations/import_scope/origin_binding；stage 后重验。"
                : "先按 next_tool_arguments 读取当前 reference，核对 occurrence 与 target_span_ids 中错误或缺失的登记；只修正经原文确认的 span，保留适用内容。用 stage_target_selector_draft 保存后重试验证。",
              do_not_edit: "不可变原文、编译产物、正确判据和引用 anchor；不要仅凭报错改变业务分类。",
            },
          });
        }
      }
    }
    const immutableLiteralSpanIds = immutableOccurrence
      ? referenceOccurrenceLiteralSpanIds(immutableOccurrence)
      : [];
    if (immutableOccurrence && immutableLiteralSpanIds.length > 0) {
      const registeredById = new Map(registry.spans.map((span) => [span.span_id, span]));
      const literalSpans = immutableLiteralSpanIds.flatMap((spanId) => {
        const span = registeredById.get(spanId);
        return span ? [span] : [];
      });
      const missingLiteralSpanIds = immutableLiteralSpanIds.filter((spanId) => !reference.anchor_span_ids.includes(spanId));
      if (missingLiteralSpanIds.length > 0) {
        issues.push({
          code: "selector_reference_literal_anchor_required",
          path: `/references/${referenceIndex}/anchor_span_ids`,
          message: "已解析引用必须把 resolve_document_reference 返回的全部精确 reference_literal_span_ids 放进 anchor_span_ids，不能漏段或只绑定引用所在的整句。",
          details: {
            occurrence_id: immutableOccurrence.occurrence_id,
            reference_literal_span_id: immutableOccurrence.reference_literal_span_id,
            reference_literal_span_ids: immutableLiteralSpanIds,
            missing_reference_literal_span_ids: missingLiteralSpanIds,
            required_action: "把全部精确 reference_literal_span_ids 按来源顺序加入 anchor_span_ids，并保留原字段全文",
          },
        });
      }
      // A non-counting placeholder has no receiving item field. Its immutable
      // literal anchors and real target coverage are checked above, including
      // normalized/composite occurrences; do not invent a business origin field.
      if (literalSpans.length === immutableLiteralSpanIds.length && reference.application_mode !== "reference_placeholder" && !contextReference) {
        const spanCoversLiteral = (spanId: string, literalSpan: { evidence_id: string; start: number; end: number }) => {
          const span = registeredById.get(spanId);
          return span?.evidence_id === literalSpan.evidence_id
            && span.start <= literalSpan.start
            && span.end >= literalSpan.end;
        };
        const fields = ["name", "requirement", "method", "quantity", "note", "sampling"] as const;
        const candidates = selectors.items.flatMap((item, itemIndex) => fields.flatMap((field) => {
          const spanIds = field === "sampling"
            ? item.sampling.status === "explicit"
              ? [...item.sampling.condition_span_ids, ...item.sampling.quantity_span_ids, ...item.sampling.script_span_ids]
              : []
            : item.fields[field].span_ids;
          return literalSpans.every(literal => spanIds.some(spanId => spanCoversLiteral(spanId, literal)))
            ? [{ item_key: item.key, item_index: itemIndex, field, span_ids: spanIds }]
            : [];
        }));
        const declared = reference.origin_binding;
        const roleCandidates = immutableOccurrence.origin_fields.length
          ? candidates.filter(candidate => immutableOccurrence.origin_fields.includes(candidate.field))
          : candidates;
        const bySpecificity = [...roleCandidates].sort((left, right) => {
          const width = (entry: typeof left) => Math.min(...entry.span_ids.map(spanId => {
            const span = registeredById.get(spanId);
            return span ? span.end - span.start : Number.POSITIVE_INFINITY;
          }));
          return width(left) - width(right);
        });
        const inferred = immutableLiteralSpanIds.length > 1 || immutableOccurrence.normalized_reference
          ? undefined
          : bySpecificity.length === 1
          || (bySpecificity.length > 1 && Math.min(...bySpecificity[0]!.span_ids.map(id => {
            const span = registeredById.get(id); return span ? span.end - span.start : Number.POSITIVE_INFINITY;
          })) < Math.min(...bySpecificity[1]!.span_ids.map(id => {
            const span = registeredById.get(id); return span ? span.end - span.start : Number.POSITIVE_INFINITY;
          })))
          ? bySpecificity[0]
          : undefined;
        const selected = declared
          ? candidates.find(candidate => candidate.item_key === declared.item_key && candidate.field === declared.target_field)
          : inferred;
        const originEvidenceIds = [...new Set(literalSpans.map(span => span.evidence_id))];
        const evidenceIndexes = originEvidenceIds.map(id => manifest.evidence.findIndex(record => record.evidence_id === id)).filter(index => index >= 0);
        const windowStart = evidenceIndexes.length ? Math.max(0, Math.min(...evidenceIndexes) - 2) : 0;
        const windowEnd = evidenceIndexes.length ? Math.min(manifest.evidence.length, Math.max(...evidenceIndexes) + 3) : 0;
        const adjacentSourceWindow = manifest.evidence.slice(windowStart, windowEnd).map(record => ({
          evidence_id: record.evidence_id, locator: record.locator, atom_id: record.atom_id ?? null,
          clause_id: record.clause_id ?? null, role: record.role, text: record.text,
        }));
        const currentItemFieldBindings = selectors.items.flatMap(item => fields.flatMap(field => {
          const spanIds = field === "sampling"
            ? item.sampling.status === "explicit"
              ? [...item.sampling.condition_span_ids, ...item.sampling.quantity_span_ids, ...item.sampling.script_span_ids]
              : []
            : item.fields[field].span_ids;
          const relevant = spanIds.filter(spanId => {
            const span = registeredById.get(spanId);
            return Boolean(span && originEvidenceIds.includes(span.evidence_id));
          });
          return relevant.length ? [{ item_key: item.key, field, span_ids: relevant }] : [];
        }));
        const requiresExplicitOriginBinding = immutableLiteralSpanIds.length > 1
          || Boolean(immutableOccurrence.normalized_reference);
        if (!selected && requiresExplicitOriginBinding) {
          // Match the existing explicit-binding invariant below: only a single
          // registered origin role constrains the author's field choice.
          const compatibleCandidates = immutableOccurrence.origin_fields.length === 1 ? roleCandidates : candidates;
          const roleConflict = candidates.length > 0 && compatibleCandidates.length === 0;
          issues.push({
            code: candidates.length ? "selector_reference_origin_field_ambiguous" : "selector_reference_origin_binding_missing",
            path: `/references/${referenceIndex}/origin_binding`,
            message: roleConflict
              ? "当前覆盖引用原话的字段均与已登记 occurrence 来源角色冲突；不能只从这些字段中选 origin_binding。请同时核对字段来源范围与 occurrence 角色。"
              : candidates.length
              ? `当前有 ${compatibleCandidates.length} 个覆盖引用原话且角色相容的本地绑定，但尚未显式选中；请依据原文选择 origin_binding。destination 不能代替 origin。`
              : "当前没有本地字段完整绑定引用 literal。不能从空 candidate_target_fields 选择字段；请根据相邻原文修复本地字段、origin occurrence 或引用组件。",
            details: {
              occurrence_id: immutableOccurrence.occurrence_id,
              occurrence_origin_fields: immutableOccurrence.origin_fields,
              declared_origin_binding: declared ?? null,
              reference_literal_span_ids: immutableLiteralSpanIds,
              candidate_origin_bindings: compatibleCandidates.map(candidate => ({ item_key: candidate.item_key, target_field: candidate.field })),
              candidate_target_fields: unique(compatibleCandidates.map(candidate => candidate.field)),
              observed_literal_bindings: candidates.map(candidate => ({ item_key: candidate.item_key, target_field: candidate.field,
                occurrence_role_compatible: compatibleCandidates.includes(candidate) })),
              adjacent_source_window: adjacentSourceWindow,
              current_item_field_bindings: currentItemFieldBindings,
              ...(roleConflict ? {
                how_to_pass: "同时核对 occurrence_origin_fields、observed_literal_bindings 与相邻原文。候选列表为空表示当前没有可直接选择的相容绑定，不表示要求从冲突字段中选一个。若字段来源混入其他语义角色，由模型用 locate_evidence_span 定位适用的精确区间，再用 stage_target_selector_draft 同批保存正确字段及 origin_binding；完整区间已含引用原话时不要追加重叠 literal。若原登记角色确有误，才用同组 literal spans 调用 resolve_document_reference 更正 origin_field，并同步本地绑定。不得仅为通过校验改 occurrence 或 destination，也不得由 harness 指定接收 item 或字段。",
                next_tool: "read_target_selectors",
                save_tool: "stage_target_selector_draft",
              } : {}),
              repair_options: [
                { kind: "bind_local_field_spans", writable_path: "/items/<index>/fields/<field>/span_ids" },
                { kind: "fix_origin_binding", writable_path: `/references/${referenceIndex}/origin_binding` },
                { kind: "fix_immutable_occurrence", next_tool: "resolve_document_reference", owner: "harness_or_reference_resolution" },
                { kind: "fix_destinations_or_components", writable_paths: [`/references/${referenceIndex}/destinations`, `/references/${referenceIndex}/component_dispositions`, `/references/${referenceIndex}/import_scope`] },
              ],
              required_action: roleConflict
                ? "repair_field_binding_or_reresolve_conflicting_origin"
                : compatibleCandidates.length
                ? "choose_one_candidate_origin_binding"
                : "repair_local_field_binding_or_reresolve_occurrence_do_not_choose_from_empty_list",
            },
          });
        } else if (selected) {
          const originMatchesOccurrence = immutableOccurrence.origin_fields.length !== 1
            || immutableOccurrence.origin_fields[0] === selected.field;
          if (originMatchesOccurrence || requiresExplicitOriginBinding) {
            referenceOriginBindings.set(referenceIndex, { item_key: selected.item_key, target_field: selected.field });
          }
          if (requiresExplicitOriginBinding && !originMatchesOccurrence) {
            issues.push({
              code: "selector_reference_occurrence_origin_conflict",
              path: `/references/${referenceIndex}/origin_binding/target_field`,
              message: "本地 origin_binding 与不可变 occurrence 的 origin_field 冲突。请用同一组精确 literal spans 重新调用 resolve_document_reference 修正来源角色；不要改 destination 来掩盖。",
              details: {
                occurrence_id: immutableOccurrence.occurrence_id,
                occurrence_origin_field: immutableOccurrence.origin_fields[0],
                selected_origin_binding: { item_key: selected.item_key, target_field: selected.field },
                reference_literal_span_ids: immutableLiteralSpanIds,
                adjacent_source_window: adjacentSourceWindow,
                current_item_field_bindings: currentItemFieldBindings,
                writable_path: "/origin_field",
                next_tool: "resolve_document_reference",
                required_action: "reresolve_same_literal_fragments_with_actual_origin_field",
              },
            });
          }
        }
      }
    }
    if (
      reference.application_mode === "reference_only"
      && !reference.occurrence_id
      && reference.target_span_ids.length > 0
    ) {
      const registeredById = new Map(registry.spans.map((span) => [span.span_id, span]));
      const anchorBindings = reference.anchor_span_ids.flatMap((spanId, spanIndex) => {
        const span = registeredById.get(spanId);
        return span ? [{
          span,
          span_id: spanId,
          path: `/references/${referenceIndex}/anchor_span_ids/${spanIndex}`,
        }] : [];
      });
      reference.destinations.forEach((destination, destinationIndex) => {
        if (destination.target_field === "note") return;
        const itemIndex = selectors.items.findIndex((item) => item.key === destination.item_key);
        if (itemIndex < 0) return;
        const item = selectors.items[itemIndex]!;
        const targetField = destination.target_field as string;
        const visibleBindings = targetField === "sampling"
          ? item.sampling.status === "explicit"
            ? [
                ...item.sampling.condition_span_ids.map((spanId, spanIndex) => ({
                  span_id: spanId,
                  path: `/items/${itemIndex}/sampling/condition_span_ids/${spanIndex}`,
                })),
                ...item.sampling.quantity_span_ids.map((spanId, spanIndex) => ({
                  span_id: spanId,
                  path: `/items/${itemIndex}/sampling/quantity_span_ids/${spanIndex}`,
                })),
                ...item.sampling.script_span_ids.map((spanId, spanIndex) => ({
                  span_id: spanId,
                  path: `/items/${itemIndex}/sampling/script_span_ids/${spanIndex}`,
                })),
              ]
            : []
          : targetField === "reference_only"
            ? []
            : item.fields[targetField as keyof typeof item.fields].span_ids.map((spanId, spanIndex) => ({
                span_id: spanId,
                path: `/items/${itemIndex}/fields/${targetField}/span_ids/${spanIndex}`,
              }));
        const conflicts = anchorBindings.flatMap((anchor) => (
          visibleBindings.flatMap((visible) => {
            const span = registeredById.get(visible.span_id);
            if (
              !span
              || span.evidence_id !== anchor.span.evidence_id
              || span.start !== anchor.span.start
              || span.end !== anchor.span.end
            ) return [];
            return [{ anchor, visible, span }];
          })
        ));
        if (!reference.occurrence_id && conflicts.length === 0) return;
        issues.push({
          code: "selector_reference_only_anchor_visible_field_conflict",
          path: `/references/${referenceIndex}/destinations/${destinationIndex}/target_field`,
          message: "这条旧引用记录没有 resolve_document_reference 的 occurrence 回执，不能用 reference_only 猜测展示字段。先解析引用，再把它关联回引用原本所在的真实业务字段；不得统一搬到 note 或伪字段 reference_only。",
          details: {
            reference_key: reference.key,
            item_key: destination.item_key,
            target_field: destination.target_field,
            conflicting_bindings: conflicts.map(({ anchor, visible, span }) => ({
              span_id: span.span_id,
              evidence_id: span.evidence_id,
              start: span.start,
              end: span.end,
              anchor_path: anchor.path,
              visible_field_path: visible.path,
            })),
            required_action: "调用 resolve_document_reference，写入返回的 occurrence_id 和全部精确 reference_literal_span_ids，再把 target_field 设为原引用实际所在的业务字段；所有本地 authoritative spans 保持不变",
            only_allowed_repair: {
              paths: [
                `/references/${referenceIndex}/occurrence_id`,
                `/references/${referenceIndex}/anchor_span_ids`,
                `/references/${referenceIndex}/destinations/${destinationIndex}/target_field`,
              ],
              target_field_values: ["name", "requirement", "method", "quantity", "note", "sampling"],
            },
            forbidden_actions: [
              "删除 item criterion_span_ids",
              "删除可见 requirement span_ids",
              "删除本地禁止、条件、对象或限值",
              "删除引用 anchor 或 occurrence provenance 中的 raw_reference",
              "把 requirement/quantity/method 中的引用统一搬到 note",
            ],
            replacement_constraints: {
              destination_must_match_original_business_field: true,
              complete_local_criterion_and_visible_requirement_spans_must_remain_unchanged: true,
              same_local_span_may_remain_visible_and_anchor_the_occurrence: true,
              raw_reference_origin_target_relation_and_resolved_evidence_remain_immutable_provenance: true,
              destination_target_field_reference_only_is_legacy_only: true,
              note_is_allowed_only_when_the_literal_originates_in_note: true,
              no_target_id_clause_number_keyword_title_format_or_length_heuristic: true,
            },
          },
        });
      });
    }
  });

  const sources = evidenceSources(manifest);
  const evidenceRecords = new Map(manifest.evidence.map(record => [record.evidence_id, record]));
  issues.push(...tableTitleBindingIssues(
    selectors,
    registry,
    manifest,
    options.tableStructurePlan,
    options.eligibleTableEvidenceIds,
  ));
  validateAcceptanceBranchContract(selectors, registry, sources, issues);
  validateItemScalarSpanGranularity(selectors, registry, sources, issues);
  selectors.lots.forEach((lot, lotIndex) => {
    const languageEvidence = resolvedSpans(
      lot.scope_span_ids,
      registry,
      sources,
      `/lots/${lotIndex}/scope_span_ids`,
      issues,
    ).map((span) => span.text);
    ([
      ["name", lot.name],
      ["reason", lot.reason],
    ] as const).forEach(([field, value]) => {
      const mismatch = sourceLanguageMismatch(value, languageEvidence);
      if (!mismatch) return;
      issues.push({
        code: "selector_source_language_mismatch",
        path: `/lots/${lotIndex}/${field}`,
        message: "Model-authored inspection-lot text must use the dominant language of its immutable source evidence",
        details: {
          ...mismatch,
          required_action: "rewrite_user_visible_text_in_source_language_without_translating_source_tokens",
        },
      });
    });
  });
  const tableCellsByEvidenceId = new Map<string, ReturnType<typeof htmlTableCellSpans>>();
  selectors.sampling_rules.forEach((rule, ruleIndex) => {
    const scopes = [
      { components: rule.components, path: `/sampling_rules/${ruleIndex}/components`, branch_key: undefined as string | undefined },
      ...rule.branches.map((branch, branchIndex) => ({
        components: branch.components,
        path: `/sampling_rules/${ruleIndex}/branches/${branchIndex}/components`,
        branch_key: branch.key,
      })),
    ];
    scopes.forEach((scope) => {
      scope.components.forEach((component, componentIndex) => {
        if (component.disposition !== "present") return;
        component.span_ids.forEach((spanId, spanIndex) => {
          const selected = registry.spans.find((span) => span.span_id === spanId);
          if (!selected) return;
          const source = sources.get(selected.evidence_id);
          if (!source) return;
          let cells = tableCellsByEvidenceId.get(selected.evidence_id);
          if (!cells) {
            cells = htmlTableCellSpans(source.text);
            tableCellsByEvidenceId.set(selected.evidence_id, cells);
          }
          const crossedTables = new Set(cells
            .filter((cell) => selected.start < cell.table_end && selected.end > cell.table_start)
            .map((cell) => cell.table_index));
          if (crossedTables.size <= 1) return;
          const issuePath = `${scope.path}/${componentIndex}/span_ids/${spanIndex}`;
          const crossedTableMetadata = [...crossedTables].sort((left, right) => left - right).map((tableIndex) => {
            const tableCell = cells!.find((cell) => cell.table_index === tableIndex);
            return {
              table_index: tableIndex,
              table_start: tableCell?.table_start,
              table_end: tableCell?.table_end,
            };
          });
          issues.push({
            code: "selector_sampling_component_span_crosses_table_boundaries",
            path: issuePath,
            message: "抽样组件的来源区间跨越了多个不可变 HTML 表格；请按原文把当前角色绑定到同一条规则表内的精确区间。",
            details: {
              actual: {
                path: issuePath,
                rule_key: rule.key,
                ...(scope.branch_key === undefined ? {} : { branch_key: scope.branch_key }),
                component_key: component.key,
                role: component.role,
                span_id: selected.span_id,
                source: {
                  source_id: source.source_id,
                  evidence_id: selected.evidence_id,
                  atom_id: source.atom_id,
                  source_length: source.text.length,
                  start: selected.start,
                  end: selected.end,
                },
                crossed_tables: crossedTableMetadata,
              },
              role: component.role,
              rule_key: rule.key,
              ...(scope.branch_key === undefined ? {} : { branch_key: scope.branch_key }),
              component_key: component.key,
              evidence_id: selected.evidence_id,
              start: selected.start,
              end: selected.end,
              crossed_table_count: crossedTables.size,
              required_action: "locate_exact_sampling_role_spans_within_one_rule_table",
              writable_collection: "sampling_rules",
              writable_collections: ["sampling_rules"],
              writable_path: issuePath,
              writable_paths: [issuePath],
              candidate_read_tool: "read_target_selectors",
              candidate_read_tools: [
                "read_target_selectors",
                "list_table_fragments",
                "read_table_summary",
                "read_table_rows",
                "open_evidence",
                "locate_evidence_span",
              ],
              next_tool: "read_target_selectors",
              next_tool_arguments: { collection: "sampling_rules", key: rule.key },
              next_tools: [
                "read_target_selectors",
                "list_table_fragments",
                "read_table_summary",
                "read_table_rows",
                "open_evidence",
                "locate_evidence_span",
                "stage_target_selector_draft",
              ],
              save_tool: "stage_target_selector_draft",
              allowed_actions: [
                "只能由模型依据已读取的原文，在同一条规则表内选择与当前角色对应的精确来源区间，并只替换 writable_path 指向的字段。",
              ],
              how_to_pass: "先用 read_target_selectors（collection=sampling_rules, key=当前 rule_key）读取当前完整规则；再用 list_table_fragments 定位物理表，并用 read_table_summary、read_table_rows 核对表头、行和单元格来源。需要确认不可变原文或精确子区间时，先用 open_evidence 打开 evidence_id，再由模型从已读原文选择区间并调用 locate_evidence_span。只能按原文选择一个表内与当前 role 对应的精确区间，不能跨表、编造文字或替模型决定 applicability、condition、quantity、method、acceptance_criterion 的语义。最后只修改 writable_path 指向的组件 span_ids，用 stage_target_selector_draft 保存完整 sampling rule 并重新执行原验证。",
              do_not_edit: "不可变原文、编译产物、未列入 writable_paths 的正确组件和业务语义。",
            },
          });
        });
      });
    });
  });
  const lotKeysByScopeSpan = new Map<string, string[]>();
  for (const lot of selectors.lots) {
    for (const spanId of lot.scope_span_ids) {
      lotKeysByScopeSpan.set(spanId, [...(lotKeysByScopeSpan.get(spanId) ?? []), lot.key]);
    }
  }
  const groupedScopeContinuations = new Map<string, { itemKeys: string[]; paths: string[]; lotKeys: string[] }>();
  const groupedUnmergedContinuations = new Map<string, { itemKeys: string[]; paths: string[] }>();
  const groupedScopeContexts = new Map<string, { paths: string[]; lotKeys: string[] }>();
  selectors.source_dispositions.forEach((disposition, dispositionIndex) => {
    if (disposition.disposition !== "context") return;
    disposition.span_ids.forEach((spanId, spanIndex) => {
      const lotKeys = lotKeysByScopeSpan.get(spanId);
      if (!lotKeys?.length) return;
      const grouped = groupedScopeContexts.get(spanId) ?? { paths: [], lotKeys: [] };
      grouped.paths.push(`/source_dispositions/${dispositionIndex}/span_ids/${spanIndex}`);
      grouped.lotKeys.push(...lotKeys);
      groupedScopeContexts.set(spanId, grouped);
    });
  });
  selectors.items.forEach((item, itemIndex) => {
    const criterionLanguageEvidence = resolvedSpans(
      unique([...item.criterion_span_ids, ...item.continuation_span_ids]),
      registry,
      sources,
      `/items/${itemIndex}/criterion_span_ids`,
      issues,
    ).map((span) => span.text);
    const nameLanguageEvidence = resolvedSpans(
      item.fields.name.span_ids,
      registry,
      sources,
      `/items/${itemIndex}/fields/name/span_ids`,
      issues,
    ).map((span) => span.text);
    const effectiveNameLanguageEvidence = dominantSourceLanguage(nameLanguageEvidence) === "undetermined"
      ? [...nameLanguageEvidence, ...criterionLanguageEvidence]
      : nameLanguageEvidence;
    ([
      ["name", item.name, effectiveNameLanguageEvidence],
      ["inspection_data_type_reason", item.inspection_data_type_reason, criterionLanguageEvidence],
      ["sampling/reason", item.sampling.reason, criterionLanguageEvidence],
    ] as const).forEach(([field, value, languageEvidence]) => {
      const mismatch = sourceLanguageMismatch(value, languageEvidence);
      if (!mismatch) return;
      if (
        field === "name"
        && acceptedSourceLanguageReviews.has(`${item.key}\0${item.name}`)
      ) return;
      issues.push({
        code: "selector_source_language_mismatch",
        path: `/items/${itemIndex}/${field}`,
        message: "Model-authored acceptance-item text must use the dominant language of its immutable source evidence",
        details: {
          ...mismatch,
          required_action: "rewrite_user_visible_text_in_source_language_without_translating_source_tokens",
        },
      });
    });
    for (const field of ["name", "requirement", "method", "quantity", "note"] as const) {
      const decision = item.fields[field];
      const path = `/items/${itemIndex}/fields/${field}`;
      if (!decision.reason.trim()) {
        issues.push({ code: "selector_reason_missing", path: `${path}/reason`, message: "Every semantic field decision requires a reason" });
      }
      if (decision.composition === "not_applicable") {
        if (decision.span_ids.length !== 0) {
          issues.push({ code: "selector_empty_field_binding", path, message: "A not_applicable field must not cite source spans" });
        }
      } else if (decision.span_ids.length === 0) {
        issues.push({
          code: "selector_nonempty_field_unbound",
          path,
          message: `item ${item.key} 的 ${field} 字段声明为 ${decision.composition}，但没有选择任何证据 span。非 not_applicable 字段必须绑定至少一个已登记的精确来源。`,
          details: {
            required_action: "bind_evidence_spans_or_mark_field_not_applicable",
            actual: { item_key: item.key, field, composition: decision.composition, span_ids: decision.span_ids },
            allowed_actions: [
              "原文确实提供该字段内容时，保留适当的 composition 并绑定已登记的精确 span_ids。",
              "原文确实没有或不适用该字段时，将 composition 改为 not_applicable，并保持 span_ids=[]。",
            ],
            writable_path: path,
            candidate_read_tool: "read_target_selectors",
            next_tool: "stage_target_selector_draft",
            how_to_pass: "先用 read_target_selectors 读取当前 item，再按原文在两种合法修法中选择：若该字段有真实来源，定位并绑定精确 span_ids；若原文确实没有或不适用该字段，改为 composition=not_applicable 且 span_ids=[]。不要为消错编造文字或来源，保存后重新执行原验证。",
            do_not_edit: "不可变原文、编译产物和其他已正确字段。",
          },
        });
      }
      if (field === "name" && decision.composition === "semantic_summary" && !item.name.trim()) {
        issues.push({ code: "selector_name_summary_missing", path: `${path}/value`, message: "A semantic_summary name requires the Agent's concise business name" });
      }
      if (decision.composition !== "semantic_summary" && decision.composition !== "not_applicable" && decision.span_ids.length > 1) {
        // Existing resolution below reports invalid sources. Analyze only valid
        // ranges here, using the same display key as literal field compilation.
        const selected = decision.span_ids.flatMap((spanId, index) => {
          const span = resolvedSpans([spanId], registry, sources, `${path}/span_ids/${index}`, [])[0];
          const displayKey = span?.text.trim().replace(/\s+/g, " ");
          return span && displayKey ? [{ spanId, index, span, displayKey }] : [];
        });
        let overlapCount = 0;
        const overlaps: Array<Record<string, unknown>> = [];
        selected.forEach((left, index) => {
          selected.slice(index + 1).forEach((right) => {
            if (left.span.evidence_id !== right.span.evidence_id || left.displayKey === right.displayKey) return;
            const start = Math.max(left.span.selector.start, right.span.selector.start);
            const end = Math.min(left.span.selector.end, right.span.selector.end);
            if (start >= end) return;
            overlapCount++;
            if (overlaps.length < 8) overlaps.push({
              evidence_id: left.span.evidence_id, overlap_start: start, overlap_end: end,
              left: { span_id: left.spanId, start: left.span.selector.start, end: left.span.selector.end, author_path: `${path}/span_ids/${left.index}` },
              right: { span_id: right.spanId, start: right.span.selector.start, end: right.span.selector.end, author_path: `${path}/span_ids/${right.index}` },
            });
          });
        });
        if (overlapCount) issues.push({
          code: "selector_field_source_overlap", path: `${path}/span_ids`,
          message: "同一原文绑定字段选择了显示文本不同但物理区间重叠的 span，拼接会重复原文内容。",
          details: {
            actual: { item_key: item.key, field, composition: decision.composition, overlap_count: overlapCount, overlaps, overlaps_complete: overlapCount === overlaps.length },
            expected: { distinct_display_fragments_must_not_repeat_the_same_source_interval: true, adjacent_ranges_allowed: true, equal_display_fragments_keep_existing_deduplication: true },
            writable_collections: ["items"], writable_paths: [`${path}/span_ids`],
            next_tool: "read_target_selectors", next_tool_arguments: { collection: "items", key: item.key },
            candidate_read_tools: ["read_target_selectors", "open_evidence", "list_reference_occurrences", "read_reference_facts", "locate_evidence_span", "batch_locate_evidence_spans"],
            save_tool: "stage_target_selector_draft",
            required_action: "bind_complete_literal_content_without_repeating_a_physical_source_interval",
            how_to_pass: "先按 key 读取完整当前 item，核对 actual.overlaps 的同源区间和作者路径。包含关系可只移除已被保留外层完整覆盖的内部绑定；部分重叠时，重新定位覆盖完整适用内容的不相交精确片段。需要补读原文时，按来源访问策略选择 open_evidence 或 list_reference_occurrences/read_reference_facts，再用 locate_evidence_span 或 batch_locate_evidence_spans 登记。保留所有真实条件、判据、单位和来源，不以改 reason、separator 或 composition 消错。overlaps 是有界样例；应核对完整字段，未展示冲突不能当作已修复。只更新此字段的 span_ids，用 stage_target_selector_draft 保存完整 item 后重试原验证。",
            do_not_edit: "不可变原文、来源登记、编译产物、其他正确字段与 item；不得绕过隔离读取、删除仍未被保留绑定承载的事实或虚构连接句。",
          },
        });
      }
    }
    // A name carrying the visible review marker already spent its one blocking
    // correction round; it seals as-is so validation cannot loop forever.
    const nameUsesDeclaredValue = !item.name_path && item.fields.name.composition === "semantic_summary";
    const effectiveName = item.name_path
      ? item.name_path.map(part => part.trim()).join("\\")
      : nameUsesDeclaredValue ? item.name
      : selectorText(item.fields.name.span_ids, registry, sources, `/items/${itemIndex}/fields/name/span_ids`, issues, item.fields.name.separator);
    const authoritativeNamePath = item.name_path ? `/items/${itemIndex}/name_path`
      : nameUsesDeclaredValue ? `/items/${itemIndex}/name` : `/items/${itemIndex}/fields/name`;
    const nameShapeSignals = effectiveName.startsWith(ACCEPTANCE_NAME_REVIEW_PREFIX)
      || acceptedVerdictNameReviews.has(`${item.key}\0${effectiveName}`)
      ? []
      : acceptanceItemNameShapeIssues(effectiveName);
    if (nameShapeSignals.length > 0) {
      issues.push({
        code: "selector_name_verdict_sentence",
        path: nameUsesDeclaredValue || item.name_path ? authoritativeNamePath : `${authoritativeNamePath}/span_ids`,
        message: "当前验收项名称以句末终止标点结束。name 应写成“受检对象＋核心质量特性”的简洁名词短语；完整判定、适用条件和限值继续由 requirement 完整呈现。措辞是否构成完整判定句、名称中的适用条件或限值是否必要，均由模型依据原文判断；harness 只检查名称末尾的终止标点，不按关键词、长度或数值机械拒绝。",
        details: {
          name: effectiveName,
          signals: nameShapeSignals,
          required_action: "remove_trailing_sentence_punctuation_without_changing_name_semantics_or_requirement",
          actual: {
            item_key: item.key,
            current_name: effectiveName,
            declared_name: item.name,
            authoritative_name_path: authoritativeNamePath,
            name_binding: item.fields.name,
            detected_signals: nameShapeSignals,
            current_requirement: {
              composition: item.fields.requirement.composition,
              span_ids: item.fields.requirement.span_ids,
            },
          },
          replacement_constraints: {
            exact_table_row_or_column_name_is_allowed: true,
            model_grade_and_business_number_tokens_are_allowed: true,
            name_length_alone_is_not_rejected: true,
            name_requirement_equality_alone_is_not_rejected: true,
            semantic_sentence_classification_belongs_to_model: true,
          },
          writable_paths: [authoritativeNamePath],
          candidate_read_tool: "read_target_selectors",
          next_tool: "read_target_selectors",
          next_tool_arguments: { collection: "items", key: item.key },
          save_tool: "stage_target_selector_draft",
          how_to_pass: nameUsesDeclaredValue
            ? "先用 read_target_selectors 读取当前 item。只移除 name 末尾的句号（。）、分号（；）、感叹号（！）或问号（？），不要截断、改写或删除名称中的业务词、条件、等级、编号或数值。措辞是否构成完整判定句由你依据原文语义判断，harness 不按关键词判定。fields.requirement 中已完整且正确的判定、条件和限值保持不变。最后用 stage_target_selector_draft 只保存当前 item 并重新验证。"
            : item.name_path
            ? "先按 key 读取完整 item。成品名称由 name_path 拼接，修改未参与显示的 name 不会改变它；只去掉最终层级末尾的句末终止标点，保留层级业务语义、真实来源和其他字段。保存完整 item 后重试原验证。"
            : "先按 key 读取完整 item。成品名称来自 fields.name 的来源绑定，单改未参与显示的 name 不会改变它。核对原文后以 locate_evidence_span 登记只去掉末尾句末终止标点的精确名称区间，更新 fields.name.span_ids，保持原文及其他字段绑定不变；若依据原文选择已有业务概括名，则按合法 semantic_summary 绑定保留真实来源。不能删除名称中的业务词、条件、等级、编号或数值。requirement 中完整判据和原始标点仍须保留。以 stage_target_selector_draft 保存完整 item 后重试原验证。",
          do_not_edit: "不可变原文、编译产物、其他已正确 item，以及 requirement 中已经完整且正确的判定、条件和限值。",
        },
      });
    }
    // A summary name cites its subject; it does not reproduce the cited criterion
    // or continuation. Only literal field bindings can carry that source content.
    const materializingFieldSpanIds = unique(Object.values(item.fields)
      .filter((field) => field.composition !== "semantic_summary")
      .flatMap((field) => field.span_ids));
    const nonMaterializingNameSpanIds = item.fields.name.composition === "semantic_summary"
      ? unique(item.fields.name.span_ids) : [];
    const fieldSpans = resolvedSpans(
      materializingFieldSpanIds,
      registry,
      sources,
      `/items/${itemIndex}/fields`,
      issues,
    );
    const tableMaterializingSpanIds = item.table ? unique([
      ...item.table.reference_span_ids,
      ...item.table.properties.table_no_span_ids,
      ...item.table.properties.table_title_span_ids,
      ...item.table.properties.applicability_span_ids,
      ...item.table.properties.row_path_span_ids.flat(),
      ...item.table.properties.column_path_span_ids.flat(),
      ...item.table.properties.unit_span_ids,
      ...item.table.properties.condition_span_ids,
      ...item.table.properties.allowed_value_span_ids,
      ...item.table.properties.inspection_method_span_ids,
    ]) : [];
    const tableMaterializingSpans = resolvedSpans(
      tableMaterializingSpanIds,
      registry,
      sources,
      `/items/${itemIndex}/table`,
      issues,
    );
    // Check source identity, not the semantics of numeric requirements. A table
    // number (including a sliced prefix) cannot be the item's entire criterion.
    // Genuine numeric cells and OCR headings containing requirements remain valid.
    const criterionBindings = resolvedSpans(
      unique([...item.criterion_span_ids, ...item.fields.requirement.span_ids]),
      registry, sources, `/items/${itemIndex}/criterion_span_ids`, issues,
    );
    const onlyTableIdentity = (span: (typeof criterionBindings)[number]): boolean => {
      const record = evidenceRecords.get(span.evidence_id);
      if (!record?.table_id || (record.role !== "formal_table_title"
        && record.role !== "table_continuation_caption")) return false;
      return locateSourceQuote(record.text, record.table_id).some(range =>
        span.selector.start >= range.start && span.selector.end <= range.end);
    };
    if (criterionBindings.length > 0 && criterionBindings.every(onlyTableIdentity)
      && !tableMaterializingSpans.some(span => !onlyTableIdentity(span))) {
      issues.push({
        code: "selector_table_identity_without_criterion",
        path: `/items/${itemIndex}/criterion_span_ids`,
        message: "当前项目的判据和要求只绑定了表题中的编号或编号片段，不能据此形成独立验收项目。",
        details: {
          actual: {
            item_key: item.key,
            name: item.name,
            criterion_span_ids: item.criterion_span_ids,
            requirement_span_ids: item.fields.requirement.span_ids,
            bindings: criterionBindings.map(span => ({
              evidence_id: span.evidence_id,
              start: span.selector.start,
              end: span.selector.end,
              text: span.text,
              source_text: evidenceRecords.get(span.evidence_id)!.text,
              source_role: evidenceRecords.get(span.evidence_id)!.role,
            })),
          },
          required_action: "bind_actual_criterion_or_remove_unsupported_item",
          writable_collection: "items",
          writable_paths: [`/items/${itemIndex}`],
          next_tool: "read_target_selectors",
          next_tool_arguments: { collection: "items", key: item.key },
          next_tools: ["read_target_selectors", "search_evidence", "stage_target_selector_draft"],
          save_tool: "stage_target_selector_draft",
          how_to_pass: "先读取此 item，按其受检对象用 search_evidence 查找当前范围内的完整判据，并按搜索回条允许的读取工具核对原文。项目确实成立时，绑定实际判据到 criterion_span_ids 与 fields.requirement；表格项目同时填写实际行列和值的 table 来源。若原文不支持此项目，用 stage_target_selector_draft 的 collection=items、remove_keys=[当前 item_key] 删除，并同步修正指向该项的引用接收路径。不能靠改名或改 category 消除此来源错误。",
          do_not_edit: "不可变证据、编译产物和其他已正确项目；不得把引用资料自行改为 primary 或编造判据。",
        },
      });
    }
    for (const [field, decision] of Object.entries(item.fields)) {
      resolvedSpans(
        decision.span_ids,
        registry,
        sources,
        `/items/${itemIndex}/fields/${field}/span_ids`,
        issues,
      ).forEach((span) => {
        const source = sources.get(span.evidence_id);
        if (!source) return;
        const tables = htmlTableCellSpans(source.text);
        const crossedTables = new Set(tables
          .filter((cell) => span.selector.start < cell.table_end && span.selector.end > cell.table_start)
          .map((cell) => cell.table_index));
        if (crossedTables.size > 1) {
          issues.push({
            code: "selector_field_span_crosses_table_boundaries",
            path: `/items/${itemIndex}/fields/${field}/span_ids`,
            message: "One field span crosses multiple immutable HTML tables; bind only the exact selected table/cell fragments so adjacent tables and following content cannot leak into the field",
            details: { evidence_id: span.evidence_id, start: span.selector.start, end: span.selector.end, crossed_table_count: crossedTables.size },
          });
        }
      });
    }
    if (item.table) {
      const registeredById = new Map(registry.spans.map((span) => [span.span_id, span]));
      const navigationBindings = [
        ...item.table.properties.table_no_span_ids.map((spanId, spanIndex) => ({
          role: "table_no_span_ids" as const,
          path: `/items/${itemIndex}/table/properties/table_no_span_ids/${spanIndex}`,
          span_id: spanId,
        })),
        ...item.table.properties.table_title_span_ids.map((spanId, spanIndex) => ({
          role: "table_title_span_ids" as const,
          path: `/items/${itemIndex}/table/properties/table_title_span_ids/${spanIndex}`,
          span_id: spanId,
        })),
      ];
      const leafBindings = [
        ...item.table.properties.allowed_value_span_ids.map((spanId, spanIndex) => ({
          role: "allowed_value_span_ids" as const,
          path: `/items/${itemIndex}/table/properties/allowed_value_span_ids/${spanIndex}`,
          span_id: spanId,
        })),
        ...item.table.properties.inspection_method_span_ids.map((spanId, spanIndex) => ({
          role: "inspection_method_span_ids" as const,
          path: `/items/${itemIndex}/table/properties/inspection_method_span_ids/${spanIndex}`,
          span_id: spanId,
        })),
      ];
      const navigationLeafConflicts = navigationBindings.flatMap((navigation) => {
        const navigationSpan = registeredById.get(navigation.span_id);
        if (!navigationSpan) return [];
        return leafBindings.flatMap((leaf) => {
          const leafSpan = registeredById.get(leaf.span_id);
          if (
            !leafSpan
            || navigationSpan.evidence_id !== leafSpan.evidence_id
            || navigationSpan.start !== leafSpan.start
            || navigationSpan.end !== leafSpan.end
          ) return [];
          return [{ navigation, leaf, span: navigationSpan }];
        });
      });
      if (navigationLeafConflicts.length > 0) {
        issues.push({
          code: "selector_table_navigation_leaf_role_conflict",
          path: `/items/${itemIndex}/table/properties`,
          message: "A table number or title interval cannot also materialize an allowed value or inspection method",
          details: {
            item_key: item.key,
            conflicting_bindings: navigationLeafConflicts.map(({ navigation, leaf, span }) => ({
              span_id: span.span_id,
              evidence_id: span.evidence_id,
              start: span.start,
              end: span.end,
              navigation_role: navigation.role,
              navigation_path: navigation.path,
              leaf_role: leaf.role,
              leaf_path: leaf.path,
            })),
            required_action: "bind_distinct_registered_table_navigation_and_leaf_role_spans",
            replacement_constraints: {
              navigation_roles: ["table_no_span_ids", "table_title_span_ids"],
              leaf_roles: ["allowed_value_span_ids", "inspection_method_span_ids"],
              identical_evidence_start_end_is_forbidden_across_navigation_and_leaf_roles: true,
              reference_only_overall_judgment_without_leaf_role_reuse_is_allowed: true,
              no_target_id_clause_number_keyword_title_format_or_length_heuristic: true,
            },
          },
        });
      }
      const inspectionMethodSpanIds = new Set(
        item.table.properties.inspection_method_span_ids,
      );
      if (inspectionMethodSpanIds.size > 0) {
        const navigationRolesBySpanId = new Map<string, string[]>();
        const addNavigationRole = (spanId: string, role: string): void => {
          navigationRolesBySpanId.set(spanId, unique([
            ...(navigationRolesBySpanId.get(spanId) ?? []),
            role,
          ]));
        };
        item.table.reference_span_ids.forEach((spanId) =>
          addNavigationRole(spanId, "reference_span_ids")
        );
        item.table.properties.table_no_span_ids.forEach((spanId) =>
          addNavigationRole(spanId, "table_no_span_ids")
        );
        item.table.properties.table_title_span_ids.forEach((spanId) =>
          addNavigationRole(spanId, "table_title_span_ids")
        );
        item.table.properties.applicability_span_ids.forEach((spanId) =>
          addNavigationRole(spanId, "applicability_span_ids")
        );
        item.table.properties.row_path_span_ids.forEach((spanIds, index) =>
          spanIds.forEach((spanId) =>
            addNavigationRole(spanId, `row_path_span_ids/${index}`)
          )
        );
        item.table.properties.column_path_span_ids.forEach((spanIds, index) =>
          spanIds.forEach((spanId) =>
            addNavigationRole(spanId, `column_path_span_ids/${index}`)
          )
        );

        const conflictingSpanIds = unique(item.fields.method.span_ids.filter((spanId) =>
          !inspectionMethodSpanIds.has(spanId) && navigationRolesBySpanId.has(spanId)
        ));
        if (conflictingSpanIds.length > 0) {
          const allowedBindings = item.table.properties.inspection_method_span_ids.flatMap((spanId) => {
            const registered = registry.spans.find((span) => span.span_id === spanId);
            const source = registered ? sources.get(registered.evidence_id) : undefined;
            return registered && source
              ? [{
                  span_id: spanId,
                  evidence_id: registered.evidence_id,
                  start: registered.start,
                  end: registered.end,
                  text: source.text.slice(registered.start, registered.end),
                }]
              : [];
          });
          issues.push({
            code: "selector_table_method_role_conflict",
            path: `/items/${itemIndex}/fields/method/span_ids`,
            message: "A table item's method field includes a span registered only for reference or table navigation while exact inspection-method spans are available",
            details: {
              conflicting_bindings: conflictingSpanIds.map((spanId) => ({
                span_id: spanId,
                roles: navigationRolesBySpanId.get(spanId) ?? [],
              })),
              allowed_bindings: allowedBindings,
              required_actions: [
                {
                  action: "remove",
                  span_ids: conflictingSpanIds,
                  instruction: "Remove navigation-only spans from fields.method.span_ids.",
                },
                {
                  action: "replace",
                  span_ids: item.table.properties.inspection_method_span_ids,
                  instruction: "Use the registered inspection_method_span_ids as the authoritative method field binding.",
                },
              ],
            },
          });
        }
      }

      const typedLeafBindings = ([
        ...item.table.properties.condition_span_ids.map((spanId, spanIndex) => ({
          role: "condition" as const,
          path: `/items/${itemIndex}/table/properties/condition_span_ids/${spanIndex}`,
          span_id: spanId,
        })),
        ...item.table.properties.allowed_value_span_ids.map((spanId, spanIndex) => ({
          role: "allowed_value" as const,
          path: `/items/${itemIndex}/table/properties/allowed_value_span_ids/${spanIndex}`,
          span_id: spanId,
        })),
        ...item.table.properties.inspection_method_span_ids.map((spanId, spanIndex) => ({
          role: "inspection_method" as const,
          path: `/items/${itemIndex}/table/properties/inspection_method_span_ids/${spanIndex}`,
          span_id: spanId,
        })),
      ]).flatMap((binding) => {
        const span = registeredById.get(binding.span_id);
        const source = span ? sources.get(span.evidence_id) : undefined;
        if (!span || !source) return [];
        const containing = containingHtmlCell(tableEvidenceCellSpans(
          evidenceRecords.get(span.evidence_id) ?? { kind: "paragraph", text: source.text },
        ), span.start, span.end);
        return containing ? [{ ...binding, span, cell: containing.cell }] : [];
      });
      const visibleTableFieldConflations = ([
        {
          field: "requirement" as const,
          intended_roles: new Set(["condition", "allowed_value"]),
        },
        {
          field: "method" as const,
          intended_roles: new Set(["inspection_method"]),
        },
      ]).flatMap(({ field, intended_roles }) => (
        item.fields[field].span_ids.flatMap((spanId, spanIndex) => {
          const selected = registeredById.get(spanId);
          if (!selected) return [];
          const contained = typedLeafBindings.filter((binding) => (
            binding.span.evidence_id === selected.evidence_id
            && binding.span.start >= selected.start
            && binding.span.end <= selected.end
            && (binding.span.start > selected.start || binding.span.end < selected.end)
          ));
          const intended = contained.filter((binding) => intended_roles.has(binding.role));
          const heterogeneous = contained.filter((binding) => !intended_roles.has(binding.role));
          const occupiedCells = unique(contained.map((binding) => [
            binding.span.evidence_id,
            binding.cell.table_index,
            binding.cell.row_index,
            binding.cell.column_index,
          ].join("\0")));
          if (intended.length === 0 || heterogeneous.length === 0 || occupiedCells.length < 2) {
            return [];
          }
          return [{
            field,
            path: `/items/${itemIndex}/fields/${field}/span_ids/${spanIndex}`,
            selected,
            intended,
            heterogeneous,
          }];
        })
      ));
      if (visibleTableFieldConflations.length > 0) {
        issues.push({
          code: "selector_table_visible_field_role_conflation",
          path: `/items/${itemIndex}`,
          message: "A visible table field binds a container interval that strictly contains distinct typed table-cell roles; bind the exact role cells instead of materializing the raw row",
          details: {
            item_key: item.key,
            conflicting_fields: visibleTableFieldConflations.map((conflict) => ({
              field: conflict.field,
              path: conflict.path,
              offending_binding: {
                span_id: conflict.selected.span_id,
                evidence_id: conflict.selected.evidence_id,
                start: conflict.selected.start,
                end: conflict.selected.end,
              },
              intended_role_bindings: conflict.intended
                .slice()
                .sort((left, right) => left.span.start - right.span.start || left.span.end - right.span.end)
                .map((binding) => ({
                  role: binding.role,
                  path: binding.path,
                  span_id: binding.span_id,
                  start: binding.span.start,
                  end: binding.span.end,
                })),
              heterogeneous_role_bindings: conflict.heterogeneous.map((binding) => ({
                role: binding.role,
                path: binding.path,
                span_id: binding.span_id,
                start: binding.span.start,
                end: binding.span.end,
              })),
            })),
            required_action: "replace_visible_table_container_spans_with_exact_typed_cell_spans_in_source_order",
            writable_collection: "items",
            writable_paths: visibleTableFieldConflations.map(conflict => conflict.path),
            next_tool: "read_target_selectors",
            next_tool_arguments: { collection: "items", key: item.key },
            save_tool: "stage_target_selector_draft",
            how_to_pass: "先读取当前完整 item，核对 conflicting_fields 中已选容器和 intended_role_bindings 的精确来源；由模型保留该字段应呈现的角色单元格，必要时补齐共同条件和单位，替换整行容器而不丢失事实。只保存涉及的完整 item 后重验，不要把混入的方法或允许值挪进 note 来消错。",
            do_not_edit: "不可变证据、来源登记表或编译产物，以及其他已正确项目。",
            replacement_constraints: {
              same_evidence_interval_containment_only: true,
              typed_roles: ["condition", "allowed_value", "inspection_method"],
              typed_bindings_must_resolve_inside_distinct_immutable_cells: true,
              exact_indivisible_prose_interval_reuse_is_allowed: true,
              reference_only_navigation_without_visible_field_projection_is_allowed: true,
              no_target_id_clause_number_keyword_title_format_or_length_heuristic: true,
            },
          },
        });
      }

      const roleBindings = [
        ...item.table.properties.table_no_span_ids.map((id) => [id, "table_no_span_ids"] as const),
        ...item.table.properties.table_title_span_ids.map((id) => [id, "table_title_span_ids"] as const),
        ...item.table.properties.applicability_span_ids.map((id) => [id, "applicability_span_ids"] as const),
        ...item.table.properties.row_path_span_ids.flatMap((ids, index) => ids.map((id) => [id, `row_path_span_ids/${index}`] as const)),
        ...item.table.properties.column_path_span_ids.flatMap((ids, index) => ids.map((id) => [id, `column_path_span_ids/${index}`] as const)),
        ...item.table.properties.unit_span_ids.map((id) => [id, "unit_span_ids"] as const),
        ...item.table.properties.condition_span_ids.map((id) => [id, "condition_span_ids"] as const),
        ...item.table.properties.allowed_value_span_ids.map((id) => [id, "allowed_value_span_ids"] as const),
        ...item.table.properties.inspection_method_span_ids.map((id) => [id, "inspection_method_span_ids"] as const),
      ];
      roleBindings.forEach(([spanId, propertyPath]) => {
        const span = resolvedSpans(
          [spanId],
          registry,
          sources,
          `/items/${itemIndex}/table/properties/${propertyPath}`,
          issues,
        )[0];
        if (!span) return;
        const source = sources.get(span.evidence_id);
        if (!source) return;
        const cells = tableEvidenceCellSpans(
          evidenceRecords.get(span.evidence_id) ?? { kind: "paragraph", text: source.text },
        );
        const overlapping = cells.filter((cell) =>
          span.selector.start < cell.table_end && span.selector.end > cell.table_start
        );
        if (!overlapping.length) return;
        const containingCell = overlapping.find((cell) =>
          span.selector.start >= cell.start && span.selector.end <= cell.end
        );
        if (containingCell) return;
        const tableIndices = [...new Set(overlapping.map((cell) => cell.table_index))];
        const directlyCovered = tableIndices.length === 1
          ? cells.filter((cell) =>
              cell.table_index === tableIndices[0]
              && span.selector.start < cell.end
              && span.selector.end > cell.start
            )
          : [];
        const candidateCellIndices = [...new Set(directlyCovered.flatMap((cell) => {
          const index = cells.indexOf(cell);
          return [...cell.inherited_cell_indices, index];
        }))].filter(index => cells[index]!.end > cells[index]!.start);
        const allowedCandidates = candidateCellIndices.slice(0, 32).flatMap((cellIndex) => {
          const cell = cells[cellIndex]!;
          const registered = registry.spans
            .filter((candidate) => candidate.evidence_id === span.evidence_id && candidate.start === cell.start && candidate.end === cell.end);
          return (registered.length ? registered : [undefined]).map((candidate) => ({
            ...(candidate ? { span_id: candidate.span_id } : {}),
            evidence_id: span.evidence_id, start: cell.start, end: cell.end,
            text: source.text.slice(cell.start, cell.end),
            table_index: cell.table_index,
            row_index: cell.row_index,
            column_index: cell.column_index,
            inherited: directlyCovered.some((covered) => covered.inherited_cell_indices.includes(cellIndex)),
          }));
        });
        issues.push({
          code: "selector_table_role_span_crosses_cells",
          path: `/items/${itemIndex}/table/properties/${propertyPath}`,
          message: "表格角色必须绑定一个不可变单元格内的精确区间；完整表格、独立 HTML 行和已解析文本行遵守同一边界。父项、子项、值和方法分别选择，不能把整行或整表当作一个角色。",
          details: {
            actual: { item_key: item.key, span_id: spanId, evidence_id: span.evidence_id, start: span.selector.start, end: span.selector.end },
            span_id: spanId,
            evidence_id: span.evidence_id,
            crossed_table_count: tableIndices.length,
            allowed_bindings: allowedCandidates,
            candidate_count: candidateCellIndices.length,
            candidates_truncated: candidateCellIndices.length > allowedCandidates.length,
            required_action: tableIndices.length === 1
              ? "replace_with_exact_registered_cell_spans"
              : "locate_exact_role_text_inside_one_selected_table",
            writable_collection: "items",
            writable_paths: [`/items/${itemIndex}/table/properties/${propertyPath}`, `/items/${itemIndex}/fields`],
            next_tool: "read_target_selectors",
            next_tool_arguments: { collection: "items", key: item.key },
            next_tools: ["read_target_selectors", "read_table_rows", "open_evidence", "locate_evidence_span", "stage_target_selector_draft"],
            save_tool: "stage_target_selector_draft",
            how_to_pass: "先读取当前完整 item，按来源访问契约核对表格与单元格。由模型判断各角色实际对应的内容；allowed_bindings 提供机械坐标，不替你指定语义。有 span_id 时可直接选用；没有时按 evidence_id 与 text 用 locate_evidence_span 登记，重文须核对 start/end。替换错误角色 span，并同步使 fields 的可见内容绑定精确角色来源。保留已有判据、条件、单位、方法和抽样，用 stage_target_selector_draft 保存完整 item 后重验。",
            do_not_edit: "不可变原文、来源登记表或编译产物；不得删去真实要求或仅改 reason 绕过单元格边界。",
          },
        });
      });

      const conditionIds = new Set(item.table.properties.condition_span_ids);
      const allowedValueIds = new Set(item.table.properties.allowed_value_span_ids);
      item.table.properties.row_path_span_ids.forEach((rowPathIds, rowPathIndex) => {
        const pathConditionIds = rowPathIds.filter((spanId) => conditionIds.has(spanId));
        const pathValueIds = rowPathIds.filter((spanId) => allowedValueIds.has(spanId));
        if (!pathConditionIds.length || !pathValueIds.length) return;

        const resolveCells = (spanIds: string[], role: "condition" | "allowed_value") => spanIds.flatMap((spanId) => {
          const span = resolvedSpans(
            [spanId],
            registry,
            sources,
            `/items/${itemIndex}/table/properties/row_path_span_ids/${rowPathIndex}`,
            issues,
          )[0];
          if (!span) return [];
          const source = sources.get(span.evidence_id);
          if (!source) return [];
          const cells = htmlTableCellSpans(source.text);
          const containing = containingHtmlCell(cells, span.selector.start, span.selector.end);
          return containing ? [{ spanId, role, span, source, cells, ...containing }] : [];
        });
        const conditionCells = resolveCells(pathConditionIds, "condition");
        const valueCells = resolveCells(pathValueIds, "allowed_value");
        const compatible = conditionCells.some((condition) => valueCells.some((value) => {
          if (condition.span.evidence_id !== value.span.evidence_id) return false;
          if (condition.cell.table_index !== value.cell.table_index) return false;
          const conditionEndRow = condition.cell.row_index + condition.cell.row_span;
          const valueEndRow = value.cell.row_index + value.cell.row_span;
          return condition.cell.row_index < valueEndRow && value.cell.row_index < conditionEndRow;
        }));
        if (compatible || !conditionCells.length || !valueCells.length) return;

        const anchor = conditionCells[0]!;
        const sameGridRowIndices = anchor.cells.flatMap((cell, cellIndex) => {
          const anchorEndRow = anchor.cell.row_index + anchor.cell.row_span;
          const cellEndRow = cell.row_index + cell.row_span;
          return cell.table_index === anchor.cell.table_index
            && anchor.cell.row_index < cellEndRow
            && cell.row_index < anchorEndRow
            ? [cellIndex]
            : [];
        });
        issues.push({
          code: "selector_table_row_path_role_mismatch",
          path: `/items/${itemIndex}/table/properties/row_path_span_ids/${rowPathIndex}`,
          message: "A typed table row path binds its condition and allowed value to different physical grid rows; replace the mismatched cell binding so the branch remains row-coherent",
          details: {
            condition_span_ids: pathConditionIds,
            allowed_value_span_ids: pathValueIds,
            condition_rows: conditionCells.map((entry) => ({
              evidence_id: entry.span.evidence_id,
              table_index: entry.cell.table_index,
              row_index: entry.cell.row_index,
              row_span: entry.cell.row_span,
            })),
            allowed_value_rows: valueCells.map((entry) => ({
              evidence_id: entry.span.evidence_id,
              table_index: entry.cell.table_index,
              row_index: entry.cell.row_index,
              row_span: entry.cell.row_span,
            })),
            allowed_bindings: tableCellAllowedBindings(
              registry,
              anchor.span.evidence_id,
              anchor.source,
              anchor.cells,
              sameGridRowIndices,
            ),
            required_action: "replace_condition_or_allowed_value_with_a_registered_cell_from_the_same_physical_grid_row",
          },
        });
      });
    }
    const materializingSpans = [...fieldSpans, ...tableMaterializingSpans];
    item.criterion_span_ids.forEach((spanId, spanIndex) => {
      const criterion = resolvedSpans(
        [spanId],
        registry,
        sources,
        `/items/${itemIndex}/criterion_span_ids/${spanIndex}`,
        issues,
      )[0];
      if (!criterion) return;
      const carried = materializingSpans.some((materialized) =>
        materialized.evidence_id === criterion.evidence_id
        && (
          (
            materialized.selector.start <= criterion.selector.start
            && materialized.selector.end >= criterion.selector.end
          )
          || (
            criterion.selector.start <= materialized.selector.start
            && criterion.selector.end >= materialized.selector.end
          )
        )
      );
      if (carried) return;
      issues.push({
        code: "selector_criterion_not_materialized",
        path: `/items/${itemIndex}/criterion_span_ids/${spanIndex}`,
        message: "每个 criterion_span_ids 来源都必须由同一 item 的原文绑定字段或结构化表格 span 承载；名称概括的来源引用不承载原文判据。",
        details: {
          item_key: item.key,
          span_id: spanId,
          evidence_id: criterion.evidence_id,
          start: criterion.selector.start,
          end: criterion.selector.end,
          materializing_span_ids: unique([
            ...materializingFieldSpanIds,
            ...tableMaterializingSpanIds,
          ]),
          non_materializing_name_span_ids: nonMaterializingNameSpanIds,
          actual: {
            criterion_span_id: spanId,
            criterion_carried: false,
            name_composition: item.fields.name.composition,
            non_materializing_name_span_ids: nonMaterializingNameSpanIds,
          },
          expected: {
            criterion_carried_by_same_item_literal_field_or_typed_table: true,
            semantic_summary_source_is_literal_content: false,
          },
          required_action: "replace_criterion_or_bind_it_to_the_same_item",
          allowed_actions: [
            "将 criterion span 替换为实际定义当前 item 的已登记精确 span。",
            "把该 criterion 的原文绑定到当前 item 的真实 fields 或结构化表格角色；semantic_summary 名称引用不能代替判据内容。",
          ],
          candidate_read_tool: "read_target_selectors",
          candidate_read_tools: ["read_target_selectors", "open_evidence", "locate_evidence_span"],
          next_tool: "read_target_selectors",
          next_tool_arguments: { collection: "items", key: item.key },
          next_tools: ["read_target_selectors", "open_evidence", "locate_evidence_span", "stage_target_selector_draft"],
          save_tool: "stage_target_selector_draft",
          writable_paths: [
            `/items/${itemIndex}/criterion_span_ids`,
            `/items/${itemIndex}/fields`,
            `/items/${itemIndex}/table`,
          ],
          how_to_pass: "先用 read_target_selectors 读取当前 item，核对 span_id、区间、materializing_span_ids 和 non_materializing_name_span_ids；需要查看原文时用 open_evidence，确需新精确区间时用 locate_evidence_span。若 criterion 确属本 item，将完整适用原文绑定到真实 fields 或 typed table；名称的 semantic_summary 及 reason 文字均不能代替原文内容。只有 criterion 登记错了，才换成真正定义本 item 的已登记精确 span。用 stage_target_selector_draft 保存完整当前 item 后重试原验证。",
          do_not_edit: "不可变原文、编译产物和其他已正确的 item；不要为消错删除真实判据、只改 reason 或凭空改写验收语义。",
        },
      });
    });
    item.continuation_span_ids.forEach((spanId, spanIndex) => {
      const groupingLotKeys = lotKeysByScopeSpan.get(spanId);
      if (groupingLotKeys?.length) {
        const grouped = groupedScopeContinuations.get(spanId) ?? { itemKeys: [], paths: [], lotKeys: [] };
        grouped.itemKeys.push(item.key);
        grouped.paths.push(`/items/${itemIndex}/continuation_span_ids/${spanIndex}`);
        grouped.lotKeys.push(...groupingLotKeys);
        groupedScopeContinuations.set(spanId, grouped);
      }
      const continuation = resolvedSpans(
        [spanId],
        registry,
        sources,
        `/items/${itemIndex}/continuation_span_ids/${spanIndex}`,
        issues,
      )[0];
      if (!continuation) return;
      const merged = fieldSpans.some((field) =>
        field.evidence_id === continuation.evidence_id
        && (
          (field.selector.start <= continuation.selector.start && field.selector.end >= continuation.selector.end)
          || (continuation.selector.start <= field.selector.start && continuation.selector.end >= field.selector.end)
        )
      );
      if (!merged) {
        const grouped = groupedUnmergedContinuations.get(spanId) ?? { itemKeys: [], paths: [] };
        grouped.itemKeys.push(item.key);
        grouped.paths.push(`/items/${itemIndex}/continuation_span_ids/${spanIndex}`);
        groupedUnmergedContinuations.set(spanId, grouped);
      }
    });
  });
  for (const [spanId, grouped] of groupedScopeContinuations) {
    issues.push({
      code: "selector_group_scope_used_as_continuation",
      path: grouped.paths[0]!,
      message: "A lot/group scope span cannot also be an item continuation; keep the heading only on the parent lot",
      details: {
        span_id: spanId,
        occurrence_count: grouped.paths.length,
        item_keys: grouped.itemKeys,
        paths: grouped.paths,
        lot_keys: [...new Set(grouped.lotKeys)].sort(),
        required_action: "remove_the_group_heading_from_continuation_and_keep_the_child_item_linked_by_lot_key",
      },
    });
  }
  for (const [spanId, grouped] of groupedUnmergedContinuations) {
    const itemKeys = unique(grouped.itemKeys);
    const affectedItems = grouped.paths.map((path, index) => ({
      item_key: grouped.itemKeys[index] ?? "",
      continuation_path: path,
      readable_path: path.replace(/\/continuation_span_ids\/\d+$/u, ""),
    }));
    const affectedItemRoots = unique(affectedItems.map((entry) => entry.readable_path));
    const registeredSpan = registry.spans.find((span) => span.span_id === spanId);
    const writablePaths = unique([
      ...grouped.paths,
      ...affectedItemRoots.flatMap((itemPath) => [
        `${itemPath}/continuation_span_ids`,
        `${itemPath}/fields`,
        `${itemPath}/table`,
        `${itemPath}/sampling`,
      ]),
      "/source_dispositions",
    ]);
    issues.push({
      code: "selector_continuation_not_merged",
      path: grouped.paths[0]!,
      message: "continuation span 不能只停留在依据清单或名称概括引用中：若它属于最终业务内容，必须由实际适用的同一 item 原文绑定字段或 typed table/sampling 来源承载；若只是背景上下文，应从 item continuation 中移除并在 source_dispositions 中如实处置。",
      details: {
        required_action: "route_continuation_to_real_item_provenance_or_source_disposition",
        actual: {
          span_id: spanId,
          ...(registeredSpan ? {
            evidence_id: registeredSpan.evidence_id,
            start: registeredSpan.start,
            end: registeredSpan.end,
          } : {}),
          occurrence_count: grouped.paths.length,
          item_keys: itemKeys,
          paths: grouped.paths,
          affected_items: affectedItems,
          non_materializing_name_sources: itemKeys.flatMap((key) => {
            const item = selectors.items.find((row) => row.key === key);
            return item?.fields.name.composition === "semantic_summary"
              ? [{ item_key: key, span_ids: unique(item.fields.name.span_ids) }] : [];
          }),
        },
        expected: {
          retained_continuation_carried_by_same_item_literal_field: true,
          semantic_summary_source_is_literal_content: false,
        },
        allowed_actions: [
          "若该 span 确实属于某个 item 的最终业务内容，只在实际适用的同一 item 中将它绑定到真实 fields、typed table 或 sampling provenance。由 table/sampling 独立承载时，从 continuation_span_ids 移除；若仍保留为 continuation，则必须由同一 item 的可见 field span 覆盖。",
          "若该 span 只是背景上下文，不属于这些 item 的最终业务内容，从 paths 列出的所有 continuation 位置移除，并在 source_dispositions 中依据原文选择真实的 context/ignored 处置及理由。",
        ],
        writable_paths: writablePaths,
        writable_collections: ["items", "source_dispositions"],
        candidate_read_tool: "read_target_selectors",
        candidate_read_tools: ["read_target_selectors", "open_evidence", "locate_evidence_span"],
        next_tool: "read_target_selectors",
        next_tool_arguments: { collection: "items", key: itemKeys[0] },
        affected_item_reads: itemKeys.map((key) => ({
          tool: "read_target_selectors",
          arguments: { collection: "items", key },
        })),
        source_disposition_read: {
          tool: "read_target_selectors",
          arguments: { collection: "source_dispositions" },
        },
        next_tools: ["read_target_selectors", "open_evidence", "locate_evidence_span", "stage_target_selector_draft"],
        save_tool: "stage_target_selector_draft",
        how_to_pass: "先按 affected_item_reads 逐条读取所有受影响的完整 item，并核对 actual 中的 span_id、evidence_id、区间和 continuation 路径；需要查看原文时用 open_evidence，现有 span 过宽时才用 locate_evidence_span 登记精确子区间。然后由模型依据原文从 allowed_actions 选择：最终业务内容只绑定到真实适用 item 的 fields/table/sampling 来源，背景内容则从所有列出 continuation 路径移除并在 source_dispositions 如实处置。保留在 continuation_span_ids 中的原文必须由同一 item 的原文绑定 field 承载；semantic_summary 名称引用和 reason 不满足此条件。只修改 writable_paths，使用 save_tool 保存完整记录后重新验证；harness 不替模型选择业务容器或处置结论。",
        do_not_edit: "不可变原文、编译产物、未列入 affected_items 的正确 item，以及已经正确的字段、表格、抽样和来源处置；不要为消错删除仍适用事实或虚构业务含义。",
      },
    });
  }
  for (const [spanId, grouped] of groupedScopeContexts) {
    issues.push({
      code: "selector_lot_scope_context_conflict",
      path: grouped.paths[0]!,
      message: "该 span 已作为检验批范围，不能再重复登记为 context。删除重复处置，不删除检验批范围。",
      details: {
        span_id: spanId,
        lot_keys: [...new Set(grouped.lotKeys)].sort(),
        disposition_paths: grouped.paths,
        required_action: "remove_the_context_disposition_and_keep_the_span_only_in_lot_scope_span_ids",
        writable_path: "/source_dispositions",
        next_tool: "stage_target_selector_draft",
        how_to_pass: "先 read_target_selectors(collection=source_dispositions) 分页获取读取键，再按 key 读取完整记录。用 stage_target_selector_draft 的 collection=source_dispositions、remove_keys=[读取键] 删除冲突记录；若该记录仍有其他有效 span，同次在 draft.source_dispositions 提交剩余完整记录。读取键只用于定位与删除，不写入草稿。保留其他有效背景与 lots[].scope_span_ids；coverage_repair 同样支持此精确删除，但不能整集合替换。",
      },
    });
  }
  const semanticNodes: SemanticDecisionPlan["semantic_nodes"] = [];
  const semanticNodeForSpan = new Map<string, string>();
  const addResolvedNode = (
    key: string,
    role: SemanticDecisionPlan["semantic_nodes"][number]["role"],
    span: EvidenceSpanDecision,
    itemKey: string,
    reason: string,
    parentKey = "",
  ) => {
    const roleKey = role === "sampling_rule"
      ? `${role}\0${span.evidence_id}:${span.start}:${span.end}`
      : `${key}\0${role}\0${span.evidence_id}:${span.start}:${span.end}\0${parentKey}\0${itemKey}`;
    const existing = semanticNodeForSpan.get(roleKey);
    if (existing) return existing;
    const nodeKey = `${key}:${semanticNodes.length}`;
    semanticNodes.push({ key: nodeKey, role, span, parent_key: parentKey, item_key: itemKey, reason });
    semanticNodeForSpan.set(roleKey, nodeKey);
    return nodeKey;
  };
  const addNode = (
    key: string,
    role: SemanticDecisionPlan["semantic_nodes"][number]["role"],
    spanId: string,
    itemKey: string,
    reason: string,
    path: string,
    parentKey = "",
  ) => {
    const span = selectorSpans([spanId], registry, sources, path, issues)[0];
    if (!span) return "";
    return addResolvedNode(key, role, span, itemKey, reason, parentKey);
  };

  selectors.items.forEach((item, itemIndex) => {
    const criterionKeys = item.criterion_span_ids.map((spanId, spanIndex) =>
      addNode(`${item.key}:criterion`, item.table ? "table_criterion" : "acceptance_item", spanId, item.key, item.reason, `/items/${itemIndex}/criterion_span_ids/${spanIndex}`)
    );
    item.continuation_span_ids.forEach((spanId, spanIndex) => addNode(
      `${item.key}:continuation`,
      "continuation",
      spanId,
      item.key,
      item.reason,
      `/items/${itemIndex}/continuation_span_ids/${spanIndex}`,
      criterionKeys[0] ?? "",
    ));
  });

  const declaredSamplingRules: SemanticDecisionPlan["sampling_rules"] = selectors.sampling_rules.map((rule, ruleIndex) => {
    const compileComponents = (
      components: readonly SamplingComponentSelector[],
      path: string,
    ) => components.map((component, componentIndex) => ({
      key: component.key,
      role: component.role,
      disposition: component.disposition,
      spans: selectorSpans(
        component.span_ids,
        registry,
        sources,
        `${path}/${componentIndex}/span_ids`,
        issues,
      ),
      reason: component.reason,
    }));
    const completeCandidates = rule.complete_span_ids.flatMap((spanId, spanIndex) => {
      const span = selectorSpans(
        [spanId],
        registry,
        sources,
        `/sampling_rules/${ruleIndex}/complete_span_ids/${spanIndex}`,
        issues,
      )[0];
      return span ? [{ span, spanId, spanIndex }] : [];
    });
    const memberSpanIds = unique([
      ...samplingComponentSpanIds(rule.components),
      ...rule.branches.flatMap((branch) => samplingComponentSpanIds(branch.components)),
    ]);
    const memberSpans = selectorSpans(memberSpanIds, registry, sources, `/sampling_rules/${ruleIndex}`, issues);
    const containsMember = (complete: EvidenceSpanDecision, member: EvidenceSpanDecision) => (
      member.evidence_id === complete.evidence_id
      && member.start >= complete.start
      && member.end <= complete.end
    );
    const isWholeSource = (span: EvidenceSpanDecision) => {
      const source = sources.get(span.evidence_id);
      return Boolean(source && span.start === 0 && span.end === source.text.length);
    };
    const wholeSourceCandidates = completeCandidates.filter((candidate) => isWholeSource(candidate.span));
    const componentCandidates = completeCandidates.filter((candidate) => !isWholeSource(candidate.span));
    const allMembersResolved = memberSpanIds.length > 0 && memberSpans.length === memberSpanIds.length;
    if (wholeSourceCandidates.length > 0 && componentCandidates.length > 0 && allMembersResolved) {
      issues.push({
        code: "selector_sampling_complete_span_overbroad",
        path: `/sampling_rules/${ruleIndex}/complete_span_ids`,
        message: "complete_span_ids 混入了完整来源和局部片段；请按允许列表替换此字段，保留组件和分支的实际来源绑定。",
        details: {
          actual: rule.complete_span_ids,
          sampling_rule_key: rule.key,
          full_source_span_ids: wholeSourceCandidates.map((candidate) => candidate.spanId),
          allowed_replacement_span_ids: unique([
            ...componentCandidates.map((candidate) => candidate.spanId),
            ...memberSpans.flatMap((span, index) => isWholeSource(span) ? [] : [memberSpanIds[index]!]),
          ]),
          required_action: "replace_complete_span_ids_with_registered_rule_components",
          how_to_pass: "仅将本规则的 complete_span_ids 替换为 allowed_replacement_span_ids。保留 components、branches 中现有的有效 span_ids（其中仍可有完整来源），不要删除数量、方法或条件绑定，也不要重新拆分原文。按 sampling_rule_key 读取现有完整规则后，仅修改该字段并保存；此修正只消除当前范围混填错误，不代表完整候选已通过。",
          writable_path: `/sampling_rules/${ruleIndex}/complete_span_ids`,
          candidate_read_tool: "read_target_selectors",
          next_tool: "stage_target_selector_draft",
          do_not_edit: "不可变原文、编译产物，以及组件、分支和接收项目中的其他正确来源绑定。",
        },
      });
    }
    const containingCompleteCandidates = completeCandidates.filter(({ span: complete }) => memberSpans.every((member) =>
      containsMember(complete, member)
    )).sort((left, right) => (
      (left.span.end - left.span.start) - (right.span.end - right.span.start)
      || left.span.evidence_id.localeCompare(right.span.evidence_id)
      || left.span.start - right.span.start
      || left.span.end - right.span.end
      || left.spanIndex - right.spanIndex
    ));
    const memberEvidenceIds = new Set(memberSpans.map((member) => member.evidence_id));
    const canComposeMemberEnvelope = allMembersResolved && memberEvidenceIds.size === 1;
    const multiEvidenceRule = allMembersResolved && memberEvidenceIds.size > 1;
    const selectedComplete = containingCompleteCandidates[0] ?? completeCandidates[0];
    const deterministicMemberBindings = memberSpans.map((span, index) => ({
      span,
      spanId: memberSpanIds[index]!,
    })).sort((left, right) => (
      left.span.evidence_id.localeCompare(right.span.evidence_id)
      || left.span.start - right.span.start
      || left.span.end - right.span.end
      || left.spanId.localeCompare(right.spanId)
    ));
    const anchorMember = multiEvidenceRule ? deterministicMemberBindings[0] : undefined;
    const anchorMemberSpan = anchorMember?.span;
    const anchorMemberSpanId = anchorMember?.spanId;
    const composedCompleteSpan = canComposeMemberEnvelope ? {
      evidence_id: memberSpans[0]!.evidence_id,
      start: Math.min(...memberSpans.map((member) => member.start)),
      end: Math.max(...memberSpans.map((member) => member.end)),
    } : undefined;
    const completeSpan = anchorMemberSpan
      ?? containingCompleteCandidates[0]?.span
      ?? composedCompleteSpan
      ?? selectedComplete?.span
      ?? { evidence_id: "", start: 0, end: 1 };
    const completeSpanIndex = selectedComplete?.spanIndex ?? 0;
    const sourceKey = anchorMemberSpanId
      ? addNode(`${rule.key}:source`, "sampling_rule", anchorMemberSpanId, "", rule.reason, `/sampling_rules/${ruleIndex}`)
      : composedCompleteSpan && containingCompleteCandidates.length === 0
      ? addResolvedNode(`${rule.key}:source`, "sampling_rule", composedCompleteSpan, "", rule.reason)
      : addNode(`${rule.key}:source`, "sampling_rule", selectedComplete?.spanId ?? "", "", rule.reason, `/sampling_rules/${ruleIndex}/complete_span_ids/${completeSpanIndex}`);
    return {
      key: rule.key,
      source_semantic_key: sourceKey,
      complete_span: completeSpan,
      components: compileComponents(rule.components, `/sampling_rules/${ruleIndex}/components`),
      branches: rule.branches.map((branch, branchIndex) => {
        const effectiveComponents = effectiveSamplingComponents(rule, branch);
        const quantitySpanIds = samplingComponentSpanIds(effectiveComponents, "quantity");
        const scriptSpanIds = samplingScriptSpanIds(effectiveComponents);
        const conditionComponents = presentSamplingComponents(branch.components)
          .filter((component) => component.role === "applicability" || component.role === "branch_condition");
        const conditionTexts = conditionComponents.map((component) => selectorText(
          component.span_ids,
          registry,
          sources,
          `/sampling_rules/${ruleIndex}/branches/${branchIndex}/components/${branch.components.indexOf(component)}/span_ids`,
          issues,
        ));
        const scriptSpans = selectorSpans(scriptSpanIds, registry, sources, `/sampling_rules/${ruleIndex}/branches/${branchIndex}/components`, issues);
        const minSampling = selectorText(quantitySpanIds, registry, sources, `/sampling_rules/${ruleIndex}/branches/${branchIndex}/components`, issues);
        if (!minSampling.trim() && quantitySpanIds.length > 0) {
          issues.push(samplingBranchQuantityMissingIssue(rule, branch, ruleIndex, branchIndex));
        }
        return {
          key: branch.key,
          applies_to_category: branch.applies_to_category,
          min_sampling: minSampling,
          script: deriveSamplingScript(
            minSampling,
            selectorText(scriptSpanIds, registry, sources, `/sampling_rules/${ruleIndex}/branches/${branchIndex}/components`, issues),
            conditionTexts,
            branch.applies_to_category,
          ),
          span: scriptSpans[0] ?? completeSpan,
          components: compileComponents(branch.components, `/sampling_rules/${ruleIndex}/branches/${branchIndex}/components`),
          conditions: conditionComponents.flatMap((component) => {
            const spans = selectorSpans(component.span_ids, registry, sources, `/sampling_rules/${ruleIndex}/branches/${branchIndex}/components`, issues);
            return spans.length ? [{
              key: component.key,
              text: selectorText(component.span_ids, registry, sources, `/sampling_rules/${ruleIndex}/branches/${branchIndex}/components`, issues),
              span: spans[0]!,
            }] : [];
          }),
        };
      }),
      shared_conditions: presentSamplingComponents(rule.components)
        .filter((component) => component.role === "applicability" || component.role === "branch_condition")
        .flatMap((component, componentIndex) => {
          const spans = selectorSpans(component.span_ids, registry, sources, `/sampling_rules/${ruleIndex}/components/${componentIndex}/span_ids`, issues);
          return spans.length ? [{
            key: component.key,
            text: selectorText(component.span_ids, registry, sources, `/sampling_rules/${ruleIndex}/components/${componentIndex}/span_ids`, issues),
            span: spans[0]!,
          }] : [];
        }),
      reason: rule.reason,
    };
  });

  const explicitSamplingRules: SemanticDecisionPlan["sampling_rules"] = selectors.items.flatMap((item, itemIndex) => {
    if (item.sampling.status !== "explicit") return [];
    const sourceSpanIds = unique([
      ...item.sampling.quantity_span_ids,
      ...item.sampling.script_span_ids,
      ...item.sampling.condition_span_ids,
    ]);
    const sourceSpans = selectorSpans(sourceSpanIds, registry, sources, `/items/${itemIndex}/sampling`, issues);
    const quantity = selectorText(item.sampling.quantity_span_ids, registry, sources, `/items/${itemIndex}/sampling/quantity_span_ids`, issues);
    const script = selectorText(item.sampling.script_span_ids, registry, sources, `/items/${itemIndex}/sampling/script_span_ids`, issues);
    const condition = selectorText(item.sampling.condition_span_ids, registry, sources, `/items/${itemIndex}/sampling/condition_span_ids`, issues);
    const ruleKey = `explicit:${item.key}`;
    const branchKey = "explicit";
    // A local explicit quantity is scoped by its receiving item, not by a
    // category the source did not state. It must never inherit a binary rule.
    const appliesToCategory = item.category === UNLABELED_ITEM_CATEGORY ? "all_items" : item.category;
    const completeSpanIndex = sourceSpans.findIndex((complete) => sourceSpans.every((member) =>
      member.evidence_id === complete.evidence_id
      && member.start >= complete.start
      && member.end <= complete.end
    ));
    let completeSpan = completeSpanIndex >= 0 ? sourceSpans[completeSpanIndex] : undefined;
    if (!completeSpan && sourceSpans.length > 0) {
      const evidenceIds = unique(sourceSpans.map((span) => span.evidence_id));
      if (evidenceIds.length === 1) {
        completeSpan = {
          evidence_id: evidenceIds[0]!,
          start: Math.min(...sourceSpans.map((span) => span.start)),
          end: Math.max(...sourceSpans.map((span) => span.end)),
        };
      } else {
        issues.push({
          code: "selector_explicit_sampling_cross_evidence",
          path: `/items/${itemIndex}/sampling`,
          message: "explicit 抽样来源必须属于同一 evidence_id，仅在同一条款中还不够。修正误绑的内联 span；确需跨 evidence 抽样时使用已声明共享规则。",
          details: {
            item_key: item.key,
            evidence_ids: evidenceIds,
            actual: item.sampling,
            required_action: "choose_the_source_faithful_repair_option; do_not_discard_real_method_or_sampling_evidence",
            repair_options: [
              "若 script 误选了另一条检验方法记录，保留 fields.method 的真实方法，将 script_span_ids 绑定到本项完整数量/抽查话述（可与 quantity_span_ids 相同）；quantity/script/condition 均来自同一 evidence_id 后可保留 explicit。",
              "若抽样确需跨记录组合，在 sampling_rules 声明完整 complete_span_ids、七种 typed components 和实际 branches；本项改为 reference，选择 rule_key/branch_keys，三个 inline 数组清空。可同次 stage 规则与完整 item，真实方法仍保留 fields.method。",
            ],
            writable_paths: [`/items/${itemIndex}/sampling`, "/sampling_rules"],
            preserve_fields: ["fields.requirement", "fields.method", "fields.quantity", "实际适用的条件与抽样来源"],
            do_not_edit: "不可变证据及编译生成的 rule/branch/receiver IDs；不得只删来源来消除跨记录报错",
            next_tool: "stage_target_selector_draft",
            expected_structure: {
              applies_when: "choosing_the_shared_rule_repair",
              affected_item_count: 1,
              other_items: "preserve_unchanged",
              sampling_rule_count: "declare_or_reuse_one_applicable_rule",
              branch_count: "one_or_more_as_required_by_the_source_conditions",
            },
            do_not_create_acceptance_items_for_sampling_conditions: true,
          },
        });
      }
    }
    const resolvedCompleteSpan = completeSpan ?? sourceSpans[0] ?? { evidence_id: "", start: 0, end: 1 };
    const sourceKey = completeSpan
      ? addResolvedNode(`${ruleKey}:source`, "sampling_rule", completeSpan, "", item.sampling.reason)
      : "";
    return [{
      key: ruleKey,
      source_semantic_key: sourceKey,
      complete_span: resolvedCompleteSpan,
      branches: [{
        key: branchKey,
        applies_to_category: appliesToCategory,
        min_sampling: quantity,
        script: deriveSamplingScript(quantity, script, condition, appliesToCategory),
        components: [
          { key: `${branchKey}:quantity`, role: "quantity", disposition: "present",
            spans: selectorSpans(item.sampling.quantity_span_ids, registry, sources, `/items/${itemIndex}/sampling/quantity_span_ids`, issues), reason: item.sampling.reason },
          { key: `${branchKey}:basis`, role: "note", disposition: "present",
            spans: selectorSpans(item.sampling.script_span_ids, registry, sources, `/items/${itemIndex}/sampling/script_span_ids`, issues), reason: item.sampling.reason },
        ],
        span: selectorSpans(item.sampling.script_span_ids, registry, sources, `/items/${itemIndex}/sampling/script_span_ids`, issues)[0]
          ?? sourceSpans[0]
          ?? { evidence_id: "", start: 0, end: 1 },
        conditions: condition ? [{
          key: `${branchKey}:condition`,
          text: condition,
          span: selectorSpans(item.sampling.condition_span_ids, registry, sources, `/items/${itemIndex}/sampling/condition_span_ids`, issues)[0]
            ?? sourceSpans[0]
            ?? { evidence_id: "", start: 0, end: 1 },
        }] : [],
      }],
      shared_conditions: [],
      reason: item.sampling.reason,
    }];
  });
  const samplingRules: SemanticDecisionPlan["sampling_rules"] = [
    ...declaredSamplingRules,
    ...explicitSamplingRules,
  ];

  const samplingRuleByKey = new Map(selectors.sampling_rules.map((rule) => [rule.key, rule]));
  const inheritedTableTitleSpanIds = new Map<string, string[]>();
  for (const tableKey of unique(selectors.items.flatMap((item) => item.table ? [item.table.table_key] : []))) {
    const owners = selectors.items.filter((item) => item.table?.table_key === tableKey);
    const fragmentIds = selectorTableFragmentIds(
      owners,
      registry,
      manifest,
      options.eligibleTableEvidenceIds,
    );
    const structureTitleSpanIds = tableStructureForTitle(tableKey, fragmentIds, options.tableStructurePlan)
      ?.formal_title_span_ids ?? [];
    const authoredTitleSpanIds = unique([
      ...owners.flatMap((item) => item.table?.properties.table_title_span_ids ?? []),
      ...structureTitleSpanIds,
    ]);
    inheritedTableTitleSpanIds.set(tableKey, logicalTableTitleSpanIds(
      authoredTitleSpanIds,
      fragmentIds,
      registry,
      manifest,
      sources,
      `/table_assembly/${tableKey}/title`,
      issues,
    ));
  }
  const fields = ["name", "requirement", "method", "quantity", "note"] as const;
  // Retain unfinished items while validating fields and reference receivers.
  // pending is author-only: it is never converted to a final sampling decision.
  type CompilingItem = Omit<SemanticDecisionPlan["items"][number], "sampling"> & {
    sampling: Omit<SemanticDecisionPlan["items"][number]["sampling"], "status"> & {
      status: TargetSelectorPlan["items"][number]["sampling"]["status"];
    };
  };
  const items: CompilingItem[] = selectors.items.map((item, itemIndex) => {
    const namePath = item.name_path?.map(part => part.trim());
    if (namePath && (namePath.some(part => !part)
      || item.fields.name.composition !== "semantic_summary" || !item.fields.name.span_ids.length)) {
      issues.push({
        code: "selector_name_path_binding", path: `/items/${itemIndex}/name_path`,
        message: "多级名称必须由非空层级组成，并由 fields.name 以 semantic_summary 绑定各级真实来源。",
        details: {
          actual: { name_path: item.name_path, name_binding: item.fields.name },
          writable_paths: [`/items/${itemIndex}/name_path`, `/items/${itemIndex}/fields/name`],
          required_action: ITEM_NAME_PATH_GUIDANCE,
          next_tools: ["read_target_selectors", "stage_target_selector_draft"],
          how_to_pass: "移除空白占位或补入有原文依据的真实层级；用 fields.name.composition=semantic_summary 和非空 span_ids 绑定名称来源后保存完整 item，再执行原验证。若无多级名称可省略 name_path。保留原判据、条件分支、检验批及其他正确字段。",
          do_not_edit: "不可变原文、编译产物及来源登记",
        },
      });
    }
    const compiledFields = Object.fromEntries(fields.map((field) => {
      const selected = item.fields[field];
      const spans = selectorSpans(selected.span_ids, registry, sources, `/items/${itemIndex}/fields/${field}/span_ids`, issues);
      if (field !== "name" && selected.composition === "semantic_summary") issues.push({
        code: "selector_source_fact_summary_forbidden",
        path: `/items/${itemIndex}/fields/${field}/composition`,
        message: "只有项目名称可以使用语义概括；来源事实字段必须精确绑定原文，或在未规定时使用 not_applicable",
        details: {
          field,
          required_action: field === "method"
            ? "用 verbatim/shared_inheritance/reference 绑定原文明示的检验方法；原文未规定方法时用 not_applicable 且 span_ids=[]，不得从验收要求推断方法"
            : "用 verbatim/shared_inheritance/reference 绑定精确原文 span；原文未规定此字段时用 not_applicable 且 span_ids=[]",
        },
      });
      return [field, {
        value: field === "name" && selected.composition === "semantic_summary" ? namePath?.join("\\") ?? item.name : "",
        composition: selected.composition as SourceBindingComposition,
        spans,
        separator: selected.separator,
        reason: selected.reason,
      } satisfies SemanticFieldDecision];
    })) as Record<AcceptanceItemField, SemanticFieldDecision>;
    const isExplicitSampling = item.sampling.status === "explicit";
    const isNotSampling = item.sampling.status === "not_sampling";
    if (isNotSampling && item.sampling.condition_span_ids.length === 0) issues.push({
      code: "selector_not_sampling_basis_missing",
      path: `/items/${itemIndex}/sampling/condition_span_ids`,
      message: "not_sampling 必须有原文明示不做数量抽样的依据；未单列检查数量不能证明不抽样。",
      details: {
        item_key: item.key,
        actual: { status: item.sampling.status, condition_span_ids: item.sampling.condition_span_ids, reason: item.sampling.reason },
        expected: { positive_source_basis_required: true, condition_span_ids: "已登记、适用于本项且明示不做数量抽样的原文 span_ids" },
        writable_collection: "items",
        writable_path: `/items/${itemIndex}/sampling`,
        writable_fields: ["status", "rule_key", "branch_keys", "quantity_span_ids", "script_span_ids", "condition_span_ids", "reason", "confidence"],
        next_tool: "read_target_selectors",
        next_tool_arguments: { collection: "items", key: item.key },
        source_tools: ["open_evidence", "search_global_document_resources", "open_global_document_resource", "locate_evidence_span"],
        save_tool: "stage_target_selector_draft",
        how_to_pass: "先读当前完整 item，再核对本项及适用共同规定，由模型按原文判断。原文明示不做数量抽样时，用 condition_span_ids 绑定精确适用依据并保留 not_sampling；不能用普通验收判据或数量缺失充当该依据。本地可执行数量用 explicit，跨来源或共同规则用 reference；明确要求抽验但未给数量用 reference_unspecified_quantity。完成核对仍无可靠依据才用 fallback；尚未完成核对保留 pending 并继续完成判断。按所选模式保存完整 item 后重试原验证，保留其他正确字段、共同规则及来源，不得虚构数量或仅改状态消错。",
        do_not_edit: "不可变原文、来源登记、编译产物及验证计数；不能在 sealed 结果中直接改状态。",
      },
    });
    const referencedSamplingStatus = item.sampling.status === "reference"
      || item.sampling.status === "reference_unspecified_quantity";
    const quantityText = selectorText(item.fields.quantity.span_ids, registry, sources, `/items/${itemIndex}/fields/quantity/span_ids`, issues);
    if (["not_sampling", "fallback"].includes(item.sampling.status) && isDirectFullInspectionQuantity(quantityText)) issues.push({
      code: "selector_full_inspection_sampling_required",
      path: `/items/${itemIndex}/sampling/status`,
      message: "可见数量字段明确规定全数检查，不能同时分类为不抽样或无依据兜底。",
      details: {
        actual: { status: item.sampling.status, quantity: quantityText, quantity_span_ids: item.fields.quantity.span_ids },
        writable_path: `/items/${itemIndex}/sampling`,
        next_tool: "stage_target_selector_draft",
        how_to_pass: "保留已正确的 quantity 字段。单一同 evidence 的本地全数检查用 explicit，quantity_span_ids 与 script_span_ids 可复用该数量原句；需要跨 evidence 或共同规定时声明完整 sampling_rules，用 reference 选择适用分支及 present quantity。不能删除可见数量或改为 reference_unspecified_quantity。",
        do_not_edit: "编译产物及不可变原文",
      },
    });
    const selectedRule = referencedSamplingStatus
      ? samplingRuleByKey.get(item.sampling.rule_key)
      : undefined;
    if (referencedSamplingStatus && !selectedRule) issues.push({
      code: "selector_sampling_rule_missing",
      path: `/items/${itemIndex}/sampling/rule_key`,
      message: `item ${item.key} 的 sampling.status=${item.sampling.status} 表示引用共享抽样规则，但当前 rule_key=${item.sampling.rule_key || "<空>"} 没有对应的已声明 sampling_rules 记录。`,
      details: {
        required_action: "declare_real_shared_sampling_rule_or_change_item_sampling_mode",
        actual: {
          item_key: item.key,
          status: item.sampling.status,
          rule_key: item.sampling.rule_key,
          branch_keys: item.sampling.branch_keys,
          declared_rule_keys: selectors.sampling_rules.map(rule => rule.key),
        },
        allowed_actions: [
          "原文确实存在跨 item 共享抽样规则时，声明完整且有来源的 sampling_rules 记录，并让本 item 选择真实 rule_key 和适用 branch_keys。",
          "本 item 不应使用共享规则时，按原文把 sampling 改为 explicit、fallback 或 not_sampling 等实际模式，并满足该模式的来源字段约束。",
        ],
        writable_paths: ["/sampling_rules", `/items/${itemIndex}/sampling`],
        candidate_read_tool: "read_target_selectors",
        next_tool: "stage_target_selector_draft",
        how_to_pass: "先用 read_target_selectors 读取 sampling_rules 与当前 item.sampling，再按原文在两种合法修法中选择：若确有共享规则，声明完整、有来源的规则并选择其真实 rule_key/branch_keys；若不应使用共享规则，取消 reference/reference_unspecified_quantity，改用符合原文的其他 sampling 模式及其所需来源。不要编造规则、数量或分支，保存后重新执行原验证。",
        do_not_edit: "不可变原文、编译产物和已正确的验收判据。",
      },
    });
    if (isExplicitSampling && (item.sampling.rule_key || item.sampling.branch_keys.length)) issues.push({ code: "selector_explicit_sampling_has_shared_key", path: `/items/${itemIndex}/sampling`, message: "Explicit item sampling selects source spans directly; compiler generates rule and branch IDs" });
    if (isExplicitSampling && item.sampling.quantity_span_ids.length === 0) issues.push({ code: "selector_explicit_sampling_quantity_missing", path: `/items/${itemIndex}/sampling/quantity_span_ids`, message: "Explicit item sampling requires the exact quantity source span" });
    if (isExplicitSampling && item.sampling.script_span_ids.length === 0) issues.push({ code: "selector_explicit_sampling_script_missing", path: `/items/${itemIndex}/sampling/script_span_ids`, message: "Explicit item sampling requires the exact executable script source span; it may reuse the quantity span" });
    if (!isExplicitSampling && (item.sampling.quantity_span_ids.length || item.sampling.script_span_ids.length || (!isNotSampling && item.sampling.condition_span_ids.length))) issues.push({
      code: "selector_nonexplicit_sampling_has_inline_spans",
      path: `/items/${itemIndex}/sampling`,
      message: referencedSamplingStatus
        ? "共享抽样与项目内直接来源不能混用。先确认选中规则及分支完整承载这些依据，再保留 rule_key/branch_keys，清空项目内三个来源数组；不要删除抽样规则或改成不抽样。"
        : "explicit 允许项目内直接抽样来源，not_sampling 仅用 condition_span_ids 保留明确不抽样的依据。若来源定义可执行抽样，请选择 explicit 或共享引用模式，不要为消除报错直接丢弃依据。",
      details: {
        actual: { ...item.sampling },
        required_action: referencedSamplingStatus
          ? "verify_shared_rule_evidence_then_clear_inline_spans"
          : "choose_sampling_mode_before_clearing_evidence",
        shared_rule_found: Boolean(selectedRule),
        selected_rule_key: item.sampling.rule_key,
        selected_branch_keys: item.sampling.branch_keys,
        required_inline_values_for_current_mode: { quantity_span_ids: [], script_span_ids: [], condition_span_ids: isNotSampling ? item.sampling.condition_span_ids : [] },
        evidence_preservation_required: "先读取选中 sampling_rules 的共同及分支 components；缺规则、缺分支或缺依据时先补齐，不能直接清空唯一依据。",
        writable_paths: [`/items/${itemIndex}/sampling`, "/sampling_rules"],
        preserve: ["已正确的项目名称和判据", "共享规则及适用分支", "数量、程序和条件的原文依据"],
        do_not_edit: "编译产物和不可变原文",
        read_tool: "read_target_selectors",
        next_tool: "stage_target_selector_draft",
      },
    });
    if (["fallback", "not_sampling"].includes(item.sampling.status) && (item.sampling.rule_key || item.sampling.branch_keys.length)) issues.push({
      code: "selector_sampling_fallback_has_source",
      path: `/items/${itemIndex}/sampling`,
      message: "fallback/not_sampling is compiler-fixed and cannot select a rule",
      details: {
        action: "clear_shared_sampling_selection",
        required_values: { rule_key: "", branch_keys: [] },
        preserve_fields: ["status", "quantity_span_ids", "script_span_ids", "condition_span_ids", "reason", "confidence"],
      },
    });
    const submittedBranchKeys = unique(item.sampling.branch_keys);
    const submittedBranchKeySet = new Set(submittedBranchKeys);
    // branch_keys is the selector's explicit semantic choice. Category is only
    // a mechanical eligibility constraint; it does not prove that every branch
    // with that category belongs to this item.
    const selectedBranches = selectedRule?.branches.filter((branch) =>
      submittedBranchKeySet.has(branch.key)
    ) ?? [];
    if (selectedRule) {
      const duplicateBranchKeys = duplicateKeys(item.sampling.branch_keys);
      if (duplicateBranchKeys.length) {
        issues.push({
          code: "selector_sampling_branch_duplicate",
          path: `/items/${itemIndex}/sampling/branch_keys`,
          message: "Sampling branch keys must not contain duplicates",
          details: { duplicate_branch_keys: duplicateBranchKeys },
        });
      }
      if (submittedBranchKeys.length === 0) {
        const ruleIndex = selectors.sampling_rules.findIndex(rule => rule.key === selectedRule.key);
        const hasDeclaredBranches = selectedRule.branches.length > 0;
        issues.push({
          code: "selector_sampling_branch_required",
          path: `/items/${itemIndex}/sampling/branch_keys`,
          message: hasDeclaredBranches ? "共享抽样必须明确选择已声明且适用的分支。" : "引用的共享规则没有任何分支，先补规则，不能从空候选中选择。",
          details: {
            item_key: item.key,
            rule_key: selectedRule.key,
            declared_branch_keys: selectedRule.branches.map((branch) => branch.key),
            required_action: hasDeclaredBranches
              ? "select_every_source_applicable_branch_without_splitting_the_acceptance_item"
              : "declare_default_or_source_branches_then_select_applicable_keys",
            actual: { branch_keys: item.sampling.branch_keys, declared_branch_keys: selectedRule.branches.map(branch => branch.key) },
            writable_path: hasDeclaredBranches ? `/items/${itemIndex}/sampling/branch_keys` : `/sampling_rules/${ruleIndex}/branches`,
            next_tool: "stage_target_selector_draft",
            how_to_pass: hasDeclaredBranches
              ? "按原文适用性选择 declared_branch_keys 中的分支，完整保存当前 item，保留正确判据和数量来源；不能凭类别自动全选。"
              : "先在该 sampling_rules 记录中声明分支。没有业务条件时声明一个默认分支（key 可为 default，applies_to_category 按真实适用范围，components=[] 可继承共同组件），不得虚构条件。随后将接收 item.sampling.branch_keys 设为该 key；共同七类组件和正确来源保持不变。",
            related_writable_path: `/items/${itemIndex}/sampling/branch_keys`,
            do_not_edit: "编译产物及不可变原文",
          },
        });
      }
      const declaredBranchKeys = new Set(selectedRule.branches.map((branch) => branch.key));
      const unknownBranchKeys = submittedBranchKeys.filter((branchKey) => !declaredBranchKeys.has(branchKey));
      if (unknownBranchKeys.length) {
        issues.push({
          code: "selector_sampling_branch_unknown",
          path: `/items/${itemIndex}/sampling/branch_keys`,
          message: "Reference sampling may select only branches declared by its shared rule",
          details: { unknown_branch_keys: unknownBranchKeys },
        });
      }
      const inapplicableBranchKeys = selectedBranches.filter((branch) =>
        branch.applies_to_category !== "all_items" && branch.applies_to_category !== item.category
      ).map((branch) => branch.key);
      if (inapplicableBranchKeys.length) {
        issues.push({
          code: "selector_sampling_branch_category_mismatch",
          path: `/items/${itemIndex}/sampling/branch_keys`,
          message: "Every selected sampling branch must apply to the receiving item category",
          details: { item_category: item.category, inapplicable_branch_keys: inapplicableBranchKeys },
        });
      }
      selectedBranches.forEach((branch) => {
        const ruleIndex = selectors.sampling_rules.findIndex((rule) => rule.key === selectedRule.key);
        const ruleBranchIndex = selectedRule.branches.findIndex((candidate) => candidate.key === branch.key);
        const selectedBranchIndex = item.sampling.branch_keys.indexOf(branch.key);
        const quantitySpanIds = samplingComponentSpanIds(
          effectiveSamplingComponents(selectedRule, branch),
          "quantity",
        );
        const allowsUnspecifiedQuantity = item.sampling.status === "reference_unspecified_quantity";
        const scriptSpanIds = samplingScriptSpanIds(effectiveSamplingComponents(selectedRule, branch));
        const scriptText = selectorText(
          scriptSpanIds,
          registry,
          sources,
          `/items/${itemIndex}/sampling/branch_keys/${selectedBranchIndex}`,
          issues,
        );
        if (allowsUnspecifiedQuantity && scriptSpanIds.length === 0) {
          issues.push({
            code: "selector_sampling_unspecified_script_missing",
            path: `/items/${itemIndex}/sampling/branch_keys/${selectedBranchIndex}`,
            message: "A source-backed sampling obligation with unspecified quantity must still bind the exact inspection instruction",
            details: {
              rule_key: selectedRule.key,
              branch_key: branch.key,
              required_action: "bind_the_exact_sampling_instruction_as_a_present_component",
            },
          });
        }
        if (
          allowsUnspecifiedQuantity
          && /(?:全\s*验|全\s*数\s*(?:检验|检查|验收)|全部\s*(?:检验|检查|验收))/u.test(scriptText)
        ) {
          const scriptComponents = [
            ...selectedRule.components.map((component, index) => ({ component, scope: "shared", path: `/sampling_rules/${ruleIndex}/components/${index}` })),
            ...branch.components.map((component, index) => ({ component, scope: "branch", path: `/sampling_rules/${ruleIndex}/branches/${ruleBranchIndex}/components/${index}` })),
          ].filter(({ component }) => component.disposition === "present" && component.span_ids.some(id => scriptSpanIds.includes(id)))
            .map(({ component, scope, path }) => ({
              scope, path, key: component.key, role: component.role,
              span_ids: component.span_ids.filter(id => scriptSpanIds.includes(id)),
            }));
          issues.push({
            code: "selector_sampling_unspecified_quantity_is_full_inspection",
            path: `/items/${itemIndex}/sampling/branch_keys/${selectedBranchIndex}`,
            message: "当前分支选取的抽样原文包含全验；请先核对它适用于本分支，还是只属于相邻分支。",
            details: {
              item_key: item.key,
              rule_key: selectedRule.key,
              branch_key: branch.key,
              actual_script: scriptText,
              actual: { status: item.sampling.status, script: scriptText, quantity_span_ids: quantitySpanIds, script_components: scriptComponents },
              expected: { quantity: "absent", instruction: "source_backed_and_scoped_to_the_selected_branch_without_inapplicable_full_inspection" },
              affected_item_reads: [{ tool: "read_target_selectors", arguments: { collection: "items", key: item.key } }],
              unchanged_input_note: "actual.script_components 列出当前抽样文本实际使用的作者绑定，包括继承的共享组件；分支内 absent 不会覆盖共享的 present。重复保存相同 item 状态、分支 key 或仅修改 reason，不会移除这些脚本来源，也不会解决当前问题。",
              script_span_ids: scriptSpanIds,
              component_paths: [
                `/sampling_rules/${ruleIndex}/components`,
                `/sampling_rules/${ruleIndex}/branches/${ruleBranchIndex}/components`,
              ],
              repair_options: [
                "若全验适用于本分支，将其精确原文绑定为 present quantity，并把该 item 的 sampling.status 改为 reference。",
                "若全验仅属于相邻分支，用 locate_evidence_span 或 quote_bindings 将本分支的 script/component 缩到真正适用的抽验原文；保留相邻分支的全验数量，不得删除原文义务。",
              ],
              writable_paths: [
                `/sampling_rules/${ruleIndex}/components`,
                `/sampling_rules/${ruleIndex}/branches/${ruleBranchIndex}/components`,
                `/items/${itemIndex}/sampling`,
              ],
              writable_collections: ["sampling_rules", "items"],
              writable_path: `/sampling_rules/${ruleIndex}/components`,
              candidate_read_tools: [
                "read_target_selectors",
                "list_sampling_rules",
                "open_evidence",
                "locate_evidence_span",
              ],
              next_tool: "read_target_selectors",
              next_tool_arguments: { collection: "sampling_rules", key: selectedRule.key },
              next_tools: [
                "read_target_selectors",
                "list_sampling_rules",
                "open_evidence",
                "locate_evidence_span",
                "stage_target_selector_draft",
              ],
              save_tool: "stage_target_selector_draft",
              how_to_pass: "先用 read_target_selectors 读取当前 sampling rule、分支和 affected_item_reads 点名的接收 item；核对 actual.script_components 的真实作者路径、角色和 span，分支 absent 不会覆盖共享 present，仅重存相同 item 不能改变共享脚本来源。需要补查候选时调用 list_sampling_rules，并用 open_evidence 打开 script_span_ids 对应原文。若现有 span 过宽，由模型从已打开原文选择精确子串，再调用 locate_evidence_span 登记，或在 stage_target_selector_draft 的 quote_bindings 中登记。核对适用范围后：若全验适用于本分支，将其精确原文绑定为 present quantity，并把 item.sampling.status 改为 reference；若全验只属于相邻分支，缩小本分支的共享或分支 components，保留 reference_unspecified_quantity 和 absent quantity。用 stage_target_selector_draft 只保存 writable_paths 涉及的 sampling_rules/items 完整记录并重试验证。不要把无可执行数量的抽验指令改成 present quantity，也不要删除相邻分支已经正确的全验数量。",
              do_not_edit: "不可变原文、编译产物、item.fields.quantity 及其他分支已经正确的数量；共享抽样修复只写 writable_paths。",
              required_action: "check_branch_scope_then_bind_quantity_or_narrow_sampling_instruction",
            },
          });
        }
        if (quantitySpanIds.length > 0 && allowsUnspecifiedQuantity) {
          const effectiveQuantityComponents = [
            ...selectedRule.components.map((component, componentIndex) => ({
              scope: "shared" as const,
              path: `/sampling_rules/${ruleIndex}/components/${componentIndex}`,
              key: component.key,
              role: component.role,
              disposition: component.disposition,
              span_ids: component.span_ids,
            })),
            ...branch.components.map((component, componentIndex) => ({
              scope: "branch" as const,
              path: `/sampling_rules/${ruleIndex}/branches/${ruleBranchIndex}/components/${componentIndex}`,
              key: component.key,
              role: component.role,
              disposition: component.disposition,
              span_ids: component.span_ids,
            })),
          ].filter((component) => component.role === "quantity" && component.disposition === "present");
          const quantityEvidenceIds = unique(effectiveQuantityComponents.flatMap((component) => component.span_ids.flatMap((spanId) => {
            const span = registry.spans.find((candidate) => candidate.span_id === spanId);
            return span ? [span.evidence_id] : [];
          })));
          const itemSamplingPath = `/items/${itemIndex}/sampling`;
          const sharedComponentsPath = `/sampling_rules/${ruleIndex}/components`;
          const branchComponentsPath = `/sampling_rules/${ruleIndex}/branches/${ruleBranchIndex}/components`;
          issues.push({
            code: "selector_sampling_unspecified_quantity_has_quantity",
            path: `/items/${itemIndex}/sampling/branch_keys/${selectedBranchIndex}`,
            message: "reference_unspecified_quantity 只能用于原文没有可执行数量的共享抽样；当前选中分支已有 quantity component，请按原文核对 status 与组件处置。",
            details: {
              actual: {
                item_key: item.key,
                sampling_status: item.sampling.status,
                rule_key: selectedRule.key,
                branch_key: branch.key,
                quantity_span_ids: quantitySpanIds,
                effective_quantity_components: effectiveQuantityComponents,
                quantity_evidence_ids: quantityEvidenceIds,
              },
              rule_key: selectedRule.key,
              branch_key: branch.key,
              required_action: "change_status_to_reference_or_remove_the_unsupported_quantity_component",
              allowed_actions: [
                "若读取原文确认当前 rule_key 或 branch_keys 选错，先在 item.sampling 中改为原文支持的真实规则和分支，再按新的选择重新核对数量处置。",
                "原文确认该共享抽样对当前 item 有可执行数量时，将 item.sampling.status 改为 reference，保留对应 present quantity component。",
                "原文确认该抽样义务没有可执行数量时，将对应 shared 或 branch quantity component 的 disposition 改为 absent 或 not_applicable，并将其 span_ids 置为空数组；保留 component 的 key/role，按新的处置更新该 component 的 reason，并保留同一 scope 的其他组件。",
              ],
              component_paths: [sharedComponentsPath, branchComponentsPath],
              writable_path: `${itemSamplingPath}/status`,
              writable_paths: [itemSamplingPath, `${itemSamplingPath}/status`, sharedComponentsPath, branchComponentsPath],
              writable_collections: ["items", "sampling_rules"],
              candidate_read_tool: "read_target_selectors",
              candidate_read_tools: ["read_target_selectors", "list_sampling_rules", "open_evidence", "locate_evidence_span"],
              next_tool: "read_target_selectors",
              next_tool_arguments: { collection: "sampling_rules", key: selectedRule.key },
              next_tools: [
                "read_target_selectors",
                "list_sampling_rules",
                "open_evidence",
                "locate_evidence_span",
                "stage_target_selector_draft",
              ],
              tool_argument_hints: {
                read_target_selectors: [
                  { collection: "sampling_rules", key: selectedRule.key },
                  { collection: "items", key: item.key },
                ],
                list_sampling_rules: { cursor: 0, limit: 100 },
                open_evidence: quantityEvidenceIds.map((evidence_id) => ({ evidence_id, cursor: 0 })),
              },
              save_tool: "stage_target_selector_draft",
              how_to_pass: "先按 tool_argument_hints.read_target_selectors 分别读取完整 sampling_rules（collection=sampling_rules, key=当前 rule_key）和接收 item（collection=items, key=当前 item.key）；必要时按 tool_argument_hints.open_evidence 的真实 evidence_id/cursor 调用 open_evidence，再由模型选择精确原文并调用 locate_evidence_span。若原文显示当前 rule_key 或 branch_keys 选错，先修正 item.sampling 的真实选择；若选择正确，由模型根据原文在两条数量路线中选择：有可执行数量则改 item.sampling.status=reference 并保留 present quantity component；没有可执行数量则将对应 quantity component 改为 disposition=absent 或 not_applicable 且 span_ids=[]，保留 key/role、按新处置更新 reason 及同 scope 其他组件。用 stage_target_selector_draft 提交涉及的完整 items/sampling_rules 记录后重试验证。不得由 harness 判断抽样适用性或数量。",
              do_not_edit: "不可变原文、编译产物、未列出的正确字段及不属于所选规则/分支的其他记录。",
            },
          });
          return;
        }
        if (quantitySpanIds.length > 0 || allowsUnspecifiedQuantity) return;
        issues.push({
          code: "selector_sampling_selected_branch_quantity_missing",
          path: `/items/${itemIndex}/sampling/branch_keys/${selectedBranchIndex}`,
          message: "A selected shared sampling branch must bind an exact quantity component; do not compile an empty min_sampling value",
          details: {
            rule_key: selectedRule.key,
            branch_key: branch.key,
            component_paths: [
              `/sampling_rules/${ruleIndex}/components`,
              `/sampling_rules/${ruleIndex}/branches/${ruleBranchIndex}/components`,
            ],
            required_action: "locate_exact_quantity_component_or_choose_source_supported_sampling_mode",
            source_absence_rule: "First check target and applicable document-wide evidence. A source requiring sampling without a quantity uses reference_unspecified_quantity; only completed checks without reliable support allow fallback. not_sampling requires positive source evidence explicitly excluding quantity sampling; quantity absence alone is insufficient.",
          },
        });
      });
    }
    const selectedMinimum = isExplicitSampling
      ? selectorText(item.sampling.quantity_span_ids, registry, sources, `/items/${itemIndex}/sampling/quantity_span_ids`, issues)
      : unique(selectedBranches.map((branch, branchIndex) => selectorText(
          samplingComponentSpanIds(effectiveSamplingComponents(selectedRule!, branch), "quantity"),
          registry,
          sources,
          `/items/${itemIndex}/sampling/branch_keys/${branchIndex}/components`,
          issues,
        ))).join("；");
    const selectedScript = isExplicitSampling
      ? explicitSamplingRules.find((rule) => rule.key === `explicit:${item.key}`)?.branches[0]?.script ?? ""
      : selectedBranches.length === 1
      ? declaredSamplingRules.find((rule) => rule.key === selectedRule?.key)?.branches.find((branch) => branch.key === selectedBranches[0]?.key)?.script ?? ""
      : "";

    const table = item.table ? (() => {
      const property = item.table!.properties;
      const compileTablePath = (groups: string[][], field: "row_path_span_ids" | "column_path_span_ids"): string[] =>
        groups.map((ids, pathIndex) => {
          const path = `/items/${itemIndex}/table/properties/${field}/${pathIndex}`;
          const issueCount = issues.length;
          const text = compactNavigationText(selectorText(ids, registry, sources, path, issues));
          if (!text && issues.length === issueCount) {
            issues.push({
              code: "selector_table_path_empty", path,
              message: "A selected table path must resolve to non-empty source text.",
              details: {
                actual: { span_ids: ids, resolved_text: text },
                writable_collection: "items", writable_path: path,
                required_action: "绑定能解析出非空原文的真实行/列路径；若原文不需要该方向，由模型移除该空路径元素（整个方向未选择时用 []）。不能保留空白占位或删除其他正确路径。",
                next_tools: ["read_target_selectors", "open_evidence", "locate_evidence_span", "stage_target_selector_draft"],
                do_not_edit: "不可变原文、来源登记和编译产物；保留验收判据及其他正确字段。",
              },
            });
          }
          return text;
        });
      const sharedTitleSpanIds = inheritedTableTitleSpanIds.get(item.table!.table_key)
        ?? property.table_title_span_ids;
      const cellEvidence = ([
        ["table_no", property.table_no_span_ids, "table_no_span_ids"],
        ["table_title", sharedTitleSpanIds, "table_title_span_ids"],
        ["applicability", property.applicability_span_ids, "applicability_span_ids"],
        ...property.row_path_span_ids.map((ids, index) => ["row_header", ids, `row_path_span_ids/${index}`] as const),
        ...property.column_path_span_ids.map((ids, index) => ["column_header", ids, `column_path_span_ids/${index}`] as const),
        ["unit", property.unit_span_ids, "unit_span_ids"],
        ["condition", property.condition_span_ids, "condition_span_ids"],
        ["allowed_value", property.allowed_value_span_ids, "allowed_value_span_ids"],
        ["inspection_method", property.inspection_method_span_ids, "inspection_method_span_ids"],
      ] as Array<[TableCellEvidenceRole, readonly string[], string]>).flatMap(([role, spanIds, propertyPath]) =>
        selectorSpans(spanIds, registry, sources, `/items/${itemIndex}/table/properties/${propertyPath}`, issues).map((span) => ({ role, span }))
      );
      return {
        source_kind: item.table!.source_kind as TableCriterionSourceKind,
        table_key: item.table!.table_key,
        table_no: compactNavigationText(selectorText(property.table_no_span_ids, registry, sources, `/items/${itemIndex}/table/properties/table_no_span_ids`, issues)),
        table_title: compactNavigationText(selectorText(sharedTitleSpanIds, registry, sources, `/items/${itemIndex}/table/properties/table_title_span_ids`, issues)),
        applicability: compactNavigationText(selectorText(property.applicability_span_ids, registry, sources, `/items/${itemIndex}/table/properties/applicability_span_ids`, issues)),
        row_path: compileTablePath(property.row_path_span_ids, "row_path_span_ids"),
        column_path: compileTablePath(property.column_path_span_ids, "column_path_span_ids"),
        unit: selectorText(property.unit_span_ids, registry, sources, `/items/${itemIndex}/table/properties/unit_span_ids`, issues),
        condition: selectorText(property.condition_span_ids, registry, sources, `/items/${itemIndex}/table/properties/condition_span_ids`, issues),
        allowed_value: selectorText(property.allowed_value_span_ids, registry, sources, `/items/${itemIndex}/table/properties/allowed_value_span_ids`, issues),
        ...(property.acceptance_branches?.length ? {
          acceptance_branches: property.acceptance_branches.map((branch, branchIndex) => ({
            key: branch.key,
            condition: selectorText(branch.condition_span_ids, registry, sources, `/items/${itemIndex}/table/properties/acceptance_branches/${branchIndex}/condition_span_ids`, issues),
            requirement: selectorText(branch.requirement_span_ids, registry, sources, `/items/${itemIndex}/table/properties/acceptance_branches/${branchIndex}/requirement_span_ids`, issues),
            allowed_value: selectorText(branch.allowed_value_span_ids, registry, sources, `/items/${itemIndex}/table/properties/acceptance_branches/${branchIndex}/allowed_value_span_ids`, issues),
            condition_spans: selectorSpans(branch.condition_span_ids, registry, sources, `/items/${itemIndex}/table/properties/acceptance_branches/${branchIndex}/condition_span_ids`, issues),
            requirement_spans: selectorSpans(branch.requirement_span_ids, registry, sources, `/items/${itemIndex}/table/properties/acceptance_branches/${branchIndex}/requirement_span_ids`, issues),
            allowed_value_spans: selectorSpans(branch.allowed_value_span_ids, registry, sources, `/items/${itemIndex}/table/properties/acceptance_branches/${branchIndex}/allowed_value_span_ids`, issues),
          })),
        } : {}),
        inspection_method: selectorText(property.inspection_method_span_ids, registry, sources, `/items/${itemIndex}/table/properties/inspection_method_span_ids`, issues),
        cell_evidence: cellEvidence,
        reference_spans: selectorSpans(item.table!.reference_span_ids, registry, sources, `/items/${itemIndex}/table/reference_span_ids`, issues),
      };
    })() : null;
    return {
      key: item.key,
      lot_key: item.lot_key,
      ...(namePath ? { name_path: namePath } : {}),
      category: item.category,
      fields: compiledFields,
      primary_spans: selectorSpans(unique([...item.criterion_span_ids, ...item.continuation_span_ids]), registry, sources, `/items/${itemIndex}/criterion_span_ids`, issues),
      table,
      inspection_data_type: item.inspection_data_type,
      inspection_data_type_reason: item.inspection_data_type_reason,
      inspection_data_type_spans: selectorSpans(item.inspection_data_type_span_ids, registry, sources, `/items/${itemIndex}/inspection_data_type_span_ids`, issues),
      sampling: {
        status: item.sampling.status,
        min_sampling: ["pending", "reference_unspecified_quantity", "fallback", "not_sampling"].includes(item.sampling.status) ? "" : selectedMinimum,
        script: item.sampling.status === "pending" ? "" : samplingScriptForStatus(item.sampling.status, selectedScript),
        reason: item.sampling.reason,
        confidence: item.sampling.status === "pending" ? 0 : samplingConfidenceForStatus(item.sampling.status, item.sampling.confidence),
        evidence_spans: isExplicitSampling || isNotSampling
          ? selectorSpans(unique([
            ...item.sampling.quantity_span_ids,
            ...item.sampling.script_span_ids,
            ...item.sampling.condition_span_ids,
          ]), registry, sources, `/items/${itemIndex}/sampling`, issues)
          : selectedRule
          ? selectorSpans(unique([
              ...selectedRule.complete_span_ids,
              ...samplingComponentSpanIds(selectedRule.components),
              ...selectedBranches.flatMap((branch) => samplingComponentSpanIds(branch.components)),
            ]), registry, sources, `/items/${itemIndex}/sampling`, issues)
          : [],
        rule_keys: isExplicitSampling ? [`explicit:${item.key}`] : selectedRule ? [selectedRule.key] : [],
        branch_keys: isExplicitSampling ? ["explicit"] : selectedBranches.map((branch) => branch.key),
      },
    };
  });

  // Applicability and conditions can belong to the referring table. Preserve
  // their cell provenance, but do not use them to identify the referenced table.
  const tableAssemblySpanIds = (item: TargetSelectorPlan["items"][number]): string[] => item.table ? [
    ...(item.table.source_kind === "reference" ? [] : item.criterion_span_ids),
    ...Object.entries(item.table.properties)
      .filter(([role]) => item.table!.source_kind !== "reference"
        || !["applicability_span_ids", "condition_span_ids"].includes(role))
      .flatMap(([, value]) => value.flat(2))
      .filter((value): value is string => typeof value === "string"),
  ] : [];
  const tableKeys = unique(selectors.items.flatMap((item) => item.table ? [item.table.table_key] : []));
  const tableCandidates = tableKeys.map((tableKey) => {
    const owners = selectors.items.filter((item) => item.table?.table_key === tableKey);
    const fragmentIds = selectorTableFragmentIds(
      owners,
      registry,
      manifest,
      options.eligibleTableEvidenceIds,
    );
    return { tableKey, owners, fragmentIds };
  });
  const tableGroups = groupTableCandidatesByFragment(tableCandidates) as Array<typeof tableCandidates>;
  const tableOwnerByFragment = new Map<string, string>();
  for (const group of tableGroups) {
    const owner = group[0]!.tableKey;
    for (const fragmentId of unique(group.flatMap((candidate) => candidate.fragmentIds))) {
      tableOwnerByFragment.set(fragmentId, owner);
    }
  }
  const tableAssembly: SemanticDecisionPlan["table_assembly"] = {
    tables: tableGroups.map((group) => {
      const tableKey = group[0]!.tableKey;
      const owners = group.flatMap((candidate) => candidate.owners);
      const fragmentIds = unique(group.flatMap((candidate) => candidate.fragmentIds));
      const rowRoles = options.confirmedTableRowRoles === false ? []
        : confirmedTableRowRoles(options.tableStructurePlan, fragmentIds, manifest, registry);
      const confirmedHeaderIds = rowRoles.filter(row => row.role === "header" || row.role === "repeated_header")
        .map(row => row.evidence_id);
      const structureTitleSpanIds = group.flatMap((candidate) =>
        tableStructureForTitle(candidate.tableKey, candidate.fragmentIds, options.tableStructurePlan)
          ?.formal_title_span_ids ?? []
      );
      const authoredTitleSpanIds = unique([
        ...owners.flatMap((item) => item.table?.properties.table_title_span_ids ?? []),
        ...structureTitleSpanIds,
      ]);
      const candidateEvidenceSpanIds = unique(owners.flatMap(tableAssemblySpanIds));
      const titleSpanIds = logicalTableTitleSpanIds(
        authoredTitleSpanIds,
        fragmentIds,
        registry,
        manifest,
        sources,
        `/table_assembly/${tableKey}/title`,
        issues,
      );
      const allowedPhysicalEvidenceIds = new Set([...confirmedHeaderIds, ...fragmentIds.flatMap((fragmentId) => {
        const fragment = manifest.table_fragments.find((candidate) => candidate.fragment_id === fragmentId);
        return fragment ? [
          ...fragment.title_candidate_evidence_ids,
          ...(fragment.continuation_caption_evidence_ids ?? []),
          ...fragment.header_evidence_ids,
          ...fragment.formal_row_evidence_ids,
        ] : [];
      })]);
      const structuralTableEvidenceIds = unique([...confirmedHeaderIds, ...fragmentIds.flatMap((fragmentId) => {
        const fragment = manifest.table_fragments.find((candidate) => candidate.fragment_id === fragmentId);
        return fragment ? [
          ...(fragment.continuation_caption_evidence_ids ?? []),
          ...fragment.header_evidence_ids,
        ] : [];
      })]);
      const structuralTableSpanIds = structuralTableEvidenceIds.flatMap((evidenceId) => {
          const evidence = manifest.evidence.find((record) => record.evidence_id === evidenceId);
          if (!evidence) return [];
          const complete = registry.spans.filter((span) =>
            span.evidence_id === evidenceId
            && span.start === 0
            && span.end === evidence.text.length
          );
          return complete.length === 1 ? [complete[0]!.span_id] : [];
      });
      const evidenceSpanIds = fragmentIds.length
        ? unique([...candidateEvidenceSpanIds.filter((spanId) => {
            const evidenceId = registry.spans.find((span) => span.span_id === spanId)?.evidence_id ?? "";
            return allowedPhysicalEvidenceIds.has(evidenceId);
          }), ...structuralTableSpanIds])
        : candidateEvidenceSpanIds;
      const evidenceSpans = selectorSpans(evidenceSpanIds, registry, sources, `/table_assembly/${tableKey}/evidence`, issues);
      const representedEvidenceIds = new Set(evidenceSpans.map(span => span.evidence_id));
      for (const fragmentId of fragmentIds) {
        const fragment = manifest.table_fragments.find(candidate => candidate.fragment_id === fragmentId)!;
        if (fragment.formal_row_evidence_ids.some(id => representedEvidenceIds.has(id))) continue;
        // A selected title can own a physical fragment while all authored facts
        // come from its continuation. Retain one structural row only when that
        // fragment has no authored row. This adds provenance, not an item or a
        // requirement, and must work even without a registered full-row span.
        const anchor = fragment.formal_row_evidence_ids
          .filter(id => !options.eligibleTableEvidenceIds || options.eligibleTableEvidenceIds.has(id))
          .map(id => manifest.evidence.find(record => record.evidence_id === id))
          .find(record => record && record.text.length > 0);
        if (anchor) evidenceSpans.push({ evidence_id: anchor.evidence_id, start: 0, end: anchor.text.length });
      }
      return {
        key: tableKey,
        canonical_title: selectorText(titleSpanIds, registry, sources, `/table_assembly/${tableKey}/title`, issues),
        title_spans: selectorSpans(titleSpanIds, registry, sources, `/table_assembly/${tableKey}/title`, issues),
        evidence_spans: evidenceSpans,
        fragment_ids: fragmentIds,
        ...(rowRoles.length ? { row_roles: rowRoles } : {}),
        reason: owners.map((item) => item.table?.reason ?? "").filter(Boolean).join("；"),
        confidence: 1,
        ...(rowRoles.length ? { row_roles: rowRoles } : {}),
      };
    }),
    fragment_dispositions: manifest.table_fragments.map((fragment) => {
      const owner = tableOwnerByFragment.get(fragment.fragment_id);
      return { fragment_id: fragment.fragment_id, disposition: owner ? "assigned" as const : "context" as const, table_key: owner ?? "", reason: owner ? "物理片段与已选择的表格语义 span 共用不可变证据" : "物理表格形状仅作导航，未被业务 selector 采用" };
    }),
  };

  const references: SemanticDecisionPlan["references"] = [];
  const occurrenceResolutions: SemanticDecisionPlan["occurrence_resolutions"] = [];
  selectors.references.forEach((reference, referenceIndex) => {
    // Register every exact local anchor as semantic provenance. The compact
    // reference contract still uses the first anchor as the parent/root of the
    // shared target nodes, but additional anchors must not disappear merely
    // because they no longer pollute destination display fields.
    const anchorKeys = reference.anchor_span_ids.map((spanId, spanIndex) => addNode(`${reference.key}:anchor`, "reference_anchor", spanId, "", reference.reason, `/references/${referenceIndex}/anchor_span_ids/${spanIndex}`));
    const anchorSpans = selectorSpans(
      reference.anchor_span_ids,
      registry,
      sources,
      `/references/${referenceIndex}/anchor_span_ids`,
      issues,
    );
    const targetSpans = selectorSpans(
      reference.target_span_ids,
      registry,
      sources,
      `/references/${referenceIndex}/target_span_ids`,
      issues,
    );
    const immutableOccurrence = reference.occurrence_id
      ? occurrenceById.get(reference.occurrence_id)
      : undefined;
    // Component dispositions already bind referenced target spans to real items. Reuse that
    // proof only for a uniquely owned referenced-table item carrying the complete local anchor;
    // the authored occurrence resolution and its business-field destinations stay unchanged.
    const componentOwnersBySpan = new Map<string, Set<string>>();
    for (const disposition of reference.component_dispositions ?? []) {
      if (disposition.decision === "not_applicable") continue;
      for (const spanId of disposition.component_span_ids) {
        const owners = componentOwnersBySpan.get(spanId) ?? new Set<string>();
        disposition.item_keys.forEach((itemKey) => owners.add(itemKey));
        componentOwnersBySpan.set(spanId, owners);
      }
    }
    const componentTableRouteItemKeys = new Set<string>();
    if (immutableOccurrence?.status === "resolved" && immutableOccurrence.reference_kind === "clause") {
      for (const disposition of reference.component_dispositions ?? []) {
        if (disposition.decision === "not_applicable" || disposition.item_keys.length !== 1) continue;
        const itemKey = disposition.item_keys[0]!;
        const receivingItem = selectors.items.find((item) => item.key === itemKey);
        const componentSpans = disposition.component_span_ids.flatMap((spanId) => {
          const span = selectorSpanById.get(spanId);
          return span ? [{ spanId, span }] : [];
        });
        const itemSpans = realItemCoverageSpansByKey.get(itemKey) ?? [];
        if (
          componentSpans.length === 0
          || componentSpans.length !== disposition.component_span_ids.length
          || componentSpans.some(({ spanId, span }) => (
            !reference.target_span_ids.includes(spanId)
            || componentOwnersBySpan.get(spanId)?.size !== 1
            || !coveredBySpans(span, itemSpans)
          ))
        ) continue;
        if (
          receivingItem?.table?.source_kind !== "reference"
          || !reference.anchor_span_ids.every((spanId) => receivingItem.table!.reference_span_ids.includes(spanId))
        ) continue;
        componentTableRouteItemKeys.add(itemKey);
      }
    }
    const targetKeysByAnchor = anchorKeys.map((anchorKey, anchorIndex) =>
      reference.target_span_ids.map((spanId, spanIndex) => addNode(
        `${reference.key}:target:${anchorIndex}`,
        "referenced_clause",
        spanId,
        "",
        reference.reason,
        `/references/${referenceIndex}/target_span_ids/${spanIndex}`,
        anchorKey,
      ))
    );
    reference.destinations.forEach((destination, destinationIndex) => {
      if (!["name", "requirement", "method", "quantity", "note"].includes(destination.target_field)) return;
      const receivingItem = items.find((item) => item.key === destination.item_key);
      if (!receivingItem) {
        const destinationPath = `/references/${referenceIndex}/destinations/${destinationIndex}`;
        issues.push({
          code: "selector_reference_destination_missing",
          path: `${destinationPath}/item_key`,
          message: "引用 destination 指向的 item_key 在当前真实验收项中不存在。请读取当前 items 后，修正为原文实际接收该引用的既有 item，或删除这条不成立的 destination。",
          details: {
            reference_key: reference.key,
            occurrence_id: reference.occurrence_id,
            unknown_item_key: destination.item_key,
            target_field: destination.target_field,
            required_action: "repair_or_remove_the_unknown_reference_destination_from_source_evidence",
            allowed_actions: [
              "原文表明该引用应由某个现有真实 item 接收时，把 item_key 改为该真实接收项，并同步核对 target_field 与 component_dispositions。",
              "原文表明当前 destination 不成立时，删除这条 destination，并同步移除只为它保留的 component_dispositions；若因此没有接收项，再按 destination_required 回条重新判断引用路线。",
            ],
            writable_paths: [
              destinationPath,
              `/references/${referenceIndex}/component_dispositions`,
            ],
            writable_collections: ["references"],
            candidate_read_tool: "read_target_selectors",
            candidate_read_tools: ["read_target_selectors", "list_reference_occurrences", "open_evidence"],
            next_tool: "read_target_selectors",
            next_tools: ["read_target_selectors", "list_reference_occurrences", "open_evidence", "stage_target_selector_draft"],
            save_tool: "stage_target_selector_draft",
            how_to_pass: "先用 read_target_selectors 读取当前 reference、报错 destination 和现有 items，再用 list_reference_occurrences 核对 occurrence；必要时用 open_evidence 查看来源原文。由模型依据原文选择 allowed_actions，不得猜测 item_key。用 stage_target_selector_draft 保存当前 destination 或 references 集合后，重新执行原验证。",
            do_not_edit: "不可变 occurrence、原文、编译产物和无关的正确 items；harness 不提供或选择业务接收项。",
          },
        });
        return;
      }
      // Reference anchors identify why and where a referenced source applies;
      // they are provenance, not display-field content. A prose replace_field
      // projection therefore replaces the selected field with the exact target
      // spans only. Referenced-table items already bind their displayed values
      // through typed table/field selectors, so an explicit reference must not
      // overwrite those values (for example, with a table caption). reference_only
      // describes reference routing without mutating
      // the anchor item.
      if (
        (reference.application_mode as string) !== "replace_field"
        || receivingItem.table?.source_kind === "reference"
      ) return;
      const field = destination.target_field as AcceptanceItemField;
      const receivingField = receivingItem.fields[field];
      receivingField.composition = "reference";
      receivingField.spans = [...new Map(
        targetSpans.map((span) => [
          `${span.evidence_id}\0${span.start}\0${span.end}`,
          span,
        ]),
      ).values()];
    });
    const hasExpansionTargets = reference.target_span_ids.length > 0;
    const referenceStatus = reference.action === "review"
      ? "review" as const
      : hasExpansionTargets
      ? "resolved" as const
      : "not_applicable" as const;
    const itemCarriesAnchor = (
      item: Pick<SemanticDecisionPlan["items"][number], "primary_spans" | "fields" | "table">,
      anchor: EvidenceSpanDecision,
      exact: boolean,
    ): boolean => {
      const spans = [
        ...item.primary_spans,
        ...Object.values(item.fields).flatMap((decision) => decision.spans),
        ...(item.table?.cell_evidence.map((cell) => cell.span) ?? []),
        ...(item.table?.reference_spans ?? []),
      ];
      return spans.some((span) => exact
        ? span.evidence_id === anchor.evidence_id
          && span.start === anchor.start
          && span.end === anchor.end
        : span.evidence_id === anchor.evidence_id
      );
    };
    anchorKeys.forEach((anchorKey, anchorIndex) => {
      const anchorSpan = anchorSpans[anchorIndex];
      const exactDestinations = anchorSpan
        ? reference.destinations.filter((destination) => {
            const receivingItem = items.find((item) => item.key === destination.item_key);
            return Boolean(receivingItem && itemCarriesAnchor(receivingItem, anchorSpan, true));
          })
        : [];
      const evidenceDestinations = exactDestinations.length || !anchorSpan
        ? []
        : reference.destinations.filter((destination) => {
            const receivingItem = items.find((item) => item.key === destination.item_key);
            return Boolean(receivingItem && itemCarriesAnchor(receivingItem, anchorSpan, false));
          });
      const localDestinations = exactDestinations.length
        ? exactDestinations
        : evidenceDestinations.length
        ? evidenceDestinations
        : reference.destinations;
      const destinationsByItem = localDestinations.reduce((byItem, destination) => {
        const receivingSelector = selectors.items.find((item) => item.key === destination.item_key);
        const projectedField = (reference.application_mode as string) === "replace_field"
          && receivingSelector?.table?.source_kind !== "reference"
          ? destination.target_field as ReferenceTargetField
          : "reference_only" as const;
        const fields = byItem.get(destination.item_key) ?? [];
        byItem.set(destination.item_key, unique([...fields, projectedField]) as ReferenceTargetField[]);
        return byItem;
      }, new Map<string, ReferenceTargetField[]>());
      for (const itemKey of componentTableRouteItemKeys) {
        const fields = destinationsByItem.get(itemKey) ?? [];
        destinationsByItem.set(itemKey, unique([...fields, "reference_only"]) as ReferenceTargetField[]);
      }
      const semanticDestinations = [...destinationsByItem].map(([itemKey, fields]) => ({
        item_key: itemKey,
        fields,
      }));
      references.push({
        key: anchorKeys.length === 1 ? reference.key : `${reference.key}:anchor:${anchorIndex}`,
        anchor_key: anchorKey,
        status: referenceStatus,
        import_scope: reference.import_scope as ReferenceImportScope,
        target_keys: targetKeysByAnchor[anchorIndex] ?? [],
        destinations: referenceStatus === "resolved" ? semanticDestinations : [],
        reason: reference.reason,
      });
    });
    const anchorEvidenceIds = unique(resolvedSpans(reference.anchor_span_ids, registry, sources, `/references/${referenceIndex}/anchor_span_ids`, issues).map((span) => span.evidence_id));
    const byOrigin = manifest.reference_occurrences.filter((occurrence) =>
      referenceOccurrenceOriginEvidenceIds(occurrence).every((evidenceId) => anchorEvidenceIds.includes(evidenceId))
    );
    // 一条条文引两张表是常态（`表格形式与内容宜符合表 8.0.7-1 和表 8.0.7-2 的规定`），
    // 两个 occurrence 的 origin_evidence_id 是同一条，只按来源证据匹配必然歧义——
    // 模型无论怎么锚都命中 2 个，永远生成不了解析记录，reference_resolution_missing
    // 永远在，于是死循环（GB/T 50312 实测三个目标各撞 48、40、25 次）。
    // 引用条目本来就带 target_span_ids，指着被引表的行：用它消歧。
    const targetEvidenceIds = new Set(
      resolvedSpans(reference.target_span_ids, registry, sources, `/references/${referenceIndex}/target_span_ids`, issues)
        .map((span) => span.evidence_id),
    );
    const byTarget = byOrigin.filter((occurrence) =>
      occurrence.target_evidence_ids.some((evidenceId) => targetEvidenceIds.has(evidenceId))
    );
    // 作者点名的优先。target_span_ids 消歧只在跨度恰好落在被引表行上时成立，
    // 而正文路的可选跨度是整块原子，落不到行上——那条路留着，但不能是唯一的路。
    const named = reference.occurrence_id
      ? byOrigin.filter((occurrence) => occurrence.occurrence_id === reference.occurrence_id)
      : [];
    if (reference.occurrence_id && named.length !== 1) {
      issues.push({
        code: "selector_reference_occurrence_not_found",
        path: `/references/${referenceIndex}/occurrence_id`,
        message: "occurrence_id 必须指向 anchor_span_ids 已覆盖来源中的不可变 occurrence。请读取 list_reference_occurrences 并逐字复制正确 ID；不得猜测或改写。",
        details: {
          occurrence_id: reference.occurrence_id,
          anchored_occurrence_ids: byOrigin.map((entry) => entry.occurrence_id),
        },
      });
    }
    const occurrences = named.length === 1
      ? named
      : byOrigin.length > 1 && byTarget.length === 1
        ? byTarget
        : byOrigin;
    if (occurrences.length > 1) {
      issues.push({
        code: "selector_reference_ambiguous",
        path: `/references/${referenceIndex}/anchor_span_ids`,
        message: "引用 anchor 命中多个不可变 occurrence；同一条可能引用多个表。必须填写当前引用对应的 occurrence_id 进行消歧，各引用保留各自字段路径和精确位置，不能合并。",
        details: {
          occurrence_ids: occurrences.map((entry) => entry.occurrence_id),
          target_locators: occurrences.map((entry) => entry.reference_kind === "table"
            ? `table:${entry.target_table_id}`
            : `${entry.target_address.source_id}:${entry.target_address.locator}`),
        },
      });
    }
    if (occurrences.length === 1) {
      const originBinding = referenceOriginBindings.get(referenceIndex);
      occurrenceResolutions.push({
        key: reference.key,
        occurrence_id: occurrences[0]!.occurrence_id,
        action: reference.action as ReferenceResolutionAction,
        application_mode: reference.application_mode as ReferenceApplicationMode,
        import_scope: reference.import_scope as ReferenceImportScope,
        target_spans: selectorSpans(reference.target_span_ids, registry, sources, `/references/${referenceIndex}/target_span_ids`, issues),
        ...(originBinding ? { origin_binding: originBinding } : {}),
        destinations: reference.destinations.map((destination) => ({ item_key: destination.item_key, target_field: destination.target_field as ReferenceTargetField })),
        reason: reference.reason,
      });
    }
  });

  selectors.items.forEach((item, itemIndex) => {
    if (item.table?.source_kind !== "reference") return;
    const targetSpanIds = unique(
      Object.values(item.table.properties)
        .flat(2)
        .filter((value): value is string => typeof value === "string"),
    );
    const targetEvidenceIds = new Set(targetSpanIds.flatMap((spanId) => {
      const span = registry.spans.find((candidate) => candidate.span_id === spanId);
      return span ? [span.evidence_id] : [];
    }));
    const placeholder = selectors.references.find((reference) =>
      reference.application_mode === "reference_placeholder"
      && reference.target_span_ids.some((spanId) => {
        const span = registry.spans.find((candidate) => candidate.span_id === spanId);
        return Boolean(span && targetEvidenceIds.has(span.evidence_id));
      })
    );
    if (!placeholder || targetSpanIds.length === 0) return;
    const anchorKey = item.table.reference_span_ids.slice(0, 1).map((spanId, spanIndex) => addNode(
      `table-reference:${item.key}:anchor`,
      "reference_anchor",
      spanId,
      "",
      item.table!.reason,
      `/items/${itemIndex}/table/reference_span_ids/${spanIndex}`,
    ))[0] ?? "";
    const targetKeys = targetSpanIds.map((spanId, spanIndex) => addNode(
      `table-reference:${item.key}:target`,
      "referenced_clause",
      spanId,
      "",
      item.table!.reason,
      `/items/${itemIndex}/table/properties/${spanIndex}`,
      anchorKey,
    ));
    references.push({
      key: `table-reference:${item.key}`,
      anchor_key: anchorKey,
      status: "resolved",
      import_scope: placeholder.import_scope as ReferenceImportScope,
      target_keys: targetKeys,
      destinations: [{ item_key: item.key, fields: ["reference_only"] }],
      reason: item.table.reason,
    });
  });

  // Keep placeholder destinations empty. These are derived field-level source
  // proofs for the real leaf, not imports into a synthetic pointer item.
  selectors.items.forEach((item, itemIndex) => {
    (Object.keys(item.fields) as AcceptanceItemField[]).forEach(field => {
      if (item.fields[field].composition !== "reference") return;
      const proof = placeholderFieldSourceProof(selectors, item, field, manifest, registry);
      // Preserve each proved contribution when ordinary imports supply the
      // other fragments. Local receipt and global field checks still reject
      // any remaining unproved source; one route never authorizes the whole field.
      proof.references.forEach(({ reference: placeholder, span_ids }) => {
        const key = `placeholder-field:${item.key}:${field}${proof.references.length > 1 ? `:${placeholder.key}` : ""}`;
        const anchorKey = addNode(`${key}:anchor`, "reference_anchor", placeholder.anchor_span_ids[0]!, "", placeholder.reason, `/references/${selectors.references.indexOf(placeholder)}/anchor_span_ids/0`);
        const targetKeys = span_ids.map(spanId => addNode(
          `${key}:target`, "referenced_clause", spanId, "", item.fields[field].reason, `/items/${itemIndex}/fields/${field}/span_ids/${item.fields[field].span_ids.indexOf(spanId)}`, anchorKey,
        ));
        references.push({ key, anchor_key: anchorKey, status: "resolved",
          import_scope: { mode: "field_specific", allowed_fields: [field], reason: "真实验收叶已选择的字段来源证明；父占位记录不进行字段导入。" },
          target_keys: targetKeys, destinations: [{ item_key: item.key, fields: [field] }], reason: item.fields[field].reason });
      });
    });
  });

  const dispositionByEvidence = new Map<string, { disposition: "context" | "ignored"; reasons: string[] }>();
  selectors.source_dispositions.forEach((disposition, dispositionIndex) => {
    const evidenceIds = unique(resolvedSpans(
      disposition.span_ids,
      registry,
      sources,
      `/source_dispositions/${dispositionIndex}/span_ids`,
      issues,
    ).map((span) => span.evidence_id));
    for (const evidenceId of evidenceIds) {
      const previous = dispositionByEvidence.get(evidenceId);
      dispositionByEvidence.set(evidenceId, {
        disposition: previous?.disposition === "context" || disposition.disposition === "context"
          ? "context"
          : "ignored",
        reasons: unique([...(previous?.reasons ?? []), disposition.reason]),
      });
    }
  });

  const dispositionCoverage = selectorDispositionCoverage({
    selectors,
    evidence: manifest.evidence,
    spans: registry.spans,
    alreadyDisposedIds: new Set(dispositionByEvidence.keys()),
  });
  // residual 兑现与预检/validator 共用 selectorDispositionCoverage；
  // 绑没绑走同一套 *_span_ids 遍历，兜底只填既没绑也没逐条交代的部分。
  if (dispositionCoverage.residual) {
    for (const evidenceId of dispositionCoverage.residual_evidence_ids) {
      dispositionByEvidence.set(evidenceId, {
        disposition: dispositionCoverage.residual.disposition,
        reasons: [dispositionCoverage.residual.reason],
      });
    }
  }

  // Do not filter unfinished records until all cross-record validation is done.
  // Any such record adds a blocking issue, so no partial plan can be emitted.
  const completedItems: SemanticDecisionPlan["items"] = items.flatMap((item, itemIndex) => {
    const status = item.sampling.status;
    if (status !== "pending") return [{ ...item, sampling: { ...item.sampling, status } }];
    issues.push({
      code: "selector_sampling_decision_pending",
      path: `/items/${itemIndex}/sampling/status`,
      message: `item ${item.key} 的抽样判断尚未完成；pending 可保存草稿，但不能完成抽样阶段或提交成品。`,
      details: {
        item_key: item.key,
        actual: status,
        required_action: "complete_sampling_decision_from_source",
        allowed_statuses: ["explicit", "reference", "reference_unspecified_quantity", "fallback", "not_sampling"],
        writable_collection: "items",
        writable_record_key: item.key,
        writable_path: `/items/${itemIndex}/sampling`,
        writable_paths: [`/items/${itemIndex}/sampling`, "/sampling_rules"],
        writable_collections: ["items", "sampling_rules"],
        next_tool: "read_target_selectors",
        next_tool_arguments: { collection: "items", key: item.key },
        candidate_read_tools: ["read_target_selectors", "list_sampling_rules", "open_evidence"],
        save_tool: "stage_target_selector_draft",
        how_to_pass: SELECTOR_PENDING_SAMPLING_REPAIR_GUIDANCE,
        do_not_edit: "不可变原文、编译产物及其他正确字段；不能删除真实项目或来源来消除未完成状态。",
      },
    });
    return [];
  });
  const internal: SemanticDecisionPlan = {
    schema_version: "semantic-decision-plan/v1",
    job_id: selectors.job_id,
    target_id: selectors.target_id,
    evidence_fingerprint: manifest.evidence_fingerprint,
    table_assembly: tableAssembly,
    lots: selectors.lots.map((lot, lotIndex) => ({
      key: lot.key,
      name: lot.name,
      evidence_spans: selectorSpans(lot.scope_span_ids, registry, sources, `/lots/${lotIndex}/scope_span_ids`, issues),
      reason: lot.reason,
    })),
    items: completedItems,
    semantic_nodes: semanticNodes,
    references,
    sampling_rules: samplingRules,
    occurrence_resolutions: occurrenceResolutions,
    evidence_dispositions: [...dispositionByEvidence].map(([evidenceId, disposition]) => ({
      evidence_id: evidenceId,
      disposition: disposition.disposition,
      reason: disposition.reasons.join("；"),
    })),
  };
  const classified = options.validationBoundary === STRUCTURAL_VALIDATION_BOUNDARY
    ? partitionValidationIssues(issues) : { errors: issues, model_review: [] };
  if (classified.model_review.length) options.onModelReview?.(classified.model_review);
  if (classified.errors.length) throw new TargetSelectorCompileError(classified.errors);
  try {
    const compiled = compileSemanticDecisionsV8(internal, manifest);
    return options.validationBoundary ? { ...compiled, validation_boundary: options.validationBoundary } : compiled;
  } catch (error) {
    if (error instanceof SemanticDecisionCompileError) {
      throw new TargetSelectorCompileError(error.issues.map((issue) => ({
        ...issue,
        code: (typeof issue.code === "string" ? issue.code : "decision_compile_error")
          .replace(/^decision_/, "selector_"),
        path: (typeof issue.path === "string" ? issue.path : "/")
          .replace(/^\/semantic_nodes/, "/items")
          .replace(/^\/occurrence_resolutions/, "/references"),
      })));
    }
    throw error;
  }
}

export function targetSelectorFingerprint(selectors: TargetSelectorPlan): string {
  const { rationale: _rationale, ...facts } = selectors;
  return sha256Text(canonicalize(facts));
}
