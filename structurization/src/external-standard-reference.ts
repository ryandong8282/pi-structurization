import { sha256Text } from "./canonical.js";
import { normalizeStandardNo, standardIdentityMatches, standardNumberTokens, type ExternalSourceWorkflow, type ExternalSourceRequest } from "./external-source-workflow.js";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { externalReferenceExpansionPolicy, externalReferenceFieldPolicy } from "./external-reference-policy.js";
import type { EvidenceManifest } from "./contracts.js";
import { resolveAndRegisterDocumentReference, type DocumentReferenceKind } from "./document-reference.js";
import type { RevisionWorkspace } from "./workspace.js";
import { ExternalReferenceContentScopeSchema, externalReferenceScopeFeedback, parseExternalReferenceScope } from "./external-reference-scope.js";
import { REFERENCE_CORRECTION_FIELDS } from "./reference-correction.js";

export const EXTERNAL_STANDARD_REFERENCE_TOOL = "resolve_external_standard_reference";

export function createExternalStandardReferenceTool(
  dispatch: (input: Record<string, unknown>, toolCallId: string) => Promise<unknown>,
): ToolDefinition {
  return defineTool({
    name: EXTERNAL_STANDARD_REFERENCE_TOOL,
    label: "解析外部标准引用",
    description: "登记另一本标准或其条、节、表、附录的引用。字段策略优先：允许偏差及其对应的“质量检验标准”“设计要求及规范规定”栏中的外部引用只保留完整引用原文、原字段、数值单位和条件，不查找或解析外部文件，即使本地已有正文也不钻取；只有验收依据中要求的引用进入正文核对，再判断与任务产出的相关性。同一规范在不同字段出现时逐处判断，不得把允许偏差的豁免套到验收依据。按 usage 区分普通合规引用和判据、方法、数量对外部正文的依赖；正文依赖先查本地资料，主文档直接依赖缺少正确版本时等待补文件。外部资料中的后续规范引用，本地有可用原文则读取并判断与当前产出的相关性；本地没有则仅保留引用原话，不再请求补文件。资料接入只提供真实证据，不代表全部业务采用或语义批准。标准号单独填写 standard_no；仅引用整本标准时省略 target，不能把标准号填成章节编号。保留原引用及其字段位置；已解析正文使用 read_document_reference_evidence/read_reference_facts 完整读取并按原契约保存真实字段。",
    parameters: Type.Object({
      ...REFERENCE_CORRECTION_FIELDS,
      origin_span_id: Type.Optional(Type.String({ minLength: 1 })),
      origin_span_ids: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 2, maxItems: 3, uniqueItems: true })),
      origin_field: Type.Union([
        Type.Literal("name"),
        Type.Literal("requirement"),
        Type.Literal("method"),
        Type.Literal("quantity"),
        Type.Literal("note"),
        Type.Literal("sampling"),
      ], { description: "外部标准引用字面量实际所在的唯一业务字段。" }),
      reference_literal_span_id: Type.Optional(Type.String({ minLength: 1 })),
      reference_literal_span_ids: Type.Optional(Type.Array(Type.String({ minLength: 1 }), {
        minItems: 2,
        maxItems: 3,
        uniqueItems: true,
        description: "OCR/Markdown 换行拆开的同一引用，按原文顺序提供 2～3 个精确 literal span；程序严格校验同 clause 与行邻接。",
      })),
      raw_reference: Type.String({ minLength: 1, description: "包含标准号和所引用位置的逐字原文，不得编造。" }),
      normalized_reference: Type.Optional(Type.String({ minLength: 1, description: "组合引用的规范化显示值；与精确 literal spans 分开。" })),
      standard_no: Type.String({ minLength: 1, description: "原文明确给出的外部标准号，例如 GB 50208；保留原文有的版本号。" }),
      standard_title: Type.Optional(Type.String({ minLength: 1 })),
      target: Type.Optional(Type.Object({
        kind: Type.Union([Type.Literal("clause"), Type.Literal("section"), Type.Literal("table"), Type.Literal("appendix")]),
        number: Type.String({ minLength: 1 }),
        paragraph: Type.Optional(Type.String({ minLength: 1 })),
      }, { additionalProperties: false })),
      relation: Type.String({ minLength: 1 }),
      usage: Type.Optional(Type.Union([Type.Literal("citation_only"), Type.Literal("content_required")], { description: "citation_only 是普通合规引用；判据、方法或数量实际依赖外部正文时必须选择 content_required。外部资料中的后续引用是否继续展开由真实来源与本地资料决定，不得为停止展开改报 citation_only。" })),
      dependent_fields: Type.Optional(Type.Array(Type.Union([Type.Literal("requirement"), Type.Literal("method"), Type.Literal("quantity"), Type.Literal("sampling")]), { minItems: 1, uniqueItems: true })),
      reason: Type.Optional(Type.String({ minLength: 1, description: "依据真实原文说明为何只是合规引用，或哪个实际字段需要外部正文；不能用空值或斜杠机械推定。" })),
      content_scope: Type.Optional(ExternalReferenceContentScopeSchema),
      scope_catalog_cursor: Type.Optional(Type.Integer({ minimum: 0 })),
    }, { additionalProperties: false }),
    executionMode: "sequential",
    execute: async (id, params) => {
      const output = await dispatch(params as Record<string, unknown>, id);
      return { content: [{ type: "text", text: JSON.stringify(output) }], details: output };
    },
  });
}

export async function registerExternalStandardReference(
  workspace: RevisionWorkspace,
  evidence: EvidenceManifest,
  input: Record<string, unknown>,
  allowAfterValidation = false,
  workflow?: ExternalSourceWorkflow,
): Promise<{ ok: boolean; [key: string]: unknown }> {
  const standardNo = typeof input.standard_no === "string" ? input.standard_no.trim() : "";
  const rawReference = typeof input.raw_reference === "string" ? input.raw_reference : "";
  const normalized = normalizeStandardNo;
  const rawNormalized = normalized(rawReference);
  const standardNormalized = normalized(standardNo);
  const standardMatches = standardNormalized
    ? rawNormalized.split(standardNormalized).length - 1
    : 0;
  const standardTokens = standardNumberTokens(rawReference);
  const possibleSplitStandard = rawNormalized === standardNormalized
    && (typeof input.origin_span_id === "string" || Array.isArray(input.origin_span_ids));
  if (
    !standardNo
    || (!possibleSplitStandard && (
      standardMatches !== 1
      || standardTokens.length !== 1
      || standardTokens[0] !== standardNormalized
    ))
  ) {
    return { ok: false, error: "external_standard_number_not_in_citation", budget_consumed: false,
      actual: { standard_no: standardNo, raw_reference: rawReference, detected_standard_numbers: standardTokens },
      how_to_pass: "standard_no 必须与本次精确引用字面量中的唯一标准号一致，保留原文明示的年份；多本标准分别定位后调用。不得编造或修改来源。",
      writable_paths: ["/standard_no", "/raw_reference", "/reference_literal_span_id", "/reference_literal_span_ids"],
      next_tool: EXTERNAL_STANDARD_REFERENCE_TOOL, do_not_edit: ["source", "compiler", "sealed_artifacts"] };
  }
  const target = input.target;
  if (target !== undefined && (
    !target || typeof target !== "object" || Array.isArray(target)
    || !["clause", "section", "table", "appendix"].includes(String((target as Record<string, unknown>).kind))
    || typeof (target as Record<string, unknown>).number !== "string"
    || !String((target as Record<string, unknown>).number).trim()
    || normalized(String((target as Record<string, unknown>).number)) === normalized(standardNo)
    || (["clause", "section"].includes(String((target as Record<string, unknown>).kind))
      && !/^(?:[A-Z]\.)?\d+(?:\.\d+)*$/iu.test(String((target as Record<string, unknown>).number).normalize("NFKC").replace(/\s+/gu, "")))
  )) {
    return { ok: false, error: "invalid_external_standard_target", budget_consumed: false,
      actual: { target, standard_no: standardNo }, writable_paths: ["/target"],
      how_to_pass: "target 只能填写外部标准内真实的条、节、表或附录编号；条/节使用 2.1.1 或 A.0.1 这类真实编号，不能填 standard 等占位。原文引用整本标准且未指定条、表或附录时省略 target。保留原引用和来源，不猜新编号。",
      next_tool: EXTERNAL_STANDARD_REFERENCE_TOOL, do_not_edit: ["source", "compiler", "sealed_artifacts"] };
  }
  const address = target as Record<string, unknown> | undefined;
  const usage = input.usage;
  const fields = Array.isArray(input.dependent_fields) ? input.dependent_fields.map(String) : [];
  if (workflow && (!["citation_only", "content_required"].includes(String(usage))
    || typeof input.reason !== "string" || !input.reason.trim()
    || (usage === "content_required" && (!fields.length || fields.some(field => !["requirement", "method", "quantity", "sampling"].includes(field)))))) {
    return { ok: false, error: "external_reference_usage_required", budget_consumed: false,
      actual: { usage, dependent_fields: fields }, writable_paths: ["/usage", "/dependent_fields", "/reason"],
      how_to_pass: "按真实原文区分普通合规引用与正文依赖；正文依赖列出 requirement/method/quantity/sampling 中的实际字段并说明原因。",
      next_tool: EXTERNAL_STANDARD_REFERENCE_TOOL, do_not_edit: ["source", "compiler", "sealed_artifacts"] };
  }
  const registry = await workspace.readSourceSpanRegistry();
  const requestedSpanIds = [input.origin_span_id, input.reference_literal_span_id,
    ...(Array.isArray(input.origin_span_ids) ? input.origin_span_ids : []),
    ...(Array.isArray(input.reference_literal_span_ids) ? input.reference_literal_span_ids : []),
  ].filter((id): id is string => typeof id === "string");
  const spanById = new Map(registry.spans.map(span => [span.span_id, span]));
  const originIds = requestedSpanIds.map(id => spanById.get(id)?.evidence_id ?? "");
  const policy = externalReferenceExpansionPolicy(evidence, originIds, { standard_no: standardNo });
  const literalSpanIds = [input.reference_literal_span_id,
    ...(Array.isArray(input.reference_literal_span_ids) ? input.reference_literal_span_ids : [])]
    .filter((id): id is string => typeof id === "string");
  const literalSpans = (literalSpanIds.length ? literalSpanIds : requestedSpanIds).map(id => {
    const span = spanById.get(id);
    if (!span || literalSpanIds.length) return span;
    const text = evidence.evidence.find(row => row.evidence_id === span.evidence_id)?.text.slice(span.start, span.end);
    const start = text?.indexOf(rawReference) ?? -1;
    // A broad origin may cover several fields. Only a unique exact literal narrows it.
    return text !== undefined && start >= 0 && text.indexOf(rawReference, start + 1) < 0
      ? { ...span, start: span.start + start, end: span.start + start + rawReference.length } : span;
  });
  const fieldPolicy = externalReferenceFieldPolicy(evidence,
    literalSpans.every(span => span !== undefined) ? literalSpans : []);
  if (policy.origin_status === "mixed") {
    return { ok: false, error: "reference_origin_crosses_documents", budget_consumed: false,
      actual: { origin_evidence_ids: originIds }, writable_paths: ["/origin_span_id", "/origin_span_ids", "/reference_literal_span_id", "/reference_literal_span_ids"],
      next_tool: "locate_evidence_span", how_to_pass: "同一引用的来源与字面 spans 必须来自同一份已登记资料，按真实原文重新定位；不能拼接主文档和外部资料。" };
  }
  const userIgnore = usage === "content_required" ? await workflow?.ignored?.(standardNo) : undefined;
  let document = workflow && usage === "content_required" && !fieldPolicy.literal_only && !userIgnore ? await workflow.lookup(standardNo) : undefined;
  const identityMismatch = Boolean(document && (normalizeStandardNo(document.standard_no) !== normalizeStandardNo(standardNo)
    || sha256Text(document.markdown) !== document.markdown_sha256 || !standardIdentityMatches(document.markdown, standardNo)));
  if (identityMismatch && !policy.nested_external) {
    return { ok: false, error: "external_document_identity_mismatch", budget_consumed: false,
      actual: { requested_standard_no: standardNo, document_standard_no: document!.standard_no },
      how_to_pass: "补充与原引用标准号、指定年份和正文身份一致的资料；不能替换为其他年份。",
      writable_paths: [], next_action: "add_external_source_file", do_not_edit: ["source", "compiler", "sealed_artifacts"] };
  }
  if (identityMismatch) document = undefined;
  const literalOnly = Boolean(userIgnore) || fieldPolicy.literal_only || Boolean(workflow && usage === "content_required" && policy.nested_external && !document);
  const contentScope = parseExternalReferenceScope(input.content_scope);
  if (!literalOnly && document && !address && usage === "content_required" && !contentScope) {
    const cursor = Number(input.scope_catalog_cursor ?? 0);
    return externalReferenceScopeFeedback(document, input.content_scope, Number.isInteger(cursor) && cursor >= 0 ? cursor : 0);
  }
  if (input.content_scope !== undefined && (!contentScope || address || usage !== "content_required" || literalOnly)) {
    return { ok: false, error: "external_reference_scope_invalid", actual: { content_scope: input.content_scope, target: address ?? null, usage },
      writable_paths: ["/content_scope", "/target"], next_tool: EXTERNAL_STANDARD_REFERENCE_TOOL,
      instruction: "content_scope 只用于无明确 target 的整本标准正文依赖，须有非空 reason。原文已明示条/节/表/附录时保留 target，不得用自选范围替代；纯引文或策略限定引用省略 content_scope。" };
  }
  const expansionReason = userIgnore ? "user_ignored_source" as const : fieldPolicy.literal_only ? "allowable_deviation_reference" as const : "nested_source_unavailable" as const;
  const output = await resolveAndRegisterDocumentReference(workspace, evidence, {
    ...(typeof input.origin_span_id === "string" ? { origin_span_id: input.origin_span_id } : {}),
    ...(Array.isArray(input.origin_span_ids) ? { origin_span_ids: input.origin_span_ids.map(String) } : {}),
    origin_field: (typeof input.origin_field === "string"
      ? input.origin_field
      : "requirement") as "name" | "requirement" | "method" | "quantity" | "note" | "sampling",
    ...(typeof input.reference_literal_span_id === "string" ? { reference_literal_span_id: input.reference_literal_span_id } : {}),
    ...(Array.isArray(input.reference_literal_span_ids)
      ? { reference_literal_span_ids: input.reference_literal_span_ids.map(String) }
      : {}),
    raw_reference: rawReference,
    ...(typeof input.normalized_reference === "string" ? { normalized_reference: input.normalized_reference } : {}),
    relation: String(input.relation ?? ""),
    ...(contentScope ? { content_scope: contentScope } : {}),
    ...(typeof input.replaces_occurrence_id === "string" ? { replaces_occurrence_id: input.replaces_occurrence_id } : {}),
    ...(typeof input.correction_reason === "string" ? { correction_reason: input.correction_reason } : {}),
    external_standard: {
      standard_no: standardNo,
      ...(typeof input.standard_title === "string" ? { standard_title: input.standard_title.trim() } : {}),
      status: document ? "resolved" : "placeholder",
      ...(workflow ? { usage: usage as "citation_only" | "content_required" } : {}),
      ...(literalOnly ? { expansion: "literal_only" as const, expansion_reason: expansionReason } : {}),
      ...(userIgnore ? { user_ignore: userIgnore } : {}),
      ...(document ? { markdown_sha256: document.markdown_sha256 } : {}),
    },
    target: {
      source_id: `external-standard:${normalized(standardNo)}`,
      kind: address ? address.kind as DocumentReferenceKind : "standard",
      number: address ? String(address.number).trim() : standardNo,
      ...(typeof address?.paragraph === "string" ? { paragraph: address.paragraph } : {}),
    },
  }, allowAfterValidation, document);
  if (userIgnore && output.ok) return { ...output, source_status: "ignored_by_user", content_available: false,
    external_standard: { ...(output.external_standard as Record<string, unknown>), expansion: "literal_only", expansion_reason: expansionReason, user_ignore: userIgnore },
    required_action: "retain_user_ignored_reference_literal", writable_paths: ["/references", "/items"], next_tool: "read_target_selectors",
    how_to_pass: "用户已明确忽略本任务的这份缺失正文。保留完整引用原文、原字段、数值及条件；用 keep_reference/reference_only，target_span_ids=[]，把引用绑定到真实接收字段。保留 content_required 和未核验标记，不推测外部条文或补造数值。",
    instruction: "只停止请求本任务这份正文，其他引用和所有已有验收要求仍须处理。不要再次报告此资料缺失、删除项目、改写原文或宣称被引正文已核验。" };
  if (usage === "citation_only" && output.ok) return { ...output, source_status: "not_requested_citation_only",
    required_action: "retain_citation_and_update_its_author_route",
    instruction: "本处按 citation_only 保留精确引用和真实字段，没有请求正文解析；这不表示本地缺少资料。若回条含 correction，旧决定已存入历史且不再作为当前义务；用 read_target_selectors 核对旧 reference，只更新其 occurrence_id 及实际引用路由，再做完整校验。不要删除原文或无关业务项目。" };
  if (literalOnly && output.ok) {
    return { ...output, expansion_policy: { ...policy, field: fieldPolicy.field, literal_only: true,
        ...(fieldPolicy.literal_only ? { local_source_status: "not_requested_by_field_policy" }
          : { local_source_available: false, local_source_status: identityMismatch ? "identity_mismatch" : "unavailable" }) },
      external_standard: { ...(output.external_standard as Record<string, unknown>), expansion: "literal_only", expansion_reason: expansionReason },
      required_action: fieldPolicy.literal_only ? "retain_allowable_deviation_reference_literal" : "retain_nested_reference_literal", budget_consumed: false,
      writable_paths: ["/references", "/items"], next_tool: "read_target_selectors",
      how_to_pass: `${fieldPolicy.literal_only ? "引用位于原文允许偏差字段，按字段策略只保留引用文本，即使本地存在正文也不钻取；验收依据字段中的独立引用仍按正常流程核对正文。" : "本引用来自已展开的外部资料，已查本地但没有身份和指纹匹配的下一标准原文。"}按 keep_reference/reference_only、target_span_ids=[] 保留全部精确 anchor，并绑定引用原话实际所在的业务字段。保留原 usage，只停止获取外部正文；不得删去原文引用或编造下级条文。`,
      instruction: fieldPolicy.literal_only ? "允许偏差引用按原文字面交付，不查找或解析外部文件、不请求补文件、不暂停任务。保留现有明确数值、单位和条件。"
        : "已保留外部资料中的后续引用原文；本地无可用的对应版本资料，不请求补文件、不暂停任务。继续保存真实原文字段及引用路由；若以后本地资料可用，重新解析可按正常流程读取并判断相关性。" };
  }
  if (workflow && usage === "content_required" && !document && output.ok && typeof output.occurrence_id === "string") {
    const origin = output.unresolved_reference as { origin_locator?: string; origin_excerpt?: string } | undefined;
    const request: ExternalSourceRequest = { standard_no: standardNo,
      ...(typeof input.standard_title === "string" ? { standard_title: input.standard_title } : {}),
      target_id: workspace.targetId, occurrence_id: output.occurrence_id,
      origin_excerpt: origin?.origin_excerpt ?? rawReference, origin_locator: origin?.origin_locator ?? "",
      dependent_fields: fields as ExternalSourceRequest["dependent_fields"], reason: String(input.reason) };
    await workflow.require(request);
    return { ...output, status: "waiting_for_source", waiting_for_source: request, terminal: false, budget_consumed: false,
      required_action: "wait_for_user_source", writable_paths: [],
      instruction: "整批等待补充外部资料，已保存引用和进度；等待不计修复失败。用户补齐正确版本并解析成功后自动恢复。不要编造正文、删除业务项目或重复轮询。" };
  }
  return { ...output, ...(document && output.ok ? { content_available: true, adoption_instruction: "资料可用只证明原文已接入。读取后由模型逐项判断与当前任务产出的相关性，采用时保存真实字段、适用范围和依据；不得把资料存在解释为全书全部采用。", external_standard: { standard_no: standardNo, status: "resolved", usage, markdown_sha256: document.markdown_sha256 } } : {}) };
}
