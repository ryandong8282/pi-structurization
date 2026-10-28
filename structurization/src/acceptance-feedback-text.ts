/**
 * Full replacement rendering model for tool instructions/repair prose.
 * Use at producers, not a blind recursive rewrite of arbitrary returned text:
 * original quotes, user reasons, saved author records and actual_error are data.
 */
export type FeedbackKind =
  | 'terminal' | 'program_fault' | 'wait_source' | 'request_rejected'
  | 'saved_local_ok' | 'saved_local_failed' | 'current_diagnostic'
  | 'readonly_page' | 'stale_diagnostic' | 'historical_navigation'
  | 'source_directory' | 'source_opened' | 'source_route' | 'quote_failed'
  | 'quote_partial' | 'quote_batch_rejected' | 'dependency_registered'
  | 'reference_resolved' | 'reference_literal_only' | 'reference_receipt'
  | 'sampling_decision' | 'table_structure' | 'source_unhandled'
  | 'phase_failed' | 'phase_passed' | 'validated' | 'fingerprint_request'
  | 'seal_revalidation_failed' | 'sealed' | 'investigation_saved'
  | 'scope_report_rejected' | 'scope_report_accepted' | 'model_review'
  | 'legacy_coverage' | 'hierarchy_difference';

/** Each existing producer supplies current facts it already knows. */
export interface FeedbackSpec {
  kind: FeedbackKind;
  code?: string | undefined;
  path?: string | undefined;
  actual?: unknown;
  expected?: unknown;
  writable_paths?: readonly string[] | undefined;
  read?: { tool: string; arguments: Record<string, unknown> };
  save?: { tool: string; arguments?: Record<string, unknown> };
  retry?: { tool: string; arguments: Record<string, unknown> };
  /** A specific source/ownership/transaction condition absent from structured fields. */
  constraint?: string;
  /** Current lifecycle facts are explicit; do not infer from prose or error-code substrings. */
  terminal?: boolean;
  durable_mutation?: 'none' | 'all' | 'partial' | 'not_applicable';
  snapshot?: 'current' | 'stale' | 'historical' | 'not_applicable';
}

export const FEEDBACK_ACTIONS: Readonly<Record<FeedbackKind, string>> = Object.freeze({
  terminal: '当前目标已终止。保留实际检查点和公开回条；本会话不再读取、保存、验证或封存。后续合法恢复由既有调度决定，原计数持续保留。',
  program_fault: '当前错误归属不可写的程序/来源不变量。保留检查点和实际错误，按现有故障路线停止或交维护；不修改selector或编译产物绕过。',
  wait_source: '当前真实正文依赖等待资料。保留已登记引用、来源和草稿，按当前回条交接；不编造正文、不删项目、不自行再开会话。',
  request_rejected: '本次请求未执行，增删及临时来源绑定均未生效。只修准确参数路径，保留原操作、全部有效记录、删除意图和同次别名定义后完整重试。',
  saved_local_ok: '本次原子修改已保存，触及记录局部通过。继续执行当前动作：execution_state=authoring时处理点名待办并保存；ready_for_check时按返回入口检查；validated时封存。局部通过不表示完整候选获批。',
  saved_local_failed: '本次全部增删已保存，局部校验未过。按稳定key及当前诊断修完整作者记录，保留正确字段；不重放已执行删除，不把保存失败与校验失败混同。',
  current_diagnostic: '这是绑定当前输入的诊断，不等于阶段通过或业务正确。读取点名完整作者记录及必要原文，按实际值/通过条件在可写路径保存真实决定；问题路径不直接作为collection。',
  readonly_page: '本页仅返回同一有效快照的连续详情；不修改草稿、不登记原文阅读、不清除问题、不执行阶段检查。需要后续详情仅复制本频道next参数；输入变化后旧页失效。',
  stale_diagnostic: '旧快照已失效，不再把旧实际值、数字路径或issue_key当当前错误。按返回当前只读入口取得诊断或按稳定key读作者记录，不为恢复旧页重检未改草稿。',
  historical_navigation: '这是历史身份导航，未确认当前仍有同错。按当前稳定key核对完整记录和原文；历史计数保留，不以旧实际值或历史工具失败裁决当前状态。',
  source_directory: '本页是元数据和读取路由，不是正文、适用结论或调查完成证明。按当前对象与字段选择需读候选，已知共同规则可复用，隔离目标走专用事实入口。',
  source_opened: '本次返回实际原文及已读状态；只有尚有未读正文时按next_cursor继续。由模型决定适用关系并精确绑定，阅读本身不等于业务批准或保存作者记录。',
  source_route: '只按返回access_mode/read_tool及精确tool_arguments读取该来源。isolated不得经open/search/table/global绕读；不猜target_key或来源身份。',
  quote_failed: '该quote尚未登记为可用span。核对同一已读evidence与真实连续原文；无匹配须重读，有歧义才用prefix/suffix。多片段分别定位后在真实字段组合，不拼造quote。',
  quote_partial: '普通部分失败中成功项已登记。只按failed_indexes逐项修失败请求，成功span可复用；不得把失败项当已保存或重做全部成功项。',
  quote_batch_rejected: '本次整批结果未持久化，临时成功也不可用。保持每个原请求的来源、quote及前后文，按原顺序完整拆小批；不丢条目、不放宽字节上限。',
  dependency_registered: '依赖来源容器已登记，可按其路由读取。登记不生成整块可绑span；选择实际承载字段的逐字片段再定位，不把atom全文塞进标量或组件。',
  reference_resolved: '当前引用目标及路由已登记，不代表正文已读或语义已接收。按target_key完成所需组件读取，再由模型决定实际采用/不适用及真实字段，不重复resolve已定位目标。',
  reference_literal_only: '此后续外部引用无可用正文，按既有literal_only停止追索：保留完整原引用和真实原字段/anchor，target_span_ids=[]；不请求补文件、不伪称正文核验。',
  reference_receipt: '按不可变occurrence原话、来源及目标逐组件核对当前作者引用。origin定位与destination交付分别声明，限于import_scope；placeholder保留空destinations，由真实项目承载。',
  sampling_decision: '读取当前完整item及实际适用共同规则，按原文完成抽样状态、组件、分支和来源。已核对共享规则可复用，只有具体缺事实才继续查；不只改status/reason，不以fallback代未完成。',
  table_structure: '读取当前保存结构和点名未决行，以真实单元格/题注/合并/续表证据完成typed结构。实际仍不确定保存review，不猜测或借selector集合名读取表结构。',
  source_unhandled: '以点名evidence义务核对实际作者绑定和引用路由；由模型选择真实业务承载、组织范围或有据context/ignored。anchor、重复相同字段或调查笔记不兑现来源；不将真实要求降背景。',
  phase_failed: '本次完整阶段检查未推进。先按当前诊断处理并保存真实作者待办，当前作者错误清空后再执行原检查；局部通过、子行减少或理由变化不保证完整评分改善，计数按原回条保留。',
  phase_passed: '当前阶段已按本阶段合同通过；继续下一实际阶段或完整提交。通过本阶段不批准后续或整目标，使用返回精确检查点参数。',
  validated: '当前完整compiler/strict验证通过。直接seal返回的精确已验证fingerprint，不新增独立审核、全量调查或改写编译产物。',
  fingerprint_request: '只修请求指纹：复制本回条已核实当前检查点的精确retry参数。请求被拒未改变候选，不把draft/plan SHA/诊断指纹混用，不修改业务来匹配旧指纹。',
  seal_revalidation_failed: '封存尚未写入不可变工件。按当前真实owner和作者可写诊断修输入，重新完整commit后用新成功fingerprint封存；不直接重试seal或编辑编译结果。',
  sealed: '当前精确候选已封存，停止修改本revision；后续变更由既有新revision或完整重跑入口处理。',
  investigation_saved: '调查交接已持久化，仅供恢复复用。按剩余事实继续形成并保存真实作者记录；本工具不结束任务、不换会话、不重置预算、不代替selector或语义批准。',
  scope_report_rejected: '本报告尚未接受终态阻塞或范围修改。按实际通过条件和当前作者输入补证/修复；保留冻结范围，不以目录、atom或摘要冒充已读精确span。',
  scope_report_accepted: '范围冲突证据及检查点已保存，按当前回条停止等待既有上游处置；报告不认定业务冲突必成立、不授予覆盖或封存，不直接编辑冻结范围。',
  model_review: '这是业务比较线索，未证明缺陷。核对点名原文及实际分配后自主决定保留或修订；不机械删除、不由此新增审核轮次。',
  legacy_coverage: '只按当前已存在历史coverage阶段的范围、durable findings及封存门槛工作，不为当前direct-validation创建或恢复新的独立覆盖复核。',
  hierarchy_difference: '以当前精确原文解决点名层级差异，数量或名称相似不证明正确；改决定后按既有验证/比较门槛处理，不改sealed lot身份。',
});

export function renderFeedback(spec: FeedbackSpec): string {
  if (spec.terminal) return FEEDBACK_ACTIONS.terminal;
  const value = (v: unknown) => JSON.stringify(v);
  return [FEEDBACK_ACTIONS[spec.kind],
    spec.code || spec.path ? `定位：${spec.code ?? ''}${spec.path ? ` @ ${spec.path}` : ''}。` : '',
    spec.actual === undefined ? '' : `实际值：${value(spec.actual)}。`,
    spec.expected === undefined ? '' : `通过条件：${value(spec.expected)}。`,
    spec.writable_paths ? `作者可写：${spec.writable_paths.length ? spec.writable_paths.join('、') : '无；由程序或维护者处理'}。` : '',
    spec.constraint ?? '',
    spec.read ? `读取：${spec.read.tool}(${value(spec.read.arguments)})。` : '',
    spec.save ? `保存：${spec.save.tool}${spec.save.arguments ? `(${value(spec.save.arguments)})` : '，按完整作者记录合同提交'}。` : '',
    spec.retry ? `下一步：${spec.retry.tool}(${value(spec.retry.arguments)})。` : '',
  ].filter(Boolean).join('\n');
}

/** Keep all existing payload fields and exact actuals; replace only chosen prose. */
export function withFeedbackText<T extends Record<string, unknown>>(payload: T, spec: FeedbackSpec): T & { instruction: string } {
  return { ...payload, instruction: renderFeedback(spec) };
}

/** For selector diagnostic projection: no heuristic classification of business. */
export function fieldDiagnosticText(payload: Record<string, unknown>, spec: Omit<FeedbackSpec, 'actual' | 'expected' | 'path' | 'code' | 'writable_paths'>): Record<string, unknown> {
  const instruction = renderFeedback({ ...spec, code: typeof payload.code === 'string' ? payload.code : undefined,
    path: typeof payload.path === 'string' ? payload.path : undefined,
    actual: payload.actual, expected: payload.expected,
    writable_paths: Array.isArray(payload.writable_paths) ? payload.writable_paths as string[] : undefined });
  return { ...payload, how_to_pass: instruction };
}

/** No inference from ok/error prose, and no recursion into source/author data.
 * Producers opt in only after they have selected the actual state. Unknown
 * responses retain their original exact instruction for explicit review. */
export function acceptanceFeedbackToolResponse(value: unknown, spec?: FeedbackSpec): unknown {
  return spec && value && typeof value === 'object' && !Array.isArray(value)
    ? withFeedbackText(value as Record<string, unknown>, spec) : value;
}
