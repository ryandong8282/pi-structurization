import { classifySamplingOccurrence } from "./domain-contract.js";
import { sha256Text } from "./canonical.js";
import { collapseHanTypesettingSpacing, NUMBERED_PROSE_BOUNDARY } from "./text-normalization.js";
import {
  locateAndRegisterSourceQuote,
  registerSourceSpan,
  sourceSpanCoveredBy,
  SourceSpanRegistryError,
  type SourceSpanRegistry,
} from "./source-span-registry.js";
import {
  DOCUMENT_SELECTOR_PLAN_SCHEMA_VERSION,
  type DocumentSelectorPlan,
} from "./document-selector-compiler.js";
import { clipSourceToLineWindow } from "./source-window.js";
import { documentContentRanges } from "./document-content-ranges.js";

export const DOCUMENT_LEDGER_SCHEMA_VERSION = "document-ledger/v1" as const;

export type LedgerColumn = "主控项目" | "一般项目";
export type LedgerClauseKind = "item_candidate" | "non_item" | "anomaly";

export interface LedgerAtomRef {
  atom_id: string;
  start_line: number;
  end_line: number;
  text: string;
}

export interface LedgerClause {
  clause_id: string;
  line: number;
  end_exclusive_line: number;
  text: string;
  kind: LedgerClauseKind;
  column?: LedgerColumn;
  has_quantity: boolean;
  has_method: boolean;
  quantity_line?: number;
  method_line?: number;
  field_role_ranges?: Array<{
    role: "method" | "quantity";
    start_line: number;
    end_exclusive_line: number;
  }>;
  sampling_kind?: string;
  /**
   * 条文正文引用了某张表（含跨章/附录引用）。
   * 表的归属、跨引用解析和「按行展开还是按条计项」是语义判断，确定性抽取做不了：
   * 对 GB 50576 金标实测，无表引用的 38 条里 37 条粒度与人工一致，
   * 带表引用的条款则两个方向都会偏（附录表跟不进去、邻表被误认）。
   */
  references_table?: boolean;
  /**
   * 整节转指时，条文自己写明的被指向节号
   * (`5.2.1 土建交接检验应符合本规范第 4.2 节的规定` → `"4.2"`)。章级转指记章号。
   * 这是文档白纸黑字给出的事实、不是推断；底账把它记下来，窗口解析才不必
   * 靠模型碰巧去引对那一节。
   */
  delegates_to_section?: string;
}

export interface LedgerHeading {
  line: number;
  level: number;
  number: string;
  title: string;
  text: string;
  role: "target_window" | "ignored" | "group";
}

export interface LedgerTargetWindow {
  window_id: string;
  heading_line: number;
  start_line: number;
  end_exclusive_line: number;
  number: string;
  title: string;
  heading_text: string;
  extractable_clause_ids: string[];
  ignored: boolean;
}

export interface LedgerRecordTable {
  table_id: string;
  caption_line: number;
  table_no: string;
  title: string;
  nearby_text: string;
}

/** 全文表题清册：正文里以「表 X」起行的题注，用于校验条款的表引用能否落到实体表。 */
export interface LedgerTableCaption {
  table_no: string;
  line: number;
  title: string;
}

/** 索引表里点名的一条：条文号，以及表里同一行印着的主控/一般与项目名。 */
export interface LedgerIndexedClause {
  clause_id: string;
  column?: LedgerColumn;
  item_name?: string;
}

export interface LedgerAnomaly {
  line: number;
  text: string;
  reason: string;
}

export interface DocumentLedger {
  schema_version: typeof DOCUMENT_LEDGER_SCHEMA_VERSION;
  source_sha256: string;
  file_name: string;
  clauses: LedgerClause[];
  headings: LedgerHeading[];
  windows: LedgerTargetWindow[];
  record_tables: LedgerRecordTable[];
  /** 老 ledger 文件没有这个字段；缺失表示表引用校验不可用，而不是「没有表」。 */
  tables?: LedgerTableCaption[];
  anomalies: LedgerAnomaly[];
  /**
   * 被文档自身的索引表点名的条文（见 indexedClausesFromTables）。
   * 除条文号外还带回索引表里印着的主控/一般和项目名——这两样在
   * GB 50339 这类书上正文里根本拿不到，只有索引表有。
   * 老 ledger 文件没有这个字段，缺失按空集处理。
   */
  indexed_clauses?: LedgerIndexedClause[];
}

export interface DiscoveryLedgerAgreement {
  /** Accounting closure; unlike skip_reviewer, permits a reviewed zero-target document. */
  complete: boolean;
  skip_reviewer: boolean;
  uncovered_clause_ids: string[];
  overlapping_clause_ids: string[];
  /**
   * 一个 target 都没认领的候选条文——识别阶段的静默丢弃。
   * 与 uncovered_clause_ids 的区别：那个建立在靠词样识别的必抽集之上，
   * 词样认不出的文档它恒为空；这个按编号数，与措辞无关。纯诊断，不参与 skip_reviewer。
   */
  unclaimed_candidate_clause_ids: string[];
  conflict_atom_ids: string[];
  anomalies: LedgerAnomaly[];
}

export interface TargetLedgerCoverage {
  complete: boolean;
  required_clause_ids: string[];
  /**
   * 窗口内「长得像验收条文」的全部条文，按编号数出来、与措辞无关。
   * 必抽集只是它的子集——必抽靠 8 个固定词样识别，词样认不出的条文
   * 连被问到的机会都没有。
   */
  candidate_clause_ids: string[];
  /**
   * 候选里既没产出项目、也没被声明为非验收项的条文——当前被静默丢弃的部分。
   * 纯诊断，不参与 complete。
   */
  unaccounted_candidate_clause_ids: string[];
  covered_clause_ids: string[];
  gap_clause_ids: string[];
  gap_evidence_ids: string[];
  /** 抽取结果里没写条文号的项目数：对不上账，不能算覆盖已证明。 */
  unlabeled_item_count: number;
  /** 抽取结果引用了底账里根本不存在的条文号（幻觉方向）。 */
  extra_clause_ids: string[];
  /** 窗口内没有任何底账条文，闸门无从证明覆盖——此时必须走复核，不得放行。 */
  vacuous: boolean;
}

const COLUMN_MASTER_RE = /主\s*控\s*项\s*目/;
const COLUMN_GENERAL_RE = /一\s*般\s*项\s*目/;
const QUANTITY_RE = /检查数量|检验数量|检测数量|抽样数量|抽检数量|抽查数量/;
const METHOD_RE = /检验方法|检查方法/;
const NON_ITEM_HEADING_RE = /总\s*则|术\s*语|缩\s*略\s*语|基\s*本\s*规\s*定|一\s*般\s*规\s*定|条\s*文\s*说\s*明|本规范用词|引用标准|前言|^工程\s*验\s*收$|竣\s*工\s*验\s*收|分部\s*[(（]?\s*子分部\s*[)）]?\s*工程验收/;
const NON_NORMATIVE_TAIL_TITLE_RE = /^(?:附\s*[:：]\s*)?(?:本\s*(?:规范|标准)\s*用\s*词\s*说明|引用\s*标准\s*名\s*录|条\s*文\s*说\s*明)$/u;
const RECORD_TABLE_RE = /检验批.{0,12}(?:质量)?验收记录|验收记录表/;
const TABLE_NO_RE = /表\s*([A-Za-z]{1,3}|[一二三四五六七八九十]|[0-9]+)(?:\s*[.．]\s*\d+){0,3}/;
const TABLE_CAPTION_LINE_RE = /^(?:#{1,6}\s*)?(?:续表|表)\s*([0-9A-Za-z]{1,3}(?:\s*[.．]\s*\d+){0,3}(?:\s*-\s*\d+)?)(?![0-9A-Za-z]|[ \t]*[.．-])/;
const CLAUSE_ID_RE = new RegExp(String.raw`^(?:#{1,6}\s*)?(\d+(?:\s*[.．]\s*\d+){2,}|(?:[A-Za-z]|[Il1]{2,3})(?:\s*[.．]\s*\d+){2,})${NUMBERED_PROSE_BOUNDARY}(\S.*)$`, "u");
const NUMBERED_HEADING_RE = /^\s*(#{1,6})\s+(.+?)\s*$/;
const ANOMALY_CLAUSE_RE = /^(?:#{1,6}\s*)?([Il1]{2,3}|[A-Za-z]{2,})(?:\s*[.．]\s*\d+){2,}\b/;
const PDF_PAGE_RE = /\s*\[PDF p\.\d+\]\s*$/;

function normalizeId(value: string): string {
  return value.normalize("NFKC").replaceAll("．", ".").replace(/\s+/g, "");
}

function stripPageMarker(value: string): string {
  return value.replace(PDF_PAGE_RE, "").trim();
}

function headingNumberAndTitle(rawTitle: string): { number: string; title: string } {
  const title = stripPageMarker(rawTitle);
  // MinerU may emit a formal clause as either plain text or a Markdown heading.
  // Reuse the clause grammar before parsing chapter/section headings so appendix
  // clauses such as `## B.1.3 ...` cannot disappear in the heading-only branch.
  const clause = CLAUSE_ID_RE.exec(title);
  if (clause) {
    return { number: normalizeId(clause[1]!), title: clause[2]!.trim() };
  }
  const numbered = /^(?:第\s*)?(\d+(?:\s*[.．]\s*\d+)*)(?:\s*[章节篇]?\s+|\s+)(.*)$/.exec(title);
  if (numbered) {
    return { number: normalizeId(numbered[1]!), title: numbered[2]!.trim() || title };
  }
  const appendix = /^(?:附录\s*)?([A-Za-z])(?:\s|$|[\.．])(.*)$/.exec(title);
  if (appendix && /附录/.test(title)) {
    return { number: appendix[1]!.toUpperCase(), title: title.replace(/^附录\s*/, "").trim() };
  }
  return { number: "", title };
}

function compactHeading(value: string): string {
  return value.replace(/\s+/g, "");
}

function isNonItemTitle(title: string): boolean {
  return NON_ITEM_HEADING_RE.test(title) || NON_ITEM_HEADING_RE.test(compactHeading(title));
}

/**
 * 返回规范正文结束处的 1-based 行号；该行本身属于用词说明、引用标准或条文说明。
 *
 * 只接受标题的完整文本，避免把目录里的「本规范用词说明 80」误当成正文终点。
 * 没有尾部非正文区的旧文档返回 undefined，由调用方保留全文行为。
 */
export function documentNormativeEndLine(lines: readonly string[]): number | undefined {
  for (let index = 0; index < lines.length; index += 1) {
    const heading = NUMBERED_HEADING_RE.exec(lines[index] ?? "");
    if (!heading?.[2]) continue;
    const title = stripPageMarker(heading[2]);
    if (isNonItemTitle(title) && NON_NORMATIVE_TAIL_TITLE_RE.test(title)) {
      return index + 1;
    }
  }
  return undefined;
}

function isColumnOnlyHeading(text: string): boolean {
  if (!detectColumn(text)) return false;
  const compact = compactHeading(stripPageMarker(text)).replace(/^#+/, "");
  return compact.length <= 12;
}

/** 附录条文号（A.0.1、H.0.10）。附录是被正文条款引用的资源，不是独立抽取范围。 */
function isAppendixClauseId(clauseId: string): boolean {
  return /^[A-Za-z]\./.test(clauseId);
}

/** 标题编号是单个字母时必然来自「附录 X」——headingNumberAndTitle 只在带「附录」时才这么解析。 */
function isAppendixHeadingNumber(number: string): boolean {
  return /^[A-Za-z]$/.test(number);
}

/**
 * 条文号 → 所属「节」的标题编号。
 * `15.0.1` / `A.0.1` 这种中段为 0 的写法表示「本章直属条文，没有节」，
 * 必须归到章号 `15` / `A`，否则会去找一个不存在的 `15.0` 标题，
 * 进而拿条文正文当标题伪造出一个抽取窗口。
 */
function sectionKeyFromClauseId(clauseId: string): string | undefined {
  const numeric = /^(\d+)\.(\d+)\.\d+/.exec(clauseId);
  if (numeric) return numeric[2] === "0" ? numeric[1]! : `${numeric[1]}.${numeric[2]}`;
  const appendix = /^([A-Za-z])\.(\d+)\.\d+/.exec(clauseId);
  if (appendix) return appendix[2] === "0" ? appendix[1]! : `${appendix[1]}.${appendix[2]}`;
  return undefined;
}

/**
 * OCR 掉了节标题时的窗口名兜底：去掉条文号前缀后取短句，绝不把整条条文正文当标题。
 */
function sectionTitleFromClauseText(text: string): string {
  const body = text.replace(/^\s*(?:\d+|[A-Za-z])(?:\s*[.．]\s*\d+)*\s*/, "").trim();
  const sentence = body.split(/[。；;]/)[0]?.trim() ?? "";
  return (sentence || body).slice(0, 24);
}

function detectColumn(text: string): LedgerColumn | undefined {
  const compact = text.replace(/\s+/g, "");
  if (compact === "主控项目" || COLUMN_MASTER_RE.test(text) && compact.length <= 12) return "主控项目";
  if (compact === "一般项目" || COLUMN_GENERAL_RE.test(text) && compact.length <= 12) return "一般项目";
  if (/^#{1,6}\s*.*(?:主\s*控\s*项\s*目|一\s*般\s*项\s*目)/.test(text) && compact.length <= 24) {
    return COLUMN_MASTER_RE.test(text) ? "主控项目" : "一般项目";
  }
  return undefined;
}

const CLAUSE_TABLE_REFERENCE_RE = /表\s*[0-9A-Za-z]/;

const SECTION_DELEGATION_RE = /应符合本(?:规范|标准)第([\d.．\s]+)([章节])(?:的有关|有关|的)?规定/;

/**
 * 「整节转指」：条款正文只说「本项应符合本规范第 X 节的规定」，没有自己的验收内容。
 * 验收项目落在被指向的那一节的各条上（GB 50310 液压电梯第 5 章大量如此：
 * 5.4.1 导轨安装应符合第 4.4 节的规定 → 真正的项目是 4.4.1~4.4.6）。
 * 把它留在必抽集里，抽取端永远交不出对应项目，闸门会无限期卡住。
 *
 * 与「转指某张表」严格区分：`应符合本规范表 E.0.1 的规定` 仍然是一个验收检查点，
 * 只是判定值在表里（GB 50576 10.3.8）——那种必须保留为验收项目。
 */
function wholeScopeDelegationTarget(
  clauseId: string,
  clauseBody: string,
): string | undefined {
  const body = clauseBody
    .replace(new RegExp(`^\\s*${clauseId.replace(/\./g, "\\.")}\\s*`), "")
    // legacy markdown 的 `<!-- pages_021_030 -->` chunk 标记会混进条文正文，
    // 不去掉就会被当成「还有第二句」而漏判。
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\s+/g, "");
  const match = SECTION_DELEGATION_RE.exec(body);
  if (!match) return undefined;
  // 正文里另有表/附录引用或额外句子的，说明它自己还有验收内容，不算纯转指。
  if (/表[\dA-Za-z]|附\s*录/.test(body)) return undefined;
  const sentences = body.split(/[。；;]/).map((part) => part.trim()).filter(Boolean);
  if (sentences.length !== 1) return undefined;
  const section = match[1]!.normalize("NFKC").replaceAll("．", ".").replace(/\s+/g, "")
    .replace(/\.$/, "");
  return section || undefined;
}

function isAnomalousClauseId(clauseId: string): boolean {
  // 罗马数字附录号被 OCR 成 I/l/1 混排（II.0.10、1I.0.10）才是异常；
  // 纯数字前缀是正常章号（11.2.1 属第 11 章），不能当垃圾扫掉。
  const leading = /^[Il1]+/.exec(clauseId)?.[0] ?? "";
  if (leading.length >= 2 && /[Il]/.test(leading)) return true;
  if (/^[A-Za-z]{2,}\./.test(clauseId)) return true;
  return false;
}

/**
 * 条文归属只认编号，不认「上一个见过的标题」。
 *
 * 继承 headingPath 字符串在两种常见 OCR 形态下会静默误杀整节验收项目：
 * 1. 节标题被 OCR 丢掉（GB 50206/50411），上一节的「一般规定」一直挂在路径上；
 * 2. 节标题本身就是栏目名（GB 50243 的 `# 4.2 主控项目`），被当作栏目行吃掉，
 *    从不进 headings，于是 4.1「一般规定」继续污染 4.2 全节。
 * 两者都让带检查数量的条文掉出必抽集，闸门就会在缺项的情况下放行。
 */
function clauseKind(
  clauseId: string,
  titleHints: string[],
  ignoredChapters: ReadonlySet<string>,
  ignoredSections: ReadonlySet<string>,
): LedgerClauseKind {
  if (isAnomalousClauseId(clauseId)) return "anomaly";
  // 附录（允许偏差表、试验方法、检验批记录表、分部检查项目清单）从来不是独立抽取范围：
  // 正文条款引用它们，抽取项目落在引用它的那一条上。
  if (isAppendixClauseId(clauseId)) return "non_item";
  const chapter = clauseId.split(".")[0] ?? "";
  if (ignoredChapters.has(chapter)) return "non_item";
  const section = sectionKeyFromClauseId(clauseId);
  if (section && ignoredSections.has(section)) return "non_item";
  if (isNonItemTitle(titleHints.join(" "))) return "non_item";
  return "item_candidate";
}

function atomsOverlappingLines(
  atoms: readonly LedgerAtomRef[],
  startLine: number,
  endExclusiveLine: number,
): LedgerAtomRef[] {
  return atoms.filter((atom) =>
    atom.start_line < endExclusiveLine && atom.end_line >= startLine
  );
}

export interface LedgerConfidence {
  /** 每个抽取窗口都由真实的节标题划出，没有一个是靠条文号反推重建的。 */
  every_window_has_heading: boolean;
  headless_window_numbers: string[];
  anomaly_count: number;
  target_window_count: number;
  /** 必抽条文里靠主控/一般栏目继承入选的条数（全文没有验收模板字段时才会 >0）。 */
  column_only_clause_count: number;
  /** 必抽条文里没有「检查数量」、只靠「检验方法」入选的条数。 */
  method_only_clause_count: number;
  /**
   * 可以在完全不经 LLM 的情况下直接封存底账窗口。
   *
   * 这一步 prefill 出来的计划再拿底账去校验是自我循环，没有第二个信息源兜底，
   * 所以门槛按「和已人工核对过的那份长得一样」来定，而不是按判据能跑通来定：
   * 窗口全部由真实节标题划出、无 OCR 异常、且每条必抽条文都带完整的
   * 检查数量 + 检验方法 模板（GB 50576 金标就是这个形态，LLM 独立跑出的 28 个
   * 检验批与底账窗口逐一吻合）。只有检验方法或只有栏目的文档先走 LLM 出一版，
   * 再用底账做独立对账——那条路上两个信息源互证，才有资格跳过复核。
   */
  safe_for_blind_seal: boolean;
}

/**
 * 底账自身的可信度。prefill 直封（零 LLM）时，底账既是提议者又是校验者，
 * 自校验恒真；这里用「底账有没有靠猜补过结构」作为唯一独立信号。
 */
export function evaluateLedgerConfidence(ledger: DocumentLedger): LedgerConfidence {
  const targetWindows = ledger.windows.filter((window) =>
    !window.ignored && window.extractable_clause_ids.length > 0
  );
  const headless = targetWindows.filter((window) =>
    !ledger.headings.some((heading) => heading.number === window.number)
  );
  const extractable = ledger.clauses.filter(ledgerRequiredClausePredicate(ledger));
  // 只靠栏目继承入选（全文没有任何验收模板字段）的条文：底账在猜。
  const columnOnly = extractable.filter((clause) => !clause.has_quantity && !clause.has_method);
  const methodOnly = extractable.filter((clause) => !clause.has_quantity && clause.has_method);
  return {
    every_window_has_heading: headless.length === 0,
    headless_window_numbers: headless.map((window) => window.number),
    anomaly_count: ledger.anomalies.length,
    target_window_count: targetWindows.length,
    column_only_clause_count: columnOnly.length,
    method_only_clause_count: methodOnly.length,
    safe_for_blind_seal: headless.length === 0
      && ledger.anomalies.length === 0
      && targetWindows.length > 0
      && columnOnly.length === 0
      && methodOnly.length === 0,
  };
}

/**
 * 「这条是不是验收项目」的唯一判据，全库只此一处。
 *
 * 跨标准的公约数是**验收模板字段**，不是单看「检查数量」：
 *  - 家族 A（GB 50576/50205/50303/50243…）检查数量与检验方法配套出现，两者等价；
 *  - 家族 B（GB 50207/50209/50210/50242…）老标准只写「检验方法」，不单列检查数量，
 *    只认检查数量会把整本书的验收项目漏掉（GB 50202 只剩 8 条，实际 76 条）；
 *  - 家族 C（GB 50310）两个字段都没有，全书条文即项目，此时才退回主控/一般栏目。
 *
 * 栏目是最弱的信号（靠上下文继承，OCR 一乱就漂），所以只在全文都没有模板字段时兜底，
 * 不再和检查数量并列——并列会让 GB 50209 多要 152 条靠继承漂过来的条文。
 */
export function ledgerRequiredClausePredicate(
  ledger: DocumentLedger,
): (clause: LedgerClause) => boolean {
  return requiredClausePredicateFor(
    ledger.clauses,
    new Set((ledger.indexed_clauses ?? []).map((entry) => entry.clause_id)),
  );
}

function requiredClausePredicateFor(
  clauses: readonly LedgerClause[],
  indexedClauseIds: ReadonlySet<string> = new Set(),
): (clause: LedgerClause) => boolean {
  const hasTemplateFields = clauses.some((clause) =>
    clause.kind === "item_candidate" && (clause.has_quantity || clause.has_method)
  );
  return (clause) =>
    clause.kind === "item_candidate"
    && (
      // 文档自己的索引表点了名的，直接算必抽——那是文档给出的答案，比任何措辞判据都硬。
      indexedClauseIds.has(clause.clause_id)
      || (hasTemplateFields
        ? clause.has_quantity || clause.has_method
        : clause.column !== undefined)
    );
}

/**
 * 从「条文索引表」里读出被点名的条文号。
 *
 * 有些规范在附录里给出逐子分部的记录表，表中一列直接写着每个验收项目对应的条文号
 * （GB 50339 附录 C：`主控项目 | 接口功能 | 4.0.4`）。那是文档自己给出的
 * 「哪些条文是验收项目」的权威答案，比任何措辞判据都硬——GB 50339 全书 150 条候选里
 * 只有 3 条写了「检查数量」这类词样，而附录表点名了 86 条。
 *
 * 判据不认表头措辞（那正是踩过三次的坑：「本标准表 X」漏掉「本规范表」、
 * 「检查数量」漏掉「各接口均应检测」、「验收记录」漏掉「检测记录」），
 * 只认内容：**某一列里至少两个格子的值是本文档里真实存在的条文号**。
 * 条文号是本文档独有的具体字符串，两格同时命中不可能是巧合；对不上的自然被排除，
 * 表格里的允许偏差数值（`2.0`、`1.5`）也因为不在条文清册里而不会被误认。
 *
 * 只用来「点名」，不改变附录条文本身的归属：附录条文仍然是 non_item，
 * 这里读的是它指向的正文条文。
 */
function indexedClausesFromTables(
  lines: readonly string[],
  knownClauseIds: ReadonlySet<string>,
): LedgerIndexedClause[] {
  const indexed = new Map<string, LedgerIndexedClause>();
  if (!knownClauseIds.size) return [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!/<table\b/i.test(lines[index]!)) continue;
    // 表可能跨行，收到 </table> 为止（上限防未闭合表拖垮扫描）。
    const chunk: string[] = [];
    for (let cursor = index; cursor < lines.length && chunk.length < 400; cursor += 1) {
      chunk.push(lines[cursor]!);
      if (/<\/table>/i.test(lines[cursor]!)) break;
    }
    const rows = chunk.join("\n").split(/<\/tr>/i).map((row) =>
      [...row.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)]
        .map((cell) => cell[1]!.replace(/<[^>]+>/g, "").trim())
    );
    const hitColumns = new Set<number>();
    const columnHits = new Map<number, number>();
    for (const row of rows) {
      row.forEach((value, column) => {
        if (!knownClauseIds.has(normalizeId(value))) return;
        columnHits.set(column, (columnHits.get(column) ?? 0) + 1);
      });
    }
    for (const [column, hits] of columnHits) if (hits >= 2) hitColumns.add(column);
    if (!hitColumns.size) continue;

    // 主控/一般写在跨行合并的首格里，后续各行不再重复（HTML rowspan），
    // 所以要顺着行往下顺延；项目名取条文号左边紧邻的那一格，
    // 不用固定列号——同一张表里带栏目标签的行会整体右移一格。
    let column: LedgerColumn | undefined;
    for (const row of rows) {
      for (const cell of row) {
        const label = detectColumn(cell);
        if (label) column = label;
      }
      row.forEach((value, position) => {
        if (!hitColumns.has(position)) return;
        const clauseId = normalizeId(value);
        if (!knownClauseIds.has(clauseId)) return;
        const previous = row[position - 1]?.trim() ?? "";
        const itemName = previous
          && !knownClauseIds.has(normalizeId(previous))
          && !detectColumn(previous)
          && previous.length <= 40
          ? collapseHanTypesettingSpacing(previous)
          : "";
        const existing = indexed.get(clauseId);
        indexed.set(clauseId, {
          clause_id: clauseId,
          ...(itemName || existing?.item_name ? { item_name: itemName || existing!.item_name! } : {}),
          ...(column || existing?.column ? { column: column ?? existing!.column! } : {}),
        });
      });
    }
  }
  return [...indexed.values()].sort((left, right) =>
    left.clause_id.localeCompare(right.clause_id, undefined, { numeric: true })
  );
}

export function extractableClauseIds(ledger: DocumentLedger): string[] {
  const isRequired = ledgerRequiredClausePredicate(ledger);
  return ledger.clauses.filter(isRequired).map((clause) => clause.clause_id);
}

export function scanDocumentLedger(
  markdown: string,
  fileName: string,
): DocumentLedger {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const headings: LedgerHeading[] = [];
  const columnHeadingLines: number[] = [];
  const anomalies: LedgerAnomaly[] = [];
  const clauses: LedgerClause[] = [];
  const seenClauses = new Set<string>();
  const tableLines = new Set<number>();
  let tableDepth = 0;
  let currentColumn: LedgerColumn | undefined;
  const ignoredChapters = new Set<string>();
  const ignoredSections = new Set<string>();
  let currentChapter = "";

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    // Include opening/closing lines and one-line tables. Table headings are
    // coverage signals, not clause-level method/quantity prose.
    if (tableDepth > 0 || /<table\b/iu.test(line)) tableLines.add(index + 1);
    tableDepth = Math.max(0, tableDepth + ((line.match(/<table\b/gi)?.length ?? 0) - (line.match(/<\/table>/gi)?.length ?? 0)));
    const trimmed = line.trim();
    if (!trimmed) continue;

    const headingMatch = tableDepth === 0 ? NUMBERED_HEADING_RE.exec(line) : null;
    // MinerU can drop the Markdown marker on a real section heading. Require
    // the immediately following nonblank line to witness that exact section
    // with a child clause; a numeric body/list/table row alone is not enough.
    const plainSection = !headingMatch && !tableLines.has(index + 1)
      ? /^(\d+\s*[.．]\s*\d+)\s+(\S.*)$/u.exec(trimmed) : null;
    const followingClause = plainSection
      ? CLAUSE_ID_RE.exec(lines.slice(index + 1).find(nextLine => nextLine.trim())?.trim() ?? "") : null;
    const headingBody = headingMatch?.[2] ?? (plainSection && followingClause
      && sectionKeyFromClauseId(normalizeId(followingClause[1]!)) === normalizeId(plainSection[1]!)
      ? trimmed : undefined);
    if (headingMatch && isColumnOnlyHeading(trimmed)) {
      columnHeadingLines.push(index + 1);
      currentColumn = detectColumn(trimmed);
      continue;
    }
    if (headingBody) {
      const level = headingMatch ? headingMatch[1]!.length : 2;
      const { number, title } = headingNumberAndTitle(headingBody);
      const ignored = isNonItemTitle(title)
        || isNonItemTitle(headingBody)
        || isAppendixHeadingNumber(number);
      if (ignored && number && !number.includes(".")) ignoredChapters.add(number);
      if (ignored && number && number.includes(".")) ignoredSections.add(number);
      const componentCount = number ? number.split(".").length : 0;
      headings.push({
        line: index + 1,
        level,
        number,
        title: title || stripPageMarker(headingBody),
        text: stripPageMarker(trimmed),
        role: ignored
          ? "ignored"
          : componentCount === 2
            ? "target_window"
            : "group",
      });
      // 章/节标题开启新范围，栏目状态要清空，否则上一节的「主控项目」会一路漏进后面的章节。
      // 但只认「编号站得住脚」的标题：条文里的分项 `1)` `2` 常被 OCR 提成一级标题
      // （GB 50310 的 `# 2 下列安全开关…` 就在第 4 章正文里），编号回退说明它是列表项不是章，
      // 拿它清栏目会误伤紧随其后的条文。章号必须不倒退，节号必须属于当前章。
      const numericChapter = /^\d+$/.test(number) ? number : "";
      const isForwardChapter = componentCount === 1
        && numericChapter !== ""
        && (currentChapter === "" || Number(numericChapter) >= Number(currentChapter));
      const isSectionOfCurrentChapter = componentCount === 2
        && currentChapter !== ""
        && number.split(".")[0] === currentChapter;
      if (isForwardChapter) currentChapter = numericChapter;
      const structuralHeading = ignored
        || isAppendixHeadingNumber(number)
        || isForwardChapter
        || isSectionOfCurrentChapter;
      const headingColumn = detectColumn(trimmed);
      currentColumn = headingColumn ?? (structuralHeading ? undefined : currentColumn);
      if (componentCount >= 3 && !seenClauses.has(number)) {
        seenClauses.add(number);
        const kind = clauseKind(number, [title], ignoredChapters, ignoredSections);
        clauses.push({
          clause_id: number,
          line: index + 1,
          end_exclusive_line: lines.length + 1,
          text: `${number} ${title}`.trim(),
          kind,
          ...(currentColumn ? { column: currentColumn } : {}),
          has_quantity: QUANTITY_RE.test(trimmed),
          has_method: METHOD_RE.test(trimmed),
        });
      }
      continue;
    }

    const column = detectColumn(trimmed);
    if (column && tableDepth === 0) {
      columnHeadingLines.push(index + 1);
      currentColumn = column;
      continue;
    }

    if (tableDepth > 0) continue;

    if (ANOMALY_CLAUSE_RE.test(trimmed) && !/^\d+\./.test(normalizeId(trimmed))) {
      const anomalyMatch = CLAUSE_ID_RE.exec(trimmed);
      if (anomalyMatch && isAnomalousClauseId(normalizeId(anomalyMatch[1]!))) {
        anomalies.push({
          line: index + 1,
          text: stripPageMarker(trimmed).slice(0, 160),
          reason: `OCR-looking clause id ${normalizeId(anomalyMatch[1]!)}`,
        });
      }
    }

    const clauseMatch = CLAUSE_ID_RE.exec(trimmed);
    if (!clauseMatch) continue;
    const clauseId = normalizeId(clauseMatch[1]!);
    if (seenClauses.has(clauseId)) continue;
    seenClauses.add(clauseId);
    const kind = clauseKind(clauseId, [clauseMatch[2]!], ignoredChapters, ignoredSections);
    if (kind === "anomaly") {
      anomalies.push({
        line: index + 1,
        text: stripPageMarker(trimmed).slice(0, 160),
        reason: `untrusted clause id ${clauseId}`,
      });
    }
    clauses.push({
      clause_id: clauseId,
      line: index + 1,
      end_exclusive_line: lines.length + 1,
      text: `${clauseId} ${stripPageMarker(clauseMatch[2]!)}`,
      kind,
      ...(currentColumn ? { column: currentColumn } : {}),
      has_quantity: QUANTITY_RE.test(trimmed),
      has_method: METHOD_RE.test(trimmed),
    });
  }

  for (let index = 0; index < clauses.length; index += 1) {
    const next = clauses[index + 1];
    const nextHeading = headings.find((heading) => heading.line > clauses[index]!.line);
    const nextColumnHeading = columnHeadingLines.find((line) => line > clauses[index]!.line);
    const boundary = Math.min(
      next?.line ?? lines.length + 1,
      nextHeading && nextHeading.line < (next?.line ?? lines.length + 1)
        ? nextHeading.line
        : next?.line ?? lines.length + 1,
      nextColumnHeading && nextColumnHeading < (next?.line ?? lines.length + 1)
        ? nextColumnHeading
        : next?.line ?? lines.length + 1,
    );
    clauses[index]!.end_exclusive_line = boundary;
    const body = lines.slice(clauses[index]!.line, boundary - 1);
    body.forEach((bodyLine, offset) => {
      const lineNo = clauses[index]!.line + 1 + offset;
      if (tableLines.has(lineNo)) return;
      const column = detectColumn(bodyLine);
      if (column) clauses[index]!.column = column;
      if (QUANTITY_RE.test(bodyLine)) {
        clauses[index]!.has_quantity = true;
        clauses[index]!.quantity_line = lineNo;
      }
      if (METHOD_RE.test(bodyLine)) {
        clauses[index]!.has_method = true;
        clauses[index]!.method_line = lineNo;
      }
    });
    // Role labels introduce prose blocks, including enumerated and wrapped
    // lines. A different label, table or clause boundary closes that block.
    const roleRanges: NonNullable<LedgerClause["field_role_ranges"]> = [];
    let activeRanges: typeof roleRanges = [];
    body.forEach((bodyLine, offset) => {
      const lineNo = clauses[index]!.line + 1 + offset;
      const tableBoundary = tableLines.has(lineNo) || TABLE_CAPTION_LINE_RE.test(bodyLine.trim());
      const roles = tableBoundary ? [] : [
        ...(METHOD_RE.test(bodyLine) ? ["method" as const] : []),
        ...(QUANTITY_RE.test(bodyLine) ? ["quantity" as const] : []),
      ];
      if (tableBoundary || roles.length > 0) {
        activeRanges.forEach(range => { range.end_exclusive_line = lineNo; });
        activeRanges = [];
      }
      for (const role of roles) {
        const range = { role, start_line: lineNo, end_exclusive_line: boundary };
        roleRanges.push(range);
        activeRanges.push(range);
      }
    });
    clauses[index]!.field_role_ranges = roleRanges;
    const clauseBody = [clauses[index]!.text, ...body].join(" ");
    const sampling = classifySamplingOccurrence(
      clauses[index]!.clause_id,
      clauseBody,
      clauses[index]!.line,
      "target",
    );
    if (sampling) clauses[index]!.sampling_kind = sampling.kind;
    if (CLAUSE_TABLE_REFERENCE_RE.test(clauseBody)) clauses[index]!.references_table = true;
    if (clauses[index]!.kind === "item_candidate") {
      const delegatesTo = wholeScopeDelegationTarget(
        clauses[index]!.clause_id,
        clauseBody,
      );
      if (delegatesTo) {
        clauses[index]!.kind = "non_item";
        clauses[index]!.delegates_to_section = delegatesTo;
      }
    }
    if (QUANTITY_RE.test(clauseBody)) clauses[index]!.has_quantity = true;
    if (METHOD_RE.test(clauseBody)) clauses[index]!.has_method = true;
  }

  const windows: LedgerTargetWindow[] = [];
  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index]!;
    if (heading.role !== "ignored") continue;
    // 条文常常也被 OCR 成同级标题（`## A.0.1 …`），拿它当边界会把附录窗口截成两行，
    // 后面整段附录就落进 irrelevant。归属于本标题的子编号一律不作为终点。
    const nextSameOrHigher = headings.find((candidate, candidateIndex) =>
      candidateIndex > index
      && candidate.level <= heading.level
      && !(heading.number && candidate.number.startsWith(`${heading.number}.`))
    );
    windows.push({
      window_id: `ignored:${heading.number || "x"}:${heading.line}`,
      heading_line: heading.line,
      start_line: heading.line,
      end_exclusive_line: nextSameOrHigher?.line ?? lines.length + 1,
      number: heading.number,
      title: heading.title,
      heading_text: heading.text,
      extractable_clause_ids: [],
      ignored: true,
    });
  }

  const indexedClauses = indexedClausesFromTables(
    lines,
    new Set(clauses.map((clause) => clause.clause_id)),
  );
  // 索引表印着的主控/一般回填到条文上——GB 50339 这类书正文里没有栏目标题，
  // 这是唯一能拿到该信息的地方。条文自己已判出栏目时不覆盖。
  const indexedByClauseId = new Map(indexedClauses.map((entry) => [entry.clause_id, entry]));
  for (const clause of clauses) {
    const indexed = indexedByClauseId.get(clause.clause_id);
    if (indexed?.column && !clause.column) clause.column = indexed.column;
  }
  const indexedClauseIds = new Set(indexedClauses.map((entry) => entry.clause_id));
  const extractable = clauses.filter(requiredClausePredicateFor(clauses, indexedClauseIds));
  const sectionClauses = new Map<string, LedgerClause[]>();
  for (const clause of extractable) {
    const key = sectionKeyFromClauseId(clause.clause_id);
    if (!key) continue;
    const list = sectionClauses.get(key) ?? [];
    list.push(clause);
    sectionClauses.set(key, list);
  }
  for (const [number, grouped] of sectionClauses) {
    const firstClauseLine = Math.min(...clauses.filter((clause) => sectionKeyFromClauseId(clause.clause_id) === number).map((clause) => clause.line));
    // Bind a heading to the same physical occurrence as its clauses. A later
    // repeated heading cannot supply the start of an earlier source range.
    const preceding = headings.filter((entry) => entry.number === number && entry.line <= firstClauseLine).at(-1);
    const heading = preceding && !headings.some((entry) => entry.line > preceding.line
      && entry.line <= firstClauseLine && entry.number && entry.number !== number
      && entry.number.split(".").length <= number.split(".").length) ? preceding : undefined;
    if (heading?.role === "ignored") continue;
    if (heading && isNonItemTitle(heading.title)) continue;
    // 该编号的标题存在但已判为 ignored（总则/竣工验收/附录）时，不能因为「找不到非 ignored 标题」
    // 就退到用条文正文伪造一个窗口——那正是 15.0.x / H.0.x 混进必抽集的路径。
    if (!heading && preceding?.role === "ignored") continue;
    if (!heading && grouped.every((clause) => isNonItemTitle(clause.text))) continue;
    const startLine = heading?.line ?? firstClauseLine;
    const endExclusiveLine = Math.max(...grouped.map((clause) => clause.end_exclusive_line));
    windows.push({
      window_id: `window:${number}`,
      heading_line: startLine,
      start_line: startLine,
      end_exclusive_line: endExclusiveLine,
      number,
      title: heading?.title || sectionTitleFromClauseText(grouped[0]!.text) || number,
      heading_text: heading?.text || grouped[0]!.text,
      extractable_clause_ids: grouped.map((clause) => clause.clause_id),
      ignored: false,
    });
  }

  const record_tables: LedgerRecordTable[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!/<table\b/i.test(lines[index]!)) continue;
    const lookback = lines.slice(Math.max(0, index - 8), index).map((line) => stripPageMarker(line.trim())).filter(Boolean);
    const caption = [...lookback].reverse().find((line) => TABLE_NO_RE.test(line) || RECORD_TABLE_RE.test(line)) ?? "";
    const nearby = lookback.join(" ");
    if (!RECORD_TABLE_RE.test(nearby) && !RECORD_TABLE_RE.test(caption)) continue;
    const tableNo = TABLE_NO_RE.exec(caption)?.[0]?.replace(/\s+/g, "") ?? `table:${index + 1}`;
    const title = lookback.filter((line) => line !== caption && !/^#/.test(line)).at(-1)
      ?? caption.replace(TABLE_NO_RE, "").trim()
      ?? "检验批质量验收记录";
    record_tables.push({
      table_id: `record:${normalizeId(tableNo)}:${index + 1}`,
      caption_line: index + 1 - (lookback.length - lookback.lastIndexOf(caption)),
      table_no: tableNo,
      title: title || "检验批质量验收记录",
      nearby_text: nearby.slice(0, 240),
    });
  }

  const tables = scanLedgerTableCaptions(markdown);

  return {
    schema_version: DOCUMENT_LEDGER_SCHEMA_VERSION,
    source_sha256: sha256Text(markdown),
    file_name: fileName,
    clauses,
    headings,
    windows,
    record_tables,
    tables,
    anomalies,
    indexed_clauses: indexedClauses,
  };
}

/** Exact caption inventory, including independently numbered continuation pages. */
export function scanLedgerTableCaptions(markdown: string): LedgerTableCaption[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const tables: LedgerTableCaption[] = [];
  const seenTables = new Set<string>();
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = stripPageMarker(lines[index]!.trim());
    const caption = TABLE_CAPTION_LINE_RE.exec(trimmed);
    if (!caption) continue;
    const tableNo = normalizeId(caption[1]!);
    if (seenTables.has(tableNo)) continue;
    seenTables.add(tableNo);
    tables.push({
      table_no: tableNo,
      line: index + 1,
      title: trimmed.slice(caption[0].length).trim() || tableNo,
    });
  }

  return tables;
}

/** Recompute derived captions without modifying frozen ownership or old artifacts. */
export function ledgerWithCurrentTableCaptions(ledger: DocumentLedger, markdown: string): DocumentLedger {
  if (sha256Text(markdown) !== ledger.source_sha256) {
    throw new Error("ledger_table_caption_source_mismatch: frozen Markdown does not match the document ledger");
  }
  return ledger.tables === undefined ? ledger : { ...ledger, tables: scanLedgerTableCaptions(markdown) };
}

/** Reparse missed joined clause boundaries in memory from the same frozen source. */
export function ledgerWithCurrentClauseBoundaries(ledger: DocumentLedger, markdown: string): DocumentLedger {
  const hasMissedBoundary = markdown.replace(/\r\n?/gu, "\n").split("\n").some((line, index) => {
    const clauseId = joinedFormalClauseId(line);
    return clauseId && !ledger.clauses.some((clause) => clause.line === index + 1 && clause.clause_id === clauseId);
  });
  if (!hasMissedBoundary) return ledger;
  if (sha256Text(markdown) !== ledger.source_sha256) {
    throw new Error("ledger_clause_boundary_source_mismatch: frozen Markdown does not match the document ledger");
  }
  return scanDocumentLedger(markdown, ledger.file_name);
}

/** Exact numbering joined directly to Han prose, without guessing Latin tokens. */
export function joinedFormalClauseId(line: string): string {
  const text = line.trim().replace(/^#{1,6}\s*/u, "");
  const match = CLAUSE_ID_RE.exec(text);
  const clauseId = normalizeId(match?.[1] ?? "");
  return match && text.startsWith(match[1]! + match[2]!) && !isAnomalousClauseId(clauseId) ? clauseId : "";
}

/**
 * 找出包含该行的最窄抽取窗口。target 的行范围只覆盖标题那一行，
 * 直接拿去做覆盖对账会空转，必须先还原成底账窗口的完整行范围。
 */
export function ledgerWindowForLine(
  ledger: DocumentLedger,
  line: number,
): LedgerTargetWindow | undefined {
  return ledger.windows
    .filter((window) =>
      !window.ignored
      && window.extractable_clause_ids.length > 0
      && line >= window.start_line
      && line < window.end_exclusive_line
    )
    .sort((left, right) =>
      (left.end_exclusive_line - left.start_line) - (right.end_exclusive_line - right.start_line)
    )[0];
}

export interface LedgerWindowTargetRef {
  name?: string;
  ledger_window_id?: string;
  evidence_fragments?: Array<{ atom_id: string; text: string }>;
  materialization?: { lot_basis_fragments?: Array<{ atom_id: string; text: string }> };
  /** 目标自身的行范围。整节转指的目标要靠它找到那句转指条文。 */
  start_line?: number;
  end_exclusive_line?: number;
}

/**
 * 目标所在的那一节整节只有一句「应符合本规范第 X 节的规定」时，把窗口解析到被指向的节。
 *
 * GB 50310 液压电梯第 5 章有 7 节是这个形态（5.2/5.4/5.5/5.6/5.7/5.8/5.10），
 * 它们本身是真实的检验批，验收项目却全落在第 4 章对应节里。此前没有任何一层去读
 * 这句话，只能指望模型自己跑去引对那一节、锚点恰好落进去——同构的七节里有的成有的败，
 * 是运气不是机制；`土建交接检验` 这个名字还在 4.2/5.2/6.2 三处重名，名称兜底也撞不唯一，
 * 于是它连续四轮 window=None，闸门无处可查、修复循环空转到耗尽预算。
 *
 * 节号是条文自己写明的，读它属于「看文档」，不是引入外部内容。
 *
 * 判据取「目标落在底账的哪一节」，不取「目标 scope 里有哪些条文」：scope 是模型选了
 * 哪几个原子的结果，实测同为转指的七节里有两节模型只选了标题那一行，按 scope 判就漏。
 * 底账的分节是确定性的，用它才不受模型取舍影响。
 */
function delegatedWindow(
  ledger: DocumentLedger,
  target: LedgerWindowTargetRef,
): LedgerTargetWindow | undefined {
  const startLine = target.start_line;
  if (startLine === undefined) return undefined;
  const heading = ledger.headings
    .filter((entry) => /^\d+(?:\.\d+)+$/.test(entry.number) && entry.line <= startLine)
    .sort((left, right) => left.line - right.line)
    .at(-1);
  if (!heading) return undefined;
  const sectionClauses = ledger.clauses.filter((clause) =>
    clause.clause_id.startsWith(`${heading.number}.`)
  );
  if (!sectionClauses.length) return undefined;
  // 这一节除转指外还有别的条文，说明它有自己的验收内容，不能整体改指别处——
  // 那会把它自己的条文从必抽集里抹掉。
  const delegations = sectionClauses.filter((clause) => clause.delegates_to_section);
  if (delegations.length !== sectionClauses.length) return undefined;
  const sections = new Set(delegations.map((clause) => clause.delegates_to_section!));
  if (sections.size !== 1) return undefined;
  const section = [...sections][0]!;
  return ledger.windows.find((window) =>
    !window.ignored
    && window.window_id === `window:${section}`
    && window.extractable_clause_ids.length > 0
  );
}

/**
 * 给检验批找底账「节」窗口。国标通用：优先 window_id，再用节标题引文锚点行，
 * 标题只在唯一命中时兜底。绝不把「大原子/整章行号范围」当成一节——那会造假缺口。
 */
/**
 * 引文落在原文的第几行。目标的 evidence_fragments 是从 6000 字原子里逐字截出来的，
 * 在原子内定位再加上原子起始行即得原文行号。
 */
function fragmentAnchorLines(
  fragments: ReadonlyArray<{ atom_id: string; text: string }>,
  atoms: readonly LedgerAtomRef[],
): number[] {
  const atomById = new Map(atoms.map((atom) => [atom.atom_id, atom]));
  return fragments.flatMap((fragment) => {
    const atom = atomById.get(fragment.atom_id);
    if (!atom || fragment.text.length >= atom.text.length) return [];
    const offset = atom.text.indexOf(fragment.text);
    if (offset < 0) return [];
    return [atom.start_line + (atom.text.slice(0, offset).match(/\n/g)?.length ?? 0)];
  });
}

/**
 * 把同一取证窗口按各目标的引文锚点切开，一人一段。
 *
 * 要解决的实测问题：GB/T 50312 第 8 章是平铺章（只有 8.0.x，没有 8.1/8.2），整章
 * 落在一两个 6000 字原子里，于是主范围取原子行范围时，三个不同的检验批拿到
 * **一模一样**的窗口 612–659：
 *   对绞电缆永久链路、CP 链路及信道测试   引文指向 8.0.3
 *   光纤布线系统性能测试                 引文指向 8.0.4
 *   光纤到用户单元光纤链路测试            引文指向 8.0.5
 * 每个目标的主证据里都装着另外两个目标的条文，覆盖复核挨个判成 foreign clause，
 * 作者答「不归我」——三方互相指责谁也过不去。实测一个目标为此跑到尝试 13、
 * 69 次工具调用、26 分钟仍未收敛，反复出现的正是 finding-foreign-clause-8-0-5
 * 与 finding-foreign-clause-8-0-7。
 *
 * 为什么是切分而不是「各取自己引的那条」：后者试过，太狠。目标的引文只举证
 * 一两条，而它实际拥有的是一串条文；实测该书落在所有主范围之外的条文从 17 涨到
 * 35，`5.0.2 各类配线部件的安装应符合下列规定`、`7.0.1 缆线终接应符合下列规定`
 * 这类真内容被挤了出去。切分则既互不重叠、又一条不漏：窗口内每条都归且只归
 * 一个目标——归它上方最近的那个锚点。
 *
 * 判据不是词表也不是猜：底账知道每条条文的行范围，目标的引文明确落在其中一条里。
 * 切开的只是 primary，其余内容仍以 reference 身份留在包里可读可引，只是不再强制
 * 这个目标为别人的条文负责。
 *
 * 返回值与入参一一对应；锚不到的目标给 undefined，由调用方退回原范围。
 */
export function ledgerTargetPrimaryScopes(
  ledger: DocumentLedger,
  targets: readonly LedgerWindowTargetRef[],
  atoms: readonly LedgerAtomRef[] = [],
): Array<{ start_line: number; end_exclusive_line: number } | undefined> {
  const clauseStartAt = (line: number): number | undefined =>
    ledger.clauses.find((clause) => line >= clause.line && line < clause.end_exclusive_line)?.line;
  // 每个目标的代表点：它引到的最靠前的那条条文的起始行。
  const anchors = targets.map((target) => {
    const lines = fragmentAnchorLines([
      ...(target.materialization?.lot_basis_fragments ?? []),
      ...(target.evidence_fragments ?? []),
    ], atoms);
    const starts = lines.flatMap((line) => {
      const start = clauseStartAt(line);
      return start === undefined ? [] : [start];
    });
    return starts.length ? Math.min(...starts) : undefined;
  });
  return targets.map((target, index) => {
    const anchor = anchors[index];
    if (
      anchor === undefined
      || target.start_line === undefined
      || target.end_exclusive_line === undefined
    ) return undefined;
    const base = { start: target.start_line, end: target.end_exclusive_line };
    // 只跟共用同一窗口的同伴切分；窗口不同的目标互不影响。
    const siblings = anchors.filter((siblingAnchor, siblingIndex) =>
      siblingIndex !== index
      && siblingAnchor !== undefined
      && targets[siblingIndex]!.start_line === base.start
      && targets[siblingIndex]!.end_exclusive_line === base.end
    ) as number[];
    // 上方没有同伴就一直吃到窗口开头，下方没有同伴就一直吃到窗口结尾——
    // 章首的总则与章末的记录条款因此仍有主人，不会变成无人认领。
    const above = siblings.filter((siblingAnchor) => siblingAnchor < anchor);
    const below = siblings.filter((siblingAnchor) => siblingAnchor > anchor);
    const start = above.length ? anchor : base.start;
    const end = below.length ? Math.min(...below) : base.end;
    return start < end ? { start_line: start, end_exclusive_line: end } : undefined;
  });
}

export function resolveLedgerWindowForTarget(
  ledger: DocumentLedger,
  target: LedgerWindowTargetRef,
  atoms: readonly LedgerAtomRef[] = [],
): LedgerTargetWindow | undefined {
  if (target.ledger_window_id) {
    const byId = ledger.windows.find((window) =>
      !window.ignored
      && window.window_id === target.ledger_window_id
      && window.extractable_clause_ids.length > 0
    );
    if (byId) return byId;
  }

  // 整节转指优先于下面各层锚点推断：条文自己写明了节号，那是文档给出的事实，
  // 而锚点是从模型引了哪段话反推出来的。
  const byDelegation = delegatedWindow(ledger, target);
  if (byDelegation) return byDelegation;

  const anchorLinesOf = (
    fragments: ReadonlyArray<{ atom_id: string; text: string }>,
  ): number[] => fragmentAnchorLines(fragments, atoms);
  const windowAt = (anchorLines: readonly number[]): LedgerTargetWindow | undefined =>
    ledger.windows
      .filter((window) =>
        !window.ignored
        && window.extractable_clause_ids.length > 0
        && anchorLines.some((line) => line >= window.start_line && line < window.end_exclusive_line)
      )
      .sort((left, right) =>
        (left.end_exclusive_line - left.start_line) - (right.end_exclusive_line - right.start_line)
      )[0];

  // 分层锚定，不做二选一：lot_basis 常引「11.1.2 …划分检验批」这种落在一般规定（ignored 窗口）
  // 里的句子，锚不到任何抽取窗口；此时 evidence_fragments 里的节标题引文才是真锚点。
  // 旧写法「lot_basis 非空就只看 lot_basis」会把这个锚点整个丢掉，退化成靠名字撞窗口，
  // 而「支承面」这类节名在多章重复，撞不唯一即解析失败。
  const lotBasisFragments = target.materialization?.lot_basis_fragments ?? [];
  const evidenceFragments = target.evidence_fragments ?? [];
  const byLotBasis = windowAt(anchorLinesOf(lotBasisFragments));
  if (byLotBasis) return byLotBasis;
  const byEvidence = windowAt(anchorLinesOf(evidenceFragments));
  if (byEvidence) return byEvidence;
  const candidates = [...lotBasisFragments, ...evidenceFragments];

  // 没有原子时，用 lot_basis / 名称文本直接撞窗口标题（仍要求唯一）。
  const quoteNeedles = [
    ...candidates.map((fragment) => fragment.text.trim()).filter((text) => text.length >= 2),
    ...(target.name ? [target.name.trim()] : []),
  ];
  for (const needle of quoteNeedles) {
    const hits = ledger.windows.filter((window) =>
      !window.ignored
      && window.extractable_clause_ids.length > 0
      && (
        window.title === needle
        || window.heading_text === needle
        || window.window_id === needle
        || window.heading_text.includes(needle)
        || needle.includes(window.title)
      )
    );
    if (hits.length === 1) return hits[0];
  }

  const byName = ledger.windows.filter((window) =>
    !window.ignored
    && window.extractable_clause_ids.length > 0
    && target.name
    && (
      window.title === target.name
      || window.heading_text === target.name
      || window.window_id === target.name
    )
  );
  return byName.length === 1 ? byName[0] : undefined;
}

/**
 * 一行落在哪一节（按章号/节号标题切）。解析不到底账窗口时的范围兜底。
 *
 * 窗口只建给「有必抽条文的节」，所以词样认不出的文档一个窗口都没有，
 * 每个检验批都解析不到窗口，范围退回成「模型举证时引用的那几行」——
 * 而那几段引文本来是用来**证明这个批存在**的，不是用来圈范围的。
 * GB/T 50312 实测：`器材及测试仪表工具检查` 只引了 `4.0.1 器材检验应符合下列规定：`
 * 一句，范围就成了 4 行，4.0.2~4.0.8 全落在范围外；全书 45 条候选里 34 条无人认领。
 *
 * 节的边界与必抽集无关，只要有编号标题就在。所以这里退到「引文所在的那一节」，
 * 上例即 246-323 行、含 4.0.1~4.0.8 八条。实测无人认领 34 → 3，
 * 剩下的 3 条是第 10 章的竣工资料与验收判定规则，本就不是验收项目。
 *
 * 只认章号与节号（`4`、`4.1`），不认条文号——本书的条文本身也是 markdown 标题
 * （`# 4.0.1 …`），把它们当边界会把每条切成一节，等于没兜底。
 */
export function ledgerSectionRangeForLine(
  ledger: DocumentLedger,
  line: number,
): { start_line: number; end_exclusive_line: number } | undefined {
  const boundaries = ledger.headings
    .filter((heading) => /^(?:\d+|[A-Z])(?:\.\d+)?$/i.test(heading.number))
    .sort((left, right) => left.line - right.line);
  const index = boundaries.findLastIndex((heading) => heading.line <= line);
  if (index < 0) return undefined;
  const documentEnd = Math.max(
    ...ledger.clauses.map((clause) => clause.end_exclusive_line),
    line + 1,
  );
  const current = boundaries[index]!;
  const currentSegments = current.number.split(".");
  const next = boundaries.slice(index + 1).find(heading => {
    if (heading.number.startsWith(`${current.number}.`)) return false;
    const segments = heading.number.split(".");
    const deeperListMarker = currentSegments.length > 1 && segments.length === 1 && heading.level > current.level;
    return !deeperListMarker;
  });
  const unknownBoundary = ledger.headings.find(heading => !heading.number && heading.line > current.line
    && heading.level <= current.level && heading.role === "ignored");
  const end = Math.min(next?.line ?? documentEnd, unknownBoundary?.line ?? documentEnd);
  if (line >= end) return undefined;
  return {
    start_line: current.line,
    end_exclusive_line: end,
  };
}

export function evaluateDiscoveryLedgerAgreement(
  plan: {
    targets: Array<{
      target_id: string;
      name?: string;
      work_scope?: import("./confirmed-target-scope.js").ConfirmedWorkScope;
      evidence_atom_ids: string[];
      evidence_fragments?: Array<{ atom_id: string; text: string }>;
      materialization?: { lot_basis_fragments?: Array<{ atom_id: string; text: string }> };
    }>;
  },
  ledger: DocumentLedger,
  atoms: readonly LedgerAtomRef[],
  reviewedContextClauseIds: readonly string[] = [],
): DiscoveryLedgerAgreement {
  // Only the caller's independently reviewed, source-bound context decisions may
  // discharge a candidate signal. Plain context overlap is not an exclusion.
  const contexts = new Set(reviewedContextClauseIds);
  const required = extractableClauseIds(ledger).filter(id => !contexts.has(id));
  const delegated = ledger.clauses
    .filter((clause) => clause.delegates_to_section && !contexts.has(clause.clause_id))
    .map((clause) => clause.clause_id);
  const coveredBy = new Map<string, string[]>();
  const directlyCoveredDelegations = new Set<string>();
  const atomById = new Map(atoms.map((atom) => [atom.atom_id, atom]));
  // Modern discovery atoms reconstruct the immutable source exactly. Use exact
  // character ranges there: line rounding misses truncated last lines and treats
  // a trailing empty line as missing evidence. Keep legacy sparse-atom fallback.
  const source = atoms.map(atom => atom.text).join("");
  const exactSource = sha256Text(source) === ledger.source_sha256;
  const lineOffsets = [0];
  for (const match of source.matchAll(/\n/g)) lineOffsets.push(match.index! + 1);
  let offset = 0;
  const atomOffsets = new Map(atoms.map(atom => {
    const start = offset; offset += atom.text.length;
    return [atom.atom_id, start] as const;
  }));
  const exactPrimary = (target: (typeof plan.targets)[number]) => (target.work_scope?.primary_fragments ?? []).flatMap(fragment => {
    const atom = atomById.get(fragment.atom_id);
    const start = atomOffsets.get(fragment.atom_id);
    return atom && start !== undefined && atom.text.slice(fragment.start, fragment.end) === fragment.text
      ? [{ evidence_id: "document", start: start + fragment.start, end: start + fragment.end }] : [];
  });
  const clauseRange = (clause: LedgerClause) => {
    const start = lineOffsets[clause.line - 1] ?? source.length;
    const end = lineOffsets[clause.end_exclusive_line - 1] ?? source.length;
    return { evidence_id: "document", start, end: start + source.slice(start, end).trimEnd().length };
  };
  const clauseCoveredBy = (clause: LedgerClause, primary: ReturnType<typeof exactPrimary>) => {
    const range = clauseRange(clause);
    return documentContentRanges(source, range.start, range.end)
      .every(content => sourceSpanCoveredBy({ evidence_id: "document", ...content }, primary));
  };
  const directRanges = (target: (typeof plan.targets)[number]): Array<readonly [number, number]> => {
    if (target.work_scope?.primary_fragments) {
      return target.work_scope.primary_fragments.flatMap(fragment => {
        const atom = atomById.get(fragment.atom_id);
        if (!atom || atom.text.slice(fragment.start, fragment.end) !== fragment.text) return [];
        const start = atom.start_line + (atom.text.slice(0, fragment.start).match(/\n/g)?.length ?? 0);
        return [[start, start + (fragment.text.match(/\n/g)?.length ?? 0) + (fragment.text.endsWith("\n") ? 0 : 1)] as const];
      });
    }
    if (target.work_scope) {
      return [[target.work_scope.start_line, target.work_scope.end_exclusive_line]];
    }
    return (target.evidence_fragments ?? []).flatMap((fragment) => {
      const atom = atomById.get(fragment.atom_id);
      if (!atom) return [];
      const offset = atom.text.indexOf(fragment.text);
      if (offset < 0) return [];
      const startLine = atom.start_line + (atom.text.slice(0, offset).match(/\n/g)?.length ?? 0);
      const endExclusive = startLine + (fragment.text.match(/\n/g)?.length ?? 0) + 1;
      return [[startLine, endExclusive] as const];
    });
  };
  const fullyCoversLineRange = (
    ranges: readonly (readonly [number, number])[],
    startLine: number,
    endExclusiveLine: number,
  ): boolean => {
    let cursor = startLine;
    for (const [start, end] of [...ranges].sort((left, right) => left[0] - right[0])) {
      if (end <= cursor) continue;
      if (start > cursor) return false;
      cursor = Math.max(cursor, end);
      if (cursor >= endExclusiveLine) return true;
    }
    return false;
  };
  for (const target of plan.targets) {
    const sourceRanges = directRanges(target);
    const sourceDelegations = ledger.clauses.filter((clause) =>
      Boolean(clause.delegates_to_section)
      && (exactSource && target.work_scope?.primary_fragments
        ? clauseCoveredBy(clause, exactPrimary(target))
        : sourceRanges.some(([start, end]) => clause.line >= start && clause.line < end))
    );
    sourceDelegations.forEach((clause) => directlyCoveredDelegations.add(clause.clause_id));
    const sourceRequired = required.filter((clauseId) => {
      const clause = ledger.clauses.find((entry) => entry.clause_id === clauseId);
      // A selector that merely reaches the clause's opening line has not made the
      // clause available to the target Agent. Require the complete physical clause
      // range, while still allowing adjacent primary fragments to cover it jointly.
      return clause && (exactSource && target.work_scope?.primary_fragments
        ? clauseCoveredBy(clause, exactPrimary(target))
        : fullyCoversLineRange(sourceRanges, clause.line, clause.end_exclusive_line));
    });
    const pureDelegationTarget = sourceDelegations.length > 0 && sourceRequired.length === 0;
    if (target.work_scope?.primary_fragments) {
      for (const clauseId of sourceRequired) {
        const owners = coveredBy.get(clauseId) ?? [];
        if (!owners.includes(target.target_id)) owners.push(target.target_id);
        coveredBy.set(clauseId, owners);
      }
      continue;
    }
    const window = resolveLedgerWindowForTarget(ledger, target, atoms);
    const windows = window && !pureDelegationTarget ? [window] : [];
    const clauseIds = pureDelegationTarget
      ? []
      : windows.length
      ? windows.flatMap((entry) => entry.extractable_clause_ids)
      : ledger.clauses
          .filter((clause) => {
            const targetAtoms = atoms.filter((atom) => target.evidence_atom_ids.includes(atom.atom_id));
            return targetAtoms.some((atom) =>
              atom.start_line < clause.end_exclusive_line && atom.end_line >= clause.line
            );
          })
          .map((clause) => clause.clause_id);
    for (const clauseId of clauseIds) {
      if (!required.includes(clauseId)) continue;
      const owners = coveredBy.get(clauseId) ?? [];
      if (!owners.includes(target.target_id)) owners.push(target.target_id);
      coveredBy.set(clauseId, owners);
    }
  }
  // Physical clauses are navigation candidates, not indivisible semantic units:
  // OCR may attach the next heading to the previous clause. Account for exact
  // source across all owners, just like discoveryObligations. The independent
  // reviewer judges the split; real gaps and duplicated source remain blocking.
  const exactOwnership = exactSource && plan.targets.every(target => target.work_scope?.primary_fragments);
  const ownedPrimary = plan.targets.flatMap(target => exactPrimary(target).map(range => ({ ...range, target_id: target.target_id })));
  const overlaps = exactOwnership ? ownedPrimary.flatMap((left, index) => ownedPrimary.slice(index + 1).flatMap(right => {
    const start = Math.max(left.start, right.start);
    const end = Math.min(left.end, right.end);
    return left.target_id !== right.target_id && start < end ? [{ start, end }] : [];
  })) : [];
  const fullyCovered = (clauseId: string) => {
    const clause = ledger.clauses.find(entry => entry.clause_id === clauseId);
    return clause && clauseCoveredBy(clause, ownedPrimary);
  };
  const uncovered_clause_ids = exactOwnership
    ? [...new Set([...required, ...delegated])].filter(clauseId => !fullyCovered(clauseId))
    : [...required.filter(clauseId => !coveredBy.has(clauseId)),
      ...delegated.filter(clauseId => !directlyCoveredDelegations.has(clauseId))];
  const overlapping_clause_ids = required.filter(clauseId => {
    if (!exactOwnership) return (coveredBy.get(clauseId)?.length ?? 0) > 1;
    const range = clauseRange(ledger.clauses.find(entry => entry.clause_id === clauseId)!);
    return overlaps.some(overlap => Math.max(range.start, overlap.start) < Math.min(range.end, overlap.end));
  });
  const conflictClauseIds = new Set([...uncovered_clause_ids, ...overlapping_clause_ids]);
  const conflict_atom_ids = [...new Set(
    [...conflictClauseIds].flatMap((clauseId) => {
      const clause = ledger.clauses.find((entry) => entry.clause_id === clauseId);
      if (!clause) return [];
      return atomsOverlappingLines(atoms, clause.line, clause.end_exclusive_line).map((atom) => atom.atom_id);
    }),
  )];
  const blockingAnomalies = ledger.anomalies.filter((anomaly) =>
    required.some((clauseId) => anomaly.text.includes(clauseId))
    || ledger.clauses.some((clause) =>
      !contexts.has(clause.clause_id) && ledgerRequiredClausePredicate(ledger)(clause) && clause.line === anomaly.line
    )
  );
  for (const anomaly of blockingAnomalies) {
    conflict_atom_ids.push(
      ...atomsOverlappingLines(atoms, anomaly.line, anomaly.line + 1).map((atom) => atom.atom_id),
    );
  }
  // 候选口径的诊断：按编号数出来的全部像验收条文的条文里，有多少一个 target 都没认领。
  //
  // 上面的 uncovered_clause_ids 建立在 required（靠 8 个固定词样识别的必抽集）之上，
  // 词样认不出的文档必抽集是空的，于是未覆盖恒为空、skip_reviewer 恒为真，
  // 识别阶段的复核被整个跳过。GB/T 50312 实测：45 条候选里 30 条不落在任何 target
  // 的行范围内，而 uncovered_clause_ids 是空的、复核被跳过、这 30 条静默落地。
  //
  // **纯诊断，不参与 skip_reviewer**：先把丢掉的显形，拦不拦是下一步的事。
  // 范围取「模型实际引用的那几段原文」，与 targetEvidenceLineSpan 同口径——
  // 那才是这个 target 的会话真正拿得到的行；整个原子往往宽得多，
  // 拿原子当范围会把没人看过的条文算成已认领。
  const targetRanges = plan.targets.flatMap((target) => {
    if (target.work_scope?.primary_fragments) return directRanges(target);
    const window = resolveLedgerWindowForTarget(ledger, target, atoms);
    if (window) return [[window.start_line, window.end_exclusive_line] as const];
    const fragments = target.evidence_fragments ?? [];
    return fragments.flatMap((fragment) => {
      const atom = atomById.get(fragment.atom_id);
      if (!atom) return [];
      const offset = atom.text.indexOf(fragment.text);
      if (offset < 0) return [];
      const startLine = atom.start_line + (atom.text.slice(0, offset).match(/\n/g)?.length ?? 0);
      const endExclusive = startLine + (fragment.text.match(/\n/g)?.length ?? 0) + 1;
      return [[startLine, endExclusive] as const];
    });
  });
  const unclaimed_candidate_clause_ids = ledger.clauses
    .filter((clause) =>
      clause.kind === "item_candidate"
      && !contexts.has(clause.clause_id)
      && !(exactOwnership
        ? clauseCoveredBy(clause, ownedPrimary)
        : fullyCoversLineRange(targetRanges, clause.line, clause.end_exclusive_line))
    )
    .map((clause) => clause.clause_id);

  const complete = uncovered_clause_ids.length === 0
      && overlapping_clause_ids.length === 0
      && blockingAnomalies.length === 0;
  return {
    complete,
    skip_reviewer: complete && plan.targets.length > 0,
    uncovered_clause_ids,
    overlapping_clause_ids,
    unclaimed_candidate_clause_ids,
    conflict_atom_ids: [...new Set(conflict_atom_ids)],
    anomalies: ledger.anomalies,
  };
}

function normalizeClauseLocator(value: string): string {
  return normalizeId(value.replace(/^第/, "").replace(/条$/, ""));
}

/**
 * 窗口定位不出来时的必抽集来源（整节转指：`5.2 土建交接检验应符合本规范第 4.2 节的规定`）。
 *
 * 不去认「第 4.2 节」这句中文——那只对这一种措辞有效，换个说法、换成英文就失效。
 * 抽取端早就读懂了那句话并把第 4.2 节的项目抽了回来，项目上写着自己出自 4.2.1、4.2.2……
 * 所以这里只做两件事：
 *   「这个批出自哪一节」——信抽取端，它读过原文；
 *   「那一节应有几条」——只信底账。
 * 少交就会对不上账，蒙混不过去；也不是循环论证，因为条数不由抽取端说了算。
 */
export function ledgerSectionsForClauses(
  ledger: DocumentLedger,
  citedClauses: readonly string[],
): { section_keys: string[]; required_clause_ids: string[] } {
  const isRequired = ledgerRequiredClausePredicate(ledger);
  const sections = new Set<string>();
  for (const raw of citedClauses) {
    const clauseId = normalizeClauseLocator(raw ?? "");
    if (!clauseId) continue;
    const key = sectionKeyFromClauseId(clauseId);
    if (key) sections.add(key);
  }
  const required_clause_ids = ledger.clauses
    .filter((clause) => {
      if (!isRequired(clause)) return false;
      const key = sectionKeyFromClauseId(clause.clause_id);
      return key !== undefined && sections.has(key);
    })
    .map((clause) => clause.clause_id);
  return { section_keys: [...sections].sort(), required_clause_ids };
}

/** Confirmed primary ranges can cross ledger windows and can be disjoint.
 * Ownership follows the clause's opening line, never the enclosing envelope. */
export function requiredClauseIdsInSourceRanges(
  ledger: DocumentLedger,
  ranges: readonly { start_line: number; end_exclusive_line: number }[],
): string[] {
  const isRequired = ledgerRequiredClausePredicate(ledger);
  return ledger.clauses.filter(clause => isRequired(clause) && ranges.some(range =>
    clause.line >= range.start_line && clause.line < range.end_exclusive_line
  )).map(clause => clause.clause_id);
}

export function evaluateTargetLedgerCoverage(input: {
  ledger: DocumentLedger;
  start_line: number;
  end_exclusive_line: number;
  source_clauses: string[];
  not_item_clause_ids?: string[];
  evidence?: Array<{ evidence_id: string; text: string }>;
  /** 显式给定必抽集，覆盖按行窗口的推导（转指检验批用 ledgerSectionsForClauses 的结果）。 */
  required_clause_ids?: readonly string[];
}): TargetLedgerCoverage {
  const isRequired = ledgerRequiredClausePredicate(input.ledger);
  const required = input.required_clause_ids
    ? input.ledger.clauses.filter((clause) => input.required_clause_ids!.includes(clause.clause_id))
    : input.ledger.clauses.filter((clause) =>
      isRequired(clause)
      && clause.line >= input.start_line
      && clause.line < input.end_exclusive_line
    );
  const required_clause_ids = required.map((clause) => clause.clause_id);
  const cited = input.source_clauses.map(normalizeClauseLocator);
  const unlabeled_item_count = cited.filter((value) => !value).length;
  const covered = new Set(
    [
      ...cited,
      ...(input.not_item_clause_ids ?? []).map(normalizeClauseLocator),
    ].filter(Boolean),
  );
  // 只承认「逐字命中」或「项目引用的是该条文的子条」；反向的「项目只报节号」
  // 不算覆盖该节下每一条，否则一条节级引用就能假装覆盖整节。
  const covered_clause_ids = required_clause_ids.filter((clauseId) =>
    covered.has(clauseId) || [...covered].some((value) => value.startsWith(`${clauseId}.`))
  );
  const coveredSet = new Set(covered_clause_ids);
  const gap_clause_ids = required_clause_ids.filter((clauseId) => !coveredSet.has(clauseId));
  const gap_evidence_ids = gapEvidenceIdsForClauses(input.evidence ?? [], gap_clause_ids, {
    start_line: input.start_line,
    end_exclusive_line: input.end_exclusive_line,
  });
  const ledgerClauseIds = new Set(input.ledger.clauses.map((clause) => clause.clause_id));
  const extra_clause_ids = [...new Set(
    covered.size ? [...covered].filter((value) => !ledgerClauseIds.has(value)) : [],
  )];
  const vacuous = required_clause_ids.length === 0;
  // 窗口内「长得像验收条文」的全部条文（按编号数出来，与措辞无关），
  // 以及其中既没产出项目、也没被声明为非验收项的那些——当前的静默丢弃。
  // **纯诊断，不参与 complete**：必抽集靠词样识别，词样认不出的条文连问都不会被问到，
  // GB/T 50312 实测 45 条候选只覆盖 9 条、必抽集是空集，全文对账却报 ok。
  // 先把丢掉的显形，拦不拦是下一步的事。
  const candidate_clause_ids = input.ledger.clauses
    .filter((clause) =>
      clause.kind === "item_candidate"
      && clause.line >= input.start_line
      && clause.line < input.end_exclusive_line
    )
    .map((clause) => clause.clause_id);
  const unaccounted_candidate_clause_ids = candidate_clause_ids.filter((clauseId) =>
    !covered.has(clauseId)
    && ![...covered].some((value) => value.startsWith(`${clauseId}.`))
  );
  return {
    complete: !vacuous
      && gap_clause_ids.length === 0
      && unlabeled_item_count === 0
      && extra_clause_ids.length === 0,
    required_clause_ids,
    candidate_clause_ids,
    unaccounted_candidate_clause_ids,
    covered_clause_ids,
    gap_clause_ids,
    gap_evidence_ids,
    unlabeled_item_count,
    extra_clause_ids,
    vacuous,
  };
}

/** 缺口证据：条文号字段 / 正文含号 / 行号落在缺口条文附近，三者任一即可。 */
export function gapEvidenceIdsForClauses(
  evidence: ReadonlyArray<{ evidence_id: string; text: string; clause_id?: string; locator?: string }>,
  gapClauseIds: readonly string[],
  window?: { start_line: number; end_exclusive_line: number },
): string[] {
  if (!gapClauseIds.length) return [];
  const gaps = new Set(gapClauseIds);
  const lineOf = (locator: string | undefined): number | undefined => {
    const match = locator?.match(/^line:(\d+)$/);
    return match ? Number(match[1]) : undefined;
  };
  return evidence
    .filter((record) => {
      if (record.clause_id && gaps.has(record.clause_id)) return true;
      if (gapClauseIds.some((clauseId) => record.text.includes(clauseId))) return true;
      const line = lineOf(record.locator);
      if (line === undefined || !window) return false;
      if (line < window.start_line || line >= window.end_exclusive_line) return false;
      // 行号在窗口内且正文很短时靠不住；只把「看起来像该缺口条文开头」的行收进来
      return gapClauseIds.some((clauseId) =>
        record.text.startsWith(clauseId) || new RegExp(`(^|[\\s　])${clauseId.replace(/\./g, "\\.")}(?:\\s|$)`).test(record.text)
      );
    })
    .map((record) => record.evidence_id);
}

/**
 * 闸门不过时的覆盖复核范围：只打缺口条文 / 未标号项目 / 幻觉条文，不再默认全文。
 * 有底账时调用方不应再退回 mode=full。
 */
export function coverageScopeFromLedgerGate(input: {
  coverage: TargetLedgerCoverage;
  items: ReadonlyArray<{ item_id: string; source_clause?: string }>;
  window_evidence_ids?: readonly string[];
  forced_item_ids?: readonly string[];
}): {
  mode: "ledger_gap";
  affected_item_ids: string[];
  affected_evidence_ids: string[];
  finding_ids: string[];
  gap_clause_ids: string[];
} {
  const { coverage } = input;
  const gapSet = new Set(coverage.gap_clause_ids);
  const extraSet = new Set(coverage.extra_clause_ids);
  const affected_item_ids = [...new Set(
    [
      ...input.items
        .filter((item) => {
          const clause = (item.source_clause ?? "").trim();
          if (!clause) return true;
          if (gapSet.has(clause) || [...gapSet].some((gap) => clause.startsWith(`${gap}.`) || gap.startsWith(`${clause}.`))) {
            return true;
          }
          return extraSet.has(clause);
        })
        .map((item) => item.item_id),
      ...(input.forced_item_ids ?? []),
    ],
  )].sort();
  const affected_evidence_ids = [...new Set([
    ...coverage.gap_evidence_ids,
    ...(input.window_evidence_ids ?? []),
  ])].sort();
  return {
    mode: "ledger_gap",
    affected_item_ids,
    affected_evidence_ids,
    finding_ids: [],
    gap_clause_ids: [...coverage.gap_clause_ids],
  };
}

function registerQuote(
  registry: SourceSpanRegistry,
  atoms: readonly LedgerAtomRef[],
  quote: string,
): { registry: SourceSpanRegistry; span_id: string } | undefined {
  const needle = quote.trim();
  if (!needle) return undefined;
  for (const atom of atoms) {
    if (!atom.text.includes(needle) && !atom.text.includes(needle.slice(0, Math.min(24, needle.length)))) continue;
    try {
      const located = locateAndRegisterSourceQuote(registry, {
        source_id: atom.atom_id,
        evidence_id: atom.atom_id,
        atom_id: atom.atom_id,
        text: atom.text,
      }, needle.length <= atom.text.length ? needle : needle.slice(0, 40));
      return { registry: located.registry, span_id: located.spans[0]!.span_id };
    } catch (error) {
      if (!(error instanceof SourceSpanRegistryError)) throw error;
    }
  }
  return undefined;
}

function ledgerTargetDisplayName(window: LedgerTargetWindow): string {
  const candidate = window.title || window.heading_text;
  // OCR 偶发整节标题变英文，编译器会拒「中文证据 + 拉丁节名」；退回节号中文名。
  if (/[\u4e00-\u9fff]/.test(candidate)) return candidate;
  return `${window.number} 检验批`;
}

/**
 * Discovery 的定位候选。标题或 OCR 缺失可能产生过宽、重叠的窗口；
 * 这些范围不决定业务边界，Agent 根据原文明确 source_blocks，独立复核判断拆并。
 *
 * `ledger.windows` 只包含确定性规则命中的直接条款；这里补回已被扫描器识别的
 * `target_window` 标题，尤其是“本节应符合第 X 节”的纯引用范围。
 */
export function discoveryScopeWindows(ledger: DocumentLedger): LedgerTargetWindow[] {
  const directByNumber = new Map(
    ledger.windows.filter((window) => !window.ignored).map((window) => [window.number, window]),
  );
  const delegatedSections = new Set(
    ledger.clauses.filter((clause) => clause.delegates_to_section)
      .map((clause) => sectionKeyFromClauseId(clause.clause_id))
      .filter((number): number is string => Boolean(number)),
  );
  const candidates: LedgerTargetWindow[] = [];
  const seen = new Set<string>();
  const headingsByNumber = new Map<string, LedgerHeading[]>();
  for (const heading of ledger.headings.filter((entry) =>
    entry.role === "target_window" && (directByNumber.has(entry.number) || delegatedSections.has(entry.number)))) {
    const entries = headingsByNumber.get(heading.number) ?? [];
    entries.push(heading);
    headingsByNumber.set(heading.number, entries);
  }
  for (const [number, entries] of headingsByNumber) {
    const direct = directByNumber.get(number);
    if (direct && !entries.some((entry) => entry.line === direct.heading_line)) {
      candidates.push(direct);
      seen.add(number);
      continue;
    }
    const firstClauseLine = ledger.clauses
      .filter((clause) => sectionKeyFromClauseId(clause.clause_id) === number)
      .sort((left, right) => left.line - right.line)[0]?.line;
    // 目录和正文可能都被 MinerU 提成同名标题。直接窗口已有可信正文行；
    // 纯引用窗口则选紧邻本节条文的标题，不能把目录条目再造一份 target。
    const anchorLine = direct?.heading_line ?? firstClauseLine;
    const heading = anchorLine === undefined
      ? entries.at(-1)!
      : [...entries].filter((entry) => entry.line <= anchorLine).at(-1) ?? entries.at(-1)!;
    const range = ledgerSectionRangeForLine(ledger, heading.line);
    if (!range) continue;
    candidates.push({
      window_id: direct?.window_id ?? `window:${number}`,
      heading_line: heading.line,
      start_line: range.start_line,
      end_exclusive_line: range.end_exclusive_line,
      number: heading.number,
      title: heading.title,
      heading_text: heading.text,
      extractable_clause_ids: direct?.extractable_clause_ids ?? [],
      ignored: false,
    });
    seen.add(number);
  }
  // 平铺章等文档没有二级标题，仍保留原有确定性窗口作为一个最大执行范围。
  for (const window of ledger.windows) {
    if (window.ignored || seen.has(window.number)) continue;
    const hasOwnHeading = ledger.headings.some((heading) => heading.line === window.heading_line && heading.number === window.number);
    const range = (hasOwnHeading ? ledgerSectionRangeForLine(ledger, window.heading_line) : undefined) ?? window;
    candidates.push({ ...window, start_line: range.start_line, end_exclusive_line: range.end_exclusive_line });
  }
  return candidates.sort((left, right) => left.start_line - right.start_line);
}

export function prefillDocumentSelectorsFromLedger(
  jobId: string,
  atoms: readonly LedgerAtomRef[],
  ledger: DocumentLedger,
  registry: SourceSpanRegistry,
): { selectors: DocumentSelectorPlan; registry: SourceSpanRegistry } {
  let nextRegistry = registry;
  const targets: DocumentSelectorPlan["targets"] = [];
  const contexts: DocumentSelectorPlan["contexts"] = [];
  const windowSpanIds = new Map<string, string>();

  for (const window of discoveryScopeWindows(ledger)) {
    const quote = window.heading_text || window.title;
    const registered = registerQuote(nextRegistry, atomsOverlappingLines(atoms, window.start_line, window.end_exclusive_line), quote)
      ?? registerQuote(nextRegistry, atoms, quote);
    if (registered) {
      nextRegistry = registered.registry;
      windowSpanIds.set(window.window_id, registered.span_id);
    }
    const spanIds = windowSpanIds.get(window.window_id) ? [windowSpanIds.get(window.window_id)!] : [];
    if (!spanIds.length) continue;
    const chapter = window.number.split(".")[0] ?? window.number;
    // Atom membership is a navigation relationship, not ownership of the whole
    // 6000-character block. Bind only text actually inside this section.
    const scopeSpanIds: string[] = [];
    const proposedScope = ledgerSectionRangeForLine(ledger, window.heading_line) ?? window;
    for (const atom of atomsOverlappingLines(atoms, proposedScope.start_line, proposedScope.end_exclusive_line)) {
      const range = clipSourceToLineWindow(atom, proposedScope);
      if (!range) continue;
      const registeredScope = registerSourceSpan(nextRegistry, {
        source_id: atom.atom_id, evidence_id: atom.atom_id, atom_id: atom.atom_id, text: atom.text,
      }, range.start, range.end);
      nextRegistry = registeredScope.registry;
      scopeSpanIds.push(registeredScope.span.span_id);
    }
    if (!scopeSpanIds.length) continue;
    targets.push({
      key: window.window_id,
      group_key: chapter ? `chapter:${chapter}` : "document",
      group_name: chapter ? `第${chapter}章` : "正文",
      group_reason: "按底账章节窗口划分抽取工作，不是编辑器层级",
      name: ledgerTargetDisplayName(window),
      lot_basis_summary: `${window.heading_text}；${window.extractable_clause_ids.length ? `含条款 ${window.extractable_clause_ids.slice(0, 8).join("、")}` : "本节验收范围须结合正文或引用条款确认"}`.slice(0, 240),
      scope_span_ids: [...new Set(scopeSpanIds)],
      source_blocks: [{
        kind: "heading_section",
        anchor_span_id: spanIds[0]!,
        start_span_id: scopeSpanIds[0]!,
        end_span_id: scopeSpanIds.at(-1)!,
        reason: "底账只提供候选边界；范围 Agent须结合原文语义确认该标题结构的起止位置",
      }],
      lot_basis_span_ids: spanIds,
      reason: window.extractable_clause_ids.length
        ? "底账窗口覆盖检查数量或主控/一般栏目条款，作为待确认的最大抽取范围"
        : "底账识别到独立验收标题；即使判据由其他章节提供，本节也须单独确认或有证据地降为 context",
    });
  }

  // The ledger proposes positive candidates; pattern absence is not a semantic
  // decision. Even an atom touched by one target may contain unreviewed content.
  // Empty dispositions remain pending and compilation rejects unreviewed atoms.
  const dispositions: DocumentSelectorPlan["dispositions"] = [];

  return {
    registry: nextRegistry,
    selectors: {
      schema_version: DOCUMENT_SELECTOR_PLAN_SCHEMA_VERSION,
      job_id: jobId,
      targets,
      contexts,
      dispositions,
    },
  };
}

export function clauseIdsFromSourceValues(values: readonly string[]): string[] {
  return [...new Set(values.map(normalizeClauseLocator).filter((value) => /^\d+(?:\.\d+){2,}$|^[A-Za-z]\.\d+/.test(value)))];
}
