import { SOURCE_HANDLE_INSTRUCTION as prompt_SOURCE_HANDLE_INSTRUCTION } from "./acceptance-prompt-suite.js";
﻿import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, realpath, unlink } from "node:fs/promises";
import { join } from "node:path";
import { Ajv } from "ajv";
import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { atomicWriteJson, atomicWriteNewText, pathExists } from "./atomic.js";
import { sha256Json } from "./canonical.js";
import { withToolArgumentFeedback } from "./tool-argument-feedback.js";

export const SOURCE_HANDLE_SCOPE_FIELD = "source_handle_scope";
export const SOURCE_HANDLE_SESSION_ENTRY = "model-source-handles/v1";
export const SOURCE_HANDLE_INSTRUCTION = prompt_SOURCE_HANDLE_INSTRUCTION;

export function sourceHandleSessionMatches(entries: readonly unknown[], scope: string): boolean {
  return entries.some(entry => object(entry) && entry.type === "custom" && entry.customType === SOURCE_HANDLE_SESSION_ENTRY && entry.data?.scope === scope);
}

export async function sourceHandleSessionFileMatches(path: string, scope: string): Promise<boolean> {
  if (!path) return false;
  try { return sourceHandleSessionMatches((await readFile(path,"utf8")).split(/\r?\n/u).filter(Boolean).map(line=>JSON.parse(line)),scope); }
  catch { return false; }
}

type Kind = "span" | "evidence" | "atom" | "reference" | "reference-target" | "checkpoint";
type Role = Kind | "source";
interface Entry { handle: string; canonical_id: string; kind: Kind; roles: Role[] }
interface State { schema_version: typeof SOURCE_HANDLE_SESSION_ENTRY; scope: string; owner_root: string; entries: Entry[] }
interface Stored extends State { checksum: string }
const prefixes: Record<Kind, string> = { span: "s", evidence: "e", atom: "a", reference: "r", "reference-target": "t", checkpoint: "c" };
const shortHandleRoles: Record<Role, string> = {
  span: "span 的 sN",
  evidence: "evidence/表格行的 eN（历史 atom/evidence 别名按回条中的字段角色使用）",
  atom: "atom 的 aN（历史 atom/evidence 别名按回条中的字段角色使用）",
  reference: "引用 occurrence 的 rN",
  "reference-target": "引用 target_key 的 tN",
  checkpoint: "草稿或校验检查点的 cN",
  source: "对应来源的 sN/eN/aN/rN/tN",
};
const shortShape = /^[seartc][0-9]+$/u;
const canonicalSourceKind = (id: string): Kind | undefined =>
  /^(span|evidence|atom|reference|reference-target):\S+$/u.exec(id)?.[1] as Kind | undefined;
const roles: Role[] = ["span", "evidence", "atom", "reference", "reference-target", "checkpoint", "source"];
const object = (v: unknown): v is Record<string, any> => Boolean(v && typeof v === "object" && !Array.isArray(v));
const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v), "utf8");
const jsonPointerToken = (value: string) => value.replace(/~/gu, "~0").replace(/\//gu, "~1");

function sourceRole(key: string): Role | undefined {
  if (["draft_fingerprint", "current_draft_fingerprint", "fingerprint", "current_fingerprint", "validated_fingerprint", "validation_fingerprint", "last_valid_fingerprint", "expected_fingerprint", "actual_fingerprint"].includes(key)) return "checkpoint";
  if (key === "occurrence_id" || key === "occurrence_ids" || key.endsWith("_occurrence_id") || key.endsWith("_occurrence_ids")) return "reference";
  if (key === "target_key" || key === "target_keys" || key.endsWith("_target_key") || key.endsWith("_target_keys")) return "reference-target";
  if (key === "row_id" || key === "row_ids" || key.endsWith("_row_ids") || key.endsWith("_rows")) {
    return "evidence";
  }
  for (const kind of ["span", "evidence", "atom"] as const) {
    if (key === `${kind}_id` || key === `${kind}_ids` || key.endsWith(`_${kind}_id`) || key.endsWith(`_${kind}_ids`)) return kind;
  }
  return key === "source_id" || key === "source_ids" ? "source" : undefined;
}

export class SourceHandleError extends Error {
  constructor(public readonly code: string, public readonly details: Record<string, unknown> = {}) { super(code); }
}

/** A model-view codec only. It never edits domain IDs, quotes, selectors or receipts. */
export class ModelSourceHandles {
  readonly directory: string;
  readonly mapPath: string;
  private readonly ownerPath: string;
  private state: State;
  private byHandle = new Map<string, Entry>();
  private byCanonical = new Map<string, Entry>();
  private readonly originalSchemas = new Map<string, unknown>();
  private readonly resultPairs = new Map<string, { canonical: unknown[]; encoded: unknown[] }>();

  private constructor(public readonly ownerRoot: string, state: State) {
    this.directory = join(ownerRoot, ".model-source-handles");
    this.mapPath = join(this.directory, "map.json");
    this.ownerPath = join(this.directory, "owner.json");
    this.state = state;
    this.index();
  }
  get scope(): string { return this.state.scope; }

  static async open(root: string): Promise<ModelSourceHandles> {
    const owner = await realpath(root);
    const seed: State = { schema_version: SOURCE_HANDLE_SESSION_ENTRY, scope: randomUUID(), owner_root: owner, entries: [] };
    const codec = new ModelSourceHandles(owner, seed);
    await mkdir(codec.directory, { recursive: true });
    await codec.exclusive(async () => {
      const [hasMap, hasOwner] = await Promise.all([pathExists(codec.mapPath), pathExists(codec.ownerPath)]);
      if (hasMap !== hasOwner) throw new SourceHandleError("source_handle_map_incomplete");
      if (hasMap) await codec.reload(false);
      else {
        await atomicWriteNewText(codec.mapPath, JSON.stringify({ ...seed, checksum: sha256Json(seed) }));
        await atomicWriteNewText(codec.ownerPath, JSON.stringify({ schema_version: SOURCE_HANDLE_SESSION_ENTRY, scope: seed.scope, owner_root: owner }));
      }
    });
    return codec;
  }

  private async exclusive<T>(action: () => Promise<T>): Promise<T> {
    const lockPath = join(this.directory, "write.lock");
    let lock;
    const until = Date.now() + 5000;
    while (!lock) {
      try { lock = await open(lockPath, "wx"); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (Date.now() >= until) throw new SourceHandleError("source_handle_map_busy");
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
    try { return await action(); }
    finally { await lock.close(); await unlink(lockPath); }
  }

  private index(): void {
    this.byHandle.clear(); this.byCanonical.clear();
    const numbers: Record<Kind, number[]> = { span: [], evidence: [], atom: [], reference: [], "reference-target": [], checkpoint: [] };
    for (const entry of this.state.entries) {
      if (!object(entry) || !Object.hasOwn(prefixes, entry.kind) || typeof entry.canonical_id !== "string" || !entry.canonical_id
        || !new RegExp(`^${prefixes[entry.kind]}[1-9][0-9]*$`, "u").test(entry.handle)
        || !Array.isArray(entry.roles) || !entry.roles.length || entry.roles.some(role => !roles.includes(role))
        || this.byHandle.has(entry.handle) || this.byCanonical.has(entry.canonical_id)) throw new SourceHandleError("source_handle_map_collision_or_invalid_entry");
      this.byHandle.set(entry.handle, entry); this.byCanonical.set(entry.canonical_id, entry);
      numbers[entry.kind].push(Number(entry.handle.slice(1)));
    }
    for (const values of Object.values(numbers)) {
      values.sort((a,b) => a-b);
      if (values.some((value,index) => value !== index + 1)) throw new SourceHandleError("source_handle_map_counter_gap");
    }
  }

  private async reload(requireSameScope = true): Promise<void> {
    const stored = JSON.parse(await readFile(this.mapPath, "utf8")) as Stored;
    const pin = JSON.parse(await readFile(this.ownerPath, "utf8")) as Omit<State, "entries">;
    const { checksum, ...state } = stored;
    if (state.schema_version !== SOURCE_HANDLE_SESSION_ENTRY || pin.schema_version !== SOURCE_HANDLE_SESSION_ENTRY
      || state.owner_root !== this.ownerRoot || pin.owner_root !== this.ownerRoot) throw new SourceHandleError("source_handle_owner_mismatch");
    if (typeof state.scope !== "string" || !state.scope || state.scope !== pin.scope
      || (requireSameScope && state.scope !== this.scope)) throw new SourceHandleError("source_handle_scope_changed");
    if (sha256Json(state) !== checksum || !Array.isArray(state.entries)) throw new SourceHandleError("source_handle_map_corrupt");
    this.state = state; this.index();
  }

  private encodeId(id: string, role: Role): string {
    if (!id) return id;
    const canonicalKind = role === "checkpoint" ? (/^[a-f0-9]{64}$/u.test(id) ? "checkpoint" : undefined) : canonicalSourceKind(id);
    // Typed keys also occur in schemas and repair instructions. Descriptions,
    // placeholders and quote aliases are not source identities, even in an old map.
    if (!canonicalKind) return id;
    // Generic target_key fields may contain business keys: only reference IDs belong here.
    if ((role === "reference" || role === "reference-target") && canonicalKind !== role) return id;
    if (role === "span" && canonicalKind && canonicalKind !== "span") throw new SourceHandleError("source_handle_invalid_canonical_type");
    let entry = this.byCanonical.get(id);
    if (!entry) {
      const kind = canonicalKind;
      const next = this.state.entries.filter(e => e.kind === kind).length + 1;
      entry = { handle: `${prefixes[kind]}${next}`, canonical_id: id, kind, roles: [role] };
      this.state.entries.push(entry); this.byHandle.set(entry.handle, entry); this.byCanonical.set(id, entry);
    } else if (!entry.roles.includes(role)) entry.roles.push(role);
    return entry.handle;
  }

  private decodeId(id: string, role: Role, suppliedScope: unknown, checkRole: boolean, argumentPath: string): string {
    if (!shortShape.test(id)) return id; // Canonical IDs remain compatible with old artifacts/callers.
    if (suppliedScope === undefined) throw new SourceHandleError("source_handle_scope_required", {
      handle: id, argument_path: argumentPath, writable_path: argumentPath,
    });
    if (suppliedScope !== this.scope) throw new SourceHandleError("source_handle_scope_mismatch", { handle: id, received_scope: suppliedScope });
    const entry = this.byHandle.get(id);
    if (!entry) throw new SourceHandleError("source_handle_unknown", {
      handle: id, expected_type: role, argument_path: argumentPath, writable_path: argumentPath,
    });
    // Keep historical numbering stable, but never send an old prose mapping to
    // domain tools and then blame the model for an unknown evidence ID.
    if (!(entry.kind === "checkpoint" ? /^[a-f0-9]{64}$/u.test(entry.canonical_id) : canonicalSourceKind(entry.canonical_id))) throw new SourceHandleError("source_handle_non_source_mapping", {
      handle: id, mapped_value: entry.canonical_id,
      argument_path: argumentPath, writable_path: argumentPath,
    });
    // Some legacy manifests use the same canonical atom as an evidence record.
    // Such aliases are allowed only when actually emitted in that typed role.
    if (checkRole && role !== "source" && entry.kind !== role && !entry.roles.includes(role)) {
      throw new SourceHandleError("source_handle_wrong_type", {
        handle: id, expected_type: role, actual_type: entry.kind,
        argument_path: argumentPath, writable_path: argumentPath,
      });
    }
    return entry.canonical_id;
  }

  private walk(value: unknown, convert: (id: string, role: Role, argumentPath: string) => string, role?: Role, argumentPath = ""): unknown {
    if (typeof value === "string") return role ? convert(value, role, argumentPath) : value;
    if (Array.isArray(value)) return value.map((child, index) => this.walk(child, convert, role, `${argumentPath}/${index}`));
    if (!object(value)) return value;
    // JSON Patch values are typed by their explicit pointer, not by the generic
    // property name "value". Do not parse or replace free-text patch values.
    const patchRole = typeof value.op === "string" && typeof value.path === "string" && value.path.startsWith("/")
      ? sourceRole(value.path.split("/").filter((part:string)=>part&&!/^\d+$/u.test(part)&&part!=="-").at(-1)??"") : undefined;
    // A keyed disposition edit/read identifies a full-atom span, unlike business target/context keys.
    const keyRole = value.collection === "dispositions" ? "span"
      : value.collection === "atom_dispositions" ? "atom" : undefined;
    // Typed ID dictionaries may group lists by author field or ownership role.
    // Records with scalar text do not inherit this role into their prose fields.
    const dictionaryRole = role && Object.values(value).every(child => Array.isArray(child) || object(child)) ? role : undefined;
    return Object.fromEntries(Object.entries(value).map(([key,child]) => [
      key,
      this.walk(child, convert, key === "value" ? patchRole : key === "key" ? keyRole : sourceRole(key) ?? dictionaryRole, `${argumentPath}/${jsonPointerToken(key)}`),
    ]));
  }

  async encode(value: unknown): Promise<unknown> {
    return this.exclusive(async () => {
      await this.reload(); const before = sha256Json(this.state);
      const encoded = this.walk(value, (id,role) => this.encodeId(id,role));
      if (sha256Json(this.state) !== before) await atomicWriteJson(this.mapPath, { ...this.state, checksum: sha256Json(this.state) });
      return encoded;
    });
  }

  private decodeLoaded(value: unknown, checkRole: boolean): unknown {
    if (!object(value)) throw new SourceHandleError("source_handle_arguments_must_be_object");
    const { [SOURCE_HANDLE_SCOPE_FIELD]: scope, ...body } = value;
    if (scope !== undefined && scope !== this.scope) throw new SourceHandleError("source_handle_scope_mismatch", { received_scope: scope });
    return this.walk(body, (id,role,argumentPath) => this.decodeId(id,role,scope,checkRole,argumentPath));
  }
  async decodeArguments(value: unknown): Promise<Record<string, unknown>> {
    return this.exclusive(async () => { await this.reload(); return this.decodeLoaded(value,true) as Record<string,unknown>; });
  }
  async decodeResponse(value: unknown): Promise<unknown> {
    return this.exclusive(async () => { await this.reload(); return this.decodeLoaded(value,false); });
  }

  private schema(value: any, role?: Role): any {
    if (Array.isArray(value)) return value.map(child => this.schema(child,role));
    if (!object(value)) return value;
    if (role && value.type === "string" && (value.pattern || value.minLength || value.const !== undefined || value.enum)) {
      // Field meaning applies to both wire formats, not only the canonical-ID branch.
      const canonical = Object.create(Object.getPrototypeOf(value), Object.getOwnPropertyDescriptors(value));
      delete canonical.description;
      return Type.Union([canonical, Type.String({
        pattern: role === "checkpoint" ? "^c[1-9][0-9]*$" : "^[seart][1-9][0-9]*$",
        description: `复制当前工具回条中${shortHandleRoles[role]}句柄，并带回条的 source_handle_scope；不得自己编编号。`,
      })], typeof value.description === "string" ? { description: value.description } : {});
    }
    // TypeBox's non-enumerable kind/optional markers must survive schema edits.
    const result = Object.create(Object.getPrototypeOf(value),Object.getOwnPropertyDescriptors(value));
    for (const [key,child] of Object.entries(value)) {
      result[key] = key === "properties" && object(child)
        ? Object.fromEntries(Object.entries(child).map(([name,schema]) => [name,this.schema(schema,sourceRole(name))]))
        : this.schema(child,role);
    }
    return result;
  }

  wrapTools(tools: ToolDefinition[]): ToolDefinition[] {
    const ajv = new Ajv({ allErrors: true, strict: false });
    const availableToolNames = new Set(tools.map(tool => tool.name));
    return tools.map(tool => {
      const original = tool.parameters;
      const parameters = this.schema(original);
      if (parameters.type !== "object" || !object(parameters.properties) || Object.hasOwn(parameters.properties,SOURCE_HANDLE_SCOPE_FIELD)) {
        throw new SourceHandleError("source_handle_unsupported_tool_schema", { tool_name: tool.name });
      }
      // Keep this schema session-stable: a per-session UUID Literal would unique the
      // tools[] prefix and prevent Chat Completions from sharing prompt cache across targets.
      parameters.properties = {
        [SOURCE_HANDLE_SCOPE_FIELD]: Type.Optional(Type.String({
          minLength: 1,
          description: "复制当前工具回条中的 source_handle_scope，不得编造或复用其他会话的 scope。",
        })),
        ...parameters.properties,
      };
      const validate = ajv.compile(original);
      this.originalSchemas.set(tool.name, original);
      return withToolArgumentFeedback({
        ...tool, parameters,
        execute: async (...args: Parameters<typeof tool.execute>) => {
          let decoded: Record<string,unknown>;
          try {
            decoded = await this.decodeArguments(args[1]);
            if (!validate(decoded)) throw new SourceHandleError("source_handle_decoded_arguments_invalid", { issues: validate.errors });
          } catch (error) {
            if (!(error instanceof SourceHandleError)) throw error;
            const missingScope = error.code === "source_handle_scope_required";
            const mismatchedScope = error.code === "source_handle_scope_mismatch";
            const wrongType = error.code === "source_handle_wrong_type";
            const nonSourceMapping = error.code === "source_handle_non_source_mapping";
            const directoryTool = ["list_evidence_resources", "get_target_context"].find(name => availableToolNames.has(name));
            const scopeMismatch = error.code === "source_handle_scope_mismatch";
            const unknownHandle = error.code === "source_handle_unknown";
            const sourceArguments: Array<{ argument_path: string; expected_type: Role }> = [];
            if (scopeMismatch) this.walk(args[1], (id, role, path) => {
              if (shortShape.test(id) || canonicalSourceKind(id)) sourceArguments.push({ argument_path: path, expected_type: role });
              return id;
            });
            const scopeLabelOnly = scopeMismatch && sourceArguments.length === 0;
            const listedSourceArguments: typeof sourceArguments = [];
            for (const argument of sourceArguments) {
              if (listedSourceArguments.length === 64 || bytes([...listedSourceArguments, argument]) > 8192) break;
              listedSourceArguments.push(argument);
            }
            const readCandidates = sourceArguments.some(argument => argument.expected_type === "reference" || argument.expected_type === "reference-target")
              || (unknownHandle && ["reference", "reference-target"].includes(String(error.details.expected_type)))
              ? ["list_reference_occurrences", "list_evidence_resources", "get_target_context", "list_document_atoms"]
              : ["list_evidence_resources", "get_target_context", "list_reference_occurrences", "list_document_atoms"];
            if (sourceArguments.length > 0 && sourceArguments.every(argument => argument.expected_type === "checkpoint")) {
              readCandidates.push("read_target_selectors");
            }
            const directoryReadTool = scopeMismatch || unknownHandle ? readCandidates.find(name => {
              const schema = this.originalSchemas.get(name);
              return availableToolNames.has(name) && schema !== undefined && ajv.compile(schema as any)({});
            }) : undefined;
            const argumentPath = typeof error.details.argument_path === "string" ? error.details.argument_path : undefined;
            // Route the failing field, not any unrelated checkpoint in the same edit.
            // Scope mismatches must retain the full typed-source reread instructions.
            const failedArgumentField = argumentPath?.split("/").filter(part => part && !/^\d+$/u.test(part)).at(-1);
            const checkpointArgument = !scopeMismatch && (error.details.expected_type === "checkpoint"
              || (failedArgumentField !== undefined && sourceRole(failedArgumentField) === "checkpoint"));
            const checkpointReadTool = checkpointArgument
              ? ["read_target_selectors", "get_target_context"].find(name => availableToolNames.has(name)) : undefined;
            const canReadEvidenceForSpan = wrongType
              && error.details.expected_type === "span"
              && typeof error.details.handle === "string"
              && (error.details.actual_type === "evidence" || this.byHandle.get(error.details.handle)?.roles.includes("evidence"))
              && availableToolNames.has("open_evidence");
            const details = { ok: false, error: error.code, ...error.details,
              ...(nonSourceMapping ? {
                actual: "旧工具回条把非来源说明文字登记成了短句柄；这不是模型编造来源",
                ...(directoryTool ? { next_tool: directoryTool, tool_arguments: {} } : {}),
                retry_tool: tool.name,
                required_action: "重新读取来源目录，按实际来源选择有效句柄，只替换 writable_path 后重试；不得猜测句柄或修改业务语义。",
                do_not_edit: "保留其余业务参数、不可变原文和既有句柄编号；本次工具尚未执行",
              } : {}),
              ...(missingScope ? {
                actual: "提交了短来源句柄，但工具参数顶层缺少 source_handle_scope",
                writable_path: `/${SOURCE_HANDLE_SCOPE_FIELD}`,
                required_argument: { [SOURCE_HANDLE_SCOPE_FIELD]: this.scope },
                next_tool: tool.name,
                do_not_edit: "保留本次其余参数、来源句柄和原文，不改业务字段；本次工具尚未执行",
              } : {}),
              ...(scopeMismatch ? {
                expected_scope: this.scope,
                actual: { received_scope: error.details.received_scope, current_scope: this.scope },
                expected: scopeLabelOnly
                  ? "当前请求没有待重读的 typed handle；仅修正 scope 参数或删除这个可选参数，并保留其他参数；重试仍执行全部参数与来源校验"
                  : "当前 typed handles 必须按不可变来源身份重新读取确认，不能只改 scope",
                source_arguments_to_reread: listedSourceArguments,
                source_argument_count: sourceArguments.length, source_arguments_complete: listedSourceArguments.length === sourceArguments.length,
                writable_paths: [`/${SOURCE_HANDLE_SCOPE_FIELD}`, ...listedSourceArguments.map(argument => argument.argument_path)],
                ...(scopeLabelOnly ? { next_tool: tool.name, required_argument: { [SOURCE_HANDLE_SCOPE_FIELD]: this.scope },
                  alternative_repair: { remove_argument_path: `/${SOURCE_HANDLE_SCOPE_FIELD}`,
                    precondition: { source_argument_count: 0, source_arguments_complete: true }, retry_tool: tool.name } }
                  : directoryReadTool ? { next_tool: directoryReadTool, next_tool_arguments: {}, tool_arguments: {} } : {}),
                retry_tool: tool.name, durable_mutation: false, original_tool_executed: false, budget_consumed: false,
                required_action: scopeLabelOnly ? "correct_scope_argument_without_rebinding_handles" : "reread_current_typed_handles_before_retry",
                do_not_edit: scopeLabelOnly
                  ? "除 source_handle_scope 外，保留原业务意图、operation、collection、remove_keys 和其余字段；本次调用全部未执行，不需要替换来源、重写业务记录或改动句柄映射"
                  : "保留原业务意图、operation、collection、remove_keys 和其余字段；本次调用全部未执行，不能把旧句柄直接重标为新 scope",
              } : {}),
              ...(unknownHandle ? {
                actual: { handle: error.details.handle, registered_in_current_scope: false },
                expected: "该参数需要当前 scope 已登记、且允许用于 expected_type 的真实来源句柄",
                ...(directoryReadTool ? { next_tool: directoryReadTool, next_tool_arguments: {}, tool_arguments: {} } : {}),
                retry_tool: tool.name, original_tool_executed: false, durable_mutation: false, budget_consumed: false,
                required_action: "read_current_source_directory_and_confirm_typed_identity_before_retry",
                do_not_edit: "保留原业务意图、operation、collection、remove_keys 和其余参数；整次调用未执行，不存在部分保存。只替换 writable_path 指向的无效句柄，不能猜编号或改写原文",
              } : {}),
              ...(checkpointReadTool && !missingScope ? {
                next_tool: checkpointReadTool, tool_arguments: {}, retry_tool: tool.name,
                required_action: `调用 ${checkpointReadTool}，tool_arguments={}，不带旧 scope 或句柄；从当前回条取得草稿/校验检查点及 source_handle_scope，核对后只替换检查点参数再重试。`,
                do_not_edit: "工具尚未执行；保留已保存草稿及原业务意图。短检查点映射精确 SHA-256，过期检查点仍会被原校验拒绝。",
              } : {}),
              ...(wrongType && !checkpointReadTool ? {
                required_action: canReadEvidenceForSpan
                  ? `先按 tool_arguments 调用 open_evidence；从其回条选择符合原业务意图的 span 句柄，只替换 ${argumentPath ?? "argument_path"} 后重试原工具。`
                  : `只替换 ${argumentPath ?? "argument_path"} 中类型错误的句柄，保留其余业务参数后重试原工具。`,
                next_tool: canReadEvidenceForSpan ? "open_evidence" : tool.name,
                ...(canReadEvidenceForSpan ? {
                  tool_arguments: {
                    evidence_id: error.details.handle,
                    [SOURCE_HANDLE_SCOPE_FIELD]: this.scope,
                  },
                } : {}),
                retry_tool: tool.name,
                do_not_edit: "除 writable_path 指向的句柄外，不改本次其余业务参数、不可变原文或已保存记录；本次工具尚未执行",
              } : {}),
              instruction: nonSourceMapping
                ? "当前句柄指向历史 harness 误登记的说明文字，不是来源 ID。本次工具未执行；先读取当前来源目录取得有效句柄，再只替换 writable_path 指向的参数并重试 retry_tool。不要把 mapped_value 当成来源，也不要重写其他业务字段。"
                : missingScope
                ? `在本次 ${tool.name} 参数对象的顶层添加 source_handle_scope（取 required_argument 中的原值），保留其他参数后重试同一工具；不要放进 draft、item 或 quote_bindings。此错误尚未检查业务内容，不要因此重写项目。`
                : checkpointReadTool
                  ? "按 required_action 重新读取当前检查点，保留草稿与原参数；不得猜测短检查点或手工补写 SHA-256。"
                : error.code === "source_handle_scope_mismatch"
                  ? scopeLabelOnly
                    ? "本次工具未执行。当前请求没有待重读的 typed handle；保留原参数，仅修正顶层 source_handle_scope 为 required_argument 中的原值；或者按 alternative_repair 删除这个可选参数。只选一种方式重试 retry_tool。这个删除方式仅适用于 source_argument_count=0 且 source_arguments_complete=true 的当前请求，不能用于含来源句柄的请求。不能因此替换来源、重写作者记录、重放已成功的其他操作或修改句柄映射；本次未执行的 operation、collection、remove_keys 及其他字段须完整保留。重试仍执行全部参数、来源和业务校验，本回条不证明任务已完成。"
                    : "本次工具未执行。" + (directoryReadTool
                    ? "按 next_tool_arguments 读取当前会话来源目录/证据，按不可变来源身份核对并取得当前 typed handles。"
                    : "本工具集合没有可执行的当前来源目录入口，不能在这里纠正来源句柄；保留意图，在具备当前来源读取工具的合法恢复入口重读，不调用未提供的工具。")
                    + "不得只给旧句柄替换 source_handle_scope。保留原业务编辑意图，包括未执行的 operation、collection、remove_keys；只替换经重新读取确认的来源句柄后重试 retry_tool。source_arguments_complete=false 时，未列出的 typed handles 也需核对。"
                : unknownHandle
                  ? "整次调用未执行，没有部分保存。" + (directoryReadTool
                    ? "按 next_tool_arguments 读取当前来源目录；目录只提供导航，不替你选择来源或登记 span。依据原业务意图确认来源后，按其允许的读取/定位工具取得 expected_type 的实际句柄。"
                    : "本工具集合没有可执行的当前来源目录入口；保留原业务意图，在具备来源读取工具的合法恢复入口核对，不调用未提供的工具。")
                    + "只替换 writable_path 指向的无效句柄，再完整重试 retry_tool；保留其余参数。不要猜编号、借用其他 scope 或把 atom/evidence 当成 span。"
                : wrongType
                  ? canReadEvidenceForSpan
                    ? `参数 ${argumentPath ?? "argument_path"} 需要 span 句柄，当前句柄已在 evidence 角色返回过，但不是 span。按 tool_arguments 打开该 evidence，遵守其实际访问回条；仅从回条选择符合原业务意图的 span。若正文窗口未返回所需 span，使用当前可用定位工具按已读原文登记作者选择的片段；工具不会替你选择 span。然后只替换 writable_path，保留其余参数并重试 retry_tool。`
                    : `参数 ${argumentPath ?? "argument_path"} 的句柄类型错误。只替换 writable_path 指向的句柄，保留其余参数并重试 retry_tool；禁止猜测、截断、规范化或借用其他 scope 的句柄。`
                  : "按 argument_path 定位无效句柄，从当前工具回条或重新读取的来源中取得同类型句柄；只替换 writable_path，禁止猜测、截断、规范化或借用其他 scope 的句柄。",
            };
            return { content: [{ type: "text" as const, text: JSON.stringify({ ...details, [SOURCE_HANDLE_SCOPE_FIELD]: this.scope }) }], details };
          }
          const result = await tool.execute.apply(tool,[args[0],decoded,...args.slice(2)] as Parameters<typeof tool.execute>);
          const content = [] as typeof result.content;
          for (const block of result.content) {
            if (block.type !== "text") { content.push(block); continue; }
            let value: unknown;
            try { value = JSON.parse(block.text); } catch { content.push(block); continue; }
            if (!object(value) && !Array.isArray(value)) { content.push(block); continue; }
            if (object(value) && Object.hasOwn(value,SOURCE_HANDLE_SCOPE_FIELD)) throw new SourceHandleError("source_handle_reserved_field_collision");
            const encoded = await this.encode(value);
            content.push({ type: "text", text: JSON.stringify(object(encoded) ? { ...encoded, [SOURCE_HANDLE_SCOPE_FIELD]: this.scope } : encoded) });
            if (Array.isArray(encoded)) content.push({ type: "text", text: JSON.stringify({ [SOURCE_HANDLE_SCOPE_FIELD]: this.scope }) });
          }
          this.resultPairs.set(args[0], { canonical: result.content, encoded: content });
          // details are internal harness data. Only content is sent to the model.
          return { ...result, content };
        },
      } as ToolDefinition, ajv.compile(parameters));
    });
  }

  /** Compare the actual outgoing request with the same structured data using canonical IDs. */
  measureProviderPayload(payload: Record<string, unknown>): Record<string, unknown> {
    if (!Array.isArray(payload.messages) || !Array.isArray(payload.tools)
      || !payload.tools.some(tool => object(tool) && object(tool.function))) {
      return { source_handle_scope: this.scope, actual_request_utf8_bytes: bytes(payload), comparison: "Canonical request comparison is only available for the Chat Completions payload shape." };
    }
    const baseline = structuredClone(payload) as Record<string,any>;
    let comparedResults = 0, comparedCalls = 0, unresolved = 0;
    for (const message of baseline.messages ?? []) {
      if (message.role === "system" && typeof message.content === "string") message.content = message.content.replace(`\n\n${SOURCE_HANDLE_INSTRUCTION}`, "");
      if (message.role === "tool" && typeof message.content === "string") {
        const pair = this.resultPairs.get(message.tool_call_id);
        if (pair && pair.canonical.every((block:any) => block.type === "text")) {
          message.content = pair.canonical.map((block:any) => block.text).join("\n"); comparedResults++;
        } else {
          try { const parsed = JSON.parse(message.content); if (parsed[SOURCE_HANDLE_SCOPE_FIELD] === this.scope) { message.content = JSON.stringify(this.decodeLoaded(parsed,false)); comparedResults++; } } catch { unresolved++; }
        }
      }
      for (const call of message.tool_calls ?? []) {
        if (typeof call.function?.arguments !== "string") continue;
        try { const parsed = JSON.parse(call.function.arguments); if (parsed[SOURCE_HANDLE_SCOPE_FIELD] === this.scope) { call.function.arguments = JSON.stringify(this.decodeLoaded(parsed,true)); comparedCalls++; } } catch { unresolved++; }
      }
    }
    for (const tool of baseline.tools ?? []) {
      const fn = tool.function ?? tool;
      if (this.originalSchemas.has(fn.name)) fn.parameters = this.originalSchemas.get(fn.name);
    }
    const actualBytes = bytes(payload), canonicalBytes = bytes(baseline);
    return { source_handle_scope: this.scope, actual_request_utf8_bytes: actualBytes, canonical_equivalent_request_utf8_bytes: canonicalBytes,
      source_handle_saved_request_bytes: canonicalBytes-actualBytes, compared_tool_results: comparedResults, compared_tool_calls: comparedCalls, unpaired_content_blocks: unresolved,
      comparison: "same outgoing request; typed source IDs restored and codec-only scope/schema/instruction overhead removed; source text unchanged" };
  }
}
