import type { EvidenceRecord } from './contracts.js';
import type { SourceSpanRegistry } from './source-span-registry.js';
import type { TargetSelectorPlan } from './target-selector-compiler.js';
import { safeJoinDisplayFragments } from './semantic-decision-compiler.js';
import { sourceBoundaryNeighbors } from './source-boundary-review.js';

/** Show authored field values beside their source; never infer or repair semantics. */
export function selectorDeliveryPreview(selectors: TargetSelectorPlan, registry: SourceSpanRegistry,
  evidence: readonly EvidenceRecord[], itemKeys: ReadonlySet<string>, openedIds: ReadonlySet<string>,
  samplingRuleKeys: ReadonlySet<string> = new Set()) {
  const spans = new Map(registry.spans.map(span => [span.span_id, span]));
  const records = new Map(evidence.map(record => [record.evidence_id, record]));
  const previews = selectors.items.filter(item => itemKeys.has(item.key) && !item.table).map(item => ({
    item_key: item.key,
    fields: Object.fromEntries(Object.entries(item.fields).map(([field, binding]) => {
      const fragments = binding.span_ids.flatMap(id => {
        const span = spans.get(id), record = span && records.get(span.evidence_id);
        return span && record && openedIds.has(span.evidence_id) ? [{ text: record.text.slice(span.start, span.end) }] : [];
      });
      const seen = new Set<string>();
      const display = fragments.filter(fragment => {
        const key = fragment.text.trim().replace(/\s+/gu, ' ');
        if (!key || seen.has(key)) return false;
        seen.add(key); return true;
      });
      const value = field === 'name' && binding.composition === 'semantic_summary'
        ? item.name_path?.join('\\') ?? item.name : safeJoinDisplayFragments(display, binding.separator);
      return [field, {
        composition: binding.composition,
        actual_value: excerpt(value, 1000), actual_value_complete: Buffer.byteLength(value, 'utf8') <= 1000,
        actual_value_char_count: value.length,
        actual_value_available: binding.span_ids.every(id => { const span = spans.get(id); return span && records.has(span.evidence_id) && openedIds.has(span.evidence_id); }),
        author_reason: excerpt(binding.reason, 300),
        selected_spans: binding.span_ids.slice(0, 6).flatMap(id => spans.get(id) ?? []),
        remaining_span_ids: binding.span_ids.slice(6, 18), remaining_span_count: Math.max(0, binding.span_ids.length - 6),
        writable_path: `/items/${selectors.items.indexOf(item)}/fields/${field}`,
      }];
    })),
    source_context: [...new Set(Object.values(item.fields).flatMap(binding => binding.span_ids)
      .flatMap(id => spans.get(id)?.evidence_id ?? []))].slice(0, 4).map(id => {
      const record = records.get(id);
      // A preview must not bypass the source-reading receipt or isolated reference access.
      const readable = openedIds.has(id) && record;
      return { evidence_id: id, locator: record?.locator,
        ...(readable ? { text: excerpt(record.text, 800), text_complete: Buffer.byteLength(record.text, 'utf8') <= 800 } : { text_complete: false }),
        boundary_neighbors: sourceBoundaryNeighbors(evidence, id) };
    }),
  }));
  const samplingPreviews = (selectors.sampling_rules ?? []).flatMap((rule, ruleIndex) => {
    if (!samplingRuleKeys.has(rule.key)) return [];
    const componentPreview = (component: typeof rule.components[number], writablePath: string) => {
      const fragments = component.span_ids.flatMap(id => {
        const span = spans.get(id), record = span && records.get(span.evidence_id);
        return span && record && openedIds.has(span.evidence_id) ? [{ text: record.text.slice(span.start, span.end) }] : [];
      });
      const value = safeJoinDisplayFragments(fragments, '');
      return { key: component.key, role: component.role, disposition: component.disposition,
        actual_value: excerpt(value, 1000), actual_value_complete: Buffer.byteLength(value, 'utf8') <= 1000,
        actual_value_char_count: value.length,
        actual_value_available: component.span_ids.every(id => {
          const span = spans.get(id); return span && records.has(span.evidence_id) && openedIds.has(span.evidence_id);
        }),
        author_reason: excerpt(component.reason, 300),
        selected_spans: component.span_ids.slice(0, 6).flatMap(id => spans.get(id) ?? []),
        remaining_span_ids: component.span_ids.slice(6, 18), remaining_span_count: Math.max(0, component.span_ids.length - 6),
        source_context: [...new Set(component.span_ids.flatMap(id => spans.get(id)?.evidence_id ?? []))].slice(0, 4).map(id => {
          const record = records.get(id), readable = openedIds.has(id) && record;
          return { evidence_id: id, locator: record?.locator,
            ...(readable ? { text: excerpt(record.text, 800), text_complete: Buffer.byteLength(record.text, 'utf8') <= 800 }
              : { text_complete: false }) };
        }),
        writable_path: writablePath };
    };
    return [{ rule_key: rule.key,
      components: rule.components.map((component, index) => componentPreview(component, `/sampling_rules/${ruleIndex}/components/${index}`)),
      branches: rule.branches.map((branch, index) => ({ branch_key: branch.key,
        components: branch.components.map((component, componentIndex) =>
          componentPreview(component, `/sampling_rules/${ruleIndex}/branches/${index}/components/${componentIndex}`)) })),
    }];
  });
  const shown: typeof previews = [], shownSampling: typeof samplingPreviews = [];
  const result = () => {
    const response = { advisory_only: true, items: shown, sampling_rules: shownSampling,
    remaining_item_keys: previews.slice(shown.length, shown.length + 32).map(item => item.item_key),
    remaining_item_count: previews.length - shown.length, remaining_item_keys_complete: true,
    remaining_sampling_rule_keys: samplingPreviews.slice(shownSampling.length, shownSampling.length + 32).map(rule => rule.rule_key),
    remaining_sampling_rule_count: samplingPreviews.length - shownSampling.length, remaining_sampling_rule_keys_complete: true,
    next_tool: 'read_target_selectors', save_tool: 'stage_target_selector_draft',
    instruction: 'actual_value 是当前所选 span 的业务字段或组件取文，author_reason 仅为作者解释，不补入交付值；组件值不自动决定适用分支。actual_value_complete=false 表示有界节选，actual_value_available=false 表示来源未全读；不能据节选判定原记录缺字。完整绑定以原记录 span_ids 为准，source_context 仅显示已读来源。比较原文并由作者判断必要限定，不自动补字或修归属。按 remaining_item_keys 读 items、按 remaining_sampling_rule_keys 读 sampling_rules；键目录也受预算限制，keys_complete=false 时可读对应集合目录。单条预览仍超预算时按完整记录的 span_ids 读取必要来源，不因未展示而判定缺项。按原契约保存完整 keyed 记录，预览不代表验证或封存。' };
    while (Buffer.byteLength(JSON.stringify(response), 'utf8') > 16 * 1024
      && (response.remaining_item_keys.length || response.remaining_sampling_rule_keys.length)) {
      if (response.remaining_sampling_rule_keys.length) response.remaining_sampling_rule_keys.pop();
      else response.remaining_item_keys.pop();
    }
    response.remaining_item_keys_complete = response.remaining_item_keys.length === response.remaining_item_count;
    response.remaining_sampling_rule_keys_complete = response.remaining_sampling_rule_keys.length === response.remaining_sampling_rule_count;
    return response;
  };
  for (const entry of previews) {
    shown.push(entry);
    if (Buffer.byteLength(JSON.stringify(result()), 'utf8') > 16 * 1024) { shown.pop(); break; }
  }
  for (const entry of samplingPreviews) {
    shownSampling.push(entry);
    if (Buffer.byteLength(JSON.stringify(result()), 'utf8') > 16 * 1024) { shownSampling.pop(); break; }
  }
  return result();
}

function excerpt(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  let result = '', bytes = 0;
  for (const char of value) { const size = Buffer.byteLength(char, 'utf8'); if (bytes + size > maxBytes) break; result += char; bytes += size; }
  return result;
}
