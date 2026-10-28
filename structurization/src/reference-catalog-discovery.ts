/**
 * 规则发现：让模型产出「切目录的规则」，而不是产出目录本身。
 *
 * 这条差别决定一切——模型直接产目录，输出 138 KB 且对错不可判定；模型产规则，
 * 输出几百字节，且规则的效果能在全量证据上被 verifyReferenceCatalog 机械验证。
 *
 * 早期那套「LLM 编排 DSL pipeline」被删掉，不是因为让 LLM 定规则的想法错，
 * 而是失败信号只看「抽到 0」，对「抽错了」「抽多了」一概视为成功。这里的校验是
 * 总和守恒：证据必须恰好落进目录，一条不多一条不少，猜错当场拒绝并说明差在哪。
 */

import {
  buildFallbackCatalog,
  buildReferenceCatalog,
  catalogSampleForRuleDiscovery,
  DEFAULT_REFERENCE_CATALOG_RULES,
  ReferenceCatalogRuleError,
  verifyReferenceCatalog,
  type CatalogEvidenceRecord,
  type ReferenceCatalogEntry,
  type ReferenceCatalogRules,
  type ReferenceCatalogVerification,
} from "./reference-catalog.js";
import { toolReject } from "./actionable-error.js";
import { sha256Json } from "./canonical.js";

/** 规则从哪儿来的——现场报告要能说清楚，不能只给一份目录不交代出处。 */
export type CatalogRuleSource = "default" | "cached" | "discovered" | "fallback";

export interface ResolvedCatalog {
  entries: ReferenceCatalogEntry[];
  rules: ReferenceCatalogRules | undefined;
  rule_source: CatalogRuleSource;
  verification: ReferenceCatalogVerification;
  /** 规则发现实际发生了几轮（0 = 没叫模型）。 */
  discovery_attempts: number;
  /** Local tool timeout was cooperatively cleaned up before deterministic fallback. */
  local_timeout_fallback?: true;
}

const localToolTimeoutReasons = new WeakSet<Error>();

export function createLocalToolTimeoutReason(message: string, cause?: unknown): Error {
  const reason = new Error(message, cause === undefined ? undefined : { cause });
  reason.name = "LocalToolTimeoutError";
  (reason as Error & { code: string }).code = "ETIMEDOUT";
  localToolTimeoutReasons.add(reason);
  return reason;
}

export function isLocalToolTimeoutReason(reason: unknown): boolean {
  return reason instanceof Error && localToolTimeoutReasons.has(reason);
}

/**
 * 规则发现的提问函数。由调用方注入真实模型，模块本身零依赖、可单测。
 * 返回 undefined 表示放弃（模型不可用 / 输出不可解析），走兜底。
 */
export type CatalogRuleAsk = (
  request: CatalogRuleRequest,
  signal?: AbortSignal,
) => Promise<ReferenceCatalogRules | undefined>;

export interface CatalogRuleRequest {
  target_key: string;
  /** 只送疑似标题行和每种 role 的头几条，几 KB。绝不送全文。 */
  sample: Array<{ locator: string; role: string; text: string }>;
  /** 上一轮为什么被拒——带着具体指标回去重猜，而不是让它盲猜第二次。 */
  previous_rejection?: {
    rules: ReferenceCatalogRules;
    coverage: number;
    issues: ReferenceCatalogVerification["issues"];
  };
  evidence_count: number;
}

export interface CatalogRuleCache {
  get(targetKey: string): Promise<ReferenceCatalogRules | undefined>;
  set(targetKey: string, rules: ReferenceCatalogRules, signal?: AbortSignal): Promise<void>;
  getFallback?(targetKey: string): Promise<string | undefined>;
  setFallback?(targetKey: string, fingerprint: string, signal?: AbortSignal): Promise<void>;
}

export const CATALOG_RULE_DISCOVERY_PROMPT_ZH = [
  "你在为一份被引用的标准文本（附录 / 章节）确定「怎么切目录」的规则。",
  "只输出规则，不要输出目录本身，也不要复述正文。",
  "规则是四条正则表达式，作用在每一行归一化后的文本上：",
  "  table_title        表标题行。捕获组1=表号，捕获组2=表名。",
  "  table_continuation 续表标记行。捕获组1=表号；命中后并回同一个表，不新开条目。",
  "  clause             条文行。捕获组1=条文号，捕获组2=首句。",
  "  subitem            款行（挂到当前条文）。",
  "表体行和表注不用你管，程序按扫描器给的 role 标签自动归属。",
  "判据必须落在「标题的形态」上（编号格式、前缀词、是否独立成行），不要写死具体的表名或条文内容。",
  "输出严格的 JSON：{\"table_title\":\"…\",\"table_continuation\":\"…\",\"clause\":\"…\",\"subitem\":\"…\"}",
].join("\n");

/** 模型可能把 JSON 裹在解释文字或代码围栏里，这里只做形状归一，不做语义纠正。 */
export function parseCatalogRules(raw: unknown): ReferenceCatalogRules | undefined {
  let value: unknown = raw;
  if (typeof value === "string") {
    const fenced = /```(?:json)?\s*([\s\S]*?)```/u.exec(value);
    const text = (fenced?.[1] ?? value).trim();
    try {
      value = JSON.parse(text);
    } catch {
      return undefined;
    }
  }
  if (value === null || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const fields: Array<keyof ReferenceCatalogRules> = [
    "table_title",
    "table_continuation",
    "clause",
    "subitem",
  ];
  const rules = {} as ReferenceCatalogRules;
  for (const field of fields) {
    const entry = record[field];
    if (typeof entry !== "string" || entry.length === 0) return undefined;
    rules[field] = entry;
  }
  return rules;
}

export function catalogRulesProposalResult(raw: unknown) {
  const rules = parseCatalogRules(raw);
  if (rules) return { ok: true as const, rules };
  const record = raw !== null && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  const fields: Array<keyof ReferenceCatalogRules> = [
    "table_title",
    "table_continuation",
    "clause",
    "subitem",
  ];
  return toolReject({
    error: "catalog_rules_shape_invalid",
    instruction: "Call propose_catalog_rules with four non-empty regex strings: table_title, table_continuation, clause, and subitem. Capture groups must follow the contract. Do not wrap the fields in prose.",
    missing_fields: fields.filter((field) => typeof record[field] !== "string" || !(record[field] as string).length),
    writable_collection: "propose_catalog_rules",
    required_action: "resubmit_four_regex_fields",
  });
}

export function catalogRuleDiscoveryUserPrompt(request: CatalogRuleRequest): string {
  const rejection = request.previous_rejection;
  return [
    `Target ${request.target_key} has ${request.evidence_count} evidence records.`,
    rejection
      ? `The previous proposal was rejected: coverage ${(rejection.coverage * 100).toFixed(1)}%. Issues: ${JSON.stringify(rejection.issues)}. Rules were ${JSON.stringify(rejection.rules)}.`
      : "The built-in rules did not classify this document.",
    "Sample lines (locator | role | text):",
    ...request.sample.map((entry) => `${entry.locator} | ${entry.role} | ${entry.text}`),
    "Call propose_catalog_rules exactly once.",
  ].join("\n");
}

function tryBuild(
  evidence: readonly CatalogEvidenceRecord[],
  rules: ReferenceCatalogRules,
): { entries: ReferenceCatalogEntry[]; verification: ReferenceCatalogVerification } | undefined {
  try {
    const entries = buildReferenceCatalog(evidence, rules);
    return { entries, verification: verifyReferenceCatalog(entries, evidence) };
  } catch (error) {
    if (error instanceof ReferenceCatalogRuleError) return undefined;
    throw error;
  }
}

export interface ResolveCatalogOptions {
  targetKey: string;
  evidence: readonly CatalogEvidenceRecord[];
  cache?: CatalogRuleCache | undefined;
  ask?: CatalogRuleAsk | undefined;
  maxDiscoveryAttempts?: number;
  /** 调用方用工作区根目录、目标和证据版本组成；相同 key 共享一个在途解析。 */
  flightKey?: string | undefined;
  signal?: AbortSignal | undefined;
}

interface CatalogResolutionFlight {
  controller: AbortController;
  promise: Promise<ResolvedCatalog>;
  waiters: Map<symbol, { aborted: boolean; reason: unknown }>;
}

const catalogResolutionFlights = new Map<string, CatalogResolutionFlight>();

function throwSignalReason(signal: AbortSignal): never {
  throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

async function joinCatalogResolutionFlight(
  flight: CatalogResolutionFlight,
  signal?: AbortSignal,
): Promise<ResolvedCatalog> {
  const waiter = Symbol("catalog-resolution-waiter");
  flight.waiters.set(waiter, { aborted: false, reason: undefined });
  let rejectEarly!: (reason: unknown) => void;
  const earlyAbort = new Promise<never>((_resolve, reject) => { rejectEarly = reject; });
  const abort = () => {
    const reason = signal?.reason ?? new DOMException("The operation was aborted", "AbortError");
    flight.waiters.set(waiter, { aborted: true, reason });
    const anotherWaiterIsActive = [...flight.waiters.entries()]
      .some(([id, entry]) => id !== waiter && !entry.aborted);
    if (anotherWaiterIsActive) {
      // This caller owns only its wait. It must not keep waiting for shared work,
      // and it must not cancel work still needed by another caller.
      rejectEarly(reason);
    } else if (!flight.controller.signal.aborted) {
      // The last waiter owns cleanup too: abort the shared work, then let the
      // common promise settle before this caller is released.
      flight.controller.abort(reason);
    }
  };
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  let result: ResolvedCatalog;
  try {
    result = await Promise.race([flight.promise, earlyAbort]);
  } catch (error) {
    if (signal?.aborted) throwSignalReason(signal);
    throw error;
  } finally {
    signal?.removeEventListener("abort", abort);
    flight.waiters.delete(waiter);
  }
  if (signal?.aborted && !result.local_timeout_fallback) throwSignalReason(signal);
  return result;
}

/**
 * 目录解析的完整梯子：缓存 → 兜底规则 → 规则发现 Agent（带拒绝理由重试）→ 确定性分段。
 * 每一层都必须过 verifyReferenceCatalog 才算数；最后一层保证目录一定存在，
 * 不会因为规则不适用就让这个引用目标彻底不可用。
 */
async function resolveReferenceCatalogOnce(options: ResolveCatalogOptions): Promise<ResolvedCatalog> {
  const { targetKey, evidence, cache, ask } = options;
  const maxAttempts = Math.max(0, options.maxDiscoveryAttempts ?? 2);
  if (options.signal?.aborted) throwSignalReason(options.signal);

  const cached = await cache?.get(targetKey);
  if (options.signal?.aborted) throwSignalReason(options.signal);
  if (cached) {
    const built = tryBuild(evidence, cached);
    if (built?.verification.ok) {
      return { ...built, rules: cached, rule_source: "cached", discovery_attempts: 0 };
    }
    // 缓存的规则不再适用（证据变了），不当它存在，继续往下走。
  }

  const byDefault = tryBuild(evidence, DEFAULT_REFERENCE_CATALOG_RULES);
  if (options.signal?.aborted) throwSignalReason(options.signal);
  if (byDefault?.verification.ok) {
    return {
      ...byDefault,
      rules: DEFAULT_REFERENCE_CATALOG_RULES,
      rule_source: "default",
      discovery_attempts: 0,
    };
  }

  // Cache the decision to use deterministic segmentation, not read receipts or
  // model conclusions. Rebuild and verify against the current immutable input.
  const fallbackFingerprint = sha256Json({ version: "catalog-fallback/v1", evidence,
    defaults: DEFAULT_REFERENCE_CATALOG_RULES, maxAttempts });
  if (cache?.getFallback && await cache.getFallback(targetKey) === fallbackFingerprint) {
    if (options.signal?.aborted) throwSignalReason(options.signal);
    const entries = buildFallbackCatalog(evidence);
    const verification = verifyReferenceCatalog(entries, evidence);
    if (verification.ok) return { entries, rules: undefined, rule_source: "fallback", verification, discovery_attempts: 0 };
  }
  let attempts = 0;
  let exhaustedInvalidProposals = false;
  let rejection: CatalogRuleRequest["previous_rejection"] | undefined = byDefault
    ? {
        rules: DEFAULT_REFERENCE_CATALOG_RULES,
        coverage: byDefault.verification.coverage,
        issues: byDefault.verification.issues,
      }
    : undefined;

  if (ask) {
    const sample = catalogSampleForRuleDiscovery(evidence);
    while (attempts < maxAttempts) {
      attempts += 1;
      const request: CatalogRuleRequest = {
        target_key: targetKey,
        sample,
        evidence_count: evidence.length,
        ...(rejection ? { previous_rejection: rejection } : {}),
      };
      if (options.signal?.aborted) throwSignalReason(options.signal);
      const proposed = await ask(request, options.signal);
      if (options.signal?.aborted && isLocalToolTimeoutReason(options.signal.reason) && proposed === undefined) {
        const entries = buildFallbackCatalog(evidence);
        return {
          entries,
          rules: undefined,
          rule_source: "fallback",
          verification: verifyReferenceCatalog(entries, evidence),
          discovery_attempts: attempts,
          local_timeout_fallback: true,
        };
      }
      if (options.signal?.aborted) throwSignalReason(options.signal);
      if (!proposed) break;
      const built = tryBuild(evidence, proposed);
      if (built?.verification.ok) {
        if (options.signal?.aborted) throwSignalReason(options.signal);
        await cache?.set(targetKey, proposed, options.signal);
        if (options.signal?.aborted) throwSignalReason(options.signal);
        return { ...built, rules: proposed, rule_source: "discovered", discovery_attempts: attempts };
      }
      rejection = built
        ? { rules: proposed, coverage: built.verification.coverage, issues: built.verification.issues }
        : {
            rules: proposed,
            coverage: 0,
            issues: [{ code: "catalog_rule_uncompilable", message: "rules are not valid regular expressions", details: {} }],
          };
      exhaustedInvalidProposals = attempts === maxAttempts;
    }
  }

  // 最后一层：确定性分段。粗，但保证全覆盖、保证可挑选。
  if (options.signal?.aborted) throwSignalReason(options.signal);
  const entries = buildFallbackCatalog(evidence);
  const verification = verifyReferenceCatalog(entries, evidence);
  if (verification.ok && exhaustedInvalidProposals && cache?.setFallback) {
    if (options.signal?.aborted) throwSignalReason(options.signal);
    await cache.setFallback(targetKey, fallbackFingerprint, options.signal);
  }
  if (options.signal?.aborted) throwSignalReason(options.signal);
  return {
    entries,
    rules: undefined,
    rule_source: "fallback",
    verification,
    discovery_attempts: attempts,
  };
}

export async function resolveReferenceCatalog(options: ResolveCatalogOptions): Promise<ResolvedCatalog> {
  if (options.signal?.aborted) throwSignalReason(options.signal);
  const flightKey = options.flightKey;
  if (!flightKey) return resolveReferenceCatalogOnce(options);
  const existing = catalogResolutionFlights.get(flightKey);
  if (existing) {
    if (!existing.controller.signal.aborted) {
      return joinCatalogResolutionFlight(existing, options.signal);
    }
    // An aborted flight remains authoritative until cleanup finishes. Do not
    // attach a new waiter to it and do not overlap a replacement with it.
    try {
      await existing.promise;
    } catch {
      // The replacement starts only after the old work has fully settled.
    }
    if (options.signal?.aborted) throwSignalReason(options.signal);
    return resolveReferenceCatalog(options);
  }

  const controller = new AbortController();
  const flight: CatalogResolutionFlight = {
    controller,
    waiters: new Map(),
    promise: undefined as unknown as Promise<ResolvedCatalog>,
  };
  flight.promise = Promise.resolve()
    .then(() => resolveReferenceCatalogOnce({ ...options, signal: controller.signal }))
    .finally(() => {
      if (catalogResolutionFlights.get(flightKey) === flight) catalogResolutionFlights.delete(flightKey);
    });
  catalogResolutionFlights.set(flightKey, flight);
  return joinCatalogResolutionFlight(flight, options.signal);
}
