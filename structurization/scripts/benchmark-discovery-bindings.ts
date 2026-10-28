import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { buildDocumentEvidence } from "../src/document-discovery.js";
import { bindDiscoverySources } from "../src/discovery-source-bindings.js";
import { scanDocumentLedger } from "../src/document-ledger.js";
import { registryWithFullSourceSpans } from "../src/source-span-registry.js";

// Offline coordinate benchmark only; source arguments are never modified and no model sees a gold plan.
// Usage: npx tsx scripts/benchmark-discovery-bindings.ts <markdown> [...markdown]
if (!process.argv[2]) throw new Error("Provide one or more Markdown files (read-only).");
const results = [];
for (const path of process.argv.slice(2)) {
  const source = await readFile(resolve(path), "utf8");
  const evidence = buildDocumentEvidence(source, basename(path));
  const ledger = scanDocumentLedger(source, basename(path));
  // Evenly spaced physical clauses across each complete document; no named targets or answer inventory.
  const clauses = ledger.clauses.filter(clause => clause.end_exclusive_line > clause.line);
  const selected = [...new Set(Array.from({ length: Math.min(40, clauses.length) }, (_, index) =>
    Math.floor(index * clauses.length / Math.min(40, clauses.length))))].map(index => clauses[index]!);
  const bindings = selected.map((clause, index) => ({ key: `source${index}`, start_line: clause.line, extent: "clause" as const }));
  const registry = registryWithFullSourceSpans(evidence.evidence_fingerprint, evidence.atoms.map(atom => ({ source_id: atom.atom_id, atom_id: atom.atom_id, evidence_id: atom.atom_id, text: atom.text })));
  const start = performance.now();
  const bound = bindDiscoverySources(bindings, evidence, ledger, new Set(evidence.atoms.map(atom => atom.atom_id)), registry);
  const elapsed = performance.now() - start;
  const sourceLines = source.split("\n");
  const quotes = selected.map((clause, index) => {
    const expected = sourceLines.slice(clause.line - 1, clause.end_exclusive_line - 1).join("\n")
      + (clause.end_exclusive_line <= sourceLines.length ? "\n" : "");
    const actual = bound.aliases.get(`source${index}`)!.span_ids.map(id => {
      const span = bound.registry.spans.find(entry => entry.span_id === id)!;
      return evidence.atoms.find(atom => atom.atom_id === span.atom_id)!.text.slice(span.start, span.end);
    }).join("");
    if (actual !== expected) throw new Error(`Physical range mismatch in ${basename(path)} at line ${clause.line}`);
    return { quote: expected };
  });
  const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
  results.push({ document: basename(path), source_sha256: evidence.source.sha256, sampled_clauses: selected.length,
    identical_complete_ranges: quotes.length, cross_atom_ranges: [...bound.aliases.values()].filter(alias => alias.span_ids.length > 1).length,
    quote_argument_bytes: bytes(quotes), coordinate_argument_bytes: bytes(bindings),
    coordinate_byte_reduction: 1 - bytes(bindings) / bytes(quotes), registration_ms: elapsed });
}
console.log(JSON.stringify({ schema_version: "discovery-binding-benchmark/v1", results,
  limits: "Mechanical input-size and exact-range comparison only. Does not measure live provider request count, semantic quality, or end-to-end latency." }, null, 2));
