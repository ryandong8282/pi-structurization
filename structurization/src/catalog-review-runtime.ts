import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

import { atomicWriteJson } from './atomic.js';
import { sha256Json } from './canonical.js';

export type CatalogReviewRuntimeAction =
  | 'accept_as_is'
  | 'keep_as_alias'
  | 'replace_title'
  | 'mark_source_conflict'
  | 'merge_into_record'
  | 'classify_as_category'
  | 'classify_as_note'
  | 'adopt_children';

export interface CatalogReviewRuntimeRecord {
  recordId: string;
  candidateId: string;
  sourceRole: string;
  nodeType: string;
  name: string;
  rawName: string;
  identifiers: Record<string, unknown>;
  path: unknown[];
  sourceRefs: Array<{ pageNumber: number; [key: string]: unknown }>;
  confidence: number;
  reviewFlags: string[];
}

export interface CatalogReviewRuntimeAnomaly {
  id: string;
  code: string;
  severity: 'warning' | 'error';
  message: string;
  recordIds: string[];
  sourceRefs: Array<{ pageNumber: number; [key: string]: unknown }>;
  details: Record<string, unknown>;
}

export interface CatalogReviewRuntimeDecision {
  anomalyId: string;
  action: CatalogReviewRuntimeAction;
  reason: string;
  evidencePages: number[];
  replacementTitle?: string;
  targetRecordId?: string;
  childRecordIds?: string[];
}

export interface CatalogReviewRuntimeInput {
  workspaceRoot: string;
  runId: string;
  anomalies: CatalogReviewRuntimeAnomaly[];
  records: CatalogReviewRuntimeRecord[];
  openPage(pageNumber: number): Promise<unknown>;
  appendEvent?(eventType: string, payload: unknown): Promise<void>;
}

type ToolResponse = Record<string, unknown> & { ok: boolean };

const ALLOWED_ACTIONS: Record<string, CatalogReviewRuntimeAction[]> = {
  cross_source_title_mismatch: ['keep_as_alias', 'replace_title', 'mark_source_conflict'],
  ambiguous_identifier_match: ['replace_title', 'mark_source_conflict'],
  ambiguous_repeated_title: ['mark_source_conflict'],
  incomplete_toc_entry: ['accept_as_is', 'replace_title'],
  repeated_form_title: ['accept_as_is', 'replace_title'],
  suspicious_form_title: ['accept_as_is', 'replace_title'],
  continuation_fragment: ['accept_as_is', 'merge_into_record'],
  note_like_record: ['accept_as_is', 'classify_as_note'],
  unclassified_master_heading: ['accept_as_is', 'classify_as_category', 'adopt_children'],
  coded_parent_candidate: ['accept_as_is', 'classify_as_category', 'adopt_children']
};

function response(value: ToolResponse): { content: Array<{ type: 'text'; text: string }>; details: ToolResponse } {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], details: value };
}

function uniqueNumbers(values: number[]): number[] {
  return [...new Set(values.filter((value) => Number.isInteger(value) && value > 0))].sort((a, b) => a - b);
}

function boundedPageEvidence(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const page = value as Record<string, unknown>;
  const lines = Array.isArray(page.lines)
    ? page.lines.slice(0, 300).map((entry) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
        const line = entry as Record<string, unknown>;
        return {
          id: line.id,
          text: line.text,
          bbox: line.bbox,
          ...(line.fontSize !== undefined ? { fontSize: line.fontSize } : {})
        };
      })
    : [];
  return {
    pageNumber: page.pageNumber,
    width: page.width,
    height: page.height,
    text: typeof page.text === 'string' ? page.text.slice(0, 32_000) : '',
    lines,
    truncated: typeof page.text === 'string' && page.text.length > 32_000
  };
}

export class CatalogReviewRuntimeController {
  private readonly anomalyById: Map<string, CatalogReviewRuntimeAnomaly>;
  private readonly recordById: Map<string, CatalogReviewRuntimeRecord>;
  private readonly decisions = new Map<string, CatalogReviewRuntimeDecision>();
  private readonly openedPages = new Set<number>();
  private sealed = false;
  private sequence = 0;
  readonly statePath: string;

  private constructor(private readonly input: CatalogReviewRuntimeInput) {
    this.anomalyById = new Map(input.anomalies.map((item) => [item.id, item]));
    this.recordById = new Map(input.records.map((item) => [item.recordId, item]));
    this.statePath = join(input.workspaceRoot, 'catalog-review-working.json');
  }

  static async create(input: CatalogReviewRuntimeInput): Promise<CatalogReviewRuntimeController> {
    await mkdir(input.workspaceRoot, { recursive: true });
    const controller = new CatalogReviewRuntimeController(input);
    await controller.persist();
    return controller;
  }

  result(): { sealed: boolean; decisions: CatalogReviewRuntimeDecision[] } {
    return { sealed: this.sealed, decisions: [...this.decisions.values()] };
  }

  snapshot(): { checkpoint: string; working_plan_sha256: string; history_sequence: number; last_valid_fingerprint: string } {
    const state = this.serializableState();
    const fingerprint = sha256Json(state);
    return {
      checkpoint: fingerprint,
      working_plan_sha256: fingerprint,
      history_sequence: this.sequence,
      last_valid_fingerprint: this.validation().ok ? fingerprint : ''
    };
  }

  private serializableState(): Record<string, unknown> {
    return {
      schema_version: 'catalog-review/v1',
      run_id: this.input.runId,
      anomaly_count: this.input.anomalies.length,
      opened_pages: [...this.openedPages].sort((a, b) => a - b),
      decisions: [...this.decisions.values()],
      sealed: this.sealed
    };
  }

  private async persist(): Promise<void> {
    await atomicWriteJson(this.statePath, this.serializableState());
  }

  private validation(): ToolResponse {
    const missing = this.input.anomalies
      .filter((item) => !this.decisions.has(item.id))
      .map((item) => ({ anomaly_id: item.id, code: item.code, severity: item.severity }));
    return {
      ok: missing.length === 0,
      decided_count: this.decisions.size,
      anomaly_count: this.input.anomalies.length,
      missing
    };
  }

  private validateDecision(value: CatalogReviewRuntimeDecision): string | undefined {
    const item = this.anomalyById.get(value.anomalyId);
    if (!item) return 'unknown_anomaly';
    if (!(ALLOWED_ACTIONS[item.code] ?? []).includes(value.action)) return 'action_not_allowed_for_anomaly';
    if (!value.reason.trim()) return 'reason_required';
    const evidencePages = uniqueNumbers(value.evidencePages);
    if (evidencePages.length === 0) return 'evidence_page_required';
    if (evidencePages.some((page) => !this.openedPages.has(page))) return 'evidence_page_not_opened';
    const sourcePages = new Set(item.sourceRefs.map((ref) => ref.pageNumber));
    if (evidencePages.some((page) => !sourcePages.has(page))) return 'evidence_page_outside_anomaly';
    if ([...sourcePages].some((page) => !evidencePages.includes(page))) return 'all_affected_source_pages_required';
    if (value.action === 'replace_title' && !value.replacementTitle?.trim()) return 'replacement_title_required';
    if (value.action === 'merge_into_record') {
      if (!value.targetRecordId || !this.recordById.has(value.targetRecordId)) return 'valid_merge_target_required';
      const primary = this.recordById.get(item.recordIds.at(-1) ?? '');
      const target = this.recordById.get(value.targetRecordId);
      if (!primary || !target || primary.candidateId !== target.candidateId || primary.recordId === target.recordId) {
        return 'merge_target_must_be_another_record_in_same_candidate';
      }
    }
    if (value.action === 'adopt_children') {
      if (!value.childRecordIds?.length) return 'child_record_ids_required';
      const parent = this.recordById.get(item.recordIds[0] ?? '');
      if (!parent) return 'parent_record_missing';
      const suggested = new Set(
        Array.isArray(item.details.candidateChildRecordIds)
          ? item.details.candidateChildRecordIds.filter((entry): entry is string => typeof entry === 'string')
          : []
      );
      if (value.childRecordIds.some((id) => {
        const child = this.recordById.get(id);
        return !child || child.candidateId !== parent.candidateId || !suggested.has(id);
      })) return 'children_must_come_from_suggested_same_candidate_records';
    }
    return undefined;
  }

  async dispatch(name: string, params: Record<string, unknown>): Promise<ToolResponse> {
    if (name === 'get_catalog_review_contract') {
      return {
        ok: true,
        run_id: this.input.runId,
        anomaly_count: this.input.anomalies.length,
        actions: ALLOWED_ACTIONS,
        action_targets: {
          cross_source_title_mismatch: 'keep_as_alias/replace_title/mark_source_conflict 作用于表单记录；主目录保留权威名称。',
          incomplete_toc_entry: 'accept_as_is/replace_title 作用于当前目录记录；必须核对原页同一基线的相邻文本块。',
          repeated_form_title: 'accept_as_is/replace_title 作用于当前表单记录；必须逐页确认重复标题是真实标题还是标题范围抽错。',
          suspicious_form_title: 'replace_title 作用于该表单记录。',
          continuation_fragment: 'merge_into_record 将异常中的末条碎片并入 target_record_id。',
          unclassified_master_heading: 'classify_as_category/adopt_children 作用于异常首条标题记录。',
          coded_parent_candidate: 'classify_as_category/adopt_children 作用于异常首条主分类记录。'
        },
        rules: [
          '目录与表单编号属于同一语义域且唯一时，标题差异必须判定为别名、抽取错误或来源冲突。',
          '不得仅凭相同常见标题连接多个目录节点。',
          '每项决定的 evidence_pages 必须包含该异常 sourceRefs 中的全部来源页，且每页均已用 open_catalog_page 打开；不得引用该异常以外的页。',
          '只能选择该异常代码允许的动作；不能发明记录或证据。'
        ]
      };
    }
    if (name === 'list_catalog_anomalies') {
      const cursor = Number(params.cursor ?? 0);
      const limit = Math.min(50, Math.max(1, Number(params.limit ?? 20)));
      const items = this.input.anomalies.slice(cursor, cursor + limit).map((item) => ({
        ...item,
        decision: this.decisions.get(item.id) ?? null
      }));
      return {
        ok: true,
        items,
        next_cursor: cursor + items.length < this.input.anomalies.length ? cursor + items.length : null
      };
    }
    if (name === 'open_catalog_record') {
      const id = String(params.record_id ?? '');
      const record = this.recordById.get(id);
      if (!record) return { ok: false, error: 'record_not_found', record_id: id };
      const index = this.input.records.findIndex((item) => item.recordId === id);
      const neighbours = this.input.records
        .slice(Math.max(0, index - 2), index + 3)
        .filter((item) => item.candidateId === record.candidateId)
        .map((item) => ({ recordId: item.recordId, name: item.name, identifiers: item.identifiers, nodeType: item.nodeType }));
      return {
        ok: true,
        record,
        neighbours,
        anomalies: this.input.anomalies.filter((item) => item.recordIds.includes(id))
      };
    }
    if (name === 'open_catalog_page') {
      const pageNumber = Number(params.page_number);
      if (!Number.isInteger(pageNumber) || pageNumber <= 0) {
        return { ok: false, error: 'invalid_page_number' };
      }
      const page = boundedPageEvidence(await this.input.openPage(pageNumber));
      this.openedPages.add(pageNumber);
      this.sequence += 1;
      await this.persist();
      return { ok: true, page_number: pageNumber, page };
    }
    if (name === 'record_catalog_decision') {
      const value: CatalogReviewRuntimeDecision = {
        anomalyId: String(params.anomaly_id ?? ''),
        action: String(params.action ?? '') as CatalogReviewRuntimeAction,
        reason: String(params.reason ?? ''),
        evidencePages: uniqueNumbers(Array.isArray(params.evidence_pages) ? params.evidence_pages.map(Number) : []),
        ...(typeof params.replacement_title === 'string' ? { replacementTitle: params.replacement_title } : {}),
        ...(typeof params.target_record_id === 'string' ? { targetRecordId: params.target_record_id } : {}),
        ...(Array.isArray(params.child_record_ids)
          ? { childRecordIds: params.child_record_ids.filter((entry): entry is string => typeof entry === 'string') }
          : {})
      };
      const error = this.validateDecision(value);
      if (error && ['evidence_page_required', 'evidence_page_not_opened', 'evidence_page_outside_anomaly', 'all_affected_source_pages_required'].includes(error)) {
        const requiredPages = uniqueNumbers(this.anomalyById.get(value.anomalyId)!.sourceRefs.map(ref => ref.pageNumber));
        const unopenedPages = requiredPages.filter(page => !this.openedPages.has(page));
        return {
          ok: false, error, anomaly_id: value.anomalyId,
          instruction: '先用 open_catalog_page 打开尚未读取的来源页，再重交 record_catalog_decision：evidence_pages 必须完整且仅包含 required_pages。当前决定未保存；保留其余正确字段，不要改写来源页或异常记录。',
          details: {
            path: '/evidence_pages', actual: value.evidencePages, required_pages: requiredPages,
            missing_pages: requiredPages.filter(page => !value.evidencePages.includes(page)),
            extra_pages: value.evidencePages.filter(page => !requiredPages.includes(page)),
            unopened_pages: unopenedPages,
            next_tool_calls: unopenedPages.map(page => ({ tool: 'open_catalog_page', arguments: { page_number: page } })),
            write_tool: 'record_catalog_decision', saved: false,
          },
        };
      }
      if (error) return { ok: false, error, anomaly_id: value.anomalyId };
      this.decisions.set(value.anomalyId, value);
      this.sequence += 1;
      await this.persist();
      return { ok: true, decision: value, progress: this.validation() };
    }
    if (name === 'validate_catalog_review') return this.validation();
    if (name === 'seal_catalog_review') {
      const validation = this.validation();
      if (!validation.ok) return { ...validation, error: 'catalog_review_incomplete' };
      this.sealed = true;
      this.sequence += 1;
      await this.persist();
      return { ok: true, fingerprint: this.snapshot().working_plan_sha256, decision_count: this.decisions.size };
    }
    return { ok: false, error: 'unknown_catalog_review_tool', tool: name };
  }
}

export function createCatalogReviewRuntimeTools(controller: CatalogReviewRuntimeController): ToolDefinition[] {
  const tool = <T>(name: string, label: string, description: string, parameters: T): ToolDefinition => defineTool({
    name,
    label,
    description,
    parameters: parameters as never,
    executionMode: 'sequential',
    execute: async (_id, params) => response(await controller.dispatch(name, params as Record<string, unknown>))
  });
  const actions = Object.values(ALLOWED_ACTIONS).flat();
  return [
    tool('get_catalog_review_contract', '读取目录自查契约', '读取异常类型、允许动作及证据要求。', Type.Object({}, { additionalProperties: false })),
    tool('list_catalog_anomalies', '列出目录异常', '分页列出确定性检查器发现的目录语义异常。', Type.Object({
      cursor: Type.Optional(Type.Number({ minimum: 0 })),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 50 }))
    }, { additionalProperties: false })),
    tool('open_catalog_record', '打开目录记录', '打开记录、相邻记录及关联异常。', Type.Object({
      record_id: Type.String({ minLength: 1 })
    }, { additionalProperties: false })),
    tool('open_catalog_page', '打开目录证据页', '打开异常来源页的不可变文字与版面行。', Type.Object({
      page_number: Type.Number({ minimum: 1 })
    }, { additionalProperties: false })),
    tool('record_catalog_decision', '记录目录自查决定', '依据已打开页面，对一个异常保存受限、可验证的处置。', Type.Object({
      anomaly_id: Type.String({ minLength: 1 }),
      action: Type.Union(actions.map((action) => Type.Literal(action))),
      reason: Type.String({ minLength: 1 }),
      evidence_pages: Type.Array(Type.Number({ minimum: 1 }), { minItems: 1 }),
      replacement_title: Type.Optional(Type.String({ minLength: 1 })),
      target_record_id: Type.Optional(Type.String({ minLength: 1 })),
      child_record_ids: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 100 }))
    }, { additionalProperties: false })),
    tool('validate_catalog_review', '验证目录自查', '检查每个异常是否都有合法且有已读页证据的决定。', Type.Object({}, { additionalProperties: false })),
    tool('seal_catalog_review', '封存目录自查', '仅在所有异常均已处置后封存工作文件。', Type.Object({}, { additionalProperties: false }))
  ];
}
