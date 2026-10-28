import Ajv from 'ajv';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { PI_AGENT_MODEL_STAGES, deepseekModelCompatibility, museModelCompatibility, museToolParameters, resolvePdfExCodePreset, type PiAgentRuntimeModelConfig } from '../src/presets.js';
import { applyModelPayloadCompatibility, configuredModel, constrainSelectorProviderPayload } from '../src/pi-runtime.js';

afterEach(() => vi.unstubAllEnvs());

describe('Muse preset transport', () => {
  test.each(['Gpt6Luna', 'gpt-6_luna'])('GPT-6 Luna preset %s resolves to Responses at the requested effort', presetName => {
    const preset = resolvePdfExCodePreset({
      LLM_PRESET: presetName,
      LLM_MODEL: 'gpt-6-luna',
      LLM_ENDPOINT: 'https://llm.example/v1',
      LLM_API_KEY: 'unit-test-key',
      LLM_REASONING_EFFORT: 'high',
    });
    expect(preset).toMatchObject({
      api: 'openai-responses',
      modelId: 'gpt-6-luna',
      reasoningEffort: 'high',
      supportsDeveloperRole: true,
    });
  });

  test('saved GPT-6 Luna settings use Responses without Muse compatibility', async () => {
    vi.stubEnv('LLM_PRESET', 'Gpt6Luna');
    vi.stubEnv('LLM_PROTOCOL', 'openai-responses');
    const root = await mkdtemp(join(tmpdir(), 'gpt6-luna-preset-'));
    try {
      const stageSettings = { apiType: 'openai', endpoint: 'https://llm.example/v1', apiKey: 'unit-test-key', model: 'gpt-6-luna', effort: 'high' };
      const uiConfig = { stages: Object.fromEntries(PI_AGENT_MODEL_STAGES.map(stage => [stage, stageSettings])) } as PiAgentRuntimeModelConfig;
      const configured = await configuredModel(root, 'hierarchy', uiConfig);
      expect(configured.model.api).toBe('openai-responses');
      expect(configured.model.compat?.supportsStrictMode).toBe(true);
      expect(configured.model.compat?.supportsDeveloperRole).not.toBe(false);
      expect(configured.configured?.effort).toBe('high');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test('standard Responses tools explicitly disable strict filling while preserving optional arguments', async () => {
    vi.stubEnv('LLM_PRESET', 'Gpt6Luna');
    const root = await mkdtemp(join(tmpdir(), 'response-optional-tool-'));
    try {
      const stageSettings = { apiType: 'openai', endpoint: 'https://llm.example/v1', apiKey: 'unit-test-key', model: 'gpt-6-luna', effort: 'high' };
      const uiConfig = { stages: Object.fromEntries(PI_AGENT_MODEL_STAGES.map(stage => [stage, stageSettings])) } as PiAgentRuntimeModelConfig;
      const { model, modelRuntime } = await configuredModel(root, 'target_extraction', uiConfig);
      const parameters = { type: 'object', properties: { collection: { type: 'string' }, key: { type: 'string' },
        evidence_ids: { type: 'array', minItems: 1, items: { type: 'string' } } }, required: ['collection', 'key'], additionalProperties: false };
      let wire: any;
      await modelRuntime.streamSimple(model, {
        messages: [{ role: 'user', content: '读取已有作者记录。', timestamp: Date.now() }],
        tools: [{ name: 'read_saved_record', description: '读取已有作者记录。', parameters }],
      }, { onPayload(payload) { wire = payload; throw new Error('neutral_payload_captured_before_network'); } }).result();
      const [wireTool] = wire.tools;
      expect(wireTool.strict).toBe(false);
      expect(wireTool.parameters).toEqual(parameters);
      expect(new Ajv({ strict: false }).compile(wireTool.parameters)({ collection: 'items', key: 'authored-component' })).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test('OpenCode Muse 1.3 uses Responses and defaults to low thinking', async () => {
    vi.stubEnv('LLM_PRESET', 'OpenCodeMuse1.3');
    vi.stubEnv('LLM_MODEL', 'custom-muse-model');
    vi.stubEnv('LLM_ENDPOINT', 'https://llm.example/v1');
    vi.stubEnv('LLM_API_KEY', 'unit-test-key');
    vi.stubEnv('LLM_REASONING_EFFORT', '');
    vi.stubEnv('PI_AGENT_PDF_MODEL', '');
    const preset = resolvePdfExCodePreset(process.env)!;
    expect(preset).toMatchObject({ api: 'openai-responses', modelId: 'custom-muse-model', reasoningEffort: 'low' });
    const root = await mkdtemp(join(tmpdir(), 'muse-preset-'));
    try {
      const envModel = await configuredModel(root, 'target_extraction');
      expect(envModel.model.api).toBe('openai-responses');
      expect(envModel.configured?.effort).toBe('low');
      const stageSettings = { apiType: 'openai', endpoint: preset.baseUrl, apiKey: 'unit-test-key', model: preset.modelId, effort: 'low' };
      const uiConfig = { stages: Object.fromEntries(PI_AGENT_MODEL_STAGES.map(stage => [stage, stageSettings])) } as PiAgentRuntimeModelConfig;
      for (const stage of PI_AGENT_MODEL_STAGES) {
        const uiModel = await configuredModel(root, stage, uiConfig);
        expect(uiModel.model.api).toBe('openai-responses');
        expect(uiModel.configured?.effort).toBe('low');
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test('auto survives model compatibility after filtering the actual Responses tool list', () => {
    const payload = { model: 'muse-spark-1.3-contributor', reasoning: { effort: 'low' }, input: [{ type: 'function_call_output', call_id: 'call_1', output: 'source' }], tools: [{ type: 'function', name: 'read_source' }, { type: 'function', name: 'write_anywhere' }] };
    const constrained = constrainSelectorProviderPayload(payload, { stage: 'inspect', allowed_tools: ['read_source'] });
    const adapted = applyModelPayloadCompatibility(constrained, payload.model);
    expect(adapted).toEqual({ ...payload, tool_choice: 'auto', tools: [payload.tools[0]] });
    expect(constrained.tool_choice).toBe('auto');
    expect(applyModelPayloadCompatibility(constrained, 'gpt-5.6-luna')).toBe(constrained);
    expect(museModelCompatibility('muse-spark-1.3-contributor', 'openai-completions')).toBeUndefined();
    expect(applyModelPayloadCompatibility({ ...payload, tools: [], tool_choice: 'required' }, payload.model)).not.toHaveProperty('tool_choice');
  });

  test('Step uses the Anthropic Messages protocol from the environment preset', async () => {
    vi.stubEnv('LLM_PRESET', 'Step');
    vi.stubEnv('LLM_MODEL', 'step-5-preview');
    vi.stubEnv('LLM_ENDPOINT', 'https://api.stepfun.com/step_plan/v1');
    vi.stubEnv('LLM_API_KEY', 'unit-test-key');
    vi.stubEnv('LLM_REASONING_EFFORT', 'high');
    vi.stubEnv('PI_AGENT_PDF_MODEL', '');
    const preset = resolvePdfExCodePreset(process.env)!;
    expect(preset).toMatchObject({ api: 'anthropic-messages', modelId: 'step-5-preview', reasoningEffort: 'high' });
    const root = await mkdtemp(join(tmpdir(), 'step-preset-'));
    try {
      const envModel = await configuredModel(root, 'target_extraction');
      expect(envModel.model.api).toBe('anthropic-messages');
      expect(envModel.configured?.apiType).toBe('anthropic');
      expect(envModel.configured?.effort).toBe('high');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test('DeepseekFlash keeps standard chat protocol and passes low effort through', async () => {
    vi.stubEnv('LLM_PRESET', 'deepseek-flash');
    vi.stubEnv('LLM_MODEL', 'deepseek-flash');
    vi.stubEnv('LLM_ENDPOINT', 'https://api.deepseek.com');
    vi.stubEnv('LLM_API_KEY', 'unit-test-key');
    vi.stubEnv('LLM_REASONING_EFFORT', 'low');
    vi.stubEnv('PI_AGENT_PDF_MODEL', '');
    const preset = resolvePdfExCodePreset(process.env)!;
    expect(preset).toMatchObject({ api: 'openai-completions', modelId: 'deepseek-flash', reasoningEffort: 'low', thinkingFormat: '' });
    const root = await mkdtemp(join(tmpdir(), 'deepseek-preset-'));
    try {
      const envModel = await configuredModel(root, 'target_extraction');
      expect(envModel.model.api).toBe('openai-completions');
      expect(envModel.configured?.effort).toBe('low');
    } finally { await rm(root, { recursive: true, force: true }); }
    expect(deepseekModelCompatibility('deepseek-flash')).toMatchObject({ thinkingFormat: 'deepseek', requiresReasoningContentOnAssistantMessages: true });
    expect(deepseekModelCompatibility('gpt-5.6-luna')).toBeUndefined();
  });
});


test('Muse nullable spelling preserves null/object validation instead of stringifying values', () => {
  const schema = { type: 'object', properties: { replacement: { anyOf: [{ type: 'null' }, { type: 'object', properties: { n: { type: 'integer', minimum: 1 } }, required: ['n'], additionalProperties: false }] } }, required: ['replacement'], additionalProperties: false };
  const normalized = museToolParameters(schema) as any;
  expect(normalized.properties.replacement.type).toEqual(['object', 'null']);
  const ajv = new Ajv({ strict: false });
  const before = ajv.compile(schema), after = ajv.compile(normalized);
  for (const replacement of [null, {n:1}, {n:0}, {}, {n:1,extra:2}, 'null', '{"n":1}']) {
    expect(after({replacement})).toBe(before({replacement}));
  }
  const payload = applyModelPayloadCompatibility({tools:[{type:'function',name:'submit',parameters:schema}]},'muse-spark-1.3-contributor') as any;
  expect(payload.tools[0].parameters).toEqual(normalized);
  const constrainedEnum = { anyOf: [{type:'string',enum:['x']},{type:'null'}] };
  expect(museToolParameters(constrainedEnum)).toEqual(constrainedEnum);
  expect(museToolParameters({ const: schema })).toEqual({ const: schema });
});

test('Muse deep-schema projection preserves the full contract as guidance and leaves local validation strict', async () => {
  const { TARGET_SELECTOR_DRAFT_PATCH_JSON_SCHEMA } = await import('../src/target-selector-compiler.js');
  const original = JSON.stringify(TARGET_SELECTOR_DRAFT_PATCH_JSON_SCHEMA);
  const projected = museToolParameters(TARGET_SELECTOR_DRAFT_PATCH_JSON_SCHEMA);
  const depth = (node: unknown): number => !node || typeof node !== 'object' ? 0
    : 1 + Math.max(0, ...Object.values(node).map(depth));
  expect(depth(projected)).toBeLessThanOrEqual(10);
  expect(JSON.stringify(projected)).toContain('Exact record contract (validated locally)');
  expect(JSON.stringify(TARGET_SELECTOR_DRAFT_PATCH_JSON_SCHEMA)).toBe(original);
  const validate = new Ajv({strict:false}).compile(TARGET_SELECTOR_DRAFT_PATCH_JSON_SCHEMA);
  expect(validate({draft:{items:[{key:'missing-required-fields'}]}})).toBe(false);
});
