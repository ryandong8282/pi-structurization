import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { Type } from 'typebox';
import { defineTool } from '@earendil-works/pi-coding-agent';
import { Ajv } from 'ajv';
import { ModelSourceHandles } from '../src/model-source-handles.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'pi-checkpoint-'));
  roots.push(root);
  return { root, codec: await ModelSourceHandles.open(root) };
}

test('short checkpoints transport exact saved hashes and keep the domain stale-draft check', async () => {
  const { root, codec } = await fixture();
  const first = 'a'.repeat(64), second = 'b'.repeat(64);
  let current = first;
  const execute = vi.fn(async (_id: string, args: any) => ({ content: [{ type: 'text' as const,
    text: JSON.stringify({ ok: args.draft_fingerprint === current, current_draft_fingerprint: current,
      received: args.draft_fingerprint }) }], details: args }));
  const original = defineTool({ name: 'commit_probe', label: 'Commit', description: 'Submit a saved draft',
    parameters: Type.Object({ draft_fingerprint: Type.String({ pattern: '^[a-f0-9]{64}$' }) }), execute });
  const [tool] = codec.wrapTools([original]);
  const encoded = await codec.encode({ draft_fingerprint: first, instruction: first }) as any;
  expect(encoded).toEqual({ draft_fingerprint: 'c1', instruction: first });
  const args = { draft_fingerprint: 'c1', source_handle_scope: codec.scope };
  expect(new Ajv({ strict: false }).compile(tool!.parameters)(args)).toBe(true);
  const call = async (value: any) => tool!.execute('submit', value, undefined as any, undefined as any, undefined as any);
  expect(JSON.parse((await call(args)).content[0].text!)).toMatchObject({ ok: true, current_draft_fingerprint: 'c1' });
  expect(execute.mock.calls[0]![1]).toEqual({ draft_fingerprint: first });
  current = second;
  const stale = JSON.parse((await call(args)).content[0].text!);
  expect(stale).toMatchObject({ ok: false, current_draft_fingerprint: 'c2', received: first });
  expect(JSON.parse((await call({ ...args, draft_fingerprint: 'c2' })).content[0].text!)).toMatchObject({ ok: true });
  expect(execute.mock.calls[2]![1]).toEqual({ draft_fingerprint: second });
  const reopened = await ModelSourceHandles.open(root);
  expect(await reopened.decodeArguments({ draft_fingerprint: 'c2', source_handle_scope: reopened.scope })).toEqual({ draft_fingerprint: second });
  expect(await reopened.decodeArguments({ draft_fingerprint: first })).toEqual({ draft_fingerprint: first });
});

test('unknown, cross-owner and wrong-role checkpoints never execute the mutation', async () => {
  const { codec } = await fixture();
  const other = await fixture();
  await codec.encode({ fingerprint: 'a'.repeat(64), evidence_id: 'evidence:source' });
  const execute = vi.fn(async () => ({ content: [] }));
  const [tool] = codec.wrapTools([defineTool({ name: 'seal_probe', label: 'Seal', description: 'Seal',
    parameters: Type.Object({ fingerprint: Type.String({ pattern: '^[a-f0-9]{64}$' }) }), execute })]);
  for (const params of [
    { fingerprint: 'c99', source_handle_scope: codec.scope },
    { fingerprint: 'c1', source_handle_scope: other.codec.scope },
    { fingerprint: 'e1', source_handle_scope: codec.scope },
    { fingerprint: 'c1' },
  ]) {
    const result = await tool!.execute('invalid', params, undefined as any, undefined as any, undefined as any);
    expect(JSON.parse(result.content[0].text!)).toMatchObject({ ok: false });
  }
  expect(execute).not.toHaveBeenCalled();
  await expect(codec.decodeArguments({ evidence_id: 'c1', source_handle_scope: codec.scope }))
    .rejects.toMatchObject({ code: 'source_handle_wrong_type' });
  expect(await codec.encode({ draft_fingerprint: 'description, not a hash', evidence_fingerprint: 'b'.repeat(64) }))
    .toEqual({ draft_fingerprint: 'description, not a hash', evidence_fingerprint: 'b'.repeat(64) });
});

test('recovery reads return distinct draft and validation checkpoints without executing a rejected commit', async () => {
  const { codec } = await fixture();
  const saved = 'd'.repeat(64), validated = 'f'.repeat(64);
  const mutate = vi.fn(async (_id: string, args: any) => ({ content: [{ type: 'text' as const, text: JSON.stringify({ ok: true }) }], details: args }));
  const read = vi.fn(async () => ({ content: [{ type: 'text' as const,
    text: JSON.stringify({ summary: { draft_fingerprint: saved, validated_fingerprint: validated } }) }] }));
  const [commit, readTool] = codec.wrapTools([
    defineTool({ name: 'commit_target_selector_draft', label: 'Commit', description: 'Commit draft', parameters: Type.Object({ draft_fingerprint: Type.String({ pattern: '^[a-f0-9]{64}$' }) }), execute: mutate }),
    defineTool({ name: 'read_target_selectors', label: 'Read', description: 'Read current checkpoints', parameters: Type.Object({}), execute: read }),
  ]);
  for (const args of [{ draft_fingerprint: 'c99', source_handle_scope: codec.scope }, { draft_fingerprint: 'c1', source_handle_scope: 'stale-scope' }]) {
    const rejected = JSON.parse((await commit!.execute('rejected', args, undefined as any, undefined as any, undefined as any)).content[0].text!);
    expect(rejected).toMatchObject({ ok: false, next_tool: 'read_target_selectors', tool_arguments: {}, retry_tool: 'commit_target_selector_draft' });
    if (args.source_handle_scope === 'stale-scope') {
      expect(rejected).toMatchObject({ error: 'source_handle_scope_mismatch', original_tool_executed: false,
        durable_mutation: false, budget_consumed: false, source_argument_count: 1, source_arguments_complete: true,
        required_action: 'reread_current_typed_handles_before_retry',
        source_arguments_to_reread: [expect.objectContaining({ argument_path: '/draft_fingerprint', expected_type: 'checkpoint' })] });
    }
    expect(mutate).not.toHaveBeenCalled();
  }
  const restored = JSON.parse((await readTool!.execute('read', {}, undefined as any, undefined as any, undefined as any)).content[0].text!);
  expect(restored).toMatchObject({ summary: { draft_fingerprint: 'c1', validated_fingerprint: 'c2' }, source_handle_scope: codec.scope });
  await commit!.execute('commit', { draft_fingerprint: restored.summary.draft_fingerprint, source_handle_scope: restored.source_handle_scope }, undefined as any, undefined as any, undefined as any);
  expect(mutate.mock.calls[0]![1]).toEqual({ draft_fingerprint: saved });
});
