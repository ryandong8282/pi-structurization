/**
 * 目标切分的第二个判据：扇入。
 *
 * 现在 stableHeadingWorkScopePlan 只按标题树切——有 `N.M` 小节按小节，没有就整章一个目标。
 * 判据里没有任何东西看得见「这一刀会拉进多少被引材料」。GB/T 50312 第 8 章因此成了一个
 * 47 行的目标，却带着 638 条证据：它自己的正文只有 100 条出头，其余 538 条全是附录 A/B/C
 * 被 8.0.3 和 8.0.7 引进来的。该目标在 256 KiB 的阶段预算下确定性失败。
 *
 * 这里只做估算，不改切分。估算永远不进 plan，也不构成已解析引用——
 * 引用发现仍然完全由模型在运行时负责（见 REFERENCE_ACTION_GUIDANCE_ZH）。
 * 正因为它只用来给切分定尺寸、不决定正确性，用确定性字面量扫描才是恰当的：
 * 估偏一点只会让某一章多切或少切一刀，不会让任何条文被漏掉或错挂。
 */

/** 估算只依赖底账的这三张表，保持纯函数、可单测。 */
export interface FanInLedgerView {
  headings: ReadonlyArray<{ line: number; level: number; number: string; role: string }>;
  clauses: ReadonlyArray<{ clause_id: string; line: number; end_exclusive_line: number }>;
  tables: ReadonlyArray<{ table_no: string; line: number }>;
}

export type FanInCitationKind = "appendix" | "clause" | "table";

export interface FanInCitation {
  literal: string;
  line: number;
  kind: FanInCitationKind;
  key: string;
  /** 能不能在底账里定位到；定位不到就只记账不计字节，绝不猜。 */
  resolved: boolean;
  bytes: number;
  start_line: number;
  end_exclusive_line: number;
}

export interface TargetFanInEstimate {
  own_bytes: number;
  /** 按被引目标去重后的扇入——同一附录在本目标内被引多次只算一次，与运行时 target_key 去重一致。 */
  fan_in_bytes: number;
  total_bytes: number;
  citations: FanInCitation[];
  unresolved_literals: string[];
}

/** `本规范附录 B` / `附录B`。 */
const APPENDIX_PATTERN = /(?:本规范)?附录\s*([A-Z])/gu;
/** `本规范第 4.0.6 条` / `第8.0.3条`。 */
const CLAUSE_PATTERN = /(?:本规范)?第\s*(\d+(?:\.\d+)*)\s*条/gu;
/** `表 8.0.7-1` / `表B.0.3-4`。 */
const TABLE_PATTERN = /表\s*([0-9A-Z]+(?:\.\d+)*(?:-\d+)?)/gu;

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function sliceBytes(lines: readonly string[], startLine: number, endExclusiveLine: number): number {
  let total = 0;
  const from = Math.max(1, startLine);
  const to = Math.min(lines.length + 1, endExclusiveLine);
  for (let line = from; line < to; line += 1) {
    total += byteLength(lines[line - 1] ?? "") + 1;
  }
  return total;
}

function isDescendantNumber(candidate: string, parent: string): boolean {
  return candidate.startsWith(`${parent}.`);
}

/**
 * 一个标题管辖的范围：从它自己到下一个「既不是它的后代、编号又非空」的标题。
 *
 * 不能按 level 定界：这份 markdown 把附录内部的条文（`B.0.3 …`）也渲染成 H1，
 * 而底账对这类标题解析不出编号（number 为空）。按 level<=1 找边界会把附录 B 截在
 * 它自己的第一条条文上——实测把 31,380 B 的附录估成 2,726 B，扇入判据直接失效。
 */
function headingRegion(
  ledger: FanInLedgerView,
  heading: FanInLedgerView["headings"][number],
  lineCount: number,
): { start_line: number; end_exclusive_line: number } {
  const next = ledger.headings
    .filter((candidate) =>
      candidate.line > heading.line
      && candidate.number.trim().length > 0
      && !isDescendantNumber(candidate.number, heading.number)
    )
    .sort((left, right) => left.line - right.line)[0];
  return {
    start_line: heading.line,
    end_exclusive_line: next?.line ?? lineCount + 1,
  };
}

/** 表没有结束行，用下一个表或下一个标题兜底。 */
function tableRegion(
  ledger: FanInLedgerView,
  table: FanInLedgerView["tables"][number],
  lineCount: number,
): { start_line: number; end_exclusive_line: number } {
  const nextLine = [
    ...ledger.tables.filter((candidate) => candidate.line > table.line).map((candidate) => candidate.line),
    ...ledger.headings.filter((candidate) => candidate.line > table.line).map((candidate) => candidate.line),
  ].sort((left, right) => left - right)[0];
  return { start_line: table.line, end_exclusive_line: nextLine ?? lineCount + 1 };
}

function firstNormativeHeading(
  ledger: FanInLedgerView,
  number: string,
): FanInLedgerView["headings"][number] | undefined {
  // 条文说明会把正文标题原样重复一遍；取行号最小的那个，别把说明part算进来。
  return ledger.headings
    .filter((heading) => heading.number === number)
    .sort((left, right) => left.line - right.line)[0];
}

function collect(
  pattern: RegExp,
  kind: FanInCitationKind,
  text: string,
  line: number,
  into: Array<{ literal: string; kind: FanInCitationKind; key: string; line: number }>,
): void {
  pattern.lastIndex = 0;
  for (const match of text.matchAll(pattern)) {
    const key = match[1];
    if (!key) continue;
    into.push({ literal: match[0], kind, key, line });
  }
}

/**
 * 估算一个候选切分范围的总成本 = 自身正文 + 去重后的扇入。
 *
 * 只扫这个范围**自己的正文**里的引用字面量，不递归——被引目标里的再引用不计入，
 * 因为运行时也是按 occurrence 逐层解析的，一次切分决策不需要算到底。
 */
export function estimateTargetFanIn(
  lines: readonly string[],
  scope: { start_line: number; end_exclusive_line: number },
  ledger: FanInLedgerView,
): TargetFanInEstimate {
  const lineCount = lines.length;
  const found: Array<{ literal: string; kind: FanInCitationKind; key: string; line: number }> = [];
  const from = Math.max(1, scope.start_line);
  const to = Math.min(lineCount + 1, scope.end_exclusive_line);
  for (let line = from; line < to; line += 1) {
    const text = lines[line - 1] ?? "";
    if (!text) continue;
    collect(APPENDIX_PATTERN, "appendix", text, line, found);
    collect(CLAUSE_PATTERN, "clause", text, line, found);
    collect(TABLE_PATTERN, "table", text, line, found);
  }

  const citations: FanInCitation[] = [];
  const unresolved: string[] = [];
  const countedKeys = new Set<string>();
  let fanInBytes = 0;

  for (const entry of found) {
    let region: { start_line: number; end_exclusive_line: number } | undefined;
    if (entry.kind === "appendix") {
      const heading = firstNormativeHeading(ledger, entry.key);
      if (heading) region = headingRegion(ledger, heading, lineCount);
    } else if (entry.kind === "clause") {
      const clause = ledger.clauses.find((candidate) => candidate.clause_id === entry.key);
      if (clause) region = { start_line: clause.line, end_exclusive_line: clause.end_exclusive_line };
    } else {
      const table = ledger.tables.find((candidate) => candidate.table_no === entry.key);
      if (table) region = tableRegion(ledger, table, lineCount);
    }

    if (!region) {
      unresolved.push(entry.literal);
      citations.push({
        literal: entry.literal,
        line: entry.line,
        kind: entry.kind,
        key: entry.key,
        resolved: false,
        bytes: 0,
        start_line: 0,
        end_exclusive_line: 0,
      });
      continue;
    }

    // 引到自己范围内的条/表不是扇入，不重复计账。
    const inside = region.start_line >= scope.start_line && region.end_exclusive_line <= scope.end_exclusive_line;
    const dedupeKey = `${entry.kind}:${entry.key}`;
    const counts = !inside && !countedKeys.has(dedupeKey);
    // bytes 报的是「这一处实际计入了多少」，不是被引区域有多大——
    // 同一附录被两条引用时第二条计 0，明细加总必须等于 fan_in_bytes。
    const bytes = counts ? sliceBytes(lines, region.start_line, region.end_exclusive_line) : 0;
    if (counts) {
      countedKeys.add(dedupeKey);
      fanInBytes += bytes;
    }
    citations.push({
      literal: entry.literal,
      line: entry.line,
      kind: entry.kind,
      key: entry.key,
      resolved: true,
      bytes,
      start_line: region.start_line,
      end_exclusive_line: region.end_exclusive_line,
    });
  }

  const ownBytes = sliceBytes(lines, scope.start_line, scope.end_exclusive_line);
  return {
    own_bytes: ownBytes,
    fan_in_bytes: fanInBytes,
    total_bytes: ownBytes + fanInBytes,
    citations,
    unresolved_literals: [...new Set(unresolved)],
  };
}
