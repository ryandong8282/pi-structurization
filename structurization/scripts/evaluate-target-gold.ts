import { readFile } from 'node:fs/promises';
import { evaluateTargetGold, type TargetGold } from './target-gold.js';

const [goldPath, caseId, sourcePath, resultPath] = process.argv.slice(2);
if (!goldPath || !caseId || !sourcePath || !resultPath) {
  throw new Error('Usage: tsx evaluate-target-gold.ts <gold.json> <case-id> <source.md> <result.json>');
}
const gold = JSON.parse(await readFile(goldPath, 'utf8')) as TargetGold;
if (gold.schema_version !== 'target-gold/v1') throw new Error('Unsupported gold schema');
const selected = gold.cases.find(c => c.id === caseId);
if (!selected) throw new Error(`Unknown gold case: ${caseId}`);
const report = evaluateTargetGold(selected, await readFile(sourcePath, 'utf8'), JSON.parse(await readFile(resultPath, 'utf8')));
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.ok ? 0 : 1;
