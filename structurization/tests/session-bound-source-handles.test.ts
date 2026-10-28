import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { defineTool, SessionManager, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Ajv } from "ajv";
import { ModelSourceHandles, SOURCE_HANDLE_BOUND_CONTRACT, SOURCE_HANDLE_SESSION_ENTRY,
  sourceHandleSessionFileMatches, sourceHandleSessionMatches } from "../src/model-source-handles.js";
import { terminalToolFailure } from "../src/pi-runtime.js";
import { protocolTargetFailure } from "../src/attempt-budget.js";

const roots: string[] = [];
const evidence = "evidence:neutral-a", span = "span:neutral-a";
async function fresh() {
  const root = await mkdtemp(join(tmpdir(), "pi-bound-sources-")); roots.push(root);
  const codec = await ModelSourceHandles.open(root), session = SessionManager.inMemory(root);
  session.appendCustomEntry(SOURCE_HANDLE_SESSION_ENTRY, { scope: codec.scope, tool_contract: SOURCE_HANDLE_BOUND_CONTRACT });
  return { root, codec, session };
}
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
const invoke = (tool: ToolDefinition, args: unknown, id = "neutral-call") => tool.execute(id, args as any, undefined as any, undefined as any, undefined as any);
const visible = (result: Awaited<ReturnType<typeof invoke>>) => JSON.parse((result.content[0] as { text: string }).text);
function probe(execute = vi.fn(async (_id: string, args: any) => ({ content: [{ type: "text" as const, text: JSON.stringify(args) }], details: args }))) {
  return defineTool({ name: "open_evidence", label: "Read", description: "Neutral source read",
    parameters: Type.Object({ evidence_id: Type.String({ pattern: "^evidence:" }) }, { additionalProperties: false }), execute });
}

describe("session-bound source identity", () => {
  test("a verified session accepts short IDs without a UUID and preserves the canonical map", async () => {
    const { codec, session } = await fresh(); await codec.encode({ evidence_id: evidence });
    const before = await readFile(codec.mapPath, "utf8"), original = probe();
    const [tool] = await codec.wrapSessionTools([original], session);
    const schema = JSON.stringify(tool!.parameters);
    expect((tool!.parameters as any).properties).not.toHaveProperty("source_handle_scope");
    expect(schema).not.toContain(codec.scope);
    const args = { evidence_id: "e1" }, result = await invoke(tool!, args);
    expect(original.execute).toHaveBeenCalledWith("neutral-call", { evidence_id: evidence }, undefined, undefined, undefined);
    expect(visible(result)).toEqual(args); expect(result.details).toEqual({ evidence_id: evidence });
    expect(JSON.stringify(result.content)).not.toContain(codec.scope);
    expect(await readFile(codec.mapPath, "utf8")).toBe(before);
    expect(args).toEqual({ evidence_id: "e1" });
    // External/legacy decoding still requires explicit ownership proof.
    await expect(codec.decodeArguments(args)).rejects.toMatchObject({ code: "source_handle_scope_required" });
  });

  test("two targets can both have e1 without binding either to the other target's session", async () => {
    const a = await fresh(), b = await fresh();
    await a.codec.encode({ evidence_id: evidence }); await b.codec.encode({ evidence_id: "evidence:neutral-b" });
    const left = probe(), right = probe();
    const [aTool] = await a.codec.wrapSessionTools([left], a.session);
    const [bTool] = await b.codec.wrapSessionTools([right], b.session);
    await invoke(aTool!, { evidence_id: "e1" }); await invoke(bTool!, { evidence_id: "e1" });
    expect((left.execute as any).mock.calls[0][1]).toEqual({ evidence_id: evidence });
    expect((right.execute as any).mock.calls[0][1]).toEqual({ evidence_id: "evidence:neutral-b" });
    await expect(a.codec.wrapSessionTools([left], b.session)).rejects.toMatchObject({ code: "source_handle_session_binding_invalid" });
    // Matching marker alone cannot override a different workspace owner.
    const foreign = SessionManager.inMemory(b.root);
    foreign.appendCustomEntry(SOURCE_HANDLE_SESSION_ENTRY, { scope: a.codec.scope, tool_contract: SOURCE_HANDLE_BOUND_CONTRACT });
    const reopened = await ModelSourceHandles.open(a.root);
    await expect(reopened.wrapSessionTools([probe()], foreign)).rejects.toMatchObject({ code: "source_handle_session_binding_invalid" });
  });

  test.each(["missing", "legacy", "wrong-contract", "mixed-scope"])("%s provider history cannot be rebound", async mode => {
    const { root, codec } = await fresh(), session = SessionManager.inMemory(root);
    if (mode !== "missing") session.appendCustomEntry(SOURCE_HANDLE_SESSION_ENTRY, {
      scope: codec.scope, ...(mode === "legacy" ? {} : { tool_contract: mode === "wrong-contract" ? "other/v1" : SOURCE_HANDLE_BOUND_CONTRACT }),
    });
    if (mode === "mixed-scope") session.appendCustomEntry(SOURCE_HANDLE_SESSION_ENTRY, { scope: "foreign", tool_contract: SOURCE_HANDLE_BOUND_CONTRACT });
    expect(sourceHandleSessionMatches(session.getEntries(), codec.scope, SOURCE_HANDLE_BOUND_CONTRACT)).toBe(false);
    await expect(codec.wrapSessionTools([probe()], session)).rejects.toMatchObject({ code: "source_handle_session_binding_invalid" });
  });

  test("legacy session bytes remain intact while a fresh provider session resumes the same map", async () => {
    const { root, codec } = await fresh(); await codec.encode({ evidence_id: evidence });
    const old = SessionManager.inMemory(root);
    old.appendCustomEntry(SOURCE_HANDLE_SESSION_ENTRY, { scope: codec.scope });
    const file = join(root, "legacy.jsonl"), history = old.getEntries().map(e => JSON.stringify(e)).join("\n");
    await writeFile(file, history); const map = await readFile(codec.mapPath, "utf8");
    expect(await sourceHandleSessionFileMatches(file, codec.scope)).toBe(true);
    expect(await sourceHandleSessionFileMatches(file, codec.scope, SOURCE_HANDLE_BOUND_CONTRACT)).toBe(false);
    const next = SessionManager.inMemory(root);
    next.appendCustomEntry(SOURCE_HANDLE_SESSION_ENTRY, { scope: codec.scope, tool_contract: SOURCE_HANDLE_BOUND_CONTRACT });
    const [tool] = await codec.wrapSessionTools([probe()], next); await invoke(tool!, { evidence_id: "e1" });
    expect(await readFile(file, "utf8")).toBe(history); expect(await readFile(codec.mapPath, "utf8")).toBe(map);
  });

  test.each(["session-marker", "map-owner"])("invalid %s after binding terminates before a domain call", async mode => {
    const { codec, session } = await fresh(); await codec.encode({ evidence_id: evidence });
    const original = probe(), [tool] = await codec.wrapSessionTools([original], session);
    if (mode === "session-marker") session.appendCustomEntry(SOURCE_HANDLE_SESSION_ENTRY, { scope: "foreign", tool_contract: SOURCE_HANDLE_BOUND_CONTRACT });
    else {
      const map = JSON.parse(await readFile(codec.mapPath, "utf8")); map.owner_root = "another-owner";
      await writeFile(codec.mapPath, JSON.stringify(map));
    }
    const result = await invoke(tool!, { evidence_id: "e1" });
    expect(result.details).toMatchObject({ error: "source_handle_session_binding_invalid", terminal: true,
      original_tool_executed: false, writable_paths: [], retryable: false });
    expect(terminalToolFailure(result.details)).toEqual({ error: "source_handle_session_binding_invalid", failure_class: "coverage_harness_defect" });
    expect(protocolTargetFailure("source_handle_session_binding_invalid")).toEqual({ failure_class: "coverage_harness_defect", retryable: false });
    expect(original.execute).not.toHaveBeenCalled();
  });

  test("wrong type and unknown IDs retain actionable, scopeless repair routes", async () => {
    const { codec, session } = await fresh(); await codec.encode({ evidence_id: evidence, span_id: span });
    const execute = vi.fn(async (_id: string, args: any) => ({ content: [], details: args }));
    const edit = defineTool({ name: "stage_probe", label: "Edit", description: "Neutral author edit",
      parameters: Type.Object({ span_ids: Type.Array(Type.String()) }, { additionalProperties: false }), execute });
    const directory = defineTool({ name: "list_evidence_resources", label: "Directory", description: "Neutral directory",
      parameters: Type.Object({}, { additionalProperties: false }), execute });
    const [tool, read, list] = await codec.wrapSessionTools([edit, probe(), directory], session);
    const rejected = visible(await invoke(tool!, { span_ids: ["e1"] }));
    expect(rejected).toMatchObject({ error: "source_handle_wrong_type", argument_path: "/span_ids/0",
      next_tool: "open_evidence", tool_arguments: { evidence_id: "e1" } });
    expect(new Ajv({ strict: false }).compile(read!.parameters)(rejected.tool_arguments)).toBe(true);
    expect(JSON.stringify(rejected)).not.toContain(codec.scope);
    const unknown = visible(await invoke(tool!, { span_ids: ["s999"] }));
    expect(unknown).toMatchObject({ error: "source_handle_unknown", next_tool: "list_evidence_resources", next_tool_arguments: {} });
    expect(new Ajv({ strict: false }).compile(list!.parameters)(unknown.next_tool_arguments)).toBe(true);
    expect(execute).not.toHaveBeenCalled();
    await invoke(tool!, { span_ids: ["s1"] }); expect(execute).toHaveBeenCalledOnce();
  });

  test("checkpoint validity stays with the domain validator and stale fingerprints are never rewritten", async () => {
    const { codec, session } = await fresh(); const stale = "a".repeat(64), current = "b".repeat(64);
    await codec.encode({ draft_fingerprint: stale });
    const edit = defineTool({ name: "stage_probe", label: "Edit", description: "Neutral checkpoint edit",
      parameters: Type.Object({ draft_fingerprint: Type.String({ pattern: "^[a-f0-9]{64}$" }) }),
      execute: async (_id, args) => ({ content: [], details: { ok: args.draft_fingerprint === current,
        error: "draft_fingerprint_mismatch", actual: args.draft_fingerprint, expected: current } }) });
    const [tool] = await codec.wrapSessionTools([edit], session);
    expect((await invoke(tool!, { draft_fingerprint: "c1" })).details).toMatchObject({ ok: false, actual: stale, expected: current });
  });

  test("legacy scope arguments are rejected rather than silently relabelled", async () => {
    const { codec, session } = await fresh(); await codec.encode({ evidence_id: evidence });
    const original = probe(), [tool] = await codec.wrapSessionTools([original], session);
    const args = { evidence_id: "e1", source_handle_scope: "foreign" };
    expect(new Ajv({ strict: false }).compile(tool!.parameters)(args)).toBe(false);
    expect((await invoke(tool!, args)).details).toMatchObject({ error: "source_handle_legacy_scope_argument",
      writable_path: "/source_handle_scope", original_tool_executed: false });
    expect(original.execute).not.toHaveBeenCalled();
  });

  test("array replies and telemetry restore canonical IDs without altering quotes or exposing scope", async () => {
    const { codec, session } = await fresh(); const text = "原文 e1 与 s1 都是文字，不改写。";
    const original = probe(vi.fn(async () => ({ content: [{ type: "text" as const, text: JSON.stringify([{ evidence_id: evidence, text }]) }], details: {} })));
    await codec.encode({ evidence_id: evidence });
    const [tool] = await codec.wrapSessionTools([original], session), result = await invoke(tool!, { evidence_id: "e1" }, "read-call");
    expect(result.content).toHaveLength(1); expect(visible(result)).toEqual([{ evidence_id: "e1", text }]);
    const payload = { messages: [{ role: "assistant", tool_calls: [{ function: { name: tool!.name, arguments: JSON.stringify({ evidence_id: "e1" }) } }] },
      { role: "tool", tool_call_id: "read-call", content: (result.content[0] as any).text }], tools: [{ type: "function", function: { name: tool!.name, parameters: tool!.parameters } }] };
    const before = structuredClone(payload), metrics = codec.measureProviderPayload(payload);
    expect(metrics).toMatchObject({ compared_tool_calls: 1, compared_tool_results: 1, unpaired_content_blocks: 0 });
    expect(payload).toEqual(before); expect(JSON.stringify(payload)).not.toContain(codec.scope);
  });
});
