import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { Type } from "typebox";
import { defineTool, wrapRegisteredTool } from "@earendil-works/pi-coding-agent";
import { ModelSourceHandles } from "../src/model-source-handles.js";
import { withToolArgumentFeedback } from "../src/tool-argument-feedback.js";
import { createPiTools } from "../src/tools.js";
import { TARGET_SELECTOR_PROTOCOLS } from "../src/acceptance-prompt-suite.js";

// Exercise the exact installed SDK, including its pre-execution rejection path.
const { validateToolArguments } = await import('@earendil-works/pi-ai');
const { agentLoop } = await import('@earendil-works/pi-agent-core');
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "sdk-argument-feedback-")); roots.push(root);
  const codec = await ModelSourceHandles.open(root);
  const execute = vi.fn(async (_id, args) => ({ content: [{ type: "text" as const, text: JSON.stringify({ ok: true }) }], details: args }));
  const tool = defineTool({ name: "stage_probe", label: "通用结构试验", description: "不含任何规范或业务答案", parameters: Type.Object({
    items: Type.Array(Type.Object({ name: Type.String(), sampling: Type.Object({ status: Type.Union([Type.Literal("present"), Type.Literal("absent")]), script_span_ids: Type.Array(Type.String()) }, { additionalProperties: false }) }, { additionalProperties: false })),
    count: Type.Optional(Type.Number()),
  }, { additionalProperties: false }), execute });
  const wrapped = codec.wrapTools([tool])[0]!;
  return { root, codec, execute, tool, wrapped };
}

test("SDK rejects exact extra and missing keys, then executes the repaired call without schema or durable mutation", async () => {
  const { codec, execute, wrapped, tool } = await fixture();
  const raw = { items: [{ name: "构件检查", sampling: { status: "present", unwanted: ["source-text"] } }], source_handle_scope: codec.scope };
  const before = JSON.stringify(raw), schema = JSON.stringify(wrapped.parameters), map = await readFile(codec.mapPath, "utf8");
  expect(() => validateToolArguments(wrapped, { type: "toolCall", id: "native", name: wrapped.name, arguments: raw })).toThrow('must not have additional properties');
  const invoke = (args: unknown) => validateToolArguments(wrapped, { type: "toolCall", id: "probe", name: wrapped.name, arguments: wrapped.prepareArguments?.(args) ?? args });
  let receipt: any;
  try { invoke(raw); } catch (error) { receipt = JSON.parse((error as Error).message); }
  expect(receipt).toMatchObject({ error: "tool_argument_shape_invalid", durable_mutation: false, next_tool: "stage_probe", issues: expect.arrayContaining([
    expect.objectContaining({ path: "/items/0/sampling/unwanted", actual: ["source-text"], allowed_fields: ["status", "script_span_ids"] }),
    expect.objectContaining({ path: "/items/0/sampling/script_span_ids", actual: { missing: true }, expected: { type: "array", items: { type: "string" } } }),
  ]) });
  expect(JSON.stringify(raw)).toBe(before); expect(JSON.stringify(wrapped.parameters)).toBe(schema);
  expect(await readFile(codec.mapPath, "utf8")).toBe(map); expect(execute).not.toHaveBeenCalled();
  const good = { items: [{ name: "构件检查", sampling: { status: "present", script_span_ids: [] } }], source_handle_scope: codec.scope };
  const args = invoke(good);
  await wrapped.execute("probe", args, undefined as any, undefined as any, undefined as any);
  expect(execute).toHaveBeenCalledOnce(); expect(JSON.stringify(tool.parameters)).not.toContain("source_handle_scope");
});

test("missing required objects expose child types and every enum choice without filling business values", async () => {
  const { codec, execute, wrapped } = await fixture();
  const raw = { items: [{ name: "构件检查" }], source_handle_scope: codec.scope };
  const before = JSON.stringify(raw), schema = JSON.stringify(wrapped.parameters), map = await readFile(codec.mapPath, "utf8");
  let receipt: any;
  try { wrapped.prepareArguments!(raw); } catch (error) { receipt = JSON.parse((error as Error).message); }
  expect(receipt).toMatchObject({
    error: "tool_argument_shape_invalid", durable_mutation: false, next_tool: "stage_probe",
    issues: [{ path: "/items/0/sampling", actual: { missing: true }, writable_path: "/items/0/sampling",
      expected: { type: "object", required_fields: ["status", "script_span_ids"],
        properties: { status: { allowed_values: ["present", "absent"] }, script_span_ids: { type: "array", items: { type: "string" } } } } }],
  });
  expect(JSON.stringify(raw)).toBe(before); expect(JSON.stringify(wrapped.parameters)).toBe(schema);
  expect(await readFile(codec.mapPath, "utf8")).toBe(map); expect(execute).not.toHaveBeenCalled();
  const repaired = { items: [{ name: "构件检查", sampling: { status: "absent", script_span_ids: [] } }], source_handle_scope: codec.scope };
  const args = wrapped.prepareArguments!(repaired);
  validateToolArguments(wrapped, { id: "repaired-object", name: wrapped.name, arguments: args });
  await wrapped.execute("repaired-object", args, undefined as never, undefined as never);
  expect(execute).toHaveBeenCalledOnce();
});

test("missing object property descriptions retain literal bounds and nullable choices without selecting one", () => {
  const original = defineTool({ name: "bounded_object_probe", label: "字段边界", description: "仅结构契约",
    parameters: Type.Object({ decision: Type.Object({
      label: Type.String({ minLength: 2, maxLength: 12 }),
      confidence: Type.Number({ minimum: 0, maximum: 1 }),
      sources: Type.Array(Type.String({ minLength: 2 }), { minItems: 1, maxItems: 4, uniqueItems: true }),
      branch: Type.Union([Type.Null(), Type.Object({ key: Type.String() })]),
    }) }), execute: vi.fn(async () => ({ content: [], details: {} })) });
  const tool = withToolArgumentFeedback(original), raw = {};
  const beforeSchema = JSON.stringify(tool.parameters);
  let receipt: any;
  try { tool.prepareArguments!(raw); } catch (error) { receipt = JSON.parse((error as Error).message); }
  expect(receipt.issues[0].expected.properties).toMatchObject({
    label: { type: "string", minLength: 2, maxLength: 12 },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    sources: { type: "array", minItems: 1, maxItems: 4, uniqueItems: true, items: { type: "string", minLength: 2 } },
    branch: { alternatives: [{ type: "null" }, { type: "object", required_fields: ["key"], allowed_fields: ["key"] }],
      choice_rule: expect.stringContaining("不要把所有") },
  });
  expect(raw).toEqual({}); expect(JSON.stringify(tool.parameters)).toBe(beforeSchema);
  expect(original.execute).not.toHaveBeenCalled();
  for (const branch of [null, { key: "source-key" }]) {
    const args = { decision: { label: "来源", confidence: 0.5, sources: ["s1"], branch } };
    expect(tool.prepareArguments!(args)).toBe(args);
    expect(validateToolArguments(tool, { id: "bounded-object", name: tool.name, arguments: args })).toEqual(args);
  }
});

test.each(["minItems", "maxItems"] as const)("%s in an unambiguous nullable object reports the array, not the null alternative", keyword => {
  // Public transcript: an empty array inside a table object leaked the SDK's
  // unrelated 'must be null' alternative. Use a document-independent shape.
  const original = defineTool({ name: "array_bound_probe", label: "数组边界", description: "只检查参数结构",
    parameters: Type.Object({ carrier: Type.Union([Type.Null(), Type.Object({
      sources: Type.Array(Type.String(), { [keyword]: 1 }),
    }, { additionalProperties: false })]) }), execute: vi.fn(async () => ({ content: [], details: {} })) });
  const tool = withToolArgumentFeedback(original);
  const raw = { carrier: { sources: keyword === "minItems" ? [] : ["a", "b"] } };
  const before = JSON.stringify(raw), schema = JSON.stringify(tool.parameters);
  expect(() => validateToolArguments(original, { id: "native-bound", name: original.name, arguments: raw })).toThrow();
  let receipt: any;
  try { tool.prepareArguments!(raw); } catch (error) { receipt = JSON.parse((error as Error).message); }
  expect(receipt).toMatchObject({ durable_mutation: false, budget_consumed: false, terminal: false, issue_count: 1,
    issues: [{ code: "tool_argument_array_length", path: "/carrier/sources", actual_count: raw.carrier.sources.length, expected: { [keyword]: 1 },
      next_tool: tool.name, actual: raw.carrier.sources }] });
  expect(JSON.stringify(receipt)).not.toContain("must be null");
  expect(JSON.stringify(raw)).toBe(before); expect(JSON.stringify(tool.parameters)).toBe(schema);
  expect(original.execute).not.toHaveBeenCalled();
  for (const args of [{ carrier: null }, { carrier: { sources: ["a"] } }]) {
    expect(tool.prepareArguments!(args)).toBe(args);
    expect(validateToolArguments(tool, { id: "valid-bound", name: tool.name, arguments: args })).toEqual(args);
  }
});

test("maxItems feedback exposes the field description without assuming repeated calls merge", () => {
  const execute = vi.fn(async () => ({ content: [], details: {} }));
  const description = "整份覆盖保存本次选择；重复调用不会自动合并上一批。";
  const original = defineTool({ name: "overwrite_array_probe", label: "覆盖数组", description: "只检查参数结构",
    parameters: Type.Object({ records: Type.Array(Type.String(), { maxItems: 2, description }) }, { additionalProperties: false }),
    execute });
  const tool = withToolArgumentFeedback(original);
  const raw = { records: ["a", "b", "c"] };
  const before = JSON.stringify(raw), schema = JSON.stringify(tool.parameters);
  let receipt: any;
  try { tool.prepareArguments!(raw); } catch (error) { receipt = JSON.parse((error as Error).message); }

  expect(receipt).toMatchObject({
    error: "tool_argument_shape_invalid",
    issues: [expect.objectContaining({
      code: "tool_argument_array_length",
      path: "/records",
      actual_count: 3,
      expected: { json_type: "array", maxItems: 2, description },
      how_to_pass: expect.stringContaining("不能假定重复调用会自动合并或保留上一批"),
    })],
  });
  expect(receipt.issues[0].how_to_pass).toContain("只有字段契约明确说明支持增量或分批提交时，才能分批");
  expect(receipt.issues[0].how_to_pass).toContain("不得为缩短数组丢弃有效来源或业务义务");
  expect(receipt.issues[0].how_to_pass).not.toContain("按工具契约分批或");
  expect(JSON.stringify(raw)).toBe(before);
  expect(JSON.stringify(tool.parameters)).toBe(schema);
  expect(execute).not.toHaveBeenCalled();

  const valid = { records: ["a", "b"] };
  expect(tool.prepareArguments!(valid)).toBe(valid);
  expect(validateToolArguments(tool, { id: "valid-overwrite-array", name: tool.name, arguments: valid })).toEqual(valid);
});

test("investigation key-source overflow reports the exact count even when the value preview is truncated", () => {
  const dispatch = vi.fn(async () => ({ ok: true }));
  const original = createPiTools({ usesSelectorCompiler: true, dispatch } as any)
    .find(tool => tool.name === "save_target_investigation")!;
  const tool = withToolArgumentFeedback(original);
  const args = { summary: "保留完整调查结论，不预设业务答案。", next_steps: "继续依据原文完成作者记录。",
    evidence_ids: Array.from({ length: 25 }, (_, index) => `evidence-neutral-${String(index).padStart(3, "0")}`) };
  const before = JSON.stringify(args), schema = JSON.stringify(tool.parameters);
  let receipt: any;
  try { tool.prepareArguments!(args); } catch (error) { receipt = JSON.parse((error as Error).message); }
  expect(receipt).toMatchObject({ durable_mutation: false, budget_consumed: false, terminal: false,
    issues: [{ code: "tool_argument_array_length", path: "/evidence_ids", writable_path: "/evidence_ids",
      actual_count: 25, actual: { truncated: true }, expected: { maxItems: 24 }, next_tool: original.name }] });
  expect(receipt.issues[0].how_to_pass).toContain("实际 25 项");
  expect(receipt.issues[0].how_to_pass).toContain("关键来源摘要");
  expect(receipt.issues[0].expected.description).toContain("关键已读来源");
  expect(receipt.issues[0].expected.description).toContain("不代表完整调查范围");
  expect(receipt.issues[0].expected.description).toContain("不自动合并");
  expect(receipt.issues[0].how_to_pass).toContain("evidence_ids=[]");
  expect(receipt.issues[0].how_to_pass).toContain("不清除已有阅读回执");
  expect(JSON.stringify(args)).toBe(before);
  expect(JSON.stringify(tool.parameters)).toBe(schema);
  expect(dispatch).not.toHaveBeenCalled();
  const valid = { ...args, evidence_ids: args.evidence_ids.slice(0, 24) };
  expect(tool.prepareArguments!(valid)).toBe(valid);
  expect(validateToolArguments(tool, { id: "within-key-source-limit", name: tool.name, arguments: valid })).toEqual(valid);
  const emptyKeys = { ...args, evidence_ids: [] };
  expect(tool.prepareArguments!(emptyKeys)).toBe(emptyKeys);
  expect(validateToolArguments(tool, { id: "empty-key-source-directory", name: tool.name, arguments: emptyKeys })).toEqual(emptyKeys);
});

test("minItems feedback distinguishes an optional array property from a required array", () => {
  const execute = vi.fn(async () => ({ content: [], details: {} }));
  const original = defineTool({ name: "optional_array_probe", label: "可选数组", description: "只检查参数结构",
    parameters: Type.Object({
      carrier: Type.Union([Type.Null(), Type.Object({
        required_sources: Type.Array(Type.String(), { minItems: 2 }),
        optional_sources: Type.Optional(Type.Array(Type.String(), { minItems: 2 })),
      }, { additionalProperties: false })]),
    }, { additionalProperties: false }), execute });
  const tool = withToolArgumentFeedback(original);
  const raw = { carrier: { required_sources: [], optional_sources: [] } };
  const before = JSON.stringify(raw), schema = JSON.stringify(tool.parameters);
  let receipt: any;
  try { tool.prepareArguments!(raw); } catch (error) { receipt = JSON.parse((error as Error).message); }

  const required = receipt.issues.find((issue: any) => issue.path === "/carrier/required_sources");
  const optional = receipt.issues.find((issue: any) => issue.path === "/carrier/optional_sources");
  expect(required).toMatchObject({
    code: "tool_argument_array_length",
    expected: { minItems: 2 },
    how_to_pass: expect.stringContaining("至少需要 2 项"),
  });
  expect(required).not.toHaveProperty("optional_property");
  expect(required.how_to_pass).not.toContain("省略");
  expect(optional).toMatchObject({
    code: "tool_argument_array_length",
    expected: { minItems: 2 },
    optional_property: true,
    how_to_pass: expect.stringContaining("删除或省略该可选属性本身"),
  });
  expect(optional.how_to_pass).toContain("是否适用由你依据原文语义决定");
  expect(optional.how_to_pass).toContain("不得把所属父对象改成 null");
  expect(JSON.stringify(raw)).toBe(before);
  expect(JSON.stringify(tool.parameters)).toBe(schema);
  expect(execute).not.toHaveBeenCalled();

  for (const args of [
    { carrier: { required_sources: ["a", "b"] } },
    { carrier: { required_sources: ["a", "b"], optional_sources: ["c", "d"] } },
  ]) {
    expect(tool.prepareArguments!(args)).toBe(args);
    expect(validateToolArguments(tool, { id: "valid-optional-array", name: tool.name, arguments: args })).toEqual(args);
  }
});

test("array bound feedback does not choose between ambiguous same-type business branches", () => {
  const original = defineTool({ name: "ambiguous_array_probe", label: "数组联合", description: "不代选业务分支",
    parameters: Type.Object({ values: Type.Union([
      Type.Array(Type.String(), { minItems: 2 }), Type.Array(Type.String(), { maxItems: 1 }),
    ]) }), execute: async () => ({ content: [], details: {} }) });
  const tool = withToolArgumentFeedback(original), args = { values: [] };
  expect(tool.prepareArguments!(args)).toBe(args);
  expect(validateToolArguments(tool, { id: "union-bound", name: tool.name, arguments: args })).toEqual(args);
});

test("native SDK coercions and union acceptance remain unchanged", async () => {
  const { wrapped } = await fixture();
  for (const count of [2, "2", true, "invalid"]) {
    const args = { items: [{ name: "构件", sampling: { status: "absent", script_span_ids: [] } }], count };
    const run = (prepare: boolean) => {
      try { return { ok: true, args: validateToolArguments(wrapped, { type: "toolCall", id: "coercion", name: wrapped.name, arguments: prepare ? wrapped.prepareArguments?.(args) ?? args : args }) }; }
      catch { return { ok: false }; }
    };
    expect(run(true)).toEqual(run(false));
  }
});

test("feedback escapes parameter pointers, bounds repeated errors and preserves prior preparation", () => {
  const prepareArguments = vi.fn((raw: any) => raw.payload);
  const original = defineTool({ name: "shape_probe", label: "参数路径", description: "结构边界",
    parameters: Type.Object({ "a/b~": Type.Array(Type.Object({ name: Type.String() }, { additionalProperties: false })) }, { additionalProperties: false }),
    execute: async () => ({ content: [], details: {} }), prepareArguments });
  const tool = withToolArgumentFeedback(original);
  const payload = { "a/b~": Array.from({ length: 25 }, () => ({ name: "记录", "x/y~": "值".repeat(1000) })) };
  let receipt: any;
  try { tool.prepareArguments!({ payload }); } catch (error) { receipt = JSON.parse((error as Error).message); }
  expect(prepareArguments).toHaveBeenCalledOnce();
  expect(receipt).toMatchObject({ issue_count: 25, remaining_issue_count: 1 });
  expect(receipt.issues).toHaveLength(24);
  expect(receipt.issues[0]).toMatchObject({ path: "/a~1b~0/0/x~1y~0", field: "x/y~", allowed_fields: ["name"], actual: { truncated: true } });
  expect(receipt.issues[0].actual.preview.length).toBe(400);
  expect(payload["a/b~"][0]!["x/y~"]).toHaveLength(1000);
  const good = { "a/b~": [{ name: "记录" }] };
  expect(tool.prepareArguments!({ payload: good })).toBe(good);
});

test("feedback does not invent a repair from a rejected union alternative", () => {
  const original = defineTool({ name: "union_probe", label: "联合分支", description: "结构边界",
    parameters: Type.Object({ value: Type.Union([
      Type.Object({ kind: Type.Literal("text"), text: Type.String() }, { additionalProperties: false }),
      Type.Object({ kind: Type.Literal("number"), number: Type.Number() }, { additionalProperties: false }),
    ]) }), execute: async () => ({ content: [], details: {} }) });
  const tool = withToolArgumentFeedback(original);
  for (const value of [{ kind: "number", number: "2" }, { kind: "text", text: 2 }, { kind: "unknown" }, { kind: "number", extra: 1 }]) {
    const args = { value };
    expect(tool.prepareArguments!(args)).toBe(args);
    const run = (prepared: boolean) => {
      try { return { ok: true, args: validateToolArguments(tool, { id: "union", name: tool.name, arguments: prepared ? tool.prepareArguments!(args) : args }) }; }
      catch (error) { return { ok: false, error: (error as Error).message }; }
    };
    expect(run(true)).toEqual(run(false));
  }
});

test("nullable objects report exact misplaced keys without suggesting the null alternative", () => {
  const original = defineTool({ name: "nullable_probe", label: "可空对象", description: "只验证参数形状",
    parameters: Type.Object({ "a/b~": Type.Array(Type.Object({ carrier: Type.Union([
      Type.Null(), Type.Object({ sources: Type.Array(Type.String()), reason: Type.String(),
        properties: Type.Object({ label: Type.String() }, { additionalProperties: false }),
      }, { additionalProperties: false }),
    ]) })) }), execute: vi.fn(async () => ({ content: [], details: {} })) });
  const tool = withToolArgumentFeedback(original);
  const raw = { "a/b~": [{ carrier: { properties: { label: "原文", sources: ["s1"], reason: "依据" } } }] };
  const before = JSON.stringify(raw), schema = JSON.stringify(tool.parameters);
  let receipt: any;
  try { tool.prepareArguments!(raw); } catch (error) { receipt = JSON.parse((error as Error).message); }
  expect(receipt).toMatchObject({ error: "tool_argument_shape_invalid", durable_mutation: false, issue_count: 4 });
  expect(receipt.issues).toEqual(expect.arrayContaining([
    expect.objectContaining({ path: "/a~1b~0/0/carrier/sources", actual: { missing: true }, expected: { type: "array", items: { type: "string" } } }),
    expect.objectContaining({ path: "/a~1b~0/0/carrier/reason", expected: { type: "string" } }),
    expect.objectContaining({ path: "/a~1b~0/0/carrier/properties/sources", actual: ["s1"], allowed_fields: ["label"] }),
    expect.objectContaining({ path: "/a~1b~0/0/carrier/properties/reason", actual: "依据", allowed_fields: ["label"] }),
  ]));
  expect(JSON.stringify(receipt)).not.toContain("must be null");
  expect(JSON.stringify(raw)).toBe(before); expect(JSON.stringify(tool.parameters)).toBe(schema);
  expect(original.execute).not.toHaveBeenCalled();
  for (const carrier of [null, { sources: ["s1"], reason: "依据", properties: { label: "原文" } }]) {
    const args = { "a/b~": [{ carrier }] };
    expect(tool.prepareArguments!(args)).toBe(args);
    expect(validateToolArguments(tool, { id: "valid", name: tool.name, arguments: args })).toEqual(args);
  }
});

test("a nullable outer object does not choose between ambiguous inner object alternatives", () => {
  const original = defineTool({ name: "nested_union_probe", label: "嵌套联合", description: "只验证参数形状",
    parameters: Type.Object({ carrier: Type.Union([Type.Null(), Type.Object({ value: Type.Union([
      Type.Object({ left: Type.String() }, { additionalProperties: false }),
      Type.Object({ right: Type.String() }, { additionalProperties: false }),
    ]) })]) }), execute: async () => ({ content: [], details: {} }) });
  const tool = withToolArgumentFeedback(original);
  const args = { carrier: { value: { unexpected: "原文" } } };
  expect(tool.prepareArguments!(args)).toBe(args);
  expect(() => validateToolArguments(tool, { id: "ambiguous", name: tool.name, arguments: args })).toThrow();
});

test.each(["anyOf", "oneOf"] as const)("%s with the same leaf type reports nested arrays without inventing a null repair", keyword => {
  // The live tool call supplied [["s1"]] for a one-dimensional source list.
  // Both identifier alternatives require strings; choosing an identifier
  // format is ambiguous, but reporting that an array is not a string is not.
  const original = defineTool({ name: "source_shape_probe", label: "来源参数结构", description: "只验证 JSON 形状",
    parameters: Type.Object({ carrier: Type.Union([Type.Null(), Type.Object({
      sources: Type.Array({ [keyword]: [
        Type.String({ pattern: "^source:[a-z]+$" }), Type.String({ pattern: "^s[0-9]+$" }),
      ] } as any),
    }, { additionalProperties: false })]) }), execute: vi.fn(async () => ({ content: [], details: {} })) });
  const tool = withToolArgumentFeedback(original);
  const raw = { carrier: { sources: [["s1"], ["source:alpha"]] } };
  const before = JSON.stringify(raw), schema = JSON.stringify(tool.parameters);
  expect(() => validateToolArguments(original, { id: "native-shape", name: original.name, arguments: raw })).toThrow("must be null");
  let receipt: any;
  try { tool.prepareArguments!(raw); } catch (error) { receipt = JSON.parse((error as Error).message); }
  expect(receipt).toMatchObject({ error: "tool_argument_shape_invalid", durable_mutation: false,
    budget_consumed: false, terminal: false, issue_count: 2, issues: [
      { code: "tool_argument_type_mismatch", path: "/carrier/sources/0", writable_path: "/carrier/sources/0",
        actual: ["s1"], received_json_type: "array", expected: { json_type: "string" }, next_tool: tool.name },
      { code: "tool_argument_type_mismatch", path: "/carrier/sources/1", writable_path: "/carrier/sources/1",
        actual: ["source:alpha"], received_json_type: "array", expected: { json_type: "string" }, next_tool: tool.name },
    ] });
  expect(JSON.stringify(receipt)).not.toContain("must be null");
  expect(JSON.stringify(raw)).toBe(before); expect(JSON.stringify(tool.parameters)).toBe(schema);
  expect(original.execute).not.toHaveBeenCalled();
  for (const args of [{ carrier: null }, { carrier: { sources: ["s1", "source:alpha"] } }]) {
    expect(tool.prepareArguments!(args)).toBe(args);
    expect(validateToolArguments(tool, { id: "valid-source", name: tool.name, arguments: args })).toEqual(args);
  }
  // Pattern selection still belongs to native validation, not this feedback.
  const badPattern = { carrier: { sources: ["unknown"] } };
  expect(tool.prepareArguments!(badPattern)).toBe(badPattern);
  expect(() => validateToolArguments(tool, { id: "bad-pattern", name: tool.name, arguments: badPattern })).toThrow();
});

test("untyped union alternatives remain ambiguous even when another branch has a matching type", () => {
  const original = defineTool({ name: "untyped_union_probe", label: "未知分支", description: "只验证参数形状",
    parameters: Type.Object({ value: Type.Union([Type.Object({ required: Type.String() }), Type.Unknown()]) }),
    execute: async () => ({ content: [], details: {} }) });
  const tool = withToolArgumentFeedback(original);
  const args = { value: {} };
  expect(tool.prepareArguments!(args)).toBe(args);
  expect(validateToolArguments(tool, { id: "unknown", name: tool.name, arguments: args })).toEqual(args);
});

test("oneOf follows only the unique JSON type and leaves conditional paths to native validation", () => {
  const original = defineTool({ name: "oneof_probe", label: "互斥联合", description: "只验证参数形状",
    parameters: { type: "object", properties: { value: { oneOf: [
      { type: "null" }, { type: "object", properties: { label: { type: "string" } }, required: ["label"],
        if: { properties: { label: { const: "variant" } }, required: ["label"] },
        then: { required: ["conditional"] },
      },
    ] } } } as any, execute: async () => ({ content: [], details: {} }) });
  const tool = withToolArgumentFeedback(original);
  expect(() => tool.prepareArguments!({ value: {} })).toThrow('"path":"/value/label"');
  const conditional = { value: { label: "variant" } };
  expect(tool.prepareArguments!(conditional)).toBe(conditional);
  const valid = { value: null };
  expect(tool.prepareArguments!(valid)).toBe(valid);
});

test("a missing union field lists the alternatives without choosing a business value", () => {
  const original = defineTool({ name: "missing_union_probe", label: "缺项", description: "结构边界",
    parameters: Type.Object({ status: Type.Union([Type.Literal("present"), Type.Literal("absent")]),
      carrier: Type.Union([Type.Null(), Type.Object({ key: Type.String() })]) }),
    execute: async () => ({ content: [], details: {} }) });
  let receipt: any;
  try { withToolArgumentFeedback(original).prepareArguments!({}); } catch (error) { receipt = JSON.parse((error as Error).message); }
  expect(receipt.issues).toEqual(expect.arrayContaining([
    expect.objectContaining({ path: "/status", expected: { allowed_values: ["present", "absent"] } }),
    expect.objectContaining({ path: "/carrier", expected: expect.objectContaining({ alternatives: [
      { type: "null" }, { type: "object", required_fields: ["key"], allowed_fields: ["key"], properties: { key: { type: "string" } } },
    ], choice_rule: expect.stringContaining("不要把所有") }) }),
  ]));
});

test("a rejected separator constant lists the closed allowed set instead of a bare const error", () => {
  // Round-10 dimensions regression (seq 954): 41 separator constants reached
  // the model as "must be equal to constant" with no allowed values and a full
  // 65KB arguments echo. A union of literals is a closed set, so the whole set
  // is revealed without choosing a business branch.
  const original = defineTool({ name: "separator_probe", label: "分隔符试验", description: "只验证常量回条",
    parameters: Type.Object({ items: Type.Array(Type.Object({
      requirement: Type.Object({ text: Type.String(), separator: Type.Union([Type.Literal(""), Type.Literal(" "), Type.Literal("\n")]) }, { additionalProperties: false }),
    }, { additionalProperties: false })) }), execute: vi.fn(async () => ({ content: [], details: {} })) });
  const tool = withToolArgumentFeedback(original);
  const raw = { items: [{ requirement: { text: "原文", separator: "：" } }] };
  let receipt: any;
  try { tool.prepareArguments!(raw); } catch (error) { receipt = JSON.parse((error as Error).message); }
  expect(receipt).toMatchObject({ error: "tool_argument_shape_invalid", durable_mutation: false, issue_count: 1 });
  expect(receipt.issues).toEqual([expect.objectContaining({
    code: "tool_argument_enum_rejected",
    path: "/items/0/requirement/separator",
    writable_path: "/items/0/requirement/separator",
    actual: "：",
    expected: { json_type: "string", allowed_values: ["", " ", "\n"] },
  })]);
  expect(JSON.stringify(receipt)).not.toContain("must be equal to constant");
  expect(JSON.stringify(receipt)).not.toContain("anyOf"); // structured receipt, not the native anyOf noise
  expect(original.execute).not.toHaveBeenCalled();
  const good = { items: [{ requirement: { text: "原文", separator: "" } }] };
  expect(tool.prepareArguments!(good)).toBe(good);
});

test("a plain type mismatch reports expected and received JSON types without business edits", () => {
  const original = defineTool({ name: "type_probe", label: "类型试验", description: "只验证类型回条",
    parameters: Type.Object({ count: Type.Optional(Type.Number()) }), execute: async () => ({ content: [], details: {} }) });
  const tool = withToolArgumentFeedback(original);
  const raw = { count: "第十二条" };
  let receipt: any;
  try { tool.prepareArguments!(raw); } catch (error) { receipt = JSON.parse((error as Error).message); }
  expect(receipt.issues).toEqual([expect.objectContaining({
    code: "tool_argument_type_mismatch",
    path: "/count",
    expected: { json_type: "number" },
    received_json_type: "string",
  })]);
});

test("ambiguous object unions stay native while closed literal unions report their set", () => {
  const original = defineTool({ name: "mixed_union_probe", label: "混合联合", description: "只验证联合边界",
    parameters: Type.Object({ carrier: Type.Union([
      Type.Object({ mode: Type.Literal("a"), left: Type.String() }, { additionalProperties: false }),
      Type.Object({ mode: Type.Literal("b"), right: Type.String() }, { additionalProperties: false }),
    ]) }), execute: async () => ({ content: [], details: {} }) });
  const tool = withToolArgumentFeedback(original);
  const args = { carrier: { mode: "c" } };
  expect(tool.prepareArguments!(args)).toBe(args);
  expect(() => validateToolArguments(tool, { id: "mixed", name: tool.name, arguments: args })).toThrow();
});

test("real selector tools advertise no diagnostic-only fields but retain actionable SDK admission", async () => {
  const root = await mkdtemp(join(tmpdir(), "selector-admission-")); roots.push(root);
  const codec = await ModelSourceHandles.open(root);
  const dispatch = vi.fn();
  const tool = codec.wrapTools(createPiTools({ usesSelectorCompiler: true, dispatch } as any))
    .find(tool => tool.name === "stage_target_selector_draft")!;
  const schema = tool.parameters as any;
  expect(schema.properties).not.toHaveProperty("items");
  expect(schema.properties.draft.properties.items.items.properties).not.toHaveProperty("reference_span_ids");
  const raw = { operation: "upsert", collection: "items", remove_keys: ["old"],
    draft: { items: [{ key: "new", table: null, reference_span_ids: ["s1"] }] } };
  const before = JSON.stringify(raw);
  expect(() => tool.prepareArguments!(raw)).toThrow('"writable_path":"/draft/references"');
  expect(JSON.stringify(raw)).toBe(before); expect(dispatch).not.toHaveBeenCalled();
});

test("real selector staging advertises one nested home for every business collection", () => {
  const dispatch = vi.fn();
  const tool = createPiTools({ usesSelectorCompiler: true, dispatch } as any)
    .find(entry => entry.name === "stage_target_selector_draft")!;
  const schema = tool.parameters as any;
  const topLevelFields = ["operation", "draft_fingerprint", "reference_selections", "draft", "quote_bindings", "collection", "remove_keys"];
  const businessPlacement = `业务参数顶层只允许 ${topLevelFields.join("、")}`;
  const draftCollections = [
    "lots", "items", "sampling_rules", "references", "source_dispositions", "residual_source_dispositions",
  ];

  expect(Object.keys(schema.properties)).toEqual(topLevelFields);
  expect(Object.keys(schema.properties.draft.properties)).toEqual(draftCollections);
  expect(schema.properties.draft.description).toContain("都只能作为 draft 的子字段");
  expect(schema.properties.draft.description).toContain(businessPlacement);
  expect(schema.properties.draft.description).toContain("来源所属目标由程序绑定当前工具会话");
  expect(schema.properties.draft.description).toContain("不传 source_handle_scope，也不放进 draft");
  for (const collection of draftCollections) {
    expect(schema.properties.draft.properties[collection].description).toContain(`只能写在 draft.${collection}`);
    expect(schema.properties).not.toHaveProperty(collection);
  }
  expect(tool.description).toContain("原子保存draft内完整typed记录");
  expect(TARGET_SELECTOR_PROTOCOLS.patch).toContain("集合只在 draft 内");
  expect(TARGET_SELECTOR_PROTOCOLS.source_handles).toContain("source_handle_scope");
  expect(TARGET_SELECTOR_PROTOCOLS.source_handles).toContain("模型不传 source_handle_scope");
  expect(TARGET_SELECTOR_PROTOCOLS.source_handles).toContain("也不把它放入 draft");

  const raw = { operation: "upsert", draft: { items: [] }, references: [], source_dispositions: [] };
  let receipt: any;
  try { tool.prepareArguments!(raw); } catch (error) { receipt = JSON.parse((error as Error).message); }
  expect(receipt).toMatchObject({
    error: "selector_draft_collection_misplaced",
    durable_mutation: false,
    budget_consumed: false,
    selector_issues: [
      expect.objectContaining({ path: "/references", details: expect.objectContaining({ writable_path: "/draft/references" }) }),
      expect.objectContaining({ path: "/source_dispositions", details: expect.objectContaining({ writable_path: "/draft/source_dispositions" }) }),
    ],
  });
  expect(receipt.instruction).toContain("都只能放在 draft 内");
  expect(receipt.instruction).toContain(businessPlacement);
  expect(receipt.instruction).toContain("短句柄");
  expect(receipt.instruction).toContain("不传 source_handle_scope，也不放进 draft");
  expect(dispatch).not.toHaveBeenCalled();
});

test("legacy explicit-scope wrapping preserves its compatibility gate while the current author contract is session-bound", async () => {
  const root = await mkdtemp(join(tmpdir(), "selector-scope-contract-")); roots.push(root);
  const codec = await ModelSourceHandles.open(root);
  const dispatch = vi.fn(async (_toolName: string, _args: Record<string, unknown>) => ({ok: true}));
  const tool = codec.wrapTools(createPiTools({ usesSelectorCompiler: true, dispatch } as any))
    .find(entry => entry.name === "stage_target_selector_draft")!;
  const schema = tool.parameters as any;
  const businessFields = ["operation", "draft_fingerprint", "reference_selections", "draft", "quote_bindings", "collection", "remove_keys"];
  expect(Object.keys(schema.properties)).toEqual(["source_handle_scope", ...businessFields]);
  expect(schema.required ?? []).not.toContain("source_handle_scope");
  expect(schema.properties.source_handle_scope).toMatchObject({type: "string", minLength: 1});
  expect(schema.properties.source_handle_scope).not.toHaveProperty("const");
  expect(schema.properties.draft.description).toContain(`业务参数顶层只允许 ${businessFields.join("、")}`);
  expect(schema.properties.draft.description).toContain("来源所属目标由程序绑定当前工具会话");
  expect(TARGET_SELECTOR_PROTOCOLS.source_handles).toContain("模型不传 source_handle_scope");

  const canonicalEvidenceId = `evidence:${"a".repeat(64)}`;
  const encoded = await codec.encode({evidence_id: canonicalEvidenceId}) as {evidence_id: string};
  const missingScope = {
    operation: "upsert",
    quote_bindings: [{key: "$source", evidence_id: encoded.evidence_id, quote: "中性来源片段"}],
  };
  const prepared = tool.prepareArguments!(missingScope);
  const rejected = await tool.execute("missing-scope", prepared, undefined as any, undefined as any, undefined as any);
  expect(rejected.details).toMatchObject({
    ok: false,
    error: "source_handle_scope_required",
    writable_path: "/source_handle_scope",
    required_argument: {source_handle_scope: codec.scope},
    next_tool: "stage_target_selector_draft",
  });
  expect(dispatch).not.toHaveBeenCalled();
  const visibleRejected = JSON.parse((rejected.content[0] as {type: "text"; text: string}).text);
  expect(visibleRejected).toMatchObject({
    error: "source_handle_scope_required",
    required_argument: {source_handle_scope: codec.scope},
    instruction: expect.stringContaining("参数对象的顶层添加 source_handle_scope"),
  });

  const retry = {...missingScope, ...visibleRejected.required_argument};
  const retried = await tool.execute("repaired-scope", tool.prepareArguments!(retry), undefined as any, undefined as any, undefined as any);
  expect(retried.details).toMatchObject({ok: true});
  expect(dispatch).toHaveBeenCalledOnce();
  expect(dispatch.mock.calls[0]?.[1]).toMatchObject({
    operation: "upsert",
    quote_bindings: [{key: "$source", evidence_id: canonicalEvidenceId, quote: "中性来源片段"}],
  });
  expect(dispatch.mock.calls[0]?.[1]).not.toHaveProperty("source_handle_scope");

  const canonicalWithoutScope = {
    operation: "upsert",
    quote_bindings: [{key: "$canonical", evidence_id: canonicalEvidenceId, quote: "另一条中性来源片段"}],
  };
  const canonicalResult = await tool.execute(
    "canonical-without-scope",
    tool.prepareArguments!(canonicalWithoutScope),
    undefined as any,
    undefined as any,
    undefined as any,
  );
  expect(canonicalResult.details).toMatchObject({ok: true});
  expect(dispatch).toHaveBeenCalledTimes(2);
  expect(dispatch.mock.calls[1]?.[1]).toEqual(canonicalWithoutScope);

  let misplacedCollection: any;
  try {
    tool.prepareArguments!({operation: "upsert", references: [], source_handle_scope: codec.scope});
  } catch (error) {
    misplacedCollection = JSON.parse((error as Error).message);
  }
  expect(misplacedCollection).toMatchObject({
    error: "selector_draft_collection_misplaced",
    selector_issues: [expect.objectContaining({path: "/references", details: expect.objectContaining({writable_path: "/draft/references"})})],
  });

  let nestedScope: any;
  try {
    tool.prepareArguments!({operation: "upsert", draft: {source_handle_scope: codec.scope}});
  } catch (error) {
    nestedScope = JSON.parse((error as Error).message);
  }
  expect(nestedScope).toMatchObject({
    error: "tool_argument_shape_invalid",
    issues: [expect.objectContaining({path: "/draft/source_handle_scope"})],
  });
});

test("real selector staging describes and reports the required top-level item reason", async () => {
  const root = await mkdtemp(join(tmpdir(), "selector-item-reason-")); roots.push(root);
  const codec = await ModelSourceHandles.open(root);
  const dispatch = vi.fn();
  const tool = codec.wrapTools(createPiTools({ usesSelectorCompiler: true, dispatch } as any))
    .find(entry => entry.name === "stage_target_selector_draft")!;
  const itemSchema = (tool.parameters as any).properties.draft.properties.items.items;
  expect(itemSchema.required).toContain("reason");
  expect(itemSchema.properties.reason).toMatchObject({
    type: "string",
    description: expect.stringContaining("顶层业务依据"),
  });
  expect(itemSchema.properties.reason.description).toContain("内层 reason 都不能代替");
  expect(TARGET_SELECTOR_PROTOCOLS.patch).toContain("item 保留顶层 reason");

  const emptyField = () => ({ composition: "not_applicable", span_ids: [], separator: "", reason: "原文未规定该字段" });
  const raw = { operation: "upsert", draft: { items: [{
    key: "item-probe", lot_key: "lot-probe", name: "项目名称", category: "一般项目",
    criterion_span_ids: [], continuation_span_ids: [],
    fields: { name: emptyField(), requirement: emptyField(), method: emptyField(), quantity: emptyField(), note: emptyField() },
    table: null,
    inspection_data_type: "review", inspection_data_type_reason: "只验证参数结构", inspection_data_type_span_ids: [],
    sampling: { status: "not_sampling", rule_key: "", branch_keys: [], quantity_span_ids: [], script_span_ids: [], condition_span_ids: [], reason: "只验证参数结构", confidence: 1 },
  }] } };
  let receipt: any;
  try { tool.prepareArguments!(raw); } catch (error) { receipt = JSON.parse((error as Error).message); }
  expect(receipt).toMatchObject({
    error: "tool_argument_shape_invalid",
    next_tool: "stage_target_selector_draft",
    issues: [expect.objectContaining({
      code: "tool_argument_required",
      path: "/draft/items/0/reason",
      field: "reason",
      expected: { type: "string", description: expect.stringContaining("内层 reason 都不能代替") },
      next_tool: "stage_target_selector_draft",
    })],
  });
  expect(dispatch).not.toHaveBeenCalled();
});

test("the provider schema and required-field receipt preserve the complete inspection data type bundle", async () => {
  const root = await mkdtemp(join(tmpdir(), "selector-inspection-type-contract-")); roots.push(root);
  const codec = await ModelSourceHandles.open(root);
  const dispatch = vi.fn();
  const definition = codec.wrapTools(createPiTools({ usesSelectorCompiler: true, dispatch } as any))
    .find(entry => entry.name === "stage_target_selector_draft")!;
  const tool = wrapRegisteredTool({ definition, extensionPath: "test" } as any, {
    createToolContext: () => ({}), getActiveTools: () => [definition.name],
  } as any);
  const itemSchema = (tool.parameters as any).properties.draft.properties.items.items;
  expect(itemSchema.required).toEqual([
    "key", "lot_key", "name", "category", "criterion_span_ids", "continuation_span_ids",
    "fields", "table", "inspection_data_type", "inspection_data_type_reason",
    "inspection_data_type_span_ids", "sampling", "reason",
  ]);
  expect(itemSchema.properties.inspection_data_type).toMatchObject({
    anyOf: [
      { const: "measurement", type: "string" }, { const: "counting", type: "string" },
      { const: "mixed", type: "string" }, { const: "review", type: "string" },
    ],
    description: expect.stringContaining("inspection_data_type_span_ids 同时保留"),
  });
  expect(itemSchema.properties.inspection_data_type_reason).toMatchObject({
    type: "string",
    description: expect.stringContaining("分类依据"),
  });
  expect(itemSchema.properties.inspection_data_type_span_ids).toMatchObject({
    type: "array",
    description: expect.stringContaining("已登记来源 span_ids"),
  });
  expect(itemSchema.properties.inspection_data_type_span_ids.description).toContain("可为 []");
  expect(TARGET_SELECTOR_PROTOCOLS.patch).toContain("upsert 按 key 替换完整记录");
  expect(TARGET_SELECTOR_PROTOCOLS.patch).toContain("inspection_data_type/reason/span_ids");

  const emptyField = () => ({ composition: "not_applicable", span_ids: [], separator: "", reason: "原文未规定该字段" });
  const raw = { operation: "upsert", draft: { items: [{
    key: "item-probe", lot_key: "lot-probe", name: "项目名称", category: "一般项目",
    criterion_span_ids: [], continuation_span_ids: [],
    fields: { name: emptyField(), requirement: emptyField(), method: emptyField(), quantity: emptyField(), note: emptyField() },
    table: null,
    inspection_data_type: "review", inspection_data_type_reason: "只验证参数结构",
    sampling: { status: "not_sampling", rule_key: "", branch_keys: [], quantity_span_ids: [], script_span_ids: [], condition_span_ids: [], reason: "只验证参数结构", confidence: 1 },
    reason: "只验证完整 item 参数结构",
  }] } };
  const before = JSON.stringify(raw);
  let receipt: any;
  try { tool.prepareArguments!(raw); } catch (error) { receipt = JSON.parse((error as Error).message); }
  expect(receipt).toMatchObject({
    error: "tool_argument_shape_invalid",
    durable_mutation: false,
    budget_consumed: false,
    next_tool: "stage_target_selector_draft",
    issues: [{
      code: "tool_argument_required",
      path: "/draft/items/0/inspection_data_type_span_ids",
      writable_path: "/draft/items/0/inspection_data_type_span_ids",
      field: "inspection_data_type_span_ids",
      actual: { missing: true },
      expected: { type: "array", description: expect.stringContaining("完整 item 中不得省略") },
      how_to_pass: expect.any(String),
      next_tool: "stage_target_selector_draft",
    }],
  });
  expect(JSON.stringify(raw)).toBe(before);
  expect(dispatch).not.toHaveBeenCalled();
});

test("real SDK sampling-shape feedback preserves complete records and permits bounded per-key retries", async () => {
  const root = await mkdtemp(join(tmpdir(), "selector-sampling-shape-")); roots.push(root);
  const codec = await ModelSourceHandles.open(root);
  const dispatch = vi.fn(async () => ({ ok: true }));
  const definition = codec.wrapTools(createPiTools({ usesSelectorCompiler: true, dispatch } as any))
    .find(entry => entry.name === "stage_target_selector_draft")!;
  const tool = wrapRegisteredTool({ definition, extensionPath: "test" } as any, {
    createToolContext: () => ({}), getActiveTools: () => [definition.name],
  } as any);
  const samplingFields = [
    "status", "rule_key", "branch_keys", "quantity_span_ids", "script_span_ids",
    "condition_span_ids", "reason", "confidence",
  ];
  const samplingSchema = (tool.parameters as any).properties.draft.properties.items.items.properties.sampling;
  expect(samplingSchema.required).toEqual(samplingFields);
  expect(TARGET_SELECTOR_PROTOCOLS.patch).toContain("完整 sampling 的 status/rule_key/branch_keys/三个 span 数组/reason/confidence");
  expect(TARGET_SELECTOR_PROTOCOLS.patch).toContain("纯 upsert 可拆小批，但每条完整");

  const emptyField = () => ({ composition: "not_applicable", span_ids: [], separator: "", reason: "原文未规定该字段" });
  const completeItem = (key: string) => ({
    key, lot_key: "lot-probe", name: "项目名称", category: "一般项目",
    criterion_span_ids: [], continuation_span_ids: [],
    fields: { name: emptyField(), requirement: emptyField(), method: emptyField(), quantity: emptyField(), note: emptyField() },
    table: null,
    inspection_data_type: "review", inspection_data_type_reason: "只验证参数结构", inspection_data_type_span_ids: [],
    sampling: { status: "not_sampling", rule_key: "", branch_keys: [], quantity_span_ids: [], script_span_ids: [], condition_span_ids: [], reason: "只验证参数结构", confidence: 1 },
    reason: "只验证完整 item 参数结构",
  });
  const first = completeItem("item-first");
  const second = completeItem("item-second") as any;
  delete second.sampling.script_span_ids;
  const rejected = { operation: "upsert", collection: "items", draft: { items: [first, second] }, source_handle_scope: codec.scope };
  const before = JSON.stringify(rejected);
  let receipt: any;
  try { tool.prepareArguments!(rejected); } catch (error) { receipt = JSON.parse((error as Error).message); }
  expect(receipt).toMatchObject({
    error: "tool_argument_shape_invalid",
    durable_mutation: false,
    budget_consumed: false,
    terminal: false,
    complete_record_fields: { item_sampling: samplingFields },
    issues: [expect.objectContaining({
      code: "tool_argument_required",
      path: "/draft/items/1/sampling/script_span_ids",
      writable_path: "/draft/items/1/sampling/script_span_ids",
      field: "script_span_ids",
      actual: { missing: true },
      expected: expect.objectContaining({ type: "array", description: expect.stringContaining("所有其他模式必须填 []"),
        items: expect.objectContaining({ alternatives: [
          { type: "string", pattern: expect.stringContaining("span:") },
          expect.objectContaining({ type: "string", pattern: "^[seart][1-9][0-9]*$", description: expect.stringContaining("span 的 sN句柄") }),
        ], choice_rule: expect.stringContaining("不要把所有") }) }),
    })],
    instruction: expect.stringContaining("纯 upsert 可按 key 拆成多个较小批次重试"),
  });
  expect(receipt.instruction).toContain("每个小批中的每条记录仍须包含 schema 的全部必填字段");
  expect(receipt.instruction).toContain("最初计划提交的全部 key 最终都要成功保存");
  expect(receipt.instruction).toContain("item.sampling 必须完整保留 status、rule_key、branch_keys、quantity_span_ids、script_span_ids、condition_span_ids、reason、confidence");
  expect(receipt.instruction).toContain("含 remove_keys 或 quote_bindings 时");
  expect(JSON.stringify(rejected)).toBe(before);
  expect(dispatch).not.toHaveBeenCalled();

  for (const key of ["item-first", "item-second"]) {
    const args = { operation: "upsert", collection: "items", draft: { items: [completeItem(key)] }, source_handle_scope: codec.scope };
    const prepared = tool.prepareArguments!(args);
    const validated = validateToolArguments(tool, { id: `retry-${key}`, name: tool.name, arguments: prepared });
    await tool.execute(`retry-${key}`, validated, undefined as any, undefined as any, undefined as any);
  }
  expect(dispatch).toHaveBeenCalledTimes(2);
  expect(dispatch.mock.calls.map(call => call[1].draft.items[0].key)).toEqual(["item-first", "item-second"]);
});

test("the provider schema and required-field receipt describe each sampling branch reason", async () => {
  const root = await mkdtemp(join(tmpdir(), "selector-sampling-branch-reason-")); roots.push(root);
  const codec = await ModelSourceHandles.open(root);
  const dispatch = vi.fn();
  const definition = codec.wrapTools(createPiTools({ usesSelectorCompiler: true, dispatch } as any))
    .find(entry => entry.name === "stage_target_selector_draft")!;
  const tool = wrapRegisteredTool({ definition, extensionPath: "test" } as any, {
    createToolContext: () => ({}), getActiveTools: () => [definition.name],
  } as any);
  const branchSchema = (tool.parameters as any).properties.draft.properties.sampling_rules.items.properties.branches.items;
  expect(branchSchema.required).toEqual(["key", "applies_to_category", "components", "reason"]);
  expect(branchSchema.properties.reason).toMatchObject({
    type: "string",
    description: expect.stringContaining("分支的适用范围和 components 组织依据"),
  });
  expect(branchSchema.properties.reason.description).toContain("独立于 sampling_rules[].reason");
  expect(TARGET_SELECTOR_PROTOCOLS.sampling).toContain("每个完整 branch 独立 reason");

  const raw = { operation: "upsert", draft: { sampling_rules: [{
    key: "rule-probe", complete_span_ids: [], components: [],
    branches: [{ key: "branch-probe", applies_to_category: "all_items", components: [] }],
    reason: "只验证共享规则参数结构",
  }] } };
  const before = JSON.stringify(raw);
  let receipt: any;
  try { tool.prepareArguments!(raw); } catch (error) { receipt = JSON.parse((error as Error).message); }
  expect(receipt).toMatchObject({
    error: "tool_argument_shape_invalid",
    durable_mutation: false,
    budget_consumed: false,
    next_tool: "stage_target_selector_draft",
    issues: [{
      code: "tool_argument_required",
      path: "/draft/sampling_rules/0/branches/0/reason",
      writable_path: "/draft/sampling_rules/0/branches/0/reason",
      field: "reason",
      actual: { missing: true },
      expected: { type: "string", description: expect.stringContaining("该分支 components[].reason") },
      how_to_pass: expect.any(String),
      next_tool: "stage_target_selector_draft",
    }],
  });
  expect(JSON.stringify(raw)).toBe(before);
  expect(dispatch).not.toHaveBeenCalled();
});

test("the actual SDK loop sends the structured rejection to the model before executing any tool", async () => {
  const { wrapped, execute } = await fixture();
  const tool = wrapRegisteredTool({ definition: wrapped, extensionPath: "test" } as any, { createToolContext: () => ({}), getActiveTools: () => [wrapped.name] } as any);
  const call = { type: "toolCall", id: "bad-call", name: tool.name, arguments: { items: [{ name: "构件", sampling: { status: "present", script_span_ids: [], extra: 1 } }] } };
  const message = { role: "assistant", content: [call], api: "test", provider: "test", model: "test", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: Date.now() };
  let n = 0; const contexts: any[] = [];
  const streamFn = async (_model: unknown, context: any) => {
    contexts.push({ messages: structuredClone(context.messages) });
    const result = n++ === 0 ? message : { ...message, content: [{ type: "text", text: "结束试验" }], stopReason: "stop" };
    return { async *[Symbol.asyncIterator]() { yield { type: "done", reason: result.stopReason, message: result }; }, result: async () => result };
  };
  const stream = agentLoop([{ role: "user", content: [{ type: "text", text: "只测试参数回条" }], timestamp: Date.now() }], { systemPrompt: "只测试工具边界", messages: [], tools: [tool] }, { model: {}, convertToLlm: (messages: any) => messages }, undefined, streamFn);
  for await (const _ of stream) { /* exercise native prepare/validate/event/persist loop */ }
  const result = contexts[1].messages.find((entry: any) => entry.role === "toolResult");
  expect(result.isError).toBe(true);
  expect(JSON.parse(result.content[0].text)).toMatchObject({ error: "tool_argument_shape_invalid", issues: [expect.objectContaining({ path: "/items/0/sampling/extra" })] });
  expect(execute).not.toHaveBeenCalled();
});

test("SDK rejection names the complete unapplied batch, and the repaired batch reaches dispatch intact", async () => {
  const root = await mkdtemp(join(tmpdir(), "sdk-batch-receipt-")); roots.push(root);
  const codec = await ModelSourceHandles.open(root);
  const execute = vi.fn(async (_id, args) => ({ content: [], details: args }));
  const original = defineTool({ name: "stage_target_selector_draft", label: "事务回条", description: "只测参数反馈",
    parameters: Type.Object({ operation: Type.Literal("upsert"), collection: Type.String(), remove_keys: Type.Array(Type.String()),
      draft: Type.Object({ items: Type.Array(Type.Object({ key: Type.String(), values: Type.Array(Type.String()) })) }) }), execute });
  const tool = codec.wrapTools([original])[0]!;
  const args = { operation: "upsert", collection: "items", remove_keys: ["obsolete"], draft: { items: [
    { key: "unchanged", values: ["a"] }, { key: "invalid", values: [["b"]] }, { key: "also-unapplied", values: ["c"] },
  ] } };
  const before = JSON.stringify(args);
  let receipt: any;
  try { tool.prepareArguments!(args); } catch (error) { receipt = JSON.parse((error as Error).message); }
  expect(receipt).toMatchObject({ durable_mutation: false,
    issues: [{ path: "/draft/items/1/values/0", expected: { json_type: "string" } }],
    mutation_receipt: { status: "not_applied", operation: "upsert", remove_keys: ["obsolete"], remove_collection: "items",
      collections: [{ collection: "items", submitted_keys: ["unchanged", "invalid", "also-unapplied"] }] } });
  expect(execute).not.toHaveBeenCalled(); expect(JSON.stringify(args)).toBe(before);
  const repaired = structuredClone(args); repaired.draft.items[1]!.values = ["b"];
  const checked = validateToolArguments(tool, { id: "retry-batch", name: tool.name, arguments: tool.prepareArguments!(repaired) });
  await tool.execute("retry-batch", checked as any, undefined as any, undefined as any, undefined as any);
  expect(execute).toHaveBeenCalledOnce();
  expect(execute.mock.calls[0]![1]).toEqual(repaired);
});
