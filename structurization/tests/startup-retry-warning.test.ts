import { describe, expect, test } from 'vitest'

import { targetSelectorStartupPrompt } from '../src/pi-runtime.js'
import { TARGET_SELECTOR_PROTOCOLS } from '../src/acceptance-prompt-suite.js'

describe('targetSelectorStartupPrompt inherited stage-retry warning', () => {
  const base = {
    job_id: 'job-1',
    target_id: 'target:metal',
    recovering_coverage_failure: false,
    resume: true,
    current_selector_state: 'inherited_existing' as const,
  }

  test('surfaces the inherited stagnation checkpoint with the save-before-retry contract', () => {
    const prompt = targetSelectorStartupPrompt({
      ...base,
      inherited_stage_retry: {
        stage: 'table',
        best_stage_rank: 1.5,
        best_issue_count: 9,
        consecutive_non_improvements: 3,
      },
    })
    const retained = JSON.parse(prompt.match(/<retained_stage_retry>\s*([\s\S]*?)\s*<\/retained_stage_retry>/u)![1]!)
    expect(retained).toEqual({ stage: 'table', best_stage_rank: 1.5,
      best_issue_count: 9, consecutive_non_improvements: 3 })
    expect(prompt).toContain('原计数/上限不变')
    expect(TARGET_SELECTOR_PROTOCOLS.patch).toContain('及时保存已确认独立记录')
    expect(prompt).toContain('当前作者待办清空且业务判断完成后再完整检查')
  })

  test('a progressing checkpoint does not claim that its next check is already terminal', () => {
    const prompt = targetSelectorStartupPrompt({ ...base, inherited_stage_retry: {
      stage: 'table', best_stage_rank: 1.5, best_issue_count: 3, consecutive_non_improvements: 0,
    } })
    const retained = JSON.parse(prompt.match(/<retained_stage_retry>\s*([\s\S]*?)\s*<\/retained_stage_retry>/u)![1]!)
    expect(retained.consecutive_non_improvements).toBe(0)
    expect(prompt).toContain('原计数/上限不变')
    expect(prompt).not.toContain('未保存真实修复就重试阶段转换会立即终止本目标')
  })

  test('no checkpoint: prompt stays unchanged in shape (no empty retry section)', () => {
    const prompt = targetSelectorStartupPrompt({ ...base })
    expect(prompt).not.toContain('<retained_stage_retry>')
    expect(prompt).toContain('从实际持久化检查点继续整个 target')
  })
})
