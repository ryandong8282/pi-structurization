import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWriteJson, atomicWriteText } from '../atomic.js';
import { sha256Json, sha256Text } from '../canonical.js';
import type { SourceBlock, SourceLedger } from './contracts.js';
import { buildAcceptanceSourceLedger } from './source-ledger.js';
import type { SplitPdfEvidence } from './lot-split.js';
import { experimentSplitRule, ruleSamplePieces, recordRuleSample, assertRuleApplicable,
  type SplitRuleExperiment, type SplitBoundaryRule, type SplitRulePhase, type SplitRuleFinding } from './split-rule-experiments.js';

/** Ordinals are a physical-order view; immutable block IDs and offsets are retained in exports. */
export interface AgenticSplitRange { from: number; to: number; start?: number; end?: number }
export interface AgenticSplitQuote { block: number; start: number; end: number }
export interface AgenticSplitDecision {
  id: string;
  kind: 'lot' | 'shared' | 'non_lot' | 'unresolved';
  name: string;
  reason: string;
  ranges: AgenticSplitRange[];
  evidence: AgenticSplitQuote[];
  /** Shared material explicitly names its consumers. Unresolved groups may link affected lots. */
  related_lot_ids: string[];
  /** A provisional right edge: later windows extend the same object; sealing requires closure. */
  open_end?: boolean;
}
export interface AgenticSplitLimits {
  max_tool_calls: number; max_tool_response_bytes: number; max_single_response_bytes: number;
  max_sessions: number; max_context_tokens: number;
}
export const DEFAULT_AGENTIC_SPLIT_LIMITS: AgenticSplitLimits = {
  max_tool_calls: 1000, max_tool_response_bytes: 1048576, max_single_response_bytes: 131072,
  max_sessions: 12, max_context_tokens: 230000,
};
interface SplitState {
  schema_version: 'agentic-lot-split/v3'; source_digest: string; pdf_digest: string | null;
  limits: AgenticSplitLimits; tool_calls: number; tool_response_bytes: number; sessions: number;
  revision: number; sealed: boolean; decisions: AgenticSplitDecision[];
  surveyed: number[]; observed: Record<string, Array<[number, number]>>;
  inspections: Record<string, { digest: string; pieces: number[] }>;
  reviews: Record<string, { digest: string; reason: string }>;
  strategy?: 'rule-assisted';
  rule_experiments?: SplitRuleExperiment[];
  program_surveyed?: number[];
}
const DISCOVERY_WINDOW_BLOCKS = 50;
interface Piece { block: number; start: number; end: number }
interface SplitIssue { code: string; actual: unknown; condition: string; next_tool: string }

/** Only transport/page ordering is automatic. No title, code, count or business-boundary heuristics. */
function physicalOrder(source: SourceLedger): SourceBlock[] {
  const chunks: Array<{ page: number; order: number; blocks: SourceBlock[] }> = [];
  for (const block of source.blocks) {
    const marker = block.text.match(/^<!--\s*pages_(\d+)_(\d+)\s*-->$/u);
    if (marker || !chunks.length) chunks.push({ page: Number(marker?.[1] ?? 0), order: chunks.length, blocks: [] });
    chunks.at(-1)!.blocks.push(block);
  }
  return chunks.sort((a, b) => a.page - b.page || a.order - b.order).flatMap(chunk => chunk.blocks);
}
const integer = (value: number, min: number, max: number, field: string) => {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${field}: actual=${value}; expected integer ${min}..${max}`);
  return value;
};

export class AgenticLotSplitController {
  readonly source: SourceLedger;
  readonly blocks: SourceBlock[];
  private pending: Promise<unknown> = Promise.resolve();
  private constructor(readonly root: string, markdown: string, private readonly state: SplitState,
    private readonly pdf?: SplitPdfEvidence) {
    this.source = buildAcceptanceSourceLedger(markdown);
    this.blocks = physicalOrder(this.source);
  }

  static async open(input: { root: string; markdown: string; resume?: boolean; limits?: AgenticSplitLimits; pdf?: SplitPdfEvidence; strategy?: 'rule-assisted' }) {
    const source = buildAcceptanceSourceLedger(input.markdown), digest = sha256Json(source);
    if (!source.blocks.length) throw new Error('Empty source: supply a document with readable source blocks.');
    const pdfDigest = input.pdf ? sha256Json(input.pdf) : null;
    let state: SplitState;
    if (input.resume) {
      state = JSON.parse(await readFile(join(input.root, 'checkpoint.json'), 'utf8')) as SplitState;
      if (state.schema_version !== 'agentic-lot-split/v3' || state.source_digest !== digest || state.pdf_digest !== pdfDigest)
        throw new Error('Frozen source, PDF evidence or split contract changed; resume requires the same inputs and contract. Older runs remain preserved.');
      if (input.limits && sha256Json(state.limits) !== sha256Json(input.limits))
        throw new Error('Resume cannot change limits or reset counters; use the persisted limits.');
      state.inspections ??= {}; state.reviews ??= {};
    } else {
      const limits = { ...DEFAULT_AGENTIC_SPLIT_LIMITS, ...input.limits };
      for (const [key, value] of Object.entries(limits)) integer(value, 1, Number.MAX_SAFE_INTEGER, key);
      await mkdir(input.root); // Exclusive new workspace, never initialize inside an existing business run.
      state = { schema_version: 'agentic-lot-split/v3', source_digest: digest, pdf_digest: pdfDigest,
        limits, tool_calls: 0, tool_response_bytes: 0, sessions: 0, revision: 0, sealed: false,
        decisions: [], surveyed: [], observed: {}, inspections: {}, reviews: {} };
      if (input.strategy === 'rule-assisted') Object.assign(state, { strategy: input.strategy, rule_experiments: [], program_surveyed: [] });
      await atomicWriteText(join(input.root, 'source.md'), input.markdown);
      await atomicWriteJson(join(input.root, 'source.json'), source);
      if (input.pdf) await atomicWriteJson(join(input.root, 'pdf-evidence.json'), input.pdf);
      await atomicWriteJson(join(input.root, 'checkpoint.json'), state);
    }
    const controller = new AgenticLotSplitController(input.root, input.markdown, state, input.pdf);
    await controller.assertSource();
    if (input.resume && !state.sealed && state.decisions.length) await controller.export(controller.audit(), true);
    return controller;
  }
  private save() { return atomicWriteJson(join(this.root, 'checkpoint.json'), this.state); }
  async assertSource() {
    if (sha256Text(await readFile(join(this.root, 'source.md'), 'utf8')) !== this.source.sha256
      || sha256Json(JSON.parse(await readFile(join(this.root, 'source.json'), 'utf8'))) !== this.state.source_digest
      || (this.pdf && sha256Json(JSON.parse(await readFile(join(this.root, 'pdf-evidence.json'), 'utf8'))) !== this.state.pdf_digest))
      throw new Error('Frozen source changed; restore it outside the agent. Source files and checkpoints are not author-writable.');
  }
  limits() { return { ...this.state.limits }; }
  ruleAssisted() { return this.state.strategy === 'rule-assisted'; }
  completed() { return this.state.sealed; }
  snapshot() { return { checkpoint: join(this.root, 'checkpoint.json'), working_plan_sha256: sha256Json(this.state.decisions),
    history_sequence: this.state.revision, last_valid_fingerprint: this.state.sealed ? sha256Json(this.state.decisions) : '' }; }
  async startSession() {
    if (this.state.sessions >= this.state.limits.max_sessions) throw new Error('Split session budget exhausted; checkpoint and counters preserved.');
    this.state.sessions++;
    await this.save();
  }
  private block(index: number) { return this.blocks[integer(index, 0, this.blocks.length - 1, 'block')]!; }
  private observe(block: number, start: number, end: number) {
    const rows = [...(this.state.observed[block] ?? []), [start, end] as [number, number]].sort((a, b) => a[0] - b[0]);
    const merged: Array<[number, number]> = [];
    for (const row of rows) { const last = merged.at(-1); if (last && row[0] <= last[1]) last[1] = Math.max(last[1], row[1]); else merged.push([...row]); }
    this.state.observed[block] = merged;
  }
  private seen(block: number, start: number, end: number) {
    return (this.state.observed[block] ?? []).some(row => row[0] <= start && row[1] >= end);
  }
  /** Source exploration cannot outrun durable, self-reviewed ownership by more than one window. */
  private progress() {
    const owned = new Map<number, Piece[]>();
    for (const decision of this.state.decisions) {
      if (this.state.reviews[decision.id]?.digest !== sha256Json(decision)) continue;
      for (const piece of this.pieces(decision)) {
        const rows = owned.get(piece.block) ?? []; rows.push(piece); owned.set(piece.block, rows);
      }
    }
    let frontier = 0;
    for (; frontier < this.blocks.length; frontier++) {
      if (!this.surveyed(frontier)) break;
      const rows = (owned.get(frontier) ?? []).sort((a, b) => a.start - b.start);
      let end = 0;
      for (const row of rows) { if (row.start !== end) break; end = row.end; }
      if (end !== this.block(frontier).text.length) break;
    }
    return { committed_blocks: frontier, window_blocks: DISCOVERY_WINDOW_BLOCKS,
      readable_to: this.ruleAssisted() ? this.blocks.length - 1 : Math.min(frontier + DISCOVERY_WINDOW_BLOCKS, this.blocks.length) - 1,
      open_decisions: this.state.decisions.filter(row => row.open_end).map(row => row.id) };
  }
  private surveyed(index: number) { return this.state.surveyed.includes(index) || Boolean(this.state.program_surveyed?.includes(index)); }
  private assertReadable(index: number) {
    this.block(index);
    const progress = this.progress();
    if (index > progress.readable_to) throw new Error(`Commit current window before reading ahead: actual block=${index}, readable_to=${progress.readable_to}, first_pending=${progress.committed_blocks}. Use update_split_decisions with ranges and reviews for the read material. Keep an unfinished object's open_end=true and extend that SAME id later; do not invent a business boundary at the window edge.`);
  }
  private preview(index: number) {
    const block = this.block(index), front = Math.min(96, block.text.length), tail = Math.max(front, block.text.length - 32);
    this.observe(index, 0, front); this.observe(index, tail, block.text.length);
    if (!this.state.surveyed.includes(index)) this.state.surveyed.push(index);
    return [index, block.kind, block.text.length, block.text.slice(0, front), block.text.slice(tail)];
  }
  private expand(range: AgenticSplitRange): Piece[] {
    integer(range.from, 0, this.blocks.length - 1, 'ranges.from'); integer(range.to, range.from, this.blocks.length - 1, 'ranges.to');
    const result: Piece[] = [];
    for (let block = range.from; block <= range.to; block++) {
      const length = this.block(block).text.length;
      const start = block === range.from ? range.start ?? 0 : 0;
      const end = block === range.to ? range.end ?? length : length;
      integer(start, 0, length - 1, 'ranges.start'); integer(end, start + 1, length, 'ranges.end');
      result.push({ block, start, end });
    }
    return result;
  }
  private pieces(decision: AgenticSplitDecision) { return decision.ranges.flatMap(range => this.expand(range)); }
  private quote(quote: AgenticSplitQuote) {
    const block = this.block(quote.block);
    integer(quote.start, 0, block.text.length - 1, 'evidence.start'); integer(quote.end, quote.start + 1, block.text.length, 'evidence.end');
    return { source_id: this.source.source_id, block_id: block.id, start: quote.start, end: quote.end, text: block.text.slice(quote.start, quote.end) };
  }
  private checkDecision(decision: AgenticSplitDecision) {
    if (!/^[a-zA-Z0-9_-]{1,80}$/u.test(decision.id) || !['lot', 'shared', 'non_lot', 'unresolved'].includes(decision.kind)
      || !decision.name?.trim() || !decision.reason?.trim() || !decision.ranges?.length || !decision.evidence?.length
      || !Array.isArray(decision.related_lot_ids)) throw new Error('Decision requires id, kind, name, reason, nonempty ranges/evidence and related_lot_ids.');
    for (const quote of decision.evidence) {
      this.quote(quote);
      if (!this.seen(quote.block, quote.start, quote.end)) throw new Error(`Evidence not read: ${JSON.stringify(quote)}; read_split_source must expose the exact interval before citing it.`);
    }
    for (const range of decision.ranges) {
      const pieces = this.expand(range), first = pieces[0]!, last = pieces.at(-1)!;
      for (const [p, isFirst] of [[first, true], [last, false]] as const) {
        const start = isFirst ? p.start : Math.max(p.start, p.end - 20);
        const end = isFirst ? Math.min(p.end, p.start + 20) : p.end;
        if (!this.seen(p.block, start, end)) throw new Error(`Boundary not read: block=${p.block}, start=${start}, end=${end}; inspect it with read_split_source before deciding.`);
      }
    }
    if (decision.open_end !== undefined && typeof decision.open_end !== 'boolean') throw new Error('open_end must be a boolean.');
    for (const piece of this.pieces(decision)) if (!this.surveyed(piece.block))
      throw new Error(`Source block not surveyed: block=${piece.block}; scan_split_source within the current window before assigning it.`);
  }
  private audit(decisions = this.state.decisions) {
    const issues: SplitIssue[] = [], owners = new Map<number, Array<Piece & { owner: string }>>();
    for (const decision of decisions) for (const piece of this.pieces(decision)) {
      const rows = owners.get(piece.block) ?? []; rows.push({ ...piece, owner: decision.id }); owners.set(piece.block, rows);
    }
    for (let block = 0; block < this.blocks.length; block++) {
      const rows = (owners.get(block) ?? []).sort((a, b) => a.start - b.start);
      let end = 0;
      for (const row of rows) {
        if (row.start !== end) issues.push({ code: row.start < end ? 'overlap' : 'gap', actual: { expected_start: end, ...row },
          condition: 'Every source character must have exactly one owner; shared material is owned once and linked.', next_tool: 'update_split_decisions' });
        end = Math.max(end, row.end);
      }
      if (end < this.block(block).text.length) issues.push({ code: 'gap', actual: { block, start: end, end: this.block(block).text.length },
        condition: 'Assign this source interval to a lot, shared material, non_lot or a concrete unresolved boundary.', next_tool: 'update_split_decisions' });
      if (!this.surveyed(block)) issues.push({ code: 'not_surveyed', actual: { block },
        condition: 'Survey every source block, including prose and tables without conventional headings.', next_tool: 'scan_split_source' });
    }
    for (const decision of decisions) for (const related of decision.related_lot_ids) {
      if (!decisions.some(row => row.id === related && row.kind === 'lot')) issues.push({ code: 'invalid_related_lot', actual: { id: decision.id, related },
        condition: 'related_lot_ids must refer to existing lot decisions; revise or remove the invalid relationship.', next_tool: 'update_split_decisions' });
    }
    for (const decision of decisions) if (decision.open_end) issues.push({ code: 'open_boundary', actual: { id: decision.id },
      condition: 'Resolve the provisional right edge using the following source, extend or revise the same decision, then set open_end=false and review it again.', next_tool: 'update_split_decisions' });
    for (const decision of decisions) if (this.state.reviews[decision.id]?.digest !== sha256Json(decision)) issues.push({
      code: 'boundary_review_required', actual: { id: decision.id, kind: decision.kind, ranges: decision.ranges },
      condition: 'Inspect the full internal structure and record an agent boundary review for this exact decision; fix swallowed independent objects, shared scope or unrelated material first.',
      next_tool: 'inspect_split_decision' });
    return { passed: issues.length === 0, issue_count: issues.length, issues, source_blocks: this.blocks.length,
      lots: decisions.filter(row => row.kind === 'lot').length, unresolved_groups: decisions.filter(row => row.kind === 'unresolved').length };
  }
  private workspace() {
    return { source_id: this.source.source_id, source_blocks: this.blocks.length, surveyed_blocks: this.state.surveyed.length,
      first_unsurveyed: this.blocks.findIndex((_, index) => !this.state.surveyed.includes(index)),
      progress: this.progress(), decisions: this.state.decisions.length, revision: this.state.revision, sealed: this.state.sealed,
      pdf_pages: this.pdf?.pages.length ?? 0, limits: this.state.limits,
      usage: { tool_calls: this.state.tool_calls, tool_response_bytes: this.state.tool_response_bytes, sessions: this.state.sessions },
      discovery_strategy: this.state.strategy ?? 'agentic-windowed', program_surveyed_blocks: this.state.program_surveyed?.length ?? 0,
      rule_experiments: this.state.rule_experiments?.map(row => this.ruleSummary(row)) ?? [],
      coordinates: 'block/from/to are zero-based physical-order ordinals; to is inclusive. start/end are block-local UTF-16 [start,end). Omitted start=0/end=last block length.',
      writable: 'Only update_split_decisions can edit decisions. Source, checkpoint, budgets and sealed exports are host-owned.',
      next_tool: 'scan_split_source' };
  }
  private ruleSummary(row: SplitRuleExperiment) {
    return { id: row.id, matched_candidates: row.candidates.length,
      matched_blocks: row.candidates.reduce((sum, item) => sum + this.pieces(item).length, 0),
      samples: row.samples, holdout_mode: row.holdout_mode, findings: Object.values(row.findings), applied: Boolean(row.applied),
      unchanged_failure_ids: row.unchanged_failure_ids,
      note: 'Matches are provisional. Sampled rule checks are not individual semantic approval or field extraction.' };
  }
  private ruleExperiment(id: unknown) {
    if (!this.ruleAssisted()) throw new Error('This checkpoint uses windowed discovery; keep its original strategy. Rule experiments are enabled for new rule-assisted runs.');
    const row = this.state.rule_experiments?.find(item => item.id === id);
    if (!row) throw new Error(`Unknown experiment ${id}; use propose_split_rule or split_workspace.`);
    return row;
  }
  private sourceExcerpt(args: Record<string, unknown>) {
    const index = Number(args.block); this.assertReadable(index);
    const block = this.block(index);
    const start = integer(Number(args.start ?? 0), 0, block.text.length - 1, 'start');
    const end = Math.min(block.text.length, start + integer(Number(args.length ?? 6000), 1, 16000, 'length'));
    return { block: index, start, end, text: block.text.slice(start, end), length: block.text.length,
      next_start: end < block.text.length ? end : null };
  }
  private async execute(name: string, args: Record<string, unknown>) {
    const cursor = () => integer(Number(args.cursor ?? 0), 0, Number.MAX_SAFE_INTEGER, 'cursor');
    const limit = () => integer(Number(args.limit ?? 25), 1, 50, 'limit');
    switch (name) {
      case 'split_workspace': return this.workspace();
      case 'scan_split_source': {
        const start = Number(args.cursor ?? this.blocks.findIndex((_, index) => !this.surveyed(index)));
        if (start === -1 || start === this.blocks.length) return { rows: [], next_cursor: null, progress: this.progress() };
        this.assertReadable(start);
        if (args.unassigned_only === true && this.ruleAssisted()) {
          const covered = new Map<number, number>();
          for (const decision of this.state.decisions) for (const piece of this.pieces(decision))
            covered.set(piece.block, (covered.get(piece.block) ?? 0) + piece.end - piece.start);
          const remaining = this.blocks.map((_, index) => index).filter(index => index >= start && covered.get(index) !== this.block(index).text.length);
          const selected = remaining.slice(0, limit());
          return { columns: ['block', 'kind', 'length', 'head', 'tail'], rows: selected.map(index => this.preview(index)),
            next_cursor: remaining.length > selected.length ? selected.at(-1)! + 1 : null, remaining_blocks: remaining.length, progress: this.progress() };
        }
        const end = Math.min(start + limit(), this.progress().readable_to + 1);
        return { columns: ['block', 'kind', 'length', 'head', 'tail'],
          rows: this.blocks.slice(start, end).map((_, offset) => this.preview(start + offset)),
          next_cursor: end < this.blocks.length ? end : null, progress: this.progress() };
      }
      case 'search_split_source': {
        const query = String(args.query ?? ''); if (!query.trim()) throw new Error('query must be nonempty literal text.');
        const hits = this.blocks.flatMap((block, index) => { const offset = block.text.indexOf(query); return offset < 0 ? [] : [{ index, offset }]; });
        const start = cursor(), selected = hits.slice(start, start + limit());
        return { total: hits.length, rows: selected.map(hit => ({ block: hit.index, match_start: hit.offset })), next_cursor: start + selected.length < hits.length ? start + selected.length : null, note: 'Locations only; read source within the current window. Search does not mark blocks surveyed or evidence read.' };
      }
      case 'read_split_source': {
        const row = this.sourceExcerpt(args);
        this.observe(row.block, row.start, row.end);
        return { ...row, ...this.quote(row) };
      }
      case 'read_split_sources': {
        const requests = args.requests as Array<Record<string, unknown>>;
        if (!Array.isArray(requests) || requests.length < 1 || requests.length > 20)
          throw new Error('requests must contain 1..20 {block,start?,length?} source intervals in the readable window.');
        // Validate the complete batch before exposing or marking any interval read.
        const rows = requests.map(request => this.sourceExcerpt(request));
        for (const row of rows) this.observe(row.block, row.start, row.end);
        return { source_id: this.source.source_id, rows };
      }
      case 'read_split_pdf': {
        const page = this.pdf?.pages.find(row => row.page === Number(args.page));
        if (!page) throw new Error(`PDF page ${args.page} unavailable; registered text pages=${this.pdf?.pages.length ?? 0}. Use source text or retain the specific unresolved issue.`);
        const start = cursor(), rows = page.lines.slice(start, start + limit());
        return { page: page.page, pdf_sha256: this.pdf!.sha256, width: page.width, height: page.height, coordinate_unit: 'PDF_points',
          lines: rows, next_cursor: start + rows.length < page.lines.length ? start + rows.length : null };
      }
      case 'list_split_decisions': {
        const start = cursor(), rows = this.state.decisions.slice(start, start + limit());
        return { revision: this.state.revision, rows, next_cursor: start + rows.length < this.state.decisions.length ? start + rows.length : null };
      }
      case 'propose_split_rule': {
        if (!this.ruleAssisted() || this.state.sealed) throw new Error('Rules require an unsealed rule-assisted checkpoint.');
        const row = await experimentSplitRule({ sourceDigest: this.state.source_digest, blocks: this.blocks,
          rule: args.rule as SplitBoundaryRule, observed: this.state.observed, previous: this.state.rule_experiments! });
        if (!this.state.rule_experiments!.some(old => old.id === row.id)) this.state.rule_experiments!.push(row);
        return { ...this.ruleSummary(row), next_tool: 'inspect_split_rule_sample' };
      }
      case 'inspect_split_rule_sample': {
        const row = this.ruleExperiment(args.experiment_id), phase = args.phase as SplitRulePhase;
        if (phase === 'holdout' && !row.inspected.holdout.length && row.holdout_mode === 'unseen') {
          const contaminated = row.candidates.filter(candidate => row.samples.holdout.includes(candidate.id))
            .some(candidate => this.pieces(candidate).some(piece => this.state.observed[piece.block]?.length));
          if (contaminated) {
            row.holdout_mode = 'remaining_full_review';
            row.samples.holdout = row.candidates.filter(candidate => !row.samples.trial.includes(candidate.id)).map(candidate => candidate.id);
          }
        }
        const pieces = ruleSamplePieces(row, phase), start = cursor(), selected = pieces.slice(start, start + limit());
        const rows = selected.map(piece => {
          const key = `${piece.id}/${piece.block}`;
          if (!row.inspected[phase].includes(key)) row.inspected[phase].push(key);
          return [piece.id, ...this.preview(piece.block)];
        });
        return { experiment_id: row.id, phase, holdout_mode: row.holdout_mode, sample_ids: row.samples[phase],
          columns: ['candidate_id', 'block', 'kind', 'length', 'head', 'tail'], rows,
          inspected_pieces: row.inspected[phase].length, total_pieces: pieces.length,
          next_cursor: start + rows.length < pieces.length ? start + rows.length : null,
          review_question: 'Check actual business boundaries, internal parallel objects, continuation and shared requirements. Read truncated or ambiguous blocks with read_split_sources. Give a verdict for EVERY fixed sample; revise the rule after failure.' };
      }
      case 'record_split_rule_sample': {
        const row = this.ruleExperiment(args.experiment_id);
        if (this.state.sealed || row.applied) throw new Error('Applied or sealed experiment findings are immutable.');
        recordRuleSample(row, args.phase as SplitRulePhase, args.findings as SplitRuleFinding[]);
        return this.ruleSummary(row);
      }
      case 'apply_split_rule': {
        const row = this.ruleExperiment(args.experiment_id);
        if (this.state.sealed) throw new Error('Sealed decisions cannot be changed.');
        if (row.applied) return { ...this.ruleSummary(row), revision: this.state.revision, unchanged: true };
        if (args.revision !== this.state.revision) throw new Error(`Stale revision: actual=${args.revision}, expected=${this.state.revision}; use split_workspace.`);
        assertRuleApplicable(row);
        const next = [...this.state.decisions, ...row.candidates];
        if (new Set(next.map(item => item.id)).size !== next.length || this.audit(next).issues.some(issue => issue.code === 'overlap'))
          throw new Error('Rule conflicts with existing ownership. Keep the old decisions; revise the rule scope or explicitly revise affected decisions before applying.');
        this.state.decisions = next; this.state.revision++; row.applied = true;
        const programmed = new Set(this.state.program_surveyed);
        for (const candidate of row.candidates) {
          for (const piece of this.pieces(candidate)) programmed.add(piece.block);
          this.state.reviews[candidate.id] = { digest: sha256Json(candidate),
            reason: `Sampled rule boundary check ${row.id}; holdout=${row.holdout_mode}; individual field semantics still require extraction/review.` };
        }
        this.state.program_surveyed = [...programmed].sort((a, b) => a - b);
        return { ...this.ruleSummary(row), revision: this.state.revision, progress: this.progress(), next_tool: 'scan_split_source',
          next_arguments: { cursor: 0, unassigned_only: true }, note: 'Unmatched/shared/exception ranges remain unassigned. Process them explicitly; application does not seal the document.' };
      }
      case 'inspect_split_decision': {
        const decision = this.state.decisions.find(row => row.id === args.id);
        if (!decision) throw new Error(`Unknown decision id=${args.id}; list_split_decisions to select an existing id.`);
        const pieces = this.pieces(decision), start = cursor(), end = Math.min(pieces.length, start + limit());
        const digest = sha256Json(decision);
        const inspection = this.state.inspections[decision.id]?.digest === digest ? this.state.inspections[decision.id]! : { digest, pieces: [] };
        const rows = pieces.slice(start, end).map((piece, offset) => {
          if (!inspection.pieces.includes(start + offset)) inspection.pieces.push(start + offset);
          const block = this.block(piece.block), text = block.text.slice(piece.start, piece.end);
          return { ...piece, kind: block.kind, text: text.slice(0, 160), tail: text.length > 160 ? text.slice(-80) : '', truncated: text.length > 240 };
        });
        this.state.inspections[decision.id] = inspection;
        return { decision, rows, next_cursor: end < pieces.length ? end : null, inspected_pieces: inspection.pieces.length, total_pieces: pieces.length,
          review_question: 'Does this range contain parallel independent business objects, hide an object as non_lot, or share unrelated material? Read ambiguous interiors. Keep main/general items of ONE object together; split different objects. Record a concrete reason after all pieces are inspected.' };
      }
      case 'record_split_boundary_review': {
        if (this.state.sealed) throw new Error('This split is sealed; boundary reviews are immutable.');
        const id = String(args.id), decision = this.state.decisions.find(row => row.id === id);
        if (!decision) throw new Error(`Unknown decision id=${id}; list_split_decisions first.`);
        const digest = sha256Json(decision), inspection = this.state.inspections[id];
        const total = this.pieces(decision).length;
        if (inspection?.digest !== digest || inspection.pieces.length !== total) throw new Error(
          `Incomplete boundary inspection: id=${id}, inspected=${inspection?.pieces.length ?? 0}, expected=${total}; inspect_split_decision must cover every piece of the current decision.`);
        if (typeof args.reason !== 'string' || !args.reason.trim()) throw new Error('reason must explain the actual business boundary and shared/non-lot disposition; generic completion is not evidence.');
        this.state.reviews[id] = { digest, reason: args.reason };
        return { reviewed: id, digest, independent_review: false, progress: this.progress() };
      }
      case 'update_split_decisions': {
        if (this.state.sealed) throw new Error('This split is sealed; author cannot mutate its decisions.');
        if (args.revision !== this.state.revision) throw new Error(`Stale revision: actual=${args.revision}, expected=${this.state.revision}; list_split_decisions before editing.`);
        const upsert = structuredClone(args.upsert) as AgenticSplitDecision[], remove = args.remove as string[];
        if (!Array.isArray(upsert) || !Array.isArray(remove) || upsert.length > 50) throw new Error('upsert/remove must be arrays; upsert at most 50 decisions per call.');
        if (new Set(upsert.map(row => row.id)).size !== upsert.length) throw new Error('Duplicate upsert IDs; one decision per id.');
        for (const decision of upsert) this.checkDecision(decision);
        const removed = new Set([...remove, ...upsert.map(row => row.id)]);
        const next = [...this.state.decisions.filter(row => !removed.has(row.id)), ...upsert];
        const overlaps = this.audit(next).issues.filter(row => row.code === 'overlap');
        if (overlaps.length) throw new Error(`Overlapping ownership: ${JSON.stringify(overlaps.slice(0, 5))}; remove/replace all affected decisions atomically; proposal was not saved.`);
        // Batch self-review uses the exact source previews already delivered in this window.
        // The model must provide a separate boundary judgment; the host never supplies that judgment.
        const reviews = (args.reviews ?? []) as Array<{ id: string; reason: string }>;
        if (!Array.isArray(reviews) || reviews.length > 50 || new Set(reviews.map(row => row.id)).size !== reviews.length)
          throw new Error('reviews must contain at most 50 unique {id, reason} entries.');
        const checked = reviews.map(review => {
          const decision = next.find(row => row.id === review.id);
          if (!decision || typeof review.reason !== 'string' || !review.reason.trim())
            throw new Error(`Invalid review id=${review.id}; provide an existing decision and a concrete boundary self-review reason.`);
          this.checkDecision(decision);
          return { id: review.id, digest: sha256Json(decision), reason: review.reason };
        });
        this.state.decisions = next; this.state.revision++;
        for (const id of removed) { delete this.state.inspections[id]; delete this.state.reviews[id]; }
        for (const review of checked) this.state.reviews[review.id] = { digest: review.digest, reason: review.reason };
        return { revision: this.state.revision, saved: upsert.map(row => row.id), removed: remove, decisions: next.length,
          reviewed: checked.map(row => row.id), progress: this.progress(), partial_export: 'partial/manifest.json' };
      }
      case 'validate_lot_split': {
        const audit = this.audit(), start = cursor();
        return { ...audit, issues: audit.issues.slice(start, start + limit()), next_cursor: start + limit() < audit.issues.length ? start + limit() : null };
      }
      case 'seal_lot_split': {
        const unresolved = this.state.decisions.filter(row => row.kind === 'unresolved');
        if (this.ruleAssisted() && unresolved.length) return { ok: false, sealed: false,
          error: 'Rule-assisted splitting still has unresolved source ranges; they cannot be handed off as complete discovery.',
          actual: unresolved.map(({ id, name, ranges, reason }) => ({ id, name, ranges, reason })),
          condition: 'Resolve every pending range into justified lot/shared/non_lot ownership before sealing. Insufficient exploration is pending work, not a resolved boundary conflict.',
          writable: 'decisions via update_split_decisions; keep existing rule experiments, source, counters and limits',
          next_tool: 'inspect_split_decision' };
        const audit = this.audit();
        if (!audit.passed) return { ok: false, ...audit, issues: audit.issues.slice(0, 10), next_tool: 'validate_lot_split', writable: 'decisions via update_split_decisions' };
        await this.export(audit);
        this.state.sealed = true;
        return { sealed: true, lots: audit.lots, unresolved_groups: audit.unresolved_groups, manifest: 'manifest.json', inputs: 'lot-inputs.jsonl' };
      }
      default: throw new Error(`Unknown split tool ${name}`);
    }
  }
  /** A single serialized dispatcher owns edits, receipts, budgets and persistence, including rejected calls. */
  dispatch(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const task = this.pending.then(() => this.dispatchSerial(name, args));
    this.pending = task.catch(() => {});
    return task;
  }
  private async dispatchSerial(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const limits = this.state.limits;
    if (this.state.tool_calls >= limits.max_tool_calls || this.state.tool_response_bytes >= limits.max_tool_response_bytes)
      return { ok: false, terminal: true, error: 'Split tool budget exhausted; checkpoint and counters retained.', actual: this.workspace().usage, condition: limits, writable: 'none; resume retains these limits' };
    this.state.tool_calls++;
    const revisionBefore = this.state.revision, reviewsBefore = sha256Json(this.state.reviews);
    let result: Record<string, unknown>;
    const observedBefore = structuredClone(this.state.observed), surveyedBefore = [...this.state.surveyed];
    const inspectionsBefore = structuredClone(this.state.inspections);
    const experimentsBefore = structuredClone(this.state.rule_experiments);
    try { await this.assertSource(); result = { ok: true, ...await this.execute(name, args) }; }
    catch (error) { result = { ok: false, error: String(error), terminal: String(error).includes('Frozen source changed'),
      actual: name === 'update_split_decisions' ? { revision: args.revision, remove: args.remove,
        upsert_ids: Array.isArray(args.upsert) ? args.upsert.map(row => row?.id) : args.upsert } : args,
      writable: 'tool arguments and decisions via update_split_decisions only',
      condition: 'Use valid, read source coordinates, disjoint ownership and the current revision; source/checkpoint/budgets are read-only.', next_tool: 'split_workspace' }; }
    let bytes = Buffer.byteLength(JSON.stringify(result), 'utf8');
    if (bytes > limits.max_single_response_bytes || this.state.tool_response_bytes + bytes > limits.max_tool_response_bytes) {
      this.state.observed = observedBefore; this.state.surveyed = surveyedBefore;
      this.state.inspections = inspectionsBefore;
      if (name === 'inspect_split_rule_sample' && experimentsBefore) this.state.rule_experiments = experimentsBefore;
      result = { ok: false, terminal: this.state.tool_response_bytes + bytes > limits.max_tool_response_bytes,
        error: 'Split response exceeds remaining budget; oversized content was not delivered or marked read.', actual_bytes: bytes,
        remaining_bytes: limits.max_tool_response_bytes - this.state.tool_response_bytes,
        single_limit: limits.max_single_response_bytes, writable: 'reduce limit/length; existing decision edits remain saved', next_tool: name };
      bytes = Buffer.byteLength(JSON.stringify(result), 'utf8');
    }
    this.state.tool_response_bytes += bytes;
    await this.save();
    // Checkpoint is authoritative. Rebuildable partial exports are written before acknowledging every accepted mutation.
    if (this.state.revision !== revisionBefore || sha256Json(this.state.reviews) !== reviewsBefore) await this.export(this.audit(), true);
    return result;
  }
  private raw(decision: AgenticSplitDecision) {
    return this.pieces(decision).sort((a, b) => a.block - b.block || a.start - b.start).map(piece => {
      const block = this.block(piece.block);
      return { ...this.quote({ block: piece.block, start: piece.start, end: piece.end }), block: piece.block,
        start_line: block.start_line + block.text.slice(0, piece.start).split('\n').length - 1,
        end_line: block.start_line + block.text.slice(0, piece.end).split('\n').length - 1 };
    });
  }
  private async export(audit: ReturnType<AgenticLotSplitController['audit']>, partial = false) {
    const output = partial ? join(this.root, 'partial') : this.root;
    if (partial) await mkdir(output, { recursive: true });
    const decisions = this.state.decisions.map(decision => ({ ...decision, evidence: decision.evidence.map(quote => this.quote(quote)), source: this.raw(decision) }))
      .sort((a, b) => a.source[0]!.block - b.source[0]!.block || a.source[0]!.start - b.source[0]!.start);
    const manifest = { schema_version: 'agentic-lot-split/v3', method: this.ruleAssisted() ? 'agent-proposed-rules-with-sampled-boundary-checks' : 'model-authored-discovery-and-boundaries', source_id: this.source.source_id,
      status: partial ? 'in_progress' : 'sealed', progress: this.progress(), source_sha256: this.source.sha256, pdf_sha256: this.pdf?.sha256 ?? null, revision: this.state.revision, decisions,
      coverage: audit, boundary_reviews: Object.fromEntries(decisions.map(row => [row.id, this.state.reviews[row.id]])),
      rule_experiments: this.state.rule_experiments,
      semantic_review: this.ruleAssisted() ? 'Sampled rule boundary checks plus individual exception checks; not independent field-semantic approval.' : 'Agent self-review of each decision; not an independent semantic approval.' };
    await atomicWriteJson(join(output, 'manifest.json'), manifest);
    await atomicWriteJson(join(output, 'coverage-check.json'), audit);
    await atomicWriteText(join(output, 'lot-inputs.jsonl'), decisions.filter(row => row.kind === 'lot').map(lot => JSON.stringify({
      id: lot.id, name: lot.name, provisional: partial, open_end: Boolean(lot.open_end), boundary_reviewed: this.state.reviews[lot.id]?.digest === sha256Json(this.state.decisions.find(row => row.id === lot.id)), source_id: this.source.source_id, source: lot.source,
      shared: decisions.filter(row => row.kind === 'shared' && row.related_lot_ids.includes(lot.id)).map(row => ({ id: row.id, source: row.source })),
      unresolved: decisions.filter(row => row.kind === 'unresolved' && row.related_lot_ids.includes(lot.id)).map(row => ({ id: row.id, reason: row.reason })),
    })).join('\n') + '\n');
    await atomicWriteText(join(output, 'boundary-report.md'), ['# Agentic 检验批发现与拆分', '',
      `Agent 当前登记 ${audit.lots} 个批候选，保留 ${audit.unresolved_groups} 组未决；全文源块 ${audit.source_blocks}，${partial ? "仍在处理中，不能作为完成交付" : "区间覆盖校验通过"}。`,
      '边界由运行时模型提交；覆盖通过不代表独立语义复核或验收字段识别完成。', '',
      ...decisions.map(row => `- ${row.kind} · ${row.id} · ${row.name}：${row.reason}；范围 ${JSON.stringify(row.ranges)}`)].join('\n') + '\n');
  }
}
