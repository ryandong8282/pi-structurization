import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { evaluateTargetGold, type TargetGold } from '../scripts/target-gold.js';

const source = '水胶比：设计值；检验方法：实际用水量与水泥等胶凝材料的重量比。抽查10%。';
const gold: TargetGold['cases'][number] = {
  id: 'probe', source_file: 'source.md', source_sha256: createHash('sha256').update(source).digest('hex'), target_name: 'probe',
  assertions: [{ id: 'roles', source_quotes: [source], rationale: '判定值、方法和数量须在正确字段',
    match: { name_includes: '水胶比' }, fields: { requirement: [['设计值']], method: [['实际用水量']], sampling: [['10%']] } }],
};
const result = (...items: any[]) => ({ inspection_lots: [{ items }] });
describe('source-anchored target gold', () => {
  test('accepts correct roles, rejects method-as-value despite provenance carrying the answer', () => {
    const item = { name: '水胶比', requirement: '设计值', method: '实际用水量', sampling: { min_sampling: '抽查10%' } };
    expect(evaluateTargetGold(gold, source, result(item)).ok).toBe(true);
    expect(evaluateTargetGold(gold, source, result({ ...item, requirement: '实际用水量', note: source, source_quote: source })).ok).toBe(false);
  });
  test('does not assemble a passing judgment from different items or sampling explanations', () => {
    expect(evaluateTargetGold(gold, source, result(
      { name: '水胶比', requirement: '设计值' },
      { name: '水胶比', method: '实际用水量', sampling: { min_sampling: '10%' } },
    )).ok).toBe(false);
    expect(evaluateTargetGold(gold, source, result({ name: '水胶比', requirement: '设计值', method: '实际用水量', sampling: { reason: '10%', script: '10%' } })).ok).toBe(false);
  });
  test('changed source is invalid gold rather than model failure', () => {
    expect(evaluateTargetGold(gold, source + 'changed', result()).assertions[0]?.status).toBe('invalid_gold');
  });
  test('accepts alternate lossless representations without requiring exact item names', () => {
    expect(evaluateTargetGold(gold, source, result({ name: '三轴搅拌桩水胶比', requirement: '符合设计值', method: '计算实际用水量', quantity: '抽查 10 %' })).ok).toBe(true);
  });
});
