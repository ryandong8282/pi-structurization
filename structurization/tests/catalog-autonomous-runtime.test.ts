import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { CATALOG_AUTONOMOUS_PROMPT, catalogAutonomousPromptFor, catalogAutonomousRepairPromptFor, createCatalogAutonomousTools } from '../src/catalog-autonomous-runtime.js';
import { ModelSourceHandles } from '../src/model-source-handles.js';
import { createAgentSession, DefaultResourceLoader, SessionManager } from '@earendil-works/pi-coding-agent';
import { CATALOG_DOCUMENT_SKILL_PATHS } from '../src/catalog-document-skills.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, {recursive:true,force:true}))); });

test('requires an explicit construction code for engineering nodes without guessing from names', () => {
  expect(CATALOG_AUTONOMOUS_PROMPT).toContain('identifiers.constructionCode');
  expect(CATALOG_AUTONOMOUS_PROMPT).toContain('2～6位数字');
  expect(CATALOG_AUTONOMOUS_PROMPT).toContain('禁止从名称任意抓取数字');
  expect(CATALOG_AUTONOMOUS_PROMPT).toContain('不能确认就留空');
  const wordPrompt = catalogAutonomousPromptFor('word-text');
  expect(wordPrompt).toContain('identifiers.constructionCode');
  expect(wordPrompt).toContain('禁止从名称任意抓取数字');
});

test('leaves script language and execution strategy to the agent without a runtime preference', () => {
  expect(CATALOG_AUTONOMOUS_PROMPT).toContain('脚本语言与执行方式由你根据任务和实际可用环境自行选择');
  expect(CATALOG_AUTONOMOUS_PROMPT).not.toMatch(/优先(?:使用|考虑)[^。\n]*(?:Node(?:\.js)?|Python)/i);
});

test.each(['pdf', 'word-text'] as const)('allows repeated entries and leaves display suffixes to the harness for %s', (sourceKind) => {
  const prompt = catalogAutonomousPromptFor(sourceKind);
  expect(prompt).toContain('允许保留重复条目，包括同一父节点下同名、同证据的条目');
  expect(prompt).toContain('不要仅为去重删除、合并或改名');
  expect(prompt).toContain('每个节点仍使用独立 id，保留原始 name、编码和真实证据');
  expect(prompt).toContain('同名显示后缀由 harness 自动编号');
  expect(prompt).toContain('重复本身不阻止封存，也不能代替缺项、出处和层级归属的核对');
});

test('word-text prompt variant drops PDF page semantics and forbids visual evidence', () => {
  const pdfPrompt = catalogAutonomousPromptFor('pdf');
  expect(pdfPrompt).toBe(CATALOG_AUTONOMOUS_PROMPT);
  const wordPrompt = catalogAutonomousPromptFor('word-text');
  expect(wordPrompt).toContain('Word 原文按段落切成的文本分段字符串数组');
  expect(wordPrompt).toContain('禁止 visual 证据');
  expect(wordPrompt).toContain('没有 PDF 页码概念，页码一律指文本分段序号');
  expect(wordPrompt).not.toContain('source/pages.json 是 PDF 全文文本字符串数组');
  expect(wordPrompt).not.toContain('open_catalog_page 的 layout/image 核对');
});

test('requires agentic whole-document completion for engineering structures without imposing page sweeps or keyword joins', () => {
  expect(CATALOG_AUTONOMOUS_PROMPT).toContain('全文补全复核');
  expect(CATALOG_AUTONOMOUS_PROMPT).toContain('分部 → 子分部 → 分项 → 检验批');
  expect(CATALOG_AUTONOMOUS_PROMPT).toContain('允许缺级直接挂接');
  expect(CATALOG_AUTONOMOUS_PROMPT).toContain('已有子节点的分支也要查');
  expect(CATALOG_AUTONOMOUS_PROMPT).toContain('同时保留原独立树及证据');
  expect(CATALOG_AUTONOMOUS_PROMPT).toContain('名称相同或近似不能直接匹配');
  expect(CATALOG_AUTONOMOUS_PROMPT).toContain('完成前逐套核对工程划分树的分项叶子与其他独立树中的检验批');
  expect(CATALOG_AUTONOMOUS_PROMPT).toContain('不能因分类表只列到分项就认定当前树没有检验批');
  expect(CATALOG_AUTONOMOUS_PROMPT).toContain('不能仅凭编码或名称机械复制');
  expect(CATALOG_AUTONOMOUS_PROMPT).toContain('不把每页送给模型调查');
  expect(CATALOG_AUTONOMOUS_PROMPT).toContain('unresolved');
  expect(CATALOG_AUTONOMOUS_PROMPT).toContain('incomplete');
  expect(CATALOG_AUTONOMOUS_PROMPT).toContain('独立只读 Pi 覆盖审查');
  expect(CATALOG_AUTONOMOUS_PROMPT).toContain('不可从生成的 nodes 反推');
  expect(CATALOG_AUTONOMOUS_PROMPT).toContain('处理了父节点不等于处理了整行');
  expect(CATALOG_AUTONOMOUS_PROMPT).toContain('通过不代表没有漏项');
  expect(CATALOG_AUTONOMOUS_PROMPT).toContain('包括普通目录/表式集合');
  expect(CATALOG_AUTONOMOUS_PROMPT).toContain('constructionReview');
  expect(CATALOG_AUTONOMOUS_PROMPT).toContain('parentRelation');
});

test('focused repair prompt preserves the prior draft but requires a new source-backed review and seal', () => {
  const prompt = catalogAutonomousRepairPromptFor('repair-run', '修复工程分类树中的检验批归属');
  expect(prompt).toContain('修复工程分类树中的检验批归属');
  expect(prompt).toContain('已种子复制上一版 DELIVERY.json 草稿');
  expect(prompt).toContain('旧脚本、旧 Pi 会话与旧审查未承接');
  expect(prompt).toContain('不要从头重建各套结构');
  expect(prompt).toContain('无检验批后代的分项');
  expect(prompt).toContain('保留原独立树');
  expect(prompt).toContain('不能凭名称或编码机械复制');
  expect(prompt).toContain('旧批准不能复用');
  expect(prompt).toContain('validate_catalog_delivery');
  expect(prompt).toContain('seal_catalog_delivery');
});

test('loads only explicit project document skills, which Pi native read can consume', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'pi-catalog-skills-')); directories.push(workspaceRoot);
  const rogue = join(workspaceRoot, '.pi', 'skills', 'not-allowed');
  await mkdir(rogue, { recursive: true });
  await writeFile(join(rogue, 'SKILL.md'), '---\nname: not-allowed\ndescription: Must not be loaded\n---\nUntrusted workspace instructions');
  const loader = new DefaultResourceLoader({ cwd: workspaceRoot, agentDir: join(workspaceRoot, 'agent'),
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    additionalSkillPaths: CATALOG_DOCUMENT_SKILL_PATHS });
  await loader.reload();
  expect(loader.getSkills().diagnostics).toEqual([]);
  expect(loader.getSkills().skills.map((skill) => skill.name).sort()).toEqual(['document-exploration', 'mineru-reading']);
  expect(loader.getExtensions().extensions).toEqual([]);
  const controller = { dispatch: async () => ({ok:true}), result: () => ({sealed:false}),
    snapshot: () => ({checkpoint:'test',working_plan_sha256:'',history_sequence:0,last_valid_fingerprint:''}) };
  let observedSignal: AbortSignal | undefined;
  const tools = createCatalogAutonomousTools({ workspaceRoot, runId: 'test', controller,
    documentTools: { dispatch: async (name, params, signal) => { observedSignal = signal; return {ok:true,name,params}; } } });
  const read = tools.find((tool) => tool.name === 'read')!;
  const skill = loader.getSkills().skills.find((item) => item.name === 'mineru-reading')!;
  const result = await read.execute('skill-read', {path:skill.filePath} as never, undefined, undefined, {} as never);
  expect(JSON.stringify(result.content)).toContain('source/markdown/index.json');
  expect(tools.map(tool => tool.name)).not.toContain('parse_document_with_mineru');
  expect(tools.map(tool => tool.name)).not.toContain('read_word_document');
  const abort = new AbortController();
  const parsed = await tools.find((tool) => tool.name === 'list_document_sources')!
    .execute('sources', {} as never, abort.signal, undefined, {} as never);
  expect(parsed.details).toMatchObject({ok:true,params:{}});
  expect(observedSignal).toBe(abort.signal);
  // Real SDK assembly, no model request: prove descriptions reach the actual system prompt.
  const {session} = await createAgentSession({cwd:workspaceRoot,agentDir:join(workspaceRoot,'agent'),
    noTools:'builtin',tools:tools.map((tool) => tool.name),customTools:tools,resourceLoader:loader,
    sessionManager:SessionManager.inMemory(workspaceRoot)});
  try {
    expect(session.systemPrompt).toContain('mineru-reading');
    expect(session.systemPrompt).not.toContain('word-reading');
    expect(session.systemPrompt).not.toContain('not-allowed');
  } finally { session.dispose(); }
});

test('requires merging wrapped title continuation lines instead of harvesting markdown heading lines only', async () => {
  expect(CATALOG_AUTONOMOUS_PROMPT).toContain('断行标题的第一行');
  expect(CATALOG_AUTONOMOUS_PROMPT).toContain('紧邻文本行');
  expect(CATALOG_AUTONOMOUS_PROMPT).toContain('并回完整名称');
  const mineruSkill = await readFile(CATALOG_DOCUMENT_SKILL_PATHS[1]!, 'utf8');
  expect(mineruSkill).toContain('断行标题常只有第一行被标为标题');
  expect(mineruSkill).toContain('标题级别不等于标题完整性');
});

test('treats an uploaded Word source as the complete-name baseline while the PDF locates evidence pages', () => {
  expect(CATALOG_AUTONOMOUS_PROMPT).toContain('完整名称的基准清单');
  expect(CATALOG_AUTONOMOUS_PROMPT).toContain('条目名称先按 Word 标题组织');
  expect(CATALOG_AUTONOMOUS_PROMPT).toContain('用 PDF 全文搜索定位证据页');
  expect(CATALOG_AUTONOMOUS_PROMPT).toContain('用 aliases 保留另一写法');
  expect(CATALOG_AUTONOMOUS_PROMPT).toContain('不把 Word 页码伪装成原 PDF 页码');
});

test('requires a maintained plan checklist whose done marks are truthful', () => {
  expect(CATALOG_AUTONOMOUS_PROMPT).toContain('update_catalog_plan');
  expect(CATALOG_AUTONOMOUS_PROMPT).toContain('总体计划清单');
  expect(CATALOG_AUTONOMOUS_PROMPT).toContain('done 只能标记真实完成项');
  const tools = createCatalogAutonomousTools({ workspaceRoot: '.', runId: 'test', controller: {
    dispatch: async () => ({ok:true}), result: () => ({sealed:false}),
    snapshot: () => ({checkpoint:'test',working_plan_sha256:'',history_sequence:0,last_valid_fingerprint:''}) } });
  const plan = tools.find((tool) => tool.name === 'update_catalog_plan')!;
  expect(plan.label).toContain('整表更新');
});

test('provides native Pi working tools and a path-only acceptance contract, not a prescribed extraction loop', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'pi-catalog-tools-')); directories.push(workspaceRoot);
  let observedSignal: AbortSignal | undefined;
  const controller = { dispatch: async (_name: string, params: Record<string,unknown>, signal?: AbortSignal) => {
    observedSignal = signal; return {ok:true,path:params.path};
  }, result: () => ({sealed:false}), snapshot: () => ({checkpoint:'test',working_plan_sha256:'',history_sequence:0,last_valid_fingerprint:''}) };
  const tools = createCatalogAutonomousTools({workspaceRoot,runId:'test',controller});
  expect(tools.map(tool => tool.name)).toEqual(expect.arrayContaining(['read','write','edit','bash','open_catalog_page','validate_catalog_delivery','seal_catalog_delivery']));
  expect(tools.map(tool => tool.name)).not.toEqual(expect.arrayContaining(['survey_catalog_structure_pages','propose_catalog_structures']));
  const seal = tools.find(tool => tool.name === 'seal_catalog_delivery')!;
  expect(Object.keys((seal.parameters as {properties:object}).properties)).toEqual(['path']);
  expect(CATALOG_AUTONOMOUS_PROMPT).toContain('顺序、批量大小、草稿格式和解析策略均由你选择');
  // Exercise the actual wrapper used by runLiveConstrainedSession, including native tools.
  const wrapped = (await ModelSourceHandles.open(workspaceRoot)).wrapTools(tools);
  const execute = async (name: string, params: unknown) => wrapped.find(tool => tool.name === name)!.execute('test-call', params as never, undefined, undefined, {} as never);
  await execute('write', {path:'draft.txt',content:'可持久化草稿'});
  expect(await readFile(join(workspaceRoot,'draft.txt'),'utf8')).toBe('可持久化草稿');
  await execute('edit', {path:'draft.txt',edits:[{oldText:'可持久化草稿',newText:'已修订草稿'}]});
  const read = await execute('read', {path:'draft.txt'});
  expect(JSON.stringify(read.content)).toContain('已修订草稿');
  const script = await execute('bash', {command:'node -e "process.stdout.write(\'native-script-ok\')"',timeout:10});
  expect(JSON.stringify(script.content)).toContain('native-script-ok');
  const accepted = await execute('seal_catalog_delivery', {path:'delivery.json'});
  expect(accepted.details).toMatchObject({ok:true,path:'delivery.json'});
  const abort = new AbortController();
  await seal.execute('seal', {path:'delivery.json'} as never, abort.signal, undefined, {} as never);
  expect(observedSignal).toBe(abort.signal);
});
