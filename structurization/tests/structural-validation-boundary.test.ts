import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { sha256Text } from "../src/canonical.js";
import { EVIDENCE_SCHEMA_VERSION, EVIDENCE_SCOPE_SCHEMA_VERSION, SEMANTIC_EVIDENCE_SCHEMA_VERSION, type EvidenceManifest } from "../src/contracts.js";
import { buildGranularProseCoverageEvidence } from "../src/evidence.js";
import { ToolController } from "../src/tools.js";
import { RevisionWorkspace } from "../src/workspace.js";
import { compileTargetSelectors, initialTargetSelectorPlan, TargetSelectorCompileError, type TargetSelectorPlan } from "../src/target-selector-compiler.js";
import { registerSourceSpan } from "../src/source-span-registry.js";
import { selectorDiagnosticToolResponse, selectorFieldDiagnostic } from "../src/selector-diagnostics.js";
import { partitionValidationIssues, STRUCTURAL_VALIDATION_BOUNDARY } from "../src/validation-boundary.js";
import { TARGET_SELECTOR_SYSTEM_PROMPT, SelectorCompletedPreflightHandoff } from "../src/pi-runtime.js";
import { TARGET_SELECTOR_PROTOCOLS } from "../src/acceptance-prompt-suite.js";
import { validatePlanText } from "../src/validator.js";

const roots: string[]=[];
afterEach(async()=>{vi.restoreAllMocks();await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});

async function fixture() {
  const root=await mkdtemp(join(tmpdir(),"neutral-structural-"));roots.push(root);
  const text="8.1.1 合成罩盖应完整。检验方法：观察。",hash=sha256Text(text);
  const evidence=buildGranularProseCoverageEvidence(text,hash,[{start_line:1,end_exclusive_line:2}]);
  const manifest:EvidenceManifest={schema_version:EVIDENCE_SCHEMA_VERSION,job_id:"neutral-structure",target_id:"target:cover",
    source:{adapter:"document-domain-agent/v1",file_name:"fictional.md",sha256:hash,semantic_workflow:SEMANTIC_EVIDENCE_SCHEMA_VERSION},
    scope:{schema_version:EVIDENCE_SCOPE_SCHEMA_VERSION,mode:"agent_discovered",target_id:"target:cover",source_line_count:1,
      selected_start_line:1,selected_end_exclusive_line:2,selected_heading:"罩盖",selection_reason:"只验证程序与模型的责任边界。",
      selected_atom_ids:evidence.map(e=>e.evidence_id),target_evidence_fragments:evidence.map(e=>({atom_id:e.evidence_id,text:e.text})),candidates:[]},
    evidence,table_fragments:[],reference_occurrences:[],evidence_fingerprint:sha256Text("neutral"+hash)};
  const ws=await RevisionWorkspace.createFromEvidence(root,manifest.job_id,manifest.target_id,{manifest,markdown:Buffer.from(text)});
  await ws.updateState(s=>{s.target_review_protocol="direct-validation/v1";});
  const registry=await ws.readSourceSpanRegistry(),span=registry.spans[0]!.span_id;
  const draft=initialTargetSelectorPlan(manifest);
  draft.lots=[{key:"lot",name:"罩盖",scope_span_ids:[span],reason:"作者选择的范围。"}];
  draft.items=[{key:"cover",lot_key:"lot",name:"罩盖完整性。",category:"一般项目",criterion_span_ids:[span],continuation_span_ids:[],
    fields:{name:{composition:"semantic_summary",span_ids:[span],separator:"",reason:"作者选择的业务名称。"},
      requirement:{composition:"verbatim",span_ids:[span],separator:"",reason:"作者的来源绑定。"},
      method:{composition:"not_applicable",span_ids:[],separator:"",reason:"本例由作者决定。"},
      quantity:{composition:"not_applicable",span_ids:[],separator:"",reason:"原文未规定数量。"},
      note:{composition:"not_applicable",span_ids:[],separator:"",reason:"无说明。"}},
    table:null,inspection_data_type:"review",inspection_data_type_reason:"作者分类。",inspection_data_type_span_ids:[span],
    sampling:{status:"fallback",rule_key:"",branch_keys:[],quantity_span_ids:[],script_span_ids:[],condition_span_ids:[],reason:"作者调查后决定。",confidence:0},reason:"独立判断。"}];
  await ws.writeWorkingSelectors(JSON.stringify(draft));
  const controller=await ToolController.create(ws);
  await controller.dispatch("get_target_context",{});
  await controller.dispatch("read_target_selectors",{collection:"items",key:"cover"});
  for(const e of evidence)await controller.dispatch("open_evidence",{evidence_id:e.evidence_id});
  return {ws,controller,manifest,registry,draft};
}

test("business heuristics remain observable without becoming compiler verdicts; old artifacts retain their contract",async()=>{
  const {manifest,registry,draft}=await fixture();
  expect(()=>compileTargetSelectors(draft,registry,manifest)).toThrow(TargetSelectorCompileError);
  const review:any[]=[];
  const plan=compileTargetSelectors(draft,registry,manifest,{validationBoundary:STRUCTURAL_VALIDATION_BOUNDARY,onModelReview:issues=>review.push(...issues)});
  expect(plan.validation_boundary).toBe(STRUCTURAL_VALIDATION_BOUNDARY);
  expect(review).toEqual(expect.arrayContaining([expect.objectContaining({code:"selector_name_verdict_sentence"})]));
  expect(plan.acceptance_items[0]!.name).toBe(draft.items[0]!.name);
});

test.each([
  ["required",(d:TargetSelectorPlan)=>{delete (d.items[0]!.fields as any).method;}],
  ["unknown source",(d:TargetSelectorPlan)=>{d.items[0]!.criterion_span_ids=["span:"+"f".repeat(32)];}],
  ["duplicate key",(d:TargetSelectorPlan)=>{d.items.push(structuredClone(d.items[0]!));}],
  ["dangling lot",(d:TargetSelectorPlan)=>{d.items[0]!.lot_key="absent";}],
  ["unfinished decision",(d:TargetSelectorPlan)=>{d.items[0]!.sampling.status="pending";}],
] as const)("structural boundary still blocks %s",async(_name,mutate)=>{
  const {manifest,registry,draft}=await fixture();mutate(draft);
  expect(()=>compileTargetSelectors(draft,registry,manifest,{validationBoundary:STRUCTURAL_VALIDATION_BOUNDARY})).toThrow(TargetSelectorCompileError);
});

test("unknown issue codes stay hard errors",()=>{
  const unknown={code:"new_unclassified_error",path:"/items/0",message:"unknown"};
  expect(partitionValidationIssues([unknown,{code:"selector_name_verdict_sentence"}])).toEqual({errors:[unknown],model_review:[{code:"selector_name_verdict_sentence"}]});
});

test("field diagnostics retain stable identities for rules and keep compiler-owned fields read-only",()=>{
  const first=selectorFieldDiagnostic({code:"selector_sampling_component_required",path:"/sampling_rules/0/components",
    message:"Missing component",details:{sampling_rule_key:"shared",actual:[],expected:["method"]}});
  const moved=selectorFieldDiagnostic({code:"selector_sampling_component_required",path:"/sampling_rules/4/components",
    message:"Missing component",details:{sampling_rule_key:"shared",actual:[],expected:["method"]}});
  expect(first.diagnostic_id).toBe(moved.diagnostic_id);
  expect(first).toMatchObject({record:{collection:"sampling_rules",key:"shared",field:"/components"},actual:[],expected:["method"]});
  expect(selectorFieldDiagnostic({code:"compiler_mapping",path:"/acceptance_items/0/id",owner:"final_contract_violation",
    message:"Generated mapping mismatch"})).toMatchObject({writable_paths:[],do_not_edit:expect.any(String)});
});

test("an explicit source disposition is checked for presence, not overridden by a guessed business role",async()=>{
  const {manifest,registry,draft}=await fixture();
  const source={...manifest.evidence[0]!,evidence_id:"atom:additional",atom_id:"atom:additional",text:"9.2.1 虚构附件应符合作者判断的适用要求。"};
  source.text_sha256=sha256Text(source.text);
  manifest.evidence.push(source);manifest.scope.selected_atom_ids.push(source.evidence_id);
  const span=registerSourceSpan(registry,{source_id:source.evidence_id,evidence_id:source.evidence_id,atom_id:source.evidence_id,text:source.text},0,source.text.length);
  draft.source_dispositions=[{span_ids:[span.span.span_id],disposition:"context",reason:"作者结合本例对象判定；程序不验证此业务结论。"}];
  const plan=compileTargetSelectors(draft,span.registry,manifest,{validationBoundary:STRUCTURAL_VALIDATION_BOUNDARY});
  expect(plan.evidence_dispositions.find(d=>d.evidence_id===source.evidence_id)?.disposition).toBe("context");
  const checked=validatePlanText(JSON.stringify(plan),manifest);
  expect(checked.ok,JSON.stringify(checked.issues)).toBe(true);
  expect(plan.acceptance_items).toHaveLength(1);
});

test("LSP identity survives item reorder and keeps actual, expected, writable path and next tool",()=>{
  const issue={code:"selector_sampling_decision_pending",path:"/items/0/sampling/status",message:"抽样决定尚未填写。",
    actual:"pending",details:{item_key:"cover",allowed_statuses:["explicit","fallback"],writable_paths:["/items/0/sampling"],
      next_tool:"read_target_selectors",next_tool_arguments:{collection:"items",key:"cover"},save_tool:"stage_target_selector_draft"}};
  const first=selectorFieldDiagnostic(issue),second=selectorFieldDiagnostic({...issue,path:"/items/5/sampling/status"});
  expect(first.diagnostic_id).toBe(second.diagnostic_id);
  expect(first).toMatchObject({severity:"error",actual:"pending",expected:{status:["explicit","fallback"]},
    record:{collection:"items",key:"cover",field:"/sampling/status"},next_tool_arguments:{collection:"items",key:"cover"}});
});

test("wire reply collapses dependent source symptoms, stays compact and preserves full raw error",()=>{
  const source={code:"compiler_unhandled_evidence",path:"/source_dispositions",message:"未填写来源处理决定。",actual:{evidence_ids:["e1"]},details:{members:[{long:"重复".repeat(10000)}]}};
  const missing={code:"selector_registered_reference_receipt_missing",path:"/references",message:"引用记录缺失。",
    actual:{occurrence_id:"r1",matching_reference_keys:[],origin_evidence_ids:["e1"]},
    writable_paths:["/references"],next_tool:"list_reference_occurrences",next_tool_arguments:{cursor:0}};
  const raw={ok:false,current_draft_fingerprint:"a".repeat(64),selector_issues:[source,missing],selector_issue_page:{cursor:0,raw_issue_count:2,
    issue_index:[{index:0,issue_key:"source"},{index:1,issue_key:"reference"}]}};
  const before=JSON.stringify(raw),wire=selectorDiagnosticToolResponse(raw) as any;
  expect(wire.selector_issues).toHaveLength(1);
  expect(wire.selector_issues[0]).toMatchObject({record:{occurrence_id:"r1"},actual:{matching_reference_keys:[]},expected:{record_count:1},
    full_details:{arguments:{issue_key:"reference",detail_mode:"full"}}});
  expect(Buffer.byteLength(JSON.stringify(wire))).toBeLessThan(2400);
  expect(wire.selector_issue_page.raw_issue_count).toBe(2);expect(JSON.stringify(raw)).toBe(before);
  expect(selectorDiagnosticToolResponse({...raw,diagnostic_detail_mode:"full"})).toMatchObject({selector_issues:[source,missing]});
});

test("preflight reuse survives controller restart; source-registry changes invalidate it without clearing history",async()=>{
  const {ws,controller,draft}=await fixture();
  const compute=vi.spyOn(controller as any,"computeTargetSelectorPreflight");
  const first=await (controller as any).evaluateTargetSelectorPreflight(draft);
  expect(first.ok,JSON.stringify(first.issues)).toBe(true);
  const before=await ws.readState();
  const second=await (controller as any).evaluateTargetSelectorPreflight(draft);
  expect(second.response.preflight_reused).toBe(true);expect(compute).toHaveBeenCalledTimes(1);
  // Business heuristics no longer drive correction-attempt policies; commit and
  // seal may share the same structural preflight despite their old policy flags.
  expect((await (controller as any).evaluateTargetSelectorPreflight(draft,false,false)).response.preflight_reused).toBe(true);
  expect(compute).toHaveBeenCalledTimes(1);
  const restored=await ToolController.create(ws),rerun=vi.spyOn(restored as any,"computeTargetSelectorPreflight");
  expect((await (restored as any).evaluateTargetSelectorPreflight(draft)).response.preflight_reused).toBe(true);
  expect(rerun).not.toHaveBeenCalled();
  const registry=await ws.readSourceSpanRegistry(),manifest=await ws.readEvidenceManifest(),e=manifest.evidence[0]!;
  const registered=registerSourceSpan(registry,{source_id:e.evidence_id,evidence_id:e.evidence_id,atom_id:e.atom_id??e.evidence_id,text:e.text},0,3);
  await writeFile(ws.sourceSpanRegistryPath,JSON.stringify(registered.registry));
  await (restored as any).evaluateTargetSelectorPreflight(draft);expect(rerun).toHaveBeenCalledTimes(1);
  const after=await ws.readState();expect(after.next_history_sequence).toBe(before.next_history_sequence);
  expect(after.validation_attempts).toBe(before.validation_attempts);expect(after.selector_protocol).toEqual(before.selector_protocol);
});

test("business observations are not repeated on unrelated source reads",async()=>{
  const {controller,draft}=await fixture();
  const saved=await controller.dispatch("stage_target_selector_draft",{draft:{items:draft.items}}) as any;
  expect(saved.model_review.observations).toEqual(expect.arrayContaining([
    expect.objectContaining({code:"selector_name_verdict_sentence"}),
  ]));
  const read=await controller.dispatch("read_target_selectors",{collection:"items",key:"cover"});
  expect(read).not.toHaveProperty("model_review");
});

test("repeating unchanged stage diagnostics does not spend another retry",async()=>{
  const {ws,controller}=await fixture();
  const diagnostic={issues:[{code:"selector_sampling_decision_pending",path:"/items/0/sampling/status",details:{item_key:"cover"}}]};
  await (controller as any).recordSelectorStageRetry(diagnostic);const before=await ws.readState();
  const again=await (controller as any).recordSelectorStageRetry(diagnostic);
  expect(again.progress).toBe("unchanged_inputs_reused");expect(await ws.readState()).toEqual(before);
});

test("prompt separates writable author routes from derived links and recovery requests only read diagnostics",()=>{
  expect(TARGET_SELECTOR_PROTOCOLS.reference_routes).toContain("references.destinations、origin_binding、component_dispositions 是作者可写");
  expect(TARGET_SELECTOR_PROTOCOLS.reference_routes).toContain("origin_field");
  expect(TARGET_SELECTOR_PROTOCOLS.reference_routes).toContain("component_dispositions");
  expect(TARGET_SELECTOR_PROTOCOLS.reference_routes).toContain("destinations");
  expect(TARGET_SELECTOR_SYSTEM_PROMPT).toContain("程序核验结构、格式、必填决定");
  expect(TARGET_SELECTOR_SYSTEM_PROMPT).not.toContain("不能编辑 SemanticSourcePlan、生成的 IDs、hash、接收关系");
  const handoff=new SelectorCompletedPreflightHandoff();
  // Recovery is covered end-to-end by length-continuation tests; construction must stay pure.
  expect(handoff.continuationNote("a".repeat(64))).toBe("");
});
