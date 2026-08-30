import { z } from 'zod';

/**
 * Live coordinator input-schema validation.
 *
 * A dependency-free, best-effort JSON-Schema-subset validator applied to a *decoded* tool-argument
 * object against the tool's discovered/declared input schema. It runs at the canonical host execution
 * boundary — after strict decode and the known-tool check, before approval, preflight, and dispatch —
 * so a call whose arguments provably violate the tool's own advertised contract never reaches policy
 * or the provider dispatch leaf.
 *
 * Design invariants (all load-bearing):
 *
 * - **Fail closed on known violations, skip safely otherwise.** A malformed or unavailable schema, an
 *   unknown keyword, or an unknown dialect is *ignored* (never a false rejection). Only a keyword we
 *   understand, applied to a value that provably breaks it, produces a violation.
 * - **Never throw on arbitrary input.** Neither an adversarial schema nor an adversarial value may
 *   throw; the validator internally catches and degrades to a safe skip. It returns a result object.
 * - **Deterministic, bounded output.** Violations carry JSON-pointer-like paths, are produced in a
 *   stable document order, and are capped in count. Recursion is capped in depth. Beyond the caps the
 *   validator stops descending and marks the result truncated rather than growing without bound.
 * - **Zod owns the contract.** The result/violation shape is a Zod schema; the validator emits values
 *   that parse against it. The schema itself is validated structurally by hand (not by Zod) because a
 *   tool input schema is arbitrary discovered JSON, not a Zod type.
 */

/** Hard caps. Bounded so an adversarial schema/value can never produce unbounded work or output. */
export const MAX_VALIDATION_VIOLATIONS = 32;
export const MAX_VALIDATION_DEPTH = 12;

export const InputSchemaViolationSchema = z.object({
  /** JSON-pointer-like path to the offending value, e.g. `/items/0/name`. Root is the empty string. */
  path: z.string(),
  /** The schema keyword that failed, e.g. `type`, `required`, `enum`, `minLength`. */
  keyword: z.string(),
  /** Deterministic, human-readable explanation. No values are interpolated to keep output bounded. */
  message: z.string(),
});

export const InputSchemaValidationResultSchema = z.object({
  /** `true` when no known violation was found (including safe-skip cases). */
  ok: z.boolean(),
  /** Bounded, ordered field-level violations. Empty when `ok` is `true`. */
  violations: z.array(InputSchemaViolationSchema),
  /** `true` when a cap (count or depth) stopped the validator before it finished. */
  truncated: z.boolean(),
});

export type InputSchemaViolation = z.infer<typeof InputSchemaViolationSchema>;
export type InputSchemaValidationResult = z.infer<typeof InputSchemaValidationResultSchema>;

const OK_RESULT: InputSchemaValidationResult = { ok: true, violations: [], truncated: false };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Read a schema keyword via bracket access (the schema is an index-signature record). */
function kw(schema: Record<string, unknown>, name: string): unknown {
  return schema[name];
}

/** Append a child token to a JSON-pointer-like path, escaping `~` and `/` per RFC 6901. */
function childPath(parent: string, token: string | number): string {
  const raw = typeof token === 'number' ? String(token) : token;
  const escaped = raw.replace(/~/g, '~0').replace(/\//g, '~1');
  return `${parent}/${escaped}`;
}

/** Mutable collector that enforces the count cap deterministically. */
class ViolationSink {
  readonly violations: InputSchemaViolation[] = [];
  truncated = false;

  add(path: string, keyword: string, message: string): void {
    if (this.violations.length >= MAX_VALIDATION_VIOLATIONS) {
      this.truncated = true;
      return;
    }
    this.violations.push({ path, keyword, message });
  }

  get full(): boolean {
    return this.violations.length >= MAX_VALIDATION_VIOLATIONS;
  }
}

/** A boolean schema (`true`/`false`) is a valid JSON Schema: `true` accepts all, `false` accepts none. */
function isBooleanSchema(schema: unknown): schema is boolean {
  return typeof schema === 'boolean';
}

/** Only records and booleans are schemas we understand; anything else is skipped safely. */
function isUsableSchema(schema: unknown): schema is Record<string, unknown> | boolean {
  return isBooleanSchema(schema) || isRecord(schema);
}

function jsonTypeOf(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  const t = typeof value;
  if (t === 'number') {
    return Number.isInteger(value) ? 'integer' : 'number';
  }
  return t;
}

/** JSON-Schema `type` match, honoring `integer` ⊂ `number` and integer-valued numbers. */
function matchesType(value: unknown, type: string): boolean {
  const actual = jsonTypeOf(value);
  if (type === 'number') {
    return actual === 'number' || actual === 'integer';
  }
  if (type === 'integer') {
    return actual === 'integer';
  }
  return actual === type;
}

function checkType(value: unknown, type: unknown, path: string, sink: ViolationSink): void {
  if (typeof type === 'string') {
    if (!matchesType(value, type)) {
      sink.add(path, 'type', `Expected type '${type}'.`);
    }
    return;
  }
  if (Array.isArray(type)) {
    const candidates = type.filter((entry): entry is string => typeof entry === 'string');
    // Unknown/non-string members are ignored; an empty candidate set is an unusable constraint (skip).
    if (candidates.length === 0) {
      return;
    }
    if (!candidates.some(candidate => matchesType(value, candidate))) {
      sink.add(path, 'type', `Expected one of types: ${candidates.join(', ')}.`);
    }
  }
  // Any other `type` shape is an unknown dialect and is ignored.
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (left === right) {
    return true;
  }
  if (typeof left !== typeof right) {
    return false;
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, index) => deepEqual(item, right[index]));
  }
  if (isRecord(left) && isRecord(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) {
      return false;
    }
    return leftKeys.every(key => Object.prototype.hasOwnProperty.call(right, key) && deepEqual(left[key], right[key]));
  }
  return false;
}

function checkEnum(value: unknown, enumValues: unknown, path: string, sink: ViolationSink): void {
  if (!Array.isArray(enumValues) || enumValues.length === 0) {
    return;
  }
  if (!enumValues.some(candidate => deepEqual(value, candidate))) {
    sink.add(path, 'enum', 'Value is not one of the permitted enum values.');
  }
}

function checkConst(value: unknown, constValue: unknown, path: string, sink: ViolationSink): void {
  if (!deepEqual(value, constValue)) {
    sink.add(path, 'const', 'Value does not equal the required constant.');
  }
}

function checkString(value: string, schema: Record<string, unknown>, path: string, sink: ViolationSink): void {
  const minLength = kw(schema, 'minLength');
  const maxLength = kw(schema, 'maxLength');
  const pattern = kw(schema, 'pattern');
  if (typeof minLength === 'number' && value.length < minLength) {
    sink.add(path, 'minLength', `String is shorter than the minimum length ${String(minLength)}.`);
  }
  if (typeof maxLength === 'number' && value.length > maxLength) {
    sink.add(path, 'maxLength', `String is longer than the maximum length ${String(maxLength)}.`);
  }
  if (typeof pattern === 'string') {
    let regex: RegExp | undefined;
    try {
      regex = new RegExp(pattern);
    } catch {
      // An invalid pattern is a malformed constraint: skip it rather than reject the value.
      regex = undefined;
    }
    if (regex !== undefined && !regex.test(value)) {
      sink.add(path, 'pattern', 'String does not match the required pattern.');
    }
  }
}

function checkNumber(value: number, schema: Record<string, unknown>, path: string, sink: ViolationSink): void {
  const minimum = kw(schema, 'minimum');
  const maximum = kw(schema, 'maximum');
  const exclusiveMinimum = kw(schema, 'exclusiveMinimum');
  const exclusiveMaximum = kw(schema, 'exclusiveMaximum');
  if (typeof minimum === 'number' && value < minimum) {
    sink.add(path, 'minimum', `Number is less than the minimum ${String(minimum)}.`);
  }
  if (typeof maximum === 'number' && value > maximum) {
    sink.add(path, 'maximum', `Number is greater than the maximum ${String(maximum)}.`);
  }
  if (typeof exclusiveMinimum === 'number' && value <= exclusiveMinimum) {
    sink.add(
      path,
      'exclusiveMinimum',
      `Number is not strictly greater than the exclusive minimum ${String(exclusiveMinimum)}.`,
    );
  }
  if (typeof exclusiveMaximum === 'number' && value >= exclusiveMaximum) {
    sink.add(
      path,
      'exclusiveMaximum',
      `Number is not strictly less than the exclusive maximum ${String(exclusiveMaximum)}.`,
    );
  }
}

/** `nullable: true` (OpenAPI dialect) permits an explicit null irrespective of declared `type`. */
function isNullableAllowed(schema: Record<string, unknown>): boolean {
  return kw(schema, 'nullable') === true;
}

interface ValidateContext {
  depth: number;
  sink: ViolationSink;
}

function validateValue(value: unknown, schema: unknown, path: string, ctx: ValidateContext): void {
  if (ctx.sink.full) {
    ctx.sink.truncated = true;
    return;
  }
  if (!isUsableSchema(schema)) {
    // Malformed/unavailable schema (e.g. a string, number, or null in schema position): skip safely.
    return;
  }
  if (isBooleanSchema(schema)) {
    if (!schema) {
      ctx.sink.add(path, 'schema', 'A false boolean schema forbids any value at this path.');
    }
    return;
  }

  // A nullable schema short-circuits on an explicit null: no further keyword applies to it.
  if (value === null && isNullableAllowed(schema)) {
    return;
  }

  if ('type' in schema) {
    checkType(value, kw(schema, 'type'), path, ctx.sink);
  }
  if ('enum' in schema) {
    checkEnum(value, kw(schema, 'enum'), path, ctx.sink);
  }
  if ('const' in schema) {
    checkConst(value, kw(schema, 'const'), path, ctx.sink);
  }

  if (typeof value === 'string') {
    checkString(value, schema, path, ctx.sink);
  }
  if (typeof value === 'number') {
    checkNumber(value, schema, path, ctx.sink);
  }
  if (Array.isArray(value)) {
    validateArray(value, schema, path, ctx);
  }
  if (isRecord(value)) {
    validateObject(value, schema, path, ctx);
  }
}

function validateArray(value: unknown[], schema: Record<string, unknown>, path: string, ctx: ValidateContext): void {
  const minItems = kw(schema, 'minItems');
  const maxItems = kw(schema, 'maxItems');
  if (typeof minItems === 'number' && value.length < minItems) {
    ctx.sink.add(path, 'minItems', `Array has fewer than the minimum ${String(minItems)} items.`);
  }
  if (typeof maxItems === 'number' && value.length > maxItems) {
    ctx.sink.add(path, 'maxItems', `Array has more than the maximum ${String(maxItems)} items.`);
  }
  if (ctx.depth >= MAX_VALIDATION_DEPTH) {
    ctx.sink.truncated = true;
    return;
  }
  const items = kw(schema, 'items');
  if (Array.isArray(items)) {
    // Tuple form: validate positionally against the shortest of the two lengths.
    const bound = Math.min(items.length, value.length);
    for (let index = 0; index < bound; index++) {
      if (ctx.sink.full) {
        ctx.sink.truncated = true;
        return;
      }
      validateValue(value[index], items[index], childPath(path, index), { depth: ctx.depth + 1, sink: ctx.sink });
    }
    return;
  }
  if (isUsableSchema(items)) {
    for (let index = 0; index < value.length; index++) {
      if (ctx.sink.full) {
        ctx.sink.truncated = true;
        return;
      }
      validateValue(value[index], items, childPath(path, index), { depth: ctx.depth + 1, sink: ctx.sink });
    }
  }
}

function validateObject(
  value: Record<string, unknown>,
  schema: Record<string, unknown>,
  path: string,
  ctx: ValidateContext,
): void {
  const required = kw(schema, 'required');
  if (Array.isArray(required)) {
    for (const key of required) {
      if (ctx.sink.full) {
        ctx.sink.truncated = true;
        return;
      }
      if (typeof key === 'string' && !Object.prototype.hasOwnProperty.call(value, key)) {
        ctx.sink.add(childPath(path, key), 'required', `Missing required property '${key}'.`);
      }
    }
  }

  const propertiesValue = kw(schema, 'properties');
  const properties = isRecord(propertiesValue) ? propertiesValue : undefined;
  const additional = kw(schema, 'additionalProperties');

  if (ctx.depth >= MAX_VALIDATION_DEPTH) {
    ctx.sink.truncated = true;
    return;
  }

  // Deterministic key order: the declared property order first, then any extra keys in insertion order.
  const declaredKeys = properties ? Object.keys(properties) : [];
  const declaredSet = new Set(declaredKeys);
  const extraKeys = Object.keys(value).filter(key => !declaredSet.has(key));

  for (const key of declaredKeys) {
    if (ctx.sink.full) {
      ctx.sink.truncated = true;
      return;
    }
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      continue;
    }
    const propertySchema = properties?.[key];
    if (isUsableSchema(propertySchema)) {
      validateValue(value[key], propertySchema, childPath(path, key), { depth: ctx.depth + 1, sink: ctx.sink });
    }
  }

  if (additional === false) {
    for (const key of extraKeys) {
      if (ctx.sink.full) {
        ctx.sink.truncated = true;
        return;
      }
      ctx.sink.add(childPath(path, key), 'additionalProperties', `Property '${key}' is not permitted.`);
    }
    return;
  }
  if (isRecord(additional) || isBooleanSchema(additional)) {
    for (const key of extraKeys) {
      if (ctx.sink.full) {
        ctx.sink.truncated = true;
        return;
      }
      validateValue(value[key], additional, childPath(path, key), { depth: ctx.depth + 1, sink: ctx.sink });
    }
  }
}

/**
 * Validate a decoded value against a discovered/declared tool input schema.
 *
 * Returns a result that always parses against {@link InputSchemaValidationResultSchema}. A malformed
 * or unavailable schema, an unknown keyword, or an unknown dialect yields `ok: true` (safe skip). A
 * known keyword applied to a provably invalid value yields `ok: false` with bounded, ordered,
 * JSON-pointer-like violations. This function never throws for any schema/value input.
 */
export function validateAgainstInputSchema(value: unknown, schema: unknown): InputSchemaValidationResult {
  if (!isUsableSchema(schema)) {
    return OK_RESULT;
  }
  const sink = new ViolationSink();
  try {
    validateValue(value, schema, '', { depth: 0, sink });
  } catch {
    // Defense in depth: any unexpected internal error degrades to a safe skip rather than a throw.
    return OK_RESULT;
  }
  return {
    ok: sink.violations.length === 0,
    violations: sink.violations,
    truncated: sink.truncated,
  };
}
