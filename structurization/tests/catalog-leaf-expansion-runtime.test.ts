import { describe, expect, it } from 'vitest';
import { createCatalogLeafExpansionTools, CATALOG_LEAF_EXPANSION_SYSTEM_PROMPT } from '../src/catalog-leaf-expansion-runtime.js';

describe('catalog leaf expansion tool port', () => {
  it('exposes only evidence/worklist operations and forwards results without a shell or file-write tool', async () => {
    const calls: unknown[] = [];
    const controller = {
      dispatch: async (name: string, params: Record<string, unknown>) => { calls.push({ name, params }); return { ok: false, error: 'Open the source page first.' }; },
      result: () => ({ sealed: false }),
      snapshot: () => ({ checkpoint: '', working_plan_sha256: '', history_sequence: 0, last_valid_fingerprint: '' }),
    };
    const tools = createCatalogLeafExpansionTools(controller);
    expect(tools.map((tool) => tool.name)).toEqual([
      'list_catalog_leaves', 'search_catalog_leaf', 'open_catalog_leaf_page', 'expand_catalog_leaf',
      'resolve_catalog_leaves', 'validate_catalog_leaf_expansion', 'seal_catalog_leaf_expansion',
    ]);
    const tool = tools.find((item) => item.name === 'search_catalog_leaf')!;
    const result = await tool.execute('call-1', { node_id: 'id-1' }, undefined, undefined, {} as never);
    expect(calls).toEqual([{ name: 'search_catalog_leaf', params: { node_id: 'id-1' } }]);
    expect(result.details).toEqual({ ok: false, error: 'Open the source page first.' });
    expect(CATALOG_LEAF_EXPANSION_SYSTEM_PROMPT).toContain('不能只看名称');
    expect(CATALOG_LEAF_EXPANSION_SYSTEM_PROMPT).toContain('不得继续展开检验批');
    expect(CATALOG_LEAF_EXPANSION_SYSTEM_PROMPT).toContain('新增结构子项自动进入工作队列');
    expect(CATALOG_LEAF_EXPANSION_SYSTEM_PROMPT).toContain('即使是空白表，也应作为该分项的 inspection_lot 子节点');
  });
});
