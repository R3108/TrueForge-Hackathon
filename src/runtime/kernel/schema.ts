/**
 * Shared Zod primitives for the kernel's runtime-bound contracts.
 *
 * Every externally persisted or runtime-bound contract in the kernel is owned
 * by a Zod schema in its own module; this module supplies the bounded string
 * and array primitives those schemas compose from so that bounds are consistent
 * and centrally auditable. All object schemas are strict (unknown keys are
 * rejected) so that malformed or adversarial payloads fail closed at the
 * admission, replay, delegation, and verification boundaries.
 *
 * Types are always inferred from schemas with `z.infer`; there are no
 * handwritten duplicate interfaces for schema-owned shapes.
 */

import { z } from 'zod';

/** Central, auditable bounds. Generous enough for real briefs, hostile-input safe. */
export const LIMITS: {
  readonly id: number;
  readonly shortText: number;
  readonly text: number;
  readonly objective: number;
  readonly path: number;
  readonly command: number;
  readonly policyVersion: number;
  readonly smallArray: number;
  readonly mediumArray: number;
  readonly largeArray: number;
} = {
  id: 128,
  shortText: 512,
  text: 2000,
  objective: 500,
  path: 1024,
  command: 4096,
  policyVersion: 128,
  smallArray: 256,
  mediumArray: 1024,
  largeArray: 4096,
};

/** A bounded, non-empty identifier string. */
export const idString = z.string().min(1).max(LIMITS.id);

/** A bounded short free-text string (constraint/criterion text, summaries). */
export const shortText = z.string().max(LIMITS.shortText);

/** A bounded medium free-text string (descriptions, approach summaries). */
export const text = z.string().max(LIMITS.text);

/** A bounded objective line. */
export const objectiveText = z.string().max(LIMITS.objective);

/** A bounded resource/path/value string. */
export const pathString = z.string().max(LIMITS.path);

/** A bounded policy-version token. */
export const policyVersionString = z.string().max(LIMITS.policyVersion);

/** A bounded array of the given element schema. */
export function boundedArray<T extends z.ZodTypeAny>(
  element: T,
  max: number = LIMITS.smallArray,
): z.ZodArray<T> {
  return z.array(element).max(max);
}

/** A bounded array of bounded short-text strings. */
export const shortTextArray = boundedArray(shortText, LIMITS.smallArray);

/** A finite integer with an inclusive lower bound (defaults to 0). */
export function boundedInt(min = 0): z.ZodNumber {
  return z.number().int().min(min);
}

/**
 * An ISO-8601 datetime string, allowing an explicit timezone offset (so real
 * event timestamps that carry `+05:30` etc. validate) as well as `Z`.
 */
export const isoDateTime = z.iso.datetime({ offset: true });

