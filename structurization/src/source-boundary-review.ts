import type { EvidenceRecord } from './contracts.js';

/** Physical navigation only. A page break never determines semantic continuity. */
export function sourceBoundaryNeighbors(records: readonly EvidenceRecord[], evidenceId: string) {
  const ordered = records.flatMap(record => {
    const line = /(?:^|\/)line:(\d+)(?:\/|$)/u.exec(record.locator)?.[1];
    return line ? [{ record, line: Number(line) }] : [];
  }).sort((a, b) => a.line - b.line);
  const index = ordered.findIndex(entry => entry.record.evidence_id === evidenceId);
  if (index < 0) return [];
  return [-1, 1].flatMap(direction => {
    const marker = ordered[index + direction]?.record;
    const neighbor = ordered[index + direction * 2]?.record;
    if (!marker || !neighbor || !/^\s*<!--\s*pages?[_\s][^>]*-->\s*$/iu.test(marker.text)) return [];
    return [{ evidence_id: neighbor.evidence_id, locator: neighbor.locator,
      boundary_evidence_id: marker.evidence_id, relation: direction > 0 ? 'after_page_boundary' : 'before_page_boundary',
      instruction: '这是分页两侧的来源导航，不是程序拼接结论。按该来源的访问路由读取相邻正文，判断是否为同一语句；若适用，在业务字段中按顺序绑定两段精确 span，不能只在来源附件或 reason 中保留后半段。' }];
  });
}
