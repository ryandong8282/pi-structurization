import {
  PLAN_SCHEMA_VERSION,
  type AcceptanceItemPlan,
  type EvidenceManifest,
  type EvidenceRecord,
  type InspectionLotPlan,
  type ReferenceOccurrence,
  type SemanticSourcePlan,
  type TableAssemblyPlan,
} from "./contracts.js";
import { buildItemFieldBindings } from "./domain-contract.js";
import { ITEM_CATEGORY_GUIDANCE } from "./acceptance-delivery-contract.js";
import { buildReviewableTableAssembly } from "./table-assembly.js";

export interface FormalRowContract {
  evidence_id: string;
  table_fragment_id: string;
  table_id: string;
  item_id: string;
  lot_id: string;
  category: "主控项目" | "一般项目";
  source_name: string;
  source_requirement: string;
  source_method: string;
}

export interface PlanContract {
  schema_version: "semantic-source-plan-contract/v6";
  plan_schema_version: typeof PLAN_SCHEMA_VERSION;
  authority: string;
  rules: string[];
  formal_rows: FormalRowContract[];
  reference_occurrences: ReferenceOccurrence[];
  plan_template: SemanticSourcePlan;
}

function unresolvedSampling() {
  return {
    status: "fallback" as const,
    min_sampling: "",
    script: "待 Agent 调查当前文档后填写。",
    reason: "尚未由 Agent 基于当前文档证据作出抽样决定。",
    confidence: 0,
    evidence_ids: [],
  };
}

function uniqueValues(values: string[]): string[] {
  const result: string[] = [];
  for (const value of values.map((entry) => entry.trim()).filter(Boolean)) {
    if (result.at(-1) !== value) result.push(value);
  }
  return result;
}

function rowCategory(record: EvidenceRecord): "主控项目" | "一般项目" {
  const category = record.cells?.find((cell) =>
    cell === "主控项目" || cell === "一般项目"
  );
  if (category !== "主控项目" && category !== "一般项目") {
    throw new Error(`Formal table row lacks a category: ${record.evidence_id}`);
  }
  return category;
}

function rowFields(record: EvidenceRecord): {
  name: string;
  requirement: string;
  method: string;
} {
  const cells = record.cells ?? [];
  if (cells.length < 5) {
    throw new Error(`Formal table row has too few expanded cells: ${record.evidence_id}`);
  }
  const name = uniqueValues(cells.slice(2, Math.max(3, cells.length - 3))).join(" / ");
  const requirement = uniqueValues(cells.slice(-3, -1)).join(" ");
  const method = cells.at(-1)?.trim() ?? "";
  return { name, requirement, method };
}

function directTableSemantics(
  record: EvidenceRecord,
  fields: ReturnType<typeof rowFields>,
): NonNullable<AcceptanceItemPlan["table_semantics"]> {
  const cells = record.cells ?? [];
  const columns = record.columns ?? [];
  const fragments: NonNullable<AcceptanceItemPlan["table_semantics"]>["cell_evidence"] = [];
  const add = (
    role: NonNullable<AcceptanceItemPlan["table_semantics"]>["cell_evidence"][number]["role"],
    text: string,
  ): void => {
    const exact = text.trim();
    if (exact && record.text.includes(exact)) {
      fragments.push({ role, evidence_id: record.evidence_id, text: exact });
    }
  };
  // The legacy structured row may carry the recovered table number as
  // metadata while its immutable row text carries only the complete caption.
  // Retain that exact caption as the table-number evidence instead of
  // fabricating a fragment equal to the normalized metadata value.
  add("table_no", record.table_title ?? record.table_id ?? "");
  add("table_title", record.table_title ?? "");
  cells.slice(2, Math.max(3, cells.length - 3)).forEach((cell) => add("row_header", cell));
  columns.slice(-3, -1).forEach((column) => add("column_header", column));
  cells.slice(-3, -1).forEach((cell) => add("allowed_value", cell));
  add("inspection_method", fields.method);
  return {
    source_kind: "direct",
    table_id: record.table_id || record.table_fragment_id || record.evidence_id,
    table_no: record.table_id ?? "",
    table_title: record.table_title ?? "",
    applicability: "",
    row_path: [fields.name],
    column_path: uniqueValues(columns.slice(-3, -1)),
    unit: "",
    condition: "",
    allowed_value: fields.requirement,
    inspection_method: fields.method,
    cell_evidence: fragments,
    reference_fragments: [],
  };
}

function unresolvedInspectionDataType(evidenceIds: string[]) {
  return {
    inspection_data_type: "review" as const,
    inspection_data_type_reason: "尚未由领域 Agent 结合完整验收准则、检查方法、抽样描述、被检对象及上下文作出专业判断。",
    inspection_data_type_evidence_ids: [...evidenceIds],
  };
}

export function buildInitialTableAssembly(
  manifest: EvidenceManifest,
): TableAssemblyPlan {
  return buildReviewableTableAssembly(manifest);
}

export function buildPlanContract(
  manifest: EvidenceManifest,
  tableAssembly: TableAssemblyPlan = buildInitialTableAssembly(manifest),
): PlanContract {
  const agentDiscovered = manifest.source.adapter === "document-domain-agent/v1";
  const semanticWorkflow = Boolean(manifest.source.semantic_workflow);
  const formalRows = manifest.evidence.filter((record) =>
    record.role === "formal_table_row"
    && record.evidence_scope !== "reference"
  );
  // Agent-discovered documents always use one format-independent semantic
  // contract. Parsed rows remain searchable evidence, but their HTML shape,
  // category labels, and column count never switch business materialization to
  // the legacy deterministic one-row/one-item inventory.
  if (agentDiscovered || !formalRows.length) {
    return {
      schema_version: "semantic-source-plan-contract/v6",
      plan_schema_version: PLAN_SCHEMA_VERSION,
      authority: agentDiscovered
        ? "The full-document domain Agent selected this target. Empty formal_rows means formatting is unavailable, never that business content is empty. Immutable evidence resources are authoritative."
        : "No formal table rows were detected; the generic Stage-1-like fallback contract applies.",
      rules: agentDiscovered
          ? [
            "Use target_scope group, target brief, selected_atom_ids, and exact target_evidence_fragments to locate the target semantically; headings, numbering, tables, labels, and OCR shape are not gates.",
            "Search the complete neutral document atom inventory when target evidence contains a semantic dependency, a truncated clause, or a shared rule. target_scope.reference_candidates are high-recall text-retrieval hints only: they may be false positives or incomplete and never decide that a reference exists or where it points.",
            ...(semanticWorkflow
              ? [
                  "Before materializing lots or items, semantically classify exact opened fragments in semantic_evidence as reference_anchor, referenced_clause, continuation, acceptance_item, table_criterion, acceptance_condition, or sampling_rule. Decide from complete business meaning, never from spelling, numbering, headings, table shape, keywords, or candidate presence. A final acceptance_item or table_criterion must bind positive exact direct or resolved-reference evidence that the document treats it as an independently judged acceptance criterion, such as an item-specific inspection method, quantitative/verdict basis, or explicit normative acceptance classification. Mandatory wording or a shared sampling rule alone never promotes a construction condition or process prerequisite into an acceptance item.",
                  "Create one acceptance_item semantic node and one final leaf for each independently judged proposition. Independence means the same inspected scope can pass one proposition while failing another because they concern different objects, quality dimensions, required or forbidden states, measurements/verdicts, or reference-derived criteria. Punctuation, conjunctions, list markers, table rows, headings, order, and OCR line breaks are never independence gates. Keep alternative thresholds for the same measurement in one judgment. Conditions, exceptions, methods, sampling, and other qualifiers are not standalone judgments: bind each exact qualifier to every item it applies to; shared qualifiers may bind multiple items and never force independent judgments to merge. Preserve every negative word, value, unit, condition, exception, and reference without duplication.",
                  "Classify every independently judged requirement found in a direct or referenced table as table_criterion, even when the table is flattened into prose, split across atoms/pages, or damaged by OCR. table_criterion is a semantic role, not a decision made from HTML tags, headings, keywords, column count, or table shape.",
                  "每个 reference_anchor 必须且只能有一条 semantic_references 决定。已解析决定必须写明精确被引节点和原引用所在的目标业务字段。新引用保留原字段、原引用文字和 provenance，并把被引内容关联到精确 literal 位置；不得搬到 note 或伪字段。不得使用 replace_field 整字段替换。无法证明唯一目标时使用 status=review 让校验阻塞，绝不猜测。引用 anchor 和适用条件不是独立 item，续片沿用父 item。",
                ]
              : []),
            "Inspect every provided primary evidence resource. selected_atom_ids are physical navigation addresses: open a selected raw atom or adjacent/global resource on demand only when the precise evidence is truncated or a dependency is missing. Emit every distinct inspection lot and every distinct acceptance item applicable to this target; never stop after one convenient example.",
            "A deterministic work_scope is only a stable reading and scheduling boundary. It may contain multiple inspection lots; never collapse the whole scope into one lot merely because discovery produced one target.",
            "A primary evidence resource containing many damaged table rows or prose requirements still requires exhaustive semantic extraction. formal_rows is intentionally empty and grants no permission to emit an empty or partial plan.",
            ITEM_CATEGORY_GUIDANCE,
            "For a table, emit one final item per independently judged checkpoint or dimension. Combine one checkpoint's conditions, units, and allowed-value branches; do not manufacture one item per physical cell. Do not collapse multiple independently judged rows or dimensions into a single '符合表X' shell.",
    "Different inspected properties, verdict formulas, or acceptance categories remain separate judgments even when they share ranges, unit, or inspection method: they can pass or fail independently. When semantic object/row paths share one core property and formula, either lossless split items or one item with complete, non-overlapping, independently evaluable object/condition branches is valid; neither item count nor physical row count is authority.",
            "Derive item identity from the inspected property or dimension after removing mutually exclusive ranges, classes, thresholds, and operating cases. When those cases only select different allowed values for the same dimension, preserve every exact condition/value pairing in either lossless representation and never hide the condition only in name or note.",
            "Every table_criterion item must fill table_semantics with the same contract for direct and referenced tables: semantic table identity, source kind, table number/title when recoverable, applicability, at least one semantic row or column path, unit, condition, allowed value, inspection method, exact role-labelled cell evidence, and exact reference-anchor fragments for referenced tables. Do not invent a missing physical axis for one-dimensional or flattened text evidence.",
            "Keep table number, title, paths, unit, condition, allowed value, method, and original reference in table_semantics instead of stuffing them into name. Name the actual checkpoint; when a bare property name would be ambiguous outside the table, add the minimum inspected-object or applicability scope needed to understand it. Never mechanically prepend a table number or the whole caption to every row.",
            "Blank record templates, examples, summaries, explanatory tables, and forms are context unless complete domain semantics prove an independently judged acceptance criterion. Table appearance or normative-looking labels never supply that proof.",
            "Use only immutable evidence IDs and bind every authoritative field to exact source fragments.",
            "Finish exhaustive semantic discovery, item eligibility, splitting/merging, reference resolution, and evidence routing before wording names. A short name never decides whether content is an item or whether two quality dimensions merge.",
            "acceptance_items[].name answers what is checked: write a concise noun phrase consisting of the inspected object plus its independently judged core quality characteristic. Preserve necessary part, joint form, material/component type, condition branch, and independently judged dimension; for example, 焊缝表面不得有裂纹、焊瘤、烧穿等缺陷 becomes 焊缝表面缺陷, while 对接焊缝余高 must not be generalized to 焊缝尺寸.",
            "Do semantic compression, never mechanical truncation, regex deletion, or a keyword whitelist. Do not copy verdict wording, modal verbs, acceptance limits, inspection quantity/method, clause/table numbers, or reference numbers into name. Avoid empty labels such as 质量要求、符合规定、施工要求. Put the complete decision rule in requirement and preserve negation, values, units, conditions, exceptions, and reference meaning there.",
            "When name paraphrases its exact evidence, prepare its field binding with composition=semantic_summary and exact source_fragments. Use composition=verbatim only when the final name itself is an exact source noun phrase. This changes presentation only and never relaxes exact fragment validation.",
            "Keep a proved source locator separate from the inspectable checkpoint title: name contains only the business title, while the unchanged clause, appendix, table, or list locator remains in exact source evidence for deterministic source_clause and navigation projection. Never remove a leading year, model, grade, dimension, percentage, or other business token merely because it contains letters or digits.",
            "For every final acceptance item, use construction-quality domain knowledge to decide inspection_data_type from the complete criterion, inspection method, sampling description, inspected object, and surrounding or referenced meaning. First explain in inspection_data_type_reason what data the inspection produces, how one inspection unit is judged, and how the final result is evaluated; then choose measurement, counting, mixed, or review and cite only the evidence actually used in inspection_data_type_evidence_ids.",
            "measurement means a continuous or discrete measured value is compared with a limit, design value, allowable deviation, or statistical parameter. counting means inspection units receive attribute verdicts and the final evaluation uses defect/pass counts or rates. A number or unit alone never proves measurement, and mandatory wording alone never proves counting.",
            "If one statement contains independent measurement and counting judgements, first decide semantically whether the complete acceptance meaning requires two items; never split mechanically just to classify it. Use mixed only when the judgements truly cannot be separated. Use review when evidence or context is insufficient, and state what is missing instead of guessing.",
            "inspection_data_type is result metadata only. It must not change target discovery, inspection-lot formation, item merging or splitting, category, or sampling calculation in this phase.",
            ...(semanticWorkflow
              ? ["For Agent-discovered evidence, explicit sampling is limited to one executable unbranched decision from one immutable evidence atom. The same exact unbranched inspection-quantity passage may be reused by every independent item it semantically governs without merging those items. Two or more conditional sampling outcomes, or typed sampling members from different evidence atoms, require one shared_sampling_rule with every branch-local condition, quantity, and method preserved; this is mandatory even for one receiving item. Each receiver selects its exact non-empty applicable branch subset. Sampling-only conditions, batch/volume/floor ranges, quantities, and methods never create acceptance items. Coverage reviews applicability, conflicts, branch completeness, and whether any item-specific quantity was overwritten."]
              : ["For Agent-discovered evidence, item-local sampling quantities use status=explicit and cite that item's primary evidence. A separate document-wide or common sampling rule uses status=reference and may be cited by every applicable item only in sampling.evidence_ids; mark that shared evidence used by all receiving item IDs in evidence_dispositions."]),
            "Use status=fallback only when no opened item-local or shared rule supplies a more specific applicable decision. Never copy a shared sampling atom into quantity field_bindings or reference_evidence_ids.",
            ...(semanticWorkflow
              ? ["Every requires_disposition evidence resource must be handled exactly once. A selected primary reference anchor may be context instead of being forced into a fake item, but it must be classified in semantic_evidence."]
              : ["Every requires_disposition evidence resource must be handled exactly once, and every materialized selected primary atom must be used by emitted items."]),
          ]
        : [
            "Use only immutable evidence IDs.",
            "Every requires_disposition evidence atom must be handled exactly once.",
          ],
      formal_rows: [],
      reference_occurrences: manifest.reference_occurrences,
      plan_template: {
        schema_version: PLAN_SCHEMA_VERSION,
        job_id: manifest.job_id,
        target_id: manifest.target_id,
        evidence_fingerprint: manifest.evidence_fingerprint,
        table_assembly: tableAssembly,
        inspection_lots: [],
        acceptance_items: [],
        reference_resolutions: [],
        evidence_dispositions: [],
        ...(semanticWorkflow
          ? {
              semantic_evidence: [],
              semantic_references: [],
              shared_sampling_rules: [],
            }
          : {}),
      },
    };
  }

  const dispositionByFragment = new Map(
    tableAssembly.fragment_dispositions.map((row) => [row.fragment_id, row]),
  );
  const logicalById = new Map(
    tableAssembly.logical_tables.map((table) => [table.logical_table_id, table]),
  );
  const rowsByTable = new Map<string, EvidenceRecord[]>();
  for (const row of formalRows) {
    const fragmentId = row.table_fragment_id;
    if (!fragmentId) {
      throw new Error(`Formal row has no table_fragment_id: ${row.evidence_id}`);
    }
    const tableId = dispositionByFragment.get(fragmentId)?.logical_table_id;
    if (!tableId || !logicalById.has(tableId)) {
      throw new Error(`Formal fragment has no logical table assignment: ${fragmentId}`);
    }
    const rows = rowsByTable.get(tableId) ?? [];
    rows.push(row);
    rowsByTable.set(tableId, rows);
  }

  const inspectionLots: InspectionLotPlan[] = [];
  const acceptanceItems: AcceptanceItemPlan[] = [];
  const rowContracts: FormalRowContract[] = [];
  for (const [tableId, rows] of rowsByTable) {
    const logicalTable = logicalById.get(tableId)!;
    const lotId = `lot:${tableId}`;
    const lotName = logicalTable.canonical_title;
    const logicalFragmentIds = new Set(logicalTable.fragment_ids);
    const titleEvidenceIds = [...new Set([
      ...logicalTable.canonical_title_fragments.map((fragment) => fragment.evidence_id),
      ...manifest.table_fragments
        .filter((fragment) => logicalFragmentIds.has(fragment.fragment_id))
        .flatMap((fragment) => fragment.title_candidate_evidence_ids),
    ])];
    const itemIds: string[] = [];
    rows.forEach((row, index) => {
      const itemId = `item:${tableId}:row:${index + 1}`;
      const category = rowCategory(row);
      const fields = rowFields(row);
      itemIds.push(itemId);
      rowContracts.push({
        evidence_id: row.evidence_id,
        table_fragment_id: row.table_fragment_id!,
        table_id: tableId,
        item_id: itemId,
        lot_id: lotId,
        category,
        source_name: fields.name,
        source_requirement: fields.requirement,
        source_method: fields.method,
      });
      acceptanceItems.push({
        item_id: itemId,
        lot_id: lotId,
        name: fields.name,
        category,
        requirement: fields.requirement,
        method: fields.method,
        quantity: "",
        note: "",
        evidence_ids: [row.evidence_id],
        reference_evidence_ids: [],
        table_semantics: directTableSemantics(row, fields),
        ...unresolvedInspectionDataType([row.evidence_id]),
        field_bindings: buildItemFieldBindings(
          {
            name: fields.name,
            requirement: fields.requirement,
            method: fields.method,
            quantity: "",
            note: "",
          },
          [row.evidence_id],
          manifest,
        ),
        sampling: unresolvedSampling(),
      });
    });
    inspectionLots.push({
      lot_id: lotId,
      name: lotName,
      evidence_ids: titleEvidenceIds,
      item_ids: itemIds,
    });
  }

  return {
    schema_version: "semantic-source-plan-contract/v6",
    plan_schema_version: PLAN_SCHEMA_VERSION,
    authority: "The semantic table-assembly plan assigns physical fragments to logical industry-standard tables; deterministic code then freezes the exact lot and row inventory.",
    rules: [
      "Resolve every physical table fragment semantically before sealing; layout adjacency, line numbers, and continuation wording are hints, never authority.",
      ...(semanticWorkflow
        ? [
            "When a formal table fragment belongs to an adjacent or different target domain, classify it as context with no logical_table_id and an exact semantic reason; never materialize it merely because the discovery window overlaps it.",
          ]
        : []),
      "Every assigned logical table in table_assembly must retain one inspection lot; a logical table may contain multiple physical fragments. Independently proved clause or referenced-table scopes may add lots with semantic evidence.",
      "Canonical lot names must be composed from exact title-candidate evidence fragments and must not use continuation captions or line-based fallbacks.",
      "Every assigned expanded formal_table_row evidence atom must retain one acceptance item. Independently executable clause or referenced-table requirements may add items with exact semantic evidence.",
      "Keep every assigned formal-row structural ID, lot relation, category, and primary row citation from plan_template unchanged.",
      "You may refine name, requirement, method, quantity, note, reference_evidence_ids, and sampling only when supported by opened evidence.",
      "Finish formal-row and prose coverage, independent condition/value branch splitting, reference expansion, and evidence routing before wording names. A short name never decides item eligibility, splitting, merging, or evidence ownership.",
      "acceptance_items[].name is a concise inspected-object plus core-quality-characteristic noun phrase. Preserve necessary part, joint form, material/component type, condition branch, and independently judged dimension. Do semantic compression rather than truncation or keyword rules; keep verdict wording, limits, quantities, methods, clause/table/reference numbers, and the full lossless acceptance meaning in requirement/method/quantity and their exact bindings.",
      "Use composition=semantic_summary with exact source_fragments when name is a semantic compression; keep composition=verbatim for an exact source noun phrase. Never use semantic_summary to weaken requirement or any other authoritative field.",
      "Keep a proved source locator separate from the inspectable checkpoint title: name contains only the business title, while the unchanged clause, appendix, table, or list locator remains in exact source evidence for deterministic source_clause and navigation projection. Never remove a leading year, model, grade, dimension, percentage, or other business token merely because it contains letters or digits.",
      "Whenever a semantic field changes, update its field_bindings value hash and exact source fragments in the same patch.",
      "For every final acceptance item, use construction-quality domain knowledge to decide inspection_data_type from the complete criterion, inspection method, sampling description, inspected object, and surrounding or referenced meaning. First explain in inspection_data_type_reason what data the inspection produces, how one inspection unit is judged, and how the final result is evaluated; then choose measurement, counting, mixed, or review and cite only the evidence actually used in inspection_data_type_evidence_ids.",
      "measurement compares an actual continuous or discrete measurement with a limit, design value, allowable deviation, or statistical parameter. counting assigns attribute verdicts to inspection units and evaluates defect/pass counts or rates. A number or unit alone never proves measurement; mandatory wording alone never proves counting.",
      "When independent measurement and counting judgements share a clause, decide first whether the complete acceptance semantics require separate items; do not split mechanically for classification. Use mixed only when they cannot reasonably be separated, and review when evidence is insufficient. This metadata does not alter discovery, lot formation, item/category semantics, or sampling.",
      "Every table-derived item must retain table_semantics. Direct and referenced tables share the same structured table contract and exact cell-evidence rules.",
      "Different inspected properties, verdict formulas, or acceptance categories remain separate judgments even when they share ranges, unit, or method. When semantic object/row paths share one core property and formula, either lossless split items or one item with complete, non-overlapping, independently evaluable object/condition branches is valid; shared physical rows and item count alone decide nothing.",
      "Mutually exclusive ranges, classes, thresholds, or operating cases that only select allowed values for one inspected dimension may remain branches of one item or lossless split items; preserve every exact pairing and never create an acceptance judgment from condition text alone.",
      "Keep table metadata outside name. Use the actual checkpoint as the name; reject both mechanical table-number/full-caption prefixes and bare property names whose inspected object or applicability cannot be understood outside the table.",
      "每个已登记并启用的 reference_occurrence 必须且只能有一条 reference_resolution。新文档引用的 reference_only 语义是：保留本地字段和原引用文字，永久保存 occurrence provenance，并把全部被引条文或结构化表格记录关联到精确 literal 位置。折叠/展开只是渲染行为，不是模型选项。",
      "Resolved document references must not erase or move their source literal. Tables remain structured resolved records with row/column/cell coordinates under the same field anchor.",
      "For every newly resolved reference, origin_binding identifies the one local item/field that actually contains all ordered reference_literal_span_ids. destination bindings are separate: they identify which business fields receive each applicable referenced component under component_dispositions and import_scope, and need not equal the origin field. Keep the complete local field and exact literal fragments unchanged; normalized_reference is a separate display/semantic label and may only normalize whitespace or layout.",
      "Every item must have an Agent-authored sampling decision supported by current-document evidence; the initial placeholder cannot validate or seal.",
      "Put sampling-rule IDs only in sampling.evidence_ids. For an explicit quantity written directly in this item's formal table row, sampling.evidence_ids may instead cite that same primary row ID. reference_evidence_ids must exactly equal the target evidence routed to the item by reference_resolutions.",
      "Every formal_table_row disposition must remain used by its one assigned item.",
      ...(semanticWorkflow
        ? [
            "Classify every distinct formal row as its own acceptance_item semantic node. Add separate clause-derived leaves only for independently pass/fail judgments. Keep alternative thresholds of one measurement in one leaf; bind conditions, exceptions, methods, sampling, and other exact qualifiers to every applicable leaf without creating qualifier-only leaves or merging independent judgments. Never infer independence from table shape, row count, punctuation, numbering, order, or OCR layout.",
            "Raw target atoms remain semantic authority for prose requirements, references, conditions, and sampling; row evidence is a lossless coverage obligation, not a target-discovery or hierarchy rule.",
          ]
        : []),
      "Pure supporting context and notes do not create items. General construction conditions and process prerequisites remain acceptance_condition context unless exact direct or resolved-reference evidence positively establishes that the document treats them as independently judged acceptance criteria; an item-specific inspection method, quantitative/verdict basis, or explicit normative acceptance classification may support that conclusion. Only proved independently executable acceptance meaning may create an additional lot or leaf item.",
    ],
    formal_rows: rowContracts,
    reference_occurrences: manifest.reference_occurrences,
    plan_template: {
      schema_version: PLAN_SCHEMA_VERSION,
      job_id: manifest.job_id,
      target_id: manifest.target_id,
      evidence_fingerprint: manifest.evidence_fingerprint,
      table_assembly: tableAssembly,
      inspection_lots: inspectionLots,
      acceptance_items: acceptanceItems,
      reference_resolutions: [],
      evidence_dispositions: rowContracts.map((row) => ({
        evidence_id: row.evidence_id,
        disposition: "used",
        item_ids: [row.item_id],
        reason: "正式质量检验表数据行对应一个验收项目",
      })),
      ...(semanticWorkflow
        ? {
            semantic_evidence: [],
            semantic_references: [],
            shared_sampling_rules: [],
          }
        : {}),
    },
  };
}
