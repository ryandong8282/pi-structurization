export { atomicWriteJson } from './atomic.js';
export { runAutonomousAcceptance, createAcceptanceAutonomousTools, ACCEPTANCE_AUTONOMOUS_PROMPT } from './acceptance-autonomous/runtime.js';
export { verifyAutonomousSealedDelivery, type AutonomousSealedDelivery } from './acceptance-autonomous/sealed.js';
export { AcceptanceAutonomousController } from './acceptance-autonomous/controller.js';
export { readAutonomousAcceptanceProgress, type AutonomousAcceptanceProgress } from './acceptance-autonomous/progress.js';
export { buildAcceptanceSourceLedger, referenceSourceField } from './acceptance-autonomous/source-ledger.js';
export { prepareLotSplitHandoff, installLotSplitHandoff, readLotSplitHandoff, createUnresolvedSplitRefinement, mapSplitCandidates, type LotSplitHandoff, type SplitBoundaryReview } from './acceptance-autonomous/lot-split-handoff.js';
export { splitAcceptanceLots, readSplitLot, auditLotSplit, type LotSplitManifest, type SplitLayoutChunk, type SplitPdfEvidence } from './acceptance-autonomous/lot-split.js';
export { copyReferencedSourceImages } from './acceptance-autonomous/source-images.js';
export type { OriginalPdfPageRenderer, OriginalPdfSource, PdfPageBox } from './acceptance-autonomous/source-images.js';
export { validateAcceptanceDelivery, eligibleLotIds } from './acceptance-autonomous/validation.js';
export type { AcceptanceDelivery, AcceptanceCheckpoint, AcceptanceLot, AcceptanceItem, SourceQuote, BoundText } from './acceptance-autonomous/contracts.js';
export {
  deriveSamplingScript,
  samplingConfidenceForStatus,
  samplingScriptForStatus,
  supportedSamplingScript,
  supportedSamplingScriptValue,
} from "./sampling-script.js";
export {
  actionableIssue,
  ensureActionableIssue,
  toolReject,
} from "./actionable-error.js";
export type {
  ActionableIssueDetails,
  ActionableToolReject,
} from "./contracts.js";
export {
  batchLedgerGapFrom,
  describeBatchLedgerGap,
  readFullBatch,
  runFullBatch,
  type BatchLedgerGap,
  type FullBatchOptions,
  type FullBatchState,
} from "./batch.js";
export { editorInspectionUnits, type EditorInspectionUnit } from "./inspection-unit.js";
export {
  runEditorHierarchy,
  type EditorHierarchyRunOptions,
  type EditorHierarchyRunResult,
} from "./editor-hierarchy-runner.js";
export {
  EDITOR_HIERARCHY_PLAN_SCHEMA_VERSION,
  EditorHierarchyController,
  EditorHierarchyWorkspace,
  buildEditorHierarchyEvidence,
  confirmModeHierarchyIssues,
  initialEditorHierarchyPlan,
  validateEditorHierarchyPlan,
  type EditorHierarchyEvidence,
  type EditorHierarchyPlan,
  type EditorHierarchyProgress,
  type HierarchyConfirmContext,
} from "./editor-hierarchy.js";
export {
  assembleEditorHierarchyFromLedger,
  matchSubdivision,
} from "./editor-hierarchy-assemble.js";
export {
  scanDocumentLedger,
  evaluateDiscoveryLedgerAgreement,
  evaluateLedgerConfidence,
  evaluateTargetLedgerCoverage,
  coverageScopeFromLedgerGate,
  gapEvidenceIdsForClauses,
  ledgerWindowForLine,
  resolveLedgerWindowForTarget,
  type DocumentLedger,
} from "./document-ledger.js";
export {
  formatLedgerReconciliation,
  ledgerClauseIdSet,
  reconcileLedgerCoverage,
  resolveItemClauseId,
  type LedgerReconciliation,
} from "./ledger-reconciliation.js";
export { prefillTargetSelectorsFromLedger } from "./ledger-target-selectors.js";
export * from "./document-graph/index.js";
export {
  COVERAGE_REVIEW_SCHEMA_VERSION,
  CoverageReviewController,
  coverageReviewObligations,
  createCoverageReviewTools,
  readSealedCoverageReview,
  sealDeterministicCleanCoverageReview,
  validateCoverageReview,
  type CoverageReviewFinding,
  type CoverageReviewIssue,
  type CoverageReviewScope,
  type DomainCoverageReview,
  type SemanticCoverageDisposition,
} from "./coverage-review.js";
export {
  COVERAGE_RISK_GATE_SCHEMA_VERSION,
  deriveCoverageRiskGate,
  type CoverageRiskCode,
  type CoverageRiskGateInput,
  type CoverageRiskGateResult,
  type CoverageRiskReason,
} from "./coverage-risk-gate.js";
export {
  TARGET_SELECTOR_PLAN_SCHEMA_VERSION,
  TARGET_SELECTOR_PLAN_JSON_SCHEMA,
  TARGET_SELECTOR_DRAFT_JSON_SCHEMA,
  SOURCE_SPAN_ID_PATTERN,
  SAMPLING_COMPONENT_ROLES,
  TargetSelectorCompileError,
  compileTargetSelectors,
  initialTargetSelectorPlan,
  migrateTargetSelectorPlan,
  migrateTargetSelectorPlanForAuthoring,
  targetSelectorFingerprint,
  type SamplingComponentRole,
  type TargetSelectorDraft,
  type TargetSelectorIssue,
  type TargetSelectorPlan,
  type TargetSelectorPlanMigrationResult,
} from "./target-selector-compiler.js";
export {
  DOCUMENT_SELECTOR_PLAN_SCHEMA_VERSION,
  DOCUMENT_SELECTOR_PLAN_JSON_SCHEMA,
  DocumentSelectorCompileError,
  compileDocumentSelectors,
  initialDocumentSelectorPlan,
  documentSelectorFingerprint,
  type DocumentSelectorIssue,
  type DocumentSelectorPlan,
} from "./document-selector-compiler.js";
export {
  SOURCE_SPAN_REGISTRY_SCHEMA_VERSION,
  SourceSpanRegistryError,
  initialSourceSpanRegistry,
  locateSourceQuote,
  registerSourceSpan,
  renderedTableCellSpans,
  resolveSourceSpan,
  sourceSpanRegistryFingerprint,
  tableEvidenceTextFormat,
  type SourceSpanRecord,
  type SourceSpanRegistry,
} from "./source-span-registry.js";
export { normalizeMineruDisplayText, normalizeMineruInlineMath } from "./text-normalization.js";
export {
  TABLE_STRUCTURE_SCHEMA_VERSION,
  initialTableStructurePlan,
  pendingComplexTableStructureIssues,
  tableStructureFingerprint,
  validateTableStructurePlan,
  type TableStructureDecision,
  type TableStructureIssue,
  type TableStructurePlan,
  type TableStructureRowRole,
  type TableStructureStatus,
} from "./table-structure.js";
export {
  PDF_LAYOUT_CATALOG_SCHEMA_VERSION,
  PDF_LAYOUT_PROFILE_SCHEMA_VERSION,
  PDF_LAYOUT_SEAL_MAX_ATTEMPTS,
  PdfLayoutSealError,
  buildPdfLayoutCatalog,
  inspectPdfLayoutLines,
  layoutCatalogExampleText,
  pdfLayoutSealToolReject,
  pdfNativeEvidenceForMarkdownWindow,
  profilePromotedHeadings,
  sealPdfLayoutProfile,
  type PdfLearnedLayoutRole,
  type PdfLayoutCatalog,
  type PdfLayoutCandidate,
  type PdfLayoutProfile,
  type PdfLayoutRule,
  type PdfLayoutSealFailure,
  type PdfLayoutStyleSummary,
  type PdfPromotedHeading,
  type PdfPromotedSourceLine,
} from "./pdf-layout-profile.js";
export {
  PDF_TEXT_ROUTE_SCHEMA_VERSION,
  classifyPdfNativePages,
  extractPdfNativeDocument,
  type PdfDocumentTextRoute,
  type PdfNativeDocument,
  type PdfNativeLine,
  type PdfPageRouteRecord,
  type PdfPageTextRoute,
  type PdfRawPage,
} from "./pdf-native-source.js";
export {
  PI_AGENT_MODEL_STAGES,
  resolvePdfExCodePreset,
  resolvePdfExCodeProtocolPreset,
  museModelCompatibility,
  museToolParameters,
  type PdfExCodePreset,
  type PiAgentApiType,
  type PiAgentAuthMode,
  type PiAgentEffort,
  type PiAgentModelSettings,
  type PiAgentModelStage,
  type PiAgentRuntimeModelConfig,
} from "./presets.js";
export {
  CATALOG_SELF_REVIEW_SYSTEM_PROMPT,
  runLiveCatalogReview,
  runLiveCatalogLeafExpansion,
  runLiveCatalogStructureDiscovery,
} from "./pi-runtime.js";
export { runLiveAutonomousCatalog, assertCatalogAutonomousResumeCheckpoint } from './pi-runtime.js';
export { CATALOG_AUTONOMOUS_PROMPT, createCatalogAutonomousTools, type CatalogAutonomousRuntimeInput } from './catalog-autonomous-runtime.js';
export {
  CATALOG_STRUCTURE_DISCOVERY_PROMPT,
  createCatalogStructureDiscoveryTools,
  type CatalogStructureDiscoveryRuntimeInput,
} from "./catalog-structure-discovery-runtime.js";
export {
  CATALOG_LEAF_EXPANSION_SYSTEM_PROMPT,
  createCatalogLeafExpansionTools,
  type CatalogLeafExpansionRuntimeInput,
} from "./catalog-leaf-expansion-runtime.js";
export {
  CatalogReviewRuntimeController,
  createCatalogReviewRuntimeTools,
  type CatalogReviewRuntimeAction,
  type CatalogReviewRuntimeAnomaly,
  type CatalogReviewRuntimeDecision,
  type CatalogReviewRuntimeInput,
  type CatalogReviewRuntimeRecord,
} from "./catalog-review-runtime.js";
export * from "./target-fan-in.js";
export { summarizeDiscoveryPerformance } from "./discovery-performance.js";
export { DEFAULT_TARGET_TRANSPORT_RETRIES } from "./attempt-budget.js";
export { ChatGptSubscriptionAuth, type ChatGptSubscriptionView } from "./chatgpt-auth.js";

export { externalReferenceExpansionPolicy, externalReferenceFieldPolicy, type ExternalReferenceExpansionPolicy } from "./external-reference-policy.js";
export { validateOfficialEditionRecord, verifyExternalEditionProof, type OfficialEditionRecord, type ExternalEditionProof, type FrozenEditionProof } from "./external-source-edition.js";
export { ExternalSourceWaitError, normalizeStandardNo, standardIdentityMatches, declaredStandardNo, type ExternalSourceWorkflow, type ExternalSourceRequest, type ExternalStandardDocument, type ExternalSourceIgnoreDecision } from "./external-source-workflow.js";

export { runAcceptanceFeedbackScope, type AcceptanceFeedbackCandidate } from "./pi-runtime.js";

export { acceptanceCandidatePreview, acceptanceFeedbackCandidates, cloneAcceptanceRevision } from "./acceptance-revision.js";
export { runTemplateAcceptanceAgent, TEMPLATE_ACCEPTANCE_PROMPT, TEMPLATE_ACCEPTANCE_TOOLS } from './template-acceptance-runtime.js';
export { AgenticLotSplitController, DEFAULT_AGENTIC_SPLIT_LIMITS,
  type AgenticSplitDecision, type AgenticSplitRange, type AgenticSplitQuote, type AgenticSplitLimits } from './acceptance-autonomous/agentic-lot-split.js';
export { runAgenticLotSplit, createAgenticLotSplitTools, AGENTIC_LOT_SPLIT_PROMPT } from './acceptance-autonomous/agentic-lot-split-runtime.js';

export { catalogAutonomousPromptFor } from './catalog-autonomous-runtime.js';
export { ModelSourceHandles } from './model-source-handles.js';
