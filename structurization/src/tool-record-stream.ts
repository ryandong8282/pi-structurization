type Schema = Record<string, unknown>;
const object = (value: unknown): Schema => value !== null && typeof value === 'object' && !Array.isArray(value)
  ? value as Schema : {};

function alternatives(schema: unknown): Schema[] {
  const value = object(schema);
  const union = value.anyOf ?? value.oneOf;
  return Array.isArray(union) ? union.flatMap(alternatives) : [value];
}

export interface StreamRecordTypeIssue {
  path: string;
  actual: { json_type: 'string'; length: number };
  expected: { json_type: 'object' };
}

/** Only reject an irreversible JSON type mismatch, never incomplete required fields
 * or semantic values. The SDK's partial argument snapshot can contain unfinished
 * strings, but a string member cannot later turn into an object member.
 */
export class ToolRecordStreamGuard {
  private readonly arrayLengths = new Map<string, number>();

  constructor(private readonly parameters: unknown) {}

  inspect(value: unknown): StreamRecordTypeIssue | undefined {
    return this.visit(value, alternatives(this.parameters), '');
  }

  private visit(value: unknown, schemas: Schema[], path: string): StreamRecordTypeIssue | undefined {
    if (value === null || typeof value !== 'object') return undefined;
    const type = Array.isArray(value) ? 'array' : 'object';
    const matching = schemas.filter(schema => schema.type === undefined || schema.type === type);
    // Unknown/ref/conditional schema branches must remain permissive here.
    if (!matching.length || matching.some(schema => schema.$ref || schema.allOf || schema.if)) return undefined;
    if (Array.isArray(value)) {
      const items = matching.flatMap(schema => alternatives(schema.items));
      const objectOnly = items.length > 0 && items.every(schema => schema.type === 'object');
      const previous = this.arrayLengths.get(path) ?? 0;
      // Streaming JSON only appends members; revisit the last unfinished member.
      // Do not repeatedly scan the growing prefix or retain argument text.
      const start = value.length < previous ? 0 : Math.max(0, previous - 1);
      this.arrayLengths.set(path, value.length);
      for (let index = start; index < value.length; index += 1) {
        const member = value[index];
        const memberPath = `${path}/${index}`;
        if (objectOnly && typeof member === 'string') {
          return { path: memberPath, actual: { json_type: 'string', length: member.length }, expected: { json_type: 'object' } };
        }
        const nested = this.visit(member, items, memberPath);
        if (nested) return nested;
      }
      return undefined;
    }
    for (const [key, child] of Object.entries(value)) {
      const properties = matching.flatMap(schema => alternatives(object(schema.properties)[key]));
      const escapedKey = key.replace(/~/g, '~0').replace(/\//g, '~1');
      const nested = this.visit(child, properties, `${path}/${escapedKey}`);
      if (nested) return nested;
    }
    return undefined;
  }
}
