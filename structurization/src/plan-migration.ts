import {
  COMPACT_PLAN_SCHEMA_VERSION,
  PLAN_SCHEMA_VERSION,
  type AcceptanceItemPlan,
  type EvidenceManifest,
  type InspectionDataType,
  type PersistedSemanticSourcePlan,
  type SemanticSourcePlan,
  type SemanticSourcePlanV8,
} from "./contracts.js";
import { sha256Text } from "./canonical.js";
import { buildItemFieldBindings } from "./domain-contract.js";
import { buildInitialTableAssembly } from "./source-plan-contract.js";

type MigratableAcceptanceItem = Omit<
  AcceptanceItemPlan,
  | "table_semantics"
  | "inspection_data_type"
  | "inspection_data_type_reason"
  | "inspection_data_type_evidence_ids"
> & {
  table_semantics?: AcceptanceItemPlan["table_semantics"];
  inspection_data_type?: InspectionDataType;
  inspection_data_type_reason?: string;
  inspection_data_type_evidence_ids?: string[];
};

type LegacyAcceptanceItemV2 = Omit<MigratableAcceptanceItem, "field_bindings">;

interface LegacyPlanV2 {
  schema_version: "semantic-source-plan/v2";
  job_id: string;
  target_id: string;
  evidence_fingerprint: string;
  inspection_lots: SemanticSourcePlan["inspection_lots"];
  acceptance_items: LegacyAcceptanceItemV2[];
  evidence_dispositions: SemanticSourcePlan["evidence_dispositions"];
}

interface LegacyPlanV3 extends Omit<
  SemanticSourcePlan,
  "schema_version" | "acceptance_items" | "reference_resolutions" | "table_assembly"
> {
  schema_version: "semantic-source-plan/v3";
  acceptance_items: MigratableAcceptanceItem[];
  reference_resolutions: Array<
    Omit<SemanticSourcePlan["reference_resolutions"][number], "occurrence_id" | "application_mode">
  >;
}

interface LegacyPlanV4 extends Omit<
  SemanticSourcePlan,
  "schema_version" | "acceptance_items" | "table_assembly"
> {
  schema_version: "semantic-source-plan/v4";
  acceptance_items: MigratableAcceptanceItem[];
}

interface LegacyPlanV5OrV6 extends Omit<
  SemanticSourcePlan,
  "schema_version" | "acceptance_items"
> {
  schema_version: "semantic-source-plan/v5" | "semantic-source-plan/v6";
  acceptance_items: MigratableAcceptanceItem[];
}

const INSPECTION_DATA_TYPES = new Set<InspectionDataType>([
  "measurement",
  "counting",
  "mixed",
  "review",
]);

function normalizeAcceptanceItems(
  items: MigratableAcceptanceItem[],
): AcceptanceItemPlan[] {
  return items.map((item) => {
    const hasCompleteClassification = (
      item.inspection_data_type !== undefined
      && INSPECTION_DATA_TYPES.has(item.inspection_data_type)
      && Boolean(item.inspection_data_type_reason?.trim())
      && Array.isArray(item.inspection_data_type_evidence_ids)
      && item.inspection_data_type_evidence_ids.length > 0
    );
    return {
      ...item,
      table_semantics: item.table_semantics ?? null,
      inspection_data_type: hasCompleteClassification
        ? item.inspection_data_type!
        : "review",
      inspection_data_type_reason: hasCompleteClassification
        ? item.inspection_data_type_reason!
        : "旧计划未包含完整的检验数据类型专业判断，迁移后保留为待复核，不作推断。",
      inspection_data_type_evidence_ids: hasCompleteClassification
        ? [...item.inspection_data_type_evidence_ids!]
        : [...item.evidence_ids],
    };
  });
}

function withCurrentItemFields<T extends {
  acceptance_items: MigratableAcceptanceItem[];
}>(plan: T): Omit<T, "acceptance_items"> & {
  acceptance_items: AcceptanceItemPlan[];
} {
  return {
    ...plan,
    acceptance_items: normalizeAcceptanceItems(plan.acceptance_items),
  };
}

function migrateV3(
  legacy: LegacyPlanV3,
  manifest: EvidenceManifest,
): SemanticSourcePlan {
  const occurrences = manifest.reference_occurrences ?? [];
  const referenceResolutions = legacy.reference_resolutions.map((resolution) => {
    const occurrence = occurrences.find((candidate) =>
      candidate.origin_evidence_id === resolution.origin_evidence_id
      && resolution.target_evidence_ids.every((evidenceId) =>
        candidate.target_evidence_ids.includes(evidenceId)
      )
    );
    if (!occurrence) {
      throw new Error(
        "semantic-source-plan/v3 reference decisions require a rebuilt reference-aware evidence package before revision",
      );
    }
    return {
      ...resolution,
      occurrence_id: occurrence.occurrence_id,
      application_mode: resolution.destination_bindings.every((destination) =>
        destination.target_field === "reference_only"
      )
        ? "reference_only" as const
        : "replace_field" as const,
    };
  });
  if (!referenceResolutions.length && occurrences.length) {
    throw new Error(
      "semantic-source-plan/v3 contains unresolved references; rebuild its evidence package before revision",
    );
  }
  return withCurrentItemFields({
    ...legacy,
    schema_version: PLAN_SCHEMA_VERSION,
    table_assembly: buildInitialTableAssembly(manifest),
    reference_resolutions: referenceResolutions,
  }) as SemanticSourcePlan;
}

export function upgradePlanToCurrent(
  input: unknown,
  manifest: EvidenceManifest,
): PersistedSemanticSourcePlan {
  if (input !== null && typeof input === "object") {
    const schemaVersion = (input as { schema_version?: unknown }).schema_version;
    if (schemaVersion === COMPACT_PLAN_SCHEMA_VERSION) {
      // v8 is already the current compact persisted representation. In
      // particular, never hydrate it here and accidentally expand provenance.
      return structuredClone(input) as SemanticSourcePlanV8;
    }
    if (schemaVersion === PLAN_SCHEMA_VERSION) {
      const current = withCurrentItemFields(
        input as SemanticSourcePlan & { acceptance_items: MigratableAcceptanceItem[] },
      ) as SemanticSourcePlan;
      return manifest.source.semantic_workflow
        ? {
            ...current,
            semantic_evidence: current.semantic_evidence ?? [],
            semantic_references: current.semantic_references ?? [],
            shared_sampling_rules: current.shared_sampling_rules ?? [],
          }
        : current;
    }
    if (schemaVersion === "semantic-source-plan/v5" || schemaVersion === "semantic-source-plan/v6") {
      const legacy = input as LegacyPlanV5OrV6;
      const current = withCurrentItemFields({
        ...legacy,
        schema_version: PLAN_SCHEMA_VERSION,
      }) as SemanticSourcePlan;
      return {
        ...current,
        semantic_evidence: current.semantic_evidence ?? [],
        semantic_references: current.semantic_references ?? [],
        shared_sampling_rules: current.shared_sampling_rules ?? [],
      };
    }
    if (schemaVersion === "semantic-source-plan/v3") {
      return migrateV3(input as LegacyPlanV3, manifest);
    }
    if (schemaVersion === "semantic-source-plan/v4") {
      return withCurrentItemFields({
        ...(input as LegacyPlanV4),
        schema_version: PLAN_SCHEMA_VERSION,
        table_assembly: buildInitialTableAssembly(manifest),
      }) as SemanticSourcePlan;
    }
  }

  if (
    input === null
    || typeof input !== "object"
    || (input as { schema_version?: unknown }).schema_version !== "semantic-source-plan/v2"
  ) {
    throw new Error(
      "Only semantic-source-plan/v2 through v8 can be migrated to the current plan schema",
    );
  }

  const legacy = input as LegacyPlanV2;
  const referenceResolutions: SemanticSourcePlan["reference_resolutions"] = [];
  const acceptanceItems = legacy.acceptance_items.map((item) => {
    if (item.reference_evidence_ids.length > 0) {
      throw new Error("Legacy reference decisions cannot be migrated without an Agent-authored import_scope");
    }
    return {
      ...item,
      table_semantics: null,
      inspection_data_type: "review" as const,
      inspection_data_type_reason: "旧计划未包含检验数据类型的专业判断，迁移后保留为待复核，不作推断。",
      inspection_data_type_evidence_ids: [...item.evidence_ids],
      field_bindings: buildItemFieldBindings(
        {
          name: item.name,
          requirement: item.requirement,
          method: item.method,
          quantity: item.quantity,
          note: item.note,
        },
        item.evidence_ids,
        manifest,
      ),
    };
  });
  return {
    schema_version: PLAN_SCHEMA_VERSION,
    job_id: legacy.job_id,
    target_id: legacy.target_id,
    evidence_fingerprint: legacy.evidence_fingerprint,
    table_assembly: buildInitialTableAssembly(manifest),
    inspection_lots: legacy.inspection_lots,
    acceptance_items: acceptanceItems,
    reference_resolutions: referenceResolutions,
    evidence_dispositions: legacy.evidence_dispositions,
  };
}

/**
 * Prepares a persisted plan for a writable revision without changing either
 * current representation. Compact v8 and expanded v7 are both current
 * artifacts; only legacy v2-v6 plans pass through the migration pipeline.
 */
export function preparePersistedPlanForWorking(
  input: unknown,
  manifest: EvidenceManifest,
): PersistedSemanticSourcePlan {
  if (input !== null && typeof input === "object") {
    const schemaVersion = (input as { schema_version?: unknown }).schema_version;
    if (
      schemaVersion === PLAN_SCHEMA_VERSION
      || schemaVersion === COMPACT_PLAN_SCHEMA_VERSION
    ) {
      return structuredClone(input) as PersistedSemanticSourcePlan;
    }
  }
  return upgradePlanToCurrent(input, manifest);
}
