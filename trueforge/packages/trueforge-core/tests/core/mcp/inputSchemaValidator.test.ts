import {
  InputSchemaValidationResultSchema,
  MAX_VALIDATION_DEPTH,
  MAX_VALIDATION_VIOLATIONS,
  validateAgainstInputSchema,
} from '../../../src/core/mcp/inputSchemaValidator';

function paths(result: ReturnType<typeof validateAgainstInputSchema>): string[] {
  return result.violations.map(v => v.path);
}

function keywords(result: ReturnType<typeof validateAgainstInputSchema>): string[] {
  return result.violations.map(v => v.keyword);
}

describe('validateAgainstInputSchema', () => {
  it('always returns a value that parses against the Zod result contract', () => {
    const result = validateAgainstInputSchema({ a: 1 }, { type: 'object', properties: { a: { type: 'string' } } });
    expect(() => InputSchemaValidationResultSchema.parse(result)).not.toThrow();
  });

  describe('malformed / unavailable schemas skip safely', () => {
    it.each([undefined, null, 42, 'string', [], NaN])('skips non-usable schema %p', schema => {
      const result = validateAgainstInputSchema({ anything: true }, schema);
      expect(result).toEqual({ ok: true, violations: [], truncated: false });
    });

    it('skips a malformed regex pattern rather than rejecting the value', () => {
      const result = validateAgainstInputSchema('abc', { type: 'string', pattern: '(' });
      expect(result.ok).toBe(true);
    });

    it('skips an unusable empty type-array constraint', () => {
      const result = validateAgainstInputSchema(1, { type: [] });
      expect(result.ok).toBe(true);
    });
  });

  describe('unknown keywords and dialects are ignored', () => {
    it('ignores unknown keywords', () => {
      const result = validateAgainstInputSchema(
        { a: 1 },
        { type: 'object', properties: { a: { type: 'integer' } }, $comment: 'x', someUnknownKeyword: 5, allOf: [] },
      );
      expect(result.ok).toBe(true);
    });

    it('ignores an unknown type dialect shape', () => {
      const result = validateAgainstInputSchema(5, { type: { nested: 'thing' } });
      expect(result.ok).toBe(true);
    });
  });

  describe('type (including type arrays)', () => {
    it('flags a scalar type mismatch', () => {
      const result = validateAgainstInputSchema('x', { type: 'number' });
      expect(result.ok).toBe(false);
      expect(keywords(result)).toEqual(['type']);
    });

    it('treats integer as a subset of number', () => {
      expect(validateAgainstInputSchema(3, { type: 'number' }).ok).toBe(true);
      expect(validateAgainstInputSchema(3.5, { type: 'integer' }).ok).toBe(false);
    });

    it('accepts a value matching any member of a type array', () => {
      expect(validateAgainstInputSchema('x', { type: ['string', 'number'] }).ok).toBe(true);
      expect(validateAgainstInputSchema(true, { type: ['string', 'number'] }).ok).toBe(false);
    });
  });

  describe('required and properties (nested paths)', () => {
    it('reports missing required properties with JSON-pointer-like paths', () => {
      const result = validateAgainstInputSchema(
        {},
        { type: 'object', required: ['a', 'b'], properties: { a: { type: 'string' }, b: { type: 'string' } } },
      );
      expect(result.ok).toBe(false);
      expect(paths(result)).toEqual(['/a', '/b']);
      expect(keywords(result)).toEqual(['required', 'required']);
    });

    it('descends into nested object and array properties producing pointer paths', () => {
      const schema = {
        type: 'object',
        properties: {
          user: {
            type: 'object',
            properties: {
              tags: { type: 'array', items: { type: 'string' } },
            },
          },
        },
      };
      const result = validateAgainstInputSchema({ user: { tags: ['ok', 5] } }, schema);
      expect(result.ok).toBe(false);
      expect(paths(result)).toEqual(['/user/tags/1']);
      expect(keywords(result)).toEqual(['type']);
    });

    it('escapes ~ and / in property names per RFC 6901', () => {
      const schema = { type: 'object', properties: { 'a/b~c': { type: 'number' } } };
      const result = validateAgainstInputSchema({ 'a/b~c': 'no' }, schema);
      expect(paths(result)).toEqual(['/a~1b~0c']);
    });
  });

  describe('additionalProperties', () => {
    it('rejects extra keys when additionalProperties is false', () => {
      const schema = { type: 'object', properties: { a: {} }, additionalProperties: false };
      const result = validateAgainstInputSchema({ a: 1, b: 2, c: 3 }, schema);
      expect(result.ok).toBe(false);
      expect(paths(result)).toEqual(['/b', '/c']);
      expect(keywords(result)).toEqual(['additionalProperties', 'additionalProperties']);
    });

    it('validates extra keys against an additionalProperties schema', () => {
      const schema = { type: 'object', properties: {}, additionalProperties: { type: 'number' } };
      const result = validateAgainstInputSchema({ x: 1, y: 'no' }, schema);
      expect(paths(result)).toEqual(['/y']);
      expect(keywords(result)).toEqual(['type']);
    });
  });

  describe('enum and const', () => {
    it('flags a value outside the enum', () => {
      expect(validateAgainstInputSchema('c', { enum: ['a', 'b'] }).ok).toBe(false);
      expect(validateAgainstInputSchema('a', { enum: ['a', 'b'] }).ok).toBe(true);
    });

    it('supports structural enum members', () => {
      const schema = { enum: [{ a: 1 }, { b: 2 }] };
      expect(validateAgainstInputSchema({ a: 1 }, schema).ok).toBe(true);
      expect(validateAgainstInputSchema({ a: 2 }, schema).ok).toBe(false);
    });

    it('flags a const mismatch', () => {
      expect(validateAgainstInputSchema(5, { const: 42 }).ok).toBe(false);
      expect(validateAgainstInputSchema(42, { const: 42 }).ok).toBe(true);
    });
  });

  describe('arrays', () => {
    it('enforces minItems and maxItems', () => {
      expect(validateAgainstInputSchema([1], { type: 'array', minItems: 2 }).ok).toBe(false);
      expect(validateAgainstInputSchema([1, 2, 3], { type: 'array', maxItems: 2 }).ok).toBe(false);
      expect(validateAgainstInputSchema([1, 2], { type: 'array', minItems: 1, maxItems: 2 }).ok).toBe(true);
    });

    it('validates tuple-form items positionally', () => {
      const schema = { type: 'array', items: [{ type: 'string' }, { type: 'number' }] };
      const result = validateAgainstInputSchema(['ok', 'bad'], schema);
      expect(paths(result)).toEqual(['/1']);
    });
  });

  describe('strings', () => {
    it('enforces minLength, maxLength and pattern', () => {
      expect(validateAgainstInputSchema('a', { type: 'string', minLength: 2 }).ok).toBe(false);
      expect(validateAgainstInputSchema('abcd', { type: 'string', maxLength: 3 }).ok).toBe(false);
      expect(validateAgainstInputSchema('abc', { type: 'string', pattern: '^[0-9]+$' }).ok).toBe(false);
      expect(validateAgainstInputSchema('123', { type: 'string', pattern: '^[0-9]+$' }).ok).toBe(true);
    });
  });

  describe('numeric bounds', () => {
    it('enforces minimum, maximum and exclusive bounds', () => {
      expect(validateAgainstInputSchema(1, { type: 'number', minimum: 2 }).ok).toBe(false);
      expect(validateAgainstInputSchema(3, { type: 'number', maximum: 2 }).ok).toBe(false);
      expect(validateAgainstInputSchema(2, { type: 'number', exclusiveMinimum: 2 }).ok).toBe(false);
      expect(validateAgainstInputSchema(2, { type: 'number', exclusiveMaximum: 2 }).ok).toBe(false);
      expect(validateAgainstInputSchema(3, { type: 'number', exclusiveMinimum: 2, exclusiveMaximum: 4 }).ok).toBe(true);
    });
  });

  describe('nullable', () => {
    it('permits explicit null when nullable is true regardless of declared type', () => {
      expect(validateAgainstInputSchema(null, { type: 'string', nullable: true }).ok).toBe(true);
      expect(validateAgainstInputSchema(null, { type: 'string' }).ok).toBe(false);
    });
  });

  describe('boolean schemas', () => {
    it('accepts everything under a true schema and rejects everything under a false schema', () => {
      expect(validateAgainstInputSchema({ a: 1 }, true).ok).toBe(true);
      const result = validateAgainstInputSchema({ a: 1 }, false);
      expect(result.ok).toBe(false);
      expect(keywords(result)).toEqual(['schema']);
    });

    it('rejects a property whose schema is the false boolean', () => {
      const schema = { type: 'object', properties: { forbidden: false } };
      const result = validateAgainstInputSchema({ forbidden: 1 }, schema);
      expect(paths(result)).toEqual(['/forbidden']);
      expect(keywords(result)).toEqual(['schema']);
    });
  });

  describe('caps and depth bounds', () => {
    it('caps the number of violations and marks the result truncated', () => {
      const properties: Record<string, unknown> = {};
      const value: Record<string, unknown> = {};
      for (let i = 0; i < MAX_VALIDATION_VIOLATIONS + 20; i++) {
        properties[`p${String(i)}`] = { type: 'string' };
        value[`p${String(i)}`] = i; // every one is a type violation
      }
      const result = validateAgainstInputSchema(value, { type: 'object', properties });
      expect(result.ok).toBe(false);
      expect(result.violations.length).toBe(MAX_VALIDATION_VIOLATIONS);
      expect(result.truncated).toBe(true);
    });

    it('stops descending beyond the maximum depth and marks truncated', () => {
      // Build a schema/value nested deeper than the depth cap. The deepest violation is unreachable.
      let schema: Record<string, unknown> = { type: 'string' };
      let value: unknown = 123; // a violation only at the very bottom
      for (let i = 0; i < MAX_VALIDATION_DEPTH + 3; i++) {
        schema = { type: 'object', properties: { child: schema } };
        value = { child: value };
      }
      const result = validateAgainstInputSchema(value, schema);
      // The bottom type mismatch is deeper than the cap, so it is never reported, but truncation is flagged.
      expect(result.violations.length).toBe(0);
      expect(result.truncated).toBe(true);
    });
  });

  describe('never throws on adversarial input', () => {
    it('handles a self-referential value without throwing', () => {
      const cyclic: Record<string, unknown> = {};
      cyclic['self'] = cyclic;
      const schema = { type: 'object', properties: { self: { type: 'string' } } };
      expect(() => validateAgainstInputSchema(cyclic, schema)).not.toThrow();
    });
  });
});
