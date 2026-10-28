import { expect, test, vi } from 'vitest'
const session = vi.hoisted(() => vi.fn(async (_workspace: unknown, options: any) => options))
vi.mock('../src/pi-runtime.js', () => ({ runLiveConstrainedSession: session }))
import { runTemplateAcceptanceAgent, TEMPLATE_ACCEPTANCE_PROMPT, TEMPLATE_ACCEPTANCE_TOOLS, TEMPLATE_FORM_PROMPT } from '../src/template-acceptance-runtime.js'

test('item extraction schema excludes method and condition while retaining the data-type rationale', () => {
  const schema = TEMPLATE_ACCEPTANCE_TOOLS.find(tool => tool.name === 'upsert_acceptance_item')!.parameters
  expect(schema.properties).not.toHaveProperty('check_method')
  expect(schema.properties).not.toHaveProperty('condition')
  expect(schema.properties).not.toHaveProperty('deviation_unit')
  expect(schema.properties).toHaveProperty('inspection_data_type_reason')
  expect(schema.additionalProperties).toBe(false)
  expect(JSON.stringify(schema.properties.evidence)).not.toMatch(/"method"|"condition"/)
  expect(TEMPLATE_ACCEPTANCE_PROMPT).toContain('不提取检查方法和适用条件字段')
  expect(TEMPLATE_ACCEPTANCE_PROMPT).toContain('单位直接写入 deviation_value')
})

test('Pi acceptance tools return repairable errors with actual values and writable fields, and stop on durable waits', async () => {
  const dispatch = vi.fn(async () => { throw new Error('start=0；通过条件：1..20，请 read_basis_document 修正 start。') })
  const options = await runTemplateAcceptanceAgent({ root: 'E:/acceptance-test', resume: true, prompt: '继续当前检验批',
    completed: async () => false, snapshot: () => ({ revision: 3, fingerprint: 'saved' }), appendEvent: async () => {}, dispatch }) as any
  const read = options.customTools.find((tool: any) => tool.name === 'read_basis_document')
  const receipt = await read.execute('call', { document_id: 'a', format: 'markdown', start: 0 })
  expect(receipt.details).toMatchObject({ ok: false, actual: { start: 0 }, writable_fields: expect.arrayContaining(['start', 'document_id']), error: expect.stringContaining('1..20') })
  expect(receipt.details.next).toContain('read_basis_document')
  expect(options.handoffWhen({ type: 'tool_execution_end', result: { details: { ok: true, waiting: true } } })).toBe(true)
  expect(options.handoffWhen({ type: 'tool_execution_end', result: { details: { ok: true } } })).toBe(false)
  expect(options.terminalTool).toBe('finish_acceptance_preview')
  expect(options.sourceHandles).toBe(false)
  expect(await options.durableSnapshot()).toMatchObject({ history_sequence: 3, working_plan_sha256: 'saved' })
})

test('original PDF images reach the model as images and do not inflate durable result details', async () => {
  const options = await runTemplateAcceptanceAgent({ root: 'E:/acceptance-test', resume: false, prompt: '识别',
    completed: async () => false, snapshot: () => ({ revision: 1, fingerprint: 'draft' }), appendEvent: async () => {},
    dispatch: async () => ({ ok: true, evidence_id: 'page-2', image: 'base64-png', text: '原文' }) }) as any
  const receipt = await options.customTools.find((tool: any) => tool.name === 'read_basis_document').execute('call', {})
  expect(receipt.content).toContainEqual({ type: 'image', mimeType: 'image/png', data: 'base64-png' })
  expect(receipt.details).not.toHaveProperty('image')
  expect(receipt.content[0].text).toContain('page-2')
})

test('joint form mode exposes table recognition tools, keeps long OCR calls alive and uses sample-row evidence', async () => {
  const args = { root: 'E:/acceptance-test', resume: false, prompt: '识别样表', completed: async () => false,
    snapshot: () => ({ revision: 1, fingerprint: 'draft' }), appendEvent: async () => {}, dispatch: async () => ({ ok: true }) }
  const items = await runTemplateAcceptanceAgent(args) as any
  expect(items.customTools.some((tool: any) => tool.name === 'recognize_inspection_forms')).toBe(false)
  expect(items.systemPrompt).not.toContain('相邻节点已定位表样')
  const form = await runTemplateAcceptanceAgent({ ...args, mode: 'form' }) as any
  expect(form.customTools.map((tool: any) => tool.name)).toEqual(expect.arrayContaining(['recognize_inspection_forms', 'read_inspection_form', 'select_inspection_form']))
  expect(form.toolTimeouts.recognize_inspection_forms).toBe(Infinity)
  expect(form.handoffWhen({ type: 'tool_execution_end', result: { details: { ok: true, preview_ready: true } } })).toBe(false)
  const waitingTool = form.customTools.find((tool: any) => tool.name === 'request_acceptance_input')
  expect(waitingTool.parameters.properties.evidence.minItems).toBeUndefined()
  expect(form.systemPrompt).toContain(TEMPLATE_FORM_PROMPT)
  expect(TEMPLATE_FORM_PROMPT).toContain('正文额外项目只在总结提示')
  expect(TEMPLATE_FORM_PROMPT).toContain('保留原文件布局')
  expect(TEMPLATE_FORM_PROMPT).toContain('无法确定版本或适用范围时 request_acceptance_input')
})

test('ordinary table mode locates and recognizes the PDF without item-writing tools or sampling completion requirements', async () => {
  const options = await runTemplateAcceptanceAgent({ root: 'E:/acceptance-test', resume: false, mode: 'table', prompt: '识别质量责任表',
    completed: async () => false, snapshot: () => ({ revision: 1, fingerprint: 'empty' }), appendEvent: async () => {},
    dispatch: async () => ({ ok: true }) }) as any
  const names = options.customTools.map((tool: any) => tool.name)
  expect(names).toEqual(expect.arrayContaining(['list_basis_documents', 'read_basis_document', 'recognize_inspection_forms', 'select_inspection_form', 'finish_acceptance_preview']))
  expect(names).not.toContain('upsert_acceptance_item')
  expect(names).not.toContain('remove_acceptance_item')
  expect(names).not.toContain('read_inspection_form')
  expect(options.systemPrompt).toContain('识别器生成结果后直接交付')
  expect(options.systemPrompt).toContain('不再分页读回或核对')
  const ready = { type: 'tool_execution_end', result: { details: { ok: true, preview_ready: true } } }
  expect(options.handoffWhen(ready)).toBe(true)
  expect(options.handoffWhen({ ...ready, type: 'tool_execution_start' })).toBe(false)
  expect(options.handoffWhen({ ...ready, result: { details: { ok: false, preview_ready: true } } })).toBe(false)
  expect(options.handoffWhen({ ...ready, result: { details: { ok: true } } })).toBe(false)
  expect(options.toolTimeouts.recognize_inspection_forms).toBe(Infinity)
  expect(options.systemPrompt).toContain('普通表只提取表样')
  expect(options.systemPrompt).toContain('检验批在本轮也只提取表样，保留原有验收项目')
  expect(options.systemPrompt).toContain('地方标准、地方用表及填表说明')
  expect(options.systemPrompt).toContain('国标和行业标准仅沿地方主依据的明确引用链参考')
  expect(options.systemPrompt).toContain('保留原文件布局')
  expect(options.systemPrompt).not.toContain('必须 read_acceptance_preview 逐项核对')
  expect(options.systemPrompt).not.toContain('表样和非空项目均已就绪')
  expect(options.customTools.find((tool: any) => tool.name === 'finish_acceptance_preview').description).toContain('不要求验收项目')
  expect(options.customTools.find((tool: any) => tool.name === 'request_acceptance_input').parameters.properties.evidence.minItems).toBeUndefined()
})

test('joint extraction saves every converted form row before enriching sampling through references', async () => {
  const options = await runTemplateAcceptanceAgent({ root: 'E:/acceptance-test', resume: false, mode: 'form', prompt: '从已有识别表取验收项目',
    completed: async () => false, snapshot: () => ({ revision: 1, fingerprint: 'empty' }), appendEvent: async () => {},
    dispatch: async () => ({ ok: true }) }) as any
  expect(options.systemPrompt).toContain('不重新识别每个项目')
  expect(options.systemPrompt).toContain('第一步先保存完整项目清单')
  expect(options.systemPrompt).toContain('必须先保存所有项目，不能查完一项抽样才保存下一项')
  expect(options.systemPrompt).toContain('不必到正文重新寻找或改写已有指标')
  expect(options.systemPrompt).toContain('第二步集中补充缺失字段')
  expect(options.systemPrompt).toContain('将对应 sampling 引文按 evidence 顺序用换行连接')
  expect(options.systemPrompt).toContain('不能把已有明确规则因书写格式失败而当成缺依据留空')
  expect(options.systemPrompt).toContain('同属一个章节或同属原材料不代表规则通用')
  expect(options.systemPrompt).toContain('source_clause 只摘取原文条文号，不填整句正文')
  expect(options.systemPrompt).toContain('相同适用规则读取一次后可回填多个项目')
  expect(options.systemPrompt).toContain('不能把只适用某项的数量套给其他项目')
  expect(options.systemPrompt).toContain('按已有 id 回填，保留表内名称、指标、分类、顺序及其证据')
  expect(options.systemPrompt).toContain('只有指标等字段确实缺失或明确要求“见某条／某表”时才沿引用补齐')
  expect(options.systemPrompt).toContain('交付前对照全部项目行及续表核对项目数量、名称和顺序')
  expect(options.customTools.find((tool: any) => tool.name === 'read_inspection_form').description).toContain('不重新识别')
  expect(options.customTools.find((tool: any) => tool.name === 'select_inspection_form').description).toContain('先按表内原顺序保存完整项目清单')
})

test('SDK tool cancellation reaches long-running form recognition', async () => {
  const dispatch = vi.fn(async (_name: string, _params: unknown, signal?: AbortSignal) => ({ ok: !signal?.aborted }))
  const options = await runTemplateAcceptanceAgent({ root: 'E:/acceptance-test', resume: false, mode: 'form', prompt: '识别',
    completed: async () => false, snapshot: () => ({ revision: 1, fingerprint: 'draft' }), appendEvent: async () => {}, dispatch }) as any
  const controller = new AbortController()
  const params = { document_id: 'a', start_page: 1, end_page: 1 }
  await options.customTools.find((tool: any) => tool.name === 'recognize_inspection_forms').execute('call', params, controller.signal)
  expect(dispatch).toHaveBeenCalledWith('recognize_inspection_forms', params, controller.signal)
})

test.each(['form', 'table'] as const)('%s exposes native DOCX tools and image OCR without converting Word to PDF', async mode => {
  const options = await runTemplateAcceptanceAgent({ root: 'E:/acceptance-test', resume: false, mode, prompt: '使用 Word 表样',
    completed: async () => false, snapshot: () => ({ revision: 1, fingerprint: 'draft' }), appendEvent: async () => {},
    dispatch: async () => ({ ok: true, image: 'jpeg-data', image_mime: 'image/jpeg' }) }) as any
  expect(options.customTools.map((tool: any) => tool.name)).toEqual(expect.arrayContaining(['list_word_forms', 'read_word_image', 'recognize_word_forms']))
  expect(options.toolTimeouts.recognize_word_forms).toBe(Infinity)
  const recognize = options.customTools.find((tool: any) => tool.name === 'recognize_word_forms')
  expect(recognize.description).toContain('新 Sheet')
  expect(recognize.description).toContain('自动补足')
  expect(options.systemPrompt).toContain('相邻节点已定位表样')
  expect(options.systemPrompt).toContain('附近没有匹配时')
  expect(options.systemPrompt).toContain('不能直接复用相邻节点的表样或引文')
  expect(options.systemPrompt).toContain('已有适用 DOCX 时不能要求另传 PDF')
  expect(options.systemPrompt).toContain('不转 PDF')
  expect(options.systemPrompt).toContain('旧 .doc')
  expect(options.systemPrompt).not.toContain('样表只能来自 PDF')
  const receipt = await options.customTools.find((tool: any) => tool.name === 'read_word_image').execute('call', { document_id: 'doc', image_id: 'image-1' })
  expect(receipt.content).toContainEqual({ type: 'image', data: 'jpeg-data', mimeType: 'image/jpeg' })
  expect(receipt.details).not.toHaveProperty('image_mime')
})

test('PDF quality-standard tables are valid forms and existing sources must not be requested as missing files', async () => {
  const options = await runTemplateAcceptanceAgent({ root: 'E:/acceptance-test', resume: true, mode: 'form', prompt: '使用表4.2.4',
    completed: async () => false, snapshot: () => ({ revision: 1, fingerprint: 'draft' }), appendEvent: async () => {},
    dispatch: async () => ({ ok: true }) }) as any
  expect(options.systemPrompt).toContain('质量检验标准表、允许偏差表和完整检验批验收记录表')
  expect(options.systemPrompt).toContain('不要求必须包含工程名称、实测记录、结论或签字栏')
  expect(options.systemPrompt).toContain('不能仅因它不是完整验收记录表而拒绝或要求另传样表')
  const request = options.customTools.find((tool: any) => tool.name === 'request_acceptance_input')
  expect(request.description).toContain('documents 只列实际缺少的文件')
  expect(request.description).toContain('不能要求重复上传已就绪文件')
  expect(request.description).toContain('options 不应把“上传/加入文件”伪装成已完成的选择')
})

test.each(['items', 'form'] as const)('%s uses regional sources first and follows their references to national standards', async mode => {
  const options = await runTemplateAcceptanceAgent({ root: 'E:/acceptance-test', resume: false, mode, prompt: '重新识别',
    completed: async () => false, snapshot: () => ({ revision: 1, fingerprint: 'draft' }), appendEvent: async () => {},
    dispatch: async () => ({ ok: true }) }) as any
  expect(options.systemPrompt).toContain('地方标准、地方验收用表及填表说明，将其作为主依据')
  expect(options.systemPrompt).toContain('不能只因国标命中更容易或 Markdown 已就绪')
  expect(options.systemPrompt).toContain('国标和行业标准仅沿地方主依据的明确引用链查阅')
  expect(options.systemPrompt).toContain('不得独立扩充项目')
  expect(options.systemPrompt).toContain('不自动改用国标作为主依据')
  expect(options.systemPrompt).toContain('列出的规范须逐份核对适用章节及上级一般规定')
  expect(options.systemPrompt).toContain('斜线或空白不表示免检')
})

test.each(['items', 'form'] as const)('%s completes sampling investigation within the initial autonomous run', async mode => {
  const options = await runTemplateAcceptanceAgent({ root: 'E:/acceptance-test', resume: false, mode, prompt: '识别',
    completed: async () => false, snapshot: () => ({ revision: 1, fingerprint: 'empty' }), appendEvent: async () => {},
    dispatch: async () => ({ ok: true }) }) as any
  expect(options.resume).toBe(false)
  expect(options.continueUntilTerminal).toBe(true)
  expect(options.systemPrompt).toContain('首次识别的一轮工作顺序')
  expect(options.systemPrompt).toContain('对每份被引规范主动检索“抽样”“检验数量”“检验批”“一般规定”')
  expect(options.systemPrompt).toContain('没有具体数量的通用规则也应原文保存')
  expect(options.systemPrompt).toContain('必须定位并读取对应的施工及验收章节')
  expect(options.systemPrompt).toContain('核查“分层”“逐层”“每道工序”“施工结束后”')
  expect(options.systemPrompt).toContain('不能只写“按检验批抽样”而丢掉分层条件')
  expect(options.systemPrompt).toContain('补查被引用的统一验收标准前先读取明确的引用条文')
  expect(options.systemPrompt).toContain('发现遗漏在当前轮继续工具调查和 upsert')
  expect(options.systemPrompt).toContain('不能依赖用户第二轮指出条文')
  const finish = options.customTools.find((tool: any) => tool.name === 'finish_acceptance_preview')
  expect(finish.description).toContain('read_acceptance_preview 自查后补齐遗漏')
  expect(finish.description).toContain('不能把抽样调查留待用户第二轮反馈')
})
