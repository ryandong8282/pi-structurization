import { Worker } from 'node:worker_threads';
import { sha256Json } from '../canonical.js';
import type { SourceBlock } from './contracts.js';
import type { AgenticSplitDecision } from './agentic-lot-split.js';

export interface SplitBoundaryRule {
  from: number; to: number; start_pattern: string; stop_pattern: string; reason: string;
}
export type SplitRulePhase = 'trial' | 'holdout';
export interface SplitRuleFinding { id: string; passed: boolean; reason: string }
export interface SplitRuleExperiment {
  id: string; rule: SplitBoundaryRule; candidates: AgenticSplitDecision[];
  samples: Record<SplitRulePhase, string[]>;
  holdout_mode: 'unseen' | 'remaining_full_review' | 'all_reviewed_in_trial';
  inspected: Record<SplitRulePhase, string[]>;
  findings: Record<string, SplitRuleFinding>;
  unchanged_failure_ids: string[];
  applied?: boolean;
}

/** Agent-supplied expressions are data, evaluated in a disposable worker with a deadline. */
async function matchBoundaries(heads: string[], rule: SplitBoundaryRule): Promise<Array<{ start: boolean; stop: boolean }>> {
  for (const pattern of [rule.start_pattern, rule.stop_pattern]) {
    if (typeof pattern !== 'string' || !pattern.startsWith('^') || pattern.length > 512)
      throw new Error('Boundary patterns must start with ^ and contain at most 512 characters; they match the original first line of each block.');
  }
  return new Promise((resolve, reject) => {
    const worker = new Worker(`const {parentPort,workerData}=require('node:worker_threads');
      try { const start=new RegExp(workerData.start,'u'), stop=new RegExp(workerData.stop,'u');
        parentPort.postMessage({rows:workerData.heads.map(head=>({start:start.test(head),stop:stop.test(head)}))});
      } catch(error) { parentPort.postMessage({error:String(error)}); }`,
    { eval: true, execArgv: [], workerData: { heads, start: rule.start_pattern, stop: rule.stop_pattern } });
    const timer = setTimeout(() => { void worker.terminate(); reject(new Error('Boundary rule exceeded 2 seconds; simplify the expression. No experiment was saved.')); }, 2000);
    worker.once('message', result => {
      clearTimeout(timer); void worker.terminate();
      if (result.error) reject(new Error(result.error)); else resolve(result.rows);
    });
    worker.once('error', error => { clearTimeout(timer); reject(error); });
    worker.once('exit', code => { clearTimeout(timer); if (code) reject(new Error(`Boundary worker exited: ${code}`)); });
  });
}

export function splitRuleId(sourceDigest: string, rule: SplitBoundaryRule): string {
  // Changing explanatory prose cannot erase a failed experiment or obtain fresh samples.
  return `rule-${sha256Json({ sourceDigest, from: rule.from, to: rule.to, start: rule.start_pattern, stop: rule.stop_pattern }).slice(0, 20)}`;
}

export function overlapSplitRanges(a: AgenticSplitDecision, b: AgenticSplitDecision): boolean {
  return a.ranges.some(left => b.ranges.some(right => left.from <= right.to && right.from <= left.to));
}

export async function experimentSplitRule(input: {
  sourceDigest: string; blocks: SourceBlock[]; rule: SplitBoundaryRule;
  observed: Record<string, Array<[number, number]>>; previous: SplitRuleExperiment[];
}): Promise<SplitRuleExperiment> {
  const { blocks, rule } = input;
  if (!Number.isSafeInteger(rule.from) || !Number.isSafeInteger(rule.to) || rule.from < 0 || rule.to < rule.from || rule.to >= blocks.length
    || !rule.reason?.trim()) throw new Error('Rule requires a valid inclusive from/to source range and a concrete applicability reason.');
  const id = splitRuleId(input.sourceDigest, rule);
  const old = input.previous.find(row => row.id === id);
  if (old) return old;
  const heads = blocks.slice(rule.from, rule.to + 1).map(block => block.text.split('\n', 1)[0]!.slice(0, 512));
  const matches = await matchBoundaries(heads, rule), candidates: AgenticSplitDecision[] = [];
  for (let offset = 0; offset < matches.length; offset++) {
    if (!matches[offset]!.start) continue;
    let end = offset + 1;
    while (end < matches.length && !matches[end]!.start && !matches[end]!.stop) end++;
    const from = rule.from + offset, to = rule.from + end - 1;
    candidates.push({ id: `${id}-${from}`, kind: 'lot', name: heads[offset]!.slice(0, 200), reason: rule.reason,
      ranges: [{ from, to }], evidence: [{ block: from, start: 0, end: Math.min(blocks[from]!.text.length, heads[offset]!.length) }], related_lot_ids: [] });
  }
  const failures = input.previous.flatMap(row => row.candidates.filter(candidate => row.findings[candidate.id]?.passed === false));
  const geometry = (candidate: AgenticSplitDecision) => sha256Json({ kind: candidate.kind, name: candidate.name, ranges: candidate.ranges });
  const unchangedFailures = candidates.filter(candidate => failures.some(failure => geometry(candidate) === geometry(failure))).map(row => row.id);
  const trial = candidates.filter(candidate => failures.some(failure => overlapSplitRanges(candidate, failure))).map(row => row.id);
  const add = (candidate: AgenticSplitDecision | undefined) => { if (candidate && !trial.includes(candidate.id)) trial.push(candidate.id); };
  add(candidates[0]);
  add([...candidates].sort((a, b) => (b.ranges[0]!.to - b.ranges[0]!.from) - (a.ranges[0]!.to - a.ranges[0]!.from))[0]);
  if (trial.length < 2) add(candidates[1]);
  const remaining = candidates.filter(candidate => !trial.includes(candidate.id));
  const unseen = remaining.filter(candidate => {
    const range = candidate.ranges[0]!;
    for (let block = range.from; block <= range.to; block++) if (input.observed[block]?.length) return false;
    return true;
  }).sort((a, b) => sha256Json([input.sourceDigest, a.ranges]).localeCompare(sha256Json([input.sourceDigest, b.ranges])));
  // If all remaining instances were exposed, inspect them all and explicitly avoid claiming a holdout.
  const holdout = (unseen.length ? unseen.slice(0, 2) : remaining).map(row => row.id);
  return { id, rule, candidates, samples: { trial, holdout }, inspected: { trial: [], holdout: [] }, findings: {}, unchanged_failure_ids: unchangedFailures,
    holdout_mode: !remaining.length ? 'all_reviewed_in_trial' : unseen.length ? 'unseen' : 'remaining_full_review' };
}

export function ruleSamplePieces(experiment: SplitRuleExperiment, phase: SplitRulePhase) {
  if (!['trial', 'holdout'].includes(phase)) throw new Error('phase must be trial or holdout.');
  if (phase === 'holdout' && !experiment.samples.trial.every(id => experiment.findings[id]?.passed))
    throw new Error('Trial samples must pass before opening the reserved holdout. Fix the rule after a failed trial.');
  return experiment.candidates.filter(row => experiment.samples[phase].includes(row.id)).flatMap(candidate => {
    const range = candidate.ranges[0]!;
    return Array.from({ length: range.to - range.from + 1 }, (_, offset) => ({ id: candidate.id, block: range.from + offset }));
  });
}

export function recordRuleSample(experiment: SplitRuleExperiment, phase: SplitRulePhase, findings: SplitRuleFinding[]) {
  const pieces = ruleSamplePieces(experiment, phase), ids = experiment.samples[phase];
  if (!findings.length || findings.length !== ids.length || new Set(findings.map(row => row.id)).size !== ids.length
    || findings.some(row => !ids.includes(row.id) || typeof row.passed !== 'boolean' || !row.reason?.trim()))
    throw new Error(`Supply one {id,passed,reason} for every required sample: ${ids.join(', ')}; samples cannot be removed or replaced.`);
  if (pieces.some(piece => !experiment.inspected[phase].includes(`${piece.id}/${piece.block}`)))
    throw new Error('Inspect all pages of the selected samples before recording a verdict. Use inspect_split_rule_sample with next_cursor.');
  for (const finding of findings) {
    const old = experiment.findings[finding.id];
    if (old && sha256Json(old) !== sha256Json(finding))
      throw new Error('Sample findings are immutable. Revise the actual rule; failed ranges remain mandatory regression samples.');
  }
  for (const finding of findings) experiment.findings[finding.id] = finding;
}

export function assertRuleApplicable(experiment: SplitRuleExperiment) {
  if (experiment.unchanged_failure_ids.length) throw new Error(`Previously failed boundaries are unchanged: ${experiment.unchanged_failure_ids.join(', ')}. Changing the expression spelling cannot approve identical failed output. Fix the boundaries or inspect these ranges as explicit individual exceptions with update_split_decisions.`);
  const required = [...experiment.samples.trial, ...experiment.samples.holdout];
  if (!experiment.candidates.length || !required.length || required.some(id => !experiment.findings[id]?.passed)
    || Object.values(experiment.findings).some(row => !row.passed))
    throw new Error('Rule cannot be applied: all fixed trial/holdout samples must pass and there must be no failed sample. Inspect/record the missing phase, or revise the actual rule.');
}
