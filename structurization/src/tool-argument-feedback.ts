import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { renderFeedback } from "./acceptance-feedback-text.js";
import { Ajv, type ValidateFunction } from "ajv";
import { Value } from "typebox/value";
import { selectorPatchReceipt } from "./selector-feedback.js";

const COMPLETE_ITEM_SAMPLING_FIELDS = [
  "status", "rule_key", "branch_keys", "quantity_span_ids", "script_span_ids",
  "condition_span_ids", "reason", "confidence",
] as const;

const escapePointer = (key: string) => key.replace(/~/gu, "~0").replace(/\//gu, "~1");
function atPointer(value: any, pointer: string): any {
  return pointer.replace(/^#/u, "").split("/").slice(1)
    .reduce((node, key) => node?.[key.replace(/~1/gu, "/").replace(/~0/gu, "~")], value);
}

function preview(value: unknown): unknown {
  const text = JSON.stringify(value);
  return text && text.length > 400 ? { preview: text.slice(0, 400), truncated: true } : value;
}

function describeField(schema: any, includeProperties = true): Record<string, unknown> {
  if (!schema) return { type: "见工具参数 schema" };
  const alternatives = schema.anyOf ?? schema.oneOf;
  const literals = Array.isArray(alternatives) && alternatives.every(part => Object.hasOwn(part, "const"))
    ? alternatives.map(part => part.const) : undefined;
  return {
    ...(schema.type ? { type: schema.type } : {}),
    ...(schema.description ? { description: schema.description } : {}),
    ...(schema.required ? { required_fields: schema.required } : {}),
    ...(schema.properties ? { allowed_fields: Object.keys(schema.properties) } : {}),
    ...(includeProperties && schema.properties ? { properties: Object.fromEntries(
      Object.entries(schema.properties).map(([key, field]) => [key, describeField(field, false)]),
    ) } : {}),
    ...(schema.items && !Array.isArray(schema.items) ? { items: describeField(schema.items, false) } : {}),
    ...Object.fromEntries(["minLength", "maxLength", "pattern", "minimum", "maximum", "minItems", "maxItems", "uniqueItems"]
      .filter(key => Object.hasOwn(schema, key)).map(key => [key, schema[key]])),
    ...(schema.enum || literals ? { allowed_values: schema.enum ?? literals } : {}),
    ...(Object.hasOwn(schema, "const") ? { allowed_values: [schema.const] } : {}),
    ...(Array.isArray(alternatives) && !literals ? { alternatives: alternatives.map(part => describeField(part, includeProperties)),
      choice_rule: "按字段契约选择一个适用分支，不要把所有备选分支的字段都补上" } : {}),
  };
}

function acceptsJsonType(schema: any, value: unknown): boolean {
  // An untyped/ref/composite alternative is potentially applicable. Never infer
  // its business branch from property names, enum values or a discriminator.
  if (!schema?.type) return true;
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  const actual = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  return types.some((type: string) => type === actual || (type === "integer" && Number.isInteger(value)));
}

function hasUnambiguousUnionPath(root: any, schemaPath: string, instancePath: string, args: unknown, typeError: boolean): boolean {
  const decode = (pointer: string) => pointer.replace(/^#/u, "").split("/").slice(1)
    .map(key => key.replace(/~1/gu, "/").replace(/~0/gu, "~"));
  const keys = decode(schemaPath).slice(0, -1), dataKeys = decode(instancePath);
  let schema = root, value: any = args, dataIndex = 0;
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index]!;
    if (key === "properties") {
      const property = keys[++index]!;
      if (dataKeys[dataIndex++] !== property) return false;
      schema = schema?.properties?.[property]; value = value?.[property];
    } else if (key === "items") {
      const item = dataKeys[dataIndex++];
      if (!Array.isArray(value) || !item || !/^\d+$/u.test(item) || Array.isArray(schema?.items)) return false;
      schema = schema?.items; value = value[Number(item)];
    } else if (key === "anyOf" || key === "oneOf" || key === "allOf") {
      const branch = Number(keys[++index]);
      const alternatives = schema?.[key];
      if (!Array.isArray(alternatives) || !Number.isInteger(branch) || !alternatives[branch]) return false;
      if (key !== "allOf") {
        const possible = alternatives.flatMap((part: any, candidate: number) => acceptsJsonType(part, value) ? [candidate] : []);
        // Canonical IDs and short handles may use different string patterns.
        // If every leaf alternative requires the same type, a wrong type is
        // definite even though selecting one pattern would be ambiguous.
        const commonLeafType = typeError && index === keys.length - 1 && possible.length === 0
          && typeof alternatives[branch].type === "string"
          && alternatives.every((part: any) => part?.type === alternatives[branch].type);
        if (!commonLeafType && (possible.length !== 1 || possible[0] !== branch)) return false;
      }
      schema = alternatives[branch];
    } else {
      // Conditional, referenced, tuple and other unmapped paths stay native.
      return false;
    }
  }
  return dataIndex === dataKeys.length;
}

function jsonTypeLabel(value: unknown): string {
  return value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
}

function isOptionalPropertyKeyword(root: any, schemaPath: string, keyword: string): boolean {
  const match = new RegExp(`^(.*)/properties/([^/]+)/${keyword}$`, "u").exec(schemaPath);
  if (!match) return false;
  const owner = atPointer(root, match[1] || "#");
  const field = match[2]!.replace(/~1/gu, "/").replace(/~0/gu, "~");
  return Boolean(
    owner?.properties
    && Object.hasOwn(owner.properties, field)
    && (!Array.isArray(owner.required) || !owner.required.includes(field)),
  );
}

interface ToolArgumentIssue {
  code: string;
  path: string;
  writable_path: string;
  actual: unknown;
  actual_count?: number;
  how_to_pass: string;
  next_tool: string;
  field?: string;
  expected?: Record<string, unknown>;
  allowed_fields?: string[];
  received_json_type?: string;
  optional_property?: boolean;
}

/**
 * Explain definite shape, array-bound and fixed-value errors before SDK validation,
 * without editing arguments or schemas. Union ambiguity stays native: the SDK
 * receipt remains authoritative whenever JSON type cannot pick a branch or
 * establish a common leaf type requirement.
 */
export function withToolArgumentFeedback(tool: ToolDefinition, validateShape: ValidateFunction = new Ajv({ allErrors: true, strict: false }).compile(tool.parameters)): ToolDefinition {
  return {
    ...tool,
    prepareArguments(raw) {
      const args = tool.prepareArguments ? tool.prepareArguments(raw) : raw;
      // The SDK starts with this same conversion on a clone. Never return the
      // converted copy: native SDK validation/coercion remains authoritative.
      const converted = structuredClone(args);
      Value.Convert(tool.parameters, converted);
      validateShape(converted);
      const issues = (validateShape.errors ?? []).flatMap((error): ToolArgumentIssue[] => {
        // A union's shape errors are actionable
        // only when JSON type identifies a branch or every leaf has that type.
        if (error.keyword !== "additionalProperties"
          && error.keyword !== "required"
          && error.keyword !== "const"
          && error.keyword !== "enum"
          && error.keyword !== "minItems"
          && error.keyword !== "maxItems"
          && error.keyword !== "type") return [];
        const params = error.params as Record<string, unknown>;
        if (error.keyword === "const" || error.keyword === "enum") {
          let allowedValues: unknown[] | undefined;
          let unionAlternatives = false;
          // A union of literals directly owning the constant is a closed
          // enumeration: listing every allowed constant reveals the whole set
          // without choosing a business branch. Constants nested deeper inside
          // one union branch (discriminators, conditional shapes) stay native:
          // reporting one branch's constant would invent the branch choice.
          // Round-10 regression: a separator union of ""/" "/"\n" reached the
          // model as bare "must be equal to constant" with no allowed values.
          const unionSegments = [...error.schemaPath.matchAll(/\/(?:anyOf|oneOf)\/\d+/gu)].map((match) => match[0]);
          const lastSegment = error.schemaPath.split("/").pop();
          const immediateUnion = unionSegments.length === 1
            && (lastSegment === "const" || lastSegment === "enum")
            && error.schemaPath.endsWith(`${unionSegments[0]}/${lastSegment}`);
          if (immediateUnion && unionSegments[0]) {
            const cut = error.schemaPath.indexOf(unionSegments[0]);
            const unionKeyword = unionSegments[0].split("/")[1]!;
            const union = atPointer(tool.parameters, `${error.schemaPath.slice(0, cut)}/${unionKeyword}`);
            // The pointer resolves to the alternatives array itself when the
            // schema stores anyOf/oneOf as a plain array.
            const alternatives: any[] | undefined = Array.isArray(union)
              ? union
              : union?.anyOf ?? union?.oneOf;
            if (Array.isArray(alternatives) && alternatives.length > 0
              && alternatives.every((part) => Object.hasOwn(part, "const"))) {
              allowedValues = alternatives.map((part) => part.const);
              unionAlternatives = true;
            }
          } else if (unionSegments.length === 0
            && !/\/(?:if|then|else|not)(?:\/|$)/u.test(error.schemaPath)) {
            const schema = atPointer(tool.parameters, error.schemaPath.replace(/\/[^/]+$/u, ""));
            allowedValues = error.keyword === "const" ? [schema?.const] : schema?.enum;
          }
          if (!Array.isArray(allowedValues) || allowedValues.length === 0) return [];
          const path = error.instancePath;
          const actual = atPointer(args, `#${path}`);
          return [{
            code: error.keyword === "const" && !unionAlternatives
              ? "tool_argument_constant_rejected"
              : "tool_argument_enum_rejected",
            path, writable_path: path,
            actual: preview(actual),
            expected: { json_type: jsonTypeLabel(allowedValues[0]), allowed_values: allowedValues },
            how_to_pass: "该参数只接受列出的固定值。对比 expected.allowed_values 原样填入，不要改写原文语义或自造变体来逼近允许值。",
            next_tool: tool.name,
          }];
        }
        if (/\/(?:anyOf|oneOf|if|then|else|not)(?:\/|$)/u.test(error.schemaPath)
          && !hasUnambiguousUnionPath(tool.parameters, error.schemaPath, error.instancePath, converted, error.keyword === "type")) return [];
        if (error.keyword === "minItems" || error.keyword === "maxItems") {
          if (typeof params.limit !== "number") return [];
          const path = error.instancePath;
          const fieldSchema = atPointer(tool.parameters, error.schemaPath.replace(/\/[^/]+$/u, ""));
          const fieldDescription = describeField(fieldSchema).description;
          const optionalProperty = error.keyword === "minItems"
            && isOptionalPropertyKeyword(tool.parameters, error.schemaPath, error.keyword);
          const actualArray = atPointer(converted, path);
          return [{
            code: "tool_argument_array_length", path, writable_path: path,
            actual: preview(atPointer(args, path)),
            ...(Array.isArray(actualArray) ? { actual_count: actualArray.length } : {}),
            expected: {
              json_type: "array",
              [error.keyword]: params.limit,
              ...(typeof fieldDescription === "string" ? { description: fieldDescription } : {}),
            },
            ...(optionalProperty ? { optional_property: true } : {}),
            how_to_pass: error.keyword === "minItems"
              ? optionalProperty
                ? `这是可选数组字段。若依据原文语义决定采用此数组表达，至少提交 ${params.limit} 项真实来源或记录；若该字段不适用或此次误加，删除或省略该可选属性本身。不得把所属父对象改成 null、丢弃其他有效内容或编造值；是否适用由你依据原文语义决定。`
                : `此数组至少需要 ${params.limit} 项。按字段契约补齐真实来源或记录；不要编造值，也不要把所属对象改成 null 来绕过该约束。`
              : `此数组实际 ${Array.isArray(actualArray) ? actualArray.length : "未知"} 项，最多接受 ${params.limit} 项。${typeof fieldDescription === "string" ? `字段契约：${fieldDescription} ` : ""}按字段契约修正：若字段只保存关键来源摘要，可选择上限内的关键来源，完整调查结论和待办仍须保留；若字段承载完整业务记录，不得为缩短数组丢弃有效来源或业务义务。只有字段契约明确说明支持增量或分批提交时，才能分批；不能假定重复调用会自动合并或保留上一批。`,
            next_tool: tool.name,
          }];
        }
        if (error.keyword === "type") {
          if (typeof params.type !== "string" && !Array.isArray(params.type)) return [];
          const path = error.instancePath;
          const actual = atPointer(args, `#${path}`);
          return [{
            code: "tool_argument_type_mismatch",
            path, writable_path: path,
            actual: preview(actual),
            expected: { json_type: params.type },
            received_json_type: jsonTypeLabel(actual),
            how_to_pass: "该参数的 JSON 类型不符。按 expected.json_type 提供同类型值（对象用 {}、数组用 []、文本加引号），不要改变业务内容。",
            next_tool: tool.name,
          }];
        }
        const key = params[error.keyword === "required" ? "missingProperty" : "additionalProperty"];
        const schema = atPointer(tool.parameters, error.schemaPath.replace(/\/[^/]+$/u, ""));
        // External refs or an unresolvable schema path remain the SDK's concern.
        if (typeof key !== "string" || !schema) return [];
        return [key].map(key => {
          const path = `${error.instancePath}/${escapePointer(key)}`;
          const missing = error.keyword === "required";
          const field = schema?.properties?.[key];
          return {
            code: missing ? "tool_argument_required" : "tool_argument_additional_property",
            path, writable_path: path, field: key,
            actual: missing ? { missing: true } : preview(atPointer(args, path)),
            ...(missing ? { expected: describeField(field) } : { allowed_fields: Object.keys(schema?.properties ?? {}) }),
            how_to_pass: missing
              ? `在此路径补齐 schema 要求的字段，按 expected 的类型、完整枚举集合、数组元素类型及边界构造参数；对象的直接子字段形状见 expected.properties，仍需保留 required_fields。${field?.description ? `字段契约：${field.description} ` : ""}值须依据原文及字段契约填写；不得把列出的备选分支全填入或自动选为空、不适用，不能为了通过校验编造值。`
              : "此对象不接受该字段。按工具参数 schema 移到真实所属位置或移除误加字段；不得因此删除其承载的有效原文或业务义务。",
            next_tool: tool.name,
          };
        });
      });
      // One logical error surfaces once: ajv repeats a union member error per
      // matching alternative, and the model only needs the receipt per path.
      const deduped = new Map<string, ToolArgumentIssue>();
      for (const issue of issues) {
        const key = JSON.stringify([issue.code, issue.path]);
        if (!deduped.has(key)) deduped.set(key, issue);
      }
      const uniqueIssues = [...deduped.values()];
      if (uniqueIssues.length) {
        const selectorDraft = tool.name === "stage_target_selector_draft";
        const itemSamplingShapeInvalid = selectorDraft && uniqueIssues.some(issue => (
          /^\/draft\/items\/\d+\/sampling(?:\/|$)/u.test(issue.path)
        ));
        const selectorRetryInstruction = selectorDraft
          ? " mutation_receipt 列出本次全部未生效记录和删除意图，不仅是报错记录。stage_target_selector_draft 的纯 upsert 可按 key 拆成多个较小批次重试；每个小批中的每条记录仍须包含 schema 的全部必填字段，最初计划提交的全部 key 最终都要成功保存，不能把未重试的 key 当成已保存。含 remove_keys 或 quote_bindings 时，删除意图或来源绑定仍须与对应记录保持原子关系。"
          : "";
        const samplingShapeInstruction = itemSamplingShapeInvalid
          ? ` item.sampling 必须完整保留 ${COMPLETE_ITEM_SAMPLING_FIELDS.join("、")}；业务上为空也不能省略字段，应按 schema 显式填写规定的空值。`
          : "";
        throw new Error(JSON.stringify({
          ok: false, error: "tool_argument_shape_invalid", stage: "sdk_argument_preparation",
          tool_name: tool.name, durable_mutation: false, budget_consumed: false, terminal: false,
          ...(selectorDraft ? { mutation_receipt: selectorPatchReceipt(args, "not_applied") } : {}),
          issues: uniqueIssues.slice(0, 24), issue_count: uniqueIssues.length, remaining_issue_count: Math.max(0, uniqueIssues.length - 24),
          next_tool: tool.name,
          ...(tool.name === "stage_target_selector_draft" ? { contract_read_tool: "get_target_selector_contract" } : {}),
          ...(itemSamplingShapeInvalid ? { complete_record_fields: { item_sampling: [...COMPLETE_ITEM_SAMPLING_FIELDS] } } : {}),
          instruction: renderFeedback({ kind: "request_rejected", constraint: `本次在SDK参数准备阶段拒绝，业务工具未执行。按issues中的完整参数路径和actual/expected修正；形状通过不批准业务，未展示问题仍会检查。${selectorRetryInstruction}${samplingShapeInstruction}` }),
          do_not_edit: "不可变原文、编译产物、与本次错误无关的正确字段；不要清空整批或只提交残缺记录来消除错误",
        }));
      }
      return args;
    },
  } as ToolDefinition;
}
