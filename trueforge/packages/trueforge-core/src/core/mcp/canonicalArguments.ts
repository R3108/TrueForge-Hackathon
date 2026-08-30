import { createHash } from 'node:crypto';

/**
 * Single shared owner of canonical argument serialization and fingerprinting.
 *
 * Both the tool-execution lifecycle (prepared/started/completed attempt events) and the durable
 * approval binding fingerprint decoded tool arguments through this module so a decode + hash never
 * drifts between the two boundaries. Any change to the canonical form is felt identically by both
 * the recorded lifecycle fingerprint and the approval binding fingerprint, which is what lets the
 * coordinator compare a persisted allow binding against a freshly decoded call by value.
 */

export interface DecodedArguments {
  ok: true;
  value: Record<string, unknown>;
}

export interface DecodeFailure {
  ok: false;
  reason: string;
}

export type DecodeArgumentsResult = DecodedArguments | DecodeFailure;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Deterministic JSON serialization: object keys sorted, arrays preserved in order. Used only as the
 * hash pre-image — never as a wire format.
 *
 * Keys are ordered by UTF-16 code unit (the default `Array.prototype.sort` comparator on strings),
 * not by locale. A locale-aware comparator (`localeCompare`) can order the same two keys differently
 * across ICU versions and runtime locales, which would make the fingerprint environment-dependent and
 * break cross-process/replay binding comparison. Code-unit ordering is total and locale-invariant.
 */
export function canonicalizeArguments(value: unknown): string {
  // `JSON.stringify(undefined)` is `undefined` (not a string), which would be
  // rejected by `Hash.update` below; a missing argument value must still
  // produce a deterministic fingerprint so failed decodes stay comparable.
  if (value === undefined) {
    return 'undefined';
  }
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map(item => canonicalizeArguments(item)).join(',')}]`;
  }
  const entries = Object.entries(value).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalizeArguments(item)}`).join(',')}}`;
}

/** SHA-256 hex fingerprint of the canonical serialization. Stable across key ordering and encodings. */
export function fingerprintArguments(value: unknown): string {
  return createHash('sha256').update(canonicalizeArguments(value)).digest('hex');
}

/**
 * Strictly decode raw model tool arguments to a JSON object. A JSON string is parsed; a plain
 * object is accepted as-is; anything else fails closed with a caller-surfaceable reason.
 */
export function decodeArguments(raw: unknown): DecodeArgumentsResult {
  let decoded: unknown = raw;
  if (typeof raw === 'string') {
    if (!raw.trim()) {
      return { ok: false, reason: 'Tool arguments must be a non-empty JSON object.' };
    }
    try {
      decoded = JSON.parse(raw);
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'invalid JSON';
      return { ok: false, reason: `Tool arguments are not valid JSON: ${detail}` };
    }
  }
  if (!isRecord(decoded)) {
    return { ok: false, reason: 'Tool arguments must decode to a JSON object.' };
  }
  return { ok: true, value: decoded };
}

/**
 * Canonical decoded-argument fingerprint. Decodes strictly, then fingerprints the decoded object on
 * success or the raw value on failure — matching the lifecycle preparation fingerprint exactly so a
 * malformed call still produces a stable, comparable fingerprint.
 */
export function canonicalArgumentFingerprint(raw: unknown): string {
  const decoded = decodeArguments(raw);
  return fingerprintArguments(decoded.ok ? decoded.value : raw);
}
