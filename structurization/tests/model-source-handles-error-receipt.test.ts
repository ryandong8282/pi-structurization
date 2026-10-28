import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import { ModelSourceHandles } from "../src/model-source-handles.js";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { sha256Json } from "../src/canonical.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

describe("model source handles in error receipts", () => {
  test.each(["list_evidence_resources", "get_target_context"])("scope mismatch offers executable bootstrap through %s without relabeling stale handles", async (directoryName) => {
    const root = await mkdtemp(join(tmpdir(), "pi-scope-bootstrap-"));
    roots.push(root);
    const codec = await ModelSourceHandles.open(root);
    const mutate = vi.fn(async () => ({ content: [] }));
    const read = vi.fn(async (_id: string, _args: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify({ evidence_id: "evidence:neutral-current" }) }] }));
    const [writeTool, directory] = codec.wrapTools([
      defineTool({ name: "stage_probe", label: "Stage", description: "Neutral mutation",
        parameters: Type.Object({ evidence_id: Type.String(), operation: Type.String() }), execute: mutate }),
      defineTool({ name: directoryName, label: "List", description: "Read current source identities",
        parameters: Type.Object({}, { additionalProperties: false }), execute: read }),
    ]);
    const args = { evidence_id: "e1", operation: "upsert", source_handle_scope: "different-session" };
    const rejected = await writeTool!.execute("stale", args, undefined as any, undefined as any, undefined as any);
    const receipt = JSON.parse((rejected.content[0] as any).text);
    expect(receipt).toMatchObject({ error: "source_handle_scope_mismatch", received_scope: "different-session",
      expected_scope: codec.scope, next_tool: directoryName, tool_arguments: {}, retry_tool: "stage_probe" });
    expect(receipt).not.toHaveProperty("required_argument");
    expect(mutate).not.toHaveBeenCalled();
    expect(args).toEqual({ evidence_id: "e1", operation: "upsert", source_handle_scope: "different-session" });
    const restored = await directory!.execute("bootstrap", receipt.tool_arguments, undefined as any, undefined as any, undefined as any);
    expect(read.mock.calls[0]?.[1]).toEqual({});
    expect(JSON.parse((restored.content[0] as any).text)).toMatchObject({ evidence_id: "e1", source_handle_scope: codec.scope });
    // Bootstrap reads do not weaken stale-scope validation on later mutations.
    await writeTool!.execute("still-stale", args, undefined as any, undefined as any, undefined as any);
    expect(mutate).not.toHaveBeenCalled();
  });

  test("old prose mappings are rejected actionably without renumbering valid handles", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-source-handle-old-hints-"));
    roots.push(root);
    const codec = await ModelSourceHandles.open(root);
    await codec.encode({ evidence_id: "evidence:first" });
    const { checksum: _checksum, ...state } = JSON.parse(await readFile(codec.mapPath, "utf8"));
    const prose = "选择已打开来源的 evidence_id";
    state.entries.push({ handle: "e2", canonical_id: prose, kind: "evidence", roles: ["evidence"] });
    await writeFile(codec.mapPath, JSON.stringify({ ...state, checksum: sha256Json(state) }));
    const reopened = await ModelSourceHandles.open(root);
    const before = await readFile(codec.mapPath, "utf8");
    expect(await reopened.encode({ evidence_id: prose })).toEqual({ evidence_id: prose });
    const execute = vi.fn(async () => ({ content: [] }));
    const [read] = reopened.wrapTools([
      defineTool({ name: "open_evidence", label: "Read", description: "Read evidence",
        parameters: Type.Object({ evidence_id: Type.String() }), execute }),
      defineTool({ name: "list_evidence_resources", label: "List", description: "List sources",
        parameters: Type.Object({}), execute }),
    ]);
    const rejected = await read!.execute("old-hint", { evidence_id: "e2", source_handle_scope: reopened.scope },
      undefined as any, undefined as any, undefined as any);
    expect(JSON.parse((rejected.content[0] as any).text)).toMatchObject({
      ok: false, error: "source_handle_non_source_mapping", handle: "e2", mapped_value: prose,
      writable_path: "/evidence_id", next_tool: "list_evidence_resources", tool_arguments: {},
      retry_tool: "open_evidence", instruction: expect.stringContaining("历史 harness"),
    });
    expect(execute).not.toHaveBeenCalled();
    expect(await readFile(codec.mapPath, "utf8")).toBe(before);
    expect(await reopened.decodeArguments({ evidence_id: "e1", source_handle_scope: reopened.scope }))
      .toEqual({ evidence_id: "evidence:first" });
    expect(await reopened.encode({ evidence_id: "evidence:next" })).toEqual({ evidence_id: "e3" });
  });

  test("model-visible hints and schemas never mint handles for descriptive text", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-source-handle-hints-"));
    roots.push(root);
    const codec = await ModelSourceHandles.open(root);
    const source = { evidence_id: "evidence:neutral-source", span_id: "span:neutral-span" };
    const prose = "来自已打开原文的 evidence_id";
    const response = {
      ok: false, actual: source,
      source_disposition_schema: { span_ids: "已登记 span_id 的非空数组" },
      tool_argument_hints: {
        locate_evidence_span: { evidence_id: prose, quote: "模型选择的精确原文" },
        stage_target_selector_draft: { draft: { source_dispositions: [{
          span_ids: ["从 actual.candidate_spans 选择"],
        }] } },
      },
      examples: { atom_id: "<atom_id>", row_ids: ["choose a returned row", "$source_alias"],
        span_id: "span: followed by explanatory text", evidence_id: "evidence:" },
    };
    const [tool] = codec.wrapTools([defineTool({
      name: "read_probe", label: "Read", description: "Neutral diagnostic receipt",
      parameters: Type.Object({}),
      execute: async () => ({ content: [{ type: "text", text: JSON.stringify(response) }], details: response }),
    })]);
    const result = await tool!.execute("receipt", {}, undefined as any, undefined as any, undefined as any);
    const visible = JSON.parse((result.content[0] as any).text);
    expect(visible).toMatchObject({ ...response, actual: { evidence_id: "e1", span_id: "s1" } });
    expect(result.details).toEqual(response);
    const stored = JSON.parse(await readFile(codec.mapPath, "utf8"));
    expect(stored.entries.map((entry: any) => entry.canonical_id).sort())
      .toEqual(Object.values(source).sort());
    expect(await codec.decodeResponse(visible)).toEqual(response);
    // Reopening must not register the same prose or advance source counters.
    const reopened = await ModelSourceHandles.open(root);
    const before = await readFile(codec.mapPath, "utf8");
    expect(await reopened.encode(response.tool_argument_hints)).toEqual(response.tool_argument_hints);
    expect(await readFile(codec.mapPath, "utf8")).toBe(before);
    expect(await reopened.encode({ evidence_id: "evidence:next-source" })).toEqual({ evidence_id: "e2" });
  });

  test("does not treat a rejected target_key received_value as a typed source identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-source-handle-error-"));
    roots.push(root);
    const codec = await ModelSourceHandles.open(root);
    const knownTarget = `reference-target:${"a".repeat(64)}`;
    const receivedInvalidTarget = `reference-target:${"b".repeat(64)}`;

    expect(await codec.encode({ target_key: knownTarget })).toEqual({ target_key: "t1" });
    const before = await readFile(codec.mapPath, "utf8");

    expect(await codec.encode({
      ok: false,
      error: "reference_target_not_found",
      parameter: "target_key",
      received_value: receivedInvalidTarget,
    })).toEqual({
      ok: false,
      error: "reference_target_not_found",
      parameter: "target_key",
      received_value: receivedInvalidTarget,
    });
    expect(await readFile(codec.mapPath, "utf8")).toBe(before);
    expect(await codec.encode({ target_key: `reference-target:${"c".repeat(64)}` }))
      .toEqual({ target_key: "t2" });
  });
});
