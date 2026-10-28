import { describe, expect, test } from "vitest";

import {
  buildFallbackCatalog,
  buildReferenceCatalog,
  catalogSampleForRuleDiscovery,
  compileReferenceCatalogRules,
  DEFAULT_REFERENCE_CATALOG_RULES,
  ReferenceCatalogRuleError,
  renderReferenceCatalog,
  verifyReferenceCatalog,
  type CatalogEvidenceRecord,
  type ReferenceCatalogRules,
} from "../src/reference-catalog.js";
import {
  catalogRuleDiscoveryUserPrompt,
  catalogRulesProposalResult,
  parseCatalogRules,
  resolveReferenceCatalog,
  type CatalogRuleAsk,
  type CatalogRuleCache,
} from "../src/reference-catalog-discovery.js";

let sequence = 0;
function record(line: number, role: string, text: string, rowIndex?: number): CatalogEvidenceRecord {
  sequence += 1;
  return {
    evidence_id: `evidence:${String(sequence).padStart(4, "0")}`,
    role,
    locator: rowIndex === undefined ? `line:${line}` : `line:${line}/table-row:${rowIndex}`,
    text,
  };
}

/** 附录 B 的真实形态：条文 → 表标题 → 表体 → 续表 → 表体 → 表注。 */
function appendixBLike(): CatalogEvidenceRecord[] {
  return [
    record(767, "context", "B.0.1 各等级的布线系统应按照永久链路和信道进行测试。"),
    record(769, "context", "1) 永久链路性能测试连接模型应包括水平电缆及相关连接器件。"),
    record(841, "context", "2) 布线系统永久链路的最小回波损耗值应符合表 B.0.3-1 的规定。"),
    record(843, "context", "表 B.0.3-1 回波损耗(RL)值"),
    record(845, "formal_table_header", '<tr><td>频率(MHz)</td><td>最小RL值(dB)</td></tr>', 1),
    record(845, "formal_table_row", "<tr><td>1</td><td>15.0</td></tr>", 2),
    record(845, "formal_table_row", "<tr><td>16</td><td>15.0</td></tr>", 3),
    record(847, "context", "续表 B.0.3-1"),
    record(849, "formal_table_header", '<tr><td>频率(MHz)</td><td>最小RL值(dB)</td></tr>', 1),
    record(849, "formal_table_row", "<tr><td>100</td><td>12.0</td></tr>", 2),
    record(851, "table_note", "注：①为有 CP 点存在的永久链路指标。"),
    record(853, "context", "表 B.0.3-2 插入损耗(IL)值"),
    record(855, "formal_table_header", '<tr><td>频率(MHz)</td><td>最大IL值(dB)</td></tr>', 1),
    record(855, "formal_table_row", "<tr><td>1</td><td>4.0</td></tr>", 2),
  ];
}

/** 附录 A 的真实形态：整份就一张 `表 A`，表号没有 `-序号` 后缀。 */
function appendixALike(): CatalogEvidenceRecord[] {
  return [
    record(739, "context", "表 A 检验项目及内容"),
    record(741, "formal_table_header", "<tr><td>阶段</td><td>验收项目</td></tr>", 1),
    record(741, "formal_table_row", "<tr><td>施工前检查</td><td>环境要求</td></tr>", 2),
    record(743, "context", "续表 A"),
    record(745, "formal_table_header", "<tr><td>阶段</td><td>验收项目</td></tr>", 1),
    record(745, "formal_table_row", "<tr><td>设备安装</td><td>机柜、机架</td></tr>", 2),
  ];
}

describe("reference catalog rules", () => {
  test("groups tables and clauses, merging 续表 back into the same entry", () => {
    const evidence = appendixBLike();
    const entries = buildReferenceCatalog(evidence);
    const ids = entries.map((entry) => entry.entry_id);
    expect(ids).toEqual(["B.0.1", "B.0.3-1", "B.0.3-2"]);
    expect(entries.map((entry) => entry.source_label)).toEqual(ids);

    const rl = entries.find((entry) => entry.entry_id === "B.0.3-1")!;
    expect(rl.kind).toBe("table");
    expect(rl.title).toBe("回波损耗(RL)值");
    // 主表 + 续表并成一条，而不是两条——模型上一版正是在这里把一张表拆散的。
    expect(rl.segments).toBe(2);
    expect(rl.rows).toBe(5);
    expect(rl.notes).toBe(1);
    expect(rl.start_line).toBe(843);
    expect(rl.end_line).toBe(851);

    const clause = entries.find((entry) => entry.entry_id === "B.0.1")!;
    expect(clause.kind).toBe("clause");
    // 条文下的 `1)` `2)` 两款都归到它名下
    expect(clause.rows).toBe(2);
  });

  test("handles a whole-appendix table whose number carries no -N suffix", () => {
    const evidence = appendixALike();
    const entries = buildReferenceCatalog(evidence);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.entry_id).toBe("A");
    expect(entries[0]!.title).toBe("检验项目及内容");
    expect(entries[0]!.segments).toBe(2);
    expect(verifyReferenceCatalog(entries, evidence).coverage).toBe(1);
  });

  test("classifies every evidence record exactly once", () => {
    const evidence = [...appendixBLike(), ...appendixALike()];
    const entries = buildReferenceCatalog(evidence);
    const classified = entries.flatMap((entry) => entry.evidence_ids);
    expect(new Set(classified).size).toBe(classified.length);
    expect(new Set(classified).size).toBe(evidence.length);
  });

  test("works on a plain-text target that has no tables at all", () => {
    const evidence = [
      record(10, "context", "C.0.1 测试前应对所有光连接器件进行清洗。"),
      record(11, "context", "1) 应将测试接收器与光源校准。"),
      record(12, "context", "C.0.2 测试应符合下列规定："),
      record(13, "context", "1) 应采用一级或二级测试模型。"),
    ];
    const entries = buildReferenceCatalog(evidence);
    expect(entries.map((entry) => entry.entry_id)).toEqual(["C.0.1", "C.0.2"]);
    expect(entries.every((entry) => entry.kind === "clause")).toBe(true);
    expect(verifyReferenceCatalog(entries, evidence).ok).toBe(true);
  });

  test("keeps a shared source label while assigning distinct stable machine IDs", () => {
    const evidence = [
      record(10, "context", "D.0.1 构件应完成复核。"),
      record(11, "context", "1) 复核记录应完整。"),
      record(20, "context", "表 D.0.1 复核项目"),
      record(21, "formal_table_header", "<tr><td>项目</td><td>要求</td></tr>", 1),
      record(21, "formal_table_row", "<tr><td>记录</td><td>完整</td></tr>", 2),
    ];
    const entries = buildReferenceCatalog(evidence);
    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.source_label)).toEqual(["D.0.1", "D.0.1"]);
    expect(new Set(entries.map((entry) => entry.entry_id)).size).toBe(2);
    expect(entries.every((entry) => entry.entry_id.startsWith("catalog-entry:"))).toBe(true);
    expect(buildReferenceCatalog(evidence)).toEqual(entries);
    expect(verifyReferenceCatalog(entries, evidence).ok).toBe(true);
  });

  test("rejects rules that are not compilable regular expressions", () => {
    const broken: ReferenceCatalogRules = { ...DEFAULT_REFERENCE_CATALOG_RULES, clause: "^([A-Z" };
    expect(() => compileReferenceCatalogRules(broken)).toThrow(ReferenceCatalogRuleError);
  });

  test("rejects an over-long rule source", () => {
    const huge: ReferenceCatalogRules = { ...DEFAULT_REFERENCE_CATALOG_RULES, clause: `^(${"a".repeat(500)})$` };
    expect(() => compileReferenceCatalogRules(huge)).toThrow(ReferenceCatalogRuleError);
  });

  test("renders one compact row per entry", () => {
    const rendered = renderReferenceCatalog(buildReferenceCatalog(appendixBLike()));
    expect(rendered).toHaveLength(3);
    expect(rendered[1]).toMatchObject({ entry_id: "B.0.3-1", kind: "table", size: "5rows+1notes" });
    // 目录必须比原文小一个数量级，否则等于没挑
    const bytes = Buffer.byteLength(JSON.stringify(rendered), "utf8");
    expect(bytes).toBeLessThan(600);
  });
});

describe("reference catalog verification", () => {
  test("flags evidence that no rule classified", () => {
    const evidence = appendixBLike();
    const entries = buildReferenceCatalog(evidence);
    const stripped = entries.map((entry) => ({ ...entry, evidence_ids: entry.evidence_ids.slice(0, 1) }));
    const verification = verifyReferenceCatalog(stripped, evidence);
    expect(verification.ok).toBe(false);
    expect(verification.coverage).toBeLessThan(1);
    expect(verification.issues.map((issue) => issue.code)).toContain("catalog_coverage_incomplete");
    expect(verification.issues[0]!.details).toHaveProperty("unclassified_samples");
  });

  test("flags one evidence record classified into two entries", () => {
    const evidence = appendixBLike();
    const entries = buildReferenceCatalog(evidence);
    const shared = entries[0]!.evidence_ids[0]!;
    entries[1]!.evidence_ids.push(shared);
    const verification = verifyReferenceCatalog(entries, evidence);
    expect(verification.ok).toBe(false);
    expect(verification.issues.map((issue) => issue.code)).toContain("catalog_evidence_duplicated");
  });

  test("flags a rule that produced no split at all on a large target", () => {
    const evidence = Array.from({ length: 60 }, (_, index) => record(100 + index, "context", `plain line ${index}`));
    const single = [{
      entry_id: "seg:1", source_label: "seg:1", kind: "segment" as const, title: "all", rows: 60, notes: 0, segments: 1,
      start_line: 100, end_line: 159, evidence_ids: evidence.map((entry) => entry.evidence_id),
    }];
    const verification = verifyReferenceCatalog(single, evidence);
    expect(verification.ok).toBe(false);
    expect(verification.issues.map((issue) => issue.code)).toContain("catalog_not_segmented");
  });

  test("flags shredding a table into one entry per row", () => {
    const evidence = appendixBLike();
    const shredded = evidence.map((entry, index) => ({
      entry_id: `row:${index}`, source_label: `row:${index}`, kind: "segment" as const, title: entry.text, rows: 1, notes: 0, segments: 1,
      start_line: index, end_line: index, evidence_ids: [entry.evidence_id],
    }));
    const verification = verifyReferenceCatalog(shredded, evidence);
    expect(verification.ok).toBe(false);
    expect(verification.issues.map((issue) => issue.code)).toContain("catalog_granularity_too_fine");
  });

  test("flags an inverted line range", () => {
    const evidence = appendixBLike();
    const entries = buildReferenceCatalog(evidence);
    entries[0]!.end_line = entries[0]!.start_line - 5;
    const verification = verifyReferenceCatalog(entries, evidence);
    expect(verification.issues.map((issue) => issue.code)).toContain("catalog_line_range_inverted");
  });

  test("flags duplicate machine entry IDs mechanically", () => {
    const evidence = appendixBLike();
    const entries = buildReferenceCatalog(evidence);
    entries[1]!.entry_id = entries[0]!.entry_id;
    const verification = verifyReferenceCatalog(entries, evidence);
    expect(verification.ok).toBe(false);
    expect(verification.issues.map((issue) => issue.code)).toContain("catalog_entry_id_duplicated");
    expect(verification.issues.find((issue) => issue.code === "catalog_entry_id_duplicated")?.message)
      .toContain("不唯一");
  });
});

describe("catalog rule discovery", () => {
  /** 默认规则认不出来的文档：条文用「第 N 条」，表标题用「附表 N」。 */
  function foreignShape(): CatalogEvidenceRecord[] {
    return [
      record(10, "context", "第 1 条 施工前应完成器材检验。"),
      record(11, "context", "附表 1 器材检验项目"),
      record(12, "formal_table_header", "<tr><td>项目</td><td>要求</td></tr>", 1),
      ...Array.from({ length: 12 }, (_, index) =>
        record(12, "formal_table_row", `<tr><td>项目${index}</td><td>要求${index}</td></tr>`, index + 2)),
      record(13, "table_note", "注：外观检查含包装。"),
      record(14, "context", "第 2 条 缆线敷设应符合设计要求。"),
      record(15, "context", "1) 缆线规格应符合设计。"),
      record(16, "context", "2) 敷设路由应符合设计。"),
    ];
  }

  const foreignRules: ReferenceCatalogRules = {
    table_title: "^附表\\s*(\\d+)\\s+(.*)$",
    table_continuation: "^续附表\\s*(\\d+)\\s*$",
    clause: "^第\\s*(\\d+)\\s*条\\s+(.+)$",
    subitem: "^(\\d+)\\s*[)）]\\s*(.+)$",
  };

  test("uses the default rules without asking when they already verify", async () => {
    const ask: CatalogRuleAsk = async () => { throw new Error("must not be asked"); };
    const resolved = await resolveReferenceCatalog({
      targetKey: "reference-target:a", evidence: appendixBLike(), ask,
    });
    expect(resolved.rule_source).toBe("default");
    expect(resolved.discovery_attempts).toBe(0);
    expect(resolved.verification.ok).toBe(true);
  });

  test("asks for rules when the defaults do not classify the document, then caches them", async () => {
    const store = new Map<string, ReferenceCatalogRules>();
    const cache: CatalogRuleCache = {
      get: async (key) => store.get(key),
      set: async (key, rules) => { store.set(key, rules); },
    };
    let asked = 0;
    const ask: CatalogRuleAsk = async (request) => {
      asked += 1;
      // 第一轮必须收到「上一轮为什么被拒」，否则等于让它盲猜
      expect(request.previous_rejection?.issues.length).toBeGreaterThan(0);
      expect(request.sample.length).toBeGreaterThan(0);
      return foreignRules;
    };
    const resolved = await resolveReferenceCatalog({
      targetKey: "reference-target:b", evidence: foreignShape(), ask, cache,
    });
    expect(asked).toBe(1);
    expect(resolved.rule_source).toBe("discovered");
    expect(resolved.verification.ok).toBe(true);
    expect(resolved.entries.map((entry) => `${entry.kind}:${entry.source_label}`))
      .toEqual(["clause:1", "table:1", "clause:2"]);
    expect(new Set(resolved.entries.map((entry) => entry.entry_id)).size).toBe(3);
    expect(store.get("reference-target:b")).toEqual(foreignRules);
  });

  test("single-flights concurrent discovery for one workspace target and evidence fingerprint", async () => {
    const store = new Map<string, ReferenceCatalogRules>();
    const cache: CatalogRuleCache = {
      get: async (key) => store.get(key),
      set: async (key, rules) => { store.set(key, rules); },
    };
    let releaseAsk!: (rules: ReferenceCatalogRules) => void;
    const askResult = new Promise<ReferenceCatalogRules>((resolve) => { releaseAsk = resolve; });
    let asked = 0;
    const ask: CatalogRuleAsk = async () => {
      asked += 1;
      return askResult;
    };
    const options = {
      targetKey: "reference-target:single-flight",
      evidence: foreignShape(),
      ask,
      cache,
      flightKey: "C:/workspace\0reference-target:single-flight\0evidence-fingerprint",
    } as Parameters<typeof resolveReferenceCatalog>[0];

    const first = resolveReferenceCatalog(options);
    await Promise.resolve();
    await Promise.resolve();
    const concurrentRetry = resolveReferenceCatalog(options);
    await Promise.resolve();
    await Promise.resolve();
    expect(asked).toBe(1);

    releaseAsk(foreignRules);
    await expect(Promise.all([first, concurrentRetry])).resolves.toEqual([
      expect.objectContaining({ rule_source: "discovered", discovery_attempts: 1 }),
      expect.objectContaining({ rule_source: "discovered", discovery_attempts: 1 }),
    ]);
    const afterCache = await resolveReferenceCatalog(options);
    expect(afterCache.rule_source).toBe("cached");
    expect(asked).toBe(1);
  });

  test("keeps a shared discovery alive while another waiter is still active", async () => {
    let releaseAsk!: (rules: ReferenceCatalogRules) => void;
    const askResult = new Promise<ReferenceCatalogRules>((resolve) => { releaseAsk = resolve; });
    let sharedSignal: AbortSignal | undefined;
    let asked = 0;
    const ask: CatalogRuleAsk = async (_request, signal) => {
      asked += 1;
      sharedSignal = signal;
      return askResult;
    };
    const firstSignal = new AbortController();
    const secondSignal = new AbortController();
    const base = {
      targetKey: "reference-target:waiters",
      evidence: foreignShape(),
      ask,
      flightKey: "C:/workspace\0reference-target:waiters\0evidence-fingerprint",
    };

    const first = resolveReferenceCatalog({ ...base, signal: firstSignal.signal });
    const second = resolveReferenceCatalog({ ...base, signal: secondSignal.signal });
    await Promise.resolve();
    await Promise.resolve();
    const firstError = new Error("first waiter stopped");
    const firstAssertion = expect(first).rejects.toBe(firstError);
    let firstSettled = false;
    void first.then(
      () => { firstSettled = true; },
      () => { firstSettled = true; },
    );
    firstSignal.abort(firstError);
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    const settledBeforeSharedAsk = firstSettled;
    expect(sharedSignal?.aborted).toBe(false);
    expect(asked).toBe(1);

    releaseAsk(foreignRules);
    await firstAssertion;
    expect(settledBeforeSharedAsk).toBe(true);
    await expect(second).resolves.toEqual(expect.objectContaining({ rule_source: "discovered" }));
  });

  test("last waiter abort cancels the shared discovery but waits for cleanup to settle", async () => {
    let releaseCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => { releaseCleanup = resolve; });
    let abortObserved!: () => void;
    const sawAbort = new Promise<void>((resolve) => { abortObserved = resolve; });
    const caller = new AbortController();
    const callerReason = new Error("caller stopped the only waiter");
    let sharedReason: unknown;
    const result = resolveReferenceCatalog({
      targetKey: "reference-target:last-waiter",
      evidence: foreignShape(),
      flightKey: "C:/workspace\0reference-target:last-waiter\0evidence-fingerprint",
      signal: caller.signal,
      ask: async (_request, signal) => {
        signal?.addEventListener("abort", () => {
          sharedReason = signal.reason;
          abortObserved();
        }, { once: true });
        await cleanup;
        if (signal?.aborted) throw signal.reason;
        return foreignRules;
      },
    });
    let settled = false;
    void result.then(
      () => { settled = true; },
      () => { settled = true; },
    );
    await Promise.resolve();
    await Promise.resolve();
    caller.abort(callerReason);
    await sawAbort;
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    expect(settled).toBe(false);
    expect(sharedReason).toBe(callerReason);

    releaseCleanup();
    await expect(result).rejects.toBe(callerReason);
  });

  test("preserves each waiter abort reason and aborts the shared work with the last reason", async () => {
    let releaseCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => { releaseCleanup = resolve; });
    let sharedSignal: AbortSignal | undefined;
    const firstSignal = new AbortController();
    const lastSignal = new AbortController();
    const firstReason = new Error("first waiter reason");
    const lastReason = new Error("last waiter reason");
    const base = {
      targetKey: "reference-target:distinct-reasons",
      evidence: foreignShape(),
      flightKey: "C:/workspace\0reference-target:distinct-reasons\0evidence-fingerprint",
      ask: async (_request: unknown, signal?: AbortSignal) => {
        sharedSignal = signal;
        await cleanup;
        if (signal?.aborted) throw signal.reason;
        return foreignRules;
      },
    };
    const first = resolveReferenceCatalog({ ...base, signal: firstSignal.signal });
    const last = resolveReferenceCatalog({ ...base, signal: lastSignal.signal });
    await Promise.resolve();
    await Promise.resolve();

    const firstAssertion = expect(first).rejects.toBe(firstReason);
    const lastAssertion = expect(last).rejects.toBe(lastReason);
    firstSignal.abort(firstReason);
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    expect(sharedSignal?.aborted).toBe(false);

    lastSignal.abort(lastReason);
    expect(sharedSignal?.aborted).toBe(true);
    expect(sharedSignal?.reason).toBe(lastReason);
    releaseCleanup();
    await firstAssertion;
    await lastAssertion;
  });

  test("does not join or overlap an aborted flight that is still cleaning up", async () => {
    let releaseCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => { releaseCleanup = resolve; });
    let firstAbortObserved!: () => void;
    const sawFirstAbort = new Promise<void>((resolve) => { firstAbortObserved = resolve; });
    let asked = 0;
    const ask: CatalogRuleAsk = async (_request, signal) => {
      asked += 1;
      if (asked === 1) {
        signal?.addEventListener("abort", firstAbortObserved, { once: true });
        await cleanup;
        if (signal?.aborted) throw signal.reason;
      }
      return foreignRules;
    };
    const flightKey = "C:/workspace\0reference-target:cleaning-flight\0evidence-fingerprint";
    const firstSignal = new AbortController();
    const firstReason = new Error("old caller stopped");
    const first = resolveReferenceCatalog({
      targetKey: "reference-target:cleaning-flight",
      evidence: foreignShape(),
      flightKey,
      signal: firstSignal.signal,
      ask,
    });
    await Promise.resolve();
    await Promise.resolve();
    firstSignal.abort(firstReason);
    await sawFirstAbort;

    const next = resolveReferenceCatalog({
      targetKey: "reference-target:cleaning-flight",
      evidence: foreignShape(),
      flightKey,
      ask,
    });
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    expect(asked).toBe(1);

    releaseCleanup();
    await expect(first).rejects.toBe(firstReason);
    await expect(next).resolves.toEqual(expect.objectContaining({ rule_source: "discovered" }));
    expect(asked).toBe(2);
  });

  test("passes a non-shared caller signal through to rule discovery", async () => {
    const caller = new AbortController();
    let observed: AbortSignal | undefined;
    const resolved = await resolveReferenceCatalog({
      targetKey: "reference-target:signal",
      evidence: foreignShape(),
      signal: caller.signal,
      ask: async (_request, signal) => {
        observed = signal;
        return foreignRules;
      },
    });
    expect(observed).toBe(caller.signal);
    expect(resolved.rule_source).toBe("discovered");
  });

  test("passes cancellation into the cache write and does not return a discovered result", async () => {
    const caller = new AbortController();
    const reason = new Error("job cancelled at cache boundary");
    let cacheWriteObservedSignal: AbortSignal | undefined;
    let durableWriteCount = 0;
    const cache: CatalogRuleCache = {
      get: async () => undefined,
      set: async (_key, _rules, signal) => {
        cacheWriteObservedSignal = signal;
        caller.abort(reason);
        if (signal?.aborted) throw signal.reason;
        durableWriteCount += 1;
      },
    };
    await expect(resolveReferenceCatalog({
      targetKey: "reference-target:cache-abort",
      evidence: foreignShape(),
      signal: caller.signal,
      cache,
      ask: async () => foreignRules,
    })).rejects.toBe(reason);
    expect(cacheWriteObservedSignal).toBe(caller.signal);
    expect(durableWriteCount).toBe(0);
  });

  test("reuses cached rules without asking again", async () => {
    const store = new Map([["reference-target:b", foreignRules]]);
    const cache: CatalogRuleCache = {
      get: async (key) => store.get(key),
      set: async () => { throw new Error("must not re-cache"); },
    };
    const ask: CatalogRuleAsk = async () => { throw new Error("must not be asked"); };
    const resolved = await resolveReferenceCatalog({
      targetKey: "reference-target:b", evidence: foreignShape(), ask, cache,
    });
    expect(resolved.rule_source).toBe("cached");
    expect(resolved.discovery_attempts).toBe(0);
  });

  test("retries with the rejection detail and stops at the attempt limit", async () => {
    const seen: number[] = [];
    const ask: CatalogRuleAsk = async (request) => {
      seen.push(request.previous_rejection ? 1 : 0);
      return { ...DEFAULT_REFERENCE_CATALOG_RULES, clause: "^NEVER_MATCHES$" };
    };
    const resolved = await resolveReferenceCatalog({
      targetKey: "reference-target:c", evidence: foreignShape(), ask, maxDiscoveryAttempts: 2,
    });
    expect(seen).toEqual([1, 1]);
    expect(resolved.discovery_attempts).toBe(2);
    // 猜不出来也必须给出可用目录，不能让这个引用目标彻底不可用
    expect(resolved.rule_source).toBe("fallback");
    expect(resolved.verification.coverage).toBe(1);
  });

  test("falls back to deterministic segmentation when no model is available", async () => {
    const resolved = await resolveReferenceCatalog({
      targetKey: "reference-target:d", evidence: foreignShape(),
    });
    expect(resolved.rule_source).toBe("fallback");
    expect(resolved.verification.coverage).toBe(1);
    expect(resolved.entries.length).toBeGreaterThan(0);
  });

  test("reuses verified fallback after exhausted discovery, but invalidates on changed evidence", async () => {
    const fallbacks = new Map<string, string>();
    const cache: CatalogRuleCache = {
      get: async () => undefined,
      set: async () => { throw new Error("no successful rules"); },
      getFallback: async key => fallbacks.get(key),
      setFallback: async (key, fingerprint) => { fallbacks.set(key, fingerprint); },
    };
    let asks = 0;
    const ask: CatalogRuleAsk = async () => {
      asks += 1;
      return { ...DEFAULT_REFERENCE_CATALOG_RULES, clause: "^NEVER_MATCHES$" };
    };
    const evidence = foreignShape();
    const options = { targetKey: "reference-target:fallback-cache", evidence, ask, cache };
    const first = await resolveReferenceCatalog(options);
    expect(asks).toBe(2);
    const second = await resolveReferenceCatalog({ ...options, cache: { ...cache } });
    expect(second).toMatchObject({ rule_source: "fallback", discovery_attempts: 0, verification: { ok: true } });
    expect(second.entries).toEqual(first.entries);
    expect(asks).toBe(2);
    await resolveReferenceCatalog({ ...options, evidence: [...evidence, record(30, "context", "新增来源")] });
    expect(asks).toBe(4);
    await resolveReferenceCatalog({ ...options, targetKey: "reference-target:other" });
    expect(asks).toBe(6);
    await resolveReferenceCatalog({ ...options, maxDiscoveryAttempts: 1 });
    expect(asks).toBe(7);
  });

  test("does not cache fallback from unavailable models or cancellation", async () => {
    let writes = 0;
    const cache: CatalogRuleCache = {
      get: async () => undefined, set: async () => {},
      getFallback: async () => undefined,
      setFallback: async () => { writes += 1; },
    };
    const options = { targetKey: "reference-target:transient", evidence: foreignShape(), cache };
    await resolveReferenceCatalog({ ...options, ask: async () => undefined });
    const controller = new AbortController();
    const reason = new Error("cancelled discovery");
    await expect(resolveReferenceCatalog({ ...options, signal: controller.signal, ask: async () => {
      controller.abort(reason);
      return DEFAULT_REFERENCE_CATALOG_RULES;
    } })).rejects.toBe(reason);
    expect(writes).toBe(0);
  });

  test("ignores uncompilable proposals instead of throwing", async () => {
    const ask: CatalogRuleAsk = async () => ({ ...DEFAULT_REFERENCE_CATALOG_RULES, clause: "^([A-Z" });
    const resolved = await resolveReferenceCatalog({
      targetKey: "reference-target:e", evidence: foreignShape(), ask, maxDiscoveryAttempts: 1,
    });
    expect(resolved.rule_source).toBe("fallback");
  });

  test("parses rules out of fenced or bare JSON and rejects incomplete shapes", () => {
    expect(parseCatalogRules("```json\n" + JSON.stringify(foreignRules) + "\n```")).toEqual(foreignRules);
    expect(parseCatalogRules(JSON.stringify(foreignRules))).toEqual(foreignRules);
    expect(parseCatalogRules(foreignRules)).toEqual(foreignRules);
    expect(parseCatalogRules("not json")).toBeUndefined();
    expect(parseCatalogRules({ table_title: "^x$" })).toBeUndefined();
    const rejected = catalogRulesProposalResult({ table_title: "^x$" });
    expect(rejected).toMatchObject({
      ok: false,
      error: "catalog_rules_shape_invalid",
      missing_fields: expect.arrayContaining(["table_continuation", "clause", "subitem"]),
    });
    expect("instruction" in rejected && rejected.instruction).toMatch(/table_title/);
  });

  test("retry prompt keeps unclassified sample text, not only issue codes", () => {
    const prompt = catalogRuleDiscoveryUserPrompt({
      target_key: "reference-target:c",
      sample: [{ locator: "line:1", role: "context", text: "附表 1 外观" }],
      evidence_count: 12,
      previous_rejection: {
        rules: DEFAULT_REFERENCE_CATALOG_RULES,
        coverage: 0.2,
        issues: [{
          code: "catalog_coverage_incomplete",
          message: "10 of 12 evidence records were not classified",
          details: {
            unclassified_samples: [{ locator: "line:4", role: "context", text: "附表 1 外观" }],
          },
        }],
      },
    });
    expect(prompt).toContain("附表 1 外观");
    expect(prompt).toContain("line:4");
    expect(prompt).not.toMatch(/issues \["catalog_coverage_incomplete"\]/);
  });

  test("the discovery sample stays small and omits table body bulk", () => {
    const bulky = [
      record(1, "context", "表 X 大表"),
      ...Array.from({ length: 300 }, (_, index) => record(2, "formal_table_row", `<tr><td>${index}</td></tr>`, index + 1)),
    ];
    const sample = catalogSampleForRuleDiscovery(bulky);
    expect(sample.filter((entry) => entry.role === "formal_table_row")).toHaveLength(2);
    expect(Buffer.byteLength(JSON.stringify(sample), "utf8")).toBeLessThan(4096);
  });
});

describe("fallback catalog", () => {
  test("covers every record and stays selectable", () => {
    const evidence = Array.from({ length: 100 }, (_, index) => record(index, "context", `line ${index}`));
    const entries = buildFallbackCatalog(evidence, 24);
    const verification = verifyReferenceCatalog(entries, evidence);
    expect(verification.ok).toBe(true);
    expect(verification.coverage).toBe(1);
    expect(entries).toHaveLength(5);
  });
});
