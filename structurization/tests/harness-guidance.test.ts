import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';
import {
  ACCEPTANCE_ORGANIZATION_GUIDANCE, INSPECTION_UNIT_GUIDANCE, FIELD_SOURCE_BINDING_GUIDANCE,
  ITEM_NAME_PATH_GUIDANCE, LOT_NAMING_GUIDANCE, SELECTOR_FIELD_ROLE_GUIDANCE,
  SELECTOR_PATCH_GUIDANCE, SELECTOR_SAMPLING_GUIDANCE, SOURCE_CONTEXT_INVESTIGATION,
} from '../src/acceptance-delivery-contract.js';
import {
  TARGET_SELECTOR_PROTOCOLS, LOSSLESS_REPRESENTATION_EQUIVALENCE_RULE,
  DISCOVERY_SYSTEM_PROMPT, DISCOVERY_REVIEW_SYSTEM_PROMPT, NAMING_CATEGORY_PROTOCOL,
  LEGACY_PLAN_PROTOCOL, LIFECYCLE_PROTOCOL,
} from '../src/acceptance-prompt-suite.js';
import { resolveDocumentReferenceTarget } from '../src/document-reference.js';
import { sha256Text } from '../src/canonical.js';
import {
  glmModelCompatibility, mimoModelCompatibility, SYSTEM_PROMPT, TARGET_SELECTOR_SYSTEM_PROMPT,
  COVERAGE_REVIEW_SYSTEM_PROMPT, HIERARCHY_CONFIRM_SYSTEM_PROMPT,
  HIERARCHY_SYSTEM_PROMPT, HIERARCHY_REVIEW_SYSTEM_PROMPT,
} from '../src/pi-runtime.js';
import { resolvePdfExCodePreset } from '../src/presets.js';
import { selectorDispositionCoverage } from '../src/evidence-disposition-coverage.js';

// The whole-suite replacement moves specialist instructions to a real read-only
// tool contract. Check their reachable destination, not the old duplicate prose
// in every system prompt. Mechanical behavior is still covered independently.
describe('harness contract regressions', () => {
  test('separates business organization from execution shards without embedding a document answer', () => {
    for (const prompt of [TARGET_SELECTOR_SYSTEM_PROMPT, HIERARCHY_CONFIRM_SYSTEM_PROMPT,
      HIERARCHY_SYSTEM_PROMPT, DISCOVERY_SYSTEM_PROMPT, DISCOVERY_REVIEW_SYSTEM_PROMPT]) {
      expect(prompt).toContain(ACCEPTANCE_ORGANIZATION_GUIDANCE);
    }
    for (const prompt of [HIERARCHY_CONFIRM_SYSTEM_PROMPT, HIERARCHY_SYSTEM_PROMPT, HIERARCHY_REVIEW_SYSTEM_PROMPT]) {
      expect(prompt).toContain(INSPECTION_UNIT_GUIDANCE);
    }
    expect(ACCEPTANCE_ORGANIZATION_GUIDANCE).toContain('一个 target 可以有多个业务检验批');
    expect(ACCEPTANCE_ORGANIZATION_GUIDANCE).toContain('主控项目/一般项目属于 item.category');
    expect(INSPECTION_UNIT_GUIDANCE).toContain('具名单元声明');
    expect(ACCEPTANCE_ORGANIZATION_GUIDANCE + INSPECTION_UNIT_GUIDANCE).not.toMatch(/50204|4\.2|模板安装|现浇|预制构件/u);
  });

  test('name hierarchy remains semantic, source-bound and independent of business granularity', () => {
    expect(TARGET_SELECTOR_PROTOCOLS.names_and_category).toContain(ITEM_NAME_PATH_GUIDANCE);
    expect(ITEM_NAME_PATH_GUIDANCE).toContain('任意层级');
    expect(ITEM_NAME_PATH_GUIDANCE).toContain('fields.name.span_ids');
    expect(ITEM_NAME_PATH_GUIDANCE).toContain('名称路径不创建树节点、不改变粒度');
    expect(ITEM_NAME_PATH_GUIDANCE).toContain('多分支共同名称不携带某一分支专属条件');
    expect(ITEM_NAME_PATH_GUIDANCE).not.toMatch(/50204|薄腹梁|桁架|4\.2\.11/u);
  });

  test('lot naming preserves complete source names rather than applying document-specific shortening', () => {
    for (const prompt of [TARGET_SELECTOR_SYSTEM_PROMPT, HIERARCHY_CONFIRM_SYSTEM_PROMPT,
      HIERARCHY_SYSTEM_PROMPT, HIERARCHY_REVIEW_SYSTEM_PROMPT]) expect(prompt).toContain(LOT_NAMING_GUIDANCE);
    for (const prompt of [HIERARCHY_CONFIRM_SYSTEM_PROMPT, HIERARCHY_SYSTEM_PROMPT, HIERARCHY_REVIEW_SYSTEM_PROMPT]) {
      expect(prompt).toContain('source_title_fragments');
      expect(prompt).toContain('编号');
    }
    expect(LOT_NAMING_GUIDANCE).toContain('包括与父级重复但属于原名的用语');
    expect(LOT_NAMING_GUIDANCE).toContain('跨节、拆并');
    expect(LOT_NAMING_GUIDANCE).toContain('不以字符串删前缀、长度、正则或专用词表');
    expect(LOT_NAMING_GUIDANCE).not.toMatch(/GB.?50204|模板安装|钢筋加工|混凝土施工|4\.2|5\.3/u);
  });

  test('sampling protocols preserve evidence identity, all states and complete author record requirements', () => {
    expect(TARGET_SELECTOR_PROTOCOLS.sampling).toBe(SELECTOR_SAMPLING_GUIDANCE);
    expect(SELECTOR_SAMPLING_GUIDANCE).toContain('quantity/script/condition spans 同 evidence');
    expect(SELECTOR_SAMPLING_GUIDANCE).toContain('跨 evidence 组合');
    for (const status of ['pending', 'explicit', 'reference', 'reference_unspecified_quantity', 'not_sampling', 'fallback', 'missing_external_source']) {
      expect(SELECTOR_SAMPLING_GUIDANCE).toContain(status);
    }
    for (const role of ['applicability', 'branch_condition', 'method', 'quantity', 'acceptance_criterion', 'exception', 'note']) {
      expect(SELECTOR_SAMPLING_GUIDANCE).toContain(role);
    }
    expect(SELECTOR_SAMPLING_GUIDANCE).toContain('“全验/全数检查”是可执行 quantity');
    expect(SELECTOR_SAMPLING_GUIDANCE).toContain('不改 fallback/not_sampling');
    expect(SELECTOR_SAMPLING_GUIDANCE).toContain('不是内部定位失败');
    expect(TARGET_SELECTOR_PROTOCOLS.patch).toBe(SELECTOR_PATCH_GUIDANCE);
    for (const field of ['status', 'rule_key', 'branch_keys', 'reason', 'confidence', 'remove_keys', 'quote_bindings']) {
      expect(SELECTOR_PATCH_GUIDANCE).toContain(field);
    }
    expect(SELECTOR_PATCH_GUIDANCE).toContain('完整记录，不是字段 patch');
    expect(SELECTOR_PATCH_GUIDANCE).toContain('原计划全部 key 最终保存');
    expect(SELECTOR_PATCH_GUIDANCE).toContain('删除意图、来源绑定与对应记录原子关系');
    expect(SELECTOR_PATCH_GUIDANCE).toContain('saved_local_validation_failed 已保存全部增删，不重放删除');
    expect(TARGET_SELECTOR_PROTOCOLS.field_roles).toBe(SELECTOR_FIELD_ROLE_GUIDANCE);
    expect(SELECTOR_FIELD_ROLE_GUIDANCE).toContain('section_heading/类别标题不作 method、quantity');
    expect(LIFECYCLE_PROTOCOL).toContain('已完整草稿也可从任一阶段 commit');
  });

  test('source investigation has a finite factual stopping condition and can reuse shared decisions', () => {
    expect(TARGET_SELECTOR_SYSTEM_PROMPT).toContain(SOURCE_CONTEXT_INVESTIGATION);
    expect(SOURCE_CONTEXT_INVESTIGATION).toContain('每个字段都须考虑共同规定');
    expect(SOURCE_CONTEXT_INVESTIGATION).toContain('同一已读共同规则及其适用结论可复用');
    expect(SOURCE_CONTEXT_INVESTIGATION).toContain('无需证明全文绝无未知规则');
    expect(SOURCE_CONTEXT_INVESTIGATION).toContain('具体未决就继续针对性调查');
    expect(SOURCE_CONTEXT_INVESTIGATION).not.toMatch(/GB.?50207|4\.1\.3|500|1000|140mm|100mm/u);
  });

  test('all author paths allow lossless same-property branches but keep independent properties separate', () => {
    expect(TARGET_SELECTOR_SYSTEM_PROMPT).toContain(LOSSLESS_REPRESENTATION_EQUIVALENCE_RULE);
    expect(LOSSLESS_REPRESENTATION_EQUIVALENCE_RULE).toContain('一个 item 对应一个');
    expect(LOSSLESS_REPRESENTATION_EQUIVALENCE_RULE).toContain('不同属性、类别或不相容判定公式须分开');
    expect(LOSSLESS_REPRESENTATION_EQUIVALENCE_RULE).toContain('拆项同时拆分名称和 requirement');
    expect(LOSSLESS_REPRESENTATION_EQUIVALENCE_RULE).toContain('同一属性上下限可是一项');
    expect(LOSSLESS_REPRESENTATION_EQUIVALENCE_RULE).toContain('存在独立剩余判据则保留');
    expect(LOSSLESS_REPRESENTATION_EQUIVALENCE_RULE).toContain('不按标点');
    expect(LOSSLESS_REPRESENTATION_EQUIVALENCE_RULE).not.toMatch(/柱塞|充液量|撞板|4\.8\.5|8项|8 项/u);
    expect(SYSTEM_PROMPT).toContain(LEGACY_PLAN_PROTOCOL);
    expect(SYSTEM_PROMPT).not.toContain('仅用于已有历史 coverage 检查点');
    expect(COVERAGE_REVIEW_SYSTEM_PROMPT).not.toContain('materialized as sibling leaves or hidden in note');
    expect(TARGET_SELECTOR_SYSTEM_PROMPT).not.toContain('review_target_selector_draft');
  });

  test('name classification and field roles remain model decisions while exact bindings carry the output', () => {
    expect(TARGET_SELECTOR_PROTOCOLS.names_and_category).toBe(NAMING_CATEGORY_PROTOCOL);
    expect(NAMING_CATEGORY_PROTOCOL).toContain('原文未标明类别');
    expect(NAMING_CATEGORY_PROTOCOL).toContain('“一般规定”不等于“一般项目”');
    expect(NAMING_CATEGORY_PROTOCOL).toContain('fields.name 绑定生成实际名称');
    expect(TARGET_SELECTOR_PROTOCOLS.fields).toBe(FIELD_SOURCE_BINDING_GUIDANCE);
    expect(FIELD_SOURCE_BINDING_GUIDANCE).toContain('只有 fields.name 可用 semantic_summary');
    expect(FIELD_SOURCE_BINDING_GUIDANCE).toContain('不得从合格判据反推检查方法');
    expect(FIELD_SOURCE_BINDING_GUIDANCE).toContain('criterion_span_ids 是依据清单，不是可见判据');
    expect(FIELD_SOURCE_BINDING_GUIDANCE).toContain('具体判据条件不能靠 lot、name、reason、note');
    expect(FIELD_SOURCE_BINDING_GUIDANCE).toContain('组织范围可由 lots.scope_span_ids+item.lot_key 继承');
    expect(TARGET_SELECTOR_PROTOCOLS.reference_routes).toContain('reference_placeholder 的 destinations=[]');
    expect(TARGET_SELECTOR_PROTOCOLS.branches).toContain('实际条件及允许值');
  });

  test('GB50202 7.5.4 resolves both delegated clauses and their actual tables', async () => {
    const source = await readFile(new URL('../fixtures/real/GB_50202-2018.md', import.meta.url), 'utf8');
    const hash = sha256Text(source);
    for (const number of ['7.2.9', '7.2.10']) {
      const clause = resolveDocumentReferenceTarget(source, hash, { kind: 'clause', number });
      expect(clause.ok).toBe(true);
      if (clause.ok) expect(clause.evidence.map(e => e.text).join('\n')).toContain(number);
      const table = resolveDocumentReferenceTarget(source, hash, { kind: 'table', number });
      expect(table.ok).toBe(true);
      if (table.ok) expect(table.evidence.some(e => /检验|检查|允许/u.test(e.text))).toBe(true);
    }
  });

  test('one selected span accounts for a record but never proves its other judgment was extracted', () => {
    const coverage = selectorDispositionCoverage({
      selectors: { items: [{ criterion_span_ids: ['a'] }] },
      evidence: [{ evidence_id: 'two-judgments', requires_disposition: true }],
      spans: [{ span_id: 'a', evidence_id: 'two-judgments' }, { span_id: 'b', evidence_id: 'two-judgments' }],
    });
    expect(coverage.bound_evidence_ids).toEqual(['two-judgments']);
    expect(coverage.uncovered_required_ids).toEqual([]);
  });

  test('protocol profile remains separate from model-specific compatibility adapters', () => {
    const preset = resolvePdfExCodePreset({ LLM_PRESET: 'Gpt5.6Luna', LLM_MODEL: 'gpt-5.6-luna', LLM_ENDPOINT: 'https://llm.example/v1', LLM_API_KEY: 'test-key', LLM_REASONING_EFFORT: 'low' })!;
    expect(preset).toMatchObject({ api: 'openai-completions', modelId: 'gpt-5.6-luna', baseUrl: 'https://llm.example/v1', reasoningEffort: 'low' });
    expect(mimoModelCompatibility('mimo-v2.5')).toMatchObject({ thinkingFormat: 'deepseek', supportsReasoningEffort: true, requiresReasoningContentOnAssistantMessages: true, supportsDeveloperRole: false, maxTokensField: 'max_tokens' });
    expect(mimoModelCompatibility('gpt-5.6-luna')).toEqual({});
    expect(glmModelCompatibility('glm-5.3-flash')).toEqual({ thinkingFormat: 'zai', maxTokensField: 'max_tokens' });
    expect(glmModelCompatibility('muse-spark-1.3-contributor')).toEqual({});
  });
});
