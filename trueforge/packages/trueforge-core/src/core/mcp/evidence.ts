import { z } from '@hono/zod-openapi';
import { createHash } from 'node:crypto';
import { canonicalizeArguments } from './canonicalArguments';
import { MAX_VALIDATION_VIOLATIONS, validateAgainstInputSchema } from './inputSchemaValidator';

/**
 * Generic output-schema verification and typed evidence.
 *
 * The {@link VerificationCoordinator} is the single owner of the transition from a nominally
 * successful tool result to either (a) verified, bounded, typed {@link EvidenceRecord} objects or
 * (b) a validation failure that carries zero evidence. It is invoked at
 * {@link ToolExecutionCoordinator} finalization — after dispatch produced a result but before the
 * outcome is normalized — and it is driven entirely by *host-owned* capability metadata
 * ({@link ToolCapability.output_schema} and {@link ToolCapability.evidence_capabilities}). Server
 * prose is never treated as execution evidence.
 *
 * Design invariants (all load-bearing):
 *
 * - **Structured content is the only evidence channel.** When a capability declares a non-null
 *   `output_schema`, a nominally successful result must carry canonical MCP `structuredContent`
 *   (a JSON object). Prose text content, however confident, is never accepted as evidence: a
 *   missing/non-object `structuredContent` is a verification failure, not a silent pass.
 * - **Reuse the bounded JSON-Schema engine.** The declared `output_schema` is validated with the
 *   same dependency-free, bounded, non-throwing validator used for inputs
 *   ({@link validateAgainstInputSchema}), generalized here for output values. A malformed/unknown
 *   schema keyword is ignored (safe skip) exactly as on the input path; a *known* violation fails
 *   closed with bounded structured violations.
 * - **Evidence carries no raw values.** An {@link EvidenceRecord} contains only deterministic
 *   identifiers/digests, the declared evidence capability, the immutable invocation/attempt source
 *   identity, a schema digest and a result digest, and an `observed_at` timestamp. It never embeds
 *   raw output, raw arguments, or secrets.
 * - **No schema ⇒ no typed evidence.** A capability with a null `output_schema` stays
 *   backward-compatible: its outcome is unverified and yields *zero* evidence even if the capability
 *   also declares `evidence_capabilities`. Evidence capabilities alone never mint evidence.
 * - **Determinism.** The record id and result/schema digests are pure functions of the canonical
 *   serialization of their inputs, so the same structured output for the same attempt always
 *   produces the same record id and digests, surviving store round-trip and lifecycle replay.
 */

/** Contract version for a typed evidence record; lets a persisted record be re-validated post-change. */
export const EVIDENCE_RECORD_VERSION = 1 as const;

/** Immutable source identity of the attempt that produced an evidence record. No mutable fields. */
export const EvidenceSourceIdentitySchema = z
  .object({
    session_id: z.string().describe('Session containing the producing execution.'),
    turn_id: z.string().describe('Turn containing the producing execution.'),
    thread_id: z.string().describe('Thread that owns the producing model tool call.'),
    stable_tool_set_id: z.string().min(1).describe('Stable host tool-set or MCP server identity.'),
    tool_name: z.string().min(1).describe('Original tool name within the stable tool set.'),
    tool_call_id: z.string().describe('Tool call id assigned by the model or nested dispatcher.'),
    root_tool_call_id: z.string().describe('Root model tool call for this execution lineage.'),
    attempt_id: z.string().describe('Host-generated immutable execution attempt id.'),
  })
  .openapi('EvidenceSourceIdentity');

/**
 * A bounded, typed record of verified structured output. Deterministic and free of raw values: it
 * links a declared evidence capability to the immutable attempt source identity plus a schema digest
 * and result digest, so downstream consumers can reason about *what was verified* without ever
 * seeing the output itself.
 */
export const EvidenceRecordSchema = z
  .object({
    version: z.literal(EVIDENCE_RECORD_VERSION).describe('Evidence record contract version.'),
    id: z.string().length(64).describe('Deterministic SHA-256 id derived from source identity and digests.'),
    evidence_capability: z.string().min(1).describe('Host-declared evidence capability this record satisfies.'),
    source: EvidenceSourceIdentitySchema,
    schema_digest: z.string().length(64).describe('SHA-256 digest of the canonical declared output schema.'),
    result_digest: z.string().length(64).describe('SHA-256 digest of the canonical verified structured output.'),
    observed_at: z.string().describe('ISO 8601 timestamp when verification observed the output.'),
  })
  .openapi('EvidenceRecord');

export type EvidenceSourceIdentity = z.infer<typeof EvidenceSourceIdentitySchema>;
export type EvidenceRecord = z.infer<typeof EvidenceRecordSchema>;

/** Bounded structured error describing why output verification failed. Carries no raw output value. */
export const OutputVerificationErrorSchema = z
  .object({
    code: z
      .enum(['missing_structured_content', 'output_schema_validation_failed'])
      .describe('Deterministic failure code.'),
    message: z.string().describe('Deterministic, value-free explanation.'),
    violations: z
      .array(
        z.object({
          path: z.string(),
          keyword: z.string(),
          message: z.string(),
        }),
      )
      .describe('Bounded, ordered field-level violations. Empty for a missing-structured-content failure.'),
    truncated: z.boolean().describe('True when a cap stopped validation before it finished.'),
  })
  .openapi('OutputVerificationError');

export type OutputVerificationError = z.infer<typeof OutputVerificationErrorSchema>;

/** A verification pass either produces bounded typed evidence, or a bounded failure, or is skipped. */
export type VerificationResult =
  | { kind: 'verified'; evidence: readonly EvidenceRecord[] }
  | { kind: 'failed'; error: OutputVerificationError }
  | { kind: 'skipped' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** SHA-256 hex digest of the canonical (key-sorted) serialization of a JSON value. Locale-invariant. */
function digest(value: unknown): string {
  return createHash('sha256').update(canonicalizeArguments(value)).digest('hex');
}

/**
 * Deterministic evidence-record id. A pure function of the immutable source identity, the declared
 * evidence capability, and the schema/result digests — never of `observed_at` — so replay of the same
 * verified output for the same attempt reconstructs an identical id.
 */
function evidenceRecordId(input: {
  source: EvidenceSourceIdentity;
  evidenceCapability: string;
  schemaDigest: string;
  resultDigest: string;
}): string {
  return digest({
    version: EVIDENCE_RECORD_VERSION,
    source: input.source,
    evidence_capability: input.evidenceCapability,
    schema_digest: input.schemaDigest,
    result_digest: input.resultDigest,
  });
}

/**
 * Owns generic output verification and typed-evidence construction. Stateless and pure apart from the
 * caller-supplied clock, so it is safe to share a single instance across all executions.
 */
export class VerificationCoordinator {
  private readonly now: () => Date;

  constructor(options: { now?: () => Date } = {}) {
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Verify a nominally successful structured result against a declared output schema and, on success,
   * mint one bounded typed {@link EvidenceRecord} per declared evidence capability.
   *
   * Source identity is decoupled from the schema/structured-content gate on purpose. The
   * verification decision (schema present ⇒ structured content required and must validate) is a
   * property of the *result*, not of where the call was anchored, so it MUST run identically for
   * durable model tool calls and for identity-less local/nested/Code-Mode dispatch. Only the minting
   * of a persistable {@link EvidenceRecord} depends on a durable source: a record embeds the immutable
   * invocation/attempt identity, and fabricating one from absent identity is never acceptable.
   *
   * - `output_schema === null` ⇒ `{ kind: 'skipped' }` (backward-compatible; never yields evidence).
   * - Missing/non-object `structured_content` ⇒ `{ kind: 'failed' }` with `missing_structured_content`.
   *   This holds even when `source` is absent — a prose-only "success" can never pass.
   * - A known schema violation ⇒ `{ kind: 'failed' }` with bounded `violations`. Also independent of
   *   `source`.
   * - Valid structured output with an **absent** durable `source` ⇒ `{ kind: 'verified', evidence: [] }`.
   *   The result is verified but yields zero evidence because there is no identity to anchor a record
   *   to; identity is never fabricated.
   * - Valid structured output with a **present** durable `source` ⇒ `{ kind: 'verified', evidence }`
   *   with one bounded typed record per declared evidence capability (empty when none are declared).
   *
   * The `structured_content` value is only ever hashed; it is never copied into the returned records.
   */
  verify(input: {
    output_schema: unknown;
    evidence_capabilities: readonly string[];
    structured_content: unknown;
    source: EvidenceSourceIdentity | null | undefined;
  }): VerificationResult {
    if (input.output_schema === null || input.output_schema === undefined) {
      return { kind: 'skipped' };
    }

    if (!isRecord(input.structured_content)) {
      return {
        kind: 'failed',
        error: {
          code: 'missing_structured_content',
          message:
            'Tool declares an output schema but the successful result carried no canonical structured content. ' +
            'Prose text is not accepted as execution evidence.',
          violations: [],
          truncated: false,
        },
      };
    }

    const validation = validateAgainstInputSchema(input.structured_content, input.output_schema);
    if (!validation.ok) {
      return {
        kind: 'failed',
        error: {
          code: 'output_schema_validation_failed',
          message: 'Structured tool output does not satisfy the declared output schema.',
          violations: validation.violations.slice(0, MAX_VALIDATION_VIOLATIONS),
          truncated: validation.truncated,
        },
      };
    }

    // Schema/structured gate passed. Durable identity is required to mint an EvidenceRecord: without
    // it the result is verified but evidence-free. Never fabricate a record from absent identity.
    if (input.source === null || input.source === undefined) {
      return { kind: 'verified', evidence: [] };
    }
    const source = input.source;

    const schemaDigest = digest(input.output_schema);
    const resultDigest = digest(input.structured_content);
    const observedAt = this.now().toISOString();

    // Deterministic, de-duplicated capability order: declared order, first occurrence wins.
    const seen = new Set<string>();
    const evidence: EvidenceRecord[] = [];
    for (const capability of input.evidence_capabilities) {
      if (typeof capability !== 'string' || capability.length === 0 || seen.has(capability)) {
        continue;
      }
      seen.add(capability);
      evidence.push(
        EvidenceRecordSchema.parse({
          version: EVIDENCE_RECORD_VERSION,
          id: evidenceRecordId({
            source,
            evidenceCapability: capability,
            schemaDigest,
            resultDigest,
          }),
          evidence_capability: capability,
          source,
          schema_digest: schemaDigest,
          result_digest: resultDigest,
          observed_at: observedAt,
        }),
      );
    }

    return { kind: 'verified', evidence };
  }
}

export const DEFAULT_VERIFICATION_COORDINATOR = new VerificationCoordinator();
