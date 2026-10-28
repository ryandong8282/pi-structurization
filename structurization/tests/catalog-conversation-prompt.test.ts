import { expect, test } from 'vitest'
import { catalogAutonomousRevisionPromptFor } from '../src/catalog-autonomous-runtime.js'

test('correction rounds carry the human conversation while preserving source evidence and fresh review requirements', () => {
  const prompt = catalogAutonomousRevisionPromptFor('round-2', '核对刚才补的节点归属', ['补齐遗漏节点'])
  expect(prompt).toContain('核对刚才补的节点归属')
  expect(prompt).toContain('补齐遗漏节点')
  expect(prompt).toContain('用户消息是调查目标，不是来源证据')
  expect(prompt).toContain('不得把截图当作原件证据')
  expect(prompt).toContain('用户要求与原文冲突')
  expect(prompt).toContain('保留其他已经正确的内容与节点 ID')
  expect(prompt).toContain('没有继承上一版的审查批准')
  expect(prompt).toContain('validate_catalog_delivery')
  expect(prompt).toContain('seal_catalog_delivery')
  expect(prompt).not.toContain('无检验批后代的分项')
})

test('image-only correction rounds still give the agent an explicit investigation request', () => {
  const prompt = catalogAutonomousRevisionPromptFor('round-image', '')
  expect(prompt).toContain('请查看本轮附图')
  expect(prompt).toContain('依据原文调查')
})
