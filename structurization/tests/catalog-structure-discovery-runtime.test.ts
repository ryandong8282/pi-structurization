import { expect, it } from 'vitest';
import { createCatalogStructureDiscoveryTools, CATALOG_STRUCTURE_DISCOVERY_PROMPT } from '../src/catalog-structure-discovery-runtime.js';

it('only exposes evidence survey/semantic grouping tools and sends images outside text payloads', async () => {
  const calls: unknown[] = [];
  const tools = createCatalogStructureDiscoveryTools({
    dispatch: async (name, params) => { calls.push({ name, params }); return { ok: true, text: '来源标题', image: { data: 'base64-image' } }; },
    result: () => ({ sealed: false }),
    snapshot: () => ({ checkpoint: '', working_plan_sha256: '', history_sequence: 0, last_valid_fingerprint: '' }),
  });
  expect(tools.map((tool) => tool.name)).toEqual(['get_catalog_structure_state', 'survey_catalog_structure_pages', 'search_catalog_structures', 'open_catalog_structure_page', 'propose_catalog_structures', 'seal_catalog_structures']);
  const response = await tools[3]!.execute('call', { page_number: 1, image: true }, undefined, undefined, {} as never);
  expect(response.content).toEqual([{ type: 'text', text: JSON.stringify({ ok: true, text: '来源标题' }) }, { type: 'image', mimeType: 'image/png', data: 'base64-image' }]);
  expect(calls).toHaveLength(1);
  expect(CATALOG_STRUCTURE_DISCOVERY_PROMPT).toContain('不能机械地“一候选一产物”');
  expect(CATALOG_STRUCTURE_DISCOVERY_PROMPT).toContain('同一套结构的续页');
});
