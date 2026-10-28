/**
 * Replacement descriptions only. Never change tool registration, parameters,
 * required fields, enums, numeric limits, execution policy or dispatch logic.
 */
export const ACCEPTANCE_TOOL_DESCRIPTIONS: Readonly<Record<string, string>> = Object.freeze({
  get_target_context: '只读当前范围、检查点和调查交接；discovery_context_cursor 分页读取已封存发现线索，按路由读原文再判断适用性。各诊断频道游标独立；不执行完整阶段校验。已有当前定点入口时无需先重读目录。',
  get_target_selector_contract: '读取完整 selector JSON Schema 和本任务业务/来源/引用/表格/抽样/原子保存/诊断协议。未知字段或新模式先读；契约描述合法表达，不替模型选业务答案。',
  get_plan_contract: '读取存量 source-plan 模式的完整 Schema、正式行、身份及可写规则；不授予新 selector 模式写编译产物权限。',
  list_evidence_resources: '分页读取当前不可变来源元数据和每项读取路由；context_for_evidence_id 只列同 clause_id 直接主资料，不读正文、不判适用性。',
  list_global_document_resources: '分页浏览可直接调查的全文元数据，不依赖关键词；按返回路由打开候选。隔离引用从引用目录进入专用事实工具。',
  search_global_document_resources: '检索可直接调查的全文；空格分隔备选词，任一词命中，完整短语和多词命中优先。不含隔离原始正文。空结果按精确next参数浏览全文目录，不证明无适用规则。',
  open_global_document_resource: '打开目录点名的可调查原子；采用范围外依赖须另经已有登记流程。隔离重叠时按回条 target_key 改用事实工具。',
  open_adjacent_document_resource: '打开已知原子的前/后相邻资源；只定位物理上下文，不判业务归属。无邻项不证明调查完成。',
  register_external_dependency: '把已打开的同文档窗外原子登记为共同/引用来源容器，再由模型定位精确片段。直接 primary 缺口走既有精确 span blocker，不把直接正文伪装为依赖。',
  resolve_document_reference: '一次登记明确内部引用的一个目标及其真实发生处，或按更正参数修正旧引用。只读取已登记目标时直接用target_key；不同来源位置仍须登记新occurrence。单段通常传origin_span_id+raw_reference及目标、字段和关系，唯一匹配时省略reference_literal_span_id，由程序定位。',
  resolve_external_standard_reference: '按实际外部标准号、年份、原字段和登记来源层级处理引用。字段豁免、一级正文等待及后续 literal_only 遵守契约，不推测外部内容。',
  list_table_fragments: '列出直接可访问表的片段、结构候选与 row obligations。候选供阅读；每义务按真实 item/同属性branch/有据处置承接。',
  read_table_summary: '读一个逻辑表的物理片段、题注候选及保存结构，定位实际未决部分；候选不裁决正式结构。',
  read_table_rows: '按页读取真实单元格文字、来源、合并坐标及可公开的前置标题原文上下文。标题与行按来源位置关联，由模型判断层级和类别；程序不填写类别。导航元数据不拼入可绑定文字。',
  read_adjacent_source: '打开表题、表注或续表附近的实际原文，仅用于所需结构和语义判断。',
  read_saved_table_structure: '读取当前表的已保存结构、确认片段与未决行；只补未决部分及必要证据。',
  stage_table_structure: '原子保存一个 typed 逻辑表结构决定，程序生成派生身份。无法确定保存 review；推翻行提示逐行写理由，note_rows填evidence、note_span_ids填span。',
  list_sampling_rules: '分页列出非穷尽抽样定位线索；适用性与最终模式由模型核对原文决定。已有共享规则可复用，未命中不支持fallback。',
  list_reference_occurrences: '分页查询不可变occurrence及target_key；缺ID或不确定当前发生处是否已登记时，按原引用、位置和字段匹配。resolved行按analysis_mode选择inline正文或isolated事实工具，复制target_key；未解析成功的ID不代表正文可读，已知读取入口无需重复查目录。',
  open_evidence: '按路由打开direct或允许的inline原文窗口；inline组件用专用正文工具完成，isolated只读事实。仅有next_cursor未读正文时继续翻页。',
  read_document_reference_evidence: '读取已登记inline引用目标。复制当前回条的target_key及读取参数，读到done后按真实组件决定接收/不适用；缺目标ID先查当前角色目录（selector为list_reference_occurrences，coverage为list_coverage_reference_targets），尚未登记的明确引用先resolve_document_reference。不可填fingerprint或读取isolated正文。',
  read_reference_facts: '读取已登记isolated引用目标。先复制当前target_key取目录，再按机器entry_id打开必要事实或有据skip；缺目标ID先查引用清单。目录/正文游标分开，续单条正文原样复制next参数；每条完整读取或有据跳过后解除pending。',
  search_evidence: '只检索已登记目标证据，不是全文；空格分隔备选词，任一词命中，完整短语和多词命中优先。不暴露隔离正文。空结果按精确next参数查全文，命中和空结果均不作业务结论。',
  batch_open_evidence: '按请求顺序打开1～50个允许资源；任含isolated则整批在写入前拒绝并给专用路由。成功后仅对未读正文按next_cursor继续。',
  batch_search_evidence: '执行1～20个目标证据检索，与单次/全文检索同为按空格分词、任一词命中排序。每项返回范围、匹配词与未命中后的精确全文入口；命中按各项读取路由打开，结果不替代适用性判断。',
  locate_evidence_span: '在已打开证据中把真实quote定位成精确来源span，重复句用prefix/suffix。只容许现有纯排版归一，不能改写或跨位置拼句。',
  batch_locate_evidence_spans: '定位1～100个明确evidence/quote。普通部分成功保留成功span、只重试失败；整批字节拒绝未登记任何临时span，按原请求完整拆批。',
  read_target_selectors: '不传collection读摘要/计数；collection页仅目录，collection+key读完整作者记录。只在source_dispositions支持evidence过滤，其内容读取键非草稿字段。表结构走专用工具。',
  read_target_selector_issues: '按当前有效预检快照的指纹、游标或issue_key只读问题详情。过期按返回当前入口读取，不为旧详情重检未改草稿。',
  replace_target_selectors: '兼容入口：只允许首次空selector的整体初稿，不用于恢复重建，保存不等于验证。',
  patch_target_selectors: '兼容入口：按当前可写路径保存有界selector JSON Patch，仍须正式commit验证，不写根或编译产物。',
  stage_target_selector_draft: '原子保存draft内完整typed记录；或用reference_selections+当前draft_fingerprint一次选择已有项目的引用字段，由程序同步来源与接收关联。两种模式不能混用，均可同次quote_bindings。参数/定位拒绝全次未保存；ok=true后检查local_validation。详见实际工具参数与契约保存协议。',
  advance_target_selector_stage: '有当前作者待办时先按回条next_tool/next_tool_arguments修复，不执行阶段检查。待办清空且业务判断完成后，复制expected_next_stage作为next_stage检查当前阶段，通过才推进；next_stage不是当前阶段。terminal立即停止，完整草稿可直接commit。',
  commit_target_selector_draft: '有当前作者待办时先处理待办，不用提交刷新诊断。待办清空且业务判断完成后，用当前draft_fingerprint执行完整compiler/strict验证；仅缺阅读回执可补读后用原指纹重试，通过立即seal精确已验证fingerprint。',
  seal_validated_plan: '封存当前最近成功完整验证绑定的精确fingerprint，派生哈希/草稿指纹不能替代；失败按真实owner修作者输入或停止。',
  report_target_blocker: '按现有typed kind、已读已登记精确span、实际受影响作者路径和理由报告真实阻塞。报告不表示已接受终态、覆盖通过或可绕过修复，按实际回条继续/等待/停止。',
  save_target_investigation: '持久化可复用调查结论、关键已读来源及剩余事实；不是selector保存、批准、换会话或封存。summary/next_steps及来源摘要按原schema上限，完整义务不丢失。',

  get_document_selector_contract: '读取当前发现selector严格合同、来源版本/范围修订信息及导航；当前发现作者通过来源覆盖结构校验后直封存。',
  list_document_atoms: '列出不可变全文原子目录，按当前角色要求实际打开；预览不代表正文已读或业务结论。',
  open_document_atom: '按当前目录atom_id读取不可变正文，记录实际阅读。',
  batch_open_document_atoms: '打开明确点名的1～50个原子，遵守原128KB回条上限，不隐含打开全文件。',
  search_document: '检索原文定位候选，空结果和命中都不裁决目标/层级。',
  batch_search_document: '执行1～20个明确原文检索，结果只导航，不决定业务范围。',
  locate_document_span: '在已读原文中定位真实quote，可按原协议跨atom；重复句用原prefix/suffix，不改写。',
  batch_locate_document_spans: '定位1～100个明确atom/quote并返回各项结果，保留成功登记，不生成全量registry。',
  read_document_selectors: '默认读accepted摘要/目录，key或view=full读完整；带draft_id读独立待提交事务，不表示accepted。恢复按实际基线和待提交事务继续。',
  edit_document_selectors: '按稳定key事务编辑targets/contexts/dispositions；update顶层差异、upsert完整。保留原四个新对象/40项/128KB限额；draft_id差异修订后edits=[]校验提交。',
  discard_document_selector_draft: '仅在明确放弃该draft_id全部待提交修改时调用；accepted不变，不为绕校验丢弃正确事务。',
  patch_document_selectors: '兼容发现JSON Patch入口，按原事务上限有界保存，不替换整语义数组；优先稳定key事务。',
  read_discovery_obligations: '分页读候选缺口与范围疑点，按实际原文判断；pending_count不代替next_cursor，读完必要后续页，不机械拆并窗口。',
  read_scope_conflicts: '分页读冻结任务、锚点与准备范围的精确冲突供有据修订，不自行认定业务边界。',
  record_discovery_decisions: '实际阅读后对当前clause记录pending或有据context并引用真实context key；context变更按原合同使关联判断失效。',
  compile_document_selectors: '对当前accepted选择器执行来源、范围、覆盖、读取和结构的完整现有校验，不选择业务对象或边界。',
  seal_discovery_plan: '只封存当前校验成功的精确fingerprint；当前作者不进入独立目标复核，历史review仍遵守其原状态门槛。',
  read_discovery_review_progress: '仅历史发现review阶段：读剩余未确认/需修订记录，读取不等于确认；保存或改动后从当前cursor=0继续。',
  record_discovery_review: '仅历史发现review阶段：独立核对当前完整记录与原文后保存真实confirmed/needs_revision及精确来源，不跳原全局门槛。',

  read_reference_target_page: '读唯一引用目标的下一页；[cursor,next_cursor)是已返回范围，下一页前保存本页事实，不把next_cursor当缺页。',
  stage_reference_facts: '通过本页page_handle与局部行索引保存精确原文事实，不选择验收接收者或字段。',
  read_staged_reference_facts: '只读当前唯一引用目标实际已存事实检查点。',
  seal_reference_analysis: '所有目标页实际已读且事实span校验通过后封存，原门槛不变。',
  report_reference_analysis_blocker: '按实际阻塞及原typed code报告；page_gap附reported_cursor/next_cursor供持久页链核验，不启动新模型会话。',

  get_hierarchy_contract: '读取当前层级角色、工作文件、图/身份/证据/调查及封存合同，确认模式与全调查模式读取义务分别适用。',
  list_sealed_lots: '列当前job不可变sealed lot，摘要只导航，不批准归属或名称。',
  open_sealed_lot: '打开已登记lot_key的封存业务内容、来源与项目目录，不改原身份。',
  read_hierarchy_plan: '读取当前层级工作文件和record_catalog，按稳定key定位，不按数组位置猜记录。',
  edit_hierarchy_records: '按稳定key原子保存层级差异：update顶层变更，upsert完整；归属、名称和冲突取舍由模型依原文判断。',
  patch_hierarchy_plan: '兼容入口：对当前层级工作文件作有界JSON Patch，守原身份/节点类型/关系合同。',
  validate_hierarchy_plan: '核验当前身份、证据、角色要求的调查、图约束和sealed lot唯一完整覆盖，返回当前repair_targets。',
  submit_hierarchy_candidate: '仅提交已验证当前fingerprint，交既有独立层级复核，作者不自行封存。',
  compare_hierarchy_candidate: 'review独立重建通过当前验证后比较隐藏作者候选，差异需实际证据解决。',
  record_hierarchy_reconciliation: '以当前精确证据保存每项差异取舍，内容改变后按原门槛重验比较。',
  seal_hierarchy_plan: '仅封存独立重建、当前验证和比较都有效且差异全解决的精确fingerprint。',

  // Existing legacy compatibility only; never register these in a new selector author.
  read_working_plan: '存量计划模式：只读实际持久化semantic-source-plan检查点。',
  prepare_field_bindings: '存量计划模式：校验作者所选精确片段并生成绑定/hash，按原有界准备次数及时保存，不编业务文本。',
  replace_working_plan: '存量计划模式：仅原合同允许的最初建模整体替换，已验证/修复或准备绑定后不整替。',
  patch_working_plan: '存量计划模式：按当前建模/active_cluster权限保存最多四项完整关联事务，修复阶段原子重验，不能扩大范围或整体重建。',
  reconcile_evidence_dispositions: '存量计划模式：推导已用证据并保存作者对已读来源的真实context/ignored处置，不能替模型选业务用途。',
  apply_table_assembly: '存量计划模式：按原合同先验证表装配，再确定性同步骨架；业务字段仍由作者判断。',
  validate_working_plan: '存量计划模式：执行现有结构、来源、声明一致性及状态验证，保留原失败后的修复权限与预算，不扩语义裁决。',
  read_coverage_review: '仅已有历史coverage合同：读取绑定当前有效计划指纹的durable review；不存在时按现有handoff交调度，不轮询或启动新审核。',
  get_coverage_review_contract: '仅历史coverage：读当前复核范围、必需证据和Schema，delta外只读。',
  open_review_evidence: '仅历史coverage：按允许路由开direct/inline证据；isolated改走事实目录，不绕隔离。',
  batch_open_review_evidence: '仅历史coverage：原子预检1～50个已知允许ID，含未知/isolated整批不写阅读或span。',
  locate_review_span: '仅历史coverage：在已读允许证据定位精确span；isolated用事实工具返回span，不读原始页。',
  list_coverage_reference_targets: '仅历史coverage：分页列已登记目标和路由，不读正文或判业务。',
  search_review_document: '仅历史coverage：在可直接调查原文定位，省query可浏览；isolated不参与文本匹配或计数。',
  open_review_document: '仅历史coverage：读已登记原子为观察，不修改候选；隔离重叠按target_key路由事实。',
  search_review_evidence: '仅历史coverage：检索可访问证据，结果不新增覆盖义务，逐项按路由读取。',
  read_candidate_plan: '仅历史coverage：分页列范围内候选目录和计数，未列范围外仍存在，精确内容按叶详情读取。',
  read_candidate_related_context: '仅历史coverage：按必需item_id读同源兄弟实际分配，到next_cursor=null再报增量缺口；不扩复核范围。',
  read_candidate_leaf_details: '仅历史coverage：先business视图读精确字段，来源具体问题才full；大叶按不可变section/text refs完成实际要求的读取。',
  read_candidate_leaf_section: '仅历史coverage：按snapshot与section_ref读连续页，原样next_page_token；嵌套section单独读取。',
  read_candidate_leaf_text: '仅历史coverage：按内容text_ref及当前snapshot分Unicode码点读长标量，不赚原始证据阅读。',
  read_working_coverage_review: '仅历史coverage：读取实际持久化结构化复核稿及当前收尾检查点。',
  stage_coverage_review_draft: '仅历史coverage：按原最多32条限制保存覆盖记录/findings，精确span由harness物化，未批准业务不伪造完成。',
  seal_coverage_review: '仅历史coverage：封存当前有效独立判断精确fingerprint，沿用全部原前置门槛。',
});

export interface DescribedTool { name: string; description?: string }
/** Missing entries fail at integration time, not via a fabricated model fallback. */
export function replaceAcceptanceToolDescription<T extends DescribedTool>(tool: T): T {
  const description = ACCEPTANCE_TOOL_DESCRIPTIONS[tool.name];
  if (!description) throw new Error(`Missing acceptance prompt description: ${tool.name}`);
  return { ...tool, description };
}

export function replaceAcceptanceToolText<T extends DescribedTool & { parameters: unknown }>(tool: T): T {
  return { ...replaceAcceptanceToolDescription(tool), parameters: replaceParameterDescriptions(tool.parameters) };
}

/** Explicit parameter prose edits. All structural schema properties stay intact. */
export const PARAMETER_DESCRIPTIONS: Readonly<Record<string, string>> = Object.freeze({
  source_handle_scope: '使用当前会话短句柄时必填顶层scope，原样复制当前回条，不给旧句柄改scope。',
  target_key: '原样复制当前公开工具返回的已登记target_key；当前回条若给t短句柄就直接用它。它是引用目标身份，不是条号、occurrence_id或span_id，不从target_fingerprint推导。缺值先查当前角色目录：selector用list_reference_occurrences，coverage用list_coverage_reference_targets；不按格式构造。',
  origin_span_id: '普通单段引用的来源范围：复制包含当前引用文字的已登记span_id，与raw_reference配合；唯一匹配时由程序定位精确引用片段。',
  origin_field: '引用逐字原话实际出现的本地字段；与目标导入字段分别声明。',
  raw_reference: '当前引用成员的最小逐字literal；原文范围引用按完整范围，target.number指定当前成员。',
  normalized_reference: '组合literal的规范显示，仅规范原排版空白，不改字符或目标。',
  reference_literal_span_id: '可选精确引用片段：普通单段唯一匹配时省略，程序按origin_span_id+raw_reference定位；仅显式消歧时传已有精确片段，通常全文等于raw_reference；回条提供expected_text时以其原文值为准，不能传包含其他正文的整段。',
  reference_literal_span_ids: '原序2～3个真实换行literal片段，不能拼接不相关原文。',
  origin_span_ids: '原序2～3段同一真实引用来源，不跨文档拼接。',
  note_rows: '表注所在原文行的evidence句柄。',
  note_span_ids: '表注精确文字的span句柄。',
  row_cursor: '仅单entry正文续页，原样复制next_row_cursor，与目录cursor独立。',
  row_offset: '仅单entry当前行续片，原样复制next_row_offset。',
  catalog_cursor: '隔离事实目录cursor，原样复制next_catalog_cursor，不作正文偏移。',
  field_diagnostic_cursor: '当前字段诊断独立游标；首次或旧快照失效从0，只读不完整检查。',
  field_diagnostic_fingerprint: '复制当前字段诊断输入指纹，与本频道游标同用。',
  field_diagnostic_detail_mode: '配合当前字段游标及指纹读该条完整诊断。',
  source_repair_cursor: '有限来源诊断独立游标；按该频道next参数读取，不作完整检查。',
  stage_diagnostic_cursor: '已执行且仍有效的阶段快照游标；过期用当前作者/字段入口，不为翻页重检。',
  saved_diagnostic_cursor: '保存回执的准确诊断游标，与返回的saved_diagnostic_scope同用。',
  saved_diagnostic_scope: '复制本次保存快照的local/deferred频道，不能与阶段频道互换。',
  diagnostic_detail_key: '复制长数组next_page中的快照键，不是草稿或校验指纹。',
  diagnostic_detail_path: '复制同一诊断next_page的数组路径，不是文件或selector集合。',
  diagnostic_detail_cursor: '复制该长数组next_page游标，只读后续条目。',
});

export function replaceParameterDescriptions<T>(schema: T): T {
  if (Array.isArray(schema)) return schema.map(replaceParameterDescriptions) as T;
  if (!schema || typeof schema !== 'object') return schema;
  const source = schema as Record<string, unknown>;
  const result: Record<string, unknown> = { ...source };
  for (const [key, value] of Object.entries(source)) {
    if (key === 'properties' && value && typeof value === 'object' && !Array.isArray(value)) {
      result.properties = Object.fromEntries(Object.entries(value).map(([field, child]) => {
        const next = replaceParameterDescriptions(child);
        return [field, PARAMETER_DESCRIPTIONS[field] && next && typeof next === 'object'
          ? { ...next, description: PARAMETER_DESCRIPTIONS[field] } : next];
      }));
    } else result[key] = replaceParameterDescriptions(value);
  }
  return result as T;
}
