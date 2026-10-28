import { join } from "node:path";
import { atomicWriteJson, pathExists, readJson } from "./atomic.js";
import { sha256Json } from "./canonical.js";

const SCHEMA = "selector-diagnostic-array-pages/v1";
const PAGE_BYTES = 8 * 1024;
const PAGE_COUNT = 64;
type RecordValue = Record<string, unknown>;
export interface DiagnosticDetailIdentity {
  root: string; job_id: string; target_id: string; revision: number; inputs_fingerprint: string;
}
interface Snapshot extends DiagnosticDetailIdentity { schema_version: string; issues: Record<string, unknown> }
const object = (v: unknown): v is RecordValue => Boolean(v && typeof v === "object" && !Array.isArray(v));
const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v), "utf8");
const pointerToken = (v: string) => v.replace(/~/g, "~0").replace(/\//g, "~1");
const snapshotPath = (identity: DiagnosticDetailIdentity) => join(identity.root, "selector-diagnostic-array-pages.json");
function matches(snapshot: Snapshot | undefined, identity: DiagnosticDetailIdentity): boolean {
  return Boolean(snapshot && snapshot.schema_version === SCHEMA && snapshot.job_id === identity.job_id
    && snapshot.target_id === identity.target_id && snapshot.revision === identity.revision
    && snapshot.inputs_fingerprint === identity.inputs_fingerprint && object(snapshot.issues));
}
function page(values: unknown[], cursor: number) {
  const entries: unknown[] = [];
  for (const value of values.slice(cursor)) {
    if (entries.length && (entries.length >= PAGE_COUNT || bytes([...entries, value]) > PAGE_BYTES)) break;
    entries.push(value);
  }
  const next = cursor + entries.length;
  return { entries, cursor, total_count: values.length, returned_count: entries.length,
    remaining_count: Math.max(0, values.length - next), next_cursor: next < values.length ? next : null };
}
function navigation(key: string, path: string, cursor: number | null) {
  return cursor === null ? null : { next_tool: "get_target_context", next_tool_arguments: {
    diagnostic_detail_key: key, diagnostic_detail_path: path, diagnostic_detail_cursor: cursor,
  } };
}

/** Bound diagnostic directories only. Business records, scalar facts and repair prose stay intact. */
export async function pageDiagnosticResponse<T>(response: T, identify: () => Promise<DiagnosticDetailIdentity>): Promise<T> {
  const captured: Record<string, unknown> = {};
  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(visit);
    if (!object(value)) return value;
    if (typeof value.code === "string" && /^(selector_|compiler_)/.test(value.code)
      && typeof value.path === "string" && typeof value.message === "string") {
      const key = sha256Json(value), pages: RecordValue[] = [];
      const bound = (entry: unknown, path: string): unknown => {
        if (Array.isArray(entry)) {
          if (entry.length > 1 && bytes(entry) > PAGE_BYTES) {
            const first = page(entry, 0);
            pages.push({ path, total_count: entry.length, returned_count: first.returned_count,
              remaining_count: first.remaining_count, next_page: navigation(key, path, first.next_cursor) });
            return first.entries;
          }
          return entry.map((child, i) => bound(child, `${path}/${i}`));
        }
        return object(entry) ? Object.fromEntries(Object.entries(entry).map(([k, child]) => [k, bound(child, `${path}/${pointerToken(k)}`)])) : entry;
      };
      const bounded = bound(value, "") as RecordValue;
      if (!pages.length) return value;
      captured[key] = value;
      return { ...bounded, diagnostic_arrays_complete: false, diagnostic_array_pages: pages,
        diagnostic_array_instruction: "长数组仅展示本页，total_count/remaining_count 包含未展示部分；按各数组 next_page 只读读取同一诊断快照的完整后续条目。分页不读取原文、不运行校验、不清除问题；可先依据已读来源保存真实修复，输入变化后旧页失效。标量实际值、通过条件及修法原文完整保留。" };
    }
    const result = Object.fromEntries(Object.entries(value).map(([k, child]) => [k, visit(child)]));
    for (const [list, meta] of [["issues", "issue_page"], ["selector_issues", "selector_issue_page"]] as const) {
      if (Array.isArray(result[list]) && object(result[meta])) result[meta] = { ...result[meta],
        reported_issue_utf8_bytes: (result[list] as unknown[]).reduce<number>((n, issue) => n + bytes(issue), 0) };
    }
    return result;
  };
  const result = visit(response) as T;
  if (!Object.keys(captured).length) return response;
  const identity = await identify(), path = snapshotPath(identity);
  const previous = await pathExists(path) ? await readJson<Snapshot>(path) : undefined;
  await atomicWriteJson(path, { ...identity, schema_version: SCHEMA,
    issues: { ...(matches(previous, identity) ? previous!.issues : {}), ...captured } });
  return result;
}

export async function readDiagnosticArrayPage(input: RecordValue, identity: DiagnosticDetailIdentity): Promise<RecordValue> {
  const path = snapshotPath(identity), snapshot = await pathExists(path) ? await readJson<Snapshot>(path) : undefined;
  if (!snapshot || !matches(snapshot, identity)) return { ok: false, terminal: false, error: "selector_diagnostic_detail_checkpoint_stale",
    actual: { snapshot_present: Boolean(snapshot), matches_current_inputs: snapshot?.inputs_fingerprint === identity.inputs_fingerprint },
    expected: { snapshot: "same_job_target_revision_contract_and_current_inputs" },
    next_tool: "read_target_selectors", next_tool_arguments: { collection: "references", cursor: 0 },
    instruction: "诊断快照已失效或不存在，不返回旧值或旧数字路径。按当前完整 keyed 作者记录和已读原文继续真实修复；不要为翻页重复保存未修改草稿或触发完整校验。",
    budget_consumed: false, full_stage_check_performed: false };
  const key = String(input.diagnostic_detail_key ?? ""), pointer = String(input.diagnostic_detail_path ?? "");
  let value = Object.hasOwn(snapshot.issues, key) ? snapshot.issues[key] : undefined;
  if (!pointer.startsWith("/")) value = undefined;
  else for (const token of pointer.slice(1).split("/")) {
    const name = token.replace(/~1/g, "/").replace(/~0/g, "~");
    value = (object(value) || Array.isArray(value)) && Object.hasOwn(value, name)
      ? (value as RecordValue)[name] : undefined;
  }
  const cursor = Number(input.diagnostic_detail_cursor ?? 0);
  if (!Array.isArray(value) || !Number.isInteger(cursor) || cursor < 0 || cursor > value.length) return {
    ok: false, terminal: false, error: "selector_diagnostic_detail_page_invalid",
    actual: { diagnostic_detail_key: key, diagnostic_detail_path: pointer, diagnostic_detail_cursor: cursor },
    expected: "Copy the exact key, array path and nonnegative cursor from diagnostic_array_pages.next_page.",
    writable_paths: ["/diagnostic_detail_key", "/diagnostic_detail_path", "/diagnostic_detail_cursor"],
    next_tool: "get_target_context", next_tool_arguments: { source_repair_cursor: 0 },
    instruction: "只按真实回条的 next_page 复制分页参数；不能猜数组路径或快照键。当前有限诊断不等于完整校验通过。",
    budget_consumed: false, full_stage_check_performed: false };
  const result = page(value, cursor);
  return { ok: true, diagnostic_detail_key: key, diagnostic_detail_path: pointer, ...result,
    next_page: navigation(key, pointer, result.next_cursor), snapshot_matches_current_inputs: true,
    budget_consumed: false, full_stage_check_performed: false, source_read_performed: false,
    instruction: "这是同一诊断长数组的完整连续条目；不是原文读取、业务采用、问题收敛或阶段校验。保留未展示部分，按 next_page 继续；实际输入变化后旧页失效。" };
}
