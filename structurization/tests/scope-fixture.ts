import type { DocumentEvidence } from '../src/document-discovery.js';
import type { DocumentSelectorPlan } from '../src/document-selector-compiler.js';
import type { SourceSpanRegistry } from '../src/source-span-registry.js';

/** 固定范围的非 discovery 回归夹具。仅为测试声明处置，生产 prefill 必须保持待确认。 */
export function approveScopeFixture(selectors: DocumentSelectorPlan, registry: SourceSpanRegistry, evidence: DocumentEvidence): DocumentSelectorPlan {
  return { ...selectors, dispositions: evidence.atoms.map(atom => {
    const keys = selectors.targets.filter(t => t.scope_span_ids.some(id =>
      registry.spans.some(s => s.span_id === id && s.atom_id === atom.atom_id))).map(t => t.key);
    const full = registry.spans.find(s => s.atom_id === atom.atom_id && s.start === 0 && s.end === atom.text.length)!;
    return { atom_span_id: full.span_id, disposition: keys.length ? 'target' as const : 'context' as const,
      target_keys: keys, reason: '范围测试固定候选，不代表生产语义批准' };
  }) };
}
