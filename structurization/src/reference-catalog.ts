import { sha256Json } from "./canonical.js";

/**
 * 被引目标的「可挑选目录」。
 *
 * 拆解不会让内容变小，只会变大——把附录切成要点，每条都要加编号、分类、说明、定位，
 * 原文 31 KB 拆完 104 KB。省下来的字节只能来自「挑」：先给一份几 KB 的目录，
 * 主 Agent 逐条表态，只有被挑中的条目才展开原文。
 *
 * 目录由规则确定性生成，零模型调用；规则跑完由 verifyReferenceCatalog 做总和守恒校验。
 * 校验不过才轮到规则发现 Agent（reference-catalog-discovery.ts），再不过退到兜底分段。
 */

/** 目录只依赖证据的这几个字段，保持纯函数、可单测。 */
export interface CatalogEvidenceRecord {
  evidence_id: string;
  role: string;
  locator: string;
  text: string;
}

export type ReferenceCatalogEntryKind = "table" | "clause" | "segment";

export interface ReferenceCatalogEntry {
  entry_id: string;
  /** 原文中的章节号、条款号或表号，仅用于展示；entry_id 是可调用的机器标识。 */
  source_label: string;
  kind: ReferenceCatalogEntryKind;
  title: string;
  /** 表体行数 / 条文下的款数。 */
  rows: number;
  notes: number;
  /** 主表 + 续表被并进同一条目时 > 1。 */
  segments: number;
  start_line: number;
  end_line: number;
  evidence_ids: string[];
}

/**
 * 规则本体。每条都是正则源码字符串——因为规则发现 Agent 产出的就是这个，
 * 必须能被持久化、被缓存、被单测断言，而不是藏在代码里的字面量。
 */
export interface ReferenceCatalogRules {
  /** 表标题：捕获组 1 = 表号，捕获组 2 = 表名。 */
  table_title: string;
  /** 续表标记：捕获组 1 = 表号，归并回同一条目而不新开。 */
  table_continuation: string;
  /** 条文号：捕获组 1 = 条文号，捕获组 2 = 首句。 */
  clause: string;
  /** 款：挂到当前条文。 */
  subitem: string;
}

/**
 * 国标最常见形态的兜底规则。附录用 `表 B.0.3-1 回波损耗(RL)值` / `B.0.1 …`，
 * 也覆盖 `表 A 检验项目及内容` 这种没有 `-序号` 后缀的整表附录。
 */
export const DEFAULT_REFERENCE_CATALOG_RULES: ReferenceCatalogRules = {
  table_title: "^表\\s*([A-Z](?:\\.\\d+)*(?:-\\d+)?)\\s+(.*)$",
  table_continuation: "^续表\\s*([A-Z](?:\\.\\d+)*(?:-\\d+)?)\\s*$",
  clause: "^([A-Z]\\.\\d+(?:\\.\\d+)*)\\s+(.+)$",
  subitem: "^(\\d+)\\s*[)）]\\s*(.+)$",
};

const TABLE_BODY_ROLES = new Set(["formal_table_header", "formal_table_row"]);
const TABLE_NOTE_ROLES = new Set(["table_note"]);
/** 规则发现 Agent 产出的正则要落盘、要编译，给个上限免得被塞进一整篇文章。 */
const MAX_RULE_SOURCE_LENGTH = 400;
const TITLE_MAX_LENGTH = 60;

export class ReferenceCatalogRuleError extends Error {
  constructor(readonly field: keyof ReferenceCatalogRules, readonly detail: string) {
    super(`invalid catalog rule ${field}: ${detail}`);
    this.name = "ReferenceCatalogRuleError";
  }
}

/** 编译规则；非法正则当场抛错，不让它在全量上悄悄匹配不到。 */
export function compileReferenceCatalogRules(
  rules: ReferenceCatalogRules,
): Record<keyof ReferenceCatalogRules, RegExp> {
  const fields: Array<keyof ReferenceCatalogRules> = [
    "table_title",
    "table_continuation",
    "clause",
    "subitem",
  ];
  const compiled = {} as Record<keyof ReferenceCatalogRules, RegExp>;
  for (const field of fields) {
    const source = rules[field];
    if (typeof source !== "string" || source.length === 0) {
      throw new ReferenceCatalogRuleError(field, "missing");
    }
    if (source.length > MAX_RULE_SOURCE_LENGTH) {
      throw new ReferenceCatalogRuleError(field, `longer than ${MAX_RULE_SOURCE_LENGTH} characters`);
    }
    try {
      compiled[field] = new RegExp(source, "u");
    } catch (error) {
      throw new ReferenceCatalogRuleError(field, error instanceof Error ? error.message : "not a regex");
    }
  }
  return compiled;
}

export function catalogLineNumber(record: { locator: string }): number {
  const match = /^line:(\d+)/.exec(record.locator);
  return match ? Number(match[1]) : 0;
}

function catalogRowIndex(record: { locator: string }): number {
  const match = /table-row:(\d+)$/.exec(record.locator);
  return match ? Number(match[1]) : 0;
}

function normalizeText(text: string): string {
  return String(text ?? "").replace(/\s+/gu, " ").trim();
}

function orderEvidence(evidence: readonly CatalogEvidenceRecord[]): CatalogEvidenceRecord[] {
  return [...evidence].sort((left, right) => {
    const byLine = catalogLineNumber(left) - catalogLineNumber(right);
    if (byLine !== 0) return byLine;
    return catalogRowIndex(left) - catalogRowIndex(right);
  });
}

function newEntry(
  kind: ReferenceCatalogEntryKind,
  sourceLabel: string,
  title: string,
  line: number,
): ReferenceCatalogEntry {
  return {
    entry_id: sourceLabel,
    source_label: sourceLabel,
    kind,
    title: title.slice(0, TITLE_MAX_LENGTH),
    rows: 0,
    notes: 0,
    segments: 0,
    start_line: line,
    end_line: line,
    evidence_ids: [],
  };
}

/**
 * 原文允许条文和表格共用同一个展示号。只有发生碰撞时才换成稳定机器 ID，
 * 使既有唯一编号保持兼容；不依据正文语义合并或拆分条目。
 */
function assignUniqueEntryIds(entries: ReferenceCatalogEntry[]): ReferenceCatalogEntry[] {
  const labelCounts = new Map<string, number>();
  for (const entry of entries) {
    labelCounts.set(entry.source_label, (labelCounts.get(entry.source_label) ?? 0) + 1);
  }
  for (const entry of entries) {
    if ((labelCounts.get(entry.source_label) ?? 0) <= 1) continue;
    entry.entry_id = `catalog-entry:${sha256Json({
      source_label: entry.source_label,
      kind: entry.kind,
      evidence_ids: entry.evidence_ids,
    })}`;
  }
  return entries;
}

function attach(entry: ReferenceCatalogEntry, record: CatalogEvidenceRecord, line: number): void {
  entry.evidence_ids.push(record.evidence_id);
  if (line > entry.end_line) entry.end_line = line;
  if (line < entry.start_line) entry.start_line = line;
}

/**
 * 按行号走一遍，遇到标题就换档。规则只认标题行，不碰正文语义——
 * 语义判断（这张表跟哪个验收项目相关）只有主 Agent 做得了，它才知道自己在建什么。
 */
export function buildReferenceCatalog(
  evidence: readonly CatalogEvidenceRecord[],
  rules: ReferenceCatalogRules = DEFAULT_REFERENCE_CATALOG_RULES,
): ReferenceCatalogEntry[] {
  const compiled = compileReferenceCatalogRules(rules);
  const entries: ReferenceCatalogEntry[] = [];
  const tablesByNumber = new Map<string, ReferenceCatalogEntry>();
  let currentTable: ReferenceCatalogEntry | undefined;
  let currentClause: ReferenceCatalogEntry | undefined;

  for (const record of orderEvidence(evidence)) {
    const line = catalogLineNumber(record);
    const text = normalizeText(record.text);

    if (TABLE_BODY_ROLES.has(record.role)) {
      if (currentTable) {
        currentTable.rows += 1;
        attach(currentTable, record, line);
      }
      continue;
    }

    if (TABLE_NOTE_ROLES.has(record.role)) {
      const owner = currentTable ?? currentClause;
      if (owner) {
        owner.notes += 1;
        attach(owner, record, line);
      }
      continue;
    }

    const tableTitle = compiled.table_title.exec(text);
    const tableNumber = tableTitle?.[1] ?? "";
    if (tableTitle && tableNumber) {
      const existing = tablesByNumber.get(tableNumber);
      if (existing) {
        currentTable = existing;
      } else {
        currentTable = newEntry("table", tableNumber, (tableTitle[2] ?? "").trim() || tableNumber, line);
        tablesByNumber.set(tableNumber, currentTable);
        entries.push(currentTable);
      }
      currentTable.segments += 1;
      attach(currentTable, record, line);
      continue;
    }

    const continuation = compiled.table_continuation.exec(text);
    if (continuation) {
      // 续表并回主表：模型把 `表 B.0.3-1` 和 `续表 B.0.3-1` 当成两张表，是拆碎的主要来源之一。
      const owner = tablesByNumber.get(continuation[1] ?? "") ?? currentTable;
      if (owner) {
        currentTable = owner;
        owner.segments += 1;
        attach(owner, record, line);
      }
      continue;
    }

    const clause = compiled.clause.exec(text);
    const clauseNumber = clause?.[1] ?? "";
    if (clause && clauseNumber) {
      currentClause = newEntry("clause", clauseNumber, (clause[2] ?? "").trim(), line);
      currentClause.segments = 1;
      entries.push(currentClause);
      attach(currentClause, record, line);
      currentTable = undefined;
      continue;
    }

    if (currentClause && compiled.subitem.test(text)) {
      currentClause.rows += 1;
      attach(currentClause, record, line);
      continue;
    }

    const owner = currentTable ?? currentClause;
    if (owner) attach(owner, record, line);
  }

  return assignUniqueEntryIds(entries);
}

/**
 * 规则彻底不适用时的安全网：按行号连续分段，保证目录一定存在且一定全覆盖。
 * 宁可给一份粗目录，也不要让这个目标彻底不可用。
 */
export function buildFallbackCatalog(
  evidence: readonly CatalogEvidenceRecord[],
  bucketSize = 24,
): ReferenceCatalogEntry[] {
  const ordered = orderEvidence(evidence);
  const size = Math.max(1, Math.trunc(bucketSize) || 24);
  const entries: ReferenceCatalogEntry[] = [];
  for (let index = 0; index < ordered.length; index += size) {
    const bucket = ordered.slice(index, index + size);
    const first = bucket[0];
    if (!first) continue;
    const line = catalogLineNumber(first);
    const entry = newEntry("segment", `seg:${entries.length + 1}`, normalizeText(first.text), line);
    entry.segments = 1;
    for (const record of bucket) {
      entry.rows += 1;
      attach(entry, record, catalogLineNumber(record));
    }
    entries.push(entry);
  }
  return assignUniqueEntryIds(entries);
}

export interface ReferenceCatalogIssue {
  code: string;
  message: string;
  details: Record<string, unknown>;
}

export interface ReferenceCatalogVerification {
  ok: boolean;
  coverage: number;
  entry_count: number;
  evidence_count: number;
  issues: ReferenceCatalogIssue[];
}

/** 目录粒度下限：条目数超过证据数这个比例，说明根本没聚合。 */
const MAX_ENTRY_TO_EVIDENCE_RATIO = 0.5;
/** 小于这个规模的目标，切成一条也算合理，不触发「未生效」。 */
const MIN_EVIDENCE_FOR_SPLIT = 50;

/**
 * 总和守恒校验。上一版 DSL pipeline 栽在「失败信号只看抽到 0」——
 * 对「抽错了」「抽多了」一概视为成功。这里五道闸门全是可判定的机械检查：
 * 规则猜错会被当场拒绝，并指出差在哪里，而不是静默产出一份看着合理的目录。
 */
export function verifyReferenceCatalog(
  entries: readonly ReferenceCatalogEntry[],
  evidence: readonly CatalogEvidenceRecord[],
): ReferenceCatalogVerification {
  const issues: ReferenceCatalogIssue[] = [];
  const entryIdCounts = new Map<string, number>();
  for (const entry of entries) {
    entryIdCounts.set(entry.entry_id, (entryIdCounts.get(entry.entry_id) ?? 0) + 1);
  }
  const duplicatedEntryIds = [...entryIdCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([entryId]) => entryId);
  if (duplicatedEntryIds.length > 0) {
    issues.push({
      code: "catalog_entry_id_duplicated",
      message: `有 ${duplicatedEntryIds.length} 个目录机器 entry_id 不唯一`,
      details: { duplicated_entry_ids: duplicatedEntryIds.slice(0, 5) },
    });
  }
  const seen = new Map<string, number>();
  for (const entry of entries) {
    for (const id of entry.evidence_ids) seen.set(id, (seen.get(id) ?? 0) + 1);
  }
  const evidenceCount = evidence.length;
  const covered = evidence.filter((record) => seen.has(record.evidence_id)).length;
  const coverage = evidenceCount === 0 ? 1 : covered / evidenceCount;

  // 闸门1 全覆盖：每条证据必须落进目录，一条都不能漏。
  if (covered < evidenceCount) {
    const missing = evidence
      .filter((record) => !seen.has(record.evidence_id))
      .slice(0, 5)
      .map((record) => ({ locator: record.locator, role: record.role, text: normalizeText(record.text).slice(0, 80) }));
    issues.push({
      code: "catalog_coverage_incomplete",
      message: `${evidenceCount - covered} of ${evidenceCount} evidence records were not classified`,
      details: { covered, evidence_count: evidenceCount, unclassified_samples: missing },
    });
  }

  // 闸门2 不重复：一条证据只能归一个条目，否则边界算错了。
  const duplicated = [...seen.entries()].filter(([, count]) => count > 1).map(([id]) => id);
  if (duplicated.length > 0) {
    issues.push({
      code: "catalog_evidence_duplicated",
      message: `${duplicated.length} evidence records were classified into more than one entry`,
      details: { duplicated_evidence_ids: duplicated.slice(0, 5) },
    });
  }

  // 闸门3 不能没切：整份只出一条等于规则没生效。
  if (entries.length <= 1 && evidenceCount > MIN_EVIDENCE_FOR_SPLIT) {
    issues.push({
      code: "catalog_not_segmented",
      message: `only ${entries.length} entries for ${evidenceCount} evidence records`,
      details: { entry_count: entries.length, evidence_count: evidenceCount },
    });
  }

  // 闸门4 不能碎切：条目数接近证据数，说明没聚合——把一张表拆成一行一条就是这种。
  if (entries.length > evidenceCount * MAX_ENTRY_TO_EVIDENCE_RATIO && evidenceCount > 0) {
    issues.push({
      code: "catalog_granularity_too_fine",
      message: `${entries.length} entries for ${evidenceCount} evidence records leaves nothing aggregated`,
      details: { entry_count: entries.length, evidence_count: evidenceCount },
    });
  }

  // 闸门5 行号区间不能倒挂。
  const inverted = entries.filter((entry) => entry.end_line < entry.start_line).map((entry) => entry.entry_id);
  if (inverted.length > 0) {
    issues.push({
      code: "catalog_line_range_inverted",
      message: `${inverted.length} entries have end_line before start_line`,
      details: { entry_ids: inverted.slice(0, 5) },
    });
  }

  return {
    ok: issues.length === 0,
    coverage,
    entry_count: entries.length,
    evidence_count: evidenceCount,
    issues,
  };
}

/** 目录的对外形态：一条一行，主 Agent 就是靠这个挑。 */
export function renderReferenceCatalog(entries: readonly ReferenceCatalogEntry[]): Array<Record<string, unknown>> {
  return entries.map((entry) => ({
    entry_id: entry.entry_id,
    source_label: entry.source_label,
    kind: entry.kind,
    title: entry.title,
    size: entry.notes > 0 ? `${entry.rows}rows+${entry.notes}notes` : `${entry.rows}rows`,
    lines: `${entry.start_line}-${entry.end_line}`,
    evidence_count: entry.evidence_ids.length,
  }));
}

/**
 * 给规则发现 Agent 看的样本：只送疑似标题行和每种 role 的头几条，几 KB 而已。
 * 绝不送全文——送全文就退回原来那个把附录整本塞进会话的问题了。
 */
export function catalogSampleForRuleDiscovery(
  evidence: readonly CatalogEvidenceRecord[],
  maxLines = 60,
): Array<{ locator: string; role: string; text: string }> {
  const ordered = orderEvidence(evidence);
  const perRole = new Map<string, number>();
  const picked: CatalogEvidenceRecord[] = [];
  for (const record of ordered) {
    if (TABLE_BODY_ROLES.has(record.role)) {
      // 表体只送头两行做形态示例，数据行对认标题毫无帮助。
      const count = perRole.get(record.role) ?? 0;
      if (count >= 2) continue;
      perRole.set(record.role, count + 1);
      picked.push(record);
      continue;
    }
    const count = perRole.get(record.role) ?? 0;
    perRole.set(record.role, count + 1);
    // 非表体行（正文、表注）是标题的藏身处，多送一些。
    if (count < maxLines) picked.push(record);
  }
  return picked.slice(0, maxLines).map((record) => ({
    locator: record.locator,
    role: record.role,
    text: normalizeText(record.text).slice(0, 120),
  }));
}
