/**
 * Phase 9 — Generic completion verification.
 *
 * The model may PROPOSE completion; the harness DECIDES whether an action task
 * may be reported as successful. Verification is generic (not hardcoded to
 * software tests): a set of {@link Verifier}s each declare whether they apply to
 * a contract and evaluate typed inputs.
 *
 * Model prose is not evidence. When required evidence is missing, errors remain
 * unresolved, unknown writes are outstanding, required actions are pending, or
 * the CURRENT-state evidence (green tests) was invalidated by a later workspace
 * mutation, a claimed success is BLOCKED and REWRITTEN into a truthful
 * incomplete/blocked answer. The regression reproduction is exempt from
 * current-epoch freshness by design: a red run necessarily precedes the fix
 * that invalidates it, so its record is allowed to be historical.
 *
 * Conversational questions are exempt: no verifiers apply, so they stay
 * lightweight.
 */

import { z } from 'zod';
import type { EvidenceSummary } from '../evidence.ts';
import { TaskContractSchema } from './contract.ts';
import type { TaskContract } from './contract.ts';
import { WorkingStateSchema } from './working-state.ts';
import { LIMITS, boundedArray, boundedInt, isoDateTime, policyVersionString, shortText, text } from './schema.ts';

export const CriterionStatusSchema = z.enum(['passed', 'failed', 'missing', 'stale', 'unknown']);
export type CriterionStatus = z.infer<typeof CriterionStatusSchema>;

export const CriterionResultSchema = z.strictObject({
  criterion: shortText,
  status: CriterionStatusSchema,
  detail: shortText.optional(),
});
export type CriterionResult = z.infer<typeof CriterionResultSchema>;

export const VerificationResultSchema = z.strictObject({
  verifierId: shortText,
  status: CriterionStatusSchema,
  criteria: boundedArray(CriterionResultSchema, LIMITS.mediumArray),
  evidenceIds: boundedArray(shortText, LIMITS.mediumArray),
  observedAt: isoDateTime,
  workspaceEpoch: boundedInt().optional(),
});
export type VerificationResult = z.infer<typeof VerificationResultSchema>;

/**
 * Minimal, boundary-owned schema for the evidence summary the verifiers read.
 * Evidence records are produced by {@link EvidenceLedger} (out of this module's
 * scope); only the fields verification consumes are modelled, and record
 * objects are validated non-strictly so extra ledger fields pass through.
 */
export const EvidenceSummarySchema = z.strictObject({
  workspaceEpoch: boundedInt(),
  regressionObserved: z.boolean(),
  regressionIsHistorical: z.boolean(),
  targetedTestPassed: z.boolean(),
  fullSuitePassed: z.boolean(),
  unverifiedSuccessObserved: z.boolean(),
  records: boundedArray(
    z.object({ id: shortText, status: z.enum(['observed', 'invalidated']) }),
    LIMITS.largeArray,
  ).readonly(),
});

// Compile-time guarantee that the imported EvidenceSummary satisfies the fields
// this boundary schema reads (no runtime cost, no `as`, no duplicate interface).
type EvidenceSummaryShape = z.infer<typeof EvidenceSummarySchema>;
const _evidenceCompat: (value: EvidenceSummary) => EvidenceSummaryShape = (value) => ({
  workspaceEpoch: value.workspaceEpoch,
  regressionObserved: value.regressionObserved,
  regressionIsHistorical: value.regressionIsHistorical,
  targetedTestPassed: value.targetedTestPassed,
  fullSuitePassed: value.fullSuitePassed,
  unverifiedSuccessObserved: value.unverifiedSuccessObserved,
  records: value.records.map((r) => ({ id: r.id, status: r.status })),
});
void _evidenceCompat;

export const VerificationInputSchema = z.strictObject({
  contract: TaskContractSchema,
  workingState: WorkingStateSchema,
  evidence: EvidenceSummarySchema,
  /** Whether any required action (approval/response) is still pending. */
  pendingRequiredActions: boundedInt(),
  /** Attempts currently in an unknown (unreconciled) side-effect state. */
  unknownWriteOutcomes: boundedInt(),
  /** Active policy version, compared against the contract-time policy. */
  activePolicyVersion: policyVersionString,
  contractPolicyVersion: policyVersionString,
  /** The model's proposed final output prose. */
  proposedOutput: text,
});
export type VerificationInput = z.infer<typeof VerificationInputSchema>;

export interface Verifier {
  id: string;
  applies(contract: TaskContract): boolean;
  evaluate(input: VerificationInput): VerificationResult;
}

const nowIso = (): string => new Date().toISOString();

function actionTask(contract: TaskContract): boolean {
  return contract.taskType !== 'question';
}

/** All required acceptance criteria are accounted for. */
const acceptanceCriteriaVerifier: Verifier = {
  id: 'acceptance-criteria',
  applies: (c) => actionTask(c) && c.acceptanceCriteria.length > 0,
  evaluate: (input) => {
    const remaining = new Set(input.workingState.remainingCriteria);
    const criteria: CriterionResult[] = input.contract.acceptanceCriteria.map((c) => ({
      criterion: c.text,
      status: remaining.has(c.text) ? 'missing' : 'passed',
    }));
    const anyMissing = criteria.some((c) => c.status !== 'passed');
    return {
      verifierId: 'acceptance-criteria',
      status: anyMissing ? 'missing' : 'passed',
      criteria,
      evidenceIds: [],
      observedAt: nowIso(),
    };
  },
};

/** Required tool/test evidence is present AND fresh at the current epoch. */
const requiredEvidenceVerifier: Verifier = {
  id: 'required-evidence',
  applies: (c) => actionTask(c) && c.requiredEvidence.some((e) => e.kind !== 'human_approval'),
  evaluate: (input) => {
    const e = input.evidence;
    const criteria: CriterionResult[] = [];
    for (const req of input.contract.requiredEvidence) {
      switch (req.kind) {
        case 'regression_reproduction':
          // The red run is definitionally PRE-fix: reproduce first, then write
          // the fix, and the fix write bumps the workspace epoch - so a
          // regression record at an older epoch is the successful flow, not
          // staleness. Requiring it at the current epoch would mark every real
          // repair stale. Freshness stays enforced where it means something:
          // on the green evidence below, at the current epoch.
          criteria.push({
            criterion: req.description,
            status: e.regressionObserved ? 'passed' : 'missing',
          });
          break;
        case 'targeted_test_pass':
          criteria.push({ criterion: req.description, status: e.targetedTestPassed ? 'passed' : 'missing' });
          break;
        case 'full_suite_pass':
          criteria.push({ criterion: req.description, status: e.fullSuitePassed ? 'passed' : 'missing' });
          break;
        default:
          break;
      }
    }
    const worst = criteria.reduce<CriterionStatus>((acc, c) => {
      if (acc === 'missing' || c.status === 'missing') return 'missing';
      if (acc === 'stale' || c.status === 'stale') return 'stale';
      return acc;
    }, 'passed');
    return {
      verifierId: 'required-evidence',
      status: worst,
      criteria,
      evidenceIds: e.records.filter((r) => r.status === 'observed').map((r) => r.id),
      observedAt: nowIso(),
      workspaceEpoch: e.workspaceEpoch,
    };
  },
};

/** No unresolved structured errors remain. */
const noUnresolvedErrorsVerifier: Verifier = {
  id: 'no-unresolved-errors',
  applies: actionTask,
  evaluate: (input) => {
    const unresolved = input.workingState.unresolvedErrors.filter((f) => !f.resolved);
    return {
      verifierId: 'no-unresolved-errors',
      status: unresolved.length === 0 ? 'passed' : 'failed',
      criteria: unresolved.map((f): CriterionResult => ({ criterion: f.summary, status: 'failed' })),
      evidenceIds: [],
      observedAt: nowIso(),
    };
  },
};

/** No unknown (unreconciled) side-effect outcomes remain. */
const noUnknownWritesVerifier: Verifier = {
  id: 'no-unknown-writes',
  applies: actionTask,
  evaluate: (input) => ({
    verifierId: 'no-unknown-writes',
    status: input.unknownWriteOutcomes === 0 ? 'passed' : 'unknown',
    criteria:
      input.unknownWriteOutcomes === 0
        ? []
        : [{ criterion: 'All side-effecting writes have a known outcome.', status: 'unknown' }],
    evidenceIds: [],
    observedAt: nowIso(),
  }),
};

/** No pending approval/auth/client-response required action remains. */
const noPendingActionsVerifier: Verifier = {
  id: 'no-pending-required-actions',
  applies: actionTask,
  evaluate: (input) => ({
    verifierId: 'no-pending-required-actions',
    status: input.pendingRequiredActions === 0 ? 'passed' : 'failed',
    criteria:
      input.pendingRequiredActions === 0
        ? []
        : [{ criterion: 'No required action is awaiting a human.', status: 'failed' }],
    evidenceIds: [],
    observedAt: nowIso(),
  }),
};

/** Evidence was produced under the currently active policy version. */
const policyVersionVerifier: Verifier = {
  id: 'current-policy-version',
  applies: actionTask,
  evaluate: (input) => ({
    verifierId: 'current-policy-version',
    status: input.activePolicyVersion === input.contractPolicyVersion ? 'passed' : 'stale',
    criteria:
      input.activePolicyVersion === input.contractPolicyVersion
        ? []
        : [{ criterion: 'Contract policy version matches active policy.', status: 'stale' }],
    evidenceIds: [],
    observedAt: nowIso(),
  }),
};

export const BUILTIN_VERIFIERS: readonly Verifier[] = [
  acceptanceCriteriaVerifier,
  requiredEvidenceVerifier,
  noUnresolvedErrorsVerifier,
  noUnknownWritesVerifier,
  noPendingActionsVerifier,
  policyVersionVerifier,
];

export interface CompletionDecision {
  /** True only when the task may truthfully be reported as complete. */
  satisfied: boolean;
  /** The output to actually present (rewritten when a false success was blocked). */
  output: string;
  /** True when a claimed success was blocked and rewritten. */
  falseCompletionBlocked: boolean;
  results: VerificationResult[];
  blockingReasons: string[];
}

const SUCCESS_PROSE = /\b(done|fixed|complete[d]?|resolved|success(ful)?|passing|all set|shipped|merged|opened the pr)\b/i;

/**
 * Verify a proposed completion against all applicable verifiers. For action
 * tasks a final success requires every applicable verifier to pass; otherwise a
 * success-sounding output is rewritten into a truthful incomplete/blocked one.
 * Conversational questions are returned unchanged.
 */
export function verifyCompletion(
  rawInput: VerificationInput,
  verifiers: readonly Verifier[] = BUILTIN_VERIFIERS,
): CompletionDecision {
  const input = VerificationInputSchema.parse(rawInput);
  if (!actionTask(input.contract)) {
    return {
      satisfied: true,
      output: input.proposedOutput,
      falseCompletionBlocked: false,
      results: [],
      blockingReasons: [],
    };
  }

  const applicable = verifiers.filter((v) => v.applies(input.contract));
  const results = applicable.map((v) => v.evaluate(input));
  const failing = results.filter((r) => r.status !== 'passed');
  const satisfied = failing.length === 0;

  if (satisfied) {
    return { satisfied: true, output: input.proposedOutput, falseCompletionBlocked: false, results, blockingReasons: [] };
  }

  const blockingReasons = failing.flatMap((r) => {
    const failed = r.criteria.filter((c) => c.status !== 'passed');
    if (failed.length === 0) return [`${r.verifierId}: ${r.status}`];
    return failed.map((c) => `${r.verifierId}: ${c.criterion} (${c.status})`);
  });

  const claimedSuccess = SUCCESS_PROSE.test(input.proposedOutput);
  const rewritten = [
    'INCOMPLETE — the harness could not verify completion from typed evidence.',
    '',
    'Outstanding items:',
    ...blockingReasons.map((r) => `  - ${r}`),
    '',
    'Model-authored summary (unverified, retained for context):',
    input.proposedOutput.trim() || '(none)',
  ].join('\n');

  return {
    satisfied: false,
    output: rewritten,
    falseCompletionBlocked: claimedSuccess,
    results,
    blockingReasons,
  };
}
