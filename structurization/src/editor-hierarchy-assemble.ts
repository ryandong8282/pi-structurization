import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { sha256Text } from "./canonical.js";
import type { DocumentLedger } from "./document-ledger.js";
import {
  EDITOR_HIERARCHY_PLAN_SCHEMA_VERSION,
  type EditorHierarchyEvidence,
  type EditorHierarchyLot,
  type EditorHierarchyPlan,
  type HierarchyConfirmContext,
} from "./editor-hierarchy.js";

export interface SpecTreeNode {
  name?: string;
  node_type?: string;
  type_name?: string;
  children?: SpecTreeNode[];
}

export interface HierarchyAssemblyResult {
  plan: EditorHierarchyPlan;
  uncertain_lot_keys: string[];
  unmapped_division_names: string[];
}

function normalizeName(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/\s+/g, "")
    .replace(/工程|分项|检验批|质量验收记录|验收记录表|记录表/g, "")
    .replace(/[（）()【】\[\]：:、，,。]/g, "");
}

function titlesRelated(left: string, right: string): boolean {
  const a = normalizeName(left);
  const b = normalizeName(right);
  if (!a || !b || a.length < 2 || b.length < 2) return false;
  return a === b || a.includes(b) || b.includes(a);
}

function clauseTokens(values: string[]): string[] {
  return [...new Set(values.flatMap((value) =>
    [...value.matchAll(/(\d+(?:\.\d+){1,3}|[A-Za-z]\.\d+(?:\.\d+)*)/g)].map((match) => match[1]!)
  ))];
}

function fragmentFor(text: string, evidence: EditorHierarchyEvidence): { atom_id: string; text: string } {
  const atoms = evidence.document.atoms;
  const needle = text.trim();
  for (const atom of atoms) {
    if (needle && atom.text.includes(needle)) {
      return { atom_id: atom.atom_id, text: needle.slice(0, Math.min(needle.length, 80)) };
    }
  }
  for (const atom of atoms) {
    const compact = needle.slice(0, 8);
    if (compact && atom.text.includes(compact)) {
      return { atom_id: atom.atom_id, text: compact };
    }
  }
  const atom = atoms[0]!;
  const slice = atom.text.trim().slice(0, Math.min(12, atom.text.trim().length));
  return { atom_id: atom.atom_id, text: slice || atom.text.slice(0, Math.min(8, atom.text.length)) };
}

function isSubdivision(node: SpecTreeNode): boolean {
  return node.node_type === "子分部" || node.type_name === "子分部";
}

function isDivision(node: SpecTreeNode): boolean {
  return node.node_type === "分项" || node.type_name === "分项";
}

export function flattenSpecSubdivisions(tree: SpecTreeNode[]): Array<{ name: string; items: string[] }> {
  const result: Array<{ name: string; items: string[] }> = [];
  const walk = (nodes: SpecTreeNode[]): void => {
    for (const node of nodes) {
      if (isSubdivision(node) && node.name) {
        result.push({
          name: node.name,
          items: (node.children ?? []).filter(isDivision).map((child) => child.name!).filter(Boolean),
        });
      }
      if (node.children?.length) walk(node.children);
    }
  };
  walk(tree);
  return result;
}

export function matchSubdivision(
  divisionName: string,
  subdivisions: Array<{ name: string; items: string[] }>,
  keepNames: string[] = [],
): string | undefined {
  const keep = new Set(keepNames.map(normalizeName));
  const wanted = normalizeName(divisionName);
  const itemHits = subdivisions.filter((entry) =>
    entry.items.some((item) => {
      const normalized = normalizeName(item);
      return normalized === wanted || normalized.includes(wanted) || wanted.includes(normalized);
    })
  );
  const uniqueItems = itemHits.filter((entry) =>
    entry.items.filter((item) => {
      const normalized = normalizeName(item);
      return normalized === wanted || (wanted.length >= 2 && (normalized.includes(wanted) || wanted.includes(normalized)));
    }).length === 1
  );
  const preferred = uniqueItems.filter((entry) => keep.size === 0 || keep.has(normalizeName(entry.name)));
  const pool = preferred.length === 1 ? preferred : uniqueItems.length === 1 ? uniqueItems : [];
  if (pool.length === 1) return pool[0]!.name;
  const nameHits = subdivisions.filter((entry) => titlesRelated(entry.name, divisionName));
  if (nameHits.length === 1) return nameHits[0]!.name;
  return undefined;
}

function divisionNamesFromLedger(ledger: DocumentLedger, lots: EditorHierarchyLot[]): string[] {
  const fromTables = ledger.record_tables.map((table) => {
    const stripped = table.title.replace(/表\s*[A-Za-z0-9.]+/g, "").trim();
    return stripped || table.nearby_text.slice(0, 40) || table.table_no;
  }).filter((name) => name.length >= 2);
  if (fromTables.length) return [...new Set(fromTables)];
  return [...new Set(lots.map((lot) => lot.target_name.trim()).filter(Boolean))];
}

export function assembleEditorHierarchyFromLedger(input: {
  evidence: EditorHierarchyEvidence;
  ledger: DocumentLedger;
  specTree?: SpecTreeNode[];
  keepNames?: string[];
}): HierarchyAssemblyResult {
  const { evidence, ledger } = input;
  const subdivisions = flattenSpecSubdivisions(input.specTree ?? []);
  const divisionNames = divisionNamesFromLedger(ledger, evidence.lots);
  const names = divisionNames.length ? divisionNames : [...new Set(evidence.lots.map((lot) => lot.target_name || lot.lot_name).filter(Boolean))];
  const fallbackNames = names.length ? names : ["未映射分项"];
  const unmapped = "未映射";
  const groups = new Map<string, string[]>();
  const unmapped_division_names: string[] = [];
  for (const name of fallbackNames) {
    const matched = matchSubdivision(name, subdivisions, input.keepNames);
    const groupName = matched ?? unmapped;
    if (!matched) unmapped_division_names.push(name);
    const list = groups.get(groupName) ?? [];
    if (!list.includes(name)) list.push(name);
    groups.set(groupName, list);
  }

  const authorityText = ledger.record_tables[0]?.nearby_text
    || ledger.windows.find((window) => !window.ignored)?.heading_text
    || evidence.document.atoms[0]?.text.slice(0, 24)
    || "层级";
  const fragment = [fragmentFor(authorityText, evidence)];
  const nodes: EditorHierarchyPlan["nodes"] = [];
  const constraints: EditorHierarchyPlan["semantic_constraints"] = [];
  const groupIds: string[] = [];
  for (const [groupName, divisions] of groups) {
    const groupId = `group:${sha256Text(groupName).slice(0, 12)}`;
    groupIds.push(groupId);
    const groupConstraint = `constraint:${groupId}`;
    const matchingSubdivisionAtom = evidence.document.atoms.find((atom) => atom.text.includes(groupName));
    const groupFragment = matchingSubdivisionAtom
      ? [{ atom_id: matchingSubdivisionAtom.atom_id, text: groupName }]
      : fragment;
    constraints.push({
      constraint_id: groupConstraint,
      kind: "scope_assignment",
      parent_node_id: "root",
      node_type: "子分部",
      node_ids: [groupId],
      expected_count: null,
      exhaustive: false,
      evidence_fragments: groupFragment,
      interpretation: groupName === unmapped
        ? "未能唯一挂到 50300 子分部的分项暂挂未映射"
        : `分项名称归一后挂到 50300 子分部「${groupName}」`,
    });
    nodes.push({
      node_id: groupId,
      parent_node_id: "root",
      node_type: "子分部",
      name: groupName,
      constraint_ids: [groupConstraint],
      evidence_fragments: groupFragment,
      reason: groupName === unmapped ? "附录记录表或抽取窗口未唯一命中 50300 子分部" : "按 50300 名称归一挂载",
    });
    const divisionIds: string[] = [];
    for (const divisionName of divisions) {
      const divisionId = `division:${sha256Text(`${groupId}|${divisionName}`).slice(0, 12)}`;
      divisionIds.push(divisionId);
      const matchingTable = ledger.record_tables.find((t) => t.title.includes(divisionName) || divisionName.includes(t.title));
      const matchingWindow = ledger.windows.find((w) => w.title === divisionName || w.heading_text.includes(divisionName) || titlesRelated(w.title, divisionName));
      const divisionAuthorityText = matchingTable?.nearby_text
        || matchingWindow?.heading_text
        || divisionName;
      const divisionFragment = [fragmentFor(divisionAuthorityText, evidence)];
      nodes.push({
        node_id: divisionId,
        parent_node_id: groupId,
        node_type: "分项",
        name: divisionName,
        constraint_ids: [],
        evidence_fragments: divisionFragment,
        reason: ledger.record_tables.length
          ? "由附录检验批质量验收记录表题生成"
          : "无附录记录表时退化为 discovery 窗口名",
      });
    }
    const divisionConstraint = `constraint:${groupId}:divisions`;
    constraints.push({
      constraint_id: divisionConstraint,
      kind: "child_enumeration",
      parent_node_id: groupId,
      node_type: "分项",
      node_ids: divisionIds,
      expected_count: divisionIds.length,
      exhaustive: true,
      evidence_fragments: groupFragment,
      interpretation: `该子分部下列出 ${divisionIds.length} 个分项`,
    });
    for (const node of nodes) {
      if (divisionIds.includes(node.node_id)) node.constraint_ids = [divisionConstraint];
    }
  }

  const rootConstraint = "constraint:root-subdivisions";
  constraints.unshift({
    constraint_id: rootConstraint,
    kind: "child_enumeration",
    parent_node_id: "root",
    node_type: "子分部",
    node_ids: groupIds,
    expected_count: groupIds.length,
    exhaustive: true,
    evidence_fragments: fragment,
    interpretation: "编辑器根下的子分部集合",
  });
  for (const node of nodes) {
    if (groupIds.includes(node.node_id) && !node.constraint_ids.includes(rootConstraint)) {
      node.constraint_ids = [rootConstraint, ...node.constraint_ids];
    }
  }

  const divisionNodes = nodes.filter((node) => node.node_type === "分项");
  const lot_bindings: EditorHierarchyPlan["lot_bindings"] = [];
  const uncertain_lot_keys: string[] = [];
  for (const lot of evidence.lots) {
    const tokens = clauseTokens([lot.lot_name, lot.target_name, ...lot.item_names]);
    const exact = divisionNodes.filter((node) => {
      const name = normalizeName(node.name);
      return name === normalizeName(lot.target_name) || name === normalizeName(lot.lot_name);
    });
    const related = divisionNodes.filter((node) => titlesRelated(node.name, lot.target_name) || titlesRelated(node.name, lot.lot_name));
    const clauseRelated = divisionNodes.filter((node) => {
      const window = ledger.windows.find((entry) =>
        entry.title === node.name
        || entry.heading_text.includes(node.name)
        || titlesRelated(entry.title, node.name)
      );
      if (!window) return false;
      return tokens.some((token) =>
        token === window.number
        || token.startsWith(`${window.number}.`)
        || window.extractable_clause_ids.includes(token)
      );
    });
    // 唯一命中才算确定；多候选时暂挂第一个并标 uncertain，留给最多一次确认。
    let chosen = exact[0] ?? (related.length === 1 ? related[0] : undefined) ?? (clauseRelated.length === 1 ? clauseRelated[0] : undefined);
    let unique = Boolean(chosen);
    if (!chosen) {
      chosen = related[0] ?? clauseRelated[0] ?? divisionNodes.find((node) => node.name === lot.target_name) ?? divisionNodes[0];
      unique = false;
    }
    if (!unique) uncertain_lot_keys.push(lot.lot_key);
    if (!chosen) continue;
    const parentConstraint = chosen.constraint_ids[0]!;
    const lotEvidence = (lot.target_evidence_fragments && lot.target_evidence_fragments.length > 0)
      ? [lot.target_evidence_fragments[0]!]
      : [fragmentFor(lot.lot_name || lot.target_name, evidence)];
    lot_bindings.push({
      lot_key: lot.lot_key,
      parent_node_id: chosen.node_id,
      // 仅预填封存批名；层级 Agent 核对适用原名并保留精确标题来源，
      // 不因父级重复而缩写，也不能由程序按字符串前缀机械截断。
      display_name: lot.lot_name,
      constraint_ids: [parentConstraint],
      evidence_fragments: lotEvidence,
      reason: unique
        ? "按目标窗口名称或条文号前缀唯一绑定到分项"
        : "未唯一命中分项，暂挂到可用分项待确认",
    });
  }

  const authorityAtomIds = new Set<string>();
  for (const node of nodes) {
    for (const frag of node.evidence_fragments) authorityAtomIds.add(frag.atom_id);
  }
  for (const binding of lot_bindings) {
    for (const frag of binding.evidence_fragments) authorityAtomIds.add(frag.atom_id);
  }
  for (const constraint of constraints) {
    for (const frag of constraint.evidence_fragments) authorityAtomIds.add(frag.atom_id);
  }
  const atom_dispositions = evidence.document.atoms.map((atom) => ({
    atom_id: atom.atom_id,
    disposition: authorityAtomIds.has(atom.atom_id) ? "hierarchy_authority" as const : "no_hierarchy_effect" as const,
    constraint_ids: authorityAtomIds.has(atom.atom_id) ? constraints.map((constraint) => constraint.constraint_id) : [],
    reason: authorityAtomIds.has(atom.atom_id) ? "承载附录记录表或章节窗口标题，约束层级装配" : "不参与本次确定性层级装配",
  }));

  return {
    plan: {
      schema_version: EDITOR_HIERARCHY_PLAN_SCHEMA_VERSION,
      job_id: evidence.job_id,
      evidence_fingerprint: evidence.evidence_fingerprint,
      business_result_sha256: evidence.business_result_sha256,
      semantic_constraints: constraints,
      atom_dispositions,
      nodes,
      lot_bindings,
      // Deliberately unconfirmed: the model must choose business units, not inherit target count.
      inspection_units: [],
    },
    uncertain_lot_keys,
    unmapped_division_names,
  };
}

export async function loadStandaloneSpecTree(): Promise<SpecTreeNode[]> {
  const envRoot = process.env.PDF_EX_CODEX_ROOT?.trim();
  const here = fileURLToPath(new URL(".", import.meta.url));
  const candidates = [
    envRoot ? join(envRoot, "data", "standalone", "50300.json") : "",
    join(process.cwd(), "data", "standalone", "50300.json"),
    join(here, "..", "..", "..", "data", "standalone", "50300.json"),
  ].filter(Boolean);
  for (const path of candidates) {
    try {
      const raw = JSON.parse(await readFile(path, "utf8")) as unknown;
      if (Array.isArray(raw)) return raw as SpecTreeNode[];
      if (raw && typeof raw === "object" && Array.isArray((raw as { tree?: unknown }).tree)) {
        return (raw as { tree: SpecTreeNode[] }).tree;
      }
    } catch {
      continue;
    }
  }
  return [];
}

export function standardHintFromFilename(fileName: string): string {
  const match = fileName.match(/GB[_/]?T?[_-]?\d{5}/i);
  return match?.[0]?.replace(/[/]/g, "_") ?? "";
}

export function hierarchyConfirmContextFromLedger(
  ledger: DocumentLedger,
  assembled: HierarchyAssemblyResult,
): HierarchyConfirmContext {
  return {
    uncertain_lot_keys: assembled.uncertain_lot_keys,
    unmapped_division_names: assembled.unmapped_division_names,
    ledger_summary: {
      record_tables: ledger.record_tables.map((table) => ({
        table_no: table.table_no,
        title: table.title,
        nearby_text: table.nearby_text,
      })),
      // 分项在 GB 验收规范里基本等于「章」，而 windows 是节级（总拼和安装、支承面…），
      // 只给节名会让确认阶段拼不出「铝合金焊接工程」这种分项名。章标题单独给。
      chapters: ledger.headings
        .filter((heading) => heading.role !== "ignored" && /^\d+$/.test(heading.number) && heading.title)
        .map((heading) => ({ number: heading.number, title: heading.title })),
      windows: ledger.windows.map((window) => ({
        number: window.number,
        title: window.title,
        ignored: window.ignored,
      })),
      anomalies: ledger.anomalies.map((anomaly) => ({
        reason: anomaly.reason,
        text: anomaly.text,
        line: anomaly.line,
      })),
    },
  };
}

export async function loadAutoSpecKeep(standardHint = ""): Promise<string[]> {
  if (!standardHint.trim()) return [];
  const envRoot = process.env.PDF_EX_CODEX_ROOT?.trim();
  const here = fileURLToPath(new URL(".", import.meta.url));
  const candidates = [
    envRoot ? join(envRoot, "data", "standalone", "auto_specs.json") : "",
    join(process.cwd(), "data", "standalone", "auto_specs.json"),
    join(here, "..", "..", "..", "data", "standalone", "auto_specs.json"),
  ].filter(Boolean);
  const needle = standardHint.replace(/[_/\s-]/g, "").toLowerCase();
  for (const path of candidates) {
    try {
      const raw = JSON.parse(await readFile(path, "utf8")) as Record<string, { source?: { keep?: unknown } }>;
      const keep = new Set<string>();
      for (const [key, value] of Object.entries(raw)) {
        const compact = key.replace(/[_/\s-]/g, "").toLowerCase();
        if (!compact.includes(needle) && !needle.includes(compact)) continue;
        const names = value?.source?.keep;
        if (Array.isArray(names)) names.filter((name): name is string => typeof name === "string").forEach((name) => keep.add(name));
      }
      return [...keep];
    } catch {
      continue;
    }
  }
  return [];
}
