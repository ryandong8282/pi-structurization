import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { createAgentSession, DefaultResourceLoader, SessionManager } from '@earendil-works/pi-coding-agent';
import { CatalogCoverageReview, CATALOG_COVERAGE_REVIEW_PROMPT, createCatalogCoverageReviewTools, type CatalogCoverageRequest } from '../src/catalog-coverage-review.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const sourcePath = 'source/markdown/original/full.md';
// Neither the test domain nor its columns/codes come from the user's document.
const original = '<table><tr><td rowspan="2">材料体系</td><td>首个子类</td><td>甲项目、乙项目</td></tr>'
  + '<tr><td>下一子类</td><td>丙项目</td></tr></table>\n续表\n'
  + '<table><tr><td>材料体系</td><td>续表首个子类</td><td>丁项目</td></tr></table>';
const request = (): CatalogCoverageRequest => ({ sha256: 'draft-hash', structures: [
  { id: 's1', title: '材料体系', nodes: [{ id: 'parent', parentId: null, name: '材料体系', constructionKind: 'other' },
    { id: 'c', parentId: 'parent', name: '下一子类', constructionKind: 'other' }] },
  { id: 's2', title: '另一套清单', nodes: [{ id: 'x', parentId: null, name: '其他项', constructionKind: 'other' }] },
] });
async function fixture(reviewRequest = request()) {
  const root = await mkdtemp(join(tmpdir(), 'catalog-coverage-review-')); roots.push(root);
  await mkdir(join(root, 'source/markdown/original'), { recursive: true });
  await writeFile(join(root, sourcePath), original);
  await writeFile(join(root, 'author.py'), 'not original evidence');
  const review = new CatalogCoverageReview({ workspaceRoot: root, request: reviewRequest,
    openPage: async () => ({ ok: true, pageNumber: 1, text: '原件中的连续引用', next_offset: null }) });
  return { root, review };
}
const finding = (structureId: string, status = 'needs_work') => ({ structureId, status,
  reason: '原文同一行及续表首行包含的子类未进入该结构，须核查并补齐后重新提交。',
  evidence: [{ path: sourcePath, quote: original.slice(0, 80) }] });

test('review has only scoped read/search/outline/submit tools, not authoring or publishing capabilities', async () => {
  const { review } = await fixture();
  expect(createCatalogCoverageReviewTools(review).map(t => t.name)).toEqual([
    'catalog_review_outline', 'read_catalog_review_source', 'search_catalog_review_source',
    'open_catalog_review_page', 'submit_catalog_coverage_review',
  ]);
  expect(CATALOG_COVERAGE_REVIEW_PROMPT).toContain('从原文反查产物是否漏项');
  expect(CATALOG_COVERAGE_REVIEW_PROMPT).toContain('一行可能同时贡献多个层级');
  expect(CATALOG_COVERAGE_REVIEW_PROMPT).toContain('不等于整行重复');
  expect(CATALOG_COVERAGE_REVIEW_PROMPT).toContain('不能只拿树中已有名称');
  expect(CATALOG_COVERAGE_REVIEW_PROMPT).toContain('不得把抽样没发现问题称为全量核对');
  expect(CATALOG_COVERAGE_REVIEW_PROMPT).toContain('不得仅因重复返回 needs_work、要求删除合并或阻止封存');
  expect(CATALOG_COVERAGE_REVIEW_PROMPT).toContain('同名显示后缀由 harness 自动编号');
  expect(CATALOG_COVERAGE_REVIEW_PROMPT).toContain('仍须核对真实出处、完整名称、层级归属和来源范围覆盖');
  expect(CATALOG_COVERAGE_REVIEW_PROMPT).toContain('itemWithoutInspectionLotCount');
  expect(CATALOG_COVERAGE_REVIEW_PROMPT).toContain('必须回原文调查两者是否在同一适用范围');
  expect(CATALOG_COVERAGE_REVIEW_PROMPT).toContain('不能据此机械复制');
});

test('outline exposes engineering items without inspection-lot descendants across independent trees as review leads', async () => {
  const { review } = await fixture({ sha256: 'cross-tree-draft', structures: [
    { id: 'classification', title: '工程划分', nodes: [
      { id: 'division', parentId: null, name: '主体工程', constructionKind: 'division' },
      { id: 'item-a', parentId: 'division', name: '构件安装', constructionKind: 'item' },
      { id: 'item-b', parentId: 'division', name: '构件连接', constructionKind: 'item' },
      { id: 'group', parentId: 'item-b', name: '记录分组', constructionKind: 'other' },
      { id: 'lot-b', parentId: 'group', name: '构件连接检验批', constructionKind: 'inspection_lot' },
    ] },
    { id: 'forms', title: '验收记录表', nodes: [
      { id: 'form-item', parentId: null, name: '构件安装', constructionKind: 'item' },
      { id: 'form-lot', parentId: 'form-item', name: '构件安装检验批', constructionKind: 'inspection_lot' },
    ] },
  ] });
  const outline = await review.dispatch('catalog_review_outline', {});
  expect(outline.structures).toEqual([
    { id: 'classification', title: '工程划分', nodeCount: 5, itemWithoutInspectionLotCount: 1, inspectionLotCount: 1 },
    { id: 'forms', title: '验收记录表', nodeCount: 2, itemWithoutInspectionLotCount: 0, inspectionLotCount: 1 },
  ]);
});

test('keeps same-parent repeated names and codes in the outline and accepts source-backed approval', async () => {
  const duplicateNodes = ['first', 'second'].map(id => ({ id, parentId: 'root', name: '重复条目',
    constructionKind: 'other', identifiers: { formCode: 'X-1' } }));
  const { root, review } = await fixture({ sha256: 'repeated-draft', structures: [{ id: 's', title: '清单', nodes: [
    { id: 'root', parentId: null, name: '清单', constructionKind: 'other' }, ...duplicateNodes,
  ] }] });
  const source = '清单\n重复条目 X-1\n重复条目 X-1';
  await writeFile(join(root, sourcePath), source);
  const outline = await review.dispatch('catalog_review_outline', { structure_id: 's', parent_id: 'root' });
  expect(outline.nodes).toEqual(duplicateNodes);
  expect(outline.total).toBe(2);
  await review.dispatch('read_catalog_review_source', { path: sourcePath });
  const approved = await review.dispatch('submit_catalog_coverage_review', { approved: true, summary: '来源条目均已覆盖，保留重复项。',
    reviews: [{ structureId: 's', status: 'passed', reason: '同名同编码的两个条目均保留，未以重复为理由删除或退回。',
      evidence: [{ path: sourcePath, quote: source }] }] });
  expect(approved).toMatchObject({ ok: true, approved: true });
  expect(review.result()?.approved).toBe(true);
});

test('real SDK review assembly has an isolated prompt and cannot expose authoring tools or workspace instructions', async () => {
  const { root, review } = await fixture();
  await writeFile(join(root, 'AGENTS.md'), 'AUTHOR_CONTEXT_MUST_NOT_BE_LOADED');
  const customTools = createCatalogCoverageReviewTools(review);
  const resourceLoader = new DefaultResourceLoader({ cwd: root, agentDir: join(root, 'review-agent'),
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    systemPrompt: CATALOG_COVERAGE_REVIEW_PROMPT });
  await resourceLoader.reload();
  const { session } = await createAgentSession({ cwd: root, agentDir: join(root, 'review-agent'),
    noTools: 'builtin', tools: customTools.map(t => t.name), customTools, resourceLoader,
    sessionManager: SessionManager.inMemory(root) });
  try {
    expect(session.getActiveToolNames().sort()).toEqual(customTools.map(t => t.name).sort());
    expect(session.systemPrompt).toContain('独立、只读覆盖审查');
    expect(session.systemPrompt).not.toContain('AUTHOR_CONTEXT_MUST_NOT_BE_LOADED');
  } finally { session.dispose(); }
});

test('long single-line HTML can be read completely by character pagination without rewriting original', async () => {
  const { root, review } = await fixture();
  const huge = original.repeat(240);
  await writeFile(join(root, sourcePath), huge);
  let offset: number | null = 0; let actual = ''; let calls = 0;
  while (offset !== null) {
    const result = await review.dispatch('read_catalog_review_source', { path: sourcePath, offset, limit: 4096 });
    expect(result.ok).toBe(true); actual += result.text; calls++; offset = result.next_offset as number | null;
  }
  expect(calls).toBeGreaterThan(1);
  expect(actual).toBe(huge);
  expect(await readFile(join(root, sourcePath), 'utf8')).toBe(huge);
});

test('read/search reject author files and traversal outside source even with an absolute path', async () => {
  const { root, review } = await fixture();
  for (const path of ['author.py', 'source/../author.py', join(root, 'author.py')]) {
    for (const name of ['read_catalog_review_source', 'search_catalog_review_source']) {
      const result = await review.dispatch(name, { path, query: 'original' });
      expect(result.ok).toBe(false); expect(result.error).toMatch(/只允许读取 source/);
    }
  }
});

test('source search finds omitted first/continuation-row items independently of delivered node names', async () => {
  const { review } = await fixture();
  const source = await review.dispatch('search_catalog_review_source', { path: sourcePath, query: '首个子类' });
  expect((source.matches as unknown[]).length).toBe(2);
  const tree = await review.dispatch('catalog_review_outline', { structure_id: 's1', parent_id: 'parent' });
  expect((tree.nodes as Array<{name: string}>).map(n => n.name)).toEqual(['下一子类']);
  const rejected = await review.dispatch('submit_catalog_coverage_review', {
    approved: false, summary: '系统性漏掉含父级行的子项。', reviews: [finding('s1')],
  });
  expect(rejected).toMatchObject({ ok: true, approved: false });
  expect(review.result()?.reviews).toHaveLength(1); // can stop early after finding a systemic defect
});

test('a claimed approval needs all structures and evidence actually read from source', async () => {
  const { review } = await fixture();
  const report = { approved: true, summary: '已对账', reviews: [finding('s1', 'passed'), finding('s2', 'passed')] };
  expect((await review.dispatch('submit_catalog_coverage_review', report)).ok).toBe(false);
  await review.dispatch('read_catalog_review_source', { path: sourcePath });
  expect((await review.dispatch('submit_catalog_coverage_review', { ...report, reviews: report.reviews.slice(0, 1) })).ok).toBe(false);
  expect((await review.dispatch('submit_catalog_coverage_review', { ...report, reviews: [finding('s1', 'passed'), finding('s1', 'passed')] })).ok).toBe(false);
  expect((await review.dispatch('submit_catalog_coverage_review', { ...report, reviews: [finding('s1', 'passed'), finding('s2')] })).ok).toBe(false);
  const invented = structuredClone(report); invented.reviews[0]!.evidence[0]!.quote = '不存在的来源引用';
  expect((await review.dispatch('submit_catalog_coverage_review', invented)).ok).toBe(false);
  expect(review.result()).toBeUndefined();
  expect((await review.dispatch('submit_catalog_coverage_review', report)).ok).toBe(true);
  const saved = review.result()!; saved.approved = false;
  expect(review.result()?.approved).toBe(true);
});

test('search is paginated, parent/node lists are bounded, and aborted review cannot submit', async () => {
  const { root, review } = await fixture();
  await writeFile(join(root, sourcePath), original.repeat(12));
  const first = await review.dispatch('search_catalog_review_source', { path: sourcePath, query: '首个子类' });
  expect(first.matches).toHaveLength(8); expect(first.next_offset).toBeTypeOf('number');
  const next = await review.dispatch('search_catalog_review_source', { path: sourcePath, query: '首个子类', offset: first.next_offset });
  expect(next.matches).toHaveLength(8);
  const tree = await review.dispatch('catalog_review_outline', { structure_id: 's1', limit: 1 });
  expect(tree.nodes).toHaveLength(1); expect(tree.next_offset).toBe(1);
  const abort = new AbortController(); abort.abort();
  expect((await review.dispatch('submit_catalog_coverage_review', { approved: false, summary: '发现漏项', reviews: [finding('s1')] }, abort.signal)).ok).toBe(false);
  expect(review.result()).toBeUndefined();
});

test('Word text sections can be cited after opening them and do not need fabricated PDF evidence', async () => {
  const { review } = await fixture();
  await review.dispatch('open_catalog_review_page', { page_number: 1 });
  const result = await review.dispatch('submit_catalog_coverage_review', { approved: false, summary: '需要补查',
    reviews: [{ ...finding('s1'), evidence: [{ path: 'source/pages.json', quote: '原件中的连续引用' }] }] });
  expect(result.ok).toBe(true);
});
