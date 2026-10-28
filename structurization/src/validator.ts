import Ajv, { type ErrorObject, type ValidateFunction } from "ajv";
import { partitionValidationIssues, STRUCTURAL_VALIDATION_BOUNDARY } from "./validation-boundary.js";

import type {
  AcceptanceItemField,
  EvidenceManifest,
  PersistedSemanticSourcePlan,
  ReferenceImportField,
  SemanticSourcePlan,
  SemanticSourcePlanV8,
  TableReferenceOccurrence,
  ValidationIssue,
  ValidationResult,
} from "./contracts.js";
import {
  COMPACT_PLAN_SCHEMA_VERSION,
  PLAN_SCHEMA_VERSION,
  referenceOccurrenceLiteralSpanIds,
  referenceOccurrenceLiterals,
  referenceOccurrenceOriginEvidenceIds,
  referenceOccurrenceOriginSpanIds,
  TABLE_ASSEMBLY_SCHEMA_VERSION,
  UNLABELED_ITEM_CATEGORY,
} from "./contracts.js";
import { referenceRowRepairCandidates } from "./reference-row-repair.js";
import { ensureActionableIssue } from "./actionable-error.js";
import { canonicalize, sha256Text } from "./canonical.js";
import { compiledUnhandledEvidenceIds } from "./evidence-disposition-coverage.js";
import { planHasContextReference } from "./context-reference.js";
import { buildPlanContract } from "./source-plan-contract.js";
import { DuplicateJsonKeyError, strictJsonParse } from "./strict-json.js";
import { validateTableAssembly } from "./table-assembly.js";
import { hydrateSemanticSourcePlan, isCompactSemanticSourcePlan, PlanHydrationError } from "./plan-hydration.js";
import { createPlanSourceResolver } from "./plan-source-resolver.js";
import { sourceSpanCoveredBy } from "./source-span-registry.js";
import { mergeSamplingComponents, validateSamplingComponents } from "./sampling-components.js";
import {
  semanticReferenceEvidenceIdsForDestination,
  validateSemanticDraft,
} from "./semantic-draft.js";

function isPureClauseForwarder(templated: string): boolean {
  const withoutNumber = templated
    .replace(/^\d+(?:\.\d+)+/u, "")
    .replace(/[。；;，,:：]+$/gu, "");
  const pureForwarder = new RegExp(
    "^([^，；;。:：]*?)(?:应|须|均)?(?:并且|并|且)?(?:符合|遵守|执行|参见|详见|见|按照|按)"
      + "(?:(?:本规范)?(?:第)?§(?:条|款|节|章|表|附录)?(?:、|和|及|与)?)+"
      + "(?:的)?(?:规定|要求)?$",
    "u",
  ).exec(withoutNumber);
  if (pureForwarder && !/(?:应|须|必须|不得|不应|严禁|宜|可)/u.test(pureForwarder[1] ?? "")) {
    return true;
  }
  return false;
}

/** Retain the complete unit for this occurrence, including any explicit shared introduction. */
export function retainsCompleteReferenceUnit(
  origin: string,
  fragments: readonly string[],
  rawReference: string,
  originReferences: readonly string[],
): boolean {
  const normalize = (text: string) => text.normalize("NFKC").replace(/\s+/gu, "");
  const comparable = (text: string) => normalize(text)
    .replace(/^\d+(?:\.\d+)+/u, "").replace(/[。；;]+$/gu, "");
  const reference = normalize(rawReference);
  if (!reference) return false;
  const references = [...new Set(originReferences.map(normalize).filter(Boolean))];
  const units = comparable(origin).split("。").flatMap(sentence =>
    sentence.split(/[；;]/u).filter(Boolean).map(text => ({ text, sentence })));
  const selected = units.filter(unit => unit.text.includes(reference));
  // Repeated occurrences need the existing full-origin proof; text alone cannot disambiguate them.
  if (selected.length !== 1 || selected[0]!.text.split(reference).length !== 2) return false;
  const unit = selected[0]!;
  let templated = unit.text;
  for (const candidate of references) templated = templated.split(candidate).join("§");
  const fragmentIntervals = fragments.flatMap(fragment => {
    const text = comparable(fragment);
    const start = text ? unit.text.indexOf(text) : -1;
    // Repeated fragments need coordinate proof; never fill multiple positions by guess.
    return start >= 0 && unit.text.indexOf(text, start + 1) < 0
      ? [{ start, end: start + text.length }] : [];
  }).sort((left, right) => left.start - right.start);
  let coveredEnd = 0;
  for (const interval of fragmentIntervals) {
    if (interval.start > coveredEnd) break;
    coveredEnd = Math.max(coveredEnd, interval.end);
  }
  if (!templated.includes("§") || !isPureClauseForwarder(templated)
    || coveredEnd !== unit.text.length) return false;
  // A colon scopes an introduction over the following semicolon-separated clauses.
  // Do not drop that shared condition merely because this occurrence is in a later clause.
  const introductionEnd = unit.sentence.indexOf(":");
  if (introductionEnd >= 0 && introductionEnd < unit.sentence.indexOf(unit.text)) {
    const introduction = unit.sentence.slice(0, introductionEnd + 1);
    if (!fragments.some(fragment => comparable(fragment).includes(introduction))) return false;
  }
  return true;
}

export function clauseReferenceLocalResidual(value: string, rawReference: string): string {
  return clauseReferenceGroupLocalResidual(value, [rawReference]);
}

export function clauseReferenceGroupLocalResidual(value: string, rawReferences: readonly string[]): string {
  return clauseReferenceResidual(value, rawReferences, false);
}

function clauseReferenceResidual(value: string, rawReferences: readonly string[], preserveForwarderSubject: boolean): string {
  const normalize = (text: string): string => text.normalize("NFKC").replace(/\s+/gu, "");
  const normalizedValue = normalize(value);
  const normalizedReferences = [...new Set(rawReferences.map(normalize).filter(Boolean))];
  if (normalizedReferences.length === 0) return "";
  let templated = normalizedValue;
  let matched = false;
  for (const reference of normalizedReferences) {
    if (!templated.includes(reference)) continue;
    matched = true;
    templated = templated.split(reference).join("§");
  }
  if (!matched) return "";
  if (!preserveForwarderSubject && isPureClauseForwarder(templated)) return "";
  return templated
    .replace(/§/gu, "")
    .replace(/^\d+(?:\.\d+)+/u, "")
    .replace(/(?:本规范|第|条|款|节|章|表|附录)/gu, "")
    .replace(/(?:应|须|宜|可|均|并|且|按照|按|符合|遵守|执行|参见|详见|见|本条|本节|有关|相关|的|之|规定|要求)/gu, "")
    .replace(/[\p{P}\p{S}\d]/gu, "");
}

const fieldBindingSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "status",
    "composition",
    "evidence_ids",
    "source_fragments",
    "value_sha256",
    "reason",
  ],
  properties: {
    status: {
      enum: ["bound", "not_found_in_evidence", "not_applicable", "review"],
    },
    composition: {
      enum: ["verbatim", "semantic_summary", "shared_inheritance", "reference", "not_applicable"],
    },
    evidence_ids: {
      type: "array",
      items: { type: "string" },
      uniqueItems: true,
    },
    source_fragments: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["evidence_id", "text"],
        properties: {
          evidence_id: { type: "string", minLength: 1 },
          text: { type: "string", minLength: 1 },
        },
      },
    },
    value_sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
    reason: { type: "string", minLength: 1 },
  },
} as const;

const referenceImportScopeSchema = {
  type: "object",
  additionalProperties: false,
  required: ["mode", "allowed_fields", "reason"],
  properties: {
    mode: { enum: ["field_specific", "full_acceptance_procedure"] },
    allowed_fields: {
      type: "array",
      minItems: 1,
      uniqueItems: true,
      items: { enum: ["name", "requirement", "method", "quantity", "note", "sampling"] },
    },
    reason: { type: "string", minLength: 1 },
  },
} as const;

export const SEMANTIC_SOURCE_PLAN_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "schema_version",
    "job_id",
    "target_id",
    "evidence_fingerprint",
    "table_assembly",
    "inspection_lots",
    "acceptance_items",
    "reference_resolutions",
    "evidence_dispositions",
  ],
  properties: {
    schema_version: { const: PLAN_SCHEMA_VERSION },
    job_id: { type: "string", minLength: 1 },
    target_id: { type: "string", minLength: 1 },
    evidence_fingerprint: { type: "string", pattern: "^[a-f0-9]{64}$" },
    table_assembly: {
      type: "object",
      additionalProperties: false,
      required: [
        "schema_version",
        "evidence_fingerprint",
        "logical_tables",
        "fragment_dispositions",
      ],
      properties: {
        schema_version: { const: TABLE_ASSEMBLY_SCHEMA_VERSION },
        evidence_fingerprint: { type: "string", pattern: "^[a-f0-9]{64}$" },
        logical_tables: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: [
              "logical_table_id",
              "canonical_title",
              "canonical_title_fragments",
              "evidence_ids",
              "fragment_ids",
              "reason",
              "confidence",
            ],
            properties: {
              logical_table_id: { type: "string", minLength: 1 },
              canonical_title: { type: "string" },
              canonical_title_fragments: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["evidence_id", "text"],
                  properties: {
                    evidence_id: { type: "string", minLength: 1 },
                    text: { type: "string", minLength: 1 },
                  },
                },
              },
              evidence_ids: {
                type: "array",
                items: { type: "string" },
                uniqueItems: true,
              },
              fragment_ids: {
                type: "array",
                items: { type: "string" },
                uniqueItems: true,
              },
              row_roles: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["evidence_id", "role", "reason"],
                  properties: {
                    evidence_id: { type: "string", minLength: 1 },
                    role: { enum: ["header", "data", "repeated_header", "note", "context"] },
                    reason: { type: "string", minLength: 1 },
                  },
                },
              },
              reason: { type: "string", minLength: 1 },
              confidence: { type: "number", minimum: 0, maximum: 1 },
            },
          },
        },
        fragment_dispositions: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["fragment_id", "disposition", "logical_table_id", "reason"],
            properties: {
              fragment_id: { type: "string", minLength: 1 },
              disposition: { enum: ["assigned", "context", "review"] },
              logical_table_id: { type: "string" },
              reason: { type: "string", minLength: 1 },
            },
          },
        },
      },
    },
    inspection_lots: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["lot_id", "name", "evidence_ids", "item_ids"],
        properties: {
          lot_id: { type: "string", minLength: 1 },
          name: { type: "string", minLength: 1 },
          evidence_ids: { type: "array", items: { type: "string" }, uniqueItems: true },
          item_ids: { type: "array", items: { type: "string" }, uniqueItems: true },
        },
      },
    },
    acceptance_items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "item_id",
          "lot_id",
          "name",
          "category",
          "requirement",
          "method",
          "quantity",
          "note",
          "evidence_ids",
          "reference_evidence_ids",
          "table_semantics",
          "inspection_data_type",
          "inspection_data_type_reason",
          "inspection_data_type_evidence_ids",
          "field_bindings",
          "sampling",
        ],
        properties: {
          item_id: { type: "string", minLength: 1 },
          lot_id: { type: "string", minLength: 1 },
          name_path: {
            type: "array", minItems: 1,
            items: { type: "string", minLength: 1, pattern: "^[^\\\\]+$" },
            description: "模型确认的名称层级，从外到内；每级非空且不含反斜杠。不改变项目边界。",
          },
          name: {
            type: "string",
            minLength: 1,
            description: "简洁检查点名词短语：被检对象加独立判定的质量特性。说明查什么，不说明怎样判合格。",
          },
          category: { enum: ["主控项目", "一般项目", UNLABELED_ITEM_CATEGORY] },
          requirement: {
            type: "string",
            description: "完整验收判据。即使名称作语义概括，此处仍保留否定、数值、单位、条件、例外和被引要求。",
          },
          method: { type: "string" },
          quantity: { type: "string" },
          note: { type: "string" },
          evidence_ids: {
            type: "array",
            minItems: 1,
            items: { type: "string" },
            uniqueItems: true,
          },
          reference_evidence_ids: {
            type: "array",
            items: { type: "string" },
            uniqueItems: true,
          },
          table_semantics: tableCriterionSchema(),
          inspection_data_type: {
            enum: ["measurement", "counting", "mixed", "review"],
            description: "由 Agent 作出的建设工程质量专业判断，确定性验证不得依据措辞、数字、单位或版式重新分类。",
          },
          inspection_data_type_reason: {
            type: "string",
            minLength: 1,
            description: "专业理由应涵盖产生的检查数据、逐单元判断和最终评价，不能把模型推断误说成原文明确标签。",
          },
          inspection_data_type_evidence_ids: {
            type: "array",
            minItems: 1,
            items: { type: "string" },
            uniqueItems: true,
          },
          field_bindings: {
            type: "object",
            additionalProperties: false,
            required: ["name", "requirement", "method", "quantity", "note"],
            properties: {
              name: fieldBindingSchema,
              requirement: fieldBindingSchema,
              method: fieldBindingSchema,
              quantity: fieldBindingSchema,
              note: fieldBindingSchema,
            },
          },
          sampling: {
            type: "object",
            additionalProperties: false,
            required: [
              "status",
              "min_sampling",
              "script",
              "reason",
              "confidence",
              "evidence_ids",
            ],
            properties: {
              status: {
                enum: ["explicit", "reference", "reference_unspecified_quantity", "fallback", "not_sampling"],
              },
              min_sampling: { type: "string" },
              script: { type: "string", description: "派生的受限抽样表达式；未实现或不能无损表达时为空。原文依据由来源绑定独立保留，旧成品允许读取历史话述。" },
              reason: { type: "string", minLength: 1 },
              confidence: { type: "number", minimum: 0, maximum: 1 },
              evidence_ids: {
                type: "array",
                items: { type: "string" },
                uniqueItems: true,
              },
              rule_ids: {
                type: "array",
                items: { type: "string" },
                uniqueItems: true,
              },
              branch_ids: {
                type: "array",
                items: { type: "string" },
                uniqueItems: true,
              },
              applied_branches: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["rule_id", "branch_id", "min_sampling", "script", "conditions", "evidence_ids"],
                  properties: {
                    rule_id: { type: "string", minLength: 1 },
                    branch_id: { type: "string", minLength: 1 },
                    min_sampling: { type: "string" },
                    script: { type: "string", description: "派生的受限抽样表达式；未实现或不能无损表达时为空。原文依据由来源绑定独立保留，旧成品允许读取历史话述。" },
                    conditions: {
                      type: "array",
                      items: {
                        type: "object",
                        additionalProperties: false,
                        required: ["condition_id", "text", "evidence_id", "exact_fragment"],
                        properties: {
                          condition_id: { type: "string", minLength: 1 },
                          text: { type: "string", minLength: 1 },
                          evidence_id: { type: "string", minLength: 1 },
                          exact_fragment: { type: "string", minLength: 1 },
                        },
                      },
                    },
                    evidence_ids: {
                      type: "array",
                      minItems: 1,
                      items: { type: "string", minLength: 1 },
                      uniqueItems: true,
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    reference_resolutions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "resolution_id",
          "occurrence_id",
          "origin_evidence_id",
          "action",
          "application_mode",
          "import_scope",
          "target_evidence_ids",
          "destination_bindings",
          "reason",
        ],
        properties: {
          resolution_id: { type: "string", minLength: 1 },
          occurrence_id: { type: "string", minLength: 1 },
          origin_evidence_id: { type: "string", minLength: 1 },
          action: {
            enum: [
              "adopt",
              "conditional",
              "compare",
              "mention",
              "keep_reference",
              "review",
            ],
          },
          application_mode: {
            enum: ["replace_field", "reference_only", "reference_placeholder"],
          },
          import_scope: referenceImportScopeSchema,
          origin_binding: {
            type: "object",
            additionalProperties: false,
            required: ["item_id", "target_field"],
            properties: {
              item_id: { type: "string", minLength: 1 },
              target_field: { enum: ["name", "requirement", "method", "quantity", "note", "sampling"] },
            },
          },
          target_evidence_ids: {
            type: "array",
            items: { type: "string" },
            uniqueItems: true,
          },
          destination_bindings: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["item_id", "target_field"],
              properties: {
                item_id: { type: "string", minLength: 1 },
                target_field: {
                  enum: [
                    "name",
                    "requirement",
                    "method",
                    "quantity",
                    "note",
                    "sampling",
                    "reference_only",
                  ],
                },
              },
            },
          },
          reason: { type: "string", minLength: 1 },
        },
      },
    },
    evidence_dispositions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["evidence_id", "disposition", "item_ids", "reason"],
        properties: {
          evidence_id: { type: "string", minLength: 1 },
          disposition: { enum: ["used", "context", "ignored"] },
          item_ids: { type: "array", items: { type: "string" }, uniqueItems: true },
          reason: { type: "string", minLength: 1 },
        },
      },
    },
    semantic_evidence: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "semantic_id",
          "role",
          "evidence_id",
          "exact_fragment",
          "parent_semantic_id",
          "materialized_item_id",
          "reason",
        ],
        properties: {
          semantic_id: { type: "string", minLength: 1 },
          role: {
            enum: [
              "reference_anchor",
              "referenced_clause",
              "continuation",
              "acceptance_item",
              "table_criterion",
              "acceptance_condition",
              "sampling_rule",
            ],
          },
          evidence_id: { type: "string", minLength: 1 },
          exact_fragment: { type: "string", minLength: 1 },
          parent_semantic_id: { type: "string" },
          materialized_item_id: { type: "string" },
          reason: { type: "string", minLength: 1 },
        },
      },
    },
    semantic_references: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "expansion_id",
          "anchor_semantic_id",
          "status",
          "import_scope",
          "target_semantic_ids",
          "destination_bindings",
          "reason",
        ],
        properties: {
          expansion_id: { type: "string", minLength: 1 },
          anchor_semantic_id: { type: "string", minLength: 1 },
          status: { enum: ["resolved", "not_applicable", "review"] },
          import_scope: referenceImportScopeSchema,
          target_semantic_ids: {
            type: "array",
            items: { type: "string" },
            uniqueItems: true,
          },
          destination_bindings: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["item_id", "fields"],
              properties: {
                item_id: { type: "string", minLength: 1 },
                fields: {
                  type: "array",
                  minItems: 1,
                  items: {
                    enum: ["name", "requirement", "method", "quantity", "note", "sampling", "reference_only"],
                  },
                  uniqueItems: true,
                },
              },
            },
          },
          reason: { type: "string", minLength: 1 },
        },
      },
    },
    shared_sampling_rules: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "rule_id",
          "source_semantic_id",
          "evidence_ids",
          "complete_source_fragment",
          "branches",
          "shared_conditions",
          "receiving_item_ids",
          "reason",
        ],
        properties: {
          rule_id: { type: "string", minLength: 1 },
          source_semantic_id: { type: "string", minLength: 1 },
          evidence_ids: {
            type: "array",
            minItems: 1,
            items: { type: "string" },
            uniqueItems: true,
          },
          complete_source_fragment: { type: "string", minLength: 1 },
          branches: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              additionalProperties: false,
              required: [
                "branch_id",
                "applies_to_category",
                "min_sampling",
                "script",
                "evidence_id",
                "exact_fragment",
              ],
              properties: {
                branch_id: { type: "string", minLength: 1 },
                applies_to_category: { enum: ["主控项目", "一般项目", "all_items"] },
                min_sampling: { type: "string" },
                script: { type: "string", description: "派生的受限抽样表达式；未实现或不能无损表达时为空。原文依据由来源绑定独立保留，旧成品允许读取历史话述。" },
                evidence_id: { type: "string", minLength: 1 },
                exact_fragment: { type: "string", minLength: 1 },
                conditions: {
                  type: "array",
                  items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["condition_id", "text", "evidence_id", "exact_fragment"],
                    properties: {
                      condition_id: { type: "string", minLength: 1 },
                      text: { type: "string", minLength: 1 },
                      evidence_id: { type: "string", minLength: 1 },
                      exact_fragment: { type: "string", minLength: 1 },
                    },
                  },
                },
              },
            },
          },
          shared_conditions: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["condition_id", "text", "evidence_id", "exact_fragment"],
              properties: {
                condition_id: { type: "string", minLength: 1 },
                text: { type: "string", minLength: 1 },
                evidence_id: { type: "string", minLength: 1 },
                exact_fragment: { type: "string", minLength: 1 },
              },
            },
          },
          receiving_item_ids: {
            type: "array",
            minItems: 1,
            items: { type: "string" },
            uniqueItems: true,
          },
          reason: { type: "string", minLength: 1 },
        },
      },
    },
  },
} as const;

function tableCriterionSchema() {
  return {
  anyOf: [
    { type: "null" },
    {
      type: "object",
      additionalProperties: false,
      required: [
        "source_kind",
        "table_id",
        "table_no",
        "table_title",
        "applicability",
        "row_path",
        "column_path",
        "unit",
        "condition",
        "allowed_value",
        "inspection_method",
        "cell_evidence",
        "reference_fragments",
      ],
      properties: {
        source_kind: { enum: ["direct", "reference"] },
        table_id: { type: "string", minLength: 1 },
        table_no: { type: "string" },
        table_title: { type: "string" },
        applicability: { type: "string" },
        row_path: {
          type: "array",
          items: { type: "string", minLength: 1 },
        },
        column_path: {
          type: "array",
          items: { type: "string", minLength: 1 },
        },
        unit: { type: "string" },
        condition: { type: "string" },
        allowed_value: { type: "string", minLength: 1 },
        acceptance_branches: {
          type: "array",
          minItems: 2,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["branch_id", "condition", "requirement", "allowed_value", "condition_fragments", "requirement_fragments", "allowed_value_fragments"],
            properties: {
              branch_id: { type: "string", minLength: 1 },
              condition: { type: "string", minLength: 1 },
              requirement: { type: "string", minLength: 1 },
              allowed_value: { type: "string", minLength: 1 },
              condition_fragments: {
                type: "array", minItems: 1,
                items: { type: "object", additionalProperties: false, required: ["evidence_id", "text"], properties: { evidence_id: { type: "string", minLength: 1 }, text: { type: "string", minLength: 1 } } },
              },
              requirement_fragments: {
                type: "array", minItems: 1,
                items: { type: "object", additionalProperties: false, required: ["evidence_id", "text"], properties: { evidence_id: { type: "string", minLength: 1 }, text: { type: "string", minLength: 1 } } },
              },
              allowed_value_fragments: {
                type: "array", minItems: 1,
                items: { type: "object", additionalProperties: false, required: ["evidence_id", "text"], properties: { evidence_id: { type: "string", minLength: 1 }, text: { type: "string", minLength: 1 } } },
              },
            },
          },
        },
        inspection_method: { type: "string" },
        cell_evidence: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["role", "evidence_id", "text"],
            properties: {
              role: {
                enum: [
                  "table_no",
                  "table_title",
                  "applicability",
                  "row_header",
                  "column_header",
                  "unit",
                  "condition",
                  "allowed_value",
                  "inspection_method",
                ],
              },
              evidence_id: { type: "string", minLength: 1 },
              text: { type: "string", minLength: 1 },
            },
          },
        },
        reference_fragments: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["evidence_id", "text"],
            properties: {
              evidence_id: { type: "string", minLength: 1 },
              text: { type: "string", minLength: 1 },
            },
          },
        },
      },
    },
  ],
  } as const;
}

export function semanticSourcePlanJsonSchemaFor(
  manifest: EvidenceManifest,
): object {
  const schema = structuredClone(SEMANTIC_SOURCE_PLAN_JSON_SCHEMA) as unknown as {
    properties: Record<string, unknown>;
    required: string[];
  };
  if (!manifest.source.semantic_workflow) {
    delete schema.properties.semantic_evidence;
    delete schema.properties.semantic_references;
    delete schema.properties.shared_sampling_rules;
  } else {
    schema.required.push(
      "semantic_evidence",
      "semantic_references",
      "shared_sampling_rules",
    );
  }
  return schema;
}

const AjvConstructor = Ajv as unknown as {
  new(options?: object): { compile(schema: object): ValidateFunction };
};
const ajv = new AjvConstructor({ allErrors: true, strict: true });
const schemaValidator = ajv.compile(SEMANTIC_SOURCE_PLAN_JSON_SCHEMA);

const compactSpanIdsSchema = {
  type: "array",
  items: { type: "string", pattern: "^span:[a-f0-9]{32}$" },
  uniqueItems: true,
} as const;

const compactConditionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["condition_id", "text", "source_span_ids"],
  properties: {
    condition_id: { type: "string", minLength: 1 },
    text: { type: "string", minLength: 1 },
    source_span_ids: compactSpanIdsSchema,
  },
} as const;

const samplingComponentSchema = {
  type: "object",
  additionalProperties: false,
  required: ["key", "role", "disposition", "source_span_ids", "reason"],
  properties: {
    key: { type: "string", minLength: 1 },
    role: { enum: ["applicability", "branch_condition", "method", "quantity", "acceptance_criterion", "exception", "note"] },
    disposition: { enum: ["present", "absent", "not_applicable"] },
    source_span_ids: compactSpanIdsSchema,
    reason: { type: "string", minLength: 1 },
  },
} as const;

function compactPlanJsonSchema(): object {
  const schema = structuredClone(SEMANTIC_SOURCE_PLAN_JSON_SCHEMA) as unknown as {
    required: string[];
    properties: Record<string, any>;
  };
  schema.required.push("source_spans");
  schema.properties.schema_version = { const: COMPACT_PLAN_SCHEMA_VERSION };
  schema.properties.validation_boundary = { const: STRUCTURAL_VALIDATION_BOUNDARY };
  schema.properties.source_spans = {
    type: "array",
    items: {
      type: "object",
      additionalProperties: false,
      required: ["span_id", "evidence_id", "start", "end", "text_sha256"],
      properties: {
        span_id: { type: "string", pattern: "^span:[a-f0-9]{32}$" },
        evidence_id: { type: "string", minLength: 1 },
        start: { type: "integer", minimum: 0 },
        end: { type: "integer", minimum: 1 },
        text_sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
      },
    },
  };

  const logicalTable = schema.properties.table_assembly.properties.logical_tables.items;
  logicalTable.required = logicalTable.required.map((name: string) =>
    name === "canonical_title_fragments" ? "canonical_title_span_ids" : name
  );
  delete logicalTable.properties.canonical_title_fragments;
  logicalTable.properties.canonical_title_span_ids = compactSpanIdsSchema;

  const item = schema.properties.acceptance_items.items;
  for (const field of ["name", "requirement", "method", "quantity", "note"]) {
    const binding = item.properties.field_bindings.properties[field];
    binding.required = binding.required.map((name: string) =>
      name === "source_fragments" ? "source_span_ids" : name
    );
    delete binding.properties.source_fragments;
    binding.properties.source_span_ids = compactSpanIdsSchema;
  }
  const table = item.properties.table_semantics.anyOf[1];
  table.required = table.required.map((name: string) =>
    name === "reference_fragments" ? "reference_span_ids" : name
  );
  table.properties.cell_evidence.items.required = ["role", "span_id"];
  delete table.properties.cell_evidence.items.properties.evidence_id;
  delete table.properties.cell_evidence.items.properties.text;
  table.properties.cell_evidence.items.properties.span_id = { type: "string", pattern: "^span:[a-f0-9]{32}$" };
  const acceptanceBranch = table.properties.acceptance_branches.items;
  for (const [fragmentField, spanField] of [
    ["condition_fragments", "condition_span_ids"],
    ["requirement_fragments", "requirement_span_ids"],
    ["allowed_value_fragments", "allowed_value_span_ids"],
  ] as const) {
    acceptanceBranch.required = acceptanceBranch.required.map((name: string) =>
      name === fragmentField ? spanField : name
    );
    delete acceptanceBranch.properties[fragmentField];
    acceptanceBranch.properties[spanField] = compactSpanIdsSchema;
  }
  delete table.properties.reference_fragments;
  table.properties.reference_span_ids = compactSpanIdsSchema;

  const applied = item.properties.sampling.properties.applied_branches.items;
  applied.required.push("effective_components");
  applied.properties.conditions.items = compactConditionSchema;
  applied.properties.effective_components = { type: "array", items: samplingComponentSchema };

  const semanticNode = schema.properties.semantic_evidence.items;
  semanticNode.required = semanticNode.required
    .filter((name: string) => name !== "evidence_id" && name !== "exact_fragment")
    .concat("span_id");
  delete semanticNode.properties.evidence_id;
  delete semanticNode.properties.exact_fragment;
  semanticNode.properties.span_id = { type: "string", pattern: "^span:[a-f0-9]{32}$" };

  const rule = schema.properties.shared_sampling_rules.items;
  rule.required = rule.required
    .filter((name: string) => name !== "complete_source_fragment")
    .concat("complete_span_ids", "components");
  delete rule.properties.complete_source_fragment;
  rule.properties.complete_span_ids = compactSpanIdsSchema;
  rule.properties.components = { type: "array", items: samplingComponentSchema };
  const branch = rule.properties.branches.items;
  branch.required = branch.required
    .filter((name: string) => name !== "evidence_id" && name !== "exact_fragment")
    .concat("source_span_ids", "components");
  delete branch.properties.evidence_id;
  delete branch.properties.exact_fragment;
  branch.properties.source_span_ids = compactSpanIdsSchema;
  branch.properties.conditions.items = compactConditionSchema;
  branch.properties.components = { type: "array", items: samplingComponentSchema };
  rule.properties.shared_conditions.items = compactConditionSchema;
  return schema;
}

export const COMPACT_SEMANTIC_SOURCE_PLAN_JSON_SCHEMA = compactPlanJsonSchema();
const compactSchemaValidator = ajv.compile(COMPACT_SEMANTIC_SOURCE_PLAN_JSON_SCHEMA);

function schemaIssues(errors: ErrorObject[] | null | undefined): ValidationIssue[] {
  return (errors ?? []).map((error) => ({
    code: "schema",
    path: error.instancePath || "/",
    message: error.message ?? "JSON schema validation failed",
    details: {
      required_action: error.message ?? "Fix the JSON so it matches the plan schema",
      ...(error.params && typeof error.params === "object" ? error.params as Record<string, unknown> : { actual: error.params }),
    },
  }));
}

function duplicates(values: string[]): string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) repeated.add(value);
    seen.add(value);
  }
  return [...repeated].sort();
}

function pushUnknownEvidence(
  issues: ValidationIssue[],
  knownEvidence: Set<string>,
  values: string[],
  path: string,
): void {
  const unknown = [...new Set(values.filter((value) => !knownEvidence.has(value)))].sort();
  if (unknown.length) {
    issues.push({
      code: "unknown_evidence",
      path,
      message: "The plan cites evidence IDs that do not exist in the immutable evidence manifest",
      details: { required_action: "The plan cites evidence IDs that do not exist in the immutable evidence manifest", evidence_ids: unknown },
    });
  }
}

const BOUND_FIELDS: AcceptanceItemField[] = [
  "name",
  "requirement",
  "method",
  "quantity",
  "note",
];

const TABLE_PROPERTY_EVIDENCE_ROLES = [
  ["table_no", "table_no"],
  ["table_title", "table_title"],
  ["applicability", "applicability"],
  ["unit", "unit"],
  ["condition", "condition"],
  ["allowed_value", "allowed_value"],
  ["inspection_method", "inspection_method"],
] as const;

function referencedTableItemCoverage(
  plan: SemanticSourcePlan,
  occurrence: TableReferenceOccurrence,
  manifest: EvidenceManifest,
): { data_row_evidence_ids: string[]; uncovered_data_row_evidence_ids: string[] } {
  const normalizeTableId = (value: string): string =>
    value.normalize("NFKC").replace(/^\s*续?表\s*/u, "").trim();
  const targetTableId = normalizeTableId(occurrence.target_table_id);
  if (!targetTableId || occurrence.target_evidence_ids.length === 0) {
    return { data_row_evidence_ids: [], uncovered_data_row_evidence_ids: [] };
  }
  const targetEvidenceIds = new Set(occurrence.target_evidence_ids);
  const evidenceById = new Map(manifest.evidence.map((record) => [record.evidence_id, record]));
  const fragmentById = new Map(manifest.table_fragments.map((fragment) => [
    fragment.fragment_id,
    fragment,
  ]));
  const targetFragments = manifest.table_fragments.filter((fragment) =>
    normalizeTableId(fragment.provisional_table_id) === targetTableId
  );
  const formalRowEvidenceIds = new Set(targetFragments.flatMap((fragment) =>
    fragment.formal_row_evidence_ids
  ));
  const fragmentIdsByEvidenceId = new Map<string, Set<string>>();
  for (const fragment of manifest.table_fragments) {
    for (const evidenceId of [
      ...fragment.title_candidate_evidence_ids,
      ...fragment.header_evidence_ids,
      ...fragment.row_evidence_ids,
      ...fragment.formal_row_evidence_ids,
    ]) {
      const fragmentIds = fragmentIdsByEvidenceId.get(evidenceId) ?? new Set<string>();
      fragmentIds.add(fragment.fragment_id);
      fragmentIdsByEvidenceId.set(evidenceId, fragmentIds);
    }
  }
  const belongsToTargetTable = (evidenceId: string): boolean => {
    const evidence = evidenceById.get(evidenceId);
    if (evidence?.table_id && normalizeTableId(evidence.table_id) === targetTableId) return true;
    const fragmentIds = new Set(fragmentIdsByEvidenceId.get(evidenceId) ?? []);
    if (evidence?.table_fragment_id) fragmentIds.add(evidence.table_fragment_id);
    return [...fragmentIds].some((fragmentId) => {
      const fragment = fragmentById.get(fragmentId);
      return Boolean(fragment && normalizeTableId(fragment.provisional_table_id) === targetTableId);
    });
  };
  const rowRoles = plan.table_assembly.logical_tables.flatMap(table => table.row_roles ?? []);
  const confirmedDataRows = new Set(rowRoles.filter(row => row.role === "data").map(row => row.evidence_id));
  const confirmedStructuralRows = new Set(rowRoles.filter(row => row.role !== "data").map(row => row.evidence_id));
  const dataRowEvidenceIds = [...targetEvidenceIds].filter((evidenceId) => {
    const evidence = evidenceById.get(evidenceId);
    const confirmedRole = plan.table_assembly.logical_tables
      .filter(table => table.fragment_ids.some(id => targetFragments.some(fragment => fragment.fragment_id === id)))
      .flatMap(table => table.row_roles ?? []).find(row => row.evidence_id === evidenceId)?.role;
    return evidence?.kind === "table_row"
      && (confirmedRole ? confirmedRole === "data"
        : (evidence.table_row_kind === "data" || formalRowEvidenceIds.has(evidenceId)))
      && belongsToTargetTable(evidenceId);
  });
  const coveredEvidenceIds = new Set(plan.acceptance_items.flatMap((item) => {
    if (!item.table_semantics) return [];
    return [
      ...item.evidence_ids,
      ...item.table_semantics.cell_evidence
        .filter((cell) => !["table_no", "table_title", "applicability"].includes(cell.role))
        .map((cell) => cell.evidence_id),
    ].filter((evidenceId) => belongsToTargetTable(evidenceId));
  }));
  return {
    data_row_evidence_ids: dataRowEvidenceIds,
    uncovered_data_row_evidence_ids: dataRowEvidenceIds.filter((evidenceId) => !coveredEvidenceIds.has(evidenceId)),
  };
}

function compactPlanSpanReferences(plan: SemanticSourcePlanV8): Array<{ span_id: string; path: string }> {
  const references: Array<{ span_id: string; path: string }> = [];
  const visit = (value: unknown, path: string): void => {
    if (Array.isArray(value)) {
      value.forEach((entry, index) => visit(entry, `${path}/${index}`));
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      const childPath = `${path}/${key}`;
      if (path.startsWith("/source_spans")) continue;
      if ((key === "span_id" || key.endsWith("_span_id")) && typeof child === "string") {
        references.push({ span_id: child, path: childPath });
      } else if ((key === "span_ids" || key.endsWith("_span_ids")) && Array.isArray(child)) {
        child.forEach((spanId, index) => {
          if (typeof spanId === "string") references.push({ span_id: spanId, path: `${childPath}/${index}` });
        });
      } else {
        visit(child, childPath);
      }
    }
  };
  visit(plan, "");
  return references;
}

function validateCompactPlan(
  plan: SemanticSourcePlanV8,
  manifest: EvidenceManifest,
  openedEvidenceIds?: Set<string>,
): ValidationResult {
  const issues: ValidationIssue[] = [];
  const resolver = createPlanSourceResolver(plan, manifest);
  const references = compactPlanSpanReferences(plan);
  for (const reference of references) resolver.resolve(reference.span_id, reference.path, issues);
  const referencedSpanIds = new Set(references.map((reference) => reference.span_id));
  plan.source_spans.forEach((span, index) => {
    resolver.resolve(span.span_id, `/source_spans/${index}`, issues);
    if (!referencedSpanIds.has(span.span_id)) {
      issues.push({
        code: "plan_span_unreferenced",
        path: `/source_spans/${index}`,
        message: "The plan-local source span catalog must contain only the provenance closure used by this plan",
        details: { required_action: "The plan-local source span catalog must contain only the provenance closure used by this plan", span_id: span.span_id },
      });
    }
  });

  const ruleById = new Map((plan.shared_sampling_rules ?? []).map((rule) => [rule.rule_id, rule]));
  (plan.shared_sampling_rules ?? []).forEach((rule, ruleIndex) => {
    issues.push(...validateSamplingComponents(rule.components, `/shared_sampling_rules/${ruleIndex}/components`));
    rule.branches.forEach((branch, branchIndex) => {
      issues.push(...validateSamplingComponents(
        branch.components,
        `/shared_sampling_rules/${ruleIndex}/branches/${branchIndex}/components`,
      ));
    });
  });
  plan.acceptance_items.forEach((item, itemIndex) => {
    (item.sampling.applied_branches ?? []).forEach((applied, appliedIndex) => {
      const path = `/acceptance_items/${itemIndex}/sampling/applied_branches/${appliedIndex}`;
      const rule = ruleById.get(applied.rule_id);
      const branch = rule?.branches.find((candidate) => candidate.branch_id === applied.branch_id);
      if (!rule || !branch) return;
      const expected = mergeSamplingComponents(rule.components, branch.components, `${path}/expected_components`);
      issues.push(...expected.issues);
      issues.push(...validateSamplingComponents(applied.effective_components, `${path}/effective_components`));
      const canonicalComponents = (components: typeof applied.effective_components) => canonicalize(
        [...components].sort((left, right) => (
          `${left.key}\0${left.role}`.localeCompare(`${right.key}\0${right.role}`)
        )),
      );
      if (canonicalComponents(expected.components) !== canonicalComponents(applied.effective_components)) {
        issues.push({
          code: "sampling_applied_components_incomplete",
          path: `${path}/effective_components`,
          message: "Every registered shared and branch-local sampling component must be materialized on the applied branch",
          details: { required_action: "Every registered shared and branch-local sampling component must be materialized on the applied branch",
            expected_component_keys: expected.components.map((component) => component.key),
            actual_component_keys: applied.effective_components.map((component) => component.key),
          },
        });
      }
    });
  });

  let hydrated: SemanticSourcePlan | undefined;
  try {
    hydrated = hydrateSemanticSourcePlan(plan, manifest);
  } catch (error) {
    if (error instanceof PlanHydrationError) issues.push(...error.issues.map(ensureActionableIssue));
    else throw error;
  }
  if (issues.length || !hydrated) return { ok: false, issues };
  // Components are a v8 runtime extension. Strip only that extension before
  // delegating established business invariants to the strict persisted-v7
  // schema; the returned hydrated view still retains every component.
  const legacyValidationView = structuredClone(hydrated);
  legacyValidationView.acceptance_items.forEach((item) => {
    item.sampling.applied_branches?.forEach((branch) => { delete branch.components; });
  });
  legacyValidationView.shared_sampling_rules?.forEach((rule) => {
    delete rule.components;
    rule.branches.forEach((branch) => { delete branch.components; });
  });
  const legacyValidation = validatePlanTextWithSources(
    canonicalize(legacyValidationView),
    manifest,
    openedEvidenceIds,
    plan,
  );
  if (!legacyValidation.ok) return legacyValidation;
  const planSha256 = sha256Text(canonicalize(plan));
  return {
    ok: true,
    issues: [],
    plan: hydrated,
    ...(legacyValidation.model_review ? { model_review: legacyValidation.model_review } : {}),
    persisted_plan: plan,
    plan_sha256: planSha256,
    fingerprint: sha256Text(canonicalize({
      validator: "semantic-source-plan-validator/v5",
      evidence_fingerprint: manifest.evidence_fingerprint,
      plan_sha256: planSha256,
    })),
  };
}

export function validatePlanText(
  source: string,
  manifest: EvidenceManifest,
  openedEvidenceIds?: Set<string>,
): ValidationResult {
  return validatePlanTextWithSources(source, manifest, openedEvidenceIds);
}

// Only the validated compact artifact can provide offsets to its hydrated view.
// Legacy v7 input has no coordinates; do not infer locations from equal text.
function validatePlanTextWithSources(
  source: string,
  manifest: EvidenceManifest,
  openedEvidenceIds?: Set<string>,
  compactSourcePlan?: SemanticSourcePlanV8,
): ValidationResult {
  let parsed: unknown;
  try {
    parsed = strictJsonParse(source);
  } catch (error) {
    return {
      ok: false,
      issues: [{
        code: error instanceof DuplicateJsonKeyError ? "duplicate_json_key" : "invalid_json",
        path: "/",
        message: error instanceof Error ? error.message : String(error),
        details: {
          required_action: "Fix the JSON so it parses as a single object with unique keys",
        },
      }],
    };
  }
  if (
    parsed
    && typeof parsed === "object"
    && !Array.isArray(parsed)
    && (parsed as { schema_version?: unknown }).schema_version === COMPACT_PLAN_SCHEMA_VERSION
  ) {
    if (!compactSchemaValidator(parsed)) {
      return { ok: false, issues: schemaIssues(compactSchemaValidator.errors) };
    }
    return validateCompactPlan(parsed as SemanticSourcePlanV8, manifest, openedEvidenceIds);
  }
  if (!schemaValidator(parsed)) {
    return { ok: false, issues: schemaIssues(schemaValidator.errors) };
  }
  const plan = parsed as SemanticSourcePlan;
  const compactSpans = new Map(compactSourcePlan?.source_spans.map(span => [span.span_id, span]));
  const issues: ValidationIssue[] = [];
  // Imported field sources intentionally remain separate from direct item
  // evidence. Count actual validated field content, never a reference claim.
  const receivedFieldEvidenceIds = new Set<string>();
  if (plan.job_id !== manifest.job_id) {
    issues.push({ code: "job_mismatch", path: "/job_id", message: "job_id does not match the evidence manifest", details: { required_action: "job_id does not match the evidence manifest" }});
  }
  if (plan.target_id !== manifest.target_id) {
    issues.push({ code: "target_mismatch", path: "/target_id", message: "target_id does not match the evidence manifest", details: { required_action: "target_id does not match the evidence manifest" }});
  }
  if (plan.evidence_fingerprint !== manifest.evidence_fingerprint) {
    issues.push({
      code: "evidence_fingerprint_mismatch",
      path: "/evidence_fingerprint",
      message: "The plan was not built against this exact immutable evidence package",
        details: { required_action: "The plan was not built against this exact immutable evidence package" }
});
  }

  const knownEvidence = new Set(manifest.evidence.map((record) => record.evidence_id));
  const evidenceById = new Map(
    manifest.evidence.map((record) => [record.evidence_id, record]),
  );
  const referenceComparable = (value: string): string => value.normalize("NFKC")
    .replace(/<!--\s*pages?[^>]*-->/giu, "")
    .replace(/[\s*_`#]/gu, "")
    .toUpperCase();
  manifest.reference_occurrences.forEach((occurrence, index) => {
    const originEvidenceIds = referenceOccurrenceOriginEvidenceIds(occurrence);
    const originSpanIds = referenceOccurrenceOriginSpanIds(occurrence);
    const literalSpanIds = referenceOccurrenceLiteralSpanIds(occurrence);
    const literals = referenceOccurrenceLiterals(occurrence);
    if (Math.max(originEvidenceIds.length, literalSpanIds.length, literals.length) <= 1) return;
    const records = literals.map((literal) => evidenceById.get(literal.evidence_id));
    const atomIds = records.map(record => record?.atom_id ?? "");
    const sourceLines = records.map((record) => {
      const match = record ? /(?:^|\/)line:(\d+)(?:\/|$)/u.exec(record.locator) : undefined;
      return match ? Number(match[1]) : undefined;
    });
    const literalText = literals.map((literal, literalIndex) => {
      const record = records[literalIndex];
      return record && literal.start >= 0 && literal.end > literal.start && literal.end <= record.text.length
        ? record.text.slice(literal.start, literal.end)
        : "";
    }).join("");
    const valid = literals.length <= 3
      && literalSpanIds.length === literals.length
      && originEvidenceIds.length === literals.length
      && originSpanIds.length === literals.length
      && occurrence.origin_evidence_id === originEvidenceIds[0]
      && occurrence.reference_literal_span_id === literalSpanIds[0]
      && occurrence.reference_literal?.evidence_id === literals[0]?.evidence_id
      && occurrence.reference_literal?.start === literals[0]?.start
      && occurrence.reference_literal?.end === literals[0]?.end
      && originEvidenceIds.every((evidenceId, literalIndex) => evidenceId === literals[literalIndex]!.evidence_id)
      && records.every(Boolean)
      && (
        records.every((record) => Boolean(record?.clause_id) && record!.clause_id === records[0]!.clause_id)
        || atomIds.every(atomId => Boolean(atomId) && atomId === atomIds[0])
      )
      && sourceLines.every((line, lineIndex) => line !== undefined && (lineIndex === 0 || line! > sourceLines[lineIndex - 1]!))
      && literalText.length > 0
      && referenceComparable(literalText) === referenceComparable(occurrence.raw_reference)
      && (!occurrence.normalized_reference
        || referenceComparable(literalText) === referenceComparable(occurrence.normalized_reference));
    if (!valid) {
      issues.push({
        code: "reference_composite_provenance_invalid",
        path: `/reference_occurrences/${index}`,
        message: "组合引用的有序 span、evidence、clause 或逐字拼接 provenance 不一致。",
        details: { required_action: "组合引用的有序 span、evidence、clause 或逐字拼接 provenance 不一致。", origin_evidence_ids: originEvidenceIds, reference_literal_span_ids: literalSpanIds, source_lines: sourceLines },
      });
    }
  });
  const dispositionsByEvidence = new Map(
    plan.evidence_dispositions.map((row) => [row.evidence_id, row]),
  );
  const genericAgentEvidence = manifest.source.adapter === "document-domain-agent/v1";
  const semanticWorkflow = Boolean(manifest.source.semantic_workflow);
  if (semanticWorkflow) {
    issues.push(...validateSemanticDraft(plan, manifest, openedEvidenceIds).issues);
  }
  const tableAssemblyIssues = validateTableAssembly(plan.table_assembly, manifest);
  issues.push(...tableAssemblyIssues);
  const lotIds = plan.inspection_lots.map((lot) => lot.lot_id);
  const itemIds = plan.acceptance_items.map((item) => item.item_id);
  const knownLots = new Set(lotIds);
  const knownItems = new Set(itemIds);
  const repeatedLots = duplicates(lotIds);
  const repeatedItems = duplicates(itemIds);
  if (repeatedLots.length) {
    issues.push({ code: "duplicate_lot_id", path: "/inspection_lots", message: "lot_id values must be unique", details: { required_action: "Rename lots so each lot_id is unique", actual: repeatedLots }});
  }
  if (repeatedItems.length) {
    issues.push({ code: "duplicate_item_id", path: "/acceptance_items", message: "item_id values must be unique", details: { required_action: "Rename items so each item_id is unique", actual: repeatedItems }});
  }
  if (genericAgentEvidence && plan.inspection_lots.length === 0) {
    issues.push({
      code: "agent_target_zero_lots",
      path: "/inspection_lots",
      message: "An Agent-discovered domain target must materialize at least one inspection lot",
        details: { required_action: "An Agent-discovered domain target must materialize at least one inspection lot" }
});
  }
  if (genericAgentEvidence && plan.acceptance_items.length === 0) {
    issues.push({
      code: "agent_target_zero_items",
      path: "/acceptance_items",
      message: "An Agent-discovered domain target must materialize at least one acceptance item",
        details: { required_action: "An Agent-discovered domain target must materialize at least one acceptance item" }
});
  }

  (plan.shared_sampling_rules ?? []).forEach((rule, ruleIndex) => {
    rule.branches.forEach((branch, branchIndex) => {
      if (branch.min_sampling.trim()) return;
      const selectingItems = plan.acceptance_items.filter((item) =>
        rule.receiving_item_ids.includes(item.item_id)
        && item.sampling.rule_ids?.includes(rule.rule_id)
        && (
          item.sampling.branch_ids?.includes(branch.branch_id)
          || item.sampling.applied_branches?.some((applied) =>
            applied.rule_id === rule.rule_id && applied.branch_id === branch.branch_id
          )
        )
      );
      const invalidSelectors = selectingItems.filter((item) =>
        item.sampling.status !== "reference_unspecified_quantity"
      );
      if (selectingItems.length === 0 || invalidSelectors.length > 0 || branch.min_sampling !== "") {
        issues.push({
          code: "sampling_branch_quantity_missing",
          path: `/shared_sampling_rules/${ruleIndex}/branches/${branchIndex}/min_sampling`,
          message: "An empty shared-rule quantity is allowed only for selected source-backed sampling obligations whose source gives no executable quantity",
          details: {
            required_action: "Use reference_unspecified_quantity with an exactly empty min_sampling for every item selecting this branch, or restore the exact source-backed quantity",
            selecting_item_ids: selectingItems.map((item) => item.item_id),
            invalid_selector_item_ids: invalidSelectors.map((item) => item.item_id),
          },
        });
      }
    });
  });

  plan.inspection_lots.forEach((lot, index) => {
    pushUnknownEvidence(issues, knownEvidence, lot.evidence_ids, `/inspection_lots/${index}/evidence_ids`);
    const expectedItems = plan.acceptance_items
      .filter((item) => item.lot_id === lot.lot_id)
      .map((item) => item.item_id)
      .sort();
    const declaredItems = [...lot.item_ids].sort();
    if (canonicalize(expectedItems) !== canonicalize(declaredItems)) {
      issues.push({
        code: "lot_item_relation",
        path: `/inspection_lots/${index}/item_ids`,
        message: "lot.item_ids must exactly match the items whose lot_id names this lot",
        details: { required_action: "lot.item_ids must exactly match the items whose lot_id names this lot", expected: expectedItems, actual: declaredItems },
      });
    }
    const unknownItems = lot.item_ids.filter((itemId) => !knownItems.has(itemId));
    if (unknownItems.length) {
      issues.push({ code: "unknown_item_relation", path: `/inspection_lots/${index}/item_ids`, message: "lot.item_ids contains unknown item IDs", details: { required_action: "Remove unknown item ids from this lot, or add those items first", actual: unknownItems }});
    }
    if (genericAgentEvidence && lot.item_ids.length === 0) {
      issues.push({
        code: "agent_empty_lot",
        path: `/inspection_lots/${index}/item_ids`,
        message: "An Agent-discovered inspection lot must contain at least one acceptance item",
        details: { required_action: "An Agent-discovered inspection lot must contain at least one acceptance item" }
});
    }
  });

  plan.acceptance_items.forEach((item, index) => {
    if (!knownLots.has(item.lot_id)) {
      issues.push({ code: "unknown_lot_relation", path: `/acceptance_items/${index}/lot_id`, message: "item.lot_id names an unknown lot", details: { required_action: "item.lot_id names an unknown lot" }});
    }
    if (item.name_path && (item.name_path.some(part => !part.trim()) || item.name_path.join("\\") !== item.name)) {
      issues.push({
        code: "name_path_mismatch", path: `/acceptance_items/${index}/name_path`,
        message: "名称路径必须由非空层级组成，最终 name 必须等于各级以单个反斜杠连接的结果。",
        details: {
          actual: { name: item.name, name_path: item.name_path },
          item_id: item.item_id, writable_collection: "items", writable_fields: ["name_path", "fields.name"],
          next_tools: ["read_target_selectors", "stage_target_selector_draft"],
          required_action: "在作者端读取对应 item，用非空 name_path 和 fields.name 的 semantic_summary 来源绑定保存；由编译器生成最终名称。不修改语义计划或 result.json，不改变原判据、分支和项目归属。",
        },
      });
    }
    pushUnknownEvidence(issues, knownEvidence, item.evidence_ids, `/acceptance_items/${index}/evidence_ids`);
    pushUnknownEvidence(issues, knownEvidence, item.reference_evidence_ids, `/acceptance_items/${index}/reference_evidence_ids`);
    if (!item.inspection_data_type_reason.trim()) {
      issues.push({
        code: "inspection_data_type_reason",
        path: `/acceptance_items/${index}/inspection_data_type_reason`,
        message: "Inspection-data-type rationale must be non-blank",
        details: { required_action: "Inspection-data-type rationale must be non-blank" }
});
    }
    pushUnknownEvidence(
      issues,
      knownEvidence,
      item.inspection_data_type_evidence_ids,
      `/acceptance_items/${index}/inspection_data_type_evidence_ids`,
    );
    // A selected shared sampling branch is an explicit source route too. Only
    // selected branches and shared members qualify, not other rule branches.
    const routedSamplingEvidence = new Set((plan.shared_sampling_rules ?? []).flatMap((rule) => {
      if (!rule.receiving_item_ids.includes(item.item_id) || !item.sampling.rule_ids?.includes(rule.rule_id)) return [];
      const selected = rule.branches.filter((branch) => item.sampling.applied_branches?.some((applied) =>
        applied.rule_id === rule.rule_id && applied.branch_id === branch.branch_id
      ));
      return [
        ...(rule.components ?? []).flatMap((component) => (component.source_fragments ?? []).map((fragment) => fragment.evidence_id)),
        ...rule.shared_conditions.map((condition) => condition.evidence_id),
        ...selected.flatMap((branch) => [branch.evidence_id,
          ...(branch.components ?? []).flatMap((component) => (component.source_fragments ?? []).map((fragment) => fragment.evidence_id)),
          ...(branch.conditions ?? []).map((condition) => condition.evidence_id),
        ]),
      ];
    }));
    const unrelatedClassificationEvidence = item.inspection_data_type_evidence_ids.filter((evidenceId) =>
      !item.evidence_ids.includes(evidenceId)
      && !item.reference_evidence_ids.includes(evidenceId)
      && !(item.sampling.evidence_ids.includes(evidenceId) && routedSamplingEvidence.has(evidenceId))
      && !plan.semantic_references?.some((entry) =>
        entry.status === "resolved"
        && entry.destination_bindings.some((destination) => destination.item_id === item.item_id)
        && entry.target_semantic_ids.some((semanticId) =>
          plan.semantic_evidence?.some((node) =>
            node.semantic_id === semanticId && node.evidence_id === evidenceId
          )
        )
      )
    );
    if (unrelatedClassificationEvidence.length) {
      issues.push({
        code: "inspection_data_type_evidence_relation",
        path: `/acceptance_items/${index}/inspection_data_type_evidence_ids`,
        message: "Inspection-data-type evidence must be primary or explicitly routed reference evidence for this item",
        details: { required_action: "Inspection-data-type evidence must be primary or explicitly routed reference evidence for this item", actual: unrelatedClassificationEvidence },
      });
    }
    pushUnknownEvidence(
      issues,
      knownEvidence,
      item.sampling.evidence_ids,
      `/acceptance_items/${index}/sampling/evidence_ids`,
    );
    BOUND_FIELDS.forEach((field) => {
      const fieldIssueStart = issues.length;
      const value = item[field];
      const binding = item.field_bindings[field];
      const path = `/acceptance_items/${index}/field_bindings/${field}`;
      if (binding.composition === "semantic_summary" && field !== "name") {
        issues.push({
          code: "semantic_summary_wrong_field",
          path: `${path}/composition`,
          message: "semantic_summary composition is reserved for the inspection-point name; acceptance requirements and other authoritative fields must retain their existing lossless composition",
        details: { required_action: "semantic_summary composition is reserved for the inspection-point name; acceptance requirements and other authoritative fields must retain their existing lossless composition" }
});
      }
      pushUnknownEvidence(issues, knownEvidence, binding.evidence_ids, `${path}/evidence_ids`);
      pushUnknownEvidence(
        issues,
        knownEvidence,
        binding.source_fragments.map((fragment) => fragment.evidence_id),
        `${path}/source_fragments`,
      );
      const semanticReferences = semanticReferenceEvidenceIdsForDestination(
        plan,
        item.item_id,
        field,
      );
      const unrelatedEvidence = binding.evidence_ids.filter((evidenceId) =>
        !item.evidence_ids.includes(evidenceId)
        && !item.reference_evidence_ids.includes(evidenceId)
        && !semanticReferences.has(evidenceId)
      );
      if (unrelatedEvidence.length) {
        issues.push({
          code: "field_binding_relation",
          path: `${path}/evidence_ids`,
          message: "Field bindings may use only the item's primary evidence or evidence explicitly routed to that item",
          details: { required_action: "Field bindings may use only the item's primary evidence or evidence explicitly routed to that item", actual: unrelatedEvidence },
        });
      }
      if (binding.value_sha256 !== sha256Text(value)) {
        issues.push({
          code: "field_binding_value_mismatch",
          path: `${path}/value_sha256`,
          message: "Field binding hash does not match the current semantic field value",
          details: { required_action: "Field binding hash does not match the current semantic field value", field, expected: sha256Text(value), actual: binding.value_sha256 },
        });
      }
      const invalidFragments = binding.source_fragments.filter((fragment) => {
        const evidence = evidenceById.get(fragment.evidence_id);
        return (
          !binding.evidence_ids.includes(fragment.evidence_id)
          || !evidence
          || !evidence.text.includes(fragment.text)
        );
      });
      if (invalidFragments.length) {
        issues.push({
          code: "field_binding_fragment_mismatch",
          path: `${path}/source_fragments`,
          message: "Every source fragment must be an exact substring of evidence named by the same field binding",
          details: { required_action: "Every source fragment must be an exact substring of evidence named by the same field binding", actual: invalidFragments },
        });
      }
      if (value) {
        if (
          binding.status !== "bound"
          || binding.composition === "not_applicable"
          || binding.evidence_ids.length === 0
          || binding.source_fragments.length === 0
        ) {
          issues.push({
            code: "unbound_authoritative_field",
            path,
            message: "A non-empty authoritative field must be bound to opened evidence and exact source fragments",
            details: { required_action: "A non-empty authoritative field must be bound to opened evidence and exact source fragments", field, status: binding.status, composition: binding.composition },
          });
        }
      } else if (
        binding.status === "not_applicable"
        && (
          binding.composition !== "not_applicable"
          || binding.evidence_ids.length !== 0
          || binding.source_fragments.length !== 0
        )
      ) {
        issues.push({
          code: "not_applicable_binding_with_source",
          path,
          message: "A not_applicable empty field must not claim evidence or source fragments",
        details: { required_action: "A not_applicable empty field must not claim evidence or source fragments" }
});
      }
      if (issues.length === fieldIssueStart && value && binding.status === "bound"
        && binding.composition !== "semantic_summary" && binding.composition !== "not_applicable") {
        for (const fragment of binding.source_fragments) {
          if (fragment.text.trim() && value.includes(fragment.text)) receivedFieldEvidenceIds.add(fragment.evidence_id);
        }
      }
    });
    const table = item.table_semantics;
    if (table) {
      const tablePath = `/acceptance_items/${index}/table_semantics`;
      const cellEvidenceIds = table.cell_evidence.map((fragment) => fragment.evidence_id);
      const referenceEvidenceIds = table.reference_fragments.map((fragment) => fragment.evidence_id);
      const branchEvidenceIds = (table.acceptance_branches ?? []).flatMap((branch) => [
        ...branch.condition_fragments.map((fragment) => fragment.evidence_id),
        ...branch.requirement_fragments.map((fragment) => fragment.evidence_id),
        ...branch.allowed_value_fragments.map((fragment) => fragment.evidence_id),
      ]);
      pushUnknownEvidence(issues, knownEvidence, [...cellEvidenceIds, ...branchEvidenceIds], `${tablePath}/cell_evidence`);
      pushUnknownEvidence(issues, knownEvidence, referenceEvidenceIds, `${tablePath}/reference_fragments`);
      const exactFragments = [
        ...table.cell_evidence,
        ...table.reference_fragments,
        ...(table.acceptance_branches ?? []).flatMap((branch) => [
          ...branch.condition_fragments,
          ...branch.requirement_fragments,
          ...branch.allowed_value_fragments,
        ]),
      ].filter((fragment) => !evidenceById.get(fragment.evidence_id)?.text.includes(fragment.text));
      if (exactFragments.length) {
        issues.push({
          code: "table_cell_fragment_mismatch",
          path: tablePath,
          message: "Every table cell/header/reference fragment must be an exact substring of immutable evidence",
          details: { required_action: "Every table cell/header/reference fragment must be an exact substring of immutable evidence", actual: exactFragments },
        });
      }
      if (table.row_path.length === 0 && table.column_path.length === 0) {
        issues.push({
          code: "table_semantic_path_missing",
          path: tablePath,
          message: "A table criterion must preserve at least one non-empty semantic row or column path even when physical layout is damaged",
        details: { required_action: "A table criterion must preserve at least one non-empty semantic row or column path even when physical layout is damaged" }
});
      }
      const evidenceRoles = new Set<string>(table.cell_evidence.map((fragment) => fragment.role));
      const requiredRoles = new Set<string>(["allowed_value"]);
      if (table.row_path.length) requiredRoles.add("row_header");
      if (table.column_path.length) requiredRoles.add("column_header");
      for (const [property, role] of TABLE_PROPERTY_EVIDENCE_ROLES) {
        if (table[property].trim()) requiredRoles.add(role);
      }
      const missingRoles = [...requiredRoles].filter((role) => !evidenceRoles.has(role));
      if (missingRoles.length) {
        issues.push({
          code: "table_property_evidence_missing",
          path: `${tablePath}/cell_evidence`,
          message: "Each structured table property must retain role-labelled exact source evidence",
          details: { required_action: "Each structured table property must retain role-labelled exact source evidence", actual: missingRoles },
        });
      }
      if (table.acceptance_branches?.length) {
        const branchIds = table.acceptance_branches.map((branch) => branch.branch_id);
        if (new Set(branchIds).size !== branchIds.length) {
          issues.push({
            code: "table_acceptance_branch_duplicate",
            path: `${tablePath}/acceptance_branches`,
            message: "Acceptance branch IDs must be unique within one table criterion",
        details: { required_action: "Acceptance branch IDs must be unique within one table criterion" }
});
        }
        const fragmentKey = (fragment: { evidence_id: string; text: string }) => `${fragment.evidence_id}\u0000${fragment.text}`;
        const conditionEvidence = new Set(table.cell_evidence.filter((fragment) => fragment.role === "condition").map(fragmentKey));
        const allowedValueEvidence = new Set(table.cell_evidence.filter((fragment) => fragment.role === "allowed_value").map(fragmentKey));
        const requirementEvidence = new Set(item.field_bindings.requirement.source_fragments.map(fragmentKey));
        const compactItem = compactSourcePlan?.acceptance_items[index];
        const visibleSpans = compactItem?.field_bindings.requirement.source_span_ids.flatMap(id => compactSpans.get(id) ?? []) ?? [];
        const noteEvidence = new Set(item.field_bindings.note.source_fragments.map(fragmentKey));
        table.acceptance_branches.forEach((branch, branchIndex) => {
          const branchPath = `${tablePath}/acceptance_branches/${branchIndex}`;
          const missingCondition = branch.condition_fragments.filter((fragment) => !conditionEvidence.has(fragmentKey(fragment)));
          const missingAllowedValue = branch.allowed_value_fragments.filter((fragment) => !allowedValueEvidence.has(fragmentKey(fragment)));
          const compactBranch = compactItem?.table_semantics?.acceptance_branches?.[branchIndex];
          const hiddenRequirement = branch.requirement_fragments.filter((fragment, fragmentIndex) => {
            if (!compactSourcePlan) return !requirementEvidence.has(fragmentKey(fragment));
            const spanId = compactBranch?.requirement_span_ids[fragmentIndex];
            const span = spanId ? compactSpans.get(spanId) : undefined;
            return !span || !sourceSpanCoveredBy(span, visibleSpans);
          });
          if (missingCondition.length || missingAllowedValue.length || hiddenRequirement.length) {
            issues.push({
              code: "table_acceptance_branch_relation",
              path: branchPath,
              message: "分支条件和允许值须保留对应表格来源，完整分支要求须由可见 requirement 的同源原文区间覆盖。",
              details: { required_action: "用 read_target_selectors 核对本项 table.properties.acceptance_branches 和 fields.requirement。来源区间确实缺失时补齐对应作者字段；同源整段已覆盖时不追加子 span。若作者字段正确而编译来源不符，应检查编译投影，不得修改编译产物。",
                actual: { item_id: item.item_id, branch_id: branch.branch_id, requirement_fragments: branch.requirement_fragments, visible_requirement_fragments: item.field_bindings.requirement.source_fragments },
                next_tool: "read_target_selectors", do_not_edit: "编译产物和不可变原文；不要删除仍适用的分支事实来过校验。",
                missing_condition_fragments: missingCondition,
                missing_allowed_value_fragments: missingAllowedValue,
                missing_requirement_fragments: hiddenRequirement,
              },
            });
          }
          const noteMisuse = [...branch.condition_fragments, ...branch.allowed_value_fragments]
            .filter((fragment) => noteEvidence.has(fragmentKey(fragment)));
          if (noteMisuse.length) {
            issues.push({
              code: "table_acceptance_branch_note_misuse",
              path: branchPath,
              message: "Acceptance branch conditions and allowed values must not be carried by note",
              details: { required_action: "Acceptance branch conditions and allowed values must not be carried by note", actual: noteMisuse },
            });
          }
        });
      }
      const semanticTableEvidence = new Set((plan.semantic_evidence ?? [])
        .filter((node) => node.materialized_item_id === item.item_id)
        .map((node) => node.evidence_id));
      const routedReferenceEvidence = new Set<string>();
      for (const field of [...BOUND_FIELDS, "reference_only"] as const) {
        for (const evidenceId of semanticReferenceEvidenceIdsForDestination(
          plan,
          item.item_id,
          field,
        )) {
          semanticTableEvidence.add(evidenceId);
          routedReferenceEvidence.add(evidenceId);
        }
      }
      // A table occurrence exposes data rows as selectable reference targets.
      // Its title/header/navigation records remain immutable structural
      // dependencies and are intentionally not legal target rows. Once a real
      // data row from that table is explicitly routed to this item, those
      // non-data records may carry the typed table structure without being
      // duplicated into criterion_span_ids. Data rows themselves still require
      // an exact item or reference route.
      const routedReferenceTableIds = new Set([...routedReferenceEvidence].flatMap((evidenceId) => {
        const evidence = evidenceById.get(evidenceId);
        return evidence?.table_id && evidence.table_row_kind === "data"
          ? [evidence.table_id]
          : [];
      }));
      const routedReferenceTableStructureEvidence = new Set(
        [...cellEvidenceIds, ...referenceEvidenceIds].filter((evidenceId) => {
          const evidence = evidenceById.get(evidenceId);
          if (!evidence?.table_id) return false;
          return table.source_kind === "reference"
            && evidence.table_row_kind !== "data"
            && (evidence.evidence_scope === "reference" || evidence.registered_dependency === true)
            && routedReferenceTableIds.has(evidence.table_id);
        }),
      );
      const allowedTableEvidence = new Set([
        ...item.evidence_ids,
        ...item.reference_evidence_ids,
        ...semanticTableEvidence,
        ...routedReferenceTableStructureEvidence,
      ]);
      const unrelatedTableEvidence = [...cellEvidenceIds, ...referenceEvidenceIds]
        .filter((evidenceId) => !allowedTableEvidence.has(evidenceId));
      if (unrelatedTableEvidence.length) {
        issues.push({
          code: "table_evidence_relation",
          path: tablePath,
          message: "表格结构使用的来源必须由同一验收项或指向该项的显式语义引用路由承载。",
          details: {
            required_action: "核对表格单元格、表头和引用来源，把实际适用的来源绑定到同一 item 或其显式语义引用路由。",
            actual: [...new Set(unrelatedTableEvidence)],
          },
});
      }
      if (openedEvidenceIds) {
        const unopened = [...new Set([...cellEvidenceIds, ...branchEvidenceIds, ...referenceEvidenceIds])]
          .filter((evidenceId) => !openedEvidenceIds.has(evidenceId));
        if (unopened.length) {
          issues.push({
            code: "table_evidence_not_opened",
            path: tablePath,
            message: "Open every immutable evidence atom used by structured table semantics",
            details: {
              required_action: "表格语义引用的每个不可变证据原子必须先完整打开。调用 batch_open_evidence 打开 unopened_evidence_ids 后重试校验。",
              actual: unopened,
              unopened_evidence_ids: unopened,
              next_tool: "batch_open_evidence",
              next_tool_arguments: { evidence_ids: unopened },
            },
          });
        }
      }
      if (table.source_kind === "reference") {
        if (table.reference_fragments.length === 0) {
          issues.push({
            code: "table_reference_anchor_missing",
            path: `${tablePath}/reference_fragments`,
            message: "A referenced-table criterion must retain the exact original reference anchor",
        details: { required_action: "A referenced-table criterion must retain the exact original reference anchor" }
});
        }
        const hasResolvedRoute = (plan.semantic_references ?? []).some((entry) =>
          entry.status === "resolved"
          && entry.destination_bindings.some((destination) => destination.item_id === item.item_id)
        );
        if (semanticWorkflow && !hasResolvedRoute) {
          issues.push({
            code: "table_reference_route_missing",
            path: tablePath,
            message: "Referenced-table semantics require a resolved semantic reference route to the same item",
        details: { required_action: "Referenced-table semantics require a resolved semantic reference route to the same item" }
});
        }
      }
      if (
        semanticWorkflow
        && !(plan.semantic_evidence ?? []).some((node) =>
          node.role === "table_criterion" && node.materialized_item_id === item.item_id
        )
      ) {
        issues.push({
          code: "table_semantics_without_criterion",
          path: tablePath,
          message: "Structured table semantics must originate from a table_criterion semantic node",
        details: { required_action: "Structured table semantics must originate from a table_criterion semantic node" }
});
      }
    }
    if (
      item.sampling.status === "not_sampling"
      || item.sampling.status === "fallback"
    ) {
      if (item.sampling.min_sampling !== "") {
        issues.push({
          code: item.sampling.status === "not_sampling"
            ? "not_sampling_with_quantity"
            : "fallback_sampling_with_quantity",
          path: `/acceptance_items/${index}/sampling/min_sampling`,
          message: `${item.sampling.status} decisions must leave min_sampling empty`,
        details: { required_action: "Fix " }
});
      }
    } else {
      const unspecifiedQuantity = item.sampling.status === "reference_unspecified_quantity";
      if (
        (unspecifiedQuantity && item.sampling.min_sampling !== "")
        || (!unspecifiedQuantity && !item.sampling.min_sampling.trim())
        || item.sampling.evidence_ids.length === 0
      ) {
        issues.push({
          code: unspecifiedQuantity
            ? "sampling_unspecified_quantity_invalid"
            : "sampling_decision_incomplete",
          path: `/acceptance_items/${index}/sampling`,
          message: unspecifiedQuantity
            ? "A source-backed unspecified quantity must leave min_sampling empty and retain at least one exact rule evidence ID"
            : "Sampling decisions must include a non-empty minimum and at least one rule evidence ID",
        details: { required_action: unspecifiedQuantity
          ? "Leave min_sampling empty and bind the exact source requiring sampling without a rate, count, or scope; full inspection is an executable quantity"
          : "Sampling decisions must include a non-empty minimum and at least one rule evidence ID" }
});
      }
      if (
        item.sampling.status === "reference"
        || item.sampling.status === "reference_unspecified_quantity"
      ) {
        const selectedRules = (plan.shared_sampling_rules ?? []).filter((rule) =>
          item.sampling.rule_ids?.includes(rule.rule_id)
        );
        const declaredBranches = selectedRules.flatMap((rule) => rule.branches
          .map((branch) => ({ rule, branch }))
        );
        const isTypedBranchContract = declaredBranches.some(({ branch }) => branch.conditions !== undefined);
        if (isTypedBranchContract) {
          const selectedBranchIds = [...(item.sampling.branch_ids ?? [])].sort();
          const declaredBranchIds = new Set(declaredBranches.map(({ branch }) => branch.branch_id));
          const selectedBranches = declaredBranches.filter(({ branch }) => selectedBranchIds.includes(branch.branch_id));
          const unknownBranchIds = selectedBranchIds.filter((branchId) => !declaredBranchIds.has(branchId));
          const inapplicableBranchIds = selectedBranches.filter(({ branch }) =>
            branch.applies_to_category !== "all_items" && branch.applies_to_category !== item.category
          ).map(({ branch }) => branch.branch_id);
          const appliedBranchIds = (item.sampling.applied_branches ?? []).map((branch) => branch.branch_id).sort();
          if (
            selectedBranchIds.length === 0
            || unknownBranchIds.length > 0
            || inapplicableBranchIds.length > 0
            || canonicalize(selectedBranchIds) !== canonicalize(appliedBranchIds)
          ) {
            issues.push({
              code: "sampling_branch_selection_invalid",
              path: `/acceptance_items/${index}/sampling/applied_branches`,
              message: "Reference sampling must retain exactly its non-empty declared, category-applicable branch selection",
              details: { required_action: "Reference sampling must retain exactly its non-empty declared, category-applicable branch selection", selected_branch_ids: selectedBranchIds, applied_branch_ids: appliedBranchIds, unknown_branch_ids: unknownBranchIds, inapplicable_branch_ids: inapplicableBranchIds },
            });
          }
          for (const [appliedIndex, applied] of (item.sampling.applied_branches ?? []).entries()) {
            const expected = selectedBranches.find(({ rule, branch }) =>
              rule.rule_id === applied.rule_id && branch.branch_id === applied.branch_id
            );
            if (!expected) continue;
            const expectedConditions = expected.branch.conditions ?? [];
            if (
              applied.min_sampling !== expected.branch.min_sampling
              || applied.script !== expected.branch.script
              || canonicalize(applied.conditions) !== canonicalize(expectedConditions)
            ) {
              issues.push({
                code: "sampling_branch_materialization_mismatch",
                path: `/acceptance_items/${index}/sampling/applied_branches/${appliedIndex}`,
                message: "Applied sampling branch must preserve its shared-rule condition, method, and quantity without flattening",
                details: { required_action: "Applied sampling branch must preserve its shared-rule condition, method, and quantity without flattening", expected: expected.branch, actual: applied },
              });
            }
            pushUnknownEvidence(
              issues,
              knownEvidence,
              applied.evidence_ids,
              `/acceptance_items/${index}/sampling/applied_branches/${appliedIndex}/evidence_ids`,
            );
          }
        }
      }
      const samplingEvidenceAppliesToItem = (evidenceId: string): boolean => {
        if (!evidenceById.has(evidenceId)) return false;
        if (item.evidence_ids.includes(evidenceId)) return true;
        const disposition = dispositionsByEvidence.get(evidenceId);
        return disposition?.disposition === "used"
          && disposition.item_ids.includes(item.item_id);
      };
      const invalidSamplingEvidence = item.sampling.evidence_ids.filter((evidenceId) => {
        const evidence = evidenceById.get(evidenceId);
        if (genericAgentEvidence) {
          if (item.sampling.status === "explicit") {
            return !samplingEvidenceAppliesToItem(evidenceId);
          }
          return !evidence;
        }
        if (evidence?.role === "sampling_rule") {
          const occurrenceKind = evidence.sampling_occurrence?.kind;
          if (item.sampling.status === "explicit") {
            return occurrenceKind !== undefined && occurrenceKind !== "explicit_quantity";
          }
          if (item.sampling.status === "fallback") {
            return occurrenceKind !== undefined && occurrenceKind !== "fallback";
          }
          if (
            item.sampling.status === "reference"
            || item.sampling.status === "reference_unspecified_quantity"
          ) {
            return occurrenceKind !== undefined
              && ![
                "reference",
                ...(item.sampling.status === "reference" ? ["explicit_quantity"] : []),
              ].includes(occurrenceKind);
          }
          return false;
        }
        return !(
          item.sampling.status === "explicit"
          && evidence?.role === "formal_table_row"
          && item.evidence_ids.includes(evidenceId)
        );
      });
      if (invalidSamplingEvidence.length) {
        issues.push({
          code: "sampling_non_rule_evidence",
          path: `/acceptance_items/${index}/sampling/evidence_ids`,
          message: genericAgentEvidence
            ? "Explicit sampling evidence must be in scope and either belong to the item directly or have a used disposition naming this item; only one unbranched decision may remain explicit"
            : "Sampling decisions may cite sampling_rule evidence; explicit row-local quantities may also cite this item's own formal_table_row evidence",
          details: { required_action: "Fix sampling non rule evidence", actual: invalidSamplingEvidence },
        });
      }
      if (item.sampling.status === "explicit") {
        const hasSpecificEvidence = item.sampling.evidence_ids.some((evidenceId) => {
          const evidence = evidenceById.get(evidenceId);
          if (genericAgentEvidence) {
            return samplingEvidenceAppliesToItem(evidenceId);
          }
          return (
            (
              evidence?.role === "formal_table_row"
              && item.evidence_ids.includes(evidenceId)
            )
            || (
              evidence?.role === "sampling_rule"
              && (
                evidence.sampling_occurrence?.kind === "explicit_quantity"
                || (
                  !evidence.sampling_occurrence
                )
              )
            )
          );
        });
        if (!hasSpecificEvidence) {
          issues.push({
            code: "explicit_sampling_without_specific_evidence",
            path: `/acceptance_items/${index}/sampling/evidence_ids`,
            message: genericAgentEvidence
              ? "Explicit sampling must cite exact in-scope evidence routed to this receiving item"
              : "Explicit sampling must cite this item's formal table row or a specific current-document rule",
        details: { required_action: "Fix explicit sampling without specific evidence" }
});
        }
      }
    }
  });

  const resolutionIds = plan.reference_resolutions.map((resolution) =>
    resolution.resolution_id
  );
  const repeatedResolutionIds = duplicates(resolutionIds);
  if (repeatedResolutionIds.length) {
    issues.push({
      code: "duplicate_reference_resolution",
      path: "/reference_resolutions",
      message: "每个 reference resolution ID 必须唯一。",
      details: { required_action: "每个 reference resolution ID 必须唯一。", actual: repeatedResolutionIds },
    });
  }
  const occurrenceById = new Map(
    manifest.reference_occurrences.map((occurrence) => [
      occurrence.occurrence_id,
      occurrence,
    ]),
  );
  const retainedUnavailableExternalOccurrenceIds = new Set(
    plan.reference_resolutions.flatMap((resolution) => {
      const occurrence = occurrenceById.get(resolution.occurrence_id);
      return occurrence?.external_standard?.status === "placeholder"
        && occurrence.status === "target_not_found"
        && !occurrence.required
        && resolution.action === "keep_reference"
        && resolution.application_mode === "reference_only"
        && resolution.target_evidence_ids.length === 0
        ? [occurrence.occurrence_id]
        : [];
    }),
  );
  const selectedReferenceEvidence = new Set(
    plan.reference_resolutions.filter(resolution => !planHasContextReference(plan, manifest, resolution)).flatMap((resolution) =>
      resolution.target_evidence_ids
    ),
  );
  const activeOccurrenceIds = new Set(
    manifest.reference_occurrences
      .filter((occurrence) =>
        occurrence.required
        || referenceOccurrenceOriginEvidenceIds(occurrence).some((evidenceId) => selectedReferenceEvidence.has(evidenceId))
      )
      .map((occurrence) => occurrence.occurrence_id),
  );
  for (const [index, occurrence] of manifest.reference_occurrences.entries()) {
    if (
      activeOccurrenceIds.has(occurrence.occurrence_id)
      && occurrence.status !== "resolved"
      && !retainedUnavailableExternalOccurrenceIds.has(occurrence.occurrence_id)
    ) {
      issues.push({
        code: occurrence.status === "cycle"
          ? "reference_cycle"
          : occurrence.status === "depth_limit"
            ? "reference_depth_limit"
            : occurrence.status === "ambiguous"
              ? "reference_target_ambiguous"
              : "reference_target_not_found",
        path: `/reference_occurrences/${index}`,
        message: `Reference occurrence cannot be sealed because its evidence lookup status is ${occurrence.status}`,
        details: {
          actual: occurrence,
          required_action: "核对真实引用目标并通过引用解析工具取得 resolved 状态；不能直接修改 occurrence 状态或猜造缺失正文。",
          required_status: "resolved",
          next_tool: "list_reference_occurrences", next_tool_arguments: { cursor: 0, limit: 100 },
          writable_paths: ["resolve_document_reference.origin_span_id", "resolve_document_reference.reference_literal_span_id", "resolve_document_reference.target"],
          how_to_pass: "先用 list_reference_occurrences 核对 actual.occurrence_id、原文 literal 和当前状态，再按真实引用来源读取原文。只有模型从已读原文确认定位参数错误且真实目标存在时，才修正 resolve_document_reference 的精确来源及 target 参数后重新解析；引用被换行拆开时沿用其组合 span 参数。target_not_found、cycle 或 depth_limit 不会因填写 destinations、保留引用文字或改变说明而解决。若仍无法取得真实目标，保留检查点与回条，当前不能封存；不得为消错排除真实适用内容。",
          do_not_edit: "不可变 reference occurrence、来源正文、编译产物和封存文件；解析工具参数不是这些文件的可写路径。",
        },
      });
    }
  }
  const resolutionCountByOccurrence = new Map<string, number>();
  const referenceTargetsByItem = new Map<string, Set<string>>();
  const referenceTargetsByItemField = new Map<string, Set<string>>();
  const referenceRoutes = new Set<string>();
  plan.reference_resolutions.forEach((resolution, index) => {
    const occurrence = occurrenceById.get(resolution.occurrence_id);
    const contextReference = planHasContextReference(plan, manifest, resolution);
    resolutionCountByOccurrence.set(
      resolution.occurrence_id,
      (resolutionCountByOccurrence.get(resolution.occurrence_id) ?? 0) + 1,
    );
    if (!occurrence) {
      issues.push({
        code: "unknown_reference_occurrence",
        path: `/reference_resolutions/${index}/occurrence_id`,
        message: "reference resolution 指向了不存在的不可变 occurrence；请从工具回执逐字复制 occurrence_id。",
        details: { required_action: "reference resolution 指向了不存在的不可变 occurrence；请从工具回执逐字复制 occurrence_id。" }
});
    } else {
      if (occurrence.status === "resolved" && resolution.target_evidence_ids.length === 0) {
        issues.push({
          code: "reference_resolved_target_required",
          path: `/reference_resolutions/${index}/target_evidence_ids`,
          message: "resolved 引用必须包含被引证据；只有已登记 target_not_found 回执的引用可以为空。",
        details: { required_action: "resolved 引用必须包含被引证据；只有已登记 target_not_found 回执的引用可以为空。" }
});
      }
      if (resolution.origin_evidence_id !== occurrence.origin_evidence_id) {
        issues.push({
          code: "reference_occurrence_origin_mismatch",
          path: `/reference_resolutions/${index}/origin_evidence_id`,
          message: "reference resolution 的 origin 必须与工具登记的 occurrence 完全一致。",
          details: { required_action: "reference resolution 的 origin 必须与工具登记的 occurrence 完全一致。",
            expected: occurrence.origin_evidence_id,
            actual: resolution.origin_evidence_id,
          },
        });
      }
      const allowedTargets = new Set(occurrence.target_evidence_ids);
      const outsideTarget = resolution.target_evidence_ids.filter(
        (evidenceId) => !allowedTargets.has(evidenceId),
      );
      if (outsideTarget.length) {
        const targetUnavailable = occurrence.target_evidence_ids.length === 0;
        issues.push({
          code: "reference_target_outside_occurrence",
          path: `/reference_resolutions/${index}/target_evidence_ids`,
          message: targetUnavailable
            ? "该 occurrence 尚无已解析的目标证据，当前选中的目标证据不能绑定到它。"
            : "被选引用证据必须来自 occurrence 已解析的目标证据。请打开 allowed_target_evidence_ids 中的实际证据，再在其中登记精确 span。",
          details: {
            occurrence_id: occurrence.occurrence_id,
            occurrence_status: occurrence.status,
            outside_target_evidence_ids: outsideTarget,
            ...(!targetUnavailable ? {
              same_physical_row_candidates: referenceRowRepairCandidates(manifest, outsideTarget, occurrence.target_evidence_ids),
              candidate_instruction: "Candidates share exact table/line/row coordinates but are not interchangeable spans. Read the allowed row through read_reference_facts and locate fresh exact spans in its actual text; do not reuse offsets or change the occurrence to bypass this check.",
            } : {}),
            allowed_target_evidence_ids: occurrence.target_evidence_ids,
            required_action: targetUnavailable
              ? "移除当前引用中不属于该 occurrence 的目标 span；若 occurrence 为 target_not_found，保留原引用和未解回执，不得借用其他 occurrence 的目标。"
              : "打开 allowed_target_evidence_ids 中的被引内容，并只在这些目标证据内登记精确 span",
          },
        });
      }
      if (occurrence.reference_kind === "table") {
        const nonDataRows = resolution.target_evidence_ids.filter((evidenceId) =>
          evidenceById.get(evidenceId)?.table_row_kind !== "data"
        );
        if (nonDataRows.length) {
          issues.push({
            code: "reference_target_not_data_row",
            path: `/reference_resolutions/${index}/target_evidence_ids`,
            message: "表格引用只能选择不可变目标表的数据行；不能只选整块原子、表题或表头。可选数据行列在 allowed_target_evidence_ids。",
            details: {
              non_data_row_evidence_ids: nonDataRows,
              allowed_target_evidence_ids: occurrence.target_evidence_ids,
              required_action: "继续打开并登记 allowed_target_evidence_ids 中的表头、条件行、数值行、单位、注释和分支数据行",
            },
          });
        }
      }
      if (resolution.application_mode === "reference_only" && resolution.reason.trim().length === 0) {
        issues.push({
          code: "reference_only_requires_reason",
          path: `/reference_resolutions/${index}/reason`,
          message: "A literal-only reference must include a reason.",
          details: { required_action: "A literal-only reference must include a reason.", target_evidence_ids: resolution.target_evidence_ids },
        });
      }
      if (
        resolution.application_mode === "replace_field"
        && resolution.target_evidence_ids.length !== 1
      ) {
        issues.push({
          code: "reference_scalar_target_count",
          path: `/reference_resolutions/${index}/target_evidence_ids`,
          message: "replace_field 会重建整个目标字段，因此必须且只能选择一条目标证据；新引用通常应保留本地字段并原位关联被引内容。",
        details: { required_action: "replace_field 会重建整个目标字段，因此必须且只能选择一条目标证据；新引用通常应保留本地字段并原位关联被引内容。" }
});
      }
    }
    if (resolution.application_mode === "reference_placeholder") {
      // Count only present components on branches actually selected by a real
      // item, never the rule's envelope or an unselected sibling. Table and
      // clause references use the same received sampling provenance.
      const receivedSamplingEvidenceIds = new Set(plan.acceptance_items.flatMap(item =>
        (compactSourcePlan?.acceptance_items.find(candidate => candidate.item_id === item.item_id)?.sampling.applied_branches ?? [])
          .filter(branch => item.sampling.branch_ids?.includes(branch.branch_id)
            && item.sampling.rule_ids?.includes(branch.rule_id))
          .flatMap(branch => branch.effective_components
            .filter(component => component.disposition === "present")
            .flatMap(component => component.source_span_ids.flatMap(id => compactSpans.get(id)?.evidence_id ?? [])))));
      const nonItemEvidence = new Set([
        ...plan.inspection_lots.flatMap(lot => lot.evidence_ids),
        ...plan.evidence_dispositions.filter(row => row.disposition !== "used"
          && row.item_ids.length === 0 && row.reason.trim()).map(row => row.evidence_id),
      ]);
      if (
        occurrence?.status !== "resolved"
      ) {
        issues.push({
          code: "reference_placeholder_requires_resolved_reference",
          path: `/reference_resolutions/${index}/application_mode`,
          message: "纯引用占位只允许承载已解析的当前文档表格、章节或条款引用。",
        details: { required_action: "纯引用占位只允许承载已解析的当前文档表格、章节或条款引用。" }
});
      }
      if (resolution.destination_bindings.length > 0) {
        issues.push({
          code: "reference_placeholder_has_item_destination",
          path: `/reference_resolutions/${index}/destination_bindings`,
          message: "纯引用占位不是业务 item，不能再绑定验收叶字段。",
        details: { required_action: "纯引用占位不是业务 item，不能再绑定验收叶字段。" }
});
      }
      if (occurrence?.reference_kind === "table") {
        const coverage = referencedTableItemCoverage(
          plan,
          occurrence,
          manifest,
        );
        const uncoveredRows = coverage.uncovered_data_row_evidence_ids
          .filter(id => !receivedSamplingEvidenceIds.has(id) && !receivedFieldEvidenceIds.has(id) && !nonItemEvidence.has(id));
        if (coverage.data_row_evidence_ids.length === 0 || uncoveredRows.length > 0) {
          issues.push({
            code: "reference_placeholder_table_leaf_missing",
            path: `/reference_resolutions/${index}/target_evidence_ids`,
            message: "被引表每条数据行须由真实验收叶及其选中抽样组件、检验批范围或明确来源处置承载。",
            details: {
              required_action: "按 uncovered_data_row_evidence_ids 核对被引表数据行：实际形成验收属性的行补真实表格验收项及精确来源，抽样行绑定真实项目选中的 sampling_rules 分支组件；非项目内容在作者 selectors 的 lots[].scope_span_ids 或 source_dispositions 中绑定完整精确来源与理由；若有实际字段接收者则改用真实路由，不得靠虚构项目满足占位模式。data_row_evidence_ids 为空时先核对目标表和解析结果。",
              data_row_evidence_ids: coverage.data_row_evidence_ids,
              uncovered_data_row_evidence_ids: uncoveredRows,
            },
          });
        }
      } else if (occurrence?.reference_kind === "clause") {
        const materializedEvidenceIds = new Set([
          ...plan.acceptance_items.flatMap(item => item.evidence_ids),
          ...receivedSamplingEvidenceIds,
          ...receivedFieldEvidenceIds,
        ]);
        const uncoveredEvidenceIds = resolution.target_evidence_ids.filter((evidenceId) => !materializedEvidenceIds.has(evidenceId)
          && !nonItemEvidence.has(evidenceId));
        if (resolution.target_evidence_ids.length === 0 || uncoveredEvidenceIds.length > 0) {
          issues.push({
            code: "reference_placeholder_item_coverage_missing",
            path: `/reference_resolutions/${index}/target_evidence_ids`,
            message: "全部选定的被引内容须由真实验收叶、检验批范围或明确来源处置承载；仅有引用理由不足以闭合。",
            details: { required_action: "全部选定的被引内容须由真实验收叶、检验批范围或明确来源处置承载；仅有引用理由不足以闭合。", uncovered_evidence_ids: uncoveredEvidenceIds },
          });
        }
      }
    } else if (resolution.destination_bindings.length === 0 && !contextReference) {
      const originField = occurrence?.origin_fields.length === 1
        ? occurrence.origin_fields[0]
        : undefined;
      issues.push({
        code: "reference_destination_required",
        path: `/reference_resolutions/${index}/destination_bindings`,
        message: occurrence?.external_standard
          ? "外部标准占位引用必须关联到原引用实际所在的业务字段；空 destination 不是内部纯指针占位。"
          : "非占位引用必须关联到原引用实际所在的业务字段。",
        details: {
          ...(originField ? { origin_field: originField } : {}),
          ...(occurrence?.external_standard ? { external_reference_placeholder: true } : {}),
          required_action: originField
            ? `bind_destination_to_origin_field_${originField}`
            : "bind_destination_to_the_registered_origin_field",
        },
      });
    }
    pushUnknownEvidence(
      issues,
      knownEvidence,
      occurrence ? referenceOccurrenceOriginEvidenceIds(occurrence) : [resolution.origin_evidence_id],
      `/reference_resolutions/${index}/origin_evidence_id`,
    );
    pushUnknownEvidence(
      issues,
      knownEvidence,
      resolution.target_evidence_ids,
      `/reference_resolutions/${index}/target_evidence_ids`,
    );
    resolution.destination_bindings.forEach((destination, destinationIndex) => {
      const destinationPath =
        `/reference_resolutions/${index}/destination_bindings/${destinationIndex}`;
      const item = plan.acceptance_items.find((candidate) =>
        candidate.item_id === destination.item_id
      );
      if (!item) {
        issues.push({
          code: "unknown_reference_destination",
          path: `${destinationPath}/item_id`,
          message: "引用 destination 指向了不存在的 item。",
        details: { required_action: "引用 destination 指向了不存在的 item。" }
});
        return;
      }
      const allowedImportFields = new Set<ReferenceImportField>(resolution.import_scope.allowed_fields);
      const targetEvidenceIds = new Set(resolution.target_evidence_ids);
      const actualImportedFields = new Set<ReferenceImportField>();
      for (const field of BOUND_FIELDS) {
        if (item.field_bindings[field].evidence_ids.some((evidenceId) => targetEvidenceIds.has(evidenceId))) {
          actualImportedFields.add(field);
        }
      }
      const selectedRuleIds = new Set(item.sampling.rule_ids ?? []);
      const importsSampling = item.sampling.evidence_ids.some((evidenceId) => targetEvidenceIds.has(evidenceId))
        || (plan.shared_sampling_rules ?? []).some((rule) =>
          selectedRuleIds.has(rule.rule_id)
          && rule.evidence_ids.some((evidenceId) => targetEvidenceIds.has(evidenceId))
        );
      if (importsSampling) actualImportedFields.add("sampling");
      const outsideImportScope = [...actualImportedFields]
        .filter((field) => !allowedImportFields.has(field))
        .sort();
      if (outsideImportScope.length > 0) {
        issues.push({
          code: "reference_import_scope_exceeded",
          path: `/reference_resolutions/${index}/import_scope/allowed_fields`,
          message: "Referenced content was imported into fields outside the Agent-authored import_scope",
          details: { required_action: "Referenced content was imported into fields outside the Agent-authored import_scope",
            item_id: item.item_id,
            imported_fields: [...actualImportedFields].sort(),
            outside_import_scope: outsideImportScope,
            allowed_fields: resolution.import_scope.allowed_fields,
          },
        });
      }
      const occurrence = manifest.reference_occurrences.find((entry) =>
        entry.occurrence_id === resolution.occurrence_id
      );
      const originEvidenceIds = occurrence
        ? referenceOccurrenceOriginEvidenceIds(occurrence)
        : [resolution.origin_evidence_id];
      const originRecords = originEvidenceIds.flatMap((evidenceId) => {
        const record = manifest.evidence.find((candidate) => candidate.evidence_id === evidenceId);
        return record ? [record] : [];
      });
      // Only components actually delivered by this receiver's selected branches
      // can retain its local citation context. The rule envelope and siblings
      // are not visible origin bindings.
      const samplingOriginFragments = (compactSourcePlan?.acceptance_items
        .find((candidate) => candidate.item_id === item.item_id)?.sampling.applied_branches ?? [])
        .filter((branch) => item.sampling.rule_ids?.includes(branch.rule_id)
          && item.sampling.branch_ids?.includes(branch.branch_id)
          && plan.shared_sampling_rules?.some((rule) => rule.rule_id === branch.rule_id
            && rule.receiving_item_ids.includes(item.item_id)))
        .flatMap((branch) => branch.effective_components
          .filter((component) => component.disposition === "present")
          .flatMap((component) => component.source_span_ids.flatMap((spanId) => {
            const span = compactSpans.get(spanId);
            const record = span && originRecords.find((candidate) => candidate.evidence_id === span.evidence_id);
            return span && record
              ? [{ evidence_id: record.evidence_id, text: record.text.slice(span.start, span.end) }]
              : [];
          })));
      const originFragmentsByField = Object.entries(item.field_bindings).map(([field, binding]) => ({ field,
        fragments: binding.source_fragments.filter((fragment) => originEvidenceIds.includes(fragment.evidence_id)
          && originRecords.some((record) => record.evidence_id === fragment.evidence_id && record.text.includes(fragment.text)))
      }));
      originFragmentsByField.push({ field: "sampling", fragments: samplingOriginFragments });
      const originFragments = originFragmentsByField.flatMap(entry => entry.fragments);
      const exactComparable = (value: string) => value.normalize("NFKC").replace(/\s+/gu, "");
      const purePointerOrigin = Boolean(
        occurrence
        && originRecords.length === originEvidenceIds.length
        && clauseReferenceLocalResidual(originRecords.map((record) => record.text).join(""), occurrence.raw_reference).length === 0
      );
      const retainsFullPurePointerOrigin = Boolean(
        purePointerOrigin
        && originRecords.length === originEvidenceIds.length
        && originRecords.every((record) => originFragments.some((fragment) =>
          fragment.evidence_id === record.evidence_id && exactComparable(fragment.text) === exactComparable(record.text)
        ))
      );
      const retainsCompleteOriginUnit = Boolean(occurrence && originRecords.length === 1
        && retainsCompleteReferenceUnit(
          originRecords[0]!.text,
          originFragments.map(fragment => fragment.text),
          occurrence.raw_reference,
          manifest.reference_occurrences.filter(candidate =>
            referenceOccurrenceOriginEvidenceIds(candidate).includes(originRecords[0]!.evidence_id)
          ).map(candidate => candidate.raw_reference),
        ));
      // Table cells are immutable source units. A subject in another visible
      // field can retain context only alongside the complete citing cell.
      const retainsTableOriginContext = Boolean(occurrence
        && clauseReferenceResidual(originFragments.map(fragment => fragment.text).join("\n"), [occurrence.raw_reference], true)
        && originRecords.some(record => record.kind === "table_row" && record.cells?.some(cell =>
          retainsCompleteReferenceUnit(cell,
            originFragments.filter(fragment => fragment.evidence_id === record.evidence_id).map(fragment => fragment.text),
            occurrence.raw_reference, [occurrence.raw_reference]))));
      const retainsOriginBeyondLiteral = (occurrence
        // The name/local condition and citation can be exact fragments in
        // different fields. Check their union only within this same origin;
        // the residual helper still requires the actual occurrence's citation.
        ? clauseReferenceLocalResidual(
            originFragments.map((fragment) => fragment.text).join("\n"),
            occurrence.raw_reference,
          ).length > 0
        : originFragments.length > 0) || retainsFullPurePointerOrigin || retainsCompleteOriginUnit || retainsTableOriginContext;
      const missingOriginEvidenceIds = originEvidenceIds.filter(evidenceId => !item.evidence_ids.includes(evidenceId) && !samplingOriginFragments.some(fragment => fragment.evidence_id === evidenceId));
      if (missingOriginEvidenceIds.length || !retainsOriginBeyondLiteral) {
        issues.push({
          code: "reference_origin_relation",
          path: destinationPath,
          message: "接收引用的 item 必须保留产生该引用的来源证据。",
          details: {
            item_id: item.item_id,
            origin_evidence_id: resolution.origin_evidence_id,
            origin_evidence_ids: originEvidenceIds,
            occurrence_id: resolution.occurrence_id,
            reference_literal_span_id: occurrence?.reference_literal_span_id ?? "",
            anchor_only_origin_binding: missingOriginEvidenceIds.length === 0
              && !retainsOriginBeyondLiteral,
            actual: {
              origin_context_field_scope: "union_of_visible_fields",
              occurrence_origin_fields: occurrence?.origin_fields ?? [],
              origin_context_fields_present: originFragmentsByField.filter(entry => entry.fragments.length).map(entry => entry.field),
              origin_provenance_present: missingOriginEvidenceIds.length === 0,
              missing_origin_evidence_ids: missingOriginEvidenceIds,
              origin_field_fragment_count: originFragments.length,
              origin_context_retained: retainsOriginBeyondLiteral,
            },
            expected: { origin_provenance_present: true, origin_context_retained: true },
            required_action: "route_to_an_item_that_retains_the_origin_sentence_beyond_the_reference_literal",
          },
        });
      }
      if (
        ["adopt", "conditional", "compare"].includes(resolution.action)
        && resolution.application_mode !== "reference_only"
        && destination.target_field === "reference_only"
      ) {
        issues.push({
          code: "reference_action_without_field",
          path: destinationPath,
          message: "adopted、conditional 或 compared 引用必须关联到原引用实际所在的权威业务字段；reference_only 表示保留本地字段和原引用，并在精确位置附着解析内容与 provenance。",
        details: { required_action: "adopted、conditional 或 compared 引用必须关联到原引用实际所在的权威业务字段；reference_only 表示保留本地字段和原引用，并在精确位置附着解析内容与 provenance。" }
});
      }
      if (
        resolution.application_mode === "reference_only"
        && occurrence !== undefined
        && referenceOccurrenceLiteralSpanIds(occurrence).length === 0
        && !["reference_only", "note"].includes(destination.target_field)
      ) {
        issues.push({
          code: "reference_only_mode_with_field",
          path: destinationPath,
          message: "这条旧引用缺少精确 literal span，无法证明真实字段归属。请调用 resolve_document_reference 取得 occurrence_id 和 reference_literal_span_id，再关联到原引用实际所在的业务字段；不得统一搬到 note 或伪字段 reference_only。",
        details: { required_action: "这条旧引用缺少精确 literal span，无法证明真实字段归属。请调用 resolve_document_reference 取得 occurrence_id 和 reference_literal_span_id，再关联到原引用实际所在的业务字段；不得统一搬到 note 或伪字段 reference_only。" }
});
      }
      if (
        resolution.application_mode !== "reference_only"
        && destination.target_field === "reference_only"
      ) {
        issues.push({
          code: "reference_application_without_field",
          path: destinationPath,
          message: "replace_field must route to authoritative source fields",
        details: { required_action: "replace_field must route to authoritative source fields" }
});
      }
      if (
        resolution.application_mode === "replace_field"
        && BOUND_FIELDS.includes(destination.target_field as AcceptanceItemField)
      ) {
        const field = destination.target_field as AcceptanceItemField;
        if (occurrence?.reference_kind === "clause") {
          const discardedLocalContent = clauseReferenceLocalResidual(
            referenceOccurrenceOriginEvidenceIds(occurrence).map((evidenceId) => evidenceById.get(evidenceId)?.text ?? "").join("") || item[field],
            occurrence.raw_reference,
          );
          if (discardedLocalContent) {
            issues.push({
              code: "clause_reference_replace_would_discard_local_requirement",
              path: `/reference_resolutions/${index}/application_mode`,
              message: "replace_entire_destination_field（旧 wire 值 replace_field）会删除引用前后的本地实质要求。应使用 retain_local_field_and_attach_reference（reference_only），完整保留本地字段和原引用，并把被引内容关联到精确 literal 位置。只有没有独立本地要求的纯指针字段才允许整字段替换；它绝不是只替换引用字面量。",
              details: {
                item_id: item.item_id,
                occurrence_id: occurrence.occurrence_id,
                target_field: field,
                raw_reference: occurrence.raw_reference,
                discarded_local_content_preview: discardedLocalContent.slice(0, 160),
                required_action: "改用 reference_only 保留本地字段并原位关联被引内容；若被引内容新增独立测试维度，再增加独立 item",
              },
            });
          }
        }
        if (
          occurrence
          && (typeof item[field] === "string" ? item[field] : "")
            .replace(/\s+/g, "")
            .includes(occurrence.raw_reference)
        ) {
          issues.push({
            code: "reference_literal_retained",
            path: `/acceptance_items/${plan.acceptance_items.indexOf(item)}/${field}`,
            // 出口必须在报错处说清楚。replace_field 假定被引表装着能替换进来的值；
            // 空白记录表没有值可替，模型于是在「必须替换」与「无从替换」之间反复撞，
            // 最后报 harness_contract_defect 退出（GB/T 50312 实测两次运行各撞 6、3 次）。
            // 同一本书另一次运行的模型改用 reference_only + 理由就过了——路一直在，
            // 只是这条消息从没提过。
            message: "replace_entire_destination_field（旧 wire 值 replace_field）会删除目标字段全部本地值并用目标证据重建整个字段，绝不是只替换引用字面量。若不应删除本地字段，使用 retain_local_field_and_attach_reference（reference_only），并把 target_field 设为引用原本所在的真实业务字段。",
            details: { required_action: "Switch application_mode to retain_local_field_and_attach_reference (reference_only) instead of replacing the whole field",
              retained_literal: occurrence.raw_reference,
              target_locator: occurrence.reference_kind === "table"
                ? `table:${occurrence.target_table_id}`
                : `${occurrence.target_address.source_id}:${occurrence.target_address.locator}`,
              alternative_application_mode: "reference_only",
            },
          });
        }
        if (!item.field_bindings[field].evidence_ids.some((evidenceId) =>
          resolution.target_evidence_ids.includes(evidenceId)
        )) {
          issues.push({
            code: "reference_replacement_without_binding",
            path: `/acceptance_items/${plan.acceptance_items.indexOf(item)}/field_bindings/${field}`,
            message: "整字段替换至少必须绑定一条已选择的目标证据行。",
        details: { required_action: "整字段替换至少必须绑定一条已选择的目标证据行。" }
});
        }
      }
      const routed = referenceTargetsByItem.get(item.item_id) ?? new Set<string>();
      resolution.target_evidence_ids.forEach((evidenceId) => routed.add(evidenceId));
      referenceTargetsByItem.set(item.item_id, routed);
      const fieldRouteKey = `${item.item_id}|${destination.target_field}`;
      const fieldRouted = referenceTargetsByItemField.get(fieldRouteKey)
        ?? new Set<string>();
      resolution.target_evidence_ids.forEach((evidenceId) =>
        fieldRouted.add(evidenceId)
      );
      referenceTargetsByItemField.set(fieldRouteKey, fieldRouted);
      for (const targetEvidenceId of resolution.target_evidence_ids) {
        const routeKey = [
          item.item_id,
          destination.target_field,
          targetEvidenceId,
        ].join("|");
        if (referenceRoutes.has(routeKey)) {
          issues.push({
            code: "duplicate_reference_route",
            path: destinationPath,
            message: "同一条被引证据只能向同一个 item 字段路由一次。",
            details: { required_action: "同一条被引证据只能向同一个 item 字段路由一次。", route: routeKey },
          });
        }
        referenceRoutes.add(routeKey);
      }
    });
    if (occurrence && resolution.application_mode !== "reference_placeholder" && !contextReference) {
      const requiresOriginBinding = referenceOccurrenceLiteralSpanIds(occurrence).length > 1
        || Boolean(occurrence.normalized_reference);
      if (!resolution.origin_binding && requiresOriginBinding) {
        issues.push({
          code: "reference_origin_binding_missing",
          path: `/reference_resolutions/${index}/origin_binding`,
          message: "引用必须单独持久化本地 origin binding；destination bindings 只描述被引内容导入位置，二者不能互相代替。",
          details: { occurrence_id: occurrence.occurrence_id, origin_fields: occurrence.origin_fields, required_action: "persist_the_compiler_verified_origin_binding_separately_from_destinations" },
        });
      } else if (resolution.origin_binding && !occurrence.origin_fields.includes(resolution.origin_binding.target_field)) {
        issues.push({
          code: "reference_origin_binding_mismatch",
          path: `/reference_resolutions/${index}/origin_binding/target_field`,
          message: "持久化 origin binding 与已核验 occurrence 来源角色不一致。",
          details: { occurrence_id: occurrence.occurrence_id, expected: occurrence.origin_fields, actual: resolution.origin_binding, required_action: "correct_the_origin_occurrence_or_origin_binding_without_changing_destination_routes" },
        });
      }
    }
  });
  for (const [index, occurrence] of manifest.reference_occurrences.entries()) {
    if (!activeOccurrenceIds.has(occurrence.occurrence_id)) continue;
    const count = resolutionCountByOccurrence.get(occurrence.occurrence_id) ?? 0;
    if (count === 0) {
      issues.push({
        code: "reference_resolution_missing",
        path: "/reference_resolutions",
        // reference_resolutions 是编译产物，作者端写不了它——可写的是 selectors.references，
        // 锚点命中该 occurrence 的 origin_evidence 时编译器才会生成对应的解析记录。
        // 只报 `/reference_resolutions` 会让作者去找一个不存在的字段：实测 GB/T 50312
        // 有两个目标据此报 harness_contract_defect 退出（「未提供引用解析记录类型或可写入路径」），
        // 那个判断在它掌握的信息下是合理的。所以这里必须把可写路径和锚点一并给出。
        message: occurrence.reference_kind === "table"
          ? "Every discovered table reference requires one explicit resolution before sealing. Author it as a selectors.references entry: anchor_span_ids must select a span inside the listed origin_evidence_id, target_span_ids must select the referenced table's rows. reference_resolutions itself is compiler-derived and is not writable."
          : "Every discovered clause or section reference requires one explicit resolution before sealing. Author it as a selectors.references entry: anchor_span_ids must select the listed origin evidence, and target_span_ids must select only the bounded target evidence attached to this occurrence. reference_resolutions itself is compiler-derived and is not writable.",
        details: {
          occurrence_id: occurrence.occurrence_id,
          origin_evidence_id: occurrence.origin_evidence_id,
          target_locator: occurrence.reference_kind === "table"
            ? `table:${occurrence.target_table_id}`
            : `${occurrence.target_address.source_id}:${occurrence.target_address.locator}`,
          candidate_count: occurrence.target_evidence_ids.length,
          candidate_fingerprint: sha256Text(JSON.stringify(occurrence.target_evidence_ids)),
          candidate_read_tool: "read_reference_facts",
          manifest_index: index,
          writable_collection: "references",
          required_action: "在 selectors.references 中逐字填写 occurrence_id，以全部有序 reference_literal_span_ids 为 anchor，并关联到原业务字段",
          disambiguation_note: "When one origin cites several targets, set the references entry's occurrence_id to occurrence_id above.",
        },
      });
    } else if (count > 1) {
      issues.push({
        code: "duplicate_reference_occurrence_resolution",
        path: "/reference_resolutions",
        message: "每一处已登记引用 occurrence 必须且只能解析一次。",
        details: { required_action: "每一处已登记引用 occurrence 必须且只能解析一次。", occurrence_id: occurrence.occurrence_id, count },
      });
    }
  }
  plan.acceptance_items.forEach((item, index) => {
    const expected = [...(referenceTargetsByItem.get(item.item_id) ?? new Set())].sort();
    const actual = [...item.reference_evidence_ids].sort();
    if (canonicalize(expected) !== canonicalize(actual)) {
      issues.push({
        code: "reference_relation",
        path: `/acceptance_items/${index}/reference_evidence_ids`,
        message: "reference_evidence_ids 必须与 reference_resolutions 路由到该 item 的证据完全一致。",
        details: { required_action: "reference_evidence_ids 必须与 reference_resolutions 路由到该 item 的证据完全一致。", expected, actual },
      });
    }
    BOUND_FIELDS.forEach((field) => {
      const allowedReferences = referenceTargetsByItemField.get(
        `${item.item_id}|${field}`,
      ) ?? new Set<string>();
      const semanticReferences = semanticReferenceEvidenceIdsForDestination(
        plan,
        item.item_id,
        field,
      );
      const misrouted = item.field_bindings[field].evidence_ids.filter(
        (evidenceId) =>
          !item.evidence_ids.includes(evidenceId)
          && !allowedReferences.has(evidenceId)
          && !semanticReferences.has(evidenceId),
      );
      if (misrouted.length) {
        issues.push({
          code: "field_binding_reference_route",
          path: `/acceptance_items/${index}/field_bindings/${field}/evidence_ids`,
          message: "被引字段证据必须路由到同一个 item 的原业务字段和原位置。",
          details: { required_action: "被引字段证据必须路由到同一个 item 的原业务字段和原位置。", actual: misrouted },
        });
      }
    });
  });

  const dispositionIds = plan.evidence_dispositions.map((row) => row.evidence_id);
  const repeatedDispositions = duplicates(dispositionIds);
  if (repeatedDispositions.length) {
    issues.push({
      code: "duplicate_evidence_disposition",
      path: "/evidence_dispositions",
      message: "Each evidence ID must be disposed exactly once",
      details: { required_action: "Keep exactly one evidence_dispositions row per evidence id", actual: repeatedDispositions },
    });
  }
  pushUnknownEvidence(issues, knownEvidence, dispositionIds, "/evidence_dispositions");
  const missingDispositions = compiledUnhandledEvidenceIds(plan, manifest.evidence);
  if (missingDispositions.length) {
    issues.push({
      code: "unhandled_evidence",
      path: "/evidence_dispositions",
      message: "Every evidence atom marked requires_disposition must be explicitly handled",
      details: { required_action: "Bind each listed evidence id to an item, or stage an explicit source_disposition / residual_source_dispositions entry", evidence_ids: missingDispositions },
    });
  }

  plan.evidence_dispositions.forEach((row, index) => {
    const unknownItems = row.item_ids.filter((itemId) => !knownItems.has(itemId));
    if (unknownItems.length) {
      issues.push({
        code: "unknown_disposition_item",
        path: `/evidence_dispositions/${index}/item_ids`,
        message: "Evidence disposition names unknown item IDs",
        details: { required_action: "Evidence disposition names unknown item IDs", actual: unknownItems },
      });
    }
    if (row.disposition === "used" && row.item_ids.length === 0) {
      issues.push({
        code: "used_evidence_without_item",
        path: `/evidence_dispositions/${index}/item_ids`,
        message: "Used evidence must identify at least one receiving item",
        details: { required_action: "Used evidence must identify at least one receiving item" }
});
    }
    if (row.disposition !== "used" && row.item_ids.length !== 0) {
      issues.push({
        code: "non_used_evidence_with_item",
        path: `/evidence_dispositions/${index}/item_ids`,
        message: "Context or ignored evidence must not claim receiving items",
        details: { required_action: "Context or ignored evidence must not claim receiving items" }
});
    }
  });
  if (genericAgentEvidence) {
    plan.acceptance_items.forEach((item, index) => {
      for (const evidenceId of item.sampling.evidence_ids) {
        const disposition = dispositionsByEvidence.get(evidenceId);
        if (
          disposition?.disposition !== "used"
          || !disposition.item_ids.includes(item.item_id)
        ) {
          issues.push({
            code: "sampling_disposition_relation",
            path: `/acceptance_items/${index}/sampling/evidence_ids`,
            message: "Every shared or item-local sampling citation must have a used disposition naming the same receiving item",
            details: { required_action: "Every shared or item-local sampling citation must have a used disposition naming the same receiving item", evidence_id: evidenceId, item_id: item.item_id },
          });
        }
      }
    });
    const selectedAtomIds = manifest.scope.selected_atom_ids ?? [];
    if (selectedAtomIds.length === 0) {
      issues.push({
        code: "agent_target_without_primary_atoms",
        path: "/evidence_dispositions",
        message: "An Agent-discovered target package must name its primary document atoms",
        details: { required_action: "An Agent-discovered target package must name its primary document atoms" }
});
    }
    for (const evidenceId of selectedAtomIds) {
      // With an exact ledger scope, selected atom IDs remain physical navigation addresses while
      // the manifest carries only granular primary evidence. Only materialized atoms require a
      // selector disposition; the granular primary records are enforced independently above.
      if (!knownEvidence.has(evidenceId)) continue;
      const disposition = dispositionsByEvidence.get(evidenceId);
      if (
        !semanticWorkflow
        && (disposition?.disposition !== "used" || disposition.item_ids.length === 0)
      ) {
        issues.push({
          code: "agent_primary_atom_not_used",
          path: "/evidence_dispositions",
          message: "Every document atom selected by discovery must be used by at least one emitted acceptance item",
          details: { required_action: "Every document atom selected by discovery must be used by at least one emitted acceptance item", evidence_id: evidenceId },
        });
      } else if (semanticWorkflow && !disposition) {
        issues.push({
          code: "agent_primary_atom_unhandled",
          path: "/evidence_dispositions",
          message: "Every document atom selected by discovery must have an explicit disposition after semantic classification",
          details: { required_action: "Every document atom selected by discovery must have an explicit disposition after semantic classification", evidence_id: evidenceId },
        });
      }
    }
  }

  plan.acceptance_items.forEach((item, index) => {
    for (const evidenceId of item.evidence_ids) {
      const disposition = dispositionsByEvidence.get(evidenceId);
      if (
        disposition?.disposition !== "used"
        || !disposition.item_ids.includes(item.item_id)
      ) {
        issues.push({
          code: "citation_disposition_relation",
          path: `/acceptance_items/${index}/evidence_ids`,
          message: "Every item citation must have a used disposition that names the same item",
          details: { required_action: "Every item citation must have a used disposition that names the same item", evidence_id: evidenceId, item_id: item.item_id },
        });
      }
    }
  });

  const contract = tableAssemblyIssues.length
    ? undefined
    : buildPlanContract(manifest, plan.table_assembly);
  if (contract?.formal_rows.length) {
    const expectedLots = new Map(
      contract.plan_template.inspection_lots.map((lot) => [lot.lot_id, lot]),
    );
    const expectedItems = new Map(
      contract.plan_template.acceptance_items.map((item) => [item.item_id, item]),
    );
    const actualLots = new Map(plan.inspection_lots.map((lot) => [lot.lot_id, lot]));
    const actualItems = new Map(plan.acceptance_items.map((item) => [item.item_id, item]));
    const missingFormalLotIds = [...expectedLots.keys()]
      .filter((lotId) => !actualLots.has(lotId))
      .sort();
    if (missingFormalLotIds.length) {
      issues.push({
        code: "formal_lot_inventory",
        path: "/inspection_lots",
        message: "Formal table targets must retain every assigned logical table; additional semantically proved lots may coexist",
        details: { required_action: "Formal table targets must retain every assigned logical table; additional semantically proved lots may coexist",
          expected: [...expectedLots.keys()].sort(),
          actual: [...actualLots.keys()].sort(),
          missing: missingFormalLotIds,
        },
      });
    }
    const missingFormalItemIds = [...expectedItems.keys()]
      .filter((itemId) => !actualItems.has(itemId))
      .sort();
    if (missingFormalItemIds.length) {
      issues.push({
        code: "formal_item_inventory",
        path: "/acceptance_items",
        message: "Formal table targets must retain every formal table row; additional clause-derived items remain subject to semantic evidence validation",
        details: { required_action: "Formal table targets must retain every formal table row; additional clause-derived items remain subject to semantic evidence validation",
          expected: [...expectedItems.keys()].sort(),
          actual: [...actualItems.keys()].sort(),
          missing: missingFormalItemIds,
        },
      });
    }
    for (const [lotId, expected] of expectedLots) {
      const actual = actualLots.get(lotId);
      if (!actual) continue;
      if (
        actual.name !== expected.name
        || canonicalize([...actual.evidence_ids].sort())
          !== canonicalize([...expected.evidence_ids].sort())
      ) {
        issues.push({
          code: "formal_lot_source_relation",
          path: `/inspection_lots/${plan.inspection_lots.indexOf(actual)}`,
          message: "Formal lot name and title evidence must match its source table",
          details: { required_action: "Formal lot name and title evidence must match its source table",
            expected_name: expected.name,
            expected_evidence_ids: expected.evidence_ids,
          },
        });
      }
    }
    for (const row of contract.formal_rows) {
      const actual = actualItems.get(row.item_id);
      if (!actual) continue;
      if (
        actual.lot_id !== row.lot_id
        || actual.category !== row.category
        || canonicalize(actual.evidence_ids) !== canonicalize([row.evidence_id])
      ) {
        issues.push({
          code: "formal_row_item_relation",
          path: `/acceptance_items/${plan.acceptance_items.indexOf(actual)}`,
          message: "A formal table row must map to its one contracted item, lot, category, and primary citation",
          details: { required_action: "A formal table row must map to its one contracted item, lot, category, and primary citation", actual: row },
        });
      }
      const disposition = dispositionsByEvidence.get(row.evidence_id);
      if (
        disposition?.disposition !== "used"
        || canonicalize(disposition.item_ids) !== canonicalize([row.item_id])
      ) {
        issues.push({
          code: "formal_row_disposition_relation",
          path: "/evidence_dispositions",
          message: "Each formal table row must be used by exactly its one contracted item",
          details: { required_action: "Each formal table row must be used by exactly its one contracted item",
            evidence_id: row.evidence_id,
            expected_item_id: row.item_id,
          },
        });
      }
    }
  }

  const classified = compactSourcePlan?.validation_boundary === STRUCTURAL_VALIDATION_BOUNDARY
    ? partitionValidationIssues(issues) : { errors: issues, model_review: [] };
  if (classified.errors.length) {
    return { ok: false, issues: classified.errors, model_review: classified.model_review };
  }
  const planSha256 = sha256Text(canonicalize(plan));
  return {
    ok: true,
    issues: [],
    model_review: classified.model_review,
    plan,
    plan_sha256: planSha256,
    fingerprint: sha256Text(
      canonicalize({
        validator: "semantic-source-plan-validator/v4",
        evidence_fingerprint: manifest.evidence_fingerprint,
        plan_sha256: planSha256,
      }),
    ),
  };
}

export interface ValidatedSemanticPlanViews {
  persisted_plan: PersistedSemanticSourcePlan;
  semantic_plan: SemanticSourcePlan;
  schema_version: typeof PLAN_SCHEMA_VERSION | typeof COMPACT_PLAN_SCHEMA_VERSION;
  validator: "semantic-source-plan-validator/v4" | "semantic-source-plan-validator/v5";
  plan_sha256: string;
  fingerprint: string;
}

export type ValidatedSemanticPlanViewsResult =
  | { ok: true; value: ValidatedSemanticPlanViews }
  | { ok: false; issues: ValidationIssue[]; actual_fingerprint?: string };

/**
 * Validates the exact persisted artifact once and exposes a hydrated semantic
 * view for deterministic consumers. The compact artifact remains authoritative
 * for hashes, fingerprints, receipts, and later persistence.
 */
export function validateSemanticPlanViews(
  source: string,
  manifest: EvidenceManifest,
  options: {
    expected_fingerprint?: string;
    opened_evidence_ids?: Set<string>;
  } = {},
): ValidatedSemanticPlanViewsResult {
  const validation = validatePlanText(source, manifest, options.opened_evidence_ids);
  if (
    !validation.ok
    || !validation.plan
    || !validation.plan_sha256
    || !validation.fingerprint
  ) {
    return {
      ok: false,
      issues: validation.issues,
      ...(validation.fingerprint ? { actual_fingerprint: validation.fingerprint } : {}),
    };
  }
  if (
    options.expected_fingerprint
    && validation.fingerprint !== options.expected_fingerprint
  ) {
    return {
      ok: false,
      issues: [{
        code: "plan_fingerprint_mismatch",
        path: "/",
        message: "The persisted semantic plan does not match the expected validated fingerprint",
        details: {
          required_action: "Re-validate the current plan fingerprint; do not submit a stale plan",
          expected_fingerprint: options.expected_fingerprint,
          actual_fingerprint: validation.fingerprint,
        },
      }],
      actual_fingerprint: validation.fingerprint,
    };
  }
  const persistedPlan = validation.persisted_plan ?? validation.plan;
  const compact = isCompactSemanticSourcePlan(persistedPlan);
  return {
    ok: true,
    value: {
      persisted_plan: persistedPlan,
      semantic_plan: validation.plan,
      schema_version: compact ? COMPACT_PLAN_SCHEMA_VERSION : PLAN_SCHEMA_VERSION,
      validator: compact
        ? "semantic-source-plan-validator/v5"
        : "semantic-source-plan-validator/v4",
      plan_sha256: validation.plan_sha256,
      fingerprint: validation.fingerprint,
    },
  };
}
