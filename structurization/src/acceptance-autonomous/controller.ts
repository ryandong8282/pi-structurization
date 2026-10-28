import { readFile, writeFile, mkdir, realpath, appendFile, stat, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, relative, join, dirname, isAbsolute } from 'node:path';
import { randomBytes } from 'node:crypto';
import { atomicWriteJson } from '../atomic.js';
import { sha256Json, sha256Text, prettyJson } from '../canonical.js';
import { strictJsonParse } from '../strict-json.js';
import { normalizeStandardNo, declaredStandardNo, standardIdentityMatches, standardNumberTokens, type ExternalSourceWorkflow } from '../external-source-workflow.js';
import type { AcceptanceCheckpoint, AcceptanceDelivery, AcceptanceGroup, AcceptanceIssue, AutonomousBudgetLimits,
  AutonomousBudgetExtension, GroupReviewer, GroupReviewRequest, GroupReviewResult, ReviewFailureCheck, SampleReviewReceipt, SourceLedger, AcceptanceReference } from './contracts.js';
import { ACCEPTANCE_DELIVERY_SCHEMA, parseAcceptanceDelivery } from './schema.js';
import { buildAcceptanceSourceLedger, referenceSourceField, verifySourceQuote } from './source-ledger.js';
import { sourceReadExposure } from './source-read-exposure.js';
import { eligibleLotIds, groupReviewBlockers, reviewBlockerFeedback, referenceScenarioKey, validateAcceptanceDelivery } from './validation.js';
import { reconcileToolResponses, subtaskToolResponses, subtaskBudgetRequests } from './tool-accounting.js';
import { eventPrefixMatches } from './event-history.js';
import { ACCEPTANCE_BATCHING_GUIDANCE } from './batch-guidance.js';
import { freezeSourceImages, freezeOriginalPdfPage, validPdfPageBox, verifySourceImages, sourceImageProofs, sourceImageManifestName,
  type OriginalPdfSource, type OriginalPdfPageRenderer, type SourceImageManifest } from './source-images.js';
import { appendTrainingDeclarations, declaredTraining, sourceExposures, trainingLotIds,
  TRAINING_INITIALIZATION_FILE, verifyTrainingDeclarationHistory } from './training-history.js';
import { groupReviewFingerprint, reviewExposures, reviewSubmissionIssues, sampleReceiptAccepted, sampleReviewFingerprint, sampleReviewMaterial, focusedReviewRules, reviewQuoteBlocks } from './review.js';
import { reviewObligations, requiredReviewLotIds, receiptPostdatesFailures } from './review-plan.js';
import { failureReviewPlan, reviewedFactsFingerprint } from './review-facts.js';
import { inventoryFailureChecks, reviewFailureChecks, requestResolvesFailures } from './review-failures.js';
import { planTableSweep, executeTableSweep, TABLE_SWEEP_PROGRAM_CONTRACT, TableSweepOutputError } from './table-sweep.js';
import { installSweepArtifacts, recoverSweepArtifacts } from './sweep-artifacts.js';
import { readLotSplitHandoff, lotSplitInputs, mapSplitCandidates, splitDeliveryIssues, splitReviewReadinessIssues, assertSplitRefinement, type LotSplitHandoff } from './lot-split-handoff.js';
import { lotInputPage } from './lot-input-pages.js';

import { verifyExternalEditionProof, type FrozenEditionProof } from '../external-source-edition.js';
import { editionCatalog, assertEditionProofPresent, freezeEditionProof, verifyFrozenEditionProofs, inventoryEvidenceFingerprint } from './source-editions.js';
import { parallelMap, runParallelExtraction } from './parallel-extraction.js';
import type { AcceptanceExtractor, ExtractionTask } from './contracts.js';

type ReferenceReceipt = { key: string; source_id?: string; literal_only: boolean; edition_proof?: FrozenEditionProof;
  reviewed?: { scenario: string; group_id: string; group_fingerprint: string; reference: AcceptanceReference } };
const applicabilityScenario = (reference: AcceptanceReference) => sha256Json({ standard_no: normalizeStandardNo(reference.standard_no),
  version: reference.version, clause: reference.clause, object: reference.object, purpose: reference.purpose,
  conditions: reference.conditions.map(condition => condition.value) });
export interface AcceptanceControllerOptions {
  root: string;
  markdownPath: string;
  limits: AutonomousBudgetLimits;
  /** Applied to newly created tasks only; existing tasks require a host-authorized policy change. */
  subtaskToolResponseBytes?: number;
  reviewer: GroupReviewer;
  extractor?: AcceptanceExtractor;
  /** Production requires a real method run before paying for table sample review or batch expansion. Legacy callers can keep their historical protocol. */
  requireExecutableTableTrials?: boolean;
  /** New live work explicitly adjudicates retained findings; historical sealed artifacts retain their protocol. */
  requireExplicitFailureResolution?: boolean;
  externalSourceWorkflow?: ExternalSourceWorkflow;
  originalPdf?: OriginalPdfSource;
  renderOriginalPdfPage?: OriginalPdfPageRenderer;
  predecessor?: AcceptanceCheckpoint['predecessor'];
  onProgress?: (message: string) => Promise<void>;
}

/** Private checkpoint/approvals are outside the author's writable work directory. */
export class AcceptanceAutonomousController {
  readonly root: string;
  readonly workRoot: string;
  readonly sourceRoot: string;
  private checkpoint!: AcceptanceCheckpoint;
  private sources: SourceLedger[] = [];
  private receipts: Record<string, ReferenceReceipt> = {};
  private sourceEditions: Record<string, FrozenEditionProof> = {};
  private salt = '';
  private lastIssues: AcceptanceIssue[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  private saveQueue: Promise<unknown> = Promise.resolve();
  private originalPageQueue: Promise<unknown> = Promise.resolve();
  private protectedFiles = new Map<string, string>();
  private returnedIssueSummaries = new Set<string>();
  private currentContextTokens = new Map<string, number>();
  private imageManifests: SourceImageManifest[] = [];
  private activity = { extraction: { queued: 0, running: 0 }, review: { queued: 0, running: 0 } };
  private activityQueue: Promise<unknown> = Promise.resolve();
  private lotSplit: LotSplitHandoff | undefined;
  private factCache = new Map<string, Record<string, string> | undefined>();

  private constructor(readonly options: AcceptanceControllerOptions) {
    this.root = resolve(options.root);
    this.workRoot = join(this.root, 'work');
    this.sourceRoot = join(this.workRoot, 'source');
  }

  static async open(options: AcceptanceControllerOptions): Promise<AcceptanceAutonomousController> {
    const controller = new AcceptanceAutonomousController(options);
    let created = false;
    let editionCatalogMigrated = false;
    await mkdir(controller.sourceRoot, { recursive: true });
    await mkdir(join(controller.root, 'reviews'), { recursive: true });
    const markdown = await readFile(options.markdownPath, 'utf8');
    const ledger = buildAcceptanceSourceLedger(markdown);
    const checkpointPath = join(controller.root, 'checkpoint.json');
    try {
      controller.checkpoint = JSON.parse(await readFile(checkpointPath, 'utf8')) as AcceptanceCheckpoint;
      if (controller.checkpoint.schema_version !== 'acceptance-autonomous-checkpoint/v1'
        || controller.checkpoint.source_sha256 !== ledger.sha256) throw new Error('Frozen source/version mismatch; create an isolated revision.');
      const stored = JSON.parse(await readFile(join(controller.root, 'sources.json'), 'utf8')) as { sources: SourceLedger[]; receipts: Record<string, ReferenceReceipt>; salt: string; editions?: Record<string, FrozenEditionProof> };
      controller.sources = stored.sources;
      controller.receipts = stored.receipts;
      controller.sourceEditions = editionCatalog([...Object.values(stored.editions ?? {}), ...Object.values(stored.receipts).map(receipt => receipt.edition_proof)]);
      editionCatalogMigrated = Object.keys(controller.sourceEditions).length > 0 && sha256Json(stored.editions ?? {}) !== sha256Json(controller.sourceEditions);
      controller.salt = stored.salt;
      for (const request of controller.checkpoint.requests) if (request.status === 'running') request.status = 'pending';
      await controller.verifyBudgetExtensions(options.limits);
      // Resume never grants new counters; only an independently audited host addition changes the byte cap.
      for (const key of Object.keys(options.limits) as Array<keyof AutonomousBudgetLimits>) {
        if (key === 'max_tool_response_bytes' && controller.checkpoint.budget_extensions?.length) continue;
        if (options.limits[key] !== controller.checkpoint.budget[key]) throw new Error(`Resume budget configuration changed: ${key}; existing checkpoint remains authoritative.`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      // An incomplete checkpoint is not permission to reset existing accounting.
      if (controller.checkpoint) throw new Error('Incomplete autonomous checkpoint; preserve it and repair the controller state.');
      if (await stat(join(controller.root, 'sources.json')).catch(() => null)) throw new Error('Checkpoint missing beside existing source state; refusing to reset accounting.');
      controller.sources = [ledger];
      controller.salt = randomBytes(24).toString('hex');
      controller.checkpoint = { schema_version: 'acceptance-autonomous-checkpoint/v1', source_sha256: ledger.sha256,
        generation: 0, delivery_fingerprint: '', status: 'working', budget: { ...options.limits, tool_response_bytes: 0, observed_context_tokens: 0, attempts: 0 },
        tool_response_accounting: { version: 1, historical_counter_bytes: 0, historical_returned_bytes: 0, adjustment_bytes: 0, audit_sha256: '' },
        ...(options.predecessor ? { predecessor: options.predecessor } : {}), training_declarations: [], requests: [], approvals: [], invalidations: [], publications: [] };
      await writeFile(join(controller.sourceRoot, `${ledger.source_id}.md`), markdown, 'utf8');
      await atomicWriteJson(join(controller.sourceRoot, `${ledger.source_id}.json`), ledger);
      await atomicWriteJson(join(controller.workRoot, 'DELIVERY.schema.json'), ACCEPTANCE_DELIVERY_SCHEMA);
      await controller.save();
      created = true;
    }
    const implementation = dirname(fileURLToPath(import.meta.url));
    for (const name of await readdir(implementation)) if (/\.(?:js|ts)$/u.test(name) && !name.endsWith('.d.ts')) {
      const path = join(implementation, name); controller.protectedFiles.set(path, sha256Text(await readFile(path, 'utf8')));
    }
    for (const path of [checkpointPath, join(controller.root, 'sources.json')]) controller.protectedFiles.set(path, sha256Text(await readFile(path, 'utf8')));
    await controller.assertSources();
    if (editionCatalogMigrated) {
      await controller.save();
      await controller.appendEvent('source_edition_catalog_registered', { proof_ids: Object.keys(controller.sourceEditions), migrated_from_receipts: true, counters_reset: false });
    }
    await controller.reconcileLegacyAccounting();
    await controller.verifySubtaskBudgetPolicy();
    await controller.verifyTaskSessionPolicy();
    if (created && options.subtaskToolResponseBytes !== undefined) await controller.useSubtaskBudgets({
      request_id: 'initial-subtask-budget-policy/v1', max_tool_response_bytes: options.subtaskToolResponseBytes,
      reason: '全文任务累计记账；独立复核和调查分别限额。', authorized_by: 'application-default' });
    if (controller.checkpoint.training_declarations === undefined) {
      // A damaged draft can still be repaired with native author tools before its first valid submission.
      const text = await readFile(join(controller.workRoot, 'DELIVERY.json'), 'utf8').catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
      let delivery: AcceptanceDelivery | undefined;
      if (text !== undefined) { try { delivery = parseAcceptanceDelivery(strictJsonParse(text)).delivery; } catch { /* Defer until valid author submission. */ } }
      if (delivery?.source_sha256 === ledger.sha256) await controller.ensureTrainingDeclarations(delivery, text!);
    }
    if (controller.checkpoint.training_declarations !== undefined) {
      await verifyTrainingDeclarationHistory(controller.root, controller.checkpoint, ledger);
      if (controller.checkpoint.training_declaration_initialization) controller.protectedFiles.set(join(controller.root, TRAINING_INITIALIZATION_FILE),
        controller.checkpoint.training_declaration_initialization.audit_sha256);
    }
    await controller.ensureSourceImages(ledger, options.markdownPath);
    // Resume archived external sources through the same local, version-checked lookup.
    const draft = await readFile(join(controller.workRoot, 'DELIVERY.json'), 'utf8').catch(() => '');
    let references: AcceptanceReference[] = [];
    try { references = parseAcceptanceDelivery(strictJsonParse(draft)).delivery?.references ?? []; } catch { /* The author can repair an invalid draft. */ }
    for (const source of controller.sources.filter(source => source.source_id !== ledger.source_id)) {
      const reference = references.find(row => controller.receipts[row.id]?.source_id === source.source_id && row.standard_no.trim());
      const document = reference ? await options.externalSourceWorkflow?.lookup(reference.standard_no) : undefined;
      const origin = document?.markdown_sha256 === source.sha256 && sha256Text(document.markdown) === source.sha256 ? document.markdown_path : undefined;
      await controller.ensureSourceImages(source, origin);
    }
    controller.lotSplit = await readLotSplitHandoff(controller.root, ledger);
    if (controller.checkpoint.lot_split && (!controller.lotSplit || controller.checkpoint.lot_split.sha256 !== sha256Json(controller.lotSplit))) {
      const previousHash = controller.checkpoint.lot_split.sha256;
      if (!controller.lotSplit || controller.lotSplit.supersedes_sha256 !== previousHash
        || controller.checkpoint.approvals.length || controller.checkpoint.publications.length)
        throw new Error('Registered lot split changed or disappeared; preserve the existing checkpoint.');
      const previous = JSON.parse(await readFile(join(controller.root, 'lot-split', `${previousHash}.json`), 'utf8')) as LotSplitHandoff;
      if (sha256Json(previous) !== previousHash) throw new Error('Frozen predecessor split changed.');
      assertSplitRefinement(previous, controller.lotSplit);
      controller.checkpoint.lot_split = { sha256: sha256Json(controller.lotSplit), lots: lotSplitInputs(controller.lotSplit).length, history: controller.lotSplit.history };
      await controller.save();
      await controller.appendEvent('lot_split_refined', { predecessor: previousHash, ...controller.checkpoint.lot_split,
        counters_reset: false, existing_candidates_preserved: true });
    }
    if (controller.lotSplit) {
      const hash = sha256Json(controller.lotSplit);
      const inputFile = join(controller.sourceRoot, `lot-split.${hash}.json`), inputText = JSON.stringify(controller.lotSplit);
      await writeFile(inputFile, inputText, { flag: 'wx' }).catch(async error => {
        if (error.code !== 'EEXIST' || await readFile(inputFile, 'utf8') !== inputText) throw new Error('Frozen lot input changed; restore registered source, preserve all counters.');
      });
      controller.protectedFiles.set(inputFile, sha256Text(inputText));
      for (const file of [join(controller.root, 'lot-split', 'accepted.json'), join(controller.root, 'lot-split', `${hash}.json`)])
        controller.protectedFiles.set(file, sha256Text(await readFile(file, 'utf8')));
      if (!controller.checkpoint.lot_split) {
        controller.checkpoint.lot_split = { sha256: hash, lots: lotSplitInputs(controller.lotSplit).length, history: controller.lotSplit.history };
        await controller.save();
        await controller.appendEvent('lot_split_adopted', { ...controller.checkpoint.lot_split, counters_reset: false, existing_candidates_preserved: true });
      }
    }
    if (controller.checkpoint.table_sweeps?.length && draft) {
      const current = parseAcceptanceDelivery(strictJsonParse(draft)).delivery;
      if (current) for (const recovered of await recoverSweepArtifacts(controller.root, controller.workRoot, controller.checkpoint.table_sweeps, current)) {
        controller.protectedFiles.set(recovered.audit, sha256Text(await readFile(recovered.audit, 'utf8')));
        await controller.appendEvent('table_sweep_artifacts_recovered', { ...recovered, counters_reset: false, semantic_approval: false });
      }
    }
    if (options.requireExplicitFailureResolution && !controller.checkpoint.review_failure_policy) {
      const previous = sha256Json(controller.checkpoint);
      controller.checkpoint.review_failure_policy = 'explicit/v1';
      await controller.appendEvent('explicit_failure_resolution_enabled', { previous_checkpoint_sha256: previous,
        requests: controller.checkpoint.requests.length, counters_reset: false, history_preserved: true });
      await controller.save();
    }
    return controller;
  }

  private async ensureSourceImages(source: SourceLedger, markdownPath?: string): Promise<void> {
    const previous = this.checkpoint.source_image_manifests?.[source.source_id];
    const result = await freezeSourceImages(this.sourceRoot, source, markdownPath, previous);
    if (!result) return;
    this.imageManifests = [...this.imageManifests.filter(row => row.source_id !== source.source_id), result.manifest];
    if (result.digest !== previous) {
      (this.checkpoint.source_image_manifests ??= {})[source.source_id] = result.digest;
      await this.save();
      await this.appendEvent('source_images_frozen', { source_id: source.source_id, images: result.manifest.images.length,
        available: result.manifest.images.filter(row => row.status === 'available').length, counters_reset: false });
    }
  }

  private imageProofs(delivery: AcceptanceDelivery, group: AcceptanceGroup, ids = group.lot_ids) {
    return sourceImageProofs(sampleReviewMaterial(delivery, group, ids), this.imageManifests);
  }

  /** Authors/workers can freeze raw pages before review; reviewers only read the resulting immutable companions. */
  openOriginalSourcePage(params: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const next = this.originalPageQueue.then(() => this.freezeOriginalSourcePage(params, signal));
    this.originalPageQueue = next.catch(() => undefined);
    return next;
  }

  private async freezeOriginalSourcePage(params: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    await this.assertSources(); signal?.throwIfAborted();
    const source = this.sources.find(row => row.source_id === params.source_id);
    const block = source?.blocks.find(row => row.id === params.block_id);
    if (!source || !block) return { ok: false, error: 'unknown_source_block', actual: {
      source_id: String(params.source_id).slice(0, 160), block_id: String(params.block_id).slice(0, 160) },
      expected: 'source_id 与 block_id 必须来自已登记的冻结来源；不能传入文件路径。', writable: 'source_id / block_id', next_tool: 'acceptance_workspace' };
    const markdown = await readFile(join(this.sourceRoot, `${source.source_id}.md`), 'utf8');
    const markers = [...markdown.slice(0, block.end).matchAll(/\[PDF\s+p\.\s*(\d+)\]/giu)];
    const page = params.page_number ?? (markers.length ? Number(markers.at(-1)![1]) : undefined);
    const box = params.box ?? [0, 0, 1, 1];
    if (typeof page !== 'number' || !Number.isSafeInteger(page) || page < 1 || !validPdfPageBox(box)) return {
      ok: false, error: 'original_page_scope_required', actual: { page_number: page ?? null, box },
      expected: 'page_number 是从1开始的PDF物理页；省略时用冻结Markdown最近的 [PDF p.N] 标记。box 为左上起算的归一化 [x0,y0,x1,y1]，0<=x0<x1<=1，0<=y0<y1<=1。',
      writable: 'page_number / box', next_tool: 'open_acceptance_source_page' };
    const previous = this.checkpoint.source_image_manifests?.[source.source_id];
    const admitted = this.imageManifests.find(row => row.source_id === source.source_id)?.original_pdf;
    const original = admitted ? { path: join(this.sourceRoot, admitted.path), sha256: admitted.sha256, kind: admitted.kind }
      : source.source_id === this.checkpoint.source_sha256 ? this.options.originalPdf
      : await this.options.externalSourceWorkflow?.originalPdf?.(source.source_id);
    if (!original || !this.options.renderOriginalPdfPage) return { ok: false, error: 'original_pdf_unavailable', actual: { source_id: source.source_id },
      expected: '该来源须有同一版本、可核验指纹的PDF原件或已登记工作PDF；当前Markdown仍保留。',
      writable: '不改冻结原文、检查点或已有资料；保留未决判断，先继续其他独立范围。', next_tool: 'acceptance_workspace' };
    const result = await freezeOriginalPdfPage({ sourceRoot: this.sourceRoot, source, block_id: block.id, original,
      page_number: page, box, max_bytes: Math.max(1, Math.floor((this.checkpoint.budget.max_single_tool_response_bytes - 4096) * 3 / 4)),
      renderer: this.options.renderOriginalPdfPage, ...(previous ? { expectedDigest: previous } : {}), ...(signal ? { signal } : {}) });
    if (!result.ok) {
      const repairable = ['physical_page_out_of_range', 'original_page_image_too_large', 'page_image_exceeds_limit', 'invalid_page_box'].includes(result.error);
      return { ...result, recoverable_by_author: repairable,
        expected: repairable ? '请求原PDF的有效物理页；图像太大时缩小 box 核验局部，不增加预算。' : '已登记原件及受管渲染器须可用；工具参数不能修复损坏原件或渲染环境，需宿主恢复。',
        writable: 'page_number / box；原件、冻结页图与程序指纹不可写，保留检查点和用量。', next_tool: repairable ? 'open_acceptance_source_page' : 'acceptance_workspace' };
    }
    this.imageManifests = [...this.imageManifests.filter(row => row.source_id !== source.source_id), result.manifest];
    if (result.digest !== previous) {
      (this.checkpoint.source_image_manifests ??= {})[source.source_id] = result.digest; await this.save();
      await this.appendEvent('original_pdf_page_frozen', { source_id: source.source_id, block_id: block.id, page_number: page, box,
        pdf_sha256: result.manifest.original_pdf!.sha256, image_sha256: result.image.sha256, manifest: result.digest, counters_reset: false });
    }
    const imagePath = `source/${result.image.path}`;
    return { ok: true, source_id: source.source_id, block_id: block.id, page_number: page, box, cached: result.cached,
      page_basis: params.page_number === undefined ? 'nearest_markdown_page_marker' : 'requested_physical_page',
      pdf_sha256: result.manifest.original_pdf!.sha256, pdf_kind: result.manifest.original_pdf!.kind, image_sha256: result.image.sha256,
      image_path: imagePath, images: `source/${sourceImageManifestName(source.source_id, result.digest)}`,
      next_tool: 'read', next_tool_arguments: { path: imagePath },
      instruction: '读取封存页图核验解析文字；必要时用 box 放大。页图是原始证据而非预先裁定，仍须核对对象、条款与适用性；Markdown保持原字节。converted_pdf 是转换后工作PDF的物理页，不是Word原始分页。记录图像根据及仍有的疑点，独立审查仍须核验。' };
  }

  private async ensureTrainingDeclarations(delivery: AcceptanceDelivery, deliveryText: string): Promise<void> {
    const source = this.sources.find(row => row.source_id === this.checkpoint.source_sha256)!;
    if (delivery.source_sha256 !== source.sha256) return;
    if (this.checkpoint.training_declarations === undefined) {
      if (this.checkpoint.training_declaration_initialization || this.checkpoint.approvals.some(row => (row.protocol_version ?? 0) >= 3)
        || this.checkpoint.publications.some(row => row.review_protocol_version === 3 || row.review_protocol_version === 4)) {
        throw new Error('training_declaration_history_changed: existing tracked history is missing; restore it without resetting counters.');
      }
      const checkpointText = await readFile(join(this.root, 'checkpoint.json'), 'utf8');
      const initial = sourceExposures(delivery, source);
      const audit = { version: 1, at: new Date().toISOString(), reason: 'Legacy candidates are conservatively seen; existing decisions and all counters are retained.',
        original_checkpoint_text: checkpointText, original_checkpoint_sha256: sha256Text(checkpointText),
        original_delivery_text: deliveryText, original_delivery_sha256: sha256Text(deliveryText), initial_declarations: initial };
      const path = join(this.root, TRAINING_INITIALIZATION_FILE);
      const previous = await readFile(path, 'utf8').catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
      if (previous) {
        const saved = JSON.parse(previous);
        if (saved.original_checkpoint_sha256 !== audit.original_checkpoint_sha256 || saved.original_delivery_sha256 !== audit.original_delivery_sha256
          || sha256Json(saved.initial_declarations) !== sha256Json(initial)) throw new Error('training_declaration_history_changed: an initialization audit already exists for different history.');
      }
      const auditText = previous ?? `${JSON.stringify(audit, null, 2)}\n`;
      if (!previous) await writeFile(path, auditText, 'utf8');
      this.checkpoint.training_declarations = initial;
      this.checkpoint.training_declaration_initialization = { audit_sha256: sha256Text(auditText) };
      this.protectedFiles.set(path, sha256Text(auditText));
      await this.save();
      await this.appendEvent('training_declaration_history_initialized', { audit: TRAINING_INITIALIZATION_FILE,
        legacy_seen_candidates: initial.length, counters_reset: false, approvals_retained: this.checkpoint.approvals.length });
    }
    if (appendTrainingDeclarations(this.checkpoint.training_declarations, declaredTraining(delivery, source))) {
      await this.save();
      await this.appendEvent('training_declarations_recorded', { total: this.checkpoint.training_declarations.length,
        delivery_fingerprint: sha256Json(delivery), history_is_append_only: true });
    }
  }

  private async verifySubtaskBudgetPolicy(): Promise<void> {
    const policy = this.checkpoint.subtask_budget_policy;
    if (!policy) return;
    const path = join(this.root, 'budget-policies', `${policy.id}.json`);
    const text = await readFile(path, 'utf8');
    const audit = JSON.parse(text);
    if (audit.version !== 1 || typeof audit.previous_checkpoint_text !== 'string' || !audit.request_usage) throw new Error('Subtask budget policy audit changed; checkpoint preserved.');
    const prior = JSON.parse(audit.previous_checkpoint_text) as AcceptanceCheckpoint;
    const { audit_sha256: _hash, ...record } = policy;
    if (sha256Text(text) !== policy.audit_sha256 || policy.id !== sha256Text(policy.request_id)
      || audit.version !== 1 || sha256Json(audit.policy) !== sha256Json(record)
      || !Number.isSafeInteger(policy.max_tool_response_bytes) || policy.max_tool_response_bytes <= 0
      || !policy.reason.trim() || !policy.authorized_by.trim()
      || sha256Text(audit.previous_checkpoint_text) !== audit.previous_checkpoint_sha256
      || prior.subtask_budget_policy || prior.source_sha256 !== this.checkpoint.source_sha256
      || sha256Json(prior.budget_extensions ?? []) !== sha256Json(this.checkpoint.budget_extensions ?? [])
      || Object.entries(prior.budget).some(([key, value]) => ['tool_response_bytes', 'observed_context_tokens', 'attempts'].includes(key)
        ? this.checkpoint.budget[key as keyof AcceptanceCheckpoint['budget']] < value
        : this.checkpoint.budget[key as keyof AcceptanceCheckpoint['budget']] !== value)
      || !await eventPrefixMatches(join(this.root, 'session.events.jsonl'), audit.event_prefix_bytes, audit.event_prefix_sha256)
      || this.checkpoint.requests.some(request => !Number.isSafeInteger(request.tool_response_bytes) || request.tool_response_bytes! < (audit.request_usage[request.id] ?? 0))
      || Object.keys(audit.request_usage).some(id => !this.checkpoint.requests.some(request => request.id === id))) {
      throw new Error('Subtask budget policy/history mismatch; checkpoint preserved.');
    }
    this.protectedFiles.set(path, policy.audit_sha256);
  }

  /** Host-only transition: retain the old cap as history, enforce independent request caps instead. */
  async useSubtaskBudgets(input: { request_id: string; max_tool_response_bytes: number; reason: string; authorized_by: string }) {
    await this.assertSources();
    if (!input.request_id.trim() || !input.reason.trim() || !input.authorized_by.trim()
      || !Number.isSafeInteger(input.max_tool_response_bytes) || input.max_tool_response_bytes <= 0) throw new Error('Subtask budget policy requires authorization and a positive byte limit.');
    const existing = this.checkpoint.subtask_budget_policy;
    if (existing) {
      if (existing.request_id !== input.request_id || existing.max_tool_response_bytes !== input.max_tool_response_bytes
        || existing.reason !== input.reason || existing.authorized_by !== input.authorized_by) throw new Error('Subtask budget policy already exists with different terms.');
      return { policy: existing, already_applied: true };
    }
    if (this.result().sealed) throw new Error('Cannot change the budget policy of a sealed task.');
    const checkpointText = await readFile(join(this.root, 'checkpoint.json'), 'utf8');
    const events = await readFile(join(this.root, 'session.events.jsonl')).catch(error => { if (error.code === 'ENOENT') return Buffer.alloc(0); throw error; });
    const usage = subtaskToolResponses(events.toString('utf8'));
    for (const request of this.checkpoint.requests) if (request.attempts && usage[request.id] === undefined) throw new Error(`Missing historical subtask usage: ${request.id}; counters preserved.`);
    const record = { id: sha256Text(input.request_id), ...input, at: new Date().toISOString() };
    const path = join(this.root, 'budget-policies', `${record.id}.json`);
    await mkdir(dirname(path), { recursive: true });
    const audit = { version: 1, policy: record, previous_checkpoint_text: checkpointText, previous_checkpoint_sha256: sha256Text(checkpointText),
      event_prefix_bytes: events.length, event_prefix_sha256: sha256Text(events.toString('utf8')),
      request_usage: Object.fromEntries(this.checkpoint.requests.map(request => [request.id, usage[request.id] ?? 0])) };
    const auditText = `${JSON.stringify(audit, null, 2)}\n`;
    const pending = await readFile(path, 'utf8').catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
    if (pending && sha256Json({ ...JSON.parse(pending), policy: { ...JSON.parse(pending).policy, at: record.at } }) !== sha256Json(audit)) throw new Error('Pending subtask budget policy differs; preserve both.');
    if (!pending) await writeFile(path, auditText, { encoding: 'utf8', flag: 'wx' });
    const policy: NonNullable<AcceptanceCheckpoint['subtask_budget_policy']> = {
      ...(pending ? JSON.parse(pending).policy : record), audit_sha256: sha256Text(pending ?? auditText) };
    this.checkpoint.subtask_budget_policy = policy;
    for (const request of this.checkpoint.requests) request.tool_response_bytes = usage[request.id] ?? 0;
    this.protectedFiles.set(path, policy.audit_sha256);
    await this.save();
    await this.appendEvent('subtask_budget_policy_applied', { policy: this.checkpoint.subtask_budget_policy, counters_reset: false, total_limit_bytes: null });
    return { policy, already_applied: false };
  }

  private async verifyTaskSessionPolicy(): Promise<void> {
    const policy = this.checkpoint.task_session_start_policy;
    if (!policy) return;
    const path = join(this.root, 'task-session-policies', `${policy.id}.json`);
    const text = await readFile(path, 'utf8');
    const audit = JSON.parse(text);
    if (audit.version !== 1 || typeof audit.previous_checkpoint_text !== 'string') throw new Error('Task session policy audit changed; checkpoint preserved.');
    const prior = JSON.parse(audit.previous_checkpoint_text) as AcceptanceCheckpoint;
    const { audit_sha256: _hash, ...record } = policy;
    if (sha256Text(text) !== policy.audit_sha256 || policy.id !== sha256Text(policy.request_id)
      || policy.scope !== 'accounting_only' || !policy.reason.trim() || !policy.authorized_by.trim()
      || sha256Json(audit.policy) !== sha256Json(record)
      || sha256Text(audit.previous_checkpoint_text) !== audit.previous_checkpoint_sha256
      || prior.task_session_start_policy || prior.source_sha256 !== this.checkpoint.source_sha256
      || sha256Json(prior.subtask_budget_policy ?? null) !== sha256Json(this.checkpoint.subtask_budget_policy ?? null)
      || sha256Json(prior.budget_extensions ?? []) !== sha256Json(this.checkpoint.budget_extensions ?? [])
      || Object.entries(prior.budget).some(([key, value]) => ['tool_response_bytes', 'observed_context_tokens', 'attempts'].includes(key)
        ? this.checkpoint.budget[key as keyof AcceptanceCheckpoint['budget']] < value
        : this.checkpoint.budget[key as keyof AcceptanceCheckpoint['budget']] !== value)
      || prior.requests.some(previous => {
        const current = this.checkpoint.requests.find(request => request.id === previous.id);
        return !current || current.attempts < previous.attempts || (current.tool_response_bytes ?? 0) < (previous.tool_response_bytes ?? 0);
      })
      || !await eventPrefixMatches(join(this.root, 'session.events.jsonl'), audit.event_prefix_bytes, audit.event_prefix_sha256, true)) {
      throw new Error('Task session policy/history mismatch; checkpoint preserved.');
    }
    this.protectedFiles.set(path, policy.audit_sha256);
  }

  /** Host-only authorization: task starts remain historical counters; request retry limits do not change. */
  async useTaskSessionAccounting(input: { request_id: string; reason: string; authorized_by: string }) {
    await this.assertSources();
    if (!input.request_id.trim() || !input.reason.trim() || !input.authorized_by.trim()) throw new Error('Task session accounting requires explicit authorization and reason.');
    const existing = this.checkpoint.task_session_start_policy;
    if (existing) {
      if (existing.request_id !== input.request_id || existing.reason !== input.reason || existing.authorized_by !== input.authorized_by) throw new Error('Task session policy already exists with different terms.');
      return { policy: existing, already_applied: true };
    }
    if (this.result().sealed) throw new Error('Cannot change the session policy of a sealed task.');
    const checkpointText = await readFile(join(this.root, 'checkpoint.json'), 'utf8');
    const events = await readFile(join(this.root, 'session.events.jsonl')).catch(error => { if (error.code === 'ENOENT') return Buffer.alloc(0); throw error; });
    const id = sha256Text(input.request_id);
    const path = join(this.root, 'task-session-policies', `${id}.json`);
    await mkdir(dirname(path), { recursive: true });
    const pending = await readFile(path, 'utf8').catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
    const record = { id, ...input, scope: 'accounting_only' as const, at: pending ? JSON.parse(pending).policy.at : new Date().toISOString() };
    const audit = { version: 1, policy: record, previous_checkpoint_text: checkpointText, previous_checkpoint_sha256: sha256Text(checkpointText),
      event_prefix_bytes: events.length, event_prefix_sha256: sha256Text(events.toString('utf8')) };
    const auditText = `${JSON.stringify(audit, null, 2)}\n`;
    if (pending && sha256Json(JSON.parse(pending)) !== sha256Json(audit)) throw new Error('Pending task session policy differs; preserve both.');
    if (!pending) await writeFile(path, auditText, { encoding: 'utf8', flag: 'wx' });
    const policy = { ...record, audit_sha256: sha256Text(pending ?? auditText) };
    this.checkpoint.task_session_start_policy = policy;
    this.protectedFiles.set(path, policy.audit_sha256);
    await this.save();
    await this.appendEvent('task_session_start_policy_applied', { policy, counters_reset: false, total_start_limit: null,
      per_request_attempt_limit: this.checkpoint.budget.max_attempts });
    return { policy, already_applied: false };
  }

  private async verifyBudgetExtensions(base: AutonomousBudgetLimits): Promise<void> {
    const extensions = this.checkpoint.budget_extensions ?? [];
    if (!extensions.length) return;
    let expected = base.max_tool_response_bytes;
    const ids = new Set<string>();
    for (const [index, extension] of extensions.entries()) {
      if (extension.id !== sha256Text(extension.request_id) || ids.has(extension.id)) throw new Error('Invalid budget extension identity; checkpoint preserved.');
      ids.add(extension.id);
      const path = join(this.root, 'budget-extensions', `${extension.id}.json`);
      const text = await readFile(path, 'utf8');
      if (sha256Text(text) !== extension.audit_sha256) throw new Error('Budget extension audit changed; checkpoint preserved.');
      const audit = JSON.parse(text);
      const prior = JSON.parse(audit.previous_checkpoint_text) as AcceptanceCheckpoint;
      const { audit_sha256: _hash, ...record } = extension;
      if (audit.version !== 1 || sha256Json(audit.extension) !== sha256Json(record)
        || sha256Text(audit.previous_checkpoint_text) !== audit.previous_checkpoint_sha256
        || prior.source_sha256 !== this.checkpoint.source_sha256
        || sha256Json(prior.budget_extensions ?? []) !== sha256Json(extensions.slice(0, index))
        || extension.from_bytes !== expected || prior.budget.max_tool_response_bytes !== expected
        || !Number.isSafeInteger(extension.to_bytes) || extension.to_bytes <= expected
        || !extension.reason.trim() || !extension.authorized_by.trim()
        || Object.entries(base).some(([key, value]) => key !== 'max_tool_response_bytes' && prior.budget[key as keyof AutonomousBudgetLimits] !== value)
        || ['tool_response_bytes', 'observed_context_tokens', 'attempts'].some(key => this.checkpoint.budget[key as keyof AcceptanceCheckpoint['budget']] < prior.budget[key as keyof AcceptanceCheckpoint['budget']])
        || !await eventPrefixMatches(join(this.root, 'session.events.jsonl'), audit.event_prefix_bytes, audit.event_prefix_sha256, true)) {
        throw new Error('Budget extension provenance/history mismatch; checkpoint preserved.');
      }
      this.protectedFiles.set(path, extension.audit_sha256);
      expected = extension.to_bytes;
    }
    if (this.checkpoint.budget.max_tool_response_bytes !== expected) throw new Error('Budget cap differs from the authorized extension; checkpoint preserved.');
  }

  /** Host operation for an idle task, intentionally absent from the author's tool collection. */
  async extendToolResponseBudget(input: { request_id: string; total_bytes: number; reason: string; authorized_by: string }) {
    await this.assertSources();
    if (this.checkpoint.subtask_budget_policy) throw new Error('Task totals are accounting-only under the subtask policy; no total-cap addition is needed.');
    if (!input.request_id.trim() || !input.reason.trim() || !input.authorized_by.trim()) throw new Error('Budget addition requires explicit authorization and reason.');
    const id = sha256Text(input.request_id);
    const existing = this.checkpoint.budget_extensions?.find(row => row.id === id);
    if (existing) {
      if (existing.to_bytes !== input.total_bytes || existing.reason !== input.reason || existing.authorized_by !== input.authorized_by) throw new Error('Budget addition request_id was already used with different terms.');
      return { extension: existing, already_applied: true, tool_response_usage: this.toolResponseUsage() };
    }
    if (this.result().sealed || !Number.isSafeInteger(input.total_bytes) || input.total_bytes <= this.checkpoint.budget.max_tool_response_bytes) throw new Error('Only an increase on an unsealed task is allowed; counters remain unchanged.');
    const path = join(this.root, 'budget-extensions', `${id}.json`);
    await mkdir(dirname(path), { recursive: true });
    const checkpointText = await readFile(join(this.root, 'checkpoint.json'), 'utf8');
    const events = await readFile(join(this.root, 'session.events.jsonl')).catch(error => { if (error.code === 'ENOENT') return Buffer.alloc(0); throw error; });
    const pending = await readFile(path, 'utf8').catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
    const record: Omit<AutonomousBudgetExtension, 'audit_sha256'> = pending ? JSON.parse(pending).extension : {
      id, request_id: input.request_id, from_bytes: this.checkpoint.budget.max_tool_response_bytes, to_bytes: input.total_bytes,
      reason: input.reason, authorized_by: input.authorized_by, at: new Date().toISOString() };
    const audit = { version: 1, extension: record, previous_checkpoint_text: checkpointText,
      previous_checkpoint_sha256: sha256Text(checkpointText), event_prefix_bytes: events.length, event_prefix_sha256: sha256Text(events.toString('utf8')) };
    if (pending && (sha256Json(JSON.parse(pending).extension) !== sha256Json({ ...record, id, request_id: input.request_id,
      from_bytes: this.checkpoint.budget.max_tool_response_bytes, to_bytes: input.total_bytes, reason: input.reason, authorized_by: input.authorized_by })
      || JSON.parse(pending).version !== 1 || JSON.parse(pending).previous_checkpoint_text !== checkpointText
      || JSON.parse(pending).previous_checkpoint_sha256 !== audit.previous_checkpoint_sha256
      || JSON.parse(pending).event_prefix_bytes > events.length
      || sha256Text(events.subarray(0, JSON.parse(pending).event_prefix_bytes).toString('utf8')) !== JSON.parse(pending).event_prefix_sha256)) throw new Error('Pending budget addition differs from this checkpoint or authorization; preserve both.');
    const auditText = pending ?? `${JSON.stringify(audit, null, 2)}\n`;
    if (!pending) await writeFile(path, auditText, { encoding: 'utf8', flag: 'wx' });
    const extension = { ...record, audit_sha256: sha256Text(auditText) };
    this.checkpoint.budget_extensions = [...(this.checkpoint.budget_extensions ?? []), extension];
    this.checkpoint.budget.max_tool_response_bytes = input.total_bytes;
    this.protectedFiles.set(path, extension.audit_sha256);
    await this.save();
    await this.appendEvent('tool_response_budget_extended', { extension, tool_response_usage: this.toolResponseUsage(), counters_reset: false });
    return { extension, already_applied: false, tool_response_usage: this.toolResponseUsage() };
  }

  private async reconcileLegacyAccounting(): Promise<void> {
    const existing = this.checkpoint.tool_response_accounting;
    const auditPath = join(this.root, 'tool-response-accounting-v1.json');
    if (existing) {
      if (existing.audit_sha256) {
        const auditText = await readFile(auditPath, 'utf8');
        if (sha256Text(auditText) !== existing.audit_sha256) throw new Error('Tool response accounting audit changed; preserve the checkpoint.');
        const audit = JSON.parse(auditText);
        if (!await eventPrefixMatches(join(this.root, 'session.events.jsonl'), audit.event_prefix_bytes, audit.event_prefix_sha256)) throw new Error('Tool response accounting history changed; preserve the checkpoint.');
        this.protectedFiles.set(auditPath, existing.audit_sha256);
      }
      return;
    }
    const events = await readFile(join(this.root, 'session.events.jsonl'), 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
    const reconciled = reconcileToolResponses(events);
    // Incomplete histories remain conservatively charged; they never grant extra budget.
    if (!reconciled) return;
    const original = await readFile(join(this.root, 'checkpoint.json'), 'utf8');
    const historical = this.checkpoint.budget.tool_response_bytes;
    const audit = { version: 1, original_checkpoint: JSON.parse(original), original_checkpoint_sha256: sha256Text(original),
      historical_counter_bytes: historical, historical_returned_bytes: reconciled.returned_bytes,
      adjustment_bytes: historical - reconciled.returned_bytes, ...reconciled };
    const auditText = `${JSON.stringify(audit, null, 2)}\n`;
    const previous = await readFile(auditPath, 'utf8').catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
    if (previous && previous !== auditText) throw new Error('Existing accounting audit differs; preserve both histories before retrying.');
    if (!previous) await writeFile(auditPath, auditText, 'utf8');
    this.checkpoint.tool_response_accounting = { version: 1, historical_counter_bytes: historical,
      historical_returned_bytes: reconciled.returned_bytes, adjustment_bytes: audit.adjustment_bytes, audit_sha256: sha256Text(auditText) };
    this.protectedFiles.set(auditPath, sha256Text(auditText));
    await this.save();
    await this.appendEvent('tool_response_accounting_reconciled', { historical_counter_bytes: historical,
      returned_bytes: reconciled.returned_bytes, adjustment_bytes: audit.adjustment_bytes, audit: 'tool-response-accounting-v1.json' });
  }

  toolResponseUsage(requestId?: string) {
    const b = this.checkpoint.budget;
    const delivered = b.tool_response_bytes - (this.checkpoint.tool_response_accounting?.adjustment_bytes ?? 0);
    const policy = this.checkpoint.subtask_budget_policy;
    const request = requestId ? this.checkpoint.requests.find(row => row.id === requestId) : undefined;
    if (requestId && !request) throw new Error(`Unknown subtask: ${requestId}`);
    const peers = request ? subtaskBudgetRequests(this.checkpoint.requests, request) : [];
    const used = peers.reduce((sum, row) => sum + (row.tool_response_bytes ?? 0), 0);
    return { historical_counter_bytes: b.tool_response_bytes, returned_content_bytes: delivered,
      historical_adjustment_bytes: this.checkpoint.tool_response_accounting?.adjustment_bytes ?? 0,
      scope: policy ? (request ? 'subtask' : 'accounting_only') : 'task_total',
      total_limit_bytes: policy ? null : b.max_tool_response_bytes,
      ...(policy && request ? { request_id: request.id, subtask_returned_bytes: used,
        ...(peers.length > 1 ? { scope_request_ids: peers.map(row => row.id), request_returned_bytes: request.tool_response_bytes ?? 0 } : {}),
        subtask_limit_bytes: policy.max_tool_response_bytes } : {}),
      remaining_bytes: policy ? (request ? Math.max(0, policy.max_tool_response_bytes - used) : null)
        : Math.max(0, b.max_tool_response_bytes - delivered) };
  }

  async appendEvent(eventType: string, payload: unknown): Promise<void> {
    await appendFile(join(this.root, 'session.events.jsonl'), `${JSON.stringify({ timestamp: new Date().toISOString(), event_type: eventType, payload })}\n`, 'utf8');
  }

  private async workingProgress() {
    const path = await this.authorPath('DELIVERY.json');
    const text = await readFile(path, 'utf8').catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
    let delivery: AcceptanceDelivery | undefined;
    if (text !== undefined) {
      try { delivery = parseAcceptanceDelivery(strictJsonParse(text)).delivery; } catch { /* The author can repair an incomplete draft. */ }
    }
    const methods: Record<string, string> = {};
    for (const name of [...new Set(delivery?.rules.flatMap(rule => rule.method_files) ?? [])].sort()) {
      try { methods[name] = sha256Text(await readFile(await this.authorPath(name), 'utf8')); }
      catch { methods[name] = 'unreadable'; }
    }
    const root = this.sources.find(source => source.source_id === this.checkpoint.source_sha256)!;
    const dispositions = new Map<string, AcceptanceDelivery['dispositions']>();
    for (const row of delivery?.dispositions ?? []) if (row.source_id === root.source_id) {
      dispositions.set(row.block_id, [...(dispositions.get(row.block_id) ?? []), row]);
    }
    const remaining = root.blocks.filter(block => {
      const rows = dispositions.get(block.id);
      return rows?.length !== 1 || rows[0]!.role === 'unresolved';
    });
    const approvedGroups = new Set((delivery?.groups ?? []).filter(group => {
      const groupFiles = Object.fromEntries((delivery?.rules ?? []).filter(rule => group.rule_ids.includes(rule.id))
        .flatMap(rule => rule.method_files).map(file => [file, methods[file]!]));
      return this.checkpoint.approvals.some(row => row.group_id === group.id
        && row.fingerprint === groupReviewFingerprint(delivery!, group, groupFiles, this.imageProofs(delivery!, group)));
    }).map(group => group.id));
    const approvedLots = new Set((delivery?.lots ?? []).filter(lot => approvedGroups.has(lot.group_id)).map(lot => lot.id));
    const pendingRequests = this.checkpoint.requests.filter(request => request.status !== 'passed'
      && (request.status === 'running' || !request.lot_ids.length || request.lot_ids.some(id => !approvedLots.has(id))));
    return { fingerprint: sha256Json({ delivery: delivery ?? (text === undefined ? null : sha256Text(text)), methods }),
      pendingRequests,
      continuation: { candidate_path: 'DELIVERY.json', draft_state: delivery ? 'readable' : text === undefined ? 'missing' : 'invalid',
        candidate_lots: delivery?.lots.length ?? 0, candidate_groups: delivery?.groups.length ?? 0,
        approved_candidate_lots: approvedLots.size, pending_candidate_lots: (delivery?.lots.length ?? 0) - approvedLots.size,
        sealed_structure_groups: (this.checkpoint.group_seals ?? []).filter(row => approvedGroups.has(row.group_id)
          && this.checkpoint.approvals.some(approval => approval.group_id === row.group_id && approval.fingerprint === row.group_fingerprint)).map(row => row.group_id),
        single_member_groups: delivery?.groups.filter(group => group.lot_ids.length === 1).length ?? 0,
        source_blocks: root.blocks.length, unresolved_source_blocks: remaining.length,
        next_source_blocks: remaining.slice(0, 3).map(block => ({ source_id: root.source_id, block_id: block.id,
          markdown: `source/${root.source_id}.md`, start_line: block.start_line, end_line: block.end_line })),
        groups_without_approval_receipts: (delivery?.groups ?? []).filter(group => !approvedGroups.has(group.id))
          .slice(0, 3).map(group => group.id),
        instruction: '定位只表示待办，不是业务结论或批准。先验证和处理当前样本的实际问题；继续读取尚未处置原文，沿用可用方法批量推进。不要只重复汇报，不为清零而改写处置。' } };
  }

  async snapshot(): Promise<{ checkpoint: string; working_plan_sha256: string; history_sequence: number; last_valid_fingerprint: string }> {
    const work = await this.workingProgress();
    const decisions = { reviews: this.checkpoint.requests.map(({ id, fingerprint, status, result, error }) => ({ id, fingerprint, status, result, error })),
      approvals: this.checkpoint.approvals, sample_reviews: this.checkpoint.sample_reviews,
      invalidations: this.checkpoint.invalidations, publications: this.checkpoint.publications, references: this.receipts,
      table_sweeps: this.checkpoint.table_sweeps, group_seals: this.checkpoint.group_seals,
      waiting_for_sources: this.checkpoint.waiting_for_sources, status: this.checkpoint.status,
      training_declarations: this.checkpoint.training_declarations };
    // Accounting and retries remain persisted, but cannot make a repeated report look like completed work.
    return { checkpoint: sha256Json({ work: work.fingerprint, decisions }), working_plan_sha256: work.fingerprint,
      history_sequence: this.checkpoint.generation, last_valid_fingerprint: sha256Json(decisions) };
  }

  async continuationPrompt(): Promise<string> {
    const { continuation } = await this.workingProgress();
    return `${ACCEPTANCE_BATCHING_GUIDANCE}\n交付尚未封存。保留现有草稿、回执、检查点及全部计数；本轮须执行下一项实际工作，不能仅重复上一批总结。${continuation.instruction}\n当前程序定位：${JSON.stringify(continuation)}\n`
      + '若草稿缺失或格式无效，先读取合同并修复作者文件；若当前组有具体错误，修复方法及所有受影响结果后验证。'
      + (this.lotSplit ? '全文拆分已冻结并登记，先 list_acceptance_lot_inputs 核对既有候选与待处理批，read_acceptance_lot_input 读单批原文。复用当前候选和有效回执，不重做全文发现。按冻结输入范围用已验证程序扫完同结构表；异常或新结构可 extract_acceptance_lot_batch，由宿主分配完整批输入并真实并发。不得以旧 not_extractable 处置漏掉拆分中的批、标题或表尾。' : '')
      + '若 sealed_structure_groups 为空，先收敛当前一类，修完明确失败、拆清共享方法与逐实例配置，完成小样→sweep_acceptance_tables 全量程序处理→真正留出→seal_acceptance_group，期间不扩大其他结构类。历史已见不全列为必审，失败范围不能缩掉。已有类封存后再从尚未处置的位置扩大下一类；不预设一个来源块就是一个检验批。'
      + '没有剩余来源位置时，核对具体问题、尚未批准的组及依赖，闭合后调用 seal_acceptance_delivery，不以汇报代替终结工具。'
      + '已通过且未变化的内容沿用回执；确实缺少必要正文时先做其他独立工作，仅在无可继续工作时正常暂停。最终仍须通过原有校验、独立审查和封存，不能改原文或通过标准。';
  }

  state(): AcceptanceCheckpoint { return structuredClone(this.checkpoint); }
  async recordReviewContextRead(requestId: string, blockIds: string[]): Promise<void> {
    const request = this.checkpoint.requests.find(row => row.id === requestId);
    if (!request) throw new Error('Review source exposure requires a registered request.');
    const rootIds = new Set(this.sources[0]!.blocks.map(block => block.id));
    const ids = [...new Set(blockIds.filter(id => rootIds.has(id)))].sort();
    if (ids.length && appendTrainingDeclarations(request.exposed_lots ??= [], [{ lot_id: requestId, block_ids: ids }])) {
      await this.save(); await this.appendEvent('review_context_exposure_recorded', { request_id: requestId, block_ids: ids, counters_reset: false });
    }
  }
  /** Only material actually returned to the author counts; deterministic sweep internals do not. */
  async observeAuthorRead(tool: string, params: Record<string, unknown>, result: { content: Array<{ type: string; text?: string }> }, requestId?: string): Promise<void> {
    if (!['read', 'bash'].includes(tool)) return;
    const returned = result.content.filter(row => row.type === 'text').map(row => row.text ?? '').join('\n');
    if (!returned) return;
    const source = this.sources[0]!, path = String(params.path ?? '').replaceAll('\\', '/');
    const offset = Number(params.offset ?? 1);
    const directMarkdown = tool === 'read' && path.endsWith(`source/${source.source_id}.md`);
    const directLedger = tool === 'read' && path.endsWith(`source/${source.source_id}.json`);
    const directBlocks = new Set(directMarkdown || directLedger ? sourceReadExposure(source,
      await readFile(join(this.sourceRoot, `${source.source_id}.${directLedger ? 'json' : 'md'}`), 'utf8'),
      directLedger ? 'ledger' : 'markdown', offset, returned) : []);
    const quotedBlocks = new Set<string>();
    const observeQuotes = (value: unknown): void => {
      if (Array.isArray(value)) value.forEach(observeQuotes);
      else if (value && typeof value === 'object') {
        const row = value as Record<string, unknown>;
        if (row.source_id === source.source_id && typeof row.block_id === 'string' && typeof row.text === 'string'
          && verifySourceQuote([source], row as unknown as import('./contracts.js').SourceQuote)) quotedBlocks.add(row.block_id);
        Object.values(row).forEach(observeQuotes);
      }
    };
    try { observeQuotes(JSON.parse(returned)); } catch { /* Custom summaries still require explicit exposure declarations. */ }
    // IDs/counts alone are discovery metadata, not source exposure. Arbitrary custom
    // summaries still require the agent's explicit record_acceptance_exposure declaration.
    const blocks = source.blocks.filter(block => directBlocks.has(block.id) || quotedBlocks.has(block.id)
      || (block.text.length >= 24 && (returned.includes(block.text) || returned.includes(JSON.stringify(block.text)))));
    if (!blocks.length) return;
    const request = requestId ? this.checkpoint.requests.find(row => row.id === requestId) : undefined;
    if (requestId && !request) throw new Error('Source read exposure requires an existing request.');
    const history = request ? (request.exposed_lots ??= []) : (this.checkpoint.training_declarations ??= []);
    if (appendTrainingDeclarations(history, [{ lot_id: requestId ?? 'author-source-read', block_ids: blocks.map(block => block.id).sort() }])) {
      await this.save(); await this.appendEvent('author_source_exposure_recorded', { tool, request_id: requestId, block_count: blocks.length, counters_reset: false });
    }
  }
  async updateParallelActivity(kind: 'extraction' | 'review', counts: { queued: number; running: number }): Promise<void> {
    this.activity[kind] = counts;
    const snapshot = structuredClone(this.activity);
    const save = this.activityQueue.then(() => atomicWriteJson(join(this.root, 'parallel-activity.json'), snapshot));
    this.activityQueue = save.catch(() => undefined); await save;
  }
  result(): { sealed: boolean } { return { sealed: ['partial', 'complete'].includes(this.checkpoint.status) }; }

  observeContext(tokens: number, requestId?: string): void {
    if (Number.isFinite(tokens) && tokens > 0) {
      this.currentContextTokens.set(requestId ?? 'author', tokens);
      this.checkpoint.budget.observed_context_tokens = Math.max(this.checkpoint.budget.observed_context_tokens, tokens);
    }
  }

  /** Called only after the SDK inspects a fresh window or confirms successful compaction. */
  contextReady(tokens: number, requestId?: string): void {
    if (!Number.isFinite(tokens) || tokens < 0 || tokens >= this.checkpoint.budget.max_observed_context_tokens) throw new Error('context_window_not_ready: inspect or compact the actual SDK window first; history retained.');
    this.currentContextTokens.set(requestId ?? 'author', tokens);
  }

  assertSources(): Promise<void> {
    // Integrity reads and checkpoint replacement share one gate. Parallel workers must not
    // compare an in-flight new checkpoint against its previous protected hash.
    const check = this.saveQueue.then(() => this.verifySources());
    this.saveQueue = check.catch(() => undefined);
    return check;
  }

  private async verifySources(): Promise<void> {
    await verifySourceImages(this.sourceRoot, this.checkpoint.source_image_manifests);
    await verifyFrozenEditionProofs(this.sourceRoot, this.sourceEditions, this.sources);
    for (const [path, expected] of this.protectedFiles) if (sha256Text(await readFile(path, 'utf8')) !== expected) throw new Error('Protected source/controller state changed; execution is blocked.');
    if (sha256Json(JSON.parse(await readFile(join(this.workRoot, 'DELIVERY.schema.json'), 'utf8'))) !== sha256Json(ACCEPTANCE_DELIVERY_SCHEMA)) throw new Error('Protected source contract changed; execution is blocked.');
    if (sha256Text(await readFile(this.options.markdownPath, 'utf8')) !== this.checkpoint.source_sha256) throw new Error('Original source changed; execution is blocked.');
    for (const source of this.sources) {
      const markdown = await readFile(join(this.sourceRoot, `${source.source_id}.md`), 'utf8');
      assertEditionProofPresent(source.source_id, markdown, this.checkpoint.source_sha256, this.sourceEditions);
      if (sha256Text(markdown) !== source.sha256
        || sha256Json(JSON.parse(await readFile(join(this.sourceRoot, `${source.source_id}.json`), 'utf8'))) !== sha256Json(source)) {
        throw new Error('Read-only source/ledger changed; execution is blocked.');
      }
    }
  }

  async authorPath(path: string, writing = false): Promise<string> {
    const target = resolve(this.workRoot, path);
    const rel = relative(this.workRoot, target);
    if (!rel || rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel)) throw new Error('Path must stay in this task work directory.');
    if (writing && (rel.split(/[\\/]/u)[0] === 'source' || rel === 'DELIVERY.schema.json')) throw new Error('Sources and delivery contract are read-only.');
    // Resolve existing ancestors so symlinks cannot turn a safe-looking path into a write elsewhere.
    let ancestor = target;
    while (true) {
      try {
        const real = await realpath(ancestor);
        const within = relative(await realpath(this.workRoot), real);
        if (within === '..' || within.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(within)) throw new Error('Path escapes the task through a symbolic link.');
        if (writing && (within.split(/[\\/]/u)[0] === 'source' || within === 'DELIVERY.schema.json')) throw new Error('Sources and delivery contract are read-only, including aliases.');
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || ancestor === dirname(ancestor)) throw error;
        ancestor = dirname(ancestor);
      }
    }
    return target;
  }

  async beginSession(): Promise<void> {
    // Provider history is inspected/compacted before any tool; a historical peak is never erased.
    await this.commitReturnedBytes(0, false);
    if (!this.checkpoint.task_session_start_policy && this.checkpoint.budget.attempts >= this.checkpoint.budget.max_attempts) throw new Error('Autonomous session attempt budget exhausted; checkpoint preserved.');
    this.checkpoint.budget.attempts += 1;
    this.checkpoint.status = 'working';
    await this.save();
  }

  async accountTool(bytes: number, contextTokens = 0, requestId?: string): Promise<void> {
    this.observeContext(contextTokens, requestId);
    await this.commitReturnedBytes(bytes, true, requestId);
  }

  async accountErrorResponse(bytes: number, requestId?: string): Promise<void> { await this.commitReturnedBytes(bytes, false, requestId); }

  private async commitReturnedBytes(bytes: number, checkContext: boolean, requestId?: string): Promise<void> {
    const b = this.checkpoint.budget;
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('Tool response byte count must be a nonnegative integer.');
    const usage = this.toolResponseUsage(requestId);
    if (bytes > b.max_single_tool_response_bytes) throw new Error(`autonomous_response_too_large: actual=${bytes}, max_single=${b.max_single_tool_response_bytes}; request a smaller range or summary; omitted content is not charged.`);
    const request = requestId ? this.checkpoint.requests.find(row => row.id === requestId) : undefined;
    const localExceeded = this.checkpoint.subtask_budget_policy && request && checkContext
      && (bytes > usage.remaining_bytes! || (bytes === 0 && usage.remaining_bytes === 0));
    const activeContext = this.currentContextTokens.get(requestId ?? 'author') ?? (requestId ? 0 : b.observed_context_tokens);
    const contextExceeded = checkContext && activeContext >= b.max_observed_context_tokens;
    const exceeded = !this.checkpoint.subtask_budget_policy && (bytes > usage.remaining_bytes! || (bytes === 0 && usage.remaining_bytes === 0));
    if (exceeded || (contextExceeded && !requestId)) this.checkpoint.status = 'blocked';
    if (!exceeded && !localExceeded && !contextExceeded) {
      this.checkpoint.budget.tool_response_bytes += bytes;
      if (request && this.checkpoint.subtask_budget_policy) request.tool_response_bytes = (request.tool_response_bytes ?? 0) + bytes;
    }
    await this.save();
    if (contextExceeded) throw new Error(`autonomous_context_window_exceeded: ${JSON.stringify({ current_context_tokens: activeContext,
      historical_peak_tokens: b.observed_context_tokens, max_context_tokens: b.max_observed_context_tokens,
      scope: requestId ?? 'author' })}; SDK window must compact before continuing; history and counters retained.`);
    if (localExceeded) throw new Error(`autonomous_subtask_budget_exceeded: ${JSON.stringify({ ...usage, attempted_response_bytes: bytes })}; only this request is stopped; checkpoint and all counters retained.`);
    if (exceeded) throw new Error(`autonomous_budget_exceeded: ${JSON.stringify({ ...b, ...usage, attempted_response_bytes: bytes })}; checkpoint retained, no counter reset.`);
  }

  dispatch(name: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const next = this.queue.then(() => this.execute(name, params, signal));
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async execute(name: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    signal?.throwIfAborted();
    await this.assertSources();
    if (name === 'survey_acceptance_source' || name === 'read_acceptance_source_block') {
      const source = this.sources.find(row => row.source_id === (params.source_id ?? this.checkpoint.source_sha256));
      if (!source) return { ok: false, error: 'unknown_registered_source', actual: params.source_id,
        expected: this.sources.map(row => row.source_id), writable: 'source_id', next_tool: 'acceptance_workspace' };
      if (name === 'survey_acceptance_source') {
        const offset = Math.max(0, Number(params.offset) || 0), limit = Math.min(80, Math.max(1, Number(params.limit) || 30));
        return { ok: true, source_id: source.source_id, total_blocks: source.blocks.length,
          counts: source.blocks.reduce<Record<string, number>>((counts, block) => { counts[block.kind] = (counts[block.kind] ?? 0) + 1; return counts; }, {}),
          blocks: source.blocks.slice(offset, offset + limit).map(({ id, kind, start_line, end_line, features, text }) =>
            ({ id, kind, start_line, end_line, features, characters: text.length, ...(kind === 'heading' ? { heading: text } : {}) })),
          next_offset: offset + limit < source.blocks.length ? offset + limit : null,
          next_tool: 'read_acceptance_source_block', instruction: '这是结构索引，不含表内答案。选择少量代表及必要相邻块读取；已读正文计入曝光，保留其他同类成员供独立留出。规划、归属与语义由模型判断。' };
      }
      const block = source.blocks.find(row => row.id === params.block_id);
      if (!block) return { ok: false, error: 'unknown_source_block', actual: params.block_id,
        expected: 'Registered block ID from survey_acceptance_source', writable: 'block_id', next_tool: 'survey_acceptance_source' };
      const start = Math.max(0, Number(params.start) || 0), length = Math.min(12000, Math.max(1, Number(params.length) || 6000));
      if (start >= block.text.length) return { ok: false, error: 'source_block_offset_out_of_range', actual: start,
        expected: { minimum: 0, exclusive_maximum: block.text.length }, writable: 'start / length', next_tool: 'read_acceptance_source_block' };
      if (source === this.sources[0] && appendTrainingDeclarations(this.checkpoint.training_declarations ??= [], [{ lot_id: 'scoped-source-read', block_ids: [block.id] }])) await this.save();
      const end = Math.min(start + length, block.text.length);
      return { ok: true, source_id: source.source_id, block_id: block.id, kind: block.kind, start, end,
        text: block.text.slice(start, end), total_characters: block.text.length, next_start: end < block.text.length ? end : null,
        coordinate_basis: 'block-local UTF-16; these start/end/text can be used directly as SourceQuote', exposure_recorded: source === this.sources[0] };
    }
    if (name === 'open_acceptance_source_page') return this.openOriginalSourcePage(params, signal);
    if (name === 'acceptance_workspace') {
      const progress = await this.workingProgress();
      return { ok: true, workspace: this.workRoot, source_index: this.sources.map(source => ({ source_id: source.source_id,
      markdown: `source/${source.source_id}.md`, ledger: `source/${source.source_id}.json`, blocks: source.blocks.length,
      discovery_tool: 'survey_acceptance_source', scoped_read_tool: 'read_acceptance_source_block',
      original_page_tool: 'open_acceptance_source_page',
      ...(this.checkpoint.source_image_manifests?.[source.source_id] ? { images: `source/${sourceImageManifestName(source.source_id, this.checkpoint.source_image_manifests[source.source_id]!)}` } : {}) })),
      contract_overview: { delivery: 'schema_version=acceptance-autonomous-delivery/v1, source_sha256, rules[], groups[], lots[], dispositions[], references[], problems[]',
        quote: 'source_id, block_id, start, end, text（块内 UTF-16）', bound: 'value, evidence:quote[], mode?:literal|summary, reason?；空值须说明原因',
        lot: 'id, name:bound, ancestors:[{id,name:bound,kind:分部|子分部|分项}], scope:{block_ids,reason,evidence}, group_id, dependency_ids, items[]',
        item: 'id, name/category/requirement/method/quantity/unit/condition/note:bound, inspection_data_type:measurement|counting|mixed|review, inspection_data_type_reason, sampling:{status,text:bound,conditions:bound[],formula?}, reference_ids, rule_ids',
        rule: 'id, method_files, scope, exceptions, evidence, relationship?', group: 'id, structure, rule_ids, lot_ids, trial_lot_ids, boundary_lot_ids, conditions, exclusions',
        disposition: 'source_id, block_id, role:lot|shared|not_extractable|unresolved, lot_ids, reason, evidence',
        details: '其余字段按需用脚本读取 DELIVERY.schema.json 的 properties.<集合>.items.properties，避免输出整份 schema。' },
      schema: 'DELIVERY.schema.json', budget: { ...this.checkpoint.budget,
        ...(this.checkpoint.subtask_budget_policy ? { max_tool_response_bytes: null,
          historical_total_cap_bytes: this.checkpoint.budget.max_tool_response_bytes,
          max_subtask_tool_response_bytes: this.checkpoint.subtask_budget_policy.max_tool_response_bytes } : {}) },
      session_start_usage: { scope: this.checkpoint.task_session_start_policy ? 'accounting_only' : 'whole_task',
        total_limit: this.checkpoint.task_session_start_policy ? null : this.checkpoint.budget.max_attempts,
        attempts: this.checkpoint.budget.attempts, per_request_attempt_limit: this.checkpoint.budget.max_attempts },
      tool_response_usage: this.toolResponseUsage(), status: this.checkpoint.status,
      lot_split: this.checkpoint.lot_split ? { ...this.checkpoint.lot_split, input_path: `source/lot-split.${this.checkpoint.lot_split.sha256}.json`,
        instruction: '此只读文件包含全部 lot/shared/non_lot/unresolved 精确来源，供程序逐批处理和全文底账核对；用脚本按 ID/范围读取，不整份打印。原拆分不重做，字段仍须验证和独立复核。' } : undefined,
      continuation_objective: this.checkpoint.subtask_budget_policy?.reason ?? this.checkpoint.budget_extensions?.at(-1)?.reason,
      continuation: progress.continuation,
      training_history: { initialized: this.checkpoint.training_declarations !== undefined,
        declared_source_scopes: this.checkpoint.training_declarations?.length ?? 0,
        legacy_candidates_conservatively_seen: Boolean(this.checkpoint.training_declaration_initialization),
        instruction: '已见只影响留出资格；trial/boundary 只列本轮代表/边界必审。其他已见用 record_acceptance_exposure 追加保存，历史不删除。明确失败另由程序按原文范围强制必审，删标签、改名或换组不能绕过或恢复未见资格。原批准回执按当前依赖核验并复用。' },
      pending_requests: progress.pendingRequests.slice(-12), pending_request_count: progress.pendingRequests.length,
      historical_request_count: this.checkpoint.requests.length };
    }
    if (name === 'report_acceptance_progress') {
      await this.options.onProgress?.(String(params.message)); return { ok: true };
    }
    if (name === 'list_acceptance_lot_inputs' || name === 'read_acceptance_lot_input') {
      if (!this.lotSplit) return { ok: false, error: 'No registered split; inspect the original block index and plan candidate boundaries.', next_tool: 'survey_acceptance_source' };
      if (name === 'read_acceptance_lot_input') {
        const inputs = lotSplitInputs(this.lotSplit);
        let input = inputs.find(row => row.id === params.lot_id);
        if (!input) {
          const path = await this.authorPath(String(params.path ?? 'DELIVERY.json'), true);
          const text = await readFile(path, 'utf8').catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
          const delivery = text ? parseAcceptanceDelivery(strictJsonParse(text)).delivery : undefined;
          const matches = mapSplitCandidates(this.lotSplit, this.sources[0]!, delivery).filter(row => row.candidate_ids.includes(String(params.lot_id)));
          if (matches.length === 1) input = inputs.find(row => row.id === matches[0]!.id);
        }
        if (input && appendTrainingDeclarations(this.checkpoint.training_declarations ??= [], [{ lot_id: input.id, block_ids: [...new Set(input.source.map(piece => piece.block_id))].sort() }])) await this.save();
        return input ? { ok: true, ...lotInputPage(input, Number(params.offset ?? 0), Number(params.limit ?? 20)), semantic_approval: false } : { ok: false, error: 'split_input_not_unique', actual: { lot_id: params.lot_id },
          expected: '提供登记的拆分 ID，或唯一对应一个拆分输入的既有候选 ID；归属冲突先按原文修订作者 scope。', writable: 'lot_id 或作者 DELIVERY.json#/lots/*/scope；冻结拆分与检查点不可写',
          next_tool: 'list_acceptance_lot_inputs', next_tool_arguments: { path: String(params.path ?? 'DELIVERY.json'), query: String(params.lot_id) } };
      }
      const path = await this.authorPath(String(params.path ?? 'DELIVERY.json'), true);
      const text = await readFile(path, 'utf8').catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
      const rows = mapSplitCandidates(this.lotSplit, this.sources[0]!, text ? parseAcceptanceDelivery(strictJsonParse(text)).delivery : undefined);
      const query = String(params.query ?? '').trim().toLowerCase();
      const selected = rows.filter(row => (!params.status || row.status === params.status)
        && (!query || [row.id, row.name, ...row.candidate_ids].some(text => text.toLowerCase().includes(query))));
      const offset = Math.max(0, Number(params.offset) || 0), limit = Math.min(30, Math.max(1, Number(params.limit) || 20));
      return { ok: true, total: rows.length, pending: rows.filter(row => row.status === 'pending').length,
        source_status: 'registered_and_hash_verified',
        instruction: 'missing_body_blocks means not yet covered by an extracted candidate, NOT missing original source. Read registered source with read_acceptance_lot_input; offset/limit paginate body and shared material.',
        candidates: rows.filter(row => row.status === 'candidate').length, conflicts: rows.filter(row => row.status === 'conflict').length,
        rows: selected.slice(offset, offset + limit), next_offset: offset + limit < selected.length ? offset + limit : null };
    }
    if (name === 'parallel_acceptance_extract' || name === 'extract_acceptance_lot_batch') {
      if (!this.options.extractor) throw new Error('Extraction worker runtime unavailable; host must supply the configured model runtime.');
      const path = await this.authorPath(String(params.path ?? 'DELIVERY.json'), true);
      let tasks = (params.tasks as ExtractionTask[] | undefined)?.map(({ split_input: _untrusted, ...task }) => task) ?? [];
      if (name === 'extract_acceptance_lot_batch') {
        if (!this.lotSplit) throw new Error('Host must register the complete split before batch extraction.');
        const delivery = parseAcceptanceDelivery(strictJsonParse(await readFile(path, 'utf8'))).delivery;
        const rows = mapSplitCandidates(this.lotSplit, this.sources[0]!, delivery);
        const requested = params.lot_ids as string[] | undefined;
        if (requested?.some(id => !rows.some(row => row.id === id && row.status === 'pending')))
          return { ok: false, error: 'Only pending split IDs may be dispatched; existing candidates must be repaired in place.', next_tool: 'list_acceptance_lot_inputs' };
        const pending = rows.filter(row => row.status === 'pending' && (!requested || requested.includes(row.id))).slice(0, this.checkpoint.budget.concurrency);
        if (!pending.length) return { ok: true, dispatched: 0, next_tool: 'list_acceptance_lot_inputs' };
        const inputs = lotSplitInputs(this.lotSplit);
        tasks = pending.map(row => {
          const input = inputs.find(item => item.id === row.id)!;
          if (input.unresolved.length || input.source.some(piece => piece.start !== 0 || piece.end !== this.sources[0]!.blocks.find(block => block.id === piece.block_id)!.text.length))
            throw new Error(`Split ${input.id} needs range-aware author processing before parallel admission; use read_acceptance_lot_input, preserve every interval and unresolved issue.`);
          return { id: `lot-${sha256Text(input.id).slice(0, 24)}`, block_ids: row.block_ids,
            instruction: String(params.instruction ?? 'Extract exactly this frozen business lot; preserve all source boundaries. Reuse supplied methods, report concrete exceptions, and do not infer unavailable external requirements.'),
            method_files: (params.method_files as string[] | undefined) ?? [],
            split_input: { id: input.id, name: input.name, source: input.source, shared: input.shared.map(item => ({ id: item.id, source: item.source })) } };
        });
      }
      if (this.options.requireExecutableTableTrials) {
        const draft = parseAcceptanceDelivery(strictJsonParse(await readFile(path, 'utf8'))).delivery;
        const active = draft?.groups.find(group => group.trial_lot_ids.length && !this.checkpoint.approvals.some(row => row.group_id === group.id)
          && draft.lots.some(lot => lot.group_id === group.id && lot.scope.block_ids.some(id => this.sources[0]!.blocks.some(block => block.id === id && block.kind === 'table'))));
        if (draft && active) {
          const exceptionBlocks = new Set(draft.problems.flatMap(problem => [...problem.block_ids,
            ...draft.lots.filter(lot => problem.affected_lot_ids.includes(lot.id)).flatMap(lot => lot.scope.block_ids)]));
          const routine = tasks.filter(task => !task.block_ids.some(id => exceptionBlocks.has(id)));
          if (routine.length) return { ok: false, error: 'first_class_workflow_required', model_started: false,
            actual: { unfinished_group_id: active.id, routine_task_ids: routine.map(task => task.id) },
            expected: 'Complete the current representative method experiment and semantic trial, then program-batch matching tables before expanding routine model work.',
            writable: 'Author method, current sample, groups and concrete source-bound problems; checkpoints/receipts are read-only.',
            next_tool: 'sweep_acceptance_tables', next_tool_arguments: { path: String(params.path ?? 'DELIVERY.json'), group_id: active.id },
            instruction: '先用代表表头发现清单，再 experiment_acceptance_table_method → trial 复核 → 同类 sweep → complete 留出。确有需要模型处理的语义/结构异常，先在 problems 记录具体问题及来源范围，异常仍可单独派发。不能为绕过此反馈虚构问题或删除已知失败。' };
        }
      }
      const result = await runParallelExtraction({ root: this.root, workRoot: this.workRoot, sources: this.sources,
        checkpoint: this.checkpoint, extractor: this.options.extractor,
        sourceIndex: this.sources.map(source => ({ source_id: source.source_id, markdown: `source/${source.source_id}.md`, ledger: `source/${source.source_id}.json`,
          ...(this.checkpoint.source_image_manifests?.[source.source_id] ? { images: `source/${sourceImageManifestName(source.source_id, this.checkpoint.source_image_manifests[source.source_id]!)}` } : {}) })),
        save: () => this.save(), assertSources: () => this.assertSources(), account: id => this.accountTool(0, 0, id), event: (type, payload) => this.appendEvent(type, payload),
        activity: counts => this.updateParallelActivity('extraction', counts),
      }, path, tasks, signal);
      // Valid proposals declare their actual training samples through the existing append-only protocol.
      const text = await readFile(path, 'utf8'), delivery = parseAcceptanceDelivery(strictJsonParse(text)).delivery;
      if (delivery) await this.ensureTrainingDeclarations(delivery, text);
      if (name === 'extract_acceptance_lot_batch') {
        for (const row of result.results) if (row.next_tool === 'parallel_acceptance_extract') {
          const task = tasks.find(task => task.id === row.task_id) as ExtractionTask | undefined;
          row.next_tool = 'extract_acceptance_lot_batch';
          row.next_tool_arguments = { path: String(params.path ?? 'DELIVERY.json'), lot_ids: task?.split_input ? [task.split_input.id] : [],
            method_files: params.method_files ?? [], ...(params.instruction ? { instruction: params.instruction } : {}) };
        }
      }
      return result;
    }
    const path = await this.authorPath(String(params.path ?? 'DELIVERY.json'));
    const deliveryText = await readFile(path, 'utf8');
    const data = strictJsonParse(deliveryText);
    const checked = validateAcceptanceDelivery(data, { sources: this.sources, root_source_id: this.checkpoint.source_sha256, resolved_references: this.receipts });
    if (checked.delivery && this.lotSplit) checked.issues.push(...splitDeliveryIssues(this.lotSplit, this.sources[0]!, checked.delivery)
      .filter(issue => issue.affected_lot_ids.length));
    if (checked.delivery && this.lotSplit) checked.issues.push(...splitReviewReadinessIssues(this.lotSplit, this.sources[0]!, checked.delivery));
    this.lastIssues = checked.issues;
    if (!checked.delivery) return { ok: false, ...await this.issuePage(checked.issues), next_tool: 'validate_acceptance_delivery' };
    const delivery = checked.delivery;
    await this.ensureTrainingDeclarations(delivery, deliveryText);
    if (name === 'record_acceptance_exposure') {
      const ids = params.lot_ids as string[];
      if (!Array.isArray(ids) || !ids.length || ids.some(id => !delivery.lots.some(lot => lot.id === id)) || !String(params.reason ?? '').trim()) {
        return { ok: false, error: '提供当前真实 lot_ids 及实际参与查看/规则修正的 reason；历史记录不能删除或变成未见。', next_tool: 'record_acceptance_exposure' };
      }
      const scopes = sourceExposures(delivery, this.sources[0]!, ids);
      if (appendTrainingDeclarations(this.checkpoint.training_declarations!, scopes)) {
        await this.save(); await this.appendEvent('historical_exposure_recorded', { scopes, reason: params.reason, counters_reset: false });
      }
      return { ok: true, historical_seen_lot_ids: ids, required_review_samples_unchanged: true, semantic_approval: false,
        instruction: '历史已见已追加保留。groups.trial_lot_ids/boundary_lot_ids 只列本轮代表/边界必审样本；明确失败由程序另外强制追踪。' };
    }
    if (name === 'sweep_acceptance_tables' || name === 'experiment_acceptance_table_method') {
      const isTrial = name === 'experiment_acceptance_table_method';
      const group = delivery.groups.find(row => row.id === params.group_id);
      if (!group) return { ok: false, error: 'Unknown group_id; choose the structure class whose trial will be used.', next_tool: 'acceptance_workspace' };
      const wholePlan = planTableSweep(this.sources[0]!, String(params.sample_block_id), Number(params.header_row_index), delivery);
      const required = requiredReviewLotIds(delivery, group, (await this.failurePlan(delivery)).unresolved);
      const trialBlocks = new Set(delivery.lots.filter(lot => required.includes(lot.id)).flatMap(lot => lot.scope.block_ids));
      const plan = isTrial ? { ...wholePlan, matches: wholePlan.matches.filter(row => trialBlocks.has(row.block_id)) } : wholePlan;
      const trialIds = isTrial ? delivery.lots.filter(lot => required.includes(lot.id)
        && lot.scope.block_ids.some(id => plan.matches.some(row => row.block_id === id))).map(lot => lot.id) : [];
      if (isTrial && !trialIds.length) return { ok: false, error: 'method_trial_samples_required',
        actual: { required_lot_ids: required, matching_sample_tables: plan.matches.length },
        expected: 'Declare a real representative/boundary sample in this group and select its structural header; the host includes unresolved failed sample scopes.',
        writable: 'groups[].trial_lot_ids / boundary_lot_ids and sample_block_id / header_row_index; source and exposure history are immutable', next_tool: 'validate_acceptance_delivery' };
      const matchingBlocks = new Set(plan.matches.map(row => row.block_id));
      const lotInputs = this.lotSplit ? lotSplitInputs(this.lotSplit).filter(input => input.source.some(piece => matchingBlocks.has(piece.block_id))) : undefined;
      const planPath = `diagnostics/table-sweep-${sha256Json(plan)}.json`;
      await mkdir(join(this.workRoot, 'diagnostics'), { recursive: true });
      await atomicWriteJson(join(this.workRoot, planPath), plan);
      if (!params.program_file) return { ok: true, plan_only: true, manifest: planPath, scanned_tables: plan.scanned_table_count,
        matching_tables: plan.matches.length, unparsed_tables: plan.unparsed_block_ids.length, header_match_policy: plan.header_match_policy,
        program_contract: TABLE_SWEEP_PROGRAM_CONTRACT,
        ...(lotInputs ? { complete_lot_inputs: lotInputs.length } : {}),
        instruction: '清单由程序扫描全部表格生成；不手填目标列表。写 Node .mjs 方法及按实例分开的配置，读取 request.json/source_ledger/DELIVERY.input.json，输出 DELIVERY.output.json 与 sweep.results.json；每个 match 必须 processed 或带具体问题的 exception。先 experiment_acceptance_table_method 实际重建小样，再 phase=trial 语义复核，通过后调用本工具 program_file 执行同类全量。未解析表格仍是原文待办，具体例外交回模型判断，不硬填整批要求值。' };
      const methods = [...new Set(delivery.rules.filter(rule => group.rule_ids.includes(rule.id)).flatMap(rule => rule.method_files))];
      const files = params.method_files as string[];
      if (!Array.isArray(files) || !files.includes(String(params.program_file)) || files.some(file => !methods.includes(file))) return {
        ok: false, error: 'sweep_dependencies_not_bound', actual: { program_file: params.program_file, method_files: files, declared_methods: methods },
        expected: '程序及实际导入/配置依赖都须通过本组通用规则或对应实例规则的 method_files 绑定；实例规则只由相应批 dependency_ids/item.rule_ids 使用。',
        writable: 'rules[].method_files / lots[].dependency_ids / items[].rule_ids 与本次参数', next_tool: 'validate_acceptance_delivery' };
      const { fingerprints } = await this.sampleFingerprints(delivery, group, required);
      const failures = await reviewObligations(this.root, delivery, this.checkpoint.requests);
      const missing = required.filter(id => !this.checkpoint.sample_reviews?.some(receipt => receipt.group_id === group.id && receipt.lot_id === id
        && receipt.fingerprint === fingerprints[id] && sampleReceiptAccepted(receipt, this.checkpoint.requests)
        && receiptPostdatesFailures(receipt.request_id, id, this.checkpoint.requests, failures)));
      if (!isTrial && this.options.requireExecutableTableTrials) {
        const gate = await this.executableTrialGate(delivery, group, required);
        if (gate) return gate;
      }
      if (!isTrial && missing.length) return { ok: false, error: 'sweep_trial_required', actual: { missing_lot_ids: missing },
        expected: '当前通用方法、相关实例配置和明确失败修复先通过小样；不重审仅因历史已见的全部候选。', next_tool: 'review_acceptance_group',
        next_tool_arguments: { path: String(params.path ?? 'DELIVERY.json'), group_id: group.id, phase: 'trial' } };
      let result: Awaited<ReturnType<typeof executeTableSweep>>;
      try {
        result = await executeTableSweep({ root: this.root, workRoot: this.workRoot, sourceRoot: this.sourceRoot, path,
          groupId: group.id, plan, programFile: String(params.program_file), methodFiles: files, assertSources: () => this.assertSources(),
          ...(isTrial ? { trialLotIds: trialIds } : {}),
          ...(lotInputs ? { lotInputs } : {}), ...(signal ? { signal } : {}) });
      } catch (error) {
        if (error instanceof TableSweepOutputError) return error.feedback;
        throw error;
      }
      const output = validateAcceptanceDelivery(result.delivery, { sources: this.sources, root_source_id: this.checkpoint.source_sha256, resolved_references: this.receipts });
      const structural = output.issues.filter(issue => !['unresolved_source', 'unresolved_reference', 'reference_receipt_required'].includes(issue.code)
        && !issue.code.startsWith('pending_') && !checked.issues.some(old => sha256Json(old) === sha256Json(issue)));
      if (this.lotSplit) {
        const newIds = new Set(result.delivery.lots.filter(lot => !delivery.lots.some(old => old.id === lot.id)).map(lot => lot.id));
        structural.push(...splitDeliveryIssues(this.lotSplit, this.sources[0]!, result.delivery).filter(issue => issue.affected_lot_ids.some(id => newIds.has(id))));
      }
      if (structural.length) return { ok: false, error: 'sweep_output_validation_failed', isolated_work: result.directory,
        ...await this.issuePage(structural), writable: 'author program/configuration; correct and rerun the sweep', next_tool: 'validate_acceptance_delivery' };
      const protectedChanges: Array<{ group_id: string; lot_ids: string[] }> = [];
      for (const approval of this.checkpoint.approvals) {
        const approvedGroup = delivery.groups.find(row => row.id === approval.group_id);
        if (!approvedGroup || await this.groupFingerprint(delivery, approvedGroup) !== approval.fingerprint) continue;
        const proposedGroup = result.delivery.groups.find(row => row.id === approvedGroup.id);
        const changedIds = approvedGroup.lot_ids.filter(id => !proposedGroup?.lot_ids.includes(id)
          || !result.delivery.lots.some(lot => lot.id === id)
          || reviewedFactsFingerprint(delivery, approvedGroup, id, this.imageManifests)
            !== reviewedFactsFingerprint(result.delivery, proposedGroup!, id, this.imageManifests));
        if (changedIds.length) protectedChanges.push({ group_id: approvedGroup.id, lot_ids: changedIds });
      }
      if (protectedChanges.length) {
        // A successful process exit must not silently undo an independently approved
        // semantic repair. Keep the proposed output inspectable, outside the live draft.
        const proposedPath = `diagnostics/${result.id.replace(':', '_')}-unmerged-output.json`;
        await atomicWriteJson(join(this.workRoot, proposedPath), result.delivery);
        return { ok: false, error: 'sweep_output_conflicts_with_approved_candidates', merged: false, model_started: false, counters_reset: false,
          actual: { changed_approved_groups: protectedChanges, proposed_output: proposedPath },
          expected: 'Program output must preserve the current independently approved facts, including model-added fields and references. Process success alone is not permission to replace them.',
          writable: 'Author program/configuration and an explicitly inspected author candidate only; approvals, history and execution receipts remain read-only.',
          next_tool: 'read', next_tool_arguments: { path: proposedPath },
          instruction: '先比较隔离输出和当前 DELIVERY.json。程序未覆盖的模型补充不应被旧程序抹掉；修程序后再实验，或保留当前完整候选，在全成员复核有效时用 seal_acceptance_group mode=semantic_exception、reason 说明模型补充范围。若确要采用不同的新输出，作者先检查并显式修改候选，再验证和复核；不靠反复重跑旧程序覆盖已通过结果，不缩小已扫描范围或删除失败历史。' };
      }
      try { await installSweepArtifacts(this.workRoot, result.artifacts); }
      catch (error) { return { ok: false, error: 'sweep_artifact_transfer_failed', actual: { message: String(error), files: Object.keys(result.artifacts).slice(0, 8) },
        expected: 'Newly referenced instance files must exist inside the isolated work directory and must not overwrite different existing author files.',
        writable: 'Author program and rules[].method_files; choose distinct instance paths and rerun. Existing files, checkpoint and receipt remain unchanged.',
        next_tool: 'read', next_tool_arguments: { path: String(params.program_file) }, merged: false, counters_reset: false }; }
      const trialFingerprints = isTrial ? (await this.sampleFingerprints(result.delivery, result.delivery.groups.find(row => row.id === group.id)!, trialIds)).fingerprints : undefined;
      const receipt = { id: result.id, group_id: group.id, phase: isTrial ? 'trial' : 'batch', plan, outcomes: result.outcomes, methods: result.methods,
        execution_scope: result.execution_scope, preserved_item_count: result.preserved_item_count,
        ...(trialFingerprints ? { trial_fingerprints: trialFingerprints } : {}),
        generated_methods: Object.fromEntries(Object.entries(result.artifacts).map(([name, file]) => [name, file.sha256])),
        input_sha256: result.input_sha256, output_sha256: sha256Text(prettyJson(result.delivery)), counters_reset: false, semantic_approval: false };
      const receiptPath = join(result.directory, '..', 'receipt.json');
      const previous = await readFile(receiptPath, 'utf8').catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
      if (previous && sha256Json(JSON.parse(previous)) !== sha256Json(receipt)) throw new Error('Immutable sweep receipt collision; original history retained.');
      if (!previous) await atomicWriteJson(receiptPath, receipt);
      await atomicWriteJson(path, result.delivery);
      const readableReceipt = `diagnostics/${result.id.replace(':', '_')}-receipt.json`;
      await atomicWriteJson(join(this.workRoot, readableReceipt), receipt);
      const entry = { id: result.id, group_id: group.id, path: receiptPath, sha256: sha256Text(await readFile(receiptPath, 'utf8')), phase: isTrial ? 'trial' as const : 'batch' as const };
      if (!this.checkpoint.table_sweeps?.some(row => row.id === entry.id)) (this.checkpoint.table_sweeps ??= []).push(entry);
      await this.ensureTrainingDeclarations(result.delivery, await readFile(path, 'utf8'));
      await this.invalidateChangedGroups(result.delivery);
      await this.appendEvent(isTrial ? 'table_method_trial_completed' : 'table_sweep_completed', { id: result.id, group_id: group.id, scanned_tables: plan.scanned_table_count,
        matching_tables: plan.matches.length, processed: result.outcomes.filter(row => row.status === 'processed').length,
        exceptions: result.outcomes.filter(row => row.status === 'exception').length, model_workers_started: 0, counters_reset: false });
      return { ok: true, phase: isTrial ? 'trial' : 'batch', sweep_id: result.id, receipt: readableReceipt, manifest: planPath,
        scanned_tables: plan.scanned_table_count, matching_tables: plan.matches.length,
        processed: result.outcomes.filter(row => row.status === 'processed').length, exceptions: result.outcomes.filter(row => row.status === 'exception').length,
        model_workers_started: 0, semantic_approval: false, next_tool: 'review_acceptance_group',
        instruction: isTrial ? '小样项目已由实际程序从原文重建；这只是执行证据，不代表语义正确或泛化已证明。先 phase=trial 独立复核；通过后用同一程序及依赖 sweep_acceptance_tables 扩展同类，再做真正留出。修正小样时同步修方法并重新实验，不能只手修输出。'
          : '全量匹配表已逐一记录；先处理异常及明确失败，再 phase=complete 真正留出抽查。不要读取留出候选来修规则；若已看过则用 record_acceptance_exposure 如实记账。' };
    }
    const fingerprint = sha256Json(delivery);
    if (this.checkpoint.delivery_fingerprint !== fingerprint) {
      this.checkpoint.delivery_fingerprint = fingerprint;
      this.checkpoint.generation += 1;
      this.checkpoint.status = 'working';
    }
    await this.invalidateChangedGroups(delivery);
    if (name === 'resolve_acceptance_reference') return this.resolveReference(delivery, String(params.reference_id), signal);
    if (name === 'pause_acceptance_for_sources') {
      const missing = this.checkpoint.waiting_for_sources ?? [];
      if (!missing.length) return { ok: false, error: '没有已查过本地且确认缺少的正文依赖；继续有效工作或按问题范围交付。' };
      await this.save();
      return { ok: false, terminal: true, error: 'waiting_for_external_source', missing, checkpoint_preserved: true };
    }
    if (name === 'validate_acceptance_delivery') {
      await this.save();
      const page = await this.issuePage(checked.issues);
      return { ok: checked.issues.length === 0, fingerprint, ...page,
        issue_cursor: page.next_cursor, next_tool: checked.issues.length ? 'read_acceptance_issues' : 'review_acceptance_group',
        semantic_approval: false };
    }
    if (name === 'read_acceptance_issues') {
      const cursor = params.cursor === undefined ? undefined : Math.max(0, Number(params.cursor));
      const issues = params.code === undefined ? checked.issues : checked.issues.filter(issue => issue.code === params.code);
      return { ok: true, ...await this.issuePage(issues, cursor), global_issue_count: checked.issues.length,
        ...(params.code === undefined ? {} : { matched_issue_count: issues.length, code_match: 'exact', available_codes: [...new Set(checked.issues.map(issue => issue.code))] }) };
    }
    if (name === 'investigate_acceptance_exception') {
      const problem = delivery.problems.find(problem => problem.id === params.problem_id);
      if (!problem) return { ok: false, error: '问题须先保存在 problems；提供实际 problem_id、影响范围和依赖。' };
      const rootBlocks = new Set(this.sources[0]!.blocks.map(block => block.id));
      const knownLots = new Set(delivery.lots.map(lot => lot.id));
      if ((!problem.block_ids.length && !problem.affected_lot_ids.length)
        || problem.block_ids.some(id => !rootBlocks.has(id)) || problem.affected_lot_ids.some(id => !knownLots.has(id))) {
        return { ok: false, error: 'exception_scope_required', actual: { problem_id: problem.id, block_count: problem.block_ids.length,
          affected_lot_count: problem.affected_lot_ids.length, unknown_blocks: problem.block_ids.filter(id => !rootBlocks.has(id)).slice(0, 8),
          unknown_lots: problem.affected_lot_ids.filter(id => !knownLots.has(id)).slice(0, 8) },
          expected: '具体原文疑点、冲突或引用问题，绑定实际 block_ids 或 affected_lot_ids；“全文尚未处理”是主体待办。',
          writable: `problems[id=${problem.id}]`, next_tool: 'validate_acceptance_delivery',
          instruction: '普通未处理内容继续按结构组试探和批量提取；只在有具体疑点时缩小问题来源后调查。全局未决问题须原样保留，仍阻止发布。' };
      }
      const ids = delivery.lots.filter(lot => problem.affected_lot_ids.includes(lot.id)
        || lot.scope.block_ids.some(id => problem.block_ids.includes(id))).map(lot => lot.id);
      const group: AcceptanceGroup = { id: `exception:${problem.id}`, structure: problem.message,
        rule_ids: delivery.rules.filter(rule => problem.dependency_ids.includes(rule.id)
          || ids.some(id => delivery.lots.find(lot => lot.id === id)?.items.some(item => item.rule_ids.includes(rule.id)))).map(rule => rule.id),
        lot_ids: ids, trial_lot_ids: [], boundary_lot_ids: [], conditions: problem.kind, exclusions: [] };
      const request = await this.review(delivery, group, sha256Json({ fingerprint, problem }), 'exception', ids, signal, problem.block_ids, problem.dependency_ids);
      return { ok: true, request, semantic_approval: false,
        instruction: '只读调查意见已保存；据原文修改方法及所有受影响输出后，仍须确定性验证和独立组审查。' };
    }
    if (name === 'review_acceptance_groups') {
      const tasks = params.groups as Array<{ group_id: string; phase?: string }>;
      if (!Array.isArray(tasks) || !tasks.length || tasks.length > 64 || new Set(tasks.map(row => row.group_id)).size !== tasks.length) throw new Error('Provide 1–64 distinct group ids for parallel independent review.');
      const results = await parallelMap(tasks, this.checkpoint.budget.concurrency, async task => {
        const group = delivery.groups.find(row => row.id === task.group_id);
        if (!group) throw new Error(`Unknown group_id: ${task.group_id}`);
        const material = task.phase === 'trial' ? sampleReviewMaterial(delivery, group,
          requiredReviewLotIds(delivery, group, (await this.failurePlan(delivery)).unresolved)) : undefined;
        const reviewScope = material ? { ...group, lot_ids: material.lots.map(lot => lot.id), rule_ids: material.rules.map(rule => rule.id) } : group;
        const blockers = groupReviewBlockers(delivery, reviewScope, checked.issues);
        if (blockers.length) return { group_id: group.id, ok: false, ...await this.issuePage(blockers),
          ...reviewBlockerFeedback(delivery, reviewScope, blockers), next_tool: 'validate_acceptance_delivery' };
        return { group_id: group.id, ...await this.reviewGroup(delivery, group, signal, task.phase === 'trial' ? 'trial' : task.phase === 'full' ? 'full' : 'complete') };
      }, signal, counts => this.updateParallelActivity('review', counts));
      signal?.throwIfAborted();
      return { ok: results.every(row => row.status === 'fulfilled' && 'ok' in row.value && row.value.ok), results: results.map((row, index) => row.status === 'fulfilled' ? row.value : { group_id: tasks[index]!.group_id, ok: false, error: String(row.reason) }) };
    }
    if (name === 'review_acceptance_group') {
      const group = delivery.groups.find(group => group.id === params.group_id);
      if (!group) return { ok: false, error: 'Unknown group_id; read the author groups collection.' };
      const trialOnly = params.phase === 'trial';
      const material = trialOnly ? sampleReviewMaterial(delivery, group,
        requiredReviewLotIds(delivery, group, (await this.failurePlan(delivery)).unresolved)) : undefined;
      const reviewScope = material ? { ...group, lot_ids: material.lots.map(lot => lot.id), rule_ids: material.rules.map(rule => rule.id) } : group;
      const blockers = groupReviewBlockers(delivery, reviewScope, checked.issues);
      if (blockers.length) return { ok: false, ...await this.issuePage(blockers),
        ...reviewBlockerFeedback(delivery, reviewScope, blockers), next_tool: 'validate_acceptance_delivery' };
      return this.reviewGroup(delivery, group, signal, trialOnly ? 'trial' : params.phase === 'full' ? 'full' : 'complete');
    }
    if (name === 'seal_acceptance_group') return this.sealGroup(delivery, String(params.group_id), String(params.mode ?? 'rule_batch'), String(params.reason ?? ''));
    if (name === 'seal_acceptance_delivery') return this.seal(delivery, fingerprint, signal);
    return { ok: false, error: `Unknown acceptance tool: ${name}` };
  }

  /** Full diagnostics stay available; one large scope must not overflow a model tool response. */
  private async issuePage(issues: AcceptanceIssue[], cursor?: number) {
    const issuesFile = `diagnostics/issues-${sha256Json(issues)}.json`;
    const file = await this.authorPath(issuesFile, true);
    await mkdir(dirname(file), { recursive: true });
    await atomicWriteJson(file, { issues });
    if (cursor === undefined) {
      if (this.returnedIssueSummaries.has(issuesFile)) return { issues: [], issues_file: issuesFile, total_issues: issues.length,
        unchanged: true, next_cursor: null, instruction: '问题清单未变。按已返回的同类问题汇总修复；具体明细可用 code 筛选或按文件读取，不必重复翻页。' };
      this.returnedIssueSummaries.add(issuesFile);
      const groups = new Map<string, { count: number; first: number }>();
      issues.forEach((issue, index) => { const group = groups.get(issue.code); if (group) group.count += 1; else groups.set(issue.code, { count: 1, first: index }); });
      return { issues: [...groups].map(([code, group]) => ({ code, count: group.count, path: issues[group.first]!.path,
        message: issues[group.first]!.message.slice(0, 384), actual: { preview: JSON.stringify(issues[group.first]!.actual)?.slice(0, 128) },
        full_issue: { path: issuesFile, json_pointer: `/issues/${group.first}` } })),
        issues_file: issuesFile, total_issues: issues.length, next_cursor: null,
        instruction: '按 code 汇总，每类给出一个样例；完整问题保留在文件中。相同代码不代表每处内容相同，修复后仍须全量验证；需要时用 code 筛选或显式 cursor 分页。' };
    }
    const page: Record<string, unknown>[] = [];
    const byteLimit = Math.min(24576, Math.floor(this.checkpoint.budget.max_single_tool_response_bytes / 2));
    let next = cursor;
    for (; next < issues.length && page.length < 24; next += 1) {
      const issue = issues[next]!;
      const full = JSON.stringify(issue);
      const item = Buffer.byteLength(full) <= 2048 ? { ...issue } : {
        code: issue.code, path: issue.path,
        actual: { truncated: true, preview: JSON.stringify(issue.actual)?.slice(0, 384), utf8_bytes: Buffer.byteLength(JSON.stringify(issue.actual) ?? '') },
        message: issue.message.slice(0, 512), affected_lot_ids: issue.affected_lot_ids.slice(0, 24), affected_lot_count: issue.affected_lot_ids.length,
        full_issue: { path: issuesFile, json_pointer: `/issues/${next}` },
        instruction: '完整实际值和影响范围保存在诊断文件；用 read 分段查看或用 bash 按 JSON 指针筛选。修复作者交付文件后重新验证，修改诊断文件不能消除问题。',
      };
      const wire = JSON.stringify([{ type: 'text', text: JSON.stringify({ issues: [...page, item], issues_file: issuesFile, next_cursor: next + 1, total_issues: issues.length }) }]);
      if (Buffer.byteLength(wire) > byteLimit && page.length) break;
      page.push(item);
    }
    return { issues: page, issues_file: issuesFile, total_issues: issues.length, next_cursor: next < issues.length ? next : null };
  }

  private async groupFingerprint(delivery: AcceptanceDelivery, group: AcceptanceGroup): Promise<string> {
    const rules = delivery.rules.filter(rule => group.rule_ids.includes(rule.id));
    const files: Record<string, string> = {};
    for (const rule of rules) for (const file of rule.method_files) files[file] = sha256Text(await readFile(await this.authorPath(file), 'utf8'));
    return groupReviewFingerprint(delivery, group, files, this.imageProofs(delivery, group));
  }

  private async invalidateChangedGroups(delivery: AcceptanceDelivery): Promise<void> {
    const unresolved = this.checkpoint.review_failure_policy ? await this.unresolvedReviewFailures(delivery) : [];
    for (const approval of [...this.checkpoint.approvals]) {
      const group = delivery.groups.find(group => group.id === approval.group_id);
      if (!group || await this.groupFingerprint(delivery, group) !== approval.fingerprint) this.invalidate(approval.group_id, 'Source, method, members, fields or dependencies changed.');
      else if (unresolved.some(row => row.current_lot_ids.some(id => group.lot_ids.includes(id)))) this.invalidate(approval.group_id, 'Historical findings require explicit evidence-bound resolution; history and counters retained.');
    }
    await this.save();
  }

  private invalidate(groupId: string, reason: string): void {
    for (const old of this.checkpoint.approvals.filter(approval => approval.group_id === groupId)) {
      this.checkpoint.invalidations.push({ group_id: groupId, fingerprint: old.fingerprint, reason, at: new Date().toISOString() });
    }
    this.checkpoint.approvals = this.checkpoint.approvals.filter(approval => approval.group_id !== groupId);
    for (const receipt of Object.values(this.receipts)) if (receipt.reviewed?.group_id === groupId) delete receipt.reviewed;
  }

  private async sampleFingerprints(delivery: AcceptanceDelivery, group: AcceptanceGroup, ids: string[]) {
    const material = sampleReviewMaterial(delivery, group, ids);
    const files: Record<string, string> = {};
    for (const lot of material.lots) for (const rule of sampleReviewMaterial(delivery, group, [lot.id]).rules) for (const file of rule.method_files) {
      if (!(file in files)) files[file] = sha256Text(await readFile(await this.authorPath(file), 'utf8'));
    }
    const fingerprints = Object.fromEntries(material.lots.map(lot => [lot.id, sampleReviewFingerprint(delivery, group, lot.id, files, this.imageProofs(delivery, group, [lot.id]))]));
    return { material, fingerprints };
  }

  private async reviewSamples(delivery: AcceptanceDelivery, group: AcceptanceGroup, ids: string[], phase: 'trial' | 'holdout' | 'full', signal?: AbortSignal) {
    const { material, fingerprints } = await this.sampleFingerprints(delivery, group, ids);
    const obligations = await reviewObligations(this.root, delivery, this.checkpoint.requests);
    const checks = this.checkpoint.review_failure_policy ? reviewFailureChecks(this.checkpoint.requests, obligations, material.lots.map(lot => lot.id)) : [];
    const receiptFor = (id: string) => this.checkpoint.sample_reviews?.findLast(receipt => receipt.group_id === group.id
      && receipt.lot_id === id && receipt.fingerprint === fingerprints[id] && sampleReceiptAccepted(receipt, this.checkpoint.requests)
      && receiptPostdatesFailures(receipt.request_id, id, this.checkpoint.requests, obligations)
      && requestResolvesFailures(this.checkpoint.requests.find(row => row.id === receipt.request_id)!, checks, id));
    const reused = material.lots.filter(lot => receiptFor(lot.id)).map(lot => lot.id);
    const pending = material.lots.filter(lot => !receiptFor(lot.id)).map(lot => lot.id);
    let request: AcceptanceCheckpoint['requests'][number] | undefined;
    if (pending.length) {
      // An unchanged concrete rejection is useful feedback, not permission for another paid review.
      const rejected = this.checkpoint.requests.findLast(row => row.status === 'needs_work' && row.result?.findings.length
        && (!this.checkpoint.review_failure_policy || row.failure_checks !== undefined)
        && pending.some(id => row.sample_fingerprints?.[id] === fingerprints[id]
          && (row.result!.findings.some(finding => !finding.lot_id || finding.lot_id === id)
            || row.result!.lot_decisions?.some(decision => decision.lot_id === id && !decision.approved))));
      if (rejected) return { ok: false, receipts: material.lots.map(lot => receiptFor(lot.id)).filter((row): row is SampleReviewReceipt => Boolean(row)),
        reused_lot_ids: reused, reviewed_lot_ids: [], request: rejected, unchanged_rejection: true,
        instruction: '明确失败的当前字段/方法尚未改变；先按原文修复实际问题及受影响同类结果，再送审。不能缩样、换组或重复提交绕过。' };
      const sent = sampleReviewMaterial(delivery, group, pending);
      const hashes = Object.fromEntries(sent.lots.map(lot => [lot.id, fingerprints[lot.id]!]));
      const failureChecks = this.checkpoint.review_failure_policy ? checks.filter(check => sent.lots.some(lot => lot.id === check.lot_id)) : undefined;
      request = await this.review(delivery, group, sha256Json({ protocol: failureChecks ? 3 : 2, phase, samples: hashes,
        ...(failureChecks ? { failure_checks: failureChecks } : {}),
        ...(obligations.some(row => row.current_lot_ids.some(id => pending.includes(id))) ? {
          failures: obligations.filter(row => row.current_lot_ids.some(id => pending.includes(id))).map(row => row.request_id) } : {}) }), phase, pending, signal, [], [], hashes, failureChecks);
      for (const lot of sent.lots) {
        const receipt = { group_id: group.id, lot_id: lot.id, fingerprint: hashes[lot.id]!, request_id: request.id };
        if (sampleReceiptAccepted(receipt, this.checkpoint.requests) && !this.checkpoint.sample_reviews?.some(old => sha256Json(old) === sha256Json(receipt))) {
          (this.checkpoint.sample_reviews ??= []).push(receipt);
        }
      }
      await this.save();
    }
    const receipts = material.lots.map(lot => receiptFor(lot.id)).filter((row): row is SampleReviewReceipt => Boolean(row));
    return { ok: receipts.length === material.lots.length, receipts, reused_lot_ids: reused, reviewed_lot_ids: pending, ...(request ? { request } : {}) };
  }

  private async executableTrialGate(delivery: AcceptanceDelivery, group: AcceptanceGroup, required: string[]): Promise<Record<string, unknown> | undefined> {
    const tables = new Set(this.sources[0]!.blocks.filter(block => block.kind === 'table').map(block => block.id));
    const ids = required.filter(id => delivery.lots.find(lot => lot.id === id)?.scope.block_ids.some(block => tables.has(block)));
    if (!ids.length) return undefined; // Prose and genuinely exceptional model work retain their own workflow.
    const { fingerprints } = await this.sampleFingerprints(delivery, group, ids);
    const covered = new Set<string>();
    for (const record of this.checkpoint.table_sweeps ?? []) {
      if (record.group_id !== group.id || record.phase !== 'trial') continue;
      const text = await readFile(record.path, 'utf8');
      if (sha256Text(text) !== record.sha256) throw new Error('Host-owned method trial receipt changed; restore the original, retain all history.');
      const saved = JSON.parse(text);
      if (saved.phase !== 'trial' || saved.plan.source_sha256 !== this.checkpoint.source_sha256) continue;
      const current = await Promise.all(Object.entries(saved.methods as Record<string, string>).map(async ([name, hash]) =>
        sha256Text(await readFile(await this.authorPath(name), 'utf8')) === hash));
      if (current.some(matches => !matches)) continue;
      for (const id of ids) if (saved.trial_fingerprints?.[id] === fingerprints[id]
        && !saved.outcomes.some((row: { status: string }) => row.status !== 'processed')) covered.add(id);
    }
    const missing = ids.filter(id => !covered.has(id));
    if (!missing.length) return undefined;
    return { ok: false, error: 'executable_method_trial_required', model_started: false,
      actual: { missing_lot_ids: missing, valid_executed_lot_ids: [...covered] },
      expected: 'Current sample fields and actual method dependencies must match a successful executable trial. Hand-written candidate rows or a previous method version are not execution evidence.',
      writable: 'Author program, declared rules[].method_files and sample scaffolds. Fix the method and run experiment_acceptance_table_method; do not change host receipts or shrink failed scopes.',
      next_tool: 'experiment_acceptance_table_method', next_tool_arguments: { path: 'DELIVERY.json', group_id: group.id },
      instruction: 'Use the sample structural header discovered with sweep_acceptance_tables. The experiment clears only selected input items and requires the program to regenerate them from source; independent trial review follows.' };
  }

  private async reviewGroup(delivery: AcceptanceDelivery, group: AcceptanceGroup, signal?: AbortSignal, phase: 'trial' | 'complete' | 'full' = 'complete'): Promise<Record<string, unknown>> {
    const fingerprint = await this.groupFingerprint(delivery, group);
    const existing = this.checkpoint.approvals.find(approval => approval.group_id === group.id && approval.fingerprint === fingerprint);
    if (existing && !(await this.unresolvedReviewFailures(delivery)).some(row => row.current_lot_ids.some(id => group.lot_ids.includes(id)))) return { ok: true, approval: existing, cached: true };
    let exposures: Array<{ lot_id: string; block_ids: string[] }>;
    try { exposures = (await Promise.all(this.checkpoint.requests.map(async request => {
      // An interrupted holdout can finish the identical frozen request. Changed inputs lose this exception.
      if (request.phase === 'holdout' && request.status === 'pending' && request.sample_fingerprints
        && request.lot_ids.some(id => group.lot_ids.includes(id))) {
        const current = await this.sampleFingerprints(delivery, group, Object.keys(request.sample_fingerprints));
        if (sha256Json(current.fingerprints) === sha256Json(request.sample_fingerprints)) return [];
      }
      return reviewExposures(this.root, request);
    }))).flat(); }
    catch { return { ok: false, error: 'review_history_unavailable', expected: '恢复原审查来源快照后再安排留出；不能靠缺失历史将已见成员当成未见。', writable: 'author files only; review history is host-owned', next_tool: 'acceptance_workspace' }; }
    if (!this.checkpoint.training_declarations) return { ok: false, error: 'training_declaration_history_unavailable',
      actual: 'Declaration history is not initialized.', expected: '提交当前冻结源版本的有效作者草稿，建立宿主持久声明历史后再安排留出。',
      writable: 'author DELIVERY.json only; declaration history is read-only', next_tool: 'validate_acceptance_delivery', model_started: false };
    const selectionHistoryCount = this.checkpoint.requests.length;
    const selectionPendingRequests = this.checkpoint.requests.filter(row => !['passed', 'needs_work'].includes(row.status)
      || !row.result || (!row.result.approved && !row.result.findings.length)).map(row => row.id);
    const failurePlan = await this.failurePlan(delivery);
    const required = requiredReviewLotIds(delivery, group, failurePlan.unresolved);
    const training = trainingLotIds(delivery, group, [...exposures, ...this.checkpoint.training_declarations]);
    const remaining = group.lot_ids.filter(id => !training.includes(id));
    const samplingPlan = { training_lot_count: training.length, historical_seen_lot_count: training.length,
      required_review_lot_ids: required, required_review_lot_count: required.length,
      unseen_lot_count: remaining.length, holdout_available: remaining.length > 0,
      ...(!remaining.length ? { instruction: '当前成员均已用于试探/边界核对。真正留出须在批量阶段加入未参与试探的同类成员，不能改名冒充未见；确无未见成员的小组只能如实标为全成员复核。' } : {}) };
    const mode = phase === 'full' || (phase === 'complete' && group.lot_ids.length === 1) ? 'full' : 'holdout';
    if (phase === 'complete' && mode === 'holdout' && !remaining.length) return { ok: false, error: 'holdout_sample_unavailable', sampling_plan: samplingPlan,
      actual: { group_id: group.id, members: group.lot_ids.length, training: training.length, unseen: 0 },
      expected: '加入真正未参与试探且不与已见候选共享来源块的同类成员，再做留出；确为有限小组可显式 phase=full 全成员复核，不能称为留出。',
      writable: 'groups / lots / rules / dispositions in author delivery only; exposure history is read-only', next_tool: 'review_acceptance_group', model_started: false };
    if (this.options.requireExecutableTableTrials && phase !== 'full') {
      const gate = await this.executableTrialGate(delivery, group, required);
      if (gate) return gate;
    }
    const trial = await this.reviewSamples(delivery, group, mode === 'full' ? group.lot_ids : required, mode === 'full' ? 'full' : 'trial', signal);
    if (!trial.ok) { this.invalidate(group.id, 'Trial failed: all group outputs need review.'); await this.save(); return { ...trial, ok: false, affected_lot_ids: group.lot_ids, sampling_plan: samplingPlan }; }
    if (phase === 'trial') return { ok: true, stage: 'trial', batch_ready: true, reused_lot_ids: trial.reused_lot_ids, reviewed_lot_ids: trial.reviewed_lot_ids,
      request_ids: [...new Set(trial.receipts.map(receipt => receipt.request_id))], semantic_approval: false, sampling_plan: samplingPlan,
      next_tool: 'review_acceptance_group', next_tool_arguments: { group_id: group.id, phase: remaining.length ? 'complete' : 'full' },
      instruction: remaining.length
        ? '小样核对通过；用当前方法批量处理同类内容。完成组成员后再次调用 review_acceptance_group（phase=complete）核对留出样本；本回条不批准发布。'
        : '小样核对通过；继续完成同类批处理及异常修复。当前没有未见成员，现有有限组使用 phase=full 全成员复核，复用仍有效的回执；不反复尝试不可用的留出，也不将全成员复核称作留出。本回条不批准发布。' };
    // Selection is private and deterministic across resume, after the method/output snapshot is frozen.
    const ordered = [...remaining].sort((a, b) => sha256Text(`${this.salt}:${fingerprint}:${a}`).localeCompare(sha256Text(`${this.salt}:${fingerprint}:${b}`)));
    const holdout = new Set(ordered.slice(0, Math.min(3, ordered.length)));
    const features = new Map<string, string>();
    for (const lot of delivery.lots.filter(lot => remaining.includes(lot.id))) {
      const signature = [...new Set(this.sources[0]!.blocks.filter(block => lot.scope.block_ids.includes(block.id)).flatMap(block => block.features))].sort().join('/');
      if (!features.has(signature)) { features.set(signature, lot.id); holdout.add(lot.id); }
    }
    const checkedIds = mode === 'full' ? [...group.lot_ids] : [...holdout];
    const review = mode === 'full' ? trial : await this.reviewSamples(delivery, group, checkedIds, 'holdout', signal);
    if (!review.ok) { this.invalidate(group.id, 'Holdout failed: all group outputs need review.'); await this.save(); return { ...review, ok: false, affected_lot_ids: group.lot_ids }; }
    const sampleReviews = [...new Map([...trial.receipts, ...review.receipts].map(receipt => [receipt.lot_id, receipt])).values()];
    const approval = { group_id: group.id, fingerprint, protocol_version: 4 as const, review_mode: mode as 'full' | 'holdout',
      selection_history_count: selectionHistoryCount,
      selection_pending_request_ids: selectionPendingRequests,
      failure_resolutions: failurePlan.resolutions.filter(row => group.lot_ids.includes(row.lot_id)),
      training_declaration_count: this.checkpoint.training_declarations.length,
      required_lot_ids: mode === 'full' ? [...group.lot_ids] : required,
      training_lot_ids: mode === 'full' ? [...group.lot_ids] : training, sample_reviews: sampleReviews,
      trial_request_id: trial.receipts[0]!.request_id, holdout_request_id: review.receipts.find(receipt => checkedIds.includes(receipt.lot_id))!.request_id };
    this.checkpoint.approvals.push(approval);
    for (const reference of delivery.references) {
      const receipt = this.receipts[reference.id];
      if (receipt?.source_id && !receipt.literal_only && reference.source_id === receipt.source_id
        && ['applicable', 'not_applicable'].includes(reference.disposition) && reference.dependent_lot_ids.some(id => group.lot_ids.includes(id))) {
        receipt.reviewed = { scenario: applicabilityScenario(reference), group_id: group.id, group_fingerprint: fingerprint, reference: structuredClone(reference) };
      }
    }
    await this.save();
    return { ok: true, approval, reviewed_lot_ids: checkedIds, review_mode: mode, holdout_available: mode === 'holdout' };
  }

  private async review(delivery: AcceptanceDelivery, group: AcceptanceGroup, fingerprint: string, phase: GroupReviewRequest['phase'], ids: string[], signal?: AbortSignal, problemBlocks: string[] = [], dependencyIds: string[] = [], sampleFingerprints?: Record<string, string>, failureChecks?: ReviewFailureCheck[]) {
    const id = `review:${sha256Json({ fingerprint, phase, ids }).slice(0, 24)}`;
    let request = this.checkpoint.requests.find(request => request.id === id);
    const incomplete = request?.status === 'needs_work' && request.result?.approved === false && request.result.findings?.length === 0;
    if (request && ['passed', 'needs_work'].includes(request.status) && !incomplete) return request;
    if (!request) {
      request = { id, kind: phase === 'exception' ? 'exception' : 'group_review', fingerprint, source_ids: this.sources.map(source => source.source_id),
        lot_ids: ids, dependency_ids: group.rule_ids, status: 'pending', attempts: 0, tool_response_bytes: 0, phase, exposed_lots: [] };
      this.checkpoint.requests.push(request);
    }
    if (request.attempts >= this.checkpoint.budget.max_attempts) { request.status = 'failed'; request.error = 'Review attempt limit reached.'; await this.save(); return request; }
    try { await this.accountTool(0, 0, request.id); }
    catch (error) { request.status = 'failed'; request.error = String(error); await this.save(); return request; }
    if (incomplete) await this.appendEvent('incomplete_review_retried', { request_id: request.id, previous_result: request.result,
      attempts: request.attempts, tool_response_bytes: request.tool_response_bytes, counters_reset: false });
    request.status = 'running'; request.attempts += 1; await this.save();
    const selected = delivery.lots.filter(lot => ids.includes(lot.id));
    const blockIds = new Set([...problemBlocks, ...selected.flatMap(lot => lot.scope.block_ids)]);
    // Include every sibling sharing a sampled source block, so a split cannot hide omissions.
    const sampled = sampleFingerprints ? sampleReviewMaterial(delivery, group, ids) : undefined;
    const lots = sampled?.lots ?? (phase === 'inventory' ? delivery.lots : delivery.lots.filter(lot => ids.includes(lot.id) || lot.scope.block_ids.some(block => blockIds.has(block))));
    const lotIds = new Set(lots.map(lot => lot.id));
    let rules = sampled?.rules ?? delivery.rules.filter(rule => group.rule_ids.includes(rule.id) || lots.some(lot => lot.items.some(item => item.rule_ids.includes(rule.id))));
    const references = sampled?.references ?? (phase === 'inventory' ? delivery.references : delivery.references.filter(ref => ref.dependent_lot_ids.some(id => lotIds.has(id))
      || lots.some(lot => lot.dependency_ids.includes(ref.id) || lot.items.some(item => item.reference_ids.includes(ref.id)))
      || dependencyIds.includes(ref.id) || blockIds.has(ref.origin.block_id)));
    for (const lot of lots) lot.scope.block_ids.forEach(id => blockIds.add(id));
    if (phase !== 'inventory') rules = focusedReviewRules(delivery, lots, references, rules, problemBlocks);
    const anchors = reviewQuoteBlocks([rules, lots, references]);
    for (const id of blockIds) anchors.add(`${delivery.source_sha256}:${id}`);
    const context = phase === 'inventory' ? [] : this.sources.flatMap(source => source.blocks.flatMap((block, index) => anchors.has(`${source.source_id}:${block.id}`)
      ? source.blocks.slice(Math.max(0, index - 1), index + 2).map(row => ({ source_id: source.source_id, block_id: row.id, start_line: row.start_line, end_line: row.end_line })) : []));
    const contextBlocks = new Set(context.map(row => `${row.source_id}:${row.block_id}`));
    const reviewInput: GroupReviewRequest = { id, phase, fingerprint, group,
      ...(failureChecks ? { failure_checks: failureChecks } : {}),
      review_scope: { requested_lot_ids: lots.map(lot => lot.id), total_group_lots: group.lot_ids.length, selection: 'controller' },
      ...(phase === 'exception' ? { question: group.structure } : {}),
      ...(sampleFingerprints ? { sample_fingerprints: sampleFingerprints,
        sample_fact_fingerprints: Object.fromEntries(lots.map(lot => [lot.id, reviewedFactsFingerprint(delivery, group, lot.id, this.imageManifests)])) } : {}),
      rules, lots, source_context: [...new Map(context.map(row => [`${row.source_id}:${row.block_id}`, row])).values()],
      sources: this.sources, dispositions: sampled?.dispositions ?? (phase === 'inventory' ? delivery.dispositions : delivery.dispositions.filter(row => contextBlocks.has(`${row.source_id}:${row.block_id}`)
        || row.lot_ids.some(id => lotIds.has(id)))), references };
    request.phase = phase;
    if (failureChecks) request.failure_checks = structuredClone(failureChecks);
    appendTrainingDeclarations(request.exposed_lots ??= [], lots.map(lot => ({ lot_id: lot.id, block_ids: lot.scope.block_ids })));
    if (sampleFingerprints) {
      request.sample_fingerprints = sampleFingerprints;
      request.sample_fact_fingerprints = reviewInput.sample_fact_fingerprints!;
      this.factCache.delete(request.id);
    }
    await atomicWriteJson(join(this.root, 'reviews', `${id.replace(':', '_')}.input.json`), reviewInput);
    await this.save();
    try {
      const result = await this.options.reviewer(reviewInput, signal);
      signal?.throwIfAborted();
      const valid = this.validReview(result, lots.map(lot => lot.id), failureChecks);
      if (!valid) await this.appendEvent('review_submission_rejected', { request_id: request.id,
        expected: 'Complete evidence-bound per-lot decisions and explicit historical finding responses.', submitted_result: result, counters_reset: false });
      request.result = valid ? result : { approved: false, reviewed_lot_ids: [], findings: [], reason: 'Reviewer did not return complete evidence-bound decisions.' };
      request.status = request.result.approved ? 'passed' : 'needs_work';
    } catch (error) {
      request.status = signal?.aborted ? 'pending' : 'failed';
      request.error = error instanceof Error ? error.message : String(error);
      await this.save();
      if (signal?.aborted) throw error;
    }
    await this.save();
    return request;
  }

  private validReview(result: GroupReviewResult, ids: string[], checks?: ReviewFailureCheck[]): boolean {
    return typeof result.approved === 'boolean' && Boolean(result.reason?.trim())
      && Array.isArray(result.reviewed_lot_ids) && ids.every(id => result.reviewed_lot_ids.includes(id))
      && new Set(result.reviewed_lot_ids).size === result.reviewed_lot_ids.length
      && Array.isArray(result.findings) && (!result.approved || result.findings.length === 0)
      && result.findings.every(finding => Boolean(finding.path && finding.message && finding.evidence?.length))
      && reviewSubmissionIssues(result, ids, this.sources, checks).length === 0;
  }

  private async unresolvedReviewFailures(delivery: AcceptanceDelivery) {
    return (await this.failurePlan(delivery)).unresolved;
  }

  private failurePlan(delivery: AcceptanceDelivery) {
    return failureReviewPlan(this.root, delivery, this.checkpoint.requests, this.checkpoint.sample_reviews ?? [], this.imageManifests, this.factCache, Boolean(this.checkpoint.review_failure_policy));
  }

  private async sealGroup(delivery: AcceptanceDelivery, groupId: string, mode: string, reason: string): Promise<Record<string, unknown>> {
    if (!['rule_batch', 'semantic_exception'].includes(mode)) return { ok: false, error: 'invalid_class_seal_mode', actual: mode,
      expected: 'rule_batch or semantic_exception', writable: 'seal_acceptance_group.mode', next_tool: 'seal_acceptance_group' };
    const group = delivery.groups.find(row => row.id === groupId);
    if (!group) return { ok: false, error: 'Unknown group_id', next_tool: 'acceptance_workspace' };
    const fingerprint = await this.groupFingerprint(delivery, group);
    const approval = this.checkpoint.approvals.find(row => row.group_id === group.id && row.fingerprint === fingerprint);
    if (!approval) return { ok: false, error: 'current_group_approval_required', next_tool: 'review_acceptance_group' };
    const failures = (await this.unresolvedReviewFailures(delivery)).filter(row => group.lot_ids.includes(row.lot_id) || row.current_lot_ids.some(id => group.lot_ids.includes(id)));
    const blockers = groupReviewBlockers(delivery, group, this.lastIssues);
    if (failures.length || blockers.length) return { ok: false, error: 'class_has_unresolved_failures', failures, ...await this.issuePage(blockers), next_tool: 'validate_acceptance_delivery' };
    const semantic = mode === 'semantic_exception';
    if (semantic && !reason.trim()) return { ok: false, error: 'semantic_exception_reason_required', actual: { reason },
      expected: '说明本组为何由模型处理及已核对的范围；不能将例外处理宣称为通用规则或真正留出验证。',
      writable: 'seal_acceptance_group.reason', next_tool: 'seal_acceptance_group' };
    if (semantic && (approval.review_mode !== 'full' || !group.lot_ids.every(id => approval.required_lot_ids?.includes(id)
      && approval.sample_reviews?.some(receipt => receipt.lot_id === id && sampleReceiptAccepted(receipt, this.checkpoint.requests))))) {
      return { ok: false, error: 'semantic_exception_full_review_required', actual: { review_mode: approval.review_mode, required_lot_ids: approval.required_lot_ids },
        expected: '当前组的全部成员必须具有有效语义复核回执；小样或留出批准不能替代全成员复核。',
        writable: '作者交付内容及实际方法依赖；通过 review_acceptance_group phase=full 核对全部成员，旧有效回执可复用。',
        next_tool: 'review_acceptance_group', next_tool_arguments: { group_id: group.id, phase: 'full' } };
    }
    const groupBlocks = new Set(delivery.lots.filter(lot => group.lot_ids.includes(lot.id)).flatMap(lot => lot.scope.block_ids));
    const sweeps: NonNullable<AcceptanceCheckpoint['table_sweeps']> = [], covered = new Set<string>();
    for (const record of [...(this.checkpoint.table_sweeps ?? [])].reverse().filter(row => row.group_id === group.id && row.phase !== 'trial')) {
      const text = await readFile(record.path, 'utf8');
      if (sha256Text(text) !== record.sha256) throw new Error('Host-owned table sweep receipt changed; restore the original, preserve counters.');
      const saved = JSON.parse(text);
      if (semantic) {
        const missing = saved.plan.matches.filter((match: { block_id: string }) => !groupBlocks.has(match.block_id));
        if (missing.length) return { ok: false, error: 'semantic_exception_scope_incomplete',
          actual: { sweep_id: record.id, omitted_block_ids: missing.map((match: { block_id: string }) => match.block_id) },
          expected: '改走全成员语义复核仍须覆盖此前批量扫描的完整范围，包括异常；不能缩组绕过。',
          writable: '作者交付文件的本组成员、原文范围与实际字段；恢复完整范围后 phase=full 复核。', next_tool: 'review_acceptance_group' };
        continue; // Preserve old execution history without calling semantic work a successful sweep.
      }
      const plan = planTableSweep(this.sources[0]!, saved.plan.sample_block_id, saved.plan.header_row_index, delivery);
      if (sha256Json(plan.matches.map(row => row.block_id)) !== sha256Json(saved.plan.matches.map((row: { block_id: string }) => row.block_id))) continue;
      if (saved.outcomes.some((row: { status: string }) => row.status !== 'processed')) continue;
      let unchanged = true;
      for (const [name, hash] of Object.entries(saved.methods)) if (sha256Text(await readFile(await this.authorPath(name), 'utf8')) !== hash) unchanged = false;
      if (!unchanged || plan.matches.some(match => !delivery.lots.some(lot => lot.group_id === group.id && lot.scope.block_ids.includes(match.block_id)))) continue;
      sweeps.push(record); plan.matches.forEach(match => covered.add(match.block_id));
    }
    const requiredTables = this.sources[0]!.blocks.filter(block => block.kind === 'table' && groupBlocks.has(block.id));
    const missing = requiredTables.filter(block => !covered.has(block.id));
    if (!semantic && (!sweeps.length || missing.length)) return { ok: false, error: 'complete_table_sweep_required',
      actual: { group_table_count: requiredTables.length, covered_group_table_count: requiredTables.length - missing.length,
        missing_group_table_count: missing.length, missing_group_block_ids: missing.slice(0, 12).map(block => block.id) },
      expected: '使用当前方法扫完各相关表头的全部匹配表；多份有效扫描回执的并集必须覆盖本组每张原文表，所有匹配异常须解决。然后核对真正留出样本。',
      writable: '作者通用程序、实例配置及其规则依赖；可以选择上列尚未覆盖的表头补充扫描，不可缩减既有成员、失败范围或改写宿主回执。', next_tool: 'sweep_acceptance_tables',
      alternative: '确由模型处理的例外可在全成员 phase=full 复核后，用 seal_acceptance_group mode=semantic_exception 并提供 reason；如实封存为例外，不需要编造程序扫描回执。' };
    const sweep = sweeps[0];
    const classification = semantic ? { mode: 'semantic_exception' as const, reason: reason.trim() } : {};
    const material = sampleReviewMaterial(delivery, group, group.lot_ids);
    const snapshot = { schema_version: 'acceptance-class-seal/v1', source_sha256: delivery.source_sha256, ...material, group, group_fingerprint: fingerprint,
      approval, ...(sweep ? { sweep } : {}), sweeps, ...classification, historical_seen_scopes: this.checkpoint.training_declarations, published: false };
    const sealFingerprint = sha256Json(snapshot), path = join(this.root, 'group-deliveries', `${sealFingerprint}.json`);
    await mkdir(dirname(path), { recursive: true });
    const previous = await readFile(path, 'utf8').catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
    if (previous && sha256Json(JSON.parse(previous)) !== sealFingerprint) throw new Error('Immutable class seal changed.');
    if (!previous) await atomicWriteJson(path, snapshot);
    if (!this.checkpoint.group_seals?.some(row => row.fingerprint === sealFingerprint)) {
      (this.checkpoint.group_seals ??= []).push({ group_id: group.id, fingerprint: sealFingerprint, group_fingerprint: fingerprint, path, ...(sweep ? { sweep_id: sweep.id } : {}), ...classification });
      await this.save(); await this.appendEvent('acceptance_class_sealed', { group_id: group.id, lot_count: group.lot_ids.length, fingerprint: sealFingerprint, ...(sweep ? { sweep_id: sweep.id } : {}), ...classification, published: false });
    }
    return { ok: true, class_sealed: true, mode, group_id: group.id, lot_count: group.lot_ids.length, fingerprint: sealFingerprint, path, published: false,
      instruction: semantic
        ? '本组作为模型处理的例外，经全成员语义复核后封存；不宣称通用规则推广或真正留出验证。可继续处理其他范围；全文仍须 seal_acceptance_delivery 与 ProductStore 实际发布。'
        : '本类已完成小样、全量程序处理和独立复核并封存，可扩大下一结构类；全文待办、失败、原计数继续保留。最终仍须 seal_acceptance_delivery 与 ProductStore 实际发布。' };
  }

  private async resolveReference(delivery: AcceptanceDelivery, id: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const reference = delivery.references.find(reference => reference.id === id);
    if (!reference || !verifySourceQuote(this.sources, reference.origin)) return { ok: false, error: 'Provide a reference with exact original source coordinates.' };
    const origin = this.sources.find(source => source.source_id === reference.origin.source_id)!;
    const role = referenceSourceField(origin, reference.origin);
    const key = referenceScenarioKey(reference);
    if (role === 'ambiguous') return { ok: false, error: 'reference_origin_ambiguous', actual: reference.origin,
      expected: '引用来源只覆盖一个实际字段，不能跨验收依据和允许偏差/要求栏。',
      writable: `references[id=${id}].origin`, next_tool: 'resolve_acceptance_reference',
      instruction: '根据原文表格或字段标签缩小 origin 的 start/end/text 到实际引用文字，再核对；既不默认跳过依据，也不整表展开。' };
    if (role === 'allowable_deviation' || (origin.source_id === this.checkpoint.source_sha256 && role !== 'acceptance_basis')) {
      this.receipts[id] = { key, literal_only: true }; await this.save();
      return { ok: true, field: role, action: 'retain_reference_literal', source_requested: false };
    }
    // An internal clause lookup stays in the same document and does not consume an external depth.
    if (!reference.standard_no.trim() && reference.clause.trim()) {
      this.receipts[id] = { key, source_id: origin.source_id, literal_only: false }; await this.save();
      return { ok: true, source_id: origin.source_id, markdown: `source/${origin.source_id}.md`, ledger: `source/${origin.source_id}.json`,
        action: 'assess_relevance', internal_navigation: true, semantic_approval: false };
    }
    const citedNumbers = standardNumberTokens(reference.origin.text);
    const expected = normalizeStandardNo(reference.standard_no);
    if (!citedNumbers.includes(expected) || (reference.version && !expected.endsWith(`-${reference.version}`))) {
      return { ok: false, error: 'Use the exact standard number/year printed in the original citation; do not strip or substitute the version.', actual: reference.standard_no, cited_numbers: citedNumbers };
    }
    const previous = Object.values(this.receipts).find(receipt => receipt.key === key && receipt.source_id && !receipt.literal_only);
    if (previous?.source_id && this.sources.some(source => source.source_id === previous.source_id)) {
      this.receipts[id] = { ...previous }; await this.save();
      return { ok: true, source_id: previous.source_id, markdown: `source/${previous.source_id}.md`, ledger: `source/${previous.source_id}.json`,
        action: 'assess_relevance', source_cache_hit: true, semantic_approval: false };
    }
    const reviewed = Object.values(this.receipts).find(receipt => receipt.reviewed?.scenario === applicabilityScenario(reference)
      && this.sources.some(source => source.source_id === receipt.source_id)
      && this.checkpoint.approvals.some(approval => approval.group_id === receipt.reviewed!.group_id && approval.fingerprint === receipt.reviewed!.group_fingerprint));
    if (reviewed?.reviewed) {
      this.receipts[id] = { ...reviewed, key }; await this.save();
      return { ok: true, source_id: reviewed.source_id, source_cache_hit: true, applicability_cache_hit: true,
        verified_scenario: reviewed.reviewed.reference, semantic_approval: false,
        instruction: '版本、条款、对象、用途、条件均相同的已审查依据可复用；本组范围与消费者仍须独立审查。' };
    }
    const document = await this.options.externalSourceWorkflow?.lookup(reference.standard_no);
    signal?.throwIfAborted();
    if (!document) {
      if (origin.source_id !== this.checkpoint.source_sha256) {
        this.receipts[id] = { key, literal_only: true }; await this.save();
        return { ok: true, action: 'retain_nested_reference_literal', source_requested: false };
      }
      // Keep this dependency local to the affected lots; independent verified lots remain deliverable.
      await this.options.externalSourceWorkflow?.require({ standard_no: reference.standard_no, target_id: reference.dependent_lot_ids[0] ?? id,
        occurrence_id: id, origin_excerpt: reference.origin.text, origin_locator: reference.origin.block_id,
        dependent_fields: ['requirement', 'method', 'quantity', 'sampling'], reason: reference.reason });
      this.checkpoint.waiting_for_sources = [...new Set([...(this.checkpoint.waiting_for_sources ?? []), reference.standard_no])];
      await this.save();
      return { ok: false, waiting_for_source: reference.standard_no, affected_lot_ids: reference.dependent_lot_ids, checkpoint_preserved: true };
    }
    const actualHash = sha256Text(document.markdown), declared = declaredStandardNo(document.markdown);
    const identityFailure = (reason: string): Record<string, unknown> => ({ ok: false,
      error: 'External source version/hash does not match the original citation.', host_repair_required: true,
      actual: { cited_standard_no: reference.standard_no, declared_standard_no: declared ?? null,
        supplied_markdown_sha256: document.markdown_sha256, actual_markdown_sha256: actualHash, reason,
        ...(document.edition_proof ? { supplied_proof_sha256: document.edition_proof.record_sha256,
          actual_proof_sha256: sha256Json(document.edition_proof.record),
          publication_standard_no: declaredStandardNo(document.edition_proof.record.publication_markdown) ?? null } : {}) },
      expected: '正文指纹须与归档一致，正文声明须匹配原引用版本；只有正文未声明版本时，才可使用宿主登记且原始PDF指纹完全一致的官方发布证明。',
      writable: `references[id=${id}].standard_no / version / origin 仅可校正为原文实际引用；source/、版本证明和检查点均不可由作者修改。`,
      next_tool: 'acceptance_workspace',
      instruction: '归档或证明不一致须由宿主恢复正确原件；作者不能修改冻结原文或证明来通过校验。保留依赖，先继续其他独立范围；引用字段校正后再调用 resolve_acceptance_reference。' });
    if (actualHash !== document.markdown_sha256) return identityFailure('markdown_hash_mismatch');
    const editionProof = !declared ? document.edition_proof : undefined;
    if (editionProof) {
      try { await verifyExternalEditionProof(editionProof, reference.standard_no); }
      catch (error) { return identityFailure(error instanceof Error ? error.message : String(error)); }
    }
    if (!standardIdentityMatches(document.markdown, reference.standard_no) && !editionProof) return identityFailure('body_declaration_does_not_match_citation');
    this.checkpoint.waiting_for_sources = (this.checkpoint.waiting_for_sources ?? []).filter(no => normalizeStandardNo(no) !== expected);
    const ledger = this.sources.find(source => source.sha256 === document.markdown_sha256) ?? buildAcceptanceSourceLedger(document.markdown);
    if (!this.sources.some(source => source.source_id === ledger.source_id)) {
      this.sources.push(ledger);
      await writeFile(join(this.sourceRoot, `${ledger.source_id}.md`), document.markdown, 'utf8');
      await atomicWriteJson(join(this.sourceRoot, `${ledger.source_id}.json`), ledger);
    }
    await this.ensureSourceImages(ledger, document.markdown_path);
    let frozenEdition: FrozenEditionProof | undefined;
    if (editionProof) {
      const publication = buildAcceptanceSourceLedger(editionProof.record.publication_markdown);
      if (!this.sources.some(source => source.source_id === publication.source_id)) {
        await writeFile(join(this.sourceRoot, `${publication.source_id}.md`), editionProof.record.publication_markdown, 'utf8');
        await atomicWriteJson(join(this.sourceRoot, `${publication.source_id}.json`), publication);
        this.sources.push(publication);
      }
      frozenEdition = await freezeEditionProof(this.sourceRoot, editionProof, ledger.source_id, publication.source_id);
      this.sourceEditions = editionCatalog([...Object.values(this.sourceEditions), frozenEdition]);
    }
    this.receipts[id] = { key, source_id: ledger.source_id, literal_only: false, ...(frozenEdition ? { edition_proof: frozenEdition } : {}) }; await this.save();
    return { ok: true, source_id: ledger.source_id, markdown: `source/${ledger.source_id}.md`, ledger: `source/${ledger.source_id}.json`,
      action: 'assess_relevance', semantic_approval: false, instruction: '仅按受检对象、用途、条款及条件判断采用或不适用；不能因文件存在而全盘采用。' };
  }

  private async seal(delivery: AcceptanceDelivery, fingerprint: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (this.lotSplit) {
      const issues = splitDeliveryIssues(this.lotSplit, this.sources[0]!, delivery);
      if (issues.length) return { ok: false, error: 'split_inventory_incomplete', ...await this.issuePage(issues), next_tool: 'list_acceptance_lot_inputs' };
    }
    const groups = new Set(this.checkpoint.approvals.map(approval => approval.group_id));
    const ids = eligibleLotIds(delivery, this.lastIssues, groups);
    const unresolved = (await this.unresolvedReviewFailures(delivery)).filter(row => row.missing_block_ids.length || !row.current_lot_ids.length || row.current_lot_ids.some(id => ids.includes(id)));
    if (unresolved.length) {
      const failuresFile = `diagnostics/review-failures-${sha256Json(unresolved)}.json`;
      await mkdir(join(this.workRoot, 'diagnostics'), { recursive: true }); await atomicWriteJson(join(this.workRoot, failuresFile), { failures: unresolved });
      return { ok: false, error: 'review_failures_unresolved', failure_count: unresolved.length, failures_file: failuresFile,
        failures: unresolved.slice(0, 4), expected: '所有明确失败的原文范围须有当前字段、方法及依赖的后续通过回执；删候选、缩样或换组不能消除失败。',
        writable: '作者方法/实例配置和 DELIVERY.json；失败历史与计数不可写', next_tool: 'review_acceptance_group' };
    }
    if (!ids.length) return { ok: false, ...await this.issuePage(this.lastIssues), approved_groups: [...groups],
      instruction: '尚无依赖闭合且通过组审查的批；继续局部试探和批量提取。未决全局范围仍阻止发布，不为已知待办启动全文复核。' };
    const inventoryGroup: AcceptanceGroup = { id: 'inventory', structure: 'whole-document inventory and business boundaries',
      rule_ids: delivery.rules.map(rule => rule.id), lot_ids: delivery.lots.map(lot => lot.id), trial_lot_ids: [], boundary_lot_ids: [], conditions: '全文', exclusions: [] };
    const editions = Object.keys(this.sourceEditions).length ? this.sourceEditions : undefined;
    const inventoryFingerprint = inventoryEvidenceFingerprint(fingerprint, this.checkpoint.source_image_manifests, editions);
    const checks = this.checkpoint.review_failure_policy ? inventoryFailureChecks(this.checkpoint.requests) : [];
    const inventory = await this.review(delivery, inventoryGroup, inventoryFingerprint, 'inventory', inventoryGroup.lot_ids, signal, [], [], undefined, checks);
    if (!inventory.result?.approved || (checks && !requestResolvesFailures(inventory, checks, ''))) {
      const findingsFile = `diagnostics/${inventory.id.replace(':', '_')}-inventory.json`;
      await mkdir(join(this.workRoot, 'diagnostics'), { recursive: true });
      await atomicWriteJson(join(this.workRoot, findingsFile), { request_id: inventory.id, status: inventory.status,
        result: inventory.result ?? null, failure_checks: checks ?? [] });
      return { ok: false, request: inventory, findings_file: findingsFile,
        instruction: '全文底账/业务范围核对未通过，具体意见已保存 findings_file。按原文修复范围、共享业务规则及适用关系，再提交全文核对；共享要求可写入 rules.relationship，不强制新造检验批。事实和依赖未变的局部有效回执继续复用，实际改动会使相关批失效；全局问题未解决不得发布。' };
    }
    await this.assertSources();
    const status = ids.length === delivery.lots.length && !this.lastIssues.length ? 'complete' : 'partial';
    const sealedFingerprint = sha256Json({ delivery: fingerprint, approvals: this.checkpoint.approvals, ids, inventory: inventory.id,
      ...(this.checkpoint.review_failure_policy ? { review_failure_policy: this.checkpoint.review_failure_policy } : {}),
      ...(this.checkpoint.lot_split ? { lot_split_sha256: this.checkpoint.lot_split.sha256 } : {}),
      review_protocol_version: 4, reviews: this.checkpoint.requests, training_declarations: this.checkpoint.training_declarations,
      ...(this.checkpoint.source_image_manifests ? { source_image_manifests: this.checkpoint.source_image_manifests } : {}),
      ...(editions ? { source_edition_proofs: editions } : {}) });
    const path = join(this.root, 'deliveries', `${sealedFingerprint}.json`);
    const publication = { schema_version: 'acceptance-autonomous-sealed/v1', review_protocol_version: 4, fingerprint: sealedFingerprint, status, source_sha256: delivery.source_sha256,
      ...(this.checkpoint.review_failure_policy ? { review_failure_policy: this.checkpoint.review_failure_policy } : {}),
      ...(this.checkpoint.lot_split ? { lot_split_sha256: this.checkpoint.lot_split.sha256 } : {}),
      lot_ids: ids, delivery, issues: this.lastIssues, reviews: this.checkpoint.requests, approvals: this.checkpoint.approvals,
      training_declarations: this.checkpoint.training_declarations, inventory_request_id: inventory.id,
      ...(this.checkpoint.source_image_manifests ? { source_image_manifests: this.checkpoint.source_image_manifests } : {}),
      ...(editions ? { source_edition_proofs: editions } : {}) };
    const previous = await readFile(path, 'utf8').catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
    if (previous && sha256Json(JSON.parse(previous)) !== sha256Json(publication)) throw new Error('Immutable sealed delivery collision; existing snapshot preserved.');
    if (!previous) await atomicWriteJson(path, publication);
    if (!this.checkpoint.publications.some(row => row.fingerprint === sealedFingerprint)) this.checkpoint.publications.push({ fingerprint: sealedFingerprint, lot_ids: ids, path, status, review_protocol_version: 4,
      ...(this.checkpoint.review_failure_policy ? { review_failure_policy: this.checkpoint.review_failure_policy } : {}),
      ...(this.checkpoint.lot_split ? { lot_split_sha256: this.checkpoint.lot_split.sha256 } : {}),
      ...(this.checkpoint.source_image_manifests ? { source_image_manifests: { ...this.checkpoint.source_image_manifests } } : {}),
      ...(editions ? { source_edition_proofs: structuredClone(editions) } : {}) });
    this.checkpoint.status = status; await this.save();
    return { ok: true, path, fingerprint: sealedFingerprint, status, verified_lots: ids.length, remaining_lots: delivery.lots.length - ids.length,
      published: false, instruction: '已形成可发布快照；正式发布由 ProductStore 完成，不能把本回执称为已发布。' };
  }

  private async save(): Promise<void> {
    const save = this.saveQueue.then(async () => {
      await atomicWriteJson(join(this.root, 'sources.json'), { sources: this.sources, receipts: this.receipts, salt: this.salt,
        ...(Object.keys(this.sourceEditions).length ? { editions: this.sourceEditions } : {}) });
      await atomicWriteJson(join(this.root, 'checkpoint.json'), this.checkpoint);
      for (const path of [join(this.root, 'sources.json'), join(this.root, 'checkpoint.json')]) this.protectedFiles.set(path, sha256Text(await readFile(path, 'utf8')));
    });
    this.saveQueue = save.catch(() => undefined);
    await save;
  }
}
