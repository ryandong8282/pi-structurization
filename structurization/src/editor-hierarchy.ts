import { replaceAcceptanceToolText } from "./acceptance-tool-text.js";
import { HIERARCHY_ITEM_ASSIGNMENT_GUIDANCE } from "./acceptance-prompt-suite.js";
import { ACCEPTANCE_TOOL_DESCRIPTIONS } from "./acceptance-tool-text.js";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";

import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";

import {
  appendText,
  atomicWriteJson,
  atomicWriteNewText,
  atomicWriteText,
  makeReadOnly,
  pathExists,
  readJson,
} from "./atomic.js";
import { catchToolReject, fingerprintMismatchReject, toolReject } from "./actionable-error.js";
import { prettyJson, sha256Json, sha256Text } from "./canonical.js";
import {
  buildDocumentEvidence,
  type DocumentAtom,
  type DocumentEvidence,
} from "./document-discovery.js";
import { applyJsonPatch, type JsonPatchOperation } from "./json-patch.js";
import { hierarchyRecordCatalog, hierarchyRecordEditOperations, hierarchyIssueRepairContext, HIERARCHY_RECORD_KEYS } from "./hierarchy-record-edits.js";
import { strictJsonParse } from "./strict-json.js";
import { ACCEPTANCE_ORGANIZATION_GUIDANCE, INSPECTION_UNIT_GUIDANCE, LOT_NAMING_GUIDANCE } from "./acceptance-delivery-contract.js";
import { editorInspectionUnits, validateInspectionUnits, type EditorInspectionUnit } from "./inspection-unit.js";

export const EDITOR_HIERARCHY_EVIDENCE_SCHEMA_VERSION = "editor-hierarchy-evidence/v1" as const;
export const EDITOR_HIERARCHY_PLAN_SCHEMA_VERSION = "editor-hierarchy-plan/v2" as const;

export interface EditorHierarchyLot {
  lot_key: string;
  target_id: string;
  target_name: string;
  target_description: string;
  target_evidence_fragments: Array<{ atom_id: string; text: string }>;
  lot_id: string;
  lot_name: string;
  item_names: string[];
  /** Exact sealed catalogue, optional only for historical evidence files. */
  items?: Array<{ item_id: string; name: string; source_clause: string }>;
}

export interface EditorHierarchyEvidence {
  schema_version: typeof EDITOR_HIERARCHY_EVIDENCE_SCHEMA_VERSION;
  job_id: string;
  document: DocumentEvidence;
  business_result_sha256: string;
  lots: EditorHierarchyLot[];
  evidence_fingerprint: string;
}

export interface HierarchyConfirmContext {
  uncertain_lot_keys: string[];
  unmapped_division_names: string[];
  ledger_summary: {
    record_tables: Array<{ table_no: string; title: string; nearby_text: string }>;
    /** 章级标题：GB 验收规范里分项通常就是章，这是分项命名与边界的第一手依据。 */
    chapters: Array<{ number: string; title: string }>;
    windows: Array<{ number: string; title: string; ignored: boolean }>;
    anomalies: Array<{ reason: string; text: string; line: number }>;
  };
}

export interface EditorHierarchyNode {
  node_id: string;
  parent_node_id: "root" | string;
  node_type: "子分部" | "分项";
  name: string;
  constraint_ids: string[];
  evidence_fragments: Array<{ atom_id: string; text: string }>;
  reason: string;
}

export interface EditorLotBinding {
  lot_key: string;
  parent_node_id: string;
  /**
   * 来源优先的检验批展示名；不因父级重复而缩写准确原名。
   * lot_name 仍保留在封存业务结果中，此字段不改变其身份。
   */
  display_name?: string;
  /** Model-selected exact source titles, not the authored lot name. Omitted on legacy plans. */
  source_title_fragments?: Array<{ atom_id: string; text: string }>;
  constraint_ids: string[];
  evidence_fragments: Array<{ atom_id: string; text: string }>;
  reason: string;
}

export interface EditorHierarchySemanticConstraint {
  constraint_id: string;
  kind: "level_definition" | "child_count" | "child_enumeration" | "scope_assignment" | "other";
  parent_node_id: "root" | string;
  node_type: "子分部" | "分项";
  node_ids: string[];
  expected_count: number | null;
  exhaustive: boolean;
  evidence_fragments: Array<{ atom_id: string; text: string }>;
  interpretation: string;
}

export interface EditorHierarchyAtomDisposition {
  atom_id: string;
  disposition: "hierarchy_authority" | "supporting_context" | "no_hierarchy_effect";
  constraint_ids: string[];
  reason: string;
}

export interface EditorHierarchyPlan {
  schema_version: typeof EDITOR_HIERARCHY_PLAN_SCHEMA_VERSION;
  job_id: string;
  evidence_fingerprint: string;
  business_result_sha256: string;
  semantic_constraints: EditorHierarchySemanticConstraint[];
  atom_dispositions: EditorHierarchyAtomDisposition[];
  nodes: EditorHierarchyNode[];
  lot_bindings: EditorLotBinding[];
  /** Explicit product organization; absent only on legacy one-node-per-lot plans. */
  inspection_units?: EditorInspectionUnit[];
}

export interface EditorHierarchyDifference {
  difference_id: string;
  kind: "candidate_only_node" | "reviewer_only_node" | "lot_parent_mismatch" | "lot_display_name_mismatch" | "inspection_unit_mismatch";
  candidate: string;
  reviewer: string;
}

export interface EditorHierarchyComparison {
  schema_version: "editor-hierarchy-comparison/v1";
  candidate_plan_sha256: string;
  reviewer_plan_sha256: string;
  reviewer_fingerprint: string;
  differences: EditorHierarchyDifference[];
}

export interface EditorHierarchyIssue {
  code: string;
  path: string;
  message: string;
  details?: unknown;
  how_to_pass?: string;
  valid_constraint_ids?: string[];
}

/**
 * 确认模式：程序装配的树只是可编辑候选，Agent 负责完成语义命名、
 * 合并/拆分分项、绑定与展示名。保底门禁只守住已封存 lot 不丢失、
 * 节点类型不被篡改，以及高层本体不被任意换父。
 */
export function confirmModeHierarchyIssues(
  baseline: EditorHierarchyPlan,
  after: EditorHierarchyPlan,
  confirm: HierarchyConfirmContext,
): EditorHierarchyIssue[] {
  const issues: EditorHierarchyIssue[] = [];
  const beforeBindings = new Map(baseline.lot_bindings.map((binding) => [binding.lot_key, binding]));
  if (baseline.inspection_units !== undefined && !Array.isArray(after.inspection_units)) {
    issues.push({ code: "inspection_units_required", path: "/inspection_units", message: "新流程不能删除业务验收单元映射来退回逐 target 成批。",
      details: { actual: after.inspection_units, writable_path: "/inspection_units", save_tool: "edit_hierarchy_records", candidate_read_tool: "get_hierarchy_contract", how_to_pass: "保留 inspection_units 数组，用 edit_hierarchy_records 以稳定 unit_id 增改（collection=inspection_units），保留各来源 lot 的兼容默认绑定；按原文用完整 lot 或互不重叠的 item_selections 使全部封存项目恰好覆盖一次；提交前 validate_hierarchy_plan。", do_not_edit: "封存 target/lot/item 和原文" } });
  }
  const afterBindings = new Map(after.lot_bindings.map((binding) => [binding.lot_key, binding]));

  // 检验批绑到哪个分项，确定性装配是拿分项名做 normalize 相等 / 子串 / 条文号前缀匹配的，
  // 而分项名本身是从附录记录表题注回看切出来的整句话；三者都不中时直接绑到 divisionNodes[0]。
  // 也就是说「确定绑定」同样只是名字噪声，锁住它等于把噪声固化。
  // 「每个检验批恰好绑定一次」由基础校验器独立保证（missing_lot_bindings /
  // duplicate_lot_binding），confirm 这层只需拦住「把检验批弄丢」。
  for (const [lotKey] of beforeBindings) {
    if (!afterBindings.has(lotKey)) {
      issues.push({
        code: "confirm_lot_binding_dropped",
        path: `/lot_bindings/${lotKey}`,
        message: "Confirm mode cannot drop a sealed lot binding; rebind it instead",
        details: { lot_key: lotKey },
      });
    }
  }

  const afterNodes = new Map(after.nodes.map((node) => [node.node_id, node]));
  for (const node of baseline.nodes) {
    const next = afterNodes.get(node.node_id);
    if (!next) {
      // 分项个数与边界是语义判断：金标把「普通紧固件连接」「高强度螺栓连接」合成
      // 一个「紧固件连接工程」，装配却按附录记录表出了两个——不允许删就永远合不了。
      // 空掉的「未映射」子分部同理，留着是脏数据。删节点安全的前提是检验批不能丢，
      // 上面已经单独拦了。
      continue;
    }
    // 命名与「分项归哪个子分部」是语义判断，确定性装配只能给候选：
    // 分项名来自附录记录表题注回看的整句话（`H.0.1 …应按 进行记录。`），
    // 归属来自分项名与 50300 子树的字符串包含匹配。两者都必须允许 confirm 改写，
    // 否则 LLM 拿着正文章标题也无权把名字修正成「铝合金焊接工程」。
    // 结构本身（节点存在、类型、层数）仍然锁死，由确定性装配保证。
    if (next.node_type !== node.node_type) {
      issues.push({
        code: "confirm_node_type_changed",
        path: `/nodes/${node.node_id}`,
        message: "Confirm mode cannot change an assembled node's type; structure stays deterministic",
        details: {
          node_id: node.node_id,
          baseline_node_type: node.node_type,
          after_node_type: next.node_type,
        },
      });
    }
    if (next.parent_node_id !== node.parent_node_id && node.node_type !== "分项") {
      issues.push({
        code: "confirm_node_reparented",
        path: `/nodes/${node.node_id}`,
        message: "Confirm mode may re-parent only 分项 nodes; higher levels stay deterministic",
        details: {
          node_id: node.node_id,
          node_type: node.node_type,
          baseline_parent_node_id: node.parent_node_id,
          after_parent_node_id: next.parent_node_id,
        },
      });
    }
  }

  return issues;
}

export interface EditorHierarchyValidation {
  ok: boolean;
  issues: EditorHierarchyIssue[];
  plan?: EditorHierarchyPlan;
  plan_sha256?: string;
  fingerprint?: string;
}

interface HierarchyState {
  schema_version: "editor-hierarchy-state/v2";
  status: "working" | "candidate" | "sealed";
  next_event_sequence: number;
  next_history_sequence: number;
  next_validation_sequence: number;
  last_candidate_fingerprint: string;
  last_review_fingerprint: string;
  last_comparison_fingerprint: string;
  last_reconciled_fingerprint: string;
  opened_atom_ids: string[];
  opened_lot_keys: string[];
  reviewer_opened_atom_ids: string[];
  reviewer_opened_lot_keys: string[];
  agent_runtime: RuntimeState;
  reviewer_runtime: RuntimeState;
}

export interface EditorHierarchyProgress {
  status: "working" | "candidate" | "sealed";
  author_atoms_opened: number;
  author_lots_opened: number;
  reviewer_atoms_opened: number;
  reviewer_lots_opened: number;
}

export interface RuntimeState {
  kind: "pi-sdk" | "offline-scripted" | "unassigned";
  session_id: string;
  session_file: string;
}

export type EditorHierarchyPhase = "candidate" | "review";

function encodedSegment(value: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error("Path segment must not be empty");
  return encodeURIComponent(normalized).replaceAll("%", "_");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function duplicates(values: string[]): string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) repeated.add(value);
    seen.add(value);
  }
  return [...repeated];
}

function exactFragments(
  value: unknown,
  path: string,
  atomById: Map<string, DocumentAtom>,
  opened: Set<string>,
  issues: EditorHierarchyIssue[],
): void {
  if (!Array.isArray(value) || value.length === 0) {
    issues.push({ code: "missing_evidence_fragments", path, message: "At least one exact source fragment is required" });
    return;
  }
  value.forEach((raw, index) => {
    const fragmentPath = `${path}/${index}`;
    if (!isRecord(raw) || typeof raw.atom_id !== "string" || typeof raw.text !== "string" || !raw.text.trim()) {
      issues.push({ code: "invalid_evidence_fragment", path: fragmentPath, message: "Evidence fragment requires atom_id and non-empty exact text" });
      return;
    }
    const atom = atomById.get(raw.atom_id);
    if (!atom) issues.push({ code: "unknown_evidence_atom", path: fragmentPath, message: "Evidence fragment cites an unknown document atom" });
    else if (!atom.text.includes(raw.text)) issues.push({ code: "non_exact_evidence_fragment", path: fragmentPath, message: "Evidence fragment is not an exact substring of immutable source" });
    if (!opened.has(raw.atom_id)) issues.push({ code: "unopened_evidence_atom", path: fragmentPath, message: "Cited evidence must be opened by this session" });
  });
}

export function initialEditorHierarchyPlan(evidence: EditorHierarchyEvidence): EditorHierarchyPlan {
  return {
    schema_version: EDITOR_HIERARCHY_PLAN_SCHEMA_VERSION,
    job_id: evidence.job_id,
    evidence_fingerprint: evidence.evidence_fingerprint,
    business_result_sha256: evidence.business_result_sha256,
    semantic_constraints: [],
    atom_dispositions: [],
    nodes: [],
    lot_bindings: [],
  };
}

export function validateEditorHierarchyPlan(
  input: unknown,
  evidence: EditorHierarchyEvidence,
  openedAtomIds: Set<string>,
  openedLotKeys: Set<string>,
): EditorHierarchyValidation {
  const issues: EditorHierarchyIssue[] = [];
  if (!isRecord(input)) return { ok: false, issues: [{ code: "plan_type", path: "", message: "Hierarchy plan must be an object" }] };
  const allowedRoot = new Set([
    "schema_version",
    "job_id",
    "evidence_fingerprint",
    "business_result_sha256",
    "semantic_constraints",
    "atom_dispositions",
    "nodes",
    "lot_bindings",
    "inspection_units",
  ]);
  const rootExtras = Object.keys(input).filter((key) => !allowedRoot.has(key));
  if (rootExtras.length) issues.push({ code: "unknown_plan_fields", path: "", message: "Unknown hierarchy plan fields", details: rootExtras });
  if (input.schema_version !== EDITOR_HIERARCHY_PLAN_SCHEMA_VERSION) issues.push({ code: "schema_version", path: "/schema_version", message: `Expected ${EDITOR_HIERARCHY_PLAN_SCHEMA_VERSION}` });
  if (input.job_id !== evidence.job_id) issues.push({ code: "job_identity", path: "/job_id", message: "Plan job_id does not match current job" });
  if (input.evidence_fingerprint !== evidence.evidence_fingerprint) issues.push({ code: "evidence_identity", path: "/evidence_fingerprint", message: "Plan evidence fingerprint is stale" });
  if (input.business_result_sha256 !== evidence.business_result_sha256) issues.push({ code: "result_identity", path: "/business_result_sha256", message: "Plan business-result fingerprint is stale" });
  if (!Array.isArray(input.semantic_constraints)) issues.push({ code: "constraints_type", path: "/semantic_constraints", message: "semantic_constraints must be an array" });
  if (!Array.isArray(input.atom_dispositions)) issues.push({ code: "atom_dispositions_type", path: "/atom_dispositions", message: "atom_dispositions must be an array" });
  if (!Array.isArray(input.nodes)) issues.push({ code: "nodes_type", path: "/nodes", message: "nodes must be an array" });
  if (!Array.isArray(input.lot_bindings)) issues.push({ code: "bindings_type", path: "/lot_bindings", message: "lot_bindings must be an array" });
  if (issues.length) return { ok: false, issues };

  const atomById = new Map(evidence.document.atoms.map((atom) => [atom.atom_id, atom]));
  const constraints = input.semantic_constraints as unknown[];
  const constraintIds: string[] = [];
  const constraintById = new Map<string, Record<string, unknown>>();
  constraints.forEach((raw, index) => {
    const path = `/semantic_constraints/${index}`;
    if (!isRecord(raw)) {
      issues.push({ code: "constraint_type", path, message: "Semantic constraint must be an object" });
      return;
    }
    const allowed = new Set(["constraint_id", "kind", "parent_node_id", "node_type", "node_ids", "expected_count", "exhaustive", "evidence_fragments", "interpretation"]);
    const extras = Object.keys(raw).filter((key) => !allowed.has(key));
    if (extras.length) issues.push({ code: "unknown_constraint_fields", path, message: "Unknown semantic constraint fields", details: extras });
    const constraintId = typeof raw.constraint_id === "string" ? raw.constraint_id.trim() : "";
    if (!constraintId) issues.push({ code: "constraint_id", path: `${path}/constraint_id`, message: "constraint_id is required" });
    else {
      constraintIds.push(constraintId);
      constraintById.set(constraintId, raw);
    }
    if (!["level_definition", "child_count", "child_enumeration", "scope_assignment", "other"].includes(String(raw.kind ?? ""))) {
      issues.push({ code: "constraint_kind", path: `${path}/kind`, message: "Unknown semantic constraint kind" });
    }
    if (typeof raw.parent_node_id !== "string" || !raw.parent_node_id.trim()) issues.push({ code: "constraint_parent", path: `${path}/parent_node_id`, message: "parent_node_id is required" });
    if (raw.node_type !== "子分部" && raw.node_type !== "分项") issues.push({ code: "constraint_node_type", path: `${path}/node_type`, message: "node_type must be 子分部 or 分项" });
    if (!strings(raw.node_ids)) issues.push({ code: "constraint_node_ids", path: `${path}/node_ids`, message: "node_ids must be a string array" });
    if (raw.expected_count !== null && (!Number.isInteger(raw.expected_count) || Number(raw.expected_count) < 0)) issues.push({ code: "constraint_expected_count", path: `${path}/expected_count`, message: "expected_count must be null or a non-negative integer" });
    if (typeof raw.exhaustive !== "boolean") issues.push({ code: "constraint_exhaustive", path: `${path}/exhaustive`, message: "exhaustive must be boolean" });
    if (typeof raw.interpretation !== "string" || !raw.interpretation.trim()) issues.push({ code: "constraint_interpretation", path: `${path}/interpretation`, message: "interpretation is required" });
    exactFragments(raw.evidence_fragments, `${path}/evidence_fragments`, atomById, openedAtomIds, issues);
  });
  const repeatedConstraints = duplicates(constraintIds);
  if (repeatedConstraints.length) issues.push({ code: "duplicate_constraint_id", path: "/semantic_constraints", message: "constraint_id values must be unique", details: repeatedConstraints });
  if (constraints.length === 0) issues.push({ code: "zero_semantic_constraints", path: "/semantic_constraints", message: "A hierarchy requires explicit evidence-bound semantic constraints" });

  // 「未知约束」类回条必须带上合法集合：作者端没有 constraint_id 清单可读，
  // 只给未知 id 会诱导瞎猜新 id（GB 50210 实测一次修复轮次把 5 个诊断改写成 23 个）。
  const validConstraintIds = () => [...constraintById.keys()].sort();
  const constraintHowToPass = "constraint_ids 只能引用 /semantic_constraints 里真实存在的 constraint_id（见 valid_constraint_ids）：删除未知引用，改引覆盖本记录的现存约束。确需新约束时，先用 edit_hierarchy_records upsert 该约束（完整字段：constraint_id/kind/parent_node_id/node_type/node_ids/evidence_fragments/interpretation），同一事务内再让本记录引用它，然后 validate_hierarchy_plan。不要发明新 id 格式，不要删无关约束。";

  const dispositions = input.atom_dispositions as unknown[];
  const disposedAtomIds: string[] = [];
  const dispositionByAtom = new Map<string, Record<string, unknown>>();
  dispositions.forEach((raw, index) => {
    const path = `/atom_dispositions/${index}`;
    if (!isRecord(raw)) {
      issues.push({ code: "atom_disposition_type", path, message: "Atom disposition must be an object" });
      return;
    }
    const extras = Object.keys(raw).filter((key) => !new Set(["atom_id", "disposition", "constraint_ids", "reason"]).has(key));
    if (extras.length) issues.push({ code: "unknown_atom_disposition_fields", path, message: "Unknown atom disposition fields", details: extras });
    const atomId = typeof raw.atom_id === "string" ? raw.atom_id.trim() : "";
    disposedAtomIds.push(atomId);
    if (!atomById.has(atomId)) issues.push({ code: "unknown_disposition_atom", path: `${path}/atom_id`, message: "Atom disposition cites an unknown document atom" });
    else dispositionByAtom.set(atomId, raw);
    if (!["hierarchy_authority", "supporting_context", "no_hierarchy_effect"].includes(String(raw.disposition ?? ""))) issues.push({ code: "atom_disposition", path: `${path}/disposition`, message: "Unknown hierarchy atom disposition" });
    if (!strings(raw.constraint_ids)) issues.push({ code: "atom_constraint_ids", path: `${path}/constraint_ids`, message: "constraint_ids must be a string array" });
    else {
      const unknown = raw.constraint_ids.filter((id) => !constraintById.has(id));
      if (unknown.length) issues.push({ code: "unknown_atom_constraints", path: `${path}/constraint_ids`, message: "Atom disposition cites unknown constraints", details: unknown,
        valid_constraint_ids: validConstraintIds(), how_to_pass: constraintHowToPass });
      if (raw.disposition === "hierarchy_authority" && raw.constraint_ids.length === 0) issues.push({ code: "authority_without_constraint", path: `${path}/constraint_ids`, message: "Hierarchy-authority atoms must bind at least one semantic constraint" });
    }
    if (typeof raw.reason !== "string" || !raw.reason.trim()) issues.push({ code: "atom_disposition_reason", path: `${path}/reason`, message: "Atom disposition reason is required" });
    if (!openedAtomIds.has(atomId)) issues.push({ code: "unopened_disposition_atom", path: `${path}/atom_id`, message: "Every disposed atom must be opened by this session" });
  });
  const repeatedDispositions = duplicates(disposedAtomIds);
  if (repeatedDispositions.length) issues.push({ code: "duplicate_atom_disposition", path: "/atom_dispositions", message: "Every document atom must be disposed exactly once", details: repeatedDispositions });
  const disposedSet = new Set(disposedAtomIds);
  const missingDispositions = evidence.document.atoms.map((atom) => atom.atom_id).filter((id) => !disposedSet.has(id));
  if (missingDispositions.length) issues.push({ code: "missing_atom_dispositions", path: "/atom_dispositions", message: "Every document atom needs an explicit hierarchy disposition", details: missingDispositions });

  for (const [constraintId, constraint] of constraintById) {
    const fragments = Array.isArray(constraint.evidence_fragments) ? constraint.evidence_fragments : [];
    const nonAuthorityAtoms = fragments
      .filter(isRecord)
      .map((fragment) => String(fragment.atom_id ?? ""))
      .filter((atomId) => dispositionByAtom.get(atomId)?.disposition !== "hierarchy_authority");
    if (nonAuthorityAtoms.length) issues.push({ code: "constraint_without_authority_disposition", path: `/semantic_constraints/${constraintIds.indexOf(constraintId)}/evidence_fragments`, message: "Every semantic constraint must come from an atom explicitly classified as hierarchy authority", details: nonAuthorityAtoms });
  }

  const nodes = input.nodes as unknown[];
  const nodeIds: string[] = [];
  const nodeById = new Map<string, Record<string, unknown>>();
  nodes.forEach((raw, index) => {
    const path = `/nodes/${index}`;
    if (!isRecord(raw)) {
      issues.push({ code: "node_type", path, message: "Hierarchy node must be an object" });
      return;
    }
    const extras = Object.keys(raw).filter((key) => !new Set(["node_id", "parent_node_id", "node_type", "name", "constraint_ids", "evidence_fragments", "reason"]).has(key));
    if (extras.length) issues.push({ code: "unknown_node_fields", path, message: "Unknown hierarchy node fields", details: extras });
    const nodeId = typeof raw.node_id === "string" ? raw.node_id.trim() : "";
    if (!nodeId || nodeId === "root") issues.push({ code: "node_id", path: `${path}/node_id`, message: "node_id must be non-empty and cannot be root" });
    else {
      nodeIds.push(nodeId);
      nodeById.set(nodeId, raw);
    }
    if (typeof raw.parent_node_id !== "string" || !raw.parent_node_id.trim()) issues.push({ code: "parent_node_id", path: `${path}/parent_node_id`, message: "parent_node_id is required" });
    if (raw.node_type !== "子分部" && raw.node_type !== "分项") issues.push({ code: "node_semantic_type", path: `${path}/node_type`, message: "node_type must be explicitly selected as 子分部 or 分项" });
    if (typeof raw.name !== "string" || !raw.name.trim()) issues.push({ code: "node_name", path: `${path}/name`, message: "Node name must be non-empty" });
    if (!strings(raw.constraint_ids) || raw.constraint_ids.length === 0) issues.push({ code: "node_constraint_ids", path: `${path}/constraint_ids`, message: "Every node must bind at least one semantic constraint" });
    else {
      const unknown = raw.constraint_ids.filter((id) => !constraintById.has(id));
      if (unknown.length) issues.push({ code: "unknown_node_constraints", path: `${path}/constraint_ids`, message: "Node cites unknown constraints", details: unknown,
        valid_constraint_ids: validConstraintIds(), how_to_pass: constraintHowToPass });
    }
    if (typeof raw.reason !== "string" || !raw.reason.trim()) issues.push({ code: "node_reason", path: `${path}/reason`, message: "Node reason must be non-empty" });
    exactFragments(raw.evidence_fragments, `${path}/evidence_fragments`, atomById, openedAtomIds, issues);
  });
  const repeatedNodes = duplicates(nodeIds);
  if (repeatedNodes.length) issues.push({ code: "duplicate_node_id", path: "/nodes", message: "node_id values must be unique", details: repeatedNodes });
  if (nodes.length === 0) issues.push({ code: "zero_nodes", path: "/nodes", message: "A sealed hierarchy requires explicit Agent-authored nodes" });

  const rootSubdivisions = [...nodeById.entries()]
    .filter(([, node]) => node.node_type === "子分部" && node.parent_node_id === "root")
    .map(([id]) => id);
  if (rootSubdivisions.length === 0) {
    issues.push({
      code: "missing_root_subdivision",
      path: "/nodes",
      message: "The editor root is the 分部; the Agent must author at least one explicit 子分部 beneath it",
    });
  }

  for (const [nodeId, node] of nodeById) {
    const parentId = String(node.parent_node_id ?? "");
    if (parentId !== "root" && !nodeById.has(parentId)) issues.push({ code: "unknown_parent", path: `/nodes/${nodeIds.indexOf(nodeId)}/parent_node_id`, message: "Hierarchy parent does not exist", details: parentId });
    if (node.node_type === "分项" && (parentId === "root" || nodeById.get(parentId)?.node_type !== "子分部")) issues.push({ code: "invalid_division_parent", path: `/nodes/${nodeIds.indexOf(nodeId)}/parent_node_id`, message: "A 分项 must be a direct child of an explicit 子分部; the editor root already represents the 分部" });
    if (node.node_type === "子分部" && parentId !== "root") issues.push({ code: "invalid_group_parent", path: `/nodes/${nodeIds.indexOf(nodeId)}/parent_node_id`, message: "A 子分部 must be a direct child of the editor root 分部" });
    const visited = new Set([nodeId]);
    let cursor = parentId;
    while (cursor !== "root" && nodeById.has(cursor)) {
      if (visited.has(cursor)) {
        issues.push({ code: "hierarchy_cycle", path: `/nodes/${nodeIds.indexOf(nodeId)}/parent_node_id`, message: "Hierarchy must be acyclic" });
        break;
      }
      visited.add(cursor);
      cursor = String(nodeById.get(cursor)?.parent_node_id ?? "");
    }
  }

  const siblingSemanticKeys = nodes
    .filter(isRecord)
    .map((node) => `${String(node.parent_node_id ?? "")}\u0000${String(node.node_type ?? "")}\u0000${String(node.name ?? "").trim()}`);
  const repeatedSemanticNodes = duplicates(siblingSemanticKeys);
  if (repeatedSemanticNodes.length) issues.push({ code: "duplicate_semantic_sibling", path: "/nodes", message: "Sibling hierarchy nodes must have unique semantic type/name identities", details: repeatedSemanticNodes });

  for (const [constraintId, constraint] of constraintById) {
    const path = `/semantic_constraints/${constraintIds.indexOf(constraintId)}`;
    const parentId = String(constraint.parent_node_id ?? "");
    if (parentId !== "root" && !nodeById.has(parentId)) issues.push({ code: "constraint_unknown_parent", path: `${path}/parent_node_id`, message: "Semantic constraint parent does not exist", details: parentId });
    const declaredNodeIds = strings(constraint.node_ids) ? constraint.node_ids : [];
    const repeatedDeclared = duplicates(declaredNodeIds);
    if (repeatedDeclared.length) issues.push({ code: "constraint_duplicate_node_ids", path: `${path}/node_ids`, message: "Constraint node_ids must be unique", details: repeatedDeclared });
    const unknownNodes = declaredNodeIds.filter((id) => !nodeById.has(id));
    if (unknownNodes.length) issues.push({ code: "constraint_unknown_nodes", path: `${path}/node_ids`, message: "Constraint cites unknown hierarchy nodes", details: unknownNodes });
    const mismatchedNodes = declaredNodeIds.filter((id) => {
      const node = nodeById.get(id);
      return node && (node.parent_node_id !== parentId || node.node_type !== constraint.node_type);
    });
    if (mismatchedNodes.length) issues.push({ code: "constraint_node_scope", path: `${path}/node_ids`, message: "Constraint nodes must be direct children of its parent with the declared semantic type", details: mismatchedNodes });
    const actualNodes = [...nodeById.entries()]
      .filter(([, node]) => node.parent_node_id === parentId && node.node_type === constraint.node_type)
      .map(([id]) => id)
      .sort();
    const declaredSorted = [...declaredNodeIds].sort();
    if (constraint.kind === "child_count") {
      if (!Number.isInteger(constraint.expected_count)) issues.push({ code: "count_constraint_missing_count", path: `${path}/expected_count`, message: "child_count requires an integer expected_count" });
      else if (constraint.expected_count !== actualNodes.length) issues.push({ code: "child_count_conflict", path, message: "Authored hierarchy contradicts its evidence-bound child-count interpretation", details: { expected: constraint.expected_count, actual: actualNodes.length, parent_node_id: parentId, node_type: constraint.node_type } });
      if (JSON.stringify(declaredSorted) !== JSON.stringify(actualNodes)) issues.push({ code: "child_count_node_set", path: `${path}/node_ids`, message: "child_count node_ids must enumerate the exact children counted by the constraint", details: { declared: declaredSorted, actual: actualNodes } });
    }
    if (constraint.kind === "child_enumeration" && constraint.exhaustive && JSON.stringify(declaredSorted) !== JSON.stringify(actualNodes)) {
      issues.push({ code: "child_enumeration_conflict", path, message: "Exhaustive evidence-bound enumeration does not match the authored hierarchy", details: { declared: declaredSorted, actual: actualNodes } });
    }
    if (constraint.kind === "child_enumeration" && Number.isInteger(constraint.expected_count) && constraint.expected_count !== declaredNodeIds.length) {
      issues.push({ code: "child_enumeration_count_conflict", path, message: "An enumerated evidence claim must name exactly the number of distinct nodes it says it enumerates", details: { expected: constraint.expected_count, enumerated: declaredNodeIds.length } });
    }
  }

  for (const [nodeId, node] of nodeById) {
    const nodeConstraintIds = strings(node.constraint_ids) ? node.constraint_ids : [];
    if (!nodeConstraintIds.some((id) => strings(constraintById.get(id)?.node_ids) && (constraintById.get(id)!.node_ids as string[]).includes(nodeId))) {
      const covering = validConstraintIds().filter((id) => {
        const declared = constraintById.get(id)?.node_ids;
        return Array.isArray(declared) && declared.includes(nodeId);
      });
      issues.push({ code: "node_not_covered_by_constraint", path: `/nodes/${nodeIds.indexOf(nodeId)}/constraint_ids`, message: "At least one cited semantic constraint must explicitly cover this node",
        details: { cited: nodeConstraintIds, covering_constraint_ids: covering },
        valid_constraint_ids: validConstraintIds(),
        how_to_pass: covering.length
          ? `constraint_ids 至少保留一个 covering_constraint_ids 里列出的约束（它们已在 node_ids 中声明本节点 ${nodeId}）。`
          : `现存约束都没有在 node_ids 中声明本节点 ${nodeId}：把该节点加入适用约束的 node_ids（update 该约束记录），或 upsert 一个 parent_node_id/node_type 匹配的新约束并在其 node_ids 声明本节点；同一事务完成，然后 validate_hierarchy_plan。` });
    }
  }

  const knownLots = new Set(evidence.lots.map((lot) => lot.lot_key));
  const bindings = input.lot_bindings as unknown[];
  const boundLotKeys: string[] = [];
  bindings.forEach((raw, index) => {
    const path = `/lot_bindings/${index}`;
    if (!isRecord(raw)) {
      issues.push({ code: "binding_type", path, message: "Lot binding must be an object" });
      return;
    }
    const extras = Object.keys(raw).filter((key) => !new Set(["lot_key", "parent_node_id", "display_name", "source_title_fragments", "constraint_ids", "evidence_fragments", "reason"]).has(key));
    if (extras.length) issues.push({ code: "unknown_binding_fields", path, message: "Unknown lot binding fields", details: extras });
    const lotKey = typeof raw.lot_key === "string" ? raw.lot_key.trim() : "";
    boundLotKeys.push(lotKey);
    if (!knownLots.has(lotKey)) issues.push({ code: "unknown_lot", path: `${path}/lot_key`, message: "Binding cites a lot outside the current sealed result" });
    if (!openedLotKeys.has(lotKey)) issues.push({ code: "unopened_lot", path: `${path}/lot_key`, message: "Every bound lot must be opened by this session" });
    const parent = nodeById.get(String(raw.parent_node_id ?? ""));
    if (!parent || parent.node_type !== "分项") issues.push({ code: "binding_parent", path: `${path}/parent_node_id`, message: "Every lot must bind to an explicit Agent-authored 分项 node" });
    if (raw.display_name !== undefined && (typeof raw.display_name !== "string" || !raw.display_name.trim())) {
      issues.push({ code: "binding_display_name", path: `${path}/display_name`, message: "Lot display_name must be a non-empty semantic name when provided" });
    }
    if (raw.source_title_fragments !== undefined) {
      const titleIssues: EditorHierarchyIssue[] = [];
      // [] explicitly means no corresponding title; old plans may omit the field.
      // The model decides which title applies. Only source identity/read/exactness is mechanical.
      if (!Array.isArray(raw.source_title_fragments) || raw.source_title_fragments.length > 0) {
        exactFragments(raw.source_title_fragments, `${path}/source_title_fragments`, atomById, openedAtomIds, titleIssues);
      }
      issues.push(...titleIssues.map(issue => ({
        ...issue,
        message: `原文标题来源无效：${issue.message}。先打开实际来源，保留精确标题及原有编号，再修改 source_title_fragments；不得填入模型归纳名。`,
        details: {
          actual: raw.source_title_fragments,
          writable_path: `${path}/source_title_fragments`,
          next_tool: "list_document_atoms",
          candidate_read_tools: ["list_document_atoms", "open_document_atom"],
          save_tool: "edit_hierarchy_records",
          how_to_pass: "用 list_document_atoms 定位来源并用 open_document_atom 打开；以 edit_hierarchy_records（collection=lot_bindings、key=lot_key、op=update）修改该绑定的 source_title_fragments 为 [{atom_id,text}]，text 必须逐字出现在该已打开原子中。跨节可保留多条；原文确无对应标题时填 []，并同步 reason 说明。保留 display_name、lot_key、父级和其他正确字段，不改封存业务结果或原文。",
          do_not_edit: "封存 target/lot 身份、编译产物或不可变原文",
        },
      })));
    }
    if (!strings(raw.constraint_ids) || raw.constraint_ids.length === 0) issues.push({ code: "binding_constraint_ids", path: `${path}/constraint_ids`, message: "Every lot binding must cite the semantic constraint that places its parent 分项" });
    else {
      const unknown = raw.constraint_ids.filter((id) => !constraintById.has(id));
      if (unknown.length) issues.push({ code: "unknown_binding_constraints", path: `${path}/constraint_ids`, message: "Lot binding cites unknown constraints", details: unknown,
        valid_constraint_ids: validConstraintIds(), how_to_pass: constraintHowToPass });
      const parentId = String(raw.parent_node_id ?? "");
      if (!raw.constraint_ids.some((id) => strings(constraintById.get(id)?.node_ids) && (constraintById.get(id)!.node_ids as string[]).includes(parentId))) {
        const covering = validConstraintIds().filter((id) => {
          const declared = constraintById.get(id)?.node_ids;
          return Array.isArray(declared) && declared.includes(parentId);
        });
        issues.push({ code: "binding_parent_not_covered", path: `${path}/constraint_ids`, message: "At least one binding constraint must explicitly cover the selected parent 分项",
          details: { parent_node_id: parentId, cited: raw.constraint_ids, covering_constraint_ids: covering },
          valid_constraint_ids: validConstraintIds(),
          how_to_pass: covering.length
            ? `constraint_ids 至少保留一个 covering_constraint_ids 里列出的约束（它们已声明父分项 ${parentId}）。`
            : `现存约束都没有声明父分项 ${parentId}：核对 parent_node_id 是否填对（按节点语义，不按数组位置），或把该父分项加入适用约束的 node_ids；同一事务完成，然后 validate_hierarchy_plan。` });
      }
    }
    if (typeof raw.reason !== "string" || !raw.reason.trim()) issues.push({ code: "binding_reason", path: `${path}/reason`, message: "Lot binding reason must be non-empty" });
    exactFragments(raw.evidence_fragments, `${path}/evidence_fragments`, atomById, openedAtomIds, issues);
  });
  const repeatedBindings = duplicates(boundLotKeys);
  if (repeatedBindings.length) issues.push({ code: "duplicate_lot_binding", path: "/lot_bindings", message: "Every lot must be bound exactly once", details: repeatedBindings });
  const boundSet = new Set(boundLotKeys);
  const missingLots = evidence.lots.map((lot) => lot.lot_key).filter((key) => !boundSet.has(key));
  if (missingLots.length) issues.push({ code: "missing_lot_bindings", path: "/lot_bindings", message: "Every sealed lot must be bound exactly once", details: missingLots });
  if (Object.hasOwn(input, "inspection_units")) issues.push(...validateInspectionUnits(input.inspection_units, evidence, bindings, openedAtomIds, nodes));
  const unopenedAtoms = evidence.document.atoms.map((atom) => atom.atom_id).filter((id) => !openedAtomIds.has(id));
  if (unopenedAtoms.length) issues.push({ code: "incomplete_document_investigation", path: "", message: "This session must open every immutable document atom", details: unopenedAtoms });
  const unopenedLots = evidence.lots.map((lot) => lot.lot_key).filter((key) => !openedLotKeys.has(key));
  if (unopenedLots.length) issues.push({ code: "incomplete_lot_investigation", path: "", message: "This session must open every current sealed lot", details: unopenedLots });

  if (issues.length) return { ok: false, issues };
  const plan = input as unknown as EditorHierarchyPlan;
  const planSha256 = sha256Json(plan);
  return {
    ok: true,
    issues: [],
    plan,
    plan_sha256: planSha256,
    fingerprint: sha256Text(`${evidence.evidence_fingerprint}|${planSha256}`),
  };
}

function semanticHierarchyPaths(plan: EditorHierarchyPlan): Map<string, string> {
  const nodeById = new Map(plan.nodes.map((node) => [node.node_id, node]));
  const memo = new Map<string, string>();
  const visit = (nodeId: string, visiting = new Set<string>()): string => {
    const cached = memo.get(nodeId);
    if (cached) return cached;
    const node = nodeById.get(nodeId);
    if (!node || visiting.has(nodeId)) return `[invalid:${nodeId}]`;
    const next = new Set(visiting);
    next.add(nodeId);
    const own = `${node.node_type}:${node.name.trim()}`;
    const path = node.parent_node_id === "root" ? own : `${visit(node.parent_node_id, next)} > ${own}`;
    memo.set(nodeId, path);
    return path;
  };
  for (const node of plan.nodes) visit(node.node_id);
  return memo;
}

export function compareEditorHierarchyPlans(
  candidate: EditorHierarchyPlan,
  reviewer: EditorHierarchyPlan,
  reviewerFingerprint: string,
): EditorHierarchyComparison {
  const candidatePaths = semanticHierarchyPaths(candidate);
  const reviewerPaths = semanticHierarchyPaths(reviewer);
  const candidateNodes = new Set(candidatePaths.values());
  const reviewerNodes = new Set(reviewerPaths.values());
  const rawDifferences: Array<Omit<EditorHierarchyDifference, "difference_id">> = [];
  for (const path of [...candidateNodes].filter((entry) => !reviewerNodes.has(entry)).sort()) {
    rawDifferences.push({ kind: "candidate_only_node", candidate: path, reviewer: "" });
  }
  for (const path of [...reviewerNodes].filter((entry) => !candidateNodes.has(entry)).sort()) {
    rawDifferences.push({ kind: "reviewer_only_node", candidate: "", reviewer: path });
  }
  const candidateLots = new Map(candidate.lot_bindings.map((binding) => [binding.lot_key, candidatePaths.get(binding.parent_node_id) ?? `[invalid:${binding.parent_node_id}]`]));
  const reviewerLots = new Map(reviewer.lot_bindings.map((binding) => [binding.lot_key, reviewerPaths.get(binding.parent_node_id) ?? `[invalid:${binding.parent_node_id}]`]));
  for (const lotKey of [...new Set([...candidateLots.keys(), ...reviewerLots.keys()])].sort()) {
    const candidateParent = candidateLots.get(lotKey) ?? "[unbound]";
    const reviewerParent = reviewerLots.get(lotKey) ?? "[unbound]";
    if (candidateParent !== reviewerParent) rawDifferences.push({ kind: "lot_parent_mismatch", candidate: `${lotKey} => ${candidateParent}`, reviewer: `${lotKey} => ${reviewerParent}` });
  }
  const candidateLotNames = new Map(candidate.lot_bindings.map((binding) => [binding.lot_key, binding.display_name?.trim() ?? ""]));
  const reviewerLotNames = new Map(reviewer.lot_bindings.map((binding) => [binding.lot_key, binding.display_name?.trim() ?? ""]));
  for (const lotKey of [...new Set([...candidateLotNames.keys(), ...reviewerLotNames.keys()])].sort()) {
    const candidateName = candidateLotNames.get(lotKey) ?? "";
    const reviewerName = reviewerLotNames.get(lotKey) ?? "";
    if (candidateName !== reviewerName) rawDifferences.push({ kind: "lot_display_name_mismatch", candidate: `${lotKey} => ${candidateName}`, reviewer: `${lotKey} => ${reviewerName}` });
  }
  const unitSignatureByLot = (plan: EditorHierarchyPlan) => {
    const paths = semanticHierarchyPaths(plan);
    const byLot = new Map<string, string[]>();
    for (const unit of editorInspectionUnits(plan)) {
      const signature = JSON.stringify({ members: [...unit.lot_keys].sort(), name: unit.name.trim(),
        parent: paths.get(unit.parent_node_id ?? plan.lot_bindings.find(binding => binding.lot_key === unit.lot_keys[0])?.parent_node_id ?? ''),
        ...(unit.item_selections ? { item_selections: unit.item_selections.map(selection => ({ lot_key: selection.lot_key, item_ids: [...selection.item_ids].sort() })).sort((a, b) => a.lot_key.localeCompare(b.lot_key)) } : {}) });
      for (const key of unit.lot_keys) byLot.set(key, [...(byLot.get(key) ?? []), signature]);
    }
    return new Map([...byLot].map(([key, signatures]) => [key, JSON.stringify(signatures.sort())]));
  };
  const candidateUnits = unitSignatureByLot(candidate);
  const reviewerUnits = unitSignatureByLot(reviewer);
  for (const key of [...new Set([...candidateUnits.keys(), ...reviewerUnits.keys()])].sort()) {
    if (candidateUnits.get(key) !== reviewerUnits.get(key)) rawDifferences.push({ kind: "inspection_unit_mismatch", candidate: `${key} => ${candidateUnits.get(key) ?? '[unassigned]'}`, reviewer: `${key} => ${reviewerUnits.get(key) ?? '[unassigned]'}` });
  }
  const differences = rawDifferences.map((difference) => ({
    difference_id: sha256Json(difference).slice(0, 24),
    ...difference,
  }));
  return {
    schema_version: "editor-hierarchy-comparison/v1",
    candidate_plan_sha256: sha256Json(candidate),
    reviewer_plan_sha256: sha256Json(reviewer),
    reviewer_fingerprint: reviewerFingerprint,
    differences,
  };
}

export async function buildEditorHierarchyEvidence(
  jobId: string,
  markdownPath: string,
  aggregate: Record<string, unknown>,
  batch: Record<string, unknown>,
): Promise<EditorHierarchyEvidence> {
  const markdown = await readFile(markdownPath, "utf8");
  const document = buildDocumentEvidence(markdown, basename(markdownPath));
  const targetMeta = new Map<string, Record<string, unknown>>();
  if (!Array.isArray(batch.targets)) throw new Error("batch.targets must be an array");
  for (const raw of batch.targets) {
    if (!isRecord(raw)) throw new Error("batch.targets entries must be objects");
    targetMeta.set(String(raw.target_id ?? ""), raw);
  }
  if (!Array.isArray(aggregate.targets)) throw new Error("result.targets must be an array");
  const lots: EditorHierarchyLot[] = [];
  for (const rawTarget of aggregate.targets) {
    if (!isRecord(rawTarget)) throw new Error("result.targets entries must be objects");
    const targetId = String(rawTarget.target_id ?? "").trim();
    const meta = targetMeta.get(targetId);
    if (!targetId || !meta) throw new Error(`Result target has no current batch target: ${targetId}`);
    if (!Array.isArray(rawTarget.inspection_lots)) throw new Error(`result target ${targetId}.inspection_lots must be an array`);
    for (const rawLot of rawTarget.inspection_lots) {
      if (!isRecord(rawLot)) throw new Error(`result target ${targetId} contains a non-object lot`);
      const lotId = String(rawLot.lot_id ?? "").trim();
      if (!lotId) throw new Error(`result target ${targetId} contains a lot without lot_id`);
      if (!Array.isArray(rawLot.items)) throw new Error(`result lot ${lotId}.items must be an array`);
      lots.push({
        lot_key: `${targetId}::${lotId}`,
        target_id: targetId,
        target_name: String(meta.name ?? ""),
        target_description: String(meta.description ?? ""),
        target_evidence_fragments: Array.isArray(meta.evidence_fragments)
          ? meta.evidence_fragments as Array<{ atom_id: string; text: string }>
          : [],
        lot_id: lotId,
        lot_name: String(rawLot.name ?? ""),
        item_names: rawLot.items.map((item) => isRecord(item) ? String(item.name ?? "") : ""),
        items: rawLot.items.map((item) => ({ item_id: isRecord(item) ? String(item.item_id ?? '') : '',
          name: isRecord(item) ? String(item.name ?? '') : '', source_clause: isRecord(item) ? String(item.source_clause ?? '') : '' })),
      });
    }
  }
  if (duplicates(lots.map((lot) => lot.lot_key)).length) throw new Error("Current sealed result contains duplicate target/lot identities");
  const payload = {
    schema_version: EDITOR_HIERARCHY_EVIDENCE_SCHEMA_VERSION,
    job_id: jobId,
    document,
    business_result_sha256: sha256Json(aggregate),
    lots,
  };
  return { ...payload, evidence_fingerprint: sha256Json(payload) };
}

export class EditorHierarchyWorkspace {
  readonly root: string;
  readonly sourcePath: string;
  readonly evidencePath: string;
  readonly resultPath: string;
  readonly workingPlanPath: string;
  readonly candidatePlanPath: string;
  readonly lastValidPlanPath: string;
  readonly sealedPlanPath: string;
  readonly validationReceiptPath: string;
  readonly sealReceiptPath: string;
  readonly manifestPath: string;
  readonly comparisonPath: string;
  readonly reconciliationPath: string;
  readonly transcriptPath: string;
  readonly statePath: string;
  readonly historyDirectory: string;
  readonly validationDirectory: string;
  readonly piSessionDirectory: string;
  readonly reviewerPiSessionDirectory: string;
  private stateTail = Promise.resolve();
  private progressListener: ((progress: EditorHierarchyProgress) => void | Promise<void>) | undefined;

  private constructor(public readonly artifactRoot: string, public readonly jobId: string) {
    this.root = join(artifactRoot, "jobs", encodedSegment(jobId), "hierarchy");
    this.sourcePath = join(this.root, "source.md");
    this.evidencePath = join(this.root, "editor-hierarchy-evidence.json");
    this.resultPath = join(this.root, "business-result.json");
    this.workingPlanPath = join(this.root, "working.editor-hierarchy-plan.json");
    this.candidatePlanPath = join(this.root, "candidate.editor-hierarchy-plan.json");
    this.lastValidPlanPath = join(this.root, "last-valid.editor-hierarchy-plan.json");
    this.sealedPlanPath = join(this.root, "editor-hierarchy-plan.json");
    this.validationReceiptPath = join(this.root, "validation-receipt.json");
    this.sealReceiptPath = join(this.root, "seal-receipt.json");
    this.manifestPath = join(this.root, "manifest.json");
    this.comparisonPath = join(this.root, "candidate-reviewer-comparison.json");
    this.reconciliationPath = join(this.root, "candidate-reviewer-reconciliation.json");
    this.transcriptPath = join(this.root, "session.events.jsonl");
    this.statePath = join(this.root, "state.json");
    this.historyDirectory = join(this.root, "history");
    this.validationDirectory = join(this.root, "validation");
    this.piSessionDirectory = join(this.root, "pi-session");
    this.reviewerPiSessionDirectory = join(this.root, "reviewer-pi-session");
  }

  static async openOrCreate(
    artifactRoot: string,
    jobId: string,
    markdownPath: string,
    aggregate: Record<string, unknown>,
    batch: Record<string, unknown>,
  ): Promise<EditorHierarchyWorkspace> {
    const workspace = new EditorHierarchyWorkspace(artifactRoot, jobId);
    const evidence = await buildEditorHierarchyEvidence(jobId, markdownPath, aggregate, batch);
    if (await pathExists(workspace.statePath)) {
      const state = await readJson<{ schema_version?: unknown }>(workspace.statePath);
      if (state.schema_version !== "editor-hierarchy-state/v2") {
        throw new Error("Persisted editor hierarchy predates the independent-reconstruction contract; restart this job to rebuild it from current Markdown");
      }
      const existing = await workspace.readEvidence();
      if (existing.evidence_fingerprint !== evidence.evidence_fingerprint) throw new Error("Persisted hierarchy evidence does not match current source and sealed result");
      return workspace;
    }
    await mkdir(workspace.historyDirectory, { recursive: true });
    await mkdir(workspace.validationDirectory, { recursive: true });
    await mkdir(workspace.piSessionDirectory, { recursive: true });
    await mkdir(workspace.reviewerPiSessionDirectory, { recursive: true });
    await atomicWriteNewText(workspace.sourcePath, await readFile(markdownPath, "utf8"));
    await atomicWriteNewText(workspace.evidencePath, prettyJson(evidence));
    await atomicWriteNewText(workspace.resultPath, prettyJson(aggregate));
    await makeReadOnly(workspace.sourcePath);
    await makeReadOnly(workspace.evidencePath);
    await makeReadOnly(workspace.resultPath);
    await atomicWriteJson(workspace.workingPlanPath, initialEditorHierarchyPlan(evidence));
    await atomicWriteJson(workspace.statePath, {
      schema_version: "editor-hierarchy-state/v2",
      status: "working",
      next_event_sequence: 1,
      next_history_sequence: 1,
      next_validation_sequence: 1,
      last_candidate_fingerprint: "",
      last_review_fingerprint: "",
      last_comparison_fingerprint: "",
      last_reconciled_fingerprint: "",
      opened_atom_ids: [],
      opened_lot_keys: [],
      reviewer_opened_atom_ids: [],
      reviewer_opened_lot_keys: [],
      agent_runtime: { kind: "unassigned", session_id: "", session_file: "" },
      reviewer_runtime: { kind: "unassigned", session_id: "", session_file: "" },
    } satisfies HierarchyState);
    return workspace;
  }

  async readEvidence(): Promise<EditorHierarchyEvidence> { return readJson<EditorHierarchyEvidence>(this.evidencePath); }
  setProgressListener(listener: (progress: EditorHierarchyProgress) => void | Promise<void>): void {
    this.progressListener = listener;
  }
  private async withState<T>(operation: (state: HierarchyState) => T | Promise<T>): Promise<T> {
    const previous = this.stateTail;
    let release!: () => void;
    this.stateTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      const state = await readJson<HierarchyState>(this.statePath);
      const result = await operation(state);
      await atomicWriteJson(this.statePath, state);
      await this.progressListener?.({
        status: state.status,
        author_atoms_opened: state.opened_atom_ids.length,
        author_lots_opened: state.opened_lot_keys.length,
        reviewer_atoms_opened: state.reviewer_opened_atom_ids.length,
        reviewer_lots_opened: state.reviewer_opened_lot_keys.length,
      });
      return result;
    } finally { release(); }
  }
  async readState(): Promise<HierarchyState> { return this.withState((state) => structuredClone(state)); }
  async setRuntime(runtime: RuntimeState): Promise<void> { await this.withState((state) => { state.agent_runtime = runtime; }); }
  async setReviewerRuntime(runtime: RuntimeState): Promise<void> { await this.withState((state) => { state.reviewer_runtime = runtime; }); }
  async markAtomOpened(id: string, review: boolean): Promise<void> { await this.withState((state) => { const list = review ? state.reviewer_opened_atom_ids : state.opened_atom_ids; if (!list.includes(id)) list.push(id); }); }
  async markLotOpened(key: string, review: boolean): Promise<void> { await this.withState((state) => { const list = review ? state.reviewer_opened_lot_keys : state.opened_lot_keys; if (!list.includes(key)) list.push(key); }); }
  async appendEvent(eventType: string, payload: unknown): Promise<void> {
    await this.withState(async (state) => {
      await appendText(this.transcriptPath, `${JSON.stringify({ schema_version: "editor-hierarchy-event/v1", sequence: state.next_event_sequence, timestamp: new Date().toISOString(), event_type: eventType, payload })}\n`);
      state.next_event_sequence += 1;
    });
  }
  async transcriptPrefix(): Promise<{ through_sequence: number; sha256: string; byte_length: number }> {
    const state = await this.readState();
    const bytes = await readFile(this.transcriptPath).catch(() => Buffer.alloc(0));
    return { through_sequence: state.next_event_sequence - 1, sha256: createHash("sha256").update(bytes).digest("hex"), byte_length: bytes.length };
  }
  async writePlan(content: string): Promise<void> {
    if ((await this.readState()).status === "sealed") throw new Error("Editor hierarchy is already sealed");
    await atomicWriteText(this.workingPlanPath, content);
  }
  async recordHistory(before: unknown, after: unknown, operation: unknown): Promise<void> {
    await this.withState(async (state) => {
      const sequence = state.next_history_sequence++;
      await atomicWriteJson(join(this.historyDirectory, `${String(sequence).padStart(6, "0")}.json`), { schema_version: "editor-hierarchy-history/v1", before_sha256: sha256Json(before), after_sha256: sha256Json(after), operation });
    });
  }
  async recordValidation(validation: EditorHierarchyValidation, phase: EditorHierarchyPhase): Promise<void> {
    await this.withState(async (state) => {
      const sequence = state.next_validation_sequence++;
      if (validation.ok) {
        if (phase === "review") state.last_review_fingerprint = validation.fingerprint!;
        else state.last_candidate_fingerprint = validation.fingerprint!;
        await atomicWriteJson(this.lastValidPlanPath, validation.plan);
      }
      await atomicWriteJson(join(this.validationDirectory, `${String(sequence).padStart(6, "0")}.json`), validation);
      await atomicWriteJson(this.validationReceiptPath, validation);
    });
  }
  async markCandidate(plan: EditorHierarchyPlan): Promise<void> {
    await atomicWriteNewText(this.candidatePlanPath, prettyJson(plan));
    await makeReadOnly(this.candidatePlanPath);
    await atomicWriteJson(this.workingPlanPath, initialEditorHierarchyPlan(await this.readEvidence()));
    await this.withState((state) => {
      state.status = "candidate";
      state.reviewer_opened_atom_ids = [];
      state.reviewer_opened_lot_keys = [];
      state.last_review_fingerprint = "";
      state.last_comparison_fingerprint = "";
      state.last_reconciled_fingerprint = "";
    });
  }
  async markCompared(fingerprint: string, reconciled: boolean): Promise<void> { await this.withState((state) => { state.last_comparison_fingerprint = fingerprint; state.last_reconciled_fingerprint = reconciled ? fingerprint : ""; }); }
  async markReconciled(fingerprint: string): Promise<void> { await this.withState((state) => { state.last_reconciled_fingerprint = fingerprint; }); }
  async markSealed(): Promise<void> { await this.withState((state) => { state.status = "sealed"; }); }
}

interface ToolResponse { ok: boolean; [key: string]: unknown }

export class EditorHierarchyController {
  private confirmBaseline?: EditorHierarchyPlan;

  private constructor(
    public readonly workspace: EditorHierarchyWorkspace,
    public readonly evidence: EditorHierarchyEvidence,
    public readonly phase: EditorHierarchyPhase,
    public readonly confirmContext?: HierarchyConfirmContext,
  ) {}
  static async create(
    workspace: EditorHierarchyWorkspace,
    phase: EditorHierarchyPhase,
    confirmContext?: HierarchyConfirmContext,
  ): Promise<EditorHierarchyController> {
    const controller = new EditorHierarchyController(workspace, await workspace.readEvidence(), phase, confirmContext);
    if (confirmContext) {
      try {
        controller.confirmBaseline = await readJson<EditorHierarchyPlan>(workspace.workingPlanPath);
      } catch {
        // baseline unavailable; confirm patch guard stays inactive
      }
    }
    return controller;
  }
  async dispatch(name: string, input: Record<string, unknown>, callId: string = randomUUID()): Promise<ToolResponse> {
    await this.workspace.appendEvent("tool_execution_start", { tool_call_id: callId, tool: name, input });
    let output: ToolResponse;
    try {
      if (name === "get_hierarchy_contract") output = this.contract();
      else if (name === "list_document_atoms") output = this.listAtoms();
      else if (name === "open_document_atom") output = await this.openAtom(String(input.atom_id ?? ""));
      else if (name === "search_document") output = this.search(String(input.query ?? ""));
      else if (name === "list_sealed_lots") output = this.listLots();
      else if (name === "open_sealed_lot") output = await this.openLot(String(input.lot_key ?? ""));
      else if (name === "read_hierarchy_plan") {
        const plan = await readJson<unknown>(this.workspace.workingPlanPath);
        output = { ok: true, plan, record_catalog: hierarchyRecordCatalog(plan), preferred_edit_tool: "edit_hierarchy_records" };
      }
      else if (name === "edit_hierarchy_records") output = await this.editRecords(input.edits);
      else if (name === "patch_hierarchy_plan") output = await this.patch(input.operations as JsonPatchOperation[]);
      else if (name === "validate_hierarchy_plan") output = await this.validate();
      else if (name === "compare_hierarchy_candidate") output = this.phase === "review" ? await this.compare(String(input.fingerprint ?? "")) : toolReject({ error: "hierarchy_phase_forbidden", instruction: "This candidate session can submit_hierarchy_candidate, not compare_hierarchy_candidate.", actual_phase: this.phase });
      else if (name === "record_hierarchy_reconciliation") output = this.phase === "review" ? await this.reconcile(String(input.fingerprint ?? ""), input.resolutions as unknown[]) : toolReject({ error: "hierarchy_phase_forbidden", instruction: "This candidate session can submit_hierarchy_candidate, not record_hierarchy_reconciliation.", actual_phase: this.phase });
      else if (name === "submit_hierarchy_candidate") output = this.phase === "candidate" ? await this.submit(String(input.fingerprint ?? "")) : toolReject({ error: "hierarchy_phase_forbidden", instruction: "This independent review session can seal_hierarchy_plan, not submit_hierarchy_candidate.", actual_phase: this.phase });
      else if (name === "seal_hierarchy_plan") output = this.phase === "review" ? await this.seal(String(input.fingerprint ?? "")) : toolReject({ error: "hierarchy_phase_forbidden", instruction: "This candidate session can submit_hierarchy_candidate, not seal_hierarchy_plan.", actual_phase: this.phase });
      else output = toolReject({
        error: "unknown_hierarchy_tool",
        instruction: "Use a tool listed by get_hierarchy_contract. Do not invent tool names.",
        actual_tool: name,
        candidate_read_tool: "get_hierarchy_contract",
      });
    } catch (error) {
      output = catchToolReject(error, "hierarchy_tool_rejected");
    }
    await this.workspace.appendEvent("tool_execution_end", { tool_call_id: callId, tool: name, output });
    return output;
  }
  private contract(): ToolResponse {
    const confirm = this.confirmContext;
    return {
      ok: true,
      authority: confirm
        ? "The deterministic ledger assembly is an editable candidate, not semantic authority. Confirm mode may rename, merge, split, or re-parent allowed nodes and may rebind any lot when current-document evidence supports it. Preserve one default lot_bindings entry per source lot; inspection_units may partition its items. Keep existing node types and the fixed root ontology."
        : "The Agent decides every semantic hierarchy node and every lot attachment from the complete current document. IDs, headings, numbering, layout, order, prior jobs, and expected outputs are not hierarchy authority.",
      ...(confirm ? { confirm_context: confirm } : {}),
      plan_template: { ...initialEditorHierarchyPlan(this.evidence), inspection_units: [] },
      inspection_unit_template: { unit_id: "stable-business-unit-id", name: "适用的原文验收单元名称或有依据的归纳名", lot_keys: ["target-id::lot-id"], source_title_fragments: [], evidence_fragments: [{ atom_id: "atom:exact-id", text: "逐字原文" }], reason: "共同组织或独立保留的依据，不能仅以分片或对象不同为理由" },
      inspection_unit_item_selection: { optional_fields: { parent_node_id: "explicit-division-node-id", item_selections: [{ lot_key: "target-id::lot-id", item_ids: ["open_sealed_lot 返回的精确 item_id"] }] },
        instruction: HIERARCHY_ITEM_ASSIGNMENT_GUIDANCE },
      inspection_unit_policy: `${ACCEPTANCE_ORGANIZATION_GUIDANCE}\n${INSPECTION_UNIT_GUIDANCE}`,
      semantic_constraint_template: { constraint_id: "stable-constraint-id", kind: "level_definition | child_count | child_enumeration | scope_assignment | other", parent_node_id: "root-or-node-id", node_type: "子分部 | 分项", node_ids: ["covered-node-id"], expected_count: null, exhaustive: false, evidence_fragments: [{ atom_id: "atom:exact-id", text: "逐字原文" }], interpretation: "原文对层级的业务约束；若明确数量则使用child_count并填写expected_count" },
      atom_disposition_template: { atom_id: "atom:exact-id", disposition: "hierarchy_authority | supporting_context | no_hierarchy_effect", constraint_ids: ["constraint-id-if-authority"], reason: "该全文窗口为何约束或不约束层级" },
      node_template: { node_id: "stable-semantic-id", parent_node_id: "root-or-node-id", node_type: "子分部 | 分项", name: "领域名称", constraint_ids: ["constraint-id"], evidence_fragments: [{ atom_id: "atom:exact-id", text: "逐字原文" }], reason: "语义归属依据" },
      lot_binding_template: { lot_key: "target-id::lot-id", parent_node_id: "explicit-division-node-id", display_name: "优先沿用适用原名，确需归纳时说明范围差异", source_title_fragments: [], constraint_ids: ["constraint-id"], evidence_fragments: [{ atom_id: "atom:exact-id", text: "逐字原文" }], reason: "原标题对应关系、沿用或归纳名称的依据及父分项归属" },
      lot_naming_policy: LOT_NAMING_GUIDANCE,
      source_title_contract: "新计划在每个 inspection_units 单元填写 source_title_fragments：从已打开原文选择对应标题的精确 {atom_id,text}，保留编号，跨节分别列出；无标题填 [] 并在 reason 说明。局部 lot_bindings 的旧标签可保留，不需逐一重命名。原标题不接受模型归纳名，不按最近标题自动指派。",
      record_editing: { tool: "edit_hierarchy_records", collection_keys: { ...HIERARCHY_RECORD_KEYS },
        instruction: "使用 read_hierarchy_plan 的 record_catalog 按稳定 key 修改具体记录；不要数数组下标或按连续位置批量决定归属。edits 每次 1–40 项；update 的 value 仅含改变的顶层字段，upsert 是完整记录。key 由程序注入，不改变业务判断。" },
      rules: confirm
        ? [
            "The working plan is an editable candidate. confirm_context.uncertain_lot_keys highlights weak matches but does not make other names or bindings semantic authority.",
            "You may rename, add, delete, merge, split, or re-parent allowed 分项/子分部 nodes and may rebind any lot when evidence supports it. Keep existing node types. Source default bindings and explicit item memberships follow inspection_unit_item_selection.",
            "Do not open every document atom. list_document_atoms returns only atoms overlapping unmatched lots or record-table captions; search_document remains available.",
            "Open unmatched sealed lots before changing their bindings. Keep 子分部 under root and 分项 under a 子分部.",
            "A child_count constraint must enumerate exactly the children it counts, and an exhaustive child_enumeration must equal the authored child set.",
            "lot_bindings contains one default attachment per source lot; explicit inspection_units memberships determine actual business assignment.",
            LOT_NAMING_GUIDANCE,
            "Edit the observable JSON workfile with bounded patches, validate, repair all diagnostics, then submit the exact fingerprint.",
          ]
        : [
            "Open every document atom and every sealed lot in this session; list/search previews do not count.",
            "Create hierarchy from industry meaning only. Never convert discovery group fields, target IDs, headings, numbers, keywords, table layout, order, or OCR shape into hierarchy.",
            "Before authoring nodes, dispose every document atom for hierarchy meaning and write exact evidence-bound semantic constraints. Explicit definitions, counts, enumerations, scope assignments, and competing statements must be represented; opening an atom is not semantic review.",
            "A child_count constraint must enumerate exactly the children it counts, and an exhaustive child_enumeration must equal the authored child set. Unreconciled contradictions between semantic constraints and the tree cannot validate.",
            "lot_bindings contains one default attachment per source lot; explicit inspection_units memberships may partition its items across 分项. One target may split across multiple 分项 and multiple targets may share one 分项.",
            LOT_NAMING_GUIDANCE,
            "Every node and binding must cite exact immutable document fragments and explain its semantic decision.",
            "Edit the observable JSON workfile with bounded patches, validate, repair all diagnostics, then submit or seal the exact fingerprint.",
          ],
    };
  }
  private confirmNeedles(): string[] {
    const confirm = this.confirmContext;
    if (!confirm) return [];
    return [
      ...confirm.uncertain_lot_keys,
      ...confirm.ledger_summary.record_tables.flatMap((table) => [table.table_no, table.title, table.nearby_text]),
      ...this.evidence.lots
        .filter((lot) => confirm.uncertain_lot_keys.includes(lot.lot_key))
        .flatMap((lot) => [lot.target_name, lot.lot_name, ...lot.item_names]),
    ].map((value) => value.trim()).filter((value) => value.length >= 2);
  }
  private listAtoms(): ToolResponse {
    const needles = this.confirmNeedles();
    const atoms = needles.length
      ? this.evidence.document.atoms.filter((atom) => needles.some((needle) => atom.text.includes(needle)))
      : this.evidence.document.atoms;
    const listed = atoms.length ? atoms : this.evidence.document.atoms.slice(0, 1);
    return {
      ok: true,
      confirm_mode: Boolean(this.confirmContext),
      atoms: listed.map((atom) => ({
        atom_id: atom.atom_id,
        start_line: atom.start_line,
        end_line: atom.end_line,
        char_count: atom.text.length,
        preview: atom.text.slice(0, 240).replace(/\s+/g, " "),
      })),
    };
  }
  private listLots(): ToolResponse {
    const uncertain = new Set(this.confirmContext?.uncertain_lot_keys ?? []);
    return {
      ok: true,
      confirm_mode: Boolean(this.confirmContext),
      lots: this.evidence.lots.map((lot) => ({
        lot_key: lot.lot_key,
        target_name: lot.target_name,
        lot_name: lot.lot_name,
        item_count: lot.item_names.length,
        unmatched: uncertain.has(lot.lot_key),
      })),
    };
  }
  private async openAtom(id: string): Promise<ToolResponse> {
    const atom = this.evidence.document.atoms.find((entry) => entry.atom_id === id);
    if (!atom) {
      return toolReject({
        error: "unknown_document_atom",
        instruction: "Copy an atom_id from list_document_atoms. Do not invent atom ids.",
        actual_atom_id: id,
        candidate_read_tool: "list_document_atoms",
      });
    }
    if (this.confirmContext) {
      const needles = this.confirmNeedles();
      if (needles.length && !needles.some((needle) => atom.text.includes(needle))) {
        return {
          ok: false,
          error: "confirm_mode_atom_forbidden",
          action: "open only atoms overlapping unmatched lots or record-table captions",
        };
      }
    }
    await this.workspace.markAtomOpened(id, this.phase === "review");
    return { ok: true, atom };
  }
  private async openLot(key: string): Promise<ToolResponse> {
    const lot = this.evidence.lots.find((entry) => entry.lot_key === key);
    if (!lot) {
      return toolReject({
        error: "Unknown sealed lot",
        instruction: "Copy lot_key from list_sealed_lots. Do not invent lot keys.",
        actual_lot_key: key,
        candidate_read_tool: "list_sealed_lots",
      });
    }
    // confirm 阶段现在要负责分项的命名、合并与归属，判断依据就是各检验批本身，
    // 所以每个封存检验批都必须可读。原来只放行 uncertain_lot_keys，等于让它
    // 在看不见大多数检验批的情况下决定分项边界。开放的只是「读」，
    // 「每个检验批恰好绑定一次」仍由基础校验器保证。
    await this.workspace.markLotOpened(key, this.phase === "review");
    return { ok: true, lot };
  }
  private search(query: string): ToolResponse { const needle = query.trim(); if (needle.length < 2) return { ok: false, error: "Search query must contain at least two characters" }; return { ok: true, matches: this.evidence.document.atoms.flatMap((atom) => { const index = atom.text.toLocaleLowerCase().indexOf(needle.toLocaleLowerCase()); return index < 0 ? [] : [{ atom_id: atom.atom_id, offset_in_atom: index, preview: atom.text.slice(Math.max(0, index - 100), index + needle.length + 180) }]; }).slice(0, 30) }; }
  private async editRecords(edits: unknown): Promise<ToolResponse> {
    const before = await readJson<unknown>(this.workspace.workingPlanPath);
    let operations: JsonPatchOperation[];
    try { operations = hierarchyRecordEditOperations(before, edits); }
    catch (error) {
      return toolReject({ error: "hierarchy_record_edit_rejected", actual_error: error instanceof Error ? error.message : String(error),
        instruction: "本次事务未保存。用 read_hierarchy_plan.record_catalog 核对 collection 和稳定 key；update 只交改变的顶层字段，upsert 交完整新记录，remove 指定现存 key。保持身份不变，不能按数组顺序推断业务归属。修正后重试 edit_hierarchy_records。",
        candidate_read_tool: "read_hierarchy_plan", next_tool: "edit_hierarchy_records" });
    }
    return this.patch(operations);
  }
  private async patch(operations: JsonPatchOperation[]): Promise<ToolResponse> {
    if (!Array.isArray(operations) || operations.length < 1 || operations.length > 40) {
      return { ok: false, error: "Patch must contain 1-40 operations" };
    }
    const before = await readJson<unknown>(this.workspace.workingPlanPath);
    const after = applyJsonPatch(before, operations);
    if (this.confirmContext && this.confirmBaseline && isRecord(after)) {
      const confirmIssues = confirmModeHierarchyIssues(
        this.confirmBaseline,
        after as unknown as EditorHierarchyPlan,
        this.confirmContext,
      );
      if (confirmIssues.length) {
        return {
          ok: false,
          error: "confirm_mode_rebuild_forbidden",
          issues: confirmIssues,
          action: "preserve every sealed lot exactly once, keep existing node types unchanged, and keep higher-level ontology intact",
        };
      }
    }
    await this.workspace.writePlan(prettyJson(after));
    await this.workspace.recordHistory(before, after, { type: "json_patch", operations });
    return { ok: true, before_sha256: sha256Json(before), after_sha256: sha256Json(after) };
  }
  private async validate(): Promise<ToolResponse> {
    let plan: unknown;
    try { plan = strictJsonParse(await readFile(this.workspace.workingPlanPath, "utf8")); }
    catch (error) { const validation: EditorHierarchyValidation = { ok: false, issues: [{ code: "invalid_json", path: "", message: error instanceof Error ? error.message : String(error) }] }; await this.workspace.recordValidation(validation, this.phase); return { ...validation }; }
    const state = await this.workspace.readState();
    const validation = validateEditorHierarchyPlan(plan, this.evidence, new Set(this.phase === "review" ? state.reviewer_opened_atom_ids : state.opened_atom_ids), new Set(this.phase === "review" ? state.reviewer_opened_lot_keys : state.opened_lot_keys));
    await this.workspace.recordValidation(validation, this.phase);
    return { ...validation, ...(!validation.ok ? {
      repair_targets: validation.issues.map(issue => ({ code: issue.code, path: issue.path, ...hierarchyIssueRepairContext(plan, issue.path) })),
      instruction: "校验未通过，不可提交或封存。按 repair_targets 的 collection/key 核对具体记录；原文问题用 source_read_tool 读取指定 atom 并复制精确片段。用 edit_hierarchy_records 保存语义修订后重新 validate_hierarchy_plan；不得改原文、业务成品或封存检验批。",
    } : {}) };
  }
  private async submit(fingerprint: string): Promise<ToolResponse> {
    const state = await this.workspace.readState();
    const plan = await readJson<EditorHierarchyPlan>(this.workspace.workingPlanPath);
    const validation = validateEditorHierarchyPlan(plan, this.evidence, new Set(state.opened_atom_ids), new Set(state.opened_lot_keys));
    if (!fingerprint || fingerprint !== state.last_candidate_fingerprint) {
      return fingerprintMismatchReject({
        error: "Candidate fingerprint does not match latest successful validation",
        submitted: fingerprint,
        expected: state.last_candidate_fingerprint ?? "",
        validate_tool: "validate_hierarchy_plan",
        ...(validation.ok && validation.fingerprint === state.last_candidate_fingerprint
          ? { verified_retry: { tool: "submit_hierarchy_candidate", arguments: { fingerprint: state.last_candidate_fingerprint! } } } : {}),
      });
    }
    if (this.confirmContext && this.confirmBaseline) {
      const confirmIssues = confirmModeHierarchyIssues(this.confirmBaseline, plan, this.confirmContext);
      if (confirmIssues.length) {
        return {
          ok: false,
          error: "confirm_mode_rebuild_forbidden",
          issues: confirmIssues,
          action: "preserve every sealed lot exactly once, keep existing node types unchanged, and keep higher-level ontology intact",
        };
      }
    }
    if (!validation.ok || validation.fingerprint !== fingerprint) {
      return toolReject({
        error: "Hierarchy workfile changed after candidate validation",
        instruction: "Re-run validate_hierarchy_plan. Repair using the returned issues, then submit the new fingerprint.",
        issues: validation.issues,
        candidate_read_tool: "validate_hierarchy_plan",
        required_action: "repair_using_returned_issues",
      });
    }
    await this.workspace.markCandidate(plan);
    return { ok: true, status: "candidate", fingerprint };
  }
  private async compare(fingerprint: string): Promise<ToolResponse> {
    const state = await this.workspace.readState();
    if (!fingerprint || fingerprint !== state.last_review_fingerprint) return { ok: false, error: "Comparison fingerprint does not match latest successful independent reconstruction" };
    const reviewer = await readJson<EditorHierarchyPlan>(this.workspace.workingPlanPath);
    const reviewerValidation = validateEditorHierarchyPlan(reviewer, this.evidence, new Set(state.reviewer_opened_atom_ids), new Set(state.reviewer_opened_lot_keys));
    if (!reviewerValidation.ok || reviewerValidation.fingerprint !== fingerprint) return { ok: false, error: "Independent reconstruction changed after validation", issues: reviewerValidation.issues };
    const candidate = await readJson<EditorHierarchyPlan>(this.workspace.candidatePlanPath);
    const candidateValidation = validateEditorHierarchyPlan(candidate, this.evidence, new Set(this.evidence.document.atoms.map((atom) => atom.atom_id)), new Set(this.evidence.lots.map((lot) => lot.lot_key)));
    if (!candidateValidation.ok) return { ok: false, error: "Author candidate no longer satisfies the current contract", issues: candidateValidation.issues };
    const comparison = compareEditorHierarchyPlans(candidate, reviewer, fingerprint);
    await atomicWriteText(this.workspace.comparisonPath, prettyJson(comparison));
    await this.workspace.markCompared(fingerprint, comparison.differences.length === 0);
    return { ok: true, comparison, reconciliation_required: comparison.differences.length > 0 };
  }
  private async reconcile(fingerprint: string, resolutions: unknown[]): Promise<ToolResponse> {
    const state = await this.workspace.readState();
    if (!fingerprint || fingerprint !== state.last_review_fingerprint || fingerprint !== state.last_comparison_fingerprint) return { ok: false, error: "Reconciliation requires a current validated and compared independent reconstruction" };
    const comparison = await readJson<EditorHierarchyComparison>(this.workspace.comparisonPath);
    if (comparison.reviewer_fingerprint !== fingerprint) return { ok: false, error: "Comparison is stale" };
    if (!Array.isArray(resolutions)) return { ok: false, error: "resolutions must be an array" };
    const issues: EditorHierarchyIssue[] = [];
    const atomById = new Map(this.evidence.document.atoms.map((atom) => [atom.atom_id, atom]));
    const knownDifferenceIds = new Set(comparison.differences.map((difference) => difference.difference_id));
    const resolvedIds: string[] = [];
    resolutions.forEach((raw, index) => {
      const path = `/resolutions/${index}`;
      if (!isRecord(raw)) {
        issues.push({ code: "resolution_type", path, message: "Difference resolution must be an object" });
        return;
      }
      const extras = Object.keys(raw).filter((key) => !new Set(["difference_id", "evidence_fragments", "reason"]).has(key));
      if (extras.length) issues.push({ code: "unknown_resolution_fields", path, message: "Unknown difference resolution fields", details: extras });
      const differenceId = typeof raw.difference_id === "string" ? raw.difference_id.trim() : "";
      resolvedIds.push(differenceId);
      if (!knownDifferenceIds.has(differenceId)) issues.push({ code: "unknown_difference", path: `${path}/difference_id`, message: "Resolution cites an unknown comparison difference" });
      exactFragments(raw.evidence_fragments, `${path}/evidence_fragments`, atomById, new Set(state.reviewer_opened_atom_ids), issues);
      if (typeof raw.reason !== "string" || !raw.reason.trim()) issues.push({ code: "resolution_reason", path: `${path}/reason`, message: "Resolution must explain why the independent reconstruction is retained" });
    });
    const repeated = duplicates(resolvedIds);
    if (repeated.length) issues.push({ code: "duplicate_difference_resolution", path: "/resolutions", message: "Each comparison difference must be resolved exactly once", details: repeated });
    const resolvedSet = new Set(resolvedIds);
    const missing = comparison.differences.map((difference) => difference.difference_id).filter((id) => !resolvedSet.has(id));
    if (missing.length) issues.push({ code: "missing_difference_resolutions", path: "/resolutions", message: "Every author/reviewer difference needs an evidence-bound resolution", details: missing });
    if (issues.length) return { ok: false, issues };
    const reconciliation = { schema_version: "editor-hierarchy-reconciliation/v1", reviewer_fingerprint: fingerprint, comparison_sha256: sha256Json(comparison), resolutions };
    await atomicWriteText(this.workspace.reconciliationPath, prettyJson(reconciliation));
    await this.workspace.markReconciled(fingerprint);
    return { ok: true, resolved_difference_count: resolutions.length };
  }
  private async seal(fingerprint: string): Promise<ToolResponse> {
    const state = await this.workspace.readState();
    if (!fingerprint || fingerprint !== state.last_review_fingerprint) return { ok: false, error: "Seal fingerprint does not match latest successful independent validation" };
    if (fingerprint !== state.last_comparison_fingerprint) return { ok: false, error: "Independent reconstruction must be compared with the hidden author candidate before sealing" };
    if (fingerprint !== state.last_reconciled_fingerprint) return { ok: false, error: "Every candidate/reviewer difference must be reconciled with exact current-document evidence before sealing" };
    const plan = await readJson<EditorHierarchyPlan>(this.workspace.workingPlanPath);
    const validation = validateEditorHierarchyPlan(plan, this.evidence, new Set(state.reviewer_opened_atom_ids), new Set(state.reviewer_opened_lot_keys));
    if (!validation.ok || validation.fingerprint !== fingerprint) return { ok: false, error: "Hierarchy workfile changed after review validation", issues: validation.issues };
    const planText = prettyJson(plan);
    await atomicWriteNewText(this.workspace.sealedPlanPath, planText);
    const comparison = await readJson<EditorHierarchyComparison>(this.workspace.comparisonPath);
    const receipt = { schema_version: "editor-hierarchy-seal/v2", fingerprint, plan_sha256: validation.plan_sha256, evidence_fingerprint: this.evidence.evidence_fingerprint, candidate_plan_sha256: comparison.candidate_plan_sha256, comparison_sha256: sha256Json(comparison), reconciliation_sha256: await pathExists(this.workspace.reconciliationPath) ? sha256Json(await readJson<unknown>(this.workspace.reconciliationPath)) : null, transcript: await this.workspace.transcriptPrefix() };
    await atomicWriteNewText(this.workspace.sealReceiptPath, prettyJson(receipt));
    const manifest = { schema_version: "editor-hierarchy-manifest/v2", job_id: this.workspace.jobId, node_count: plan.nodes.length, lot_binding_count: plan.lot_bindings.length, files: { plan_sha256: sha256Text(planText), candidate_plan_sha256: sha256Json(await readJson<EditorHierarchyPlan>(this.workspace.candidatePlanPath)), comparison_sha256: sha256Json(comparison), seal_receipt_sha256: sha256Json(receipt), evidence_sha256: sha256Json(this.evidence) } };
    await atomicWriteNewText(this.workspace.manifestPath, prettyJson(manifest));
    await makeReadOnly(this.workspace.sealedPlanPath); await makeReadOnly(this.workspace.sealReceiptPath); await makeReadOnly(this.workspace.manifestPath); await chmod(this.workspace.workingPlanPath, 0o444); await this.workspace.markSealed();
    return { ok: true, fingerprint, node_count: plan.nodes.length, lot_binding_count: plan.lot_bindings.length };
  }

  /**
   * 直接封印 author 候选（PI_AGENT_HIERARCHY_REVIEW=off 时使用）：
   * 不跑独立重建复核，但对候选跑全套确定性校验（枚举/计数/覆盖/无环），
   * 封印契约与复核封印一致，receipt 里显式标记 independent_review: "skipped"。
   */
  async sealCandidateWithoutReview(): Promise<ToolResponse> {
    if (this.phase !== "candidate") {
      return toolReject({
        error: "hierarchy_phase_forbidden",
        instruction: "This independent review session can seal_hierarchy_plan, not skip review from the candidate controller.",
        actual_phase: this.phase,
      });
    }
    const state = await this.workspace.readState();
    if (state.status !== "candidate") {
      return toolReject({
        error: "hierarchy_no_candidate",
        instruction: "Submit a validated hierarchy candidate first, then seal.",
        status: state.status,
        candidate_read_tool: "validate_hierarchy_plan",
      });
    }
    if (!(await pathExists(this.workspace.candidatePlanPath))) {
      return toolReject({
        error: "hierarchy_candidate_missing",
        instruction: "Submit a validated hierarchy candidate so candidatePlanPath exists, then seal.",
        candidate_read_tool: "validate_hierarchy_plan",
      });
    }
    const plan = await readJson<EditorHierarchyPlan>(this.workspace.candidatePlanPath);
    const validation = validateEditorHierarchyPlan(
      plan,
      this.evidence,
      new Set(this.evidence.document.atoms.map((atom) => atom.atom_id)),
      new Set(this.evidence.lots.map((lot) => lot.lot_key)),
    );
    if (!validation.ok || !validation.fingerprint) {
      return toolReject({
        error: "hierarchy_candidate_invalid",
        instruction: "Repair the hierarchy workfile using issues, then validate_hierarchy_plan and submit the new fingerprint.",
        issues: validation.issues,
        required_action: "repair_using_returned_issues",
        candidate_read_tool: "validate_hierarchy_plan",
      });
    }
    const planText = prettyJson(plan);
    await atomicWriteNewText(this.workspace.sealedPlanPath, planText);
    const receipt = {
      schema_version: "editor-hierarchy-seal/v2",
      fingerprint: validation.fingerprint,
      plan_sha256: validation.plan_sha256,
      evidence_fingerprint: this.evidence.evidence_fingerprint,
      candidate_plan_sha256: sha256Json(plan),
      comparison_sha256: null,
      reconciliation_sha256: null,
      independent_review: "skipped",
      transcript: await this.workspace.transcriptPrefix(),
    };
    await atomicWriteNewText(this.workspace.sealReceiptPath, prettyJson(receipt));
    const manifest = {
      schema_version: "editor-hierarchy-manifest/v2",
      job_id: this.workspace.jobId,
      node_count: plan.nodes.length,
      lot_binding_count: plan.lot_bindings.length,
      independent_review: "skipped",
      files: {
        plan_sha256: sha256Text(planText),
        candidate_plan_sha256: sha256Json(plan),
        comparison_sha256: null,
        seal_receipt_sha256: sha256Json(receipt),
        evidence_sha256: sha256Json(this.evidence),
      },
    };
    await atomicWriteNewText(this.workspace.manifestPath, prettyJson(manifest));
    await makeReadOnly(this.workspace.sealedPlanPath);
    await makeReadOnly(this.workspace.sealReceiptPath);
    await makeReadOnly(this.workspace.manifestPath);
    await chmod(this.workspace.workingPlanPath, 0o444);
    await this.workspace.markSealed();
    return {
      ok: true,
      fingerprint: validation.fingerprint,
      node_count: plan.nodes.length,
      lot_binding_count: plan.lot_bindings.length,
      independent_review: "skipped",
    };
  }
}

function resultContent(value: ToolResponse): { content: Array<{ type: "text"; text: string }>; details: ToolResponse } {
  return { content: [{ type: "text", text: JSON.stringify(value) }], details: value };
}

export function createEditorHierarchyTools(controller: EditorHierarchyController): ToolDefinition[] {
  const tool = <T>(name: string, label: string, description: string, parameters: T): ToolDefinition => defineTool({ name, label, description, parameters: parameters as never, executionMode: "sequential", execute: async (id, params) => resultContent(await controller.dispatch(name, params as Record<string, unknown>, id)) });
  const definitions = [
    tool("get_hierarchy_contract", "读取层级契约", ACCEPTANCE_TOOL_DESCRIPTIONS["get_hierarchy_contract"]!, Type.Object({})),
    tool("list_document_atoms", "列出文档原子", ACCEPTANCE_TOOL_DESCRIPTIONS["list_document_atoms"]!, Type.Object({})),
    tool("open_document_atom", "打开文档原子", ACCEPTANCE_TOOL_DESCRIPTIONS["open_document_atom"]!, Type.Object({ atom_id: Type.String() })),
    tool("search_document", "检索文档", ACCEPTANCE_TOOL_DESCRIPTIONS["search_document"]!, Type.Object({ query: Type.String() })),
    tool("list_sealed_lots", "列出已封存检验批", ACCEPTANCE_TOOL_DESCRIPTIONS["list_sealed_lots"]!, Type.Object({})),
    tool("open_sealed_lot", "打开已封存检验批", ACCEPTANCE_TOOL_DESCRIPTIONS["open_sealed_lot"]!, Type.Object({ lot_key: Type.String() })),
    tool("read_hierarchy_plan", "读取层级计划", ACCEPTANCE_TOOL_DESCRIPTIONS["read_hierarchy_plan"]!, Type.Object({})),
    tool("edit_hierarchy_records", "按身份修订层级", ACCEPTANCE_TOOL_DESCRIPTIONS["edit_hierarchy_records"]!, Type.Object({ edits: Type.Array(Type.Object({
      collection: Type.Union(Object.keys(HIERARCHY_RECORD_KEYS).map((name) => Type.Literal(name))),
      key: Type.String(), op: Type.Union([Type.Literal("update"), Type.Literal("upsert"), Type.Literal("remove")]), value: Type.Optional(Type.Unknown()),
    })) })),
    tool("patch_hierarchy_plan", "修订层级计划", ACCEPTANCE_TOOL_DESCRIPTIONS["patch_hierarchy_plan"]!, Type.Object({ operations: Type.Array(Type.Object({ op: Type.Union([Type.Literal("add"), Type.Literal("replace"), Type.Literal("remove")]), path: Type.String(), value: Type.Optional(Type.Unknown()) })) })),
    tool("validate_hierarchy_plan", "验证层级计划", ACCEPTANCE_TOOL_DESCRIPTIONS["validate_hierarchy_plan"]!, Type.Object({})),
  ];
  definitions.push(controller.phase === "candidate"
    ? tool("submit_hierarchy_candidate", "提交层级候选", ACCEPTANCE_TOOL_DESCRIPTIONS["submit_hierarchy_candidate"]!, Type.Object({ fingerprint: Type.String() }))
    : tool("compare_hierarchy_candidate", "比较隐藏层级候选", ACCEPTANCE_TOOL_DESCRIPTIONS["compare_hierarchy_candidate"]!, Type.Object({ fingerprint: Type.String() })));
  if (controller.phase === "review") {
    definitions.push(tool("record_hierarchy_reconciliation", "解决层级差异", ACCEPTANCE_TOOL_DESCRIPTIONS["record_hierarchy_reconciliation"]!, Type.Object({
      fingerprint: Type.String(),
      resolutions: Type.Array(Type.Object({
        difference_id: Type.String(),
        evidence_fragments: Type.Array(Type.Object({ atom_id: Type.String(), text: Type.String() })),
        reason: Type.String(),
      })),
    })));
    definitions.push(tool("seal_hierarchy_plan", "封存层级计划", ACCEPTANCE_TOOL_DESCRIPTIONS["seal_hierarchy_plan"]!, Type.Object({ fingerprint: Type.String() })));
  }
  return definitions.map(replaceAcceptanceToolText);
}
