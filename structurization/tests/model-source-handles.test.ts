import { mkdtemp, readFile, rm, writeFile, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { Ajv } from "ajv";
import { Type } from "typebox";
import { defineTool, SessionManager } from "@earendil-works/pi-coding-agent";
import { sha256Json } from "../src/canonical.js";
import { ModelSourceHandles, SOURCE_HANDLE_INSTRUCTION, SOURCE_HANDLE_SCOPE_FIELD, SOURCE_HANDLE_SESSION_ENTRY, sourceHandleSessionMatches } from "../src/model-source-handles.js";
import { createPiTools } from "../src/tools.js";
import { classifyCompilerInvariantIssues } from "../src/selector-issue-ownership.js";

const span = `span:${"a".repeat(32)}`, evidence = `evidence:${"b".repeat(64)}`, atom = `atom:${"c".repeat(64)}`;
const roots: string[] = [];
async function fresh() { const root = await mkdtemp(join(tmpdir(),"pi-source-handles-")); roots.push(root); return {root,codec:await ModelSourceHandles.open(root)}; }
afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});});

describe("model-only source handles",()=>{
  test.each(["missing-separator", "upper-case", "compact"])("normalizes only the same UUID identity (%s), retaining the map and typed checks", async format => {
    const { codec } = await fresh();
    await codec.encode({ evidence_id: evidence });
    const before = await readFile(codec.mapPath, "utf8");
    const supplied = format === "missing-separator" ? codec.scope.replace("-", "")
      : format === "upper-case" ? codec.scope.toUpperCase() : codec.scope.replaceAll("-", "");
    expect(await codec.decodeArguments({ evidence_id: "e1", source_handle_scope: supplied })).toEqual({ evidence_id: evidence });
    await expect(codec.decodeArguments({ span_id: "e1", source_handle_scope: supplied })).rejects.toMatchObject({ code: "source_handle_wrong_type" });
    const other = await fresh();
    await expect(codec.decodeArguments({ evidence_id: "e1", source_handle_scope: other.codec.scope.replaceAll("-", "") }))
      .rejects.toMatchObject({ code: "source_handle_scope_mismatch" });
    await expect(codec.decodeArguments({ evidence_id: "e1", source_handle_scope: codec.scope.slice(0, 8) + codec.scope }))
      .rejects.toMatchObject({ code: "source_handle_scope_mismatch" });
    expect(await readFile(codec.mapPath, "utf8")).toBe(before);
  });

  test.each(["compiler_unhandled_evidence", "compiler_semantic_primary_atom_unclassified"])("%s repair identity uses the same typed public handles as its source reads", async code => {
    const { codec } = await fresh();
    const selectors = { items: [], references: [], source_dispositions: [] } as any;
    const registry = { spans: [{ span_id: span, evidence_id: evidence, atom_id: atom, start: 0, end: 12 }] } as any;
    const before = JSON.stringify({ selectors, registry });
    const [issue] = classifyCompilerInvariantIssues(selectors, registry, [{
      code, path: "/semantic_evidence", message: "source has no compiled receiver",
      details: { evidence_ids: [evidence, atom] },
    }]);
    const short = await codec.encode(issue) as any;
    expect(short.details.repair_identity).toEqual({ kind: "evidence_id", evidence_ids: ["e1", "a1"] });
    expect(short.details.repair_identity.evidence_ids).toEqual(short.details.actual.evidence_ids);
    expect(JSON.stringify(short)).not.toMatch(/(?:span|evidence|atom):/u);
    expect(await codec.decodeResponse({ ...short, source_handle_scope: codec.scope })).toEqual(issue);
    expect(await codec.decodeArguments({ evidence_id: short.details.repair_identity.evidence_ids[0], source_handle_scope: codec.scope }))
      .toEqual({ evidence_id: evidence });
    expect(JSON.stringify({ selectors, registry })).toBe(before);
  });
  test("typed ID dictionaries retain their role through nested field lists without rewriting record prose", async () => {
    const { codec } = await fresh();
    const value = {
      field_span_ids: { alpha: [span], beta: [] },
      binding_evidence_ids: { criterion: [evidence], continuation: [], fields: { method: [evidence] } },
      current_rows: [{ row_id: evidence, note: "e1", reason: span, nested: { quote: "s1" } }],
      text: `自由文字 ${span} 和 e1`,
    };
    const short = await codec.encode(value) as any;
    expect(short.field_span_ids).toEqual({ alpha: ["s1"], beta: [] });
    expect(short.binding_evidence_ids).toEqual({ criterion: ["e1"], continuation: [], fields: { method: ["e1"] } });
    expect(short.current_rows).toEqual([{ row_id: "e1", note: "e1", reason: span, nested: { quote: "s1" } }]);
    expect(short.text).toBe(value.text);
    expect(await codec.decodeResponse({ ...short, source_handle_scope: codec.scope })).toEqual(value);
    expect(await codec.decodeArguments({ field_span_ids: short.field_span_ids, source_handle_scope: codec.scope }))
      .toEqual({ field_span_ids: value.field_span_ids });
    await expect(codec.decodeArguments({ field_span_ids: { alpha: ["e1"] }, source_handle_scope: codec.scope }))
      .rejects.toMatchObject({ code: "source_handle_wrong_type", details: { argument_path: "/field_span_ids/alpha/0" } });
    await expect(codec.decodeArguments({ binding_evidence_ids: short.binding_evidence_ids, source_handle_scope: "different" }))
      .rejects.toMatchObject({ code: "source_handle_scope_mismatch" });
  });
  test("hierarchy atom disposition keys round trip in catalogs, repairs and keyed edits", async () => {
    const { codec } = await fresh();
    const identity = { collection: "atom_dispositions", key: atom };
    const response = { record_catalog: { atom_dispositions: [identity] }, repair_targets: [identity] };
    const short = await codec.encode(response) as any;
    expect(short.record_catalog.atom_dispositions[0].key).toBe("a1");
    expect(short.repair_targets[0].key).toBe("a1");
    const args = { edits: [{ ...identity, op: "update", value: { reason: "a1 is free text" } }] };
    const shortArgs = await codec.encode(args) as any;
    expect(shortArgs.edits[0].key).toBe("a1");
    expect(await codec.decodeArguments({ ...shortArgs, source_handle_scope: codec.scope })).toEqual(args);
    await expect(codec.decodeArguments({ edits: [{ ...shortArgs.edits[0], key: "a99" }], source_handle_scope: codec.scope }))
      .rejects.toMatchObject({ code: "source_handle_unknown" });
    expect(await codec.encode({ collection: "nodes", key: "a1" })).toEqual({ collection: "nodes", key: "a1" });
  });

  test("reference occurrence and target handles round trip through tools, errors, patches and legacy maps", async () => {
    const { root, codec } = await fresh();
    // Existing v1 maps with only source IDs remain valid and retain their assignments.
    await codec.encode({ span_id: span, evidence_id: evidence });
    const reopened = await ModelSourceHandles.open(root);
    const occurrence = `reference:${"d".repeat(64)}`;
    const target = `reference-target:${"f".repeat(64)}`;
    const value = {
      occurrence_id: occurrence, target_key: target,
      details: { occurrence_ids: [occurrence], requested_target_key: target },
      text: `原文 ${occurrence}`, reason: target,
    };
    const encoded = await reopened.encode(value) as any;
    expect(encoded).toEqual({
      occurrence_id: "r1", target_key: "t1",
      details: { occurrence_ids: ["r1"], requested_target_key: "t1" },
      text: value.text, reason: target,
    });
    expect(await reopened.encode({ target_key: "business-target", span_id: span, evidence_id: evidence }))
      .toEqual({ target_key: "business-target", span_id: "s1", evidence_id: "e1" });
    expect(await reopened.decodeArguments({ ...encoded, source_handle_scope: reopened.scope })).toEqual(value);
    await expect(reopened.decodeArguments({ target_key: "r1", source_handle_scope: reopened.scope }))
      .rejects.toMatchObject({ code: "source_handle_wrong_type" });
    await expect(reopened.decodeArguments({ occurrence_id: "r1" }))
      .rejects.toMatchObject({ code: "source_handle_scope_required" });
    await expect(reopened.decodeArguments({ target_key: "t1", source_handle_scope: "wrong" }))
      .rejects.toMatchObject({ code: "source_handle_scope_mismatch" });
    await expect(reopened.decodeArguments({ target_key: "t99", source_handle_scope: reopened.scope }))
      .rejects.toMatchObject({ code: "source_handle_unknown" });
    const patch = { operations: [{ op: "replace", path: "/references/0/occurrence_id", value: occurrence }] };
    const shortPatch = await reopened.encode(patch) as any;
    expect(shortPatch.operations[0].value).toBe("r1");
    expect(await reopened.decodeArguments({ ...shortPatch, source_handle_scope: reopened.scope })).toEqual(patch);
    const execute = vi.fn(async (_id: string, args: any) => ({
      content: [{ type: "text" as const, text: JSON.stringify({ ok: false, details: args }) }], details: args,
    }));
    const original = defineTool({ name: "reference_probe", label: "Reference", description: "Reference test",
      parameters: Type.Object({ occurrence_id: Type.String({ pattern: "^reference:[a-f0-9]{64}$" }),
        target_key: Type.String({ pattern: "^reference-target:[a-f0-9]{64}$" }) }), execute });
    const [wrapped] = reopened.wrapTools([original]);
    const args = { occurrence_id: "r1", target_key: "t1", source_handle_scope: reopened.scope };
    expect(new Ajv({ strict: false }).compile(wrapped!.parameters)(args)).toBe(true);
    const result = await wrapped!.execute("ref-call", args, undefined as any, undefined as any, undefined as any);
    expect(execute.mock.calls[0]?.[1]).toEqual({ occurrence_id: occurrence, target_key: target });
    expect(JSON.parse((result.content[0] as any).text).details).toEqual({ occurrence_id: "r1", target_key: "t1" });
    expect(result.details).toEqual({ occurrence_id: occurrence, target_key: target });
    const again = await ModelSourceHandles.open(root);
    expect(await again.encode(value)).toEqual(encoded);
    const stored = JSON.parse(await readFile(again.mapPath, "utf8"));
    expect(stored.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ handle: "r1", canonical_id: occurrence }),
      expect.objectContaining({ handle: "t1", canonical_id: target }),
    ]));
  });

  test("round trips typed IDs, nested table paths and repeated identities without rewriting source/free text",async()=>{
    const {codec}=await fresh();
    const value={span_id:span,evidence_id:evidence,atom_id:atom,source_id:evidence,
      item:{criterion_span_ids:[span],table:{row_path_span_ids:[[span,span]],reference_span_ids:[span]}},
      text:`原文中的 ${span}、s1 与 e1 均须保持原样。`,reason:JSON.stringify({span_id:span}),scope_note:"source_handle_scope"};
    const encoded=await codec.encode(value) as any;
    expect(encoded).toMatchObject({span_id:"s1",evidence_id:"e1",atom_id:"a1",source_id:"e1",item:{table:{row_path_span_ids:[["s1","s1"]]}}});
    expect(encoded.text).toBe(value.text);expect(encoded.reason).toBe(value.reason);
    expect(await codec.decodeResponse({...encoded,[SOURCE_HANDLE_SCOPE_FIELD]:codec.scope})).toEqual(value);
    // A canonical source may be called an atom and an evidence by legacy registries.
    const legacy=await codec.encode({atom_id:evidence,evidence_id:evidence}) as any;
    expect(legacy.atom_id).toBe(legacy.evidence_id);
    expect(await codec.decodeArguments({...legacy,[SOURCE_HANDLE_SCOPE_FIELD]:codec.scope})).toEqual({atom_id:evidence,evidence_id:evidence});
  });

  test("rejects unknown, missing-scope, wrong-type and cross-scope handles without guessing",async()=>{
    const {codec}=await fresh(),other=await fresh();
    await codec.encode({span_id:span,evidence_id:evidence,atom_id:atom});
    await other.codec.encode({span_id:`span:${"d".repeat(32)}`});
    const before=await readFile(codec.mapPath,"utf8");
    await expect(codec.decodeArguments({span_id:"s1"})).rejects.toMatchObject({
      code:"source_handle_scope_required", details:{argument_path:"/span_id",writable_path:"/span_id"},
    });
    await expect(codec.decodeArguments({span_id:"s999",source_handle_scope:codec.scope})).rejects.toMatchObject({
      code:"source_handle_unknown", details:{argument_path:"/span_id",writable_path:"/span_id"},
    });
    await expect(codec.decodeArguments({span_id:"e1",source_handle_scope:codec.scope})).rejects.toMatchObject({
      code:"source_handle_wrong_type", details:{argument_path:"/span_id",writable_path:"/span_id"},
    });
    await expect(codec.decodeArguments({evidence_id:"a1",source_handle_scope:codec.scope})).rejects.toMatchObject({code:"source_handle_wrong_type"});
    await expect(other.codec.decodeArguments({span_id:"s1",source_handle_scope:codec.scope})).rejects.toMatchObject({code:"source_handle_scope_mismatch"});
    expect(await readFile(codec.mapPath,"utf8")).toBe(before);
    expect(await codec.decodeArguments({span_id:span,evidence_id:evidence})).toEqual({span_id:span,evidence_id:evidence});
  });

  test("reports the exact escaped argument path and an evidence-to-span read route without choosing a replacement", async () => {
    const { codec } = await fresh();
    await codec.encode({ evidence_id: evidence, span_id: span });
    const execute = vi.fn(async (_id: string, args: any) => ({ content: [], details: args }));
    const stage = defineTool({
      name: "stage_probe", label: "Stage", description: "Neutral typed-handle probe",
      parameters: Type.Object({
        table: Type.Object({
          note_rows: Type.Array(Type.String()),
          note_span_ids: Type.Array(Type.String()),
        }),
      }, { additionalProperties: false }), execute,
    });
    const openEvidence = defineTool({
      name: "open_evidence", label: "Open", description: "Open one evidence record",
      parameters: Type.Object({ evidence_id: Type.String() }, { additionalProperties: false }), execute,
    });
    const [wrapped] = codec.wrapTools([stage, openEvidence]);
    const wrongSpan = await wrapped!.execute("wrong-span", {
      table: { note_rows: ["e1"], note_span_ids: ["e1"] }, source_handle_scope: codec.scope,
    }, undefined as any, undefined as any, undefined as any);
    expect(wrongSpan.details).toMatchObject({
      ok: false, error: "source_handle_wrong_type", handle: "e1",
      expected_type: "span", actual_type: "evidence",
      argument_path: "/table/note_span_ids/0", writable_path: "/table/note_span_ids/0",
      next_tool: "open_evidence",
      tool_arguments: { evidence_id: "e1", source_handle_scope: codec.scope },
      retry_tool: "stage_probe",
    });
    expect((wrongSpan.details as any).instruction).toContain("工具不会替你选择 span");
    expect(JSON.parse((wrongSpan.content[0] as any).text)).toMatchObject({
      error: "source_handle_wrong_type",
      argument_path: "/table/note_span_ids/0",
      writable_path: "/table/note_span_ids/0",
      next_tool: "open_evidence",
      tool_arguments: { evidence_id: "e1", source_handle_scope: codec.scope },
    });
    expect(execute).not.toHaveBeenCalled();

    const wrongRow = await wrapped!.execute("wrong-row", {
      table: { note_rows: ["s1"], note_span_ids: ["s1"] }, source_handle_scope: codec.scope,
    }, undefined as any, undefined as any, undefined as any);
    expect(wrongRow.details).toMatchObject({
      error: "source_handle_wrong_type", handle: "s1",
      expected_type: "evidence", actual_type: "span",
      argument_path: "/table/note_rows/0", writable_path: "/table/note_rows/0",
      next_tool: "stage_probe", retry_tool: "stage_probe",
    });

    const escaped = await wrapped!.execute("escaped", {
      "table/~copy": { note_rows: ["e1"], note_span_ids: ["e1"] }, source_handle_scope: codec.scope,
    } as any, undefined as any, undefined as any, undefined as any);
    expect(escaped.details).toMatchObject({
      error: "source_handle_wrong_type",
      argument_path: "/table~1~0copy/note_span_ids/0",
      writable_path: "/table~1~0copy/note_span_ids/0",
    });
    const atomOnly = await codec.encode({ atom_id: atom }) as any;
    const atomAsSpan = await wrapped!.execute("atom-only", { table: { note_rows: ["e1"], note_span_ids: [atomOnly.atom_id] },
      source_handle_scope: codec.scope }, undefined as any, undefined as any, undefined as any);
    expect(atomAsSpan.details).toMatchObject({ error: "source_handle_wrong_type", actual_type: "atom", next_tool: "stage_probe" });
    expect(atomAsSpan.details).not.toHaveProperty("tool_arguments");
    expect(execute).not.toHaveBeenCalled();
  });

  test("describes table row and span handles without encoding a business answer", () => {
    const stage = createPiTools({ usesSelectorCompiler: true } as any).find(tool => tool.name === "stage_table_structure")!;
    const table = (stage.parameters as any).properties.table.properties;
    expect(table.note_rows.description).toContain("evidence句柄");
    expect(table.note_span_ids.description).toContain("span句柄");
  });

  test("uses explicit JSON Patch source-field paths for scalar/array values while preserving free text",async()=>{
    const {codec}=await fresh();
    const args={operations:[{op:"replace",path:"/items/0/criterion_span_ids/0",value:span},{op:"replace",path:"/targets/0/evidence_atom_ids",value:[atom]},{op:"replace",path:"/items/0/reason",value:`s1 ${span}`}]};
    const short=await codec.encode(args) as any;
    expect(short.operations[0].value).toBe("s1");expect(short.operations[1].value).toEqual(["a1"]);expect(short.operations[2].value).toBe(args.operations[2]!.value);
    expect(await codec.decodeArguments({...short,source_handle_scope:codec.scope})).toEqual(args);
  });

  test("persists one-to-one assignments across reopens and rebuilds a new revision from canonical IDs with a new scope",async()=>{
    const first=await fresh();
    const original=await first.codec.encode({span_ids:[span,`span:${"d".repeat(32)}`],evidence_id:evidence});
    const reopened=await ModelSourceHandles.open(first.root);
    expect(reopened.scope).toBe(first.codec.scope);
    expect(await reopened.encode({span_ids:[span,`span:${"d".repeat(32)}`],evidence_id:evidence})).toEqual(original);
    const revision=await fresh();
    expect(revision.codec.scope).not.toBe(first.codec.scope);
    const rebuilt=await revision.codec.encode({span_id:span}) as any;
    expect(await revision.codec.decodeArguments({...rebuilt,source_handle_scope:revision.codec.scope})).toEqual({span_id:span});
    await expect(revision.codec.decodeArguments({...rebuilt,source_handle_scope:first.codec.scope})).rejects.toMatchObject({code:"source_handle_scope_mismatch"});
  });

  test.each(["duplicate_handle","duplicate_canonical","checksum"])("rejects a damaged persisted map: %s",async(mode)=>{
    const {root,codec}=await fresh();await codec.encode({span_ids:[span,`span:${"d".repeat(32)}`]});
    const stored=JSON.parse(await readFile(codec.mapPath,"utf8"));
    if(mode==="duplicate_handle")stored.entries[1].handle=stored.entries[0].handle;
    if(mode==="duplicate_canonical")stored.entries[1].canonical_id=stored.entries[0].canonical_id;
    if(mode==="checksum")stored.checksum="damaged";
    else {const {checksum,...state}=stored;stored.checksum=sha256Json(state);}
    await writeFile(codec.mapPath,JSON.stringify(stored));
    await expect(ModelSourceHandles.open(root)).rejects.toMatchObject({code:mode==="checksum"?"source_handle_map_corrupt":"source_handle_map_collision_or_invalid_entry"});
  });

  test("rejects copied cross-target maps and does not silently replace a missing mapping",async()=>{
    const a=await fresh(),b=await fresh();await a.codec.encode({span_id:span});
    await copyFile(a.codec.mapPath,b.codec.mapPath);
    await copyFile(join(a.codec.directory,"owner.json"),join(b.codec.directory,"owner.json"));
    await expect(ModelSourceHandles.open(b.root)).rejects.toMatchObject({code:"source_handle_owner_mismatch"});
    await rm(a.codec.mapPath);
    await expect(ModelSourceHandles.open(a.root)).rejects.toMatchObject({code:"source_handle_map_incomplete"});
  });

  test("serializes concurrent encoders without collisions or reassignments",async()=>{
    const {root,codec}=await fresh(),another=await ModelSourceHandles.open(root);
    const values=await Promise.all(Array.from({length:12},(_,i)=>(i%2?codec:another).encode({evidence_id:`evidence:${i}`})));
    expect(new Set(values.map((v:any)=>v.evidence_id)).size).toBe(12);
    const reloaded=await ModelSourceHandles.open(root);
    for(let i=0;i<values.length;i++)expect(await reloaded.decodeArguments({...values[i] as any,source_handle_scope:codec.scope})).toEqual({evidence_id:`evidence:${i}`});
  });

  test("advertises short arguments, validates decoded canonical arguments, and shortens actual model content rather than internal details",async()=>{
    const {codec}=await fresh();const execute=vi.fn(async(_id:string,args:any)=>({content:[{type:"text" as const,text:JSON.stringify({ok:true,...args})}],details:{ok:true,...args}}));
    const original=defineTool({name:"echo_source",label:"Source",description:"A source-bound operation",parameters:Type.Object({span_ids:Type.Array(Type.String({pattern:"^span:[a-f0-9]{32}$"})),evidence_id:Type.String(),quote:Type.String()},{additionalProperties:false}),execute});
    const [wrapped]=codec.wrapTools([original]);
    const canonical={span_ids:[span,span,span,span],evidence_id:evidence,quote:`不得改写原文 ${evidence}`};
    const short=await codec.encode(canonical) as any;
    const args={...short,source_handle_scope:codec.scope};
    expect(new Ajv({strict:false}).compile(wrapped!.parameters)(args)).toBe(true);
    const result=await wrapped!.execute("call-1",args,undefined as any,undefined as any,undefined as any);
    expect(execute.mock.calls[0]?.[1]).toEqual(canonical);
    const visible=JSON.parse((result.content[0] as any).text);
    expect(visible.span_ids).toEqual(["s1","s1","s1","s1"]);
    expect(visible.quote).toBe(canonical.quote);
    expect(result.details).toEqual({ok:true,...canonical});
    const request={model:"gpt-5.6-terra",messages:[{role:"system",content:`Rules\n\n${SOURCE_HANDLE_INSTRUCTION}`},{role:"assistant",content:null,tool_calls:[{id:"call-1",type:"function",function:{name:original.name,arguments:JSON.stringify(args)}}]},{role:"tool",tool_call_id:"call-1",content:(result.content[0] as any).text}],tools:[{type:"function",function:{name:original.name,parameters:wrapped!.parameters}}]};
    const expected={...request,messages:[{role:"system",content:"Rules"},{role:"assistant",content:null,tool_calls:[{id:"call-1",type:"function",function:{name:original.name,arguments:JSON.stringify(canonical)}}]},{role:"tool",tool_call_id:"call-1",content:JSON.stringify({ok:true,...canonical})}],tools:[{type:"function",function:{name:original.name,parameters:original.parameters}}]};
    const stats=codec.measureProviderPayload(request);
    expect(stats.actual_request_utf8_bytes).toBe(Buffer.byteLength(JSON.stringify(request)));
    expect(stats.canonical_equivalent_request_utf8_bytes).toBe(Buffer.byteLength(JSON.stringify(expected)));
    expect(stats.compared_tool_results).toBe(1);expect(stats.compared_tool_calls).toBe(1);
    expect(await codec.decodeResponse(visible)).toEqual({ok:true,...canonical});
    const invalid=await wrapped!.execute("call-2",{...args,span_ids:["e1"]},undefined as any,undefined as any,undefined as any);
    expect(invalid.details).toMatchObject({ok:false,error:"source_handle_wrong_type"});expect(execute).toHaveBeenCalledTimes(1);
  });

  test("keeps parameter meaning above canonical/handle alternatives without mutating the original schema", async () => {
    const { codec } = await fresh();
    const description = "本次读取的引用目标，取引用目录返回的 target_key。";
    const spanDescription = "引用所在来源段落。";
    const parameters = Type.Object({
      target_key: Type.String({ pattern: "^reference-target:[a-f0-9]{64}$", description }),
      origin_span_id: Type.Optional(Type.String({ pattern: "^span:[a-f0-9]{32}$", description: spanDescription })),
      evidence_ids: Type.Array(Type.Union([
        Type.String({ pattern: "^evidence:[a-f0-9]{64}$" }),
        Type.String({ pattern: "^atom:[a-f0-9]{64}$" }),
      ], { description: "需读取的来源，保留工具实际返回的身份。" })),
    }, { additionalProperties: false });
    const before = JSON.stringify(parameters);
    const [wrapped] = codec.wrapTools([defineTool({ name: "reference_schema_probe", label: "Reference",
      description: "Neutral reference schema probe", parameters, execute: async () => ({ content: [] }) })]);
    const visible = JSON.parse(JSON.stringify(wrapped!.parameters));
    expect(visible.properties.target_key.description).toBe(description);
    expect(visible.properties.target_key.anyOf[0]).not.toHaveProperty("description");
    expect(visible.properties.target_key.anyOf[1].description).toContain("target_key 的 tN");
    expect(visible.properties.origin_span_id.description).toBe(spanDescription);
    expect(visible.properties.origin_span_id.anyOf[1].description).toContain("span 的 sN");
    expect(visible.properties.evidence_ids.items.description).toBe(parameters.properties.evidence_ids.items.description);
    expect(visible.properties.evidence_ids.items.anyOf[1].anyOf[1].description).toContain("历史 atom/evidence 别名");
    expect(JSON.stringify(parameters)).toBe(before);
    expect(visible.required).toEqual(["target_key", "evidence_ids"]);

    // This is a documentation change: the schema still accepts both wire formats,
    // and leaves handle identity/role checking to the existing decoder.
    const validate = new Ajv({ strict: false }).compile(visible);
    const target = `reference-target:${"d".repeat(64)}`;
    for (const target_key of [target, "s1", "e1", "a1", "r1", "t1"]) {
      expect(validate({ target_key, evidence_ids: [] }), target_key).toBe(true);
    }
    expect(validate({ target_key: "t0", evidence_ids: [] })).toBe(false);
    expect(validate({ target_key: "t1", evidence_ids: [atom, evidence, "a1", "e1"], origin_span_id: "s1" })).toBe(true);
  });

  test("clarified handle schemas retain canonical callers, emitted legacy aliases and runtime rejection", async () => {
    const { codec } = await fresh();
    const target = `reference-target:${"d".repeat(64)}`;
    const occurrence = `reference:${"f".repeat(64)}`;
    const canonical = { target_key: target, origin_span_id: span, evidence_ids: [evidence, atom] };
    const short = await codec.encode(canonical) as any;
    const extra = await codec.encode({ occurrence_id: occurrence, atom_id: `atom:${"e".repeat(64)}` }) as any;
    const execute = vi.fn(async (_id: string, args: any) => ({ content: [], details: args }));
    const [wrapped] = codec.wrapTools([defineTool({ name: "reference_runtime_probe", label: "Reference",
      description: "Neutral reference runtime probe", parameters: Type.Object({
        target_key: Type.String({ pattern: "^reference-target:[a-f0-9]{64}$", description: "引用目标" }),
        origin_span_id: Type.String({ pattern: "^span:[a-f0-9]{32}$", description: "来源段落" }),
        evidence_ids: Type.Array(Type.Union([
          Type.String({ pattern: "^evidence:[a-f0-9]{64}$" }),
          Type.String({ pattern: "^atom:[a-f0-9]{64}$" }),
        ])),
      }, { additionalProperties: false }), execute })]);
    const call = (id: string, args: any) => wrapped!.execute(id, args, undefined as any, undefined as any, undefined as any);
    const args = { ...short, source_handle_scope: codec.scope };
    const persistedBefore = await readFile(codec.mapPath, "utf8");
    await call("canonical", canonical);
    await call("short-and-emitted-alias", args);
    expect(execute.mock.calls.map(([, value]) => value)).toEqual([canonical, canonical]);
    for (const [id, input, error] of [
      ["wrong-target-role", { ...args, target_key: extra.occurrence_id }, "source_handle_wrong_type"],
      ["wrong-span-role", { ...args, origin_span_id: short.evidence_ids[0] }, "source_handle_wrong_type"],
      ["unemitted-alias", { ...args, evidence_ids: [extra.atom_id] }, "source_handle_wrong_type"],
      ["unknown", { ...args, target_key: "t99" }, "source_handle_unknown"],
      ["missing-scope", short, "source_handle_scope_required"],
      ["other-scope", { ...args, source_handle_scope: "other-session" }, "source_handle_scope_mismatch"],
    ] as const) {
      expect((await call(id, input)).details, id).toMatchObject({ ok: false, error });
    }
    expect(execute).toHaveBeenCalledTimes(2);
    expect(await readFile(codec.mapPath, "utf8")).toBe(persistedBefore);
  });

  test("wrapped tool schemas are identical across sessions and do not embed the scope UUID",async()=>{
    const a=await fresh(),b=await fresh();
    expect(a.codec.scope).not.toBe(b.codec.scope);
    const original=defineTool({name:"echo_source",label:"Source",description:"A source-bound operation",parameters:Type.Object({span_id:Type.String()}),execute:async()=>({content:[]})});
    const [left]=a.codec.wrapTools([original]);
    const [right]=b.codec.wrapTools([original]);
    expect(JSON.stringify(left!.parameters)).toBe(JSON.stringify(right!.parameters));
    const advertised=JSON.stringify(left!.parameters);
    expect(advertised).not.toContain(a.codec.scope);
    expect(advertised).not.toContain(b.codec.scope);
    expect((left!.parameters as {properties?:{source_handle_scope?:{const?:unknown}}}).properties?.source_handle_scope?.const).toBeUndefined();
    const args={span_id:"s1",source_handle_scope:a.codec.scope};
    expect(new Ajv({strict:false}).compile(left!.parameters)(args)).toBe(true);
    await expect(a.codec.decodeArguments(args)).rejects.toMatchObject({code:"source_handle_unknown"});
    await expect(b.codec.decodeArguments({span_id:"s1",source_handle_scope:a.codec.scope})).rejects.toMatchObject({code:"source_handle_scope_mismatch"});
  });

  test("missing scope returns an exact top-level repair and never executes or rewrites the payload", async () => {
    const {codec} = await fresh();
    const execute = vi.fn(async (_id: string, args: any) => ({content: [], details: args}));
    const [tool] = codec.wrapTools([defineTool({name:"stage_probe", label:"Stage", description:"Test staging",
      parameters:Type.Object({span_ids:Type.Array(Type.String())}, {additionalProperties:false}), execute})]);
    await codec.encode({span_id:span});
    const args = {span_ids:["s1"]};
    const rejected = await tool!.execute("missing", args, undefined as any, undefined as any, undefined as any);
    expect(rejected.details).toMatchObject({ok:false, error:"source_handle_scope_required",
      argument_path:"/span_ids/0",
      writable_path:"/source_handle_scope", required_argument:{source_handle_scope:codec.scope},
      next_tool:"stage_probe", do_not_edit:expect.any(String)});
    expect(execute).not.toHaveBeenCalled();
    expect(args).toEqual({span_ids:["s1"]});
    const visible = JSON.parse((rejected.content[0] as any).text);
    await tool!.execute("repaired", {...args,...visible.required_argument}, undefined as any, undefined as any, undefined as any);
    expect(execute.mock.calls[0]?.[1]).toEqual({span_ids:[span]});
    const wrongScope = await tool!.execute("wrong-scope", {...args,source_handle_scope:"another-session"}, undefined as any, undefined as any, undefined as any);
    expect(wrongScope.details).toMatchObject({ok:false,error:"source_handle_scope_mismatch"});
    expect((wrongScope.details as any).instruction).toContain("不得只给旧句柄替换 source_handle_scope");
    expect(wrongScope.details).not.toHaveProperty("required_argument");
    expect(wrongScope.details).not.toHaveProperty("alternative_repair");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  test("wrong scope gives an executable current reference directory route without relabelling or executing the old payload", async () => {
    const { codec } = await fresh();
    const previous = await fresh();
    await previous.codec.encode({ target_key: "reference-target:neutral" });
    await codec.encode({ target_key: "reference-target:different-source" });
    const execute = vi.fn(async (_id: string, args: any) => ({ content: [], details: args }));
    const directoryExecute = vi.fn(async () => ({ content: [{ type: "text" as const, text: JSON.stringify({ occurrence_id: "reference:neutral", target_key: "reference-target:neutral" }) }] }));
    const [tool, directory] = codec.wrapTools([
      defineTool({ name: "read_reference_facts", label: "Reference", description: "Read current reference",
        parameters: Type.Object({ target_key: Type.String() }, { additionalProperties: false }), execute }),
      defineTool({ name: "list_reference_occurrences", label: "Directory", description: "Current directory",
        parameters: Type.Object({}, { additionalProperties: false }), execute: directoryExecute }),
    ]);
    const args = { target_key: "t1", source_handle_scope: previous.codec.scope };
    const before = await readFile(codec.mapPath, "utf8");
    const rejected = await tool!.execute("old", args, undefined as any, undefined as any, undefined as any);
    expect(rejected.details).toMatchObject({ ok: false, error: "source_handle_scope_mismatch",
      actual: { received_scope: previous.codec.scope, current_scope: codec.scope }, original_tool_executed: false, durable_mutation: false,
      source_arguments_to_reread: [{ argument_path: "/target_key", expected_type: "reference-target" }], source_arguments_complete: true,
      writable_paths: ["/source_handle_scope", "/target_key"], next_tool: "list_reference_occurrences", next_tool_arguments: {}, retry_tool: "read_reference_facts" });
    expect(rejected.details).not.toHaveProperty("required_argument"); expect(rejected.details).not.toHaveProperty("retry_arguments");
    expect(rejected.details).not.toHaveProperty("alternative_repair");
    expect(args).toEqual({ target_key: "t1", source_handle_scope: previous.codec.scope });
    expect(await readFile(codec.mapPath, "utf8")).toBe(before); expect(execute).not.toHaveBeenCalled();
    const canonicalRejected = await tool!.execute("old-canonical", { target_key: "reference-target:neutral", source_handle_scope: previous.codec.scope }, undefined as any, undefined as any, undefined as any);
    expect(canonicalRejected.details).toMatchObject({ next_tool: "list_reference_occurrences", source_argument_count: 1,
      source_arguments_to_reread: [{ argument_path: "/target_key", expected_type: "reference-target" }] });
    expect(canonicalRejected.details).not.toHaveProperty("alternative_repair");
    expect(execute).not.toHaveBeenCalled();
    const current = await directory!.execute("current", (rejected.details as any).next_tool_arguments, undefined as any, undefined as any, undefined as any);
    const visible = JSON.parse((current.content[0] as any).text);
    expect(visible).toMatchObject({ occurrence_id: "r1", target_key: "t2", source_handle_scope: codec.scope });
    await tool!.execute("confirmed", { target_key: visible.target_key, source_handle_scope: visible.source_handle_scope }, undefined as any, undefined as any, undefined as any);
    expect(execute).toHaveBeenCalledOnce(); expect(directoryExecute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]?.[1]).toEqual({ target_key: "reference-target:neutral" });
  });

  test("unknown handles provide an executable directory while preserving the entire unexecuted edit", async () => {
    const { codec } = await fresh();
    await codec.encode({ span_id: span });
    const execute = vi.fn(async (_id: string, args: any) => ({ content: [], details: args }));
    const edit = defineTool({ name: "stage_probe", label: "Stage", description: "A neutral author edit",
      parameters: Type.Object({ operation: Type.String(), collection: Type.String(), remove_keys: Type.Array(Type.String()),
        draft: Type.Object({ span_ids: Type.Array(Type.String()), reason: Type.String() }) }, { additionalProperties: false }), execute });
    const directory = defineTool({ name: "list_evidence_resources", label: "Directory", description: "Current source navigation",
      parameters: Type.Object({}, { additionalProperties: false }), execute: async () => ({ content: [{ type: "text" as const,
        text: JSON.stringify({ evidence_id: evidence }) }] }) });
    const originals = [edit, directory];
    const [wrapped, read] = codec.wrapTools(originals);
    const args = { operation: "upsert", collection: "source_dispositions", remove_keys: ["author-remove"],
      draft: { span_ids: ["s999"], reason: "原作者意图，不能因句柄错误重写" }, source_handle_scope: codec.scope };
    const before = await readFile(codec.mapPath, "utf8"), untouched = structuredClone(args);
    const rejected = await wrapped!.execute("unknown", args, undefined as any, undefined as any, undefined as any);
    const visible = JSON.parse((rejected.content[0] as any).text);
    expect(visible).toMatchObject({ error: "source_handle_unknown", handle: "s999", expected_type: "span",
      actual: { registered_in_current_scope: false }, argument_path: "/draft/span_ids/0", writable_path: "/draft/span_ids/0",
      next_tool: "list_evidence_resources", next_tool_arguments: {}, retry_tool: "stage_probe",
      original_tool_executed: false, durable_mutation: false, budget_consumed: false });
    expect(new Ajv({ strict: false }).compile(read!.parameters)(visible.next_tool_arguments)).toBe(true);
    expect(visible.instruction).toContain("没有部分保存"); expect(visible.instruction).toContain("目录只提供导航");
    expect(execute).not.toHaveBeenCalled(); expect(args).toEqual(untouched); expect(await readFile(codec.mapPath, "utf8")).toBe(before);
    await read!.execute("directory", visible.next_tool_arguments, undefined as any, undefined as any, undefined as any);
    // The author confirms an already returned real span; the directory never picks a replacement span.
    await wrapped!.execute("confirmed", { ...args, draft: { ...args.draft, span_ids: ["s1"] } }, undefined as any, undefined as any, undefined as any);
    expect(execute.mock.calls[0]?.[1]).toEqual({ operation: args.operation, collection: args.collection, remove_keys: args.remove_keys,
      draft: { span_ids: [span], reason: args.draft.reason } });
    const requiredDirectory = defineTool({ ...directory, parameters: Type.Object({ locator: Type.String() }, { additionalProperties: false }) });
    const [fallback] = codec.wrapTools([edit, requiredDirectory, defineTool({ ...directory, name: "get_target_context" })]);
    expect((await fallback!.execute("fallback", args, undefined as any, undefined as any, undefined as any)).details)
      .toMatchObject({ next_tool: "get_target_context", next_tool_arguments: {}, original_tool_executed: false });
    const [unavailable] = codec.wrapTools([edit]);
    const noReader = await unavailable!.execute("unavailable", args, undefined as any, undefined as any, undefined as any);
    expect(noReader.details).not.toHaveProperty("next_tool"); expect((noReader.details as any).instruction).toContain("没有可执行");
    expect(execute).toHaveBeenCalledOnce();
  });

  test.each(["occurrence_id", "target_key"])("unknown %s uses an available reference directory without inferring its identity", async field => {
    const { codec } = await fresh();
    const execute = vi.fn(async () => ({ content: [] }));
    const [wrapped, directory] = codec.wrapTools([
      defineTool({ name: "reference_probe", label: "Reference", description: "Neutral reference request",
        parameters: Type.Object({ [field]: Type.String() }, { additionalProperties: false }), execute }),
      defineTool({ name: "list_reference_occurrences", label: "Directory", description: "Reference directory",
        parameters: Type.Object({}, { additionalProperties: false }), execute }),
      defineTool({ name: "list_evidence_resources", label: "Evidence", description: "Evidence directory",
        parameters: Type.Object({}, { additionalProperties: false }), execute }),
    ]);
    const result = await wrapped!.execute("unknown", { [field]: field === "target_key" ? "t999" : "r999", source_handle_scope: codec.scope }, undefined as any, undefined as any, undefined as any);
    expect(result.details).toMatchObject({ expected_type: field === "target_key" ? "reference-target" : "reference",
      writable_path: `/${field}`, next_tool: "list_reference_occurrences", next_tool_arguments: {}, original_tool_executed: false });
    expect(new Ajv({ strict: false }).compile(directory!.parameters)((result.details as any).next_tool_arguments)).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });

  test.each(["read_target_selectors", "stage_probe"])("a stale scope on %s without typed handles only needs the scope argument corrected", async name => {
    const { codec } = await fresh();
    const execute = vi.fn(async () => ({ content: [] }));
    const [tool] = codec.wrapTools([defineTool({ name, label: "Author", description: "Neutral author request",
      parameters: Type.Object({ collection: Type.String(), key: Type.Optional(Type.String()),
        operation: Type.Optional(Type.String()), remove_keys: Type.Optional(Type.Array(Type.String())) }, { additionalProperties: false }), execute })]);
    const args = name === "read_target_selectors"
      ? { collection: "references", key: "author-key", source_handle_scope: "old-scope" }
      : { operation: "upsert", collection: "source_dispositions", remove_keys: ["author-key"], source_handle_scope: "old-scope" };
    const untouched = structuredClone(args), before = await readFile(codec.mapPath, "utf8");
    const rejected = await tool!.execute("stale-label", args, undefined as any, undefined as any, undefined as any);
    const visible = JSON.parse((rejected.content[0] as any).text);
    expect(visible).toMatchObject({ error: "source_handle_scope_mismatch", source_argument_count: 0,
      source_arguments_complete: true, source_arguments_to_reread: [], writable_paths: ["/source_handle_scope"],
      required_argument: { source_handle_scope: codec.scope }, next_tool: name, retry_tool: name,
      required_action: "correct_scope_argument_without_rebinding_handles", original_tool_executed: false,
      durable_mutation: false, budget_consumed: false });
    expect(visible.instruction).toContain("没有待重读的 typed handle");
    expect(visible.instruction).not.toContain("本工具集合没有可执行");
    expect(visible.alternative_repair).toEqual({ remove_argument_path: "/source_handle_scope",
      precondition: { source_argument_count: 0, source_arguments_complete: true }, retry_tool: name });
    expect(visible.instruction).toContain("删除这个可选参数");
    expect(args).toEqual(untouched); expect(await readFile(codec.mapPath, "utf8")).toBe(before);
    expect(execute).not.toHaveBeenCalled();
    const retryArgs = { ...args, ...visible.required_argument };
    expect(new Ajv({ strict: false }).compile(tool!.parameters)(retryArgs)).toBe(true);
    await tool!.execute("corrected-label", retryArgs, undefined as any, undefined as any, undefined as any);
    const { source_handle_scope: _scope, ...businessArgs } = untouched;
    expect(execute).toHaveBeenCalledExactlyOnceWith("corrected-label", businessArgs, undefined, undefined, undefined);
    // Author chooses the already-legal omission route; the harness does not edit the rejected request.
    const omittedArgs = structuredClone(untouched);
    delete (omittedArgs as { source_handle_scope?: string }).source_handle_scope;
    expect(new Ajv({ strict: false }).compile(tool!.parameters)(omittedArgs)).toBe(true);
    await tool!.execute("omitted-label", omittedArgs, undefined as any, undefined as any, undefined as any);
    expect(execute).toHaveBeenNthCalledWith(2, "omitted-label", businessArgs, undefined, undefined, undefined);
    const invalid = await tool!.execute("omitted-invalid", { ...omittedArgs, collection: 7 }, undefined as any, undefined as any, undefined as any);
    expect(invalid.details).toMatchObject({ error: "source_handle_decoded_arguments_invalid" });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(args).toEqual(untouched); expect(await readFile(codec.mapPath, "utf8")).toBe(before);
  });

  test("wrong scope skips unavailable directory arguments and declares bounded source paths or absent read tools", async () => {
    const { codec } = await fresh();
    const execute = vi.fn(async () => ({ content: [] }));
    const originals = [
      defineTool({ name: "stage_probe", label: "Stage", description: "Preserve pending mutation",
        parameters: Type.Object({ operation: Type.String(), collection: Type.String(), remove_keys: Type.Array(Type.String()), span_ids: Type.Array(Type.String()) }, { additionalProperties: false }), execute }),
      defineTool({ name: "list_evidence_resources", label: "Directory", description: "A directory requiring arguments",
        parameters: Type.Object({ mandatory_locator: Type.String() }, { additionalProperties: false }), execute }),
      defineTool({ name: "get_target_context", label: "Context", description: "An available current read",
        parameters: Type.Object({}, { additionalProperties: false }), execute }),
    ];
    const [tool] = codec.wrapTools(originals);
    const args = { operation: "replace", collection: "source_dispositions", remove_keys: ["authored-delete-key"], span_ids: Array.from({ length: 100 }, () => "s1"), source_handle_scope: "old-revision" };
    const rejected = await tool!.execute("bounded", args, undefined as any, undefined as any, undefined as any);
    expect(rejected.details).toMatchObject({ next_tool: "get_target_context", next_tool_arguments: {}, source_argument_count: 100, source_arguments_complete: false });
    expect((rejected.details as any).source_arguments_to_reread).toHaveLength(64);
    expect((rejected.details as any).do_not_edit).toContain("remove_keys"); expect(args.remove_keys).toEqual(["authored-delete-key"]);
    const [discoveryTool, atomDirectory] = codec.wrapTools([originals[0]!, defineTool({
      name: "list_document_atoms", label: "Atoms", description: "Current discovery directory",
      parameters: Type.Object({ cursor: Type.Optional(Type.Number({ minimum: 0 })), limit: Type.Optional(Type.Number({ minimum: 1, maximum: 100 })) }, { additionalProperties: false }), execute,
    })]);
    const discoveryRejected = await discoveryTool!.execute("discovery", { ...args, span_ids: ["s1"] }, undefined as any, undefined as any, undefined as any);
    expect(discoveryRejected.details).toMatchObject({ next_tool: "list_document_atoms", next_tool_arguments: {}, original_tool_executed: false });
    expect(new Ajv({ strict: false }).compile(atomDirectory!.parameters)((discoveryRejected.details as any).next_tool_arguments)).toBe(true);
    const [withoutDirectory] = codec.wrapTools([originals[0]!]);
    const unavailable = await withoutDirectory!.execute("unavailable", { ...args, span_ids: ["s1"] }, undefined as any, undefined as any, undefined as any);
    expect(unavailable.details).not.toHaveProperty("next_tool"); expect((unavailable.details as any).instruction).toContain("本工具集合没有可执行");
    expect(execute).not.toHaveBeenCalled();
  });


  test.each([
    { name: "unknown occurrence", occurrence_id: "r999", target_span_ids: ["s1"], error: "source_handle_unknown", path: "/reference_selections/0/occurrence_id", expected: "reference", next: "list_reference_occurrences" },
    { name: "evidence used as span", occurrence_id: "r1", target_span_ids: ["e1"], error: "source_handle_wrong_type", path: "/reference_selections/0/target_span_ids/0", expected: "span", next: "open_evidence" },
  ])("a valid checkpoint does not redirect $name diagnostics to checkpoint repair", async row => {
    const { codec } = await fresh();
    const fingerprint = "d".repeat(64), occurrence = "reference:neutral-panel";
    await codec.encode({ draft_fingerprint: fingerprint, occurrence_id: occurrence, span_id: span, evidence_id: evidence });
    const execute = vi.fn(async (_id: string, args: any) => ({ content: [], details: args }));
    const read = (name: string, parameters = Type.Object({}, { additionalProperties: false })) => defineTool({ name, label: name,
      description: "Neutral source navigation", parameters, execute: async () => ({ content: [] }) });
    const [tool] = codec.wrapTools([
      defineTool({ name: "stage_probe", label: "Stage", description: "Neutral interlock author selection",
        parameters: Type.Object({ draft_fingerprint: Type.String({ pattern: "^[a-f0-9]{64}$" }), reference_selections: Type.Array(Type.Object({
          occurrence_id: Type.String({ minLength: 1 }), target_span_ids: Type.Array(Type.String({ minLength: 1 })), reason: Type.String(),
        }, { additionalProperties: false })) }, { additionalProperties: false }), execute }),
      read("read_target_selectors"), read("get_target_context"), read("list_reference_occurrences"),
      read("open_evidence", Type.Object({ evidence_id: Type.String() }, { additionalProperties: false })),
    ]);
    const args = { draft_fingerprint: "c1", reference_selections: [{ occurrence_id: row.occurrence_id,
      target_span_ids: row.target_span_ids, reason: "确认联锁面板采用的来源" }], source_handle_scope: codec.scope };
    const before = await readFile(codec.mapPath, "utf8"), unchanged = structuredClone(args);
    const rejected = await tool!.execute("bad-source", args, undefined as any, undefined as any, undefined as any);
    const visible = JSON.parse((rejected.content[0] as any).text);
    expect(visible).toMatchObject({ error: row.error, argument_path: row.path, expected_type: row.expected, next_tool: row.next,
      retry_tool: "stage_probe" });
    expect(visible.instruction).not.toContain("重新读取当前检查点");
    expect(visible.required_action ?? "").not.toContain("只替换检查点");
    expect(args).toEqual(unchanged); expect(await readFile(codec.mapPath, "utf8")).toBe(before);
    expect(execute).not.toHaveBeenCalled();
    await tool!.execute("fixed-source", { ...args, reference_selections: [{ ...args.reference_selections[0],
      occurrence_id: "r1", target_span_ids: ["s1"] }] }, undefined as any, undefined as any, undefined as any);
    expect(execute.mock.calls[0]?.[1]).toEqual({ draft_fingerprint: fingerprint,
      reference_selections: [{ occurrence_id: occurrence, target_span_ids: [span], reason: args.reference_selections[0]!.reason }] });
  });

  test.each(["c999", "e1"])("the actual bad checkpoint %s still routes to checkpoint reads with valid sources", async invalid => {
    const { codec } = await fresh();
    await codec.encode({ draft_fingerprint: "d".repeat(64), span_id: span, evidence_id: evidence });
    const execute = vi.fn(async () => ({ content: [] }));
    const [tool] = codec.wrapTools([
      defineTool({ name: "stage_probe", label: "Stage", description: "Neutral checkpoint-bound edit",
        parameters: Type.Object({ draft_fingerprint: Type.String({ pattern: "^[a-f0-9]{64}$" }), target_span_ids: Type.Array(Type.String()) }), execute }),
      defineTool({ name: "read_target_selectors", label: "Read", description: "Current author checkpoint",
        parameters: Type.Object({}, { additionalProperties: false }), execute }),
      defineTool({ name: "open_evidence", label: "Read", description: "Source",
        parameters: Type.Object({ evidence_id: Type.String() }), execute }),
    ]);
    const args = { draft_fingerprint: invalid, target_span_ids: ["s1"], source_handle_scope: codec.scope };
    const before = await readFile(codec.mapPath, "utf8"), unchanged = structuredClone(args);
    const result = await tool!.execute("bad-checkpoint", args, undefined as any, undefined as any, undefined as any);
    const visible = JSON.parse((result.content[0] as any).text);
    expect(visible).toMatchObject({ expected_type: "checkpoint", argument_path: "/draft_fingerprint", next_tool: "read_target_selectors", tool_arguments: {} });
    expect(visible.required_action).toContain("只替换检查点");
    expect(execute).not.toHaveBeenCalled(); expect(args).toEqual(unchanged); expect(await readFile(codec.mapPath, "utf8")).toBe(before);
  });

  test("scope mismatch with a checkpoint preserves all typed source reread instructions", async () => {
    const { codec } = await fresh();
    await codec.encode({ draft_fingerprint: "d".repeat(64), occurrence_id: "reference:neutral-switch", span_id: span });
    const execute = vi.fn(async () => ({ content: [] }));
    const [tool] = codec.wrapTools([
      defineTool({ name: "stage_probe", label: "Stage", description: "Neutral switch edit",
        parameters: Type.Object({ draft_fingerprint: Type.String(), reference_selections: Type.Array(Type.Object({
          occurrence_id: Type.String(), target_span_ids: Type.Array(Type.String()),
        })) }), execute }),
      ...["read_target_selectors", "list_reference_occurrences"].map(name => defineTool({ name, label: name,
        description: "Current directory", parameters: Type.Object({}, { additionalProperties: false }), execute })),
    ]);
    const args = { draft_fingerprint: "c1", reference_selections: [{ occurrence_id: "r1", target_span_ids: ["s1"] }], source_handle_scope: "old-session" };
    const before = await readFile(codec.mapPath, "utf8"), unchanged = structuredClone(args);
    const result = await tool!.execute("old-scope", args, undefined as any, undefined as any, undefined as any);
    const visible = JSON.parse((result.content[0] as any).text);
    expect(visible).toMatchObject({ error: "source_handle_scope_mismatch", next_tool: "list_reference_occurrences", next_tool_arguments: {},
      required_action: "reread_current_typed_handles_before_retry", original_tool_executed: false, source_argument_count: 3,
      source_arguments_to_reread: [
        { argument_path: "/draft_fingerprint", expected_type: "checkpoint" },
        { argument_path: "/reference_selections/0/occurrence_id", expected_type: "reference" },
        { argument_path: "/reference_selections/0/target_span_ids/0", expected_type: "span" },
      ] });
    expect(visible.instruction).toContain("不得只给旧句柄替换 source_handle_scope");
    expect(visible.instruction).not.toContain("重新读取当前检查点");
    expect(visible).not.toHaveProperty("required_argument"); expect(visible).not.toHaveProperty("alternative_repair");
    expect(args).toEqual(unchanged); expect(await readFile(codec.mapPath, "utf8")).toBe(before); expect(execute).not.toHaveBeenCalled();
  });

  test("provider history is compatible only when it explicitly records the current handle scope",async()=>{
    const {codec}=await fresh();const session=SessionManager.inMemory();
    expect(sourceHandleSessionMatches(session.getEntries(),codec.scope)).toBe(false);
    session.appendCustomEntry(SOURCE_HANDLE_SESSION_ENTRY,{scope:codec.scope});
    expect(sourceHandleSessionMatches(session.getEntries(),codec.scope)).toBe(true);
    expect(sourceHandleSessionMatches(session.getEntries(),"a different revision")).toBe(false);
  });
});
