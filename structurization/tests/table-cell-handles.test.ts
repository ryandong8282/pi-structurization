import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { RevisionWorkspace } from '../src/workspace.js';
import { ToolController } from '../src/tools.js';
import { renderedTableCellSpans } from '../src/source-span-registry.js';

test('canonical row cells preserve delimiters, duplicate values and exact coordinates without guessing roles', () => {
  const row = { kind: 'table_row', table_title: '表 A', row_index: 2, columns: ['项目', '值', '方法'], cells: ['A | B=C', '5', '5'], text: '表 A | 数据行 2 | 项目=A | B=C | 值=5 | 方法=5' };
  const cells = renderedTableCellSpans(row);
  expect(cells.map(c => row.text.slice(c.start, c.end))).toEqual(row.cells);
  expect(cells[1]!.start).not.toBe(cells[2]!.start);
  expect(renderedTableCellSpans({ ...row, text: row.text + 'changed' })).toEqual([]);
});

test('single and batch table reads expose usable exact cell handles while retaining the complete row', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-cell-handles-'));
  try {
    const markdown = '# 4.2 质量检验\n\n表 4.2 尺寸\n\n<table><tr><td>项目</td><td>允许偏差(mm)</td><td>检验方法</td></tr><tr><td>平整度</td><td>5</td><td>靠尺检查</td></tr></table>\n';
    const sourcePath = join(root, 'source.md');
    await writeFile(sourcePath, markdown);
    const workspace = await RevisionWorkspace.create(root, 'cells', 'target', sourcePath);
    const controller = await ToolController.create(workspace);
    const manifest = await workspace.readEvidenceManifest();
    const row = manifest.evidence.find(e => e.kind === 'table_row' && e.cells?.includes('靠尺检查'))!;
    expect(row).toBeDefined();
    const single = await controller.dispatch('open_evidence', { evidence_id: row.evidence_id }) as any;
    expect(single.cells.map((c: any) => c.text)).toEqual(['平整度', '5', '靠尺检查']);
    // 新证据只含本行单元格值，表头单位不能伪装成本数据行的来源。
    expect(row.table_text_format).toBe('cell_values_v1');
    expect(single.cells[1].label_fragments).toEqual([]);
    expect(single.cells[1]).not.toHaveProperty('label_span_id');
    expect(single.cells[1]).not.toHaveProperty('unit');
    const header = manifest.evidence.find(e => e.kind === 'table_row' && e.cells?.includes('允许偏差(mm)'))!;
    const openedHeader = await controller.dispatch('open_evidence', { evidence_id: header.evidence_id }) as any;
    const unitHeading = openedHeader.cells.find((c: any) => c.text === '允许偏差(mm)');
    expect(unitHeading.span_id).toMatch(/^span:/);
    const locatedUnit = await controller.dispatch('locate_evidence_span', { evidence_id: header.evidence_id, quote: 'mm' }) as any;
    expect(locatedUnit).toMatchObject({ ok: true, span: { evidence_id: header.evidence_id, span_id: expect.stringMatching(/^span:/) } });
    const registry = await workspace.readSourceSpanRegistry();
    expect(registry.spans.some(s => s.span_id === locatedUnit.span.span_id
      && s.evidence_id === header.evidence_id && header.text.slice(s.start, s.end) === 'mm')).toBe(true);
    expect(registry.spans.some(s => s.span_id === unitHeading.span_id
      && s.evidence_id === header.evidence_id && header.text.slice(s.start, s.end) === '允许偏差(mm)')).toBe(true);
    for (const c of [...single.cells, ...single.cells.flatMap((cell: any) => cell.label_fragments)]) {
      expect(registry.spans.some(s => s.span_id === c.span_id && row.text.slice(s.start, s.end) === c.text)).toBe(true);
    }
    const batch = await controller.dispatch('batch_open_evidence', { evidence_ids: [row.evidence_id] }) as any;
    expect(batch.opened[0].cells).toEqual(single.cells);
    expect(batch.opened[0].text_window.text).toBe(row.text);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('parenthetical heading fragments are navigation and retain non-unit qualifiers', () => {
  const row = {kind: 'table_row', table_title: '表 B', row_index: 2, columns: ['等级（推荐）', '应力(MPa)'], cells: ['甲', '7'], text: '表 B | 数据行 2 | 等级（推荐）=甲 | 应力(MPa)=7'};
  const spans = renderedTableCellSpans(row);
  expect(spans.flatMap(cell => cell.label_fragments.map(f => row.text.slice(f.start, f.end)))).toEqual(['推荐', 'MPa']);
  expect(spans.every(cell => !('unit' in cell))).toBe(true);
});
