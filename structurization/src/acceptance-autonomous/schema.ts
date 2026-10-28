import Ajv, { type ValidateFunction } from 'ajv';
import { Type } from 'typebox';
import type { AcceptanceDelivery, AcceptanceIssue } from './contracts.js';

const text = Type.String({ minLength: 1 });
const texts = Type.Array(text, { uniqueItems: true });
const obj = (properties: Record<string, unknown>) => Type.Object(properties as never, { additionalProperties: false });
const quote = obj({ source_id: text, block_id: text, start: Type.Integer({ minimum: 0 }), end: Type.Integer({ minimum: 1 }), text });
const evidence = Type.Array(quote);
const bound = obj({ value: Type.String(), evidence, mode: Type.Optional(Type.Union([Type.Literal('literal'), Type.Literal('summary')])), reason: Type.Optional(text) });
const enumeration = (...values: string[]) => Type.Union(values.map(value => Type.Literal(value)));

export const ACCEPTANCE_DELIVERY_SCHEMA = obj({
  schema_version: Type.Literal('acceptance-autonomous-delivery/v1'), source_sha256: text,
  rules: Type.Array(obj({ id: text, method_files: texts, scope: text, exceptions: texts, evidence,
    relationship: Type.Optional(obj({ kind: enumeration('membership', 'shared_requirement', 'inheritance', 'sampling'),
      objects: texts, conditions: Type.Array(bound), exclusions: Type.Array(bound) })) })),
  groups: Type.Array(obj({ id: text, structure: text, rule_ids: texts, lot_ids: texts, trial_lot_ids: texts,
    boundary_lot_ids: texts, conditions: text, exclusions: texts })),
  lots: Type.Array(obj({ id: text, name: bound,
    ancestors: Type.Array(obj({ id: text, name: bound, kind: enumeration('分部', '子分部', '分项') })),
    scope: obj({ block_ids: texts, reason: text, evidence }), group_id: text, dependency_ids: texts,
    items: Type.Array(obj({ id: text, name: bound, category: bound, requirement: bound, method: bound, quantity: bound,
      unit: bound, condition: bound, note: bound, inspection_data_type: enumeration('measurement', 'counting', 'mixed', 'review'),
      inspection_data_type_reason: text, sampling: obj({ status: enumeration('specified', 'requires_conditions', 'reference_unspecified_quantity', 'not_sampling'),
        text: bound, conditions: Type.Array(bound), formula: Type.Optional(obj({ expression: text, variables: texts, reason: text, evidence })) }),
      reference_ids: texts, rule_ids: texts }), { minItems: 1 }) })),
  dispositions: Type.Array(obj({ source_id: text, block_id: text, role: enumeration('lot', 'shared', 'not_extractable', 'unresolved'),
    lot_ids: texts, reason: text, evidence })),
  references: Type.Array(obj({ id: text, origin: quote, standard_no: Type.String(), version: Type.String(), clause: Type.String(), object: text,
    purpose: text, conditions: Type.Array(bound), dependent_lot_ids: texts, disposition: enumeration('literal', 'applicable', 'not_applicable', 'unresolved'),
    source_id: Type.Optional(text), evidence, reason: text })),
  problems: Type.Array(obj({ id: text, kind: enumeration('scope', 'structure', 'conflict', 'reference', 'sampling', 'extraction'),
    message: text, affected_lot_ids: texts, block_ids: texts, dependency_ids: texts })),
});

const AjvConstructor = Ajv as unknown as { new(options?: object): { compile(schema: object): ValidateFunction } };
const validate = new AjvConstructor({ allErrors: true, strict: false }).compile(ACCEPTANCE_DELIVERY_SCHEMA);

export function parseAcceptanceDelivery(value: unknown): { delivery?: AcceptanceDelivery; issues: AcceptanceIssue[] } {
  if (validate(value)) return { delivery: value as AcceptanceDelivery, issues: [] };
  return { issues: (validate.errors ?? []).map(error => ({ code: 'delivery_schema', path: error.instancePath,
    actual: error.params, message: `${error.message}; 请修改作者交付文件该字段后重新验证，原文和验证规则不可写。`, affected_lot_ids: [] })) };
}
