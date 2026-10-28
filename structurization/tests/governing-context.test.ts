import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { governingContextWindows, documentSearchMatch } from '../src/governing-context.js';
import { scanDocumentLedger } from '../src/document-ledger.js';
import { buildAgentScopedEvidenceManifest, buildDocumentEvidence, type DocumentTarget } from '../src/document-discovery.js';

// Original miniature source: layout intentionally differs from the live roof sample.
const source = ['# 3 基本规定', '3.0.1 每批检查记录。', '# 4 基层工程', '# 4.1 一 般 规 定',
  '4.1.1 每100㎡检查一处，每处10㎡，且不少于3处。', '# 4.2 找平层', '# 主控项目',
  '4.2.1 材料应符合设计。', '检验方法：检查报告。', '# 5 防水工程', '# 5.1 一般规定',
  '5.1.1 防水层全数检查。', '# 5.2 卷材', '5.2.1 卷材无破损。'].join('\n');

describe('governing context investigation', () => {
  test('nominates document and ancestor context without unrelated chapter scope', () => {
    const ledger = scanDocumentLedger(source, 'sample.md');
    expect(governingContextWindows(ledger, { start_line: 6, end_exclusive_line: 10 }))
      .toEqual([{ start_line: 1, end_exclusive_line: 3 }, { start_line: 4, end_exclusive_line: 6 }]);
  });
  test('whitespace keywords no longer require an impossible contiguous phrase', () => {
    expect(documentSearchMatch('每个检验批按面积抽检', '检验批 抽样')?.matched_terms).toEqual(['检验批']);
    expect(documentSearchMatch('抽样用于检验批', '检验批 抽样')!.score)
      .toBeGreaterThan(documentSearchMatch('检验批', '检验批 抽样')!.score);
    expect(documentSearchMatch('无关', '检验批 抽样')).toBeNull();
    expect(documentSearchMatch('anything', '   ')).toBeNull();
  });
  test.each([3, 13])('glued context heading numbers remain optional navigation without changing the ledger (%i)', chapter => {
    const owner = chapter + 4;
    const compactSource = [`# ${chapter}基 本 规 定 [PDF p.2]`, `${chapter}.0.1 每批保留检查记录。`,
      `# ${owner} 基层工程`, `# ${owner}.1一 般 规 定 [PDF p.3]`, `${owner}.1.1 每100㎡检查一处。`,
      `# ${owner}.2 找平层`, `${owner}.2.1 表面应平整。`, `# ${owner + 1} 防水工程`,
      `# ${owner + 1}.1一般规定`, `${owner + 1}.1.1 防水层全数检查。`, `# ${owner + 1}.2 卷材`].join('\n');
    const ledger = scanDocumentLedger(compactSource, 'compact-neutral.md'), untouched = structuredClone(ledger);
    expect(governingContextWindows(ledger, { start_line: 6, end_exclusive_line: 8 }))
      .toEqual([{ start_line: 1, end_exclusive_line: 3 }, { start_line: 4, end_exclusive_line: 6 }]);
    expect(ledger).toEqual(untouched);
    const invalidTitles = ['3D基本规定', '2.5毫米', '3基本规定说明', '3.1节的规定'];
    for (const title of invalidTitles) {
      const counter = scanDocumentLedger(`# ${title}\n说明文字。\n# 8 基层工程\n# 8.2 找平层\n8.2.1 表面应平整。`, 'counter.md');
      expect(governingContextWindows(counter, { start_line: 4, end_exclusive_line: 6 })).toEqual([]);
    }
  });
  test.each([false, true])('author and reviewer share exact optional context; never a primary disposition obligation (glued=%s)', async glued => {
    const root = await mkdtemp(join(tmpdir(), 'governing-context-'));
    try {
      const path = join(root, 'sample.md');
      const formatted = glued ? source.replace('# 3 基本规定', '# 3基本规定').replace('# 4.1 一 般 规 定', '# 4.1一 般 规 定') : source;
      await writeFile(path, formatted);
      const document = buildDocumentEvidence(formatted, path); const atom = document.atoms[0]!;
      const target: DocumentTarget = { target_id: 'test', group_id: 'g', group_name: 'g', group_reason: 'test', name: '找平层', description: 'test',
        evidence_atom_ids: [atom.atom_id], evidence_fragments: [{ atom_id: atom.atom_id, text: '# 4.2 找平层' }],
        materialization: { kind: 'work_scope', lot_basis_summary: '找平层', lot_basis_fragments: [{ atom_id: atom.atom_id, text: '# 4.2 找平层' }], reason: 'test' }, reason: 'test' };
      const { manifest } = await buildAgentScopedEvidenceManifest(path, 'job', target, document, undefined, { start_line: 6, end_exclusive_line: 10 });
      const contextIds = new Set(manifest.scope.governing_context_evidence_ids);
      const context = manifest.evidence.filter(e => contextIds.has(e.evidence_id));
      expect(context.some(e => e.text.includes('每100㎡'))).toBe(true);
      expect(context.every(e => !e.requires_disposition && e.evidence_scope !== 'primary')).toBe(true);
      expect(context.some(e => e.text.includes('防水层全数'))).toBe(false);
      expect(manifest.evidence.some(e => e.text.includes('材料应符合设计') && e.requires_disposition)).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
