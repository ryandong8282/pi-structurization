import { describe, expect, test } from 'vitest';
import { ToolRecordStreamGuard } from '../src/tool-record-stream.js';
import { TARGET_SELECTOR_TOOL_DRAFT_PATCH_JSON_SCHEMA } from '../src/target-selector-compiler.js';

describe('schema-bound streamed record types', () => {
  test.each([1, 7, 47])('accepts real SDK partial JSON snapshots and rejects an invalid record immediately (chunk=%s)', async chunkSize => {
    const { parseStreamingJson } = await import('@earendil-works/pi-ai/utils/json-parse');
    const valid = JSON.stringify({ draft: { items: [{ key: 'first', reason: 'quoted "text" and a newline\n', fields: {},
      criterion_span_ids: ['one', 'two'], table: { properties: { row_path_span_ids: [['row', 'column']] } } }, { key: 'next' }] } });
    const guard = new ToolRecordStreamGuard(TARGET_SELECTOR_TOOL_DRAFT_PATCH_JSON_SCHEMA);
    for (let end = chunkSize; end < valid.length; end += chunkSize) {
      expect(guard.inspect(parseStreamingJson(valid.slice(0, end))), valid.slice(0, end)).toBeUndefined();
    }
    expect(guard.inspect(parseStreamingJson(valid))).toBeUndefined();
    const invalid = '{"draft":{"items":[{"key":"first"},"arbitrary content';
    const fresh = new ToolRecordStreamGuard(TARGET_SELECTOR_TOOL_DRAFT_PATCH_JSON_SCHEMA);
    let detected: ReturnType<ToolRecordStreamGuard['inspect']>;
    for (let end = 1; end <= invalid.length; end += 1) {
      detected = fresh.inspect(parseStreamingJson(invalid.slice(0, end)));
      if (detected) break;
    }
    expect(detected).toMatchObject({ path: '/draft/items/1', expected: { json_type: 'object' }, actual: { json_type: 'string' } });
  });
  test('rejects the first string in an object collection without waiting for repetition or completion', () => {
    const guard = new ToolRecordStreamGuard(TARGET_SELECTOR_TOOL_DRAFT_PATCH_JSON_SCHEMA);
    expect(guard.inspect({ draft: { items: [{ key: 'first' }] } })).toBeUndefined();
    expect(guard.inspect({ draft: { items: [{ key: 'first' }, 'arbitrary unfinished text'] } })).toEqual({
      path: '/draft/items/1', actual: { json_type: 'string', length: 25 }, expected: { json_type: 'object' },
    });
  });
  test('allows incomplete records, long repeated strings and ordinary string arrays', () => {
    const guard = new ToolRecordStreamGuard(TARGET_SELECTOR_TOOL_DRAFT_PATCH_JSON_SCHEMA);
    const item = { key: 'first', reason: 'ordinary content '.repeat(10000), criterion_span_ids: ['same', 'same'], sampling: {} };
    expect(guard.inspect({ draft: { items: [{}] } })).toBeUndefined();
    expect(guard.inspect({ draft: { items: [item] } })).toBeUndefined();
    expect(guard.inspect({ draft: { items: [item, { key: 'second' }] } })).toBeUndefined();
  });
  test('uses arbitrary tool schemas, including nested record arrays and escaped keys', () => {
    const guard = new ToolRecordStreamGuard({ type: 'object', properties: { 'a/b': { type: 'array', items: {
      type: 'object', properties: { children: { type: 'array', items: { type: 'object' } } },
    } } } });
    expect(guard.inspect({ 'a/b': [{ children: ['wrong'] }] })?.path).toBe('/a~1b/0/children/0');
  });
  test('does not narrow unknown schemas, references, or unions which permit strings', () => {
    for (const schema of [{}, { $ref: '#/$defs/record' }, { anyOf: [{ type: 'object' }, { type: 'string' }] }]) {
      expect(new ToolRecordStreamGuard({ type: 'array', items: schema }).inspect(['valid for some branch'])).toBeUndefined();
    }
  });
  test('continues checking the newest member without rescanning a completed prefix', () => {
    const guard = new ToolRecordStreamGuard({ type: 'array', items: { type: 'object' } });
    const rows = Array.from({ length: 1000 }, (_, index) => ({ key: String(index) }));
    expect(guard.inspect(rows)).toBeUndefined();
    expect(guard.inspect([...rows, 'wrong'])?.path).toBe('/1000');
    expect(guard.inspect([])).toBeUndefined();
    expect(guard.inspect(['wrong'])?.path).toBe('/0');
  });
});
