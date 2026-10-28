import {
  initialTargetSelectorPlan,
  type TargetSelectorPlan,
} from "./target-selector-compiler.js";
import {
  htmlTableCellSpans,
  locateAndRegisterSourceQuote,
  locateSourceQuote,
  registerHtmlTableCellSpans,
  SourceSpanRegistryError,
  type HtmlTableCellSpan,
  type ImmutableTextSource,
  type SourceSpanRegistry,
} from "./source-span-registry.js";
import { UNLABELED_ITEM_CATEGORY, type AcceptanceItemCategory, type EvidenceManifest } from "./contracts.js";
import { isDirectFullInspectionQuantity } from "./acceptance-delivery-contract.js";
import { ledgerRequiredClausePredicate, type DocumentLedger, type LedgerClause } from "./document-ledger.js";

const QUANTITY_LABEL_RE = /^(?:检查数量|检验数量|检测数量|抽样数量|抽检数量|抽查数量)\s*[:：]?\s*/;
const METHOD_LABEL_RE = /^(?:检验方法|检查方法)\s*[:：]?\s*/;
const RECORD_TABLE_RE = /检验批.{0,12}(?:质量)?验收记录|验收记录表/;
const TABLE_CAPTION_RE = /表\s*([0-9A-Za-z]+(?:\s*[.．]\s*\d+)*(?:\s*-\s*\d+)?)([^\n<]{0,80})/;
const VALUE_HEADER_RE = /允许偏差|允许值/;
const NAME_HEADER_RE = /检查项目|项目/;
const METHOD_HEADER_RE = /检验方法|检查方法/;

export interface LedgerTargetPrefill {
  selectors: TargetSelectorPlan;
  registry: SourceSpanRegistry;
  clause_item_count: number;
  table_item_count: number;
}

type FieldSelector = TargetSelectorPlan["items"][number]["fields"]["name"];

function emptyField(reason: string): FieldSelector {
  return { composition: "not_applicable", span_ids: [], separator: "", reason };
}

function boundField(
  composition: "verbatim" | "semantic_summary",
  spanId: string,
  reason: string,
): FieldSelector {
  return { composition, span_ids: [spanId], separator: "", reason };
}

function markdownLines(markdown: string): string[] {
  return markdown.replace(/\r\n?/g, "\n").split("\n");
}

function lineText(lines: readonly string[], line: number | undefined): string {
  if (!line) return "";
  return (lines[line - 1] ?? "").trim();
}

function stripLabel(text: string, label: RegExp): string {
  return text.replace(label, "").trim();
}

function evidenceSources(records: EvidenceManifest["evidence"]): ImmutableTextSource[] {
  return records.map((record) => ({
    source_id: record.evidence_id,
    evidence_id: record.evidence_id,
    atom_id: record.evidence_id,
    text: record.text,
  }));
}

function spanIdAt(
  registry: SourceSpanRegistry,
  evidenceId: string,
  start: number,
  end: number,
): string | undefined {
  return registry.spans.find((span) =>
    span.evidence_id === evidenceId
    && span.start === start
    && span.end === end
  )?.span_id;
}

function locateQuote(
  registry: SourceSpanRegistry,
  sources: readonly ImmutableTextSource[],
  quote: string,
): { registry: SourceSpanRegistry; span_id: string } | undefined {
  const needle = quote.trim();
  if (!needle) return undefined;
  const ranked = [...sources]
    .filter((source) => locateSourceQuote(source.text, needle).length > 0)
    .map((source) => ({ source, length: source.text.length }))
    .sort((left, right) => left.length - right.length);
  for (const { source } of ranked) {
    try {
      const located = locateAndRegisterSourceQuote(registry, source, needle);
      return { registry: located.registry, span_id: located.spans[0]!.span_id };
    } catch (error) {
      if (!(error instanceof SourceSpanRegistryError)) throw error;
    }
  }
  return undefined;
}

/** 两个注册跨度是否有交集（含包含关系）；任一 span_id 查不到即视为不重叠。 */
function spansOverlap(
  registry: SourceSpanRegistry,
  spanId: string | undefined,
  otherSpanIds: readonly string[],
): boolean {
  if (!spanId) return false;
  const span = registry.spans.find((entry) => entry.span_id === spanId);
  if (!span) return false;
  return otherSpanIds.some((otherId) => {
    const other = registry.spans.find((entry) => entry.span_id === otherId);
    if (!other || other.evidence_id !== span.evidence_id) return false;
    return span.start < other.end && other.start < span.end;
  });
}

function clauseTitle(clause: LedgerClause): string {
  return clause.text.replace(clause.clause_id, "").trim() || clause.clause_id;
}

/** 原文候选只供作者阅读；程序不通过关键词或截断替作者生成业务名称。 */
function sourceNameCandidate(title: string): string {
  return title.trim();
}

function clauseRequirement(lines: readonly string[], clause: LedgerClause): string {
  const end = Math.min(
    clause.quantity_line ?? clause.end_exclusive_line,
    clause.method_line ?? clause.end_exclusive_line,
    ...(clause.field_role_ranges ?? []).map((range) => range.start_line),
    clause.end_exclusive_line,
  );
  const firstLine = lines[clause.line - 1] ?? "";
  const locatorStart = firstLine.indexOf(clause.clause_id);
  const firstBody = locatorStart >= 0
    ? firstLine.slice(locatorStart + clause.clause_id.length).trimStart()
    : firstLine;
  const body = lines
    .slice(clause.line, end - 1)
    .filter((line) => {
      const trimmed = line.trim();
      return !/^#{1,6}\s/.test(trimmed)
        && !QUANTITY_LABEL_RE.test(trimmed)
        && !METHOD_LABEL_RE.test(trimmed)
        && !/^<table\b/i.test(trimmed)
        && !/主\s*控\s*项\s*目|一\s*般\s*项\s*目/.test(trimmed.replace(/\s+/g, ""));
    });
  return [firstBody, ...body].join("\n").trim() || clauseTitle(clause);
}

function clauseRoleText(
  lines: readonly string[], clause: LedgerClause, role: "method" | "quantity",
): { line: number | undefined; raw: string } {
  const ranges = (clause.field_role_ranges ?? []).filter(range => range.role === role);
  if (!ranges.length) {
    const line = role === "method" ? clause.method_line : clause.quantity_line;
    return { line, raw: lineText(lines, line) };
  }
  const raw = ranges.flatMap(range => {
    const block = lines.slice(range.start_line - 1, range.end_exclusive_line - 1);
    // Notes and table captions are separate from the preceding prose field.
    const boundary = block.findIndex((line, index) => index > 0 && (
      /^注(?:\s*\d+)?\s*[:：]/u.test(line.trim())
      || /^(?:续表|表)\s*[0-9A-Za-z]/u.test(line.trim())
    ));
    return block.slice(0, boundary < 0 ? block.length : boundary).map(line => line.trim()).filter(Boolean);
  }).join("");
  return { line: ranges[0]!.start_line, raw };
}

function inspectionType(methodText: string, valueText: string): {
  type: "measurement" | "review";
  reason: string;
} {
  if (/尺|量测|百分表|卡尺|分度|探伤|硬度/.test(methodText) || /mm|±|%|允许偏差/.test(valueText)) {
    return { type: "measurement", reason: "量测或允许偏差值，按计量检验" };
  }
  return { type: "review", reason: "核验文件或观察，按复核检验" };
}

function samplingFor(
  quantityText: string,
  quantitySpanId: string | undefined,
): TargetSelectorPlan["items"][number]["sampling"] {
  const samplingLike = /抽|%|不少于|不应少于/.test(quantityText) || isDirectFullInspectionQuantity(quantityText);
  if (quantitySpanId && samplingLike) {
    return {
      status: "explicit",
      rule_key: "",
      branch_keys: [],
      quantity_span_ids: [quantitySpanId],
      script_span_ids: [quantitySpanId],
      condition_span_ids: [],
      reason: "检查数量原文即抽样话述",
      confidence: 1,
    };
  }
  return {
    status: "pending",
    rule_key: "",
    branch_keys: [],
    quantity_span_ids: [],
    script_span_ids: [],
    condition_span_ids: [],
    reason: quantitySpanId
      ? "已登记本地数量片段，尚待核对其抽样语义、适用条件及共同规定"
      : "尚待核对本项及适用共同规定；未单列数量不能证明不抽样",
    confidence: 0,
  };
}

function emptyTableProperties(): NonNullable<TargetSelectorPlan["items"][number]["table"]>["properties"] {
  return {
    table_no_span_ids: [],
    table_title_span_ids: [],
    applicability_span_ids: [],
    row_path_span_ids: [],
    column_path_span_ids: [],
    unit_span_ids: [],
    condition_span_ids: [],
    allowed_value_span_ids: [],
    inspection_method_span_ids: [],
  };
}

function headerKind(text: string): "name" | "value" | "method" | "other" {
  const compact = text.replace(/\s+/g, "");
  if (VALUE_HEADER_RE.test(compact)) return "value";
  if (METHOD_HEADER_RE.test(compact)) return "method";
  if (NAME_HEADER_RE.test(compact)) return "name";
  return "other";
}

function cellAt(
  cells: readonly HtmlTableCellSpan[],
  tableIndex: number,
  rowIndex: number,
  columnIndex: number,
): HtmlTableCellSpan | undefined {
  return cells.find((cell) =>
    cell.table_index === tableIndex
    && cell.row_index === rowIndex
    && cell.column_index === columnIndex
  );
}

function nameCellForRow(
  cells: readonly HtmlTableCellSpan[],
  tableIndex: number,
  rowIndex: number,
  nameCol: number,
): HtmlTableCellSpan | undefined {
  const direct = cellAt(cells, tableIndex, rowIndex, nameCol);
  if (direct?.text) return direct;
  const occupying = cells.find((cell) =>
    cell.table_index === tableIndex
    && cell.column_index === nameCol
    && cell.row_index <= rowIndex
    && cell.row_index + cell.row_span > rowIndex
    && cell.text
  );
  return occupying ?? direct;
}

function expandHtmlTables(input: {
  sources: readonly ImmutableTextSource[];
  registry: SourceSpanRegistry;
  clause: LedgerClause;
  clauseBody: string;
  clauseSpanId: string;
  quantitySpanId?: string;
  methodSpanId?: string;
  quantityText: string;
  methodText: string;
  category: AcceptanceItemCategory;
  lotKey: string;
}): { registry: SourceSpanRegistry; items: TargetSelectorPlan["items"] } {
  const items: TargetSelectorPlan["items"] = [];
  let registry = input.registry;
  // 条款级单调递增：同一条款可能同时拥有跨页续表（题注表号相同），
  // 每张表各自从 0 开始编号会生成重复 item key，编译器直接判 selector_duplicate_item_key。
  let itemIndex = 0;
  const clauseHaystack = `${input.clause.text}\n${input.clauseBody}`;
  for (const source of input.sources) {
    const tables = [...source.text.matchAll(/<table\b[^>]*>[\s\S]*?<\/table>/gi)];
    const cells = htmlTableCellSpans(source.text);
    tables.forEach((tableMatch, tableIndex) => {
      const html = tableMatch[0];
      const tableStart = tableMatch.index ?? 0;
      const preface = source.text.slice(Math.max(0, tableStart - 240), tableStart);
      if (RECORD_TABLE_RE.test(preface)) return;
      const caption = TABLE_CAPTION_RE.exec(preface.split("\n").reverse().find((line) => TABLE_CAPTION_RE.test(line)) ?? preface);
      const tableNo = caption?.[1]?.replace(/\s+/g, "") ?? "";
      const owned = input.clauseBody.includes(html)
        || (tableNo && clauseHaystack.replace(/\s+/g, "").includes(tableNo));
      if (!owned) return;
      const tableCells = cells.filter((cell) => cell.table_index === tableIndex);
      if (!tableCells.length) return;
      const headerRows = tableCells
        .filter((cell) => headerKind(cell.text) !== "other")
        .map((cell) => cell.row_index);
      const headerRow = headerRows.length ? Math.min(...headerRows) : 0;
      const kinds = new Map<number, "name" | "value" | "method" | "other">();
      for (const cell of tableCells.filter((entry) => entry.row_index === headerRow)) {
        kinds.set(cell.column_index, headerKind(cell.text));
      }
      const nameCol = [...kinds.entries()].find(([, kind]) => kind === "name")?.[0];
      const valueCol = [...kinds.entries()].find(([, kind]) => kind === "value")?.[0];
      const methodCol = [...kinds.entries()].find(([, kind]) => kind === "method")?.[0];
      if (nameCol === undefined || valueCol === undefined) return;
      const dataRows = [...new Set(tableCells.map((cell) => cell.row_index))]
        .filter((row) => row > headerRow)
        .sort((left, right) => left - right);
      const groups = new Map<string, number[]>();
      for (const row of dataRows) {
        const nameCell = nameCellForRow(tableCells, tableIndex, row, nameCol);
        const key = nameCell?.text.trim() || `row:${row}`;
        groups.set(key, [...(groups.get(key) ?? []), row]);
      }
      const captionNo = caption?.[1]?.replace(/\s+/g, "") ?? "";
      const captionTitle = `${caption?.[0] ?? ""}`.replace(/\s+/g, " ").trim();
      const noSpan = captionNo ? locateQuote(registry, [source], captionNo) : undefined;
      if (noSpan) registry = noSpan.registry;
      const titleSpan = captionTitle ? locateQuote(registry, [source], captionTitle) : undefined;
      if (titleSpan) registry = titleSpan.registry;
      for (const [name, rows] of groups) {
        const nameCell = rows
          .map((row) => nameCellForRow(tableCells, tableIndex, row, nameCol))
          .find((cell) => cell?.text === name);
        const valueCells = rows
          .map((row) => cellAt(tableCells, tableIndex, row, valueCol))
          .filter((cell): cell is HtmlTableCellSpan => Boolean(cell?.text));
        const methodCell = methodCol === undefined
          ? undefined
          : rows
            .map((row) => cellAt(tableCells, tableIndex, row, methodCol))
            .find((cell) => cell?.text);
        const conditionCells = rows.flatMap((row) =>
          tableCells.filter((cell) =>
            cell.row_index === row
            && cell.column_index !== nameCol
            && cell.column_index !== valueCol
            && cell.column_index !== methodCol
            && cell.text
          )
        );
        const nameSpanId = nameCell
          ? spanIdAt(registry, source.evidence_id ?? source.source_id, nameCell.start, nameCell.end)
          : undefined;
        const valueSpanIds = valueCells.flatMap((cell) => {
          const spanId = spanIdAt(registry, source.evidence_id ?? source.source_id, cell.start, cell.end);
          return spanId ? [spanId] : [];
        });
        const tableMethodSpanId = methodCell
          ? spanIdAt(registry, source.evidence_id ?? source.source_id, methodCell.start, methodCell.end)
          : undefined;
        // 表内没有检验方法列时退回条款级的「检验方法」跨度，但那一段有时会整个盖住表格，
        // 把允许偏差单元格也吞进去；编译器随即判 requirement/method 角色重叠。
        // 重叠就当作没有方法，宁可留空也不要让两个可见角色抢同一段原文。
        const methodSpanId = tableMethodSpanId
          ?? (spansOverlap(registry, input.methodSpanId, valueSpanIds) ? undefined : input.methodSpanId);
        if (!nameSpanId || !valueSpanIds.length) continue;
        const valueText = valueCells.map((cell) => cell.text).join(" / ");
        const methodText = methodCell?.text || input.methodText;
        const typed = inspectionType(methodText, valueText);
        const tableKey = captionNo || `html:${tableIndex}`;
        items.push({
          key: `ledger-table:${input.clause.clause_id}:${tableKey}:${itemIndex}`,
          lot_key: input.lotKey,
          name: sourceNameCandidate(name),
          category: input.category,
          criterion_span_ids: [input.clauseSpanId, nameSpanId],
          continuation_span_ids: [],
          fields: {
            name: boundField("semantic_summary", nameSpanId, "完整表格原文候选，业务名称尚待模型核对"),
            requirement: boundField("verbatim", valueSpanIds[0]!, "允许偏差或允许值"),
            method: methodSpanId
              ? boundField("verbatim", methodSpanId, "检验方法")
              : emptyField("表内未单列检验方法"),
            quantity: input.quantitySpanId
              ? boundField("verbatim", input.quantitySpanId, "所属条款检查数量")
              : emptyField("所属条款未单列检查数量"),
            note: emptyField("无备注"),
          },
          table: {
            source_kind: "direct",
            table_key: tableKey,
            properties: {
              ...emptyTableProperties(),
              table_no_span_ids: noSpan ? [noSpan.span_id] : [],
              table_title_span_ids: titleSpan ? [titleSpan.span_id] : [],
              row_path_span_ids: [[nameSpanId]],
              condition_span_ids: conditionCells.flatMap((cell) => {
                const spanId = spanIdAt(registry, source.evidence_id ?? source.source_id, cell.start, cell.end);
                return spanId ? [spanId] : [];
              }),
              allowed_value_span_ids: valueSpanIds,
              inspection_method_span_ids: methodSpanId ? [methodSpanId] : [],
            },
            reference_span_ids: [input.clauseSpanId],
            reason: "Markdown 内嵌 HTML 表按检查点展开，条件行不另立项",
          },
          inspection_data_type: typed.type,
          inspection_data_type_reason: typed.reason,
          inspection_data_type_span_ids: [valueSpanIds[0]!],
          sampling: samplingFor(input.quantityText, input.quantitySpanId),
          reason: `条款 ${input.clause.clause_id} 引用表的检查点`,
        });
        itemIndex += 1;
      }
    });
  }
  return { registry, items };
}

export function prefillTargetSelectorsFromLedger(input: {
  ledger: DocumentLedger;
  markdown: string;
  manifest: EvidenceManifest;
  registry: SourceSpanRegistry;
  start_line: number;
  end_exclusive_line: number;
}): LedgerTargetPrefill {
  const lines = markdownLines(input.markdown);
  // A discovery window is only a search boundary; it can contain several targets.
  // References and gaps between confirmed primary blocks must never seed items.
  const ranges = input.manifest.scope.primary_source_ranges ?? [{
    start_line: input.manifest.scope.selected_start_line,
    end_exclusive_line: input.manifest.scope.selected_end_exclusive_line,
  }];
  const inScope = (line: number) => line >= input.start_line
    && line < input.end_exclusive_line
    && ranges.some(range => line >= range.start_line && line < range.end_exclusive_line);
  const primary = input.manifest.evidence.filter(record => {
    if (record.evidence_scope !== "primary"
      && !(record.evidence_scope === undefined && record.requires_disposition)) return false;
    const line = /^line:(\d+)$/.exec(record.locator ?? "");
    return !line || markdownLines(record.text).some((_, offset) => inScope(Number(line[1]) + offset));
  });
  const sources = evidenceSources(primary);
  const sourcesByLine = new Map<number, ImmutableTextSource[]>();
  for (const record of primary) {
    const match = /^line:(\d+)$/.exec(record.locator ?? "");
    if (!match) continue;
    const source = {
      source_id: record.evidence_id,
      evidence_id: record.evidence_id,
      atom_id: record.evidence_id,
      text: record.text,
    };
    // Old manifests may store a multiline paragraph at its starting line.
    markdownLines(record.text).forEach((_, offset) => {
      const line = Number(match[1]) + offset;
      if (inScope(line)) sourcesByLine.set(line, [...(sourcesByLine.get(line) ?? []), source]);
    });
  }
  const locateDirectQuote = (
    currentRegistry: SourceSpanRegistry,
    line: number | undefined,
    raw: string,
    stripped = raw,
  ): { registry: SourceSpanRegistry; span_id: string } | undefined => {
    if (line !== undefined && !inScope(line)) return undefined;
    const lineSources = line ? sourcesByLine.get(line) ?? [] : [];
    // Legacy whole-source manifests have char locators. Granular manifests must
    // bind the original line, never an identical quote from a different clause.
    const scopedSources = sourcesByLine.size > 0 ? lineSources : sources;
    return locateQuote(currentRegistry, scopedSources, raw)
      ?? (stripped !== raw ? locateQuote(currentRegistry, scopedSources, stripped) : undefined);
  };
  // 原文索引单元格可作为完整名称候选；不表示程序已完成业务命名。
  // 索引表的主控/一般不用在这里取：底账扫描时已回填到 clause.column，category 自然拿到。
  const indexedNames = new Map(
    (input.ledger.indexed_clauses ?? [])
      .filter((entry) => entry.item_name)
      .map((entry) => [entry.clause_id, entry.item_name!]),
  );
  /** 索引单元格或完整条题都是原文候选；命名和格式修订由作者完成。 */
  const itemName = (clauseId: string, title: string): string => {
    const indexed = indexedNames.get(clauseId);
    if (indexed) return sourceNameCandidate(indexed);
    return sourceNameCandidate(title);
  };
  let registry = registerHtmlTableCellSpans(input.registry, sources).registry;
  const selectors = initialTargetSelectorPlan(input.manifest);
  const lotKey = "ledger-lot";
  if (!primary.length) {
    return { selectors, registry, clause_item_count: 0, table_item_count: 0 };
  }
  // Scope selectors are structural parent headings, not the entire evidence
  // window. Promoting prose/table notes here makes legitimate continuations and
  // context dispositions conflict with the compiler's heading-only contract.
  const scopeHeading = input.ledger.headings.find((heading) => heading.line === input.start_line);
  const headingBinding = scopeHeading
    ? locateDirectQuote(registry, scopeHeading.line, lineText(lines, scopeHeading.line))
    : undefined;
  if (headingBinding) registry = headingBinding.registry;
  const lotSpanIds = headingBinding ? [headingBinding.span_id] : [];
  selectors.lots.push({
    key: lotKey,
    name: input.manifest.scope.selected_heading || input.manifest.target_id,
    scope_span_ids: [...new Set(lotSpanIds)],
    reason: "未验证的临时分组；须由模型根据受检对象、工序和验收条件确认或拆并，target 与检验批不自动等同",
  });

  const isRequired = ledgerRequiredClausePredicate(input.ledger);
  const clauses = input.ledger.clauses.filter((clause) =>
    isRequired(clause)
    && inScope(clause.line)
  );
  let tableItemCount = 0;
  for (const clause of clauses) {
    const title = clauseTitle(clause);
    const headingQuote = clause.text.trim() || `${clause.clause_id} ${title}`;
    // A bare clause number is navigation, not a substitute for a missing clause.
    const heading = locateDirectQuote(registry, clause.line, headingQuote);
    if (!heading) continue;
    registry = heading.registry;
    const quantityBlock = clauseRoleText(lines, clause, "quantity");
    const methodBlock = clauseRoleText(lines, clause, "method");
    const quantityRaw = quantityBlock.raw;
    const methodRaw = methodBlock.raw;
    const quantityText = stripLabel(quantityRaw, QUANTITY_LABEL_RE);
    const methodText = stripLabel(methodRaw, METHOD_LABEL_RE);
    const requirementText = clauseRequirement(lines, clause);
    const quantity = quantityText
      ? locateDirectQuote(registry, quantityBlock.line, quantityRaw, quantityText)
      : undefined;
    if (quantity) registry = quantity.registry;
    const method = methodText
      ? locateDirectQuote(registry, methodBlock.line, methodRaw, methodText)
      : undefined;
    if (method) registry = method.registry;
    const requirement = requirementText && requirementText !== title
      ? locateQuote(registry, sources, requirementText)
      : undefined;
    if (requirement) registry = requirement.registry;
    // The ledger only carries a category when a source heading or index says
    // so. A missing label is an unvalidated authoring question, not 主控项目.
    const category = clause.column ?? UNLABELED_ITEM_CATEGORY;
    const clauseBody = lines.slice(clause.line, clause.end_exclusive_line - 1).join("\n");
    const expanded = expandHtmlTables({
      sources,
      registry,
      clause,
      clauseBody,
      clauseSpanId: heading.span_id,
      ...(quantity?.span_id ? { quantitySpanId: quantity.span_id } : {}),
      ...(method?.span_id ? { methodSpanId: method.span_id } : {}),
      quantityText,
      methodText,
      category,
      lotKey,
    });
    registry = expanded.registry;
    if (expanded.items.length) {
      selectors.items.push(...expanded.items);
      tableItemCount += expanded.items.length;
      continue;
    }
    const clauseTableRows = primary.filter(record => record.table_row_kind === "data"
      && record.table_id?.replace(/\s+/gu, "") === clause.clause_id.replace(/\s+/gu, ""));
    if (clauseTableRows.length > 1) {
      // 多行正式表格是待展开 work package，不是一个可进入最终编译的条款 item。
      // 行级义务由 tableExpansionState 从不可变 manifest 持续派生并在 table/commit 阶段硬校验。
      continue;
    }
    // A truncated prefix is not a complete requirement. Leave this source pending
    // for normal model authoring when the multiline body cannot bind exactly.
    if (requirementText && requirementText !== title && !requirement) continue;
    // Do not seed a prefix or declare a labeled, unbound block not applicable.
    if ((quantityText && !quantity) || (methodText && !method)) continue;
    const typed = inspectionType(methodText, requirementText);
    selectors.items.push({
      key: `ledger-clause:${clause.clause_id}`,
      lot_key: lotKey,
      name: itemName(clause.clause_id, requirementText),
      category,
      criterion_span_ids: [heading.span_id],
      continuation_span_ids: [],
      fields: {
        name: boundField("semantic_summary", requirement?.span_id ?? heading.span_id, "完整原文条款候选，业务名称尚待模型核对"),
        requirement: requirement
          ? boundField("verbatim", requirement.span_id, "条款要求原文")
          : boundField("verbatim", heading.span_id, "要求与条题同句"),
        method: method
          ? boundField("verbatim", method.span_id, "检验方法原文")
          : emptyField("未单列检验方法"),
        quantity: quantity
          ? boundField("verbatim", quantity.span_id, "检查数量原文")
          : emptyField("未单列检查数量"),
        note: emptyField("无备注"),
      },
      table: null,
      inspection_data_type: typed.type,
      inspection_data_type_reason: typed.reason,
      inspection_data_type_span_ids: [requirement?.span_id ?? heading.span_id],
      sampling: samplingFor(quantityText, quantity?.span_id),
      reason: clause.column
        ? "底账条款带原文分类栏目，按原文登记 span；仍须由模型核对判据和适用范围"
        : "底账未发现主控/一般分类栏目；暂记原文未标明，须由模型核查上位分组、索引和适用引用后确认",
    });
  }

  // Prefill registers unvalidated candidates, not semantic coverage decisions.
  // In particular, row evidence may not be expandable by the HTML helper above.
  // Leave unhandled evidence pending for the model; neither a clause skeleton
  // nor an expanded table proves that the remaining source is only background.

  return {
    selectors,
    registry,
    clause_item_count: selectors.items.length - tableItemCount,
    table_item_count: tableItemCount,
  };
}
