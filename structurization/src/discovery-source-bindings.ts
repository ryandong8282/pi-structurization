import { Type } from "typebox";
import type { DocumentEvidence } from "./document-discovery.js";
import type { DocumentLedger } from "./document-ledger.js";
import type { DocumentSelectorPlan } from "./document-selector-compiler.js";
import { registerSourceSpan, SourceSpanRegistryError, type SourceSpanRegistry } from "./source-span-registry.js";

export const DiscoverySourceBindingSchema = Type.Object({
  key: Type.String({ minLength: 1, pattern: "^[A-Za-z][A-Za-z0-9_-]*$" }),
  start_line: Type.Integer({ minimum: 1 }),
  end_exclusive_line: Type.Optional(Type.Integer({ minimum: 2,
    description: "extent=lines 或省略 extent 时必须提供，与 start_line 组成非空范围；extent=clause 时可省略，由程序绑定完整物理条文。",
  })),
  extent: Type.Optional(Type.Union([Type.Literal("lines"), Type.Literal("clause")], {
    description: "lines 选择明确的物理行范围；clause 选择从 start_line 开始的完整底账条款。两者都只绑定来源坐标，不分配业务角色。",
  })),
}, { additionalProperties: false });

export interface DiscoverySourceBinding {
  key: string;
  start_line: number;
  end_exclusive_line?: number;
  extent?: "lines" | "clause";
}

export interface DiscoverySourceAlias {
  span_ids: string[];
  anchor_span_id: string;
}

function reject(code: string, actual: unknown, instruction: string, repair: Record<string, unknown> = {}): never {
  throw new SourceSpanRegistryError([{
    code, path: "/source_bindings", message: instruction,
    details: { actual, writable_collection: "source_bindings", next_tools: ["open_document_atom", "edit_document_selectors"], required_action: instruction, ...repair },
  }]);
}

/** Register only model-selected coordinates, in memory, after this phase read all intersecting atoms. */
export function bindDiscoverySources(
  bindings: readonly DiscoverySourceBinding[],
  evidence: DocumentEvidence,
  ledger: DocumentLedger,
  opened: ReadonlySet<string>,
  registry: SourceSpanRegistry,
): { registry: SourceSpanRegistry; aliases: Map<string, DiscoverySourceAlias> } {
  const source = evidence.atoms.map(atom => atom.text).join("");
  const offsets = [0];
  for (const match of source.matchAll(/\n/g)) offsets.push(match.index! + 1);
  // The final exclusive line is allowed even without a trailing newline.
  offsets.push(source.length);
  const aliases = new Map<string, DiscoverySourceAlias>();
  let current = registry;
  if (!Array.isArray(bindings) || bindings.length > 100) reject("discovery_binding_limit", bindings, "Provide at most 100 explicitly selected line bindings in one edit_document_selectors call.");
  for (const [bindingIndex, binding] of bindings.entries()) {
    if (!binding || !/^[A-Za-z][A-Za-z0-9_-]*$/.test(binding.key) || aliases.has(binding.key)) {
      reject("discovery_binding_key_invalid", binding, "Use unique local binding keys (letters, digits, underscore or hyphen, starting with a letter); reference them as $key only in span fields.");
    }
    let endLine = binding.end_exclusive_line;
    if (binding.extent === "clause") {
      const clauses = ledger.clauses.filter(clause => clause.line === binding.start_line);
      const expectedEnd = clauses.length === 1 ? clauses[0]!.end_exclusive_line : undefined;
      // A final empty line and EOF can have distinct line addresses but the
      // identical character offset. Accept that exact equivalence, never truncate.
      const samePhysicalEnd = endLine === undefined || (Number.isInteger(endLine)
        && offsets[endLine - 1] !== undefined && offsets[endLine - 1] === offsets[(expectedEnd ?? 0) - 1]);
      if (clauses.length !== 1 || !samePhysicalEnd) reject("discovery_clause_address_invalid",
        { ...binding, expected_end_exclusive_line: clauses.length === 1 ? clauses[0]!.end_exclusive_line : null },
        "For extent=clause, use the exact starting line of one physical ledger clause. Omit end_exclusive_line or match expected_end_exclusive_line exactly; a shortened clause is rejected. For unindexed or ambiguous text, explicitly select extent=lines with both boundaries after reading the source.");
      endLine = clauses[0]!.end_exclusive_line;
    } else if (binding.extent !== undefined && binding.extent !== "lines") {
      reject("discovery_binding_extent_invalid", binding, "Use extent=lines or clause. These select physical source coordinates, not business scope.");
    }
    if (endLine === undefined) {
      const start = offsets[binding.start_line - 1];
      const atom = start === undefined ? undefined : evidence.atoms.find(entry => entry.start_offset <= start && entry.end_offset > start);
      reject("discovery_binding_end_line_required", { ...binding, end_exclusive_line: null, source_line_count: offsets.length - 1 },
        "This lines binding has no end_exclusive_line. Read the intended source range, then provide an explicit exclusive end greater than start_line and at most source_line_count + 1; do not guess a one-line end or silently change to clause extent. No bindings or edits were saved; retry the complete transaction.", {
          writable_path: `/source_bindings/${bindingIndex}/end_exclusive_line`,
          expected: { end_exclusive_line: "integer", greater_than: binding.start_line, maximum: offsets.length },
          ...(atom ? { next_tool: "open_document_atom", next_tool_arguments: { atom_id: atom.atom_id } } : { next_tool: "list_document_atoms", next_tool_arguments: {} }),
          save_tool: "edit_document_selectors",
        });
    }
    if (!Number.isInteger(binding.start_line) || !Number.isInteger(endLine)
      || binding.start_line < 1 || endLine! <= binding.start_line || endLine! > offsets.length) {
      reject("discovery_binding_range_invalid", { ...binding, source_line_count: offsets.length - 1 },
        "Select a non-empty physical range with 1 <= start_line < end_exclusive_line <= source_line_count + 1. Copy line numbers from the opened source; do not count characters or edit immutable text.");
    }
    const start = offsets[binding.start_line - 1]!;
    const end = offsets[endLine! - 1]!;
    if (!source.slice(start, end).trim()) reject("discovery_binding_empty", binding, "Select a non-empty source line or clause; blank lines alone cannot bind evidence.");
    const atoms = evidence.atoms.filter(atom => atom.start_offset < end && atom.end_offset > start);
    const unread = atoms.filter(atom => !opened.has(atom.atom_id));
    if (unread.length) reject("discovery_binding_source_unread", { binding, unopened_atom_ids: unread.map(atom => atom.atom_id) },
      "Open every listed atom in this session phase before binding the range. A candidate's reads never count as independent reviewer reads.");
    const spans: string[] = [];
    for (const atom of atoms) {
      const result = registerSourceSpan(current, { source_id: atom.atom_id, atom_id: atom.atom_id, evidence_id: atom.atom_id, text: atom.text },
        Math.max(0, start - atom.start_offset), Math.min(atom.text.length, end - atom.start_offset));
      current = result.registry;
      spans.push(result.span.span_id);
    }
    const firstAnchor = atoms.flatMap((atom) => {
      const localStart = Math.max(0, start - atom.start_offset);
      const localEnd = Math.min(atom.text.length, end - atom.start_offset);
      const selected = atom.text.slice(localStart, localEnd);
      let lineStart = 0;
      while (lineStart < selected.length) {
        const newline = selected.indexOf("\n", lineStart);
        const lineEnd = newline < 0 ? selected.length : newline;
        let contentStart = lineStart;
        while (contentStart < lineEnd && /\s/u.test(selected[contentStart]!)) contentStart += 1;
        let contentEnd = lineEnd;
        if (contentEnd > contentStart && selected[contentEnd - 1] === "\r") contentEnd -= 1;
        while (contentEnd > contentStart && /\s/u.test(selected[contentEnd - 1]!)) contentEnd -= 1;
        if (contentEnd > contentStart) return [{
          atom,
          anchorStart: localStart + contentStart,
          anchorEnd: localStart + contentEnd,
        }];
        if (newline < 0) break;
        lineStart = newline + 1;
      }
      return [];
    })[0];
    if (!firstAnchor) reject("discovery_binding_anchor_empty", binding,
      "The selected source has no non-empty physical line for a structural anchor. Select a non-empty clause or line range after reading the source.");
    const anchor = registerSourceSpan(current, {
      source_id: firstAnchor.atom.atom_id,
      atom_id: firstAnchor.atom.atom_id,
      evidence_id: firstAnchor.atom.atom_id,
      text: firstAnchor.atom.text,
    }, firstAnchor.anchorStart, firstAnchor.anchorEnd);
    current = anchor.registry;
    aliases.set(binding.key, { span_ids: spans, anchor_span_id: anchor.span.span_id });
  }
  return { registry: current, aliases };
}

/** Diagnose all missing call-local aliases before applying any edits, without resolving or guessing bindings. */
export function assertDiscoveryAliasReferences(
  value: unknown,
  aliases: ReadonlyMap<string, DiscoverySourceAlias>,
  prefix = "/edits",
): void {
  const missing: Array<{ alias: string; path: string }> = [];
  const missingKeys = new Set<string>();
  let count = 0;
  const check = (entry: string, path: string) => {
    if (!entry.startsWith("$") || aliases.has(entry.slice(1))) return;
    count += 1;
    missingKeys.add(entry.slice(1));
    if (missing.length < 40) missing.push({ alias: entry, path });
  };
  const visit = (entry: unknown, path: string, field = "") => {
    if (Array.isArray(entry)) {
      entry.forEach((child, index) => {
        const childPath = `${path}/${index}`;
        if (field.endsWith("span_ids") && typeof child === "string") check(child, childPath);
        else visit(child, childPath);
      });
    } else if (typeof entry === "string" && field.endsWith("span_id")) {
      check(entry, path);
    } else if (entry && typeof entry === "object") {
      for (const [key, child] of Object.entries(entry)) {
        visit(child, `${path}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`, key);
      }
    }
  };
  visit(value, prefix);
  if (!count) return;
  const instruction = "Declare each missing key in source_bindings in this same edit_document_selectors call, or call read_document_selectors with the current draft_id and use its returned canonical span IDs or pending handles. Aliases from earlier calls are not retained. Do not guess bindings or edit immutable source/compiled data.";
  throw new SourceSpanRegistryError(missing.map(({ alias, path }, index) => ({
    code: "discovery_binding_alias_unknown",
    path,
    message: `Unknown call-local source alias ${alias}.` + (index === 0 ? ` ${instruction}` : ""),
    details: {
      actual: alias,
      writable_path: path,
      binding_key: alias.slice(1),
      ...(index === 0 ? {
        unknown_reference_count: count,
        unknown_alias_count: missingKeys.size,
        missing_alias_keys: [...missingKeys].slice(0, 40),
        omitted_alias_count: Math.max(0, missingKeys.size - 40),
        reported_reference_count: missing.length,
        omitted_reference_count: count - missing.length,
        defined_keys: [...aliases.keys()].slice(0, 100),
        omitted_defined_key_count: Math.max(0, aliases.size - 100),
        writable_collection: "source_bindings",
        next_tools: ["read_document_selectors", "edit_document_selectors"],
        required_action: instruction,
      } : {}),
    },
  })));
}

/** Expand arrays across physical atom boundaries; scalar anchors use the first non-empty source line. */
export function resolveDiscoveryAliases(value: unknown, aliases: ReadonlyMap<string, DiscoverySourceAlias>, field = ""): unknown {
  const resolve = (entry: string): DiscoverySourceAlias => {
    const alias = aliases.get(entry.slice(1));
    if (!alias) reject("discovery_binding_alias_unknown", entry, "Define this $key in source_bindings in the same transaction, or use a registered span ID from read_document_selectors. No edits were saved.");
    return alias;
  };
  if (Array.isArray(value)) return value.flatMap(entry =>
    field.endsWith("span_ids") && typeof entry === "string" && entry.startsWith("$")
      ? resolve(entry).span_ids : [resolveDiscoveryAliases(entry, aliases)]);
  if (typeof value === "string" && value.startsWith("$") && field.endsWith("span_id")) {
    const alias = resolve(value);
    const ids = alias.span_ids;
    if (field === "end_span_id") return ids.at(-1)!;
    if (field === "anchor_span_id") return alias.anchor_span_id;
    if (field === "start_span_id" || field === "end_before_span_id") return ids[0]!;
    if (ids.length !== 1) reject("discovery_binding_scalar_ambiguous", { field, alias: value, span_count: ids.length },
      "Use a narrower single-atom line binding for this scalar anchor. Span arrays and source-block start/end fields can use cross-atom bindings.");
    return ids[0]!;
  }
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, resolveDiscoveryAliases(child, aliases, key)]));
  return value;
}

/** Include an explicitly selected adjacent anchor in the primary block start. */
export function reconcileAdjacentSourceBlockAnchors(
  selectors: DocumentSelectorPlan,
  evidence: DocumentEvidence,
  registry: SourceSpanRegistry,
): { selectors: DocumentSelectorPlan; changed_target_keys: string[] } {
  const reconciled = structuredClone(selectors);
  const atomById = new Map(evidence.atoms.map((atom) => [atom.atom_id, atom]));
  const spanById = new Map(registry.spans.map((span) => [span.span_id, span]));
  const source = evidence.atoms.map((atom) => atom.text).join("");
  const changed = new Set<string>();
  for (const target of reconciled.targets) {
    for (const block of target.source_blocks) {
      const anchor = spanById.get(block.anchor_span_id);
      const start = spanById.get(block.start_span_id);
      const anchorAtom = anchor ? atomById.get(anchor.atom_id) : undefined;
      const startAtom = start ? atomById.get(start.atom_id) : undefined;
      if (!anchor || !start || !anchorAtom || !startAtom) continue;
      const anchorStart = anchorAtom.start_offset + anchor.start;
      const anchorEnd = anchorAtom.start_offset + anchor.end;
      const startOffset = startAtom.start_offset + start.start;
      if (anchorStart >= startOffset || anchorEnd > startOffset || !/^\s*$/u.test(source.slice(anchorEnd, startOffset))) continue;
      block.start_span_id = block.anchor_span_id;
      changed.add(target.key);
    }
  }
  return { selectors: reconciled, changed_target_keys: [...changed] };
}

/** The model receives exact text once, with physical line addresses alongside it. */
export function discoveryAtomWithLines(atom: DocumentEvidence["atoms"][number]) {
  const { text, ...metadata } = atom;
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const addressed = { ...metadata, source_lines: lines.map((text, index) => ({ line: atom.start_line + index, text: text.replace(/\r$/, "") })) };
  return Buffer.byteLength(JSON.stringify(addressed), "utf8") <= 96 * 1024 ? addressed : atom;
}
