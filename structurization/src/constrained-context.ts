/** Align SDK compaction with the host's current-window limit, without altering the provider model. */
export function constrainedContextSettings<T extends { contextWindow: number }>(model: T, maxTokens: number) {
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1024) throw new Error('Invalid constrained context window.');
  const contextWindow = Math.min(model.contextWindow, maxTokens);
  const reserveTokens = Math.min(65536, Math.floor(contextWindow / 3));
  return { model: { ...model, contextWindow },
    compaction: { enabled: true, reserveTokens, keepRecentTokens: Math.min(20000, Math.floor(contextWindow / 8)) },
    threshold: contextWindow - reserveTokens };
}

/** SDK compaction persists its summary in the same session; durable workfiles remain authoritative. */
export async function prepareConstrainedContext(session: {
  getContextUsage(): { tokens: number | null } | undefined;
  compact(instructions: string): Promise<{ estimatedTokensAfter?: number }>;
}, threshold: number, ready: (tokens: number) => void, log: (type: string, payload: unknown) => Promise<void>) {
  const before = session.getContextUsage()?.tokens ?? 0;
  if (before < threshold) { ready(before); return; }
  await log('pi_context_compaction_started', { tokens_before: before, threshold, counters_reset: false });
  const result = await session.compact('保留当前任务目标、原文来源路径、方法文件、候选路径、已完成验证、批准与未决问题及下一步。'
    + '来源、候选、批准和预算计数以持久化工作文件为准；不重新调查已完成工作，不清空或重建检查点。');
  const after = result.estimatedTokensAfter;
  if (!Number.isFinite(after) || after! < 0 || after! >= threshold) throw new Error(`context_compaction_insufficient: before=${before}, after=${after}, required_below=${threshold}; history and checkpoints retained.`);
  ready(after!);
  await log('pi_context_compaction_completed', { tokens_before: before, estimated_tokens_after: after, threshold, counters_reset: false });
}
