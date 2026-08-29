import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { compileTaskContract, type CompilerOptions, type TaskContract } from '../../../src/runtime/kernel/contract.ts';
import { projectWorkingState } from '../../../src/runtime/kernel/working-state.ts';
import { verifyCompletion, type VerificationInput } from '../../../src/runtime/kernel/verification.ts';
import type { EvidenceSummary } from '../../../src/runtime/evidence.ts';

const options: CompilerOptions = {
  requireTestEvidence: true,
  writePaths: ['fixture/**'],
  targetRepo: 'truefoundry/example',
  baseBranch: 'main',
  policyVersion: 'v1',
};

function evidence(overrides: Partial<EvidenceSummary> = {}): EvidenceSummary {
  return {
    workspaceEpoch: 1,
    regressionObserved: true,
    regressionIsHistorical: false,
    targetedTestPassed: true,
    fullSuitePassed: true,
    unverifiedSuccessObserved: false,
    records: [],
    ...overrides,
  };
}

function input(contract: TaskContract, over: Partial<VerificationInput>): VerificationInput {
  return {
    contract,
    workingState: projectWorkingState(contract.taskId, [
      { type: 'criteria_set', criteria: [] },
    ]),
    evidence: evidence(),
    pendingRequiredActions: 0,
    unknownWriteOutcomes: 0,
    activePolicyVersion: 'v1',
    contractPolicyVersion: 'v1',
    proposedOutput: 'Done — the fix is complete and all tests pass.',
    ...over,
  };
}

const bugFix = compileTaskContract('Fix the null deref crash in cart', options, 'v1');

describe('VerificationCoordinator — action task completion', () => {
  test('accepts a genuine completion when all evidence is present and fresh', () => {
    const decision = verifyCompletion(input(bugFix, {}));
    assert.equal(decision.satisfied, true);
    assert.equal(decision.falseCompletionBlocked, false);
    assert.match(decision.output, /complete/);
  });

  test('blocks and rewrites a false success when required evidence is missing', () => {
    const decision = verifyCompletion(
      input(bugFix, { evidence: evidence({ targetedTestPassed: false, fullSuitePassed: false }) }),
    );
    assert.equal(decision.satisfied, false);
    assert.equal(decision.falseCompletionBlocked, true);
    assert.match(decision.output, /INCOMPLETE/);
    assert.ok(decision.blockingReasons.length > 0);
  });

  test('treats stale (later-mutated) evidence as not satisfying completion', () => {
    const decision = verifyCompletion(
      input(bugFix, { evidence: evidence({ regressionIsHistorical: true }) }),
    );
    assert.equal(decision.satisfied, false);
    assert.ok(decision.results.some((r) => r.status === 'stale'));
  });

  test('blocks completion while a required action is still pending', () => {
    const decision = verifyCompletion(input(bugFix, { pendingRequiredActions: 1 }));
    assert.equal(decision.satisfied, false);
    assert.ok(decision.blockingReasons.some((r) => /no-pending-required-actions/.test(r)));
  });

  test('blocks completion while a write outcome is unknown', () => {
    const decision = verifyCompletion(input(bugFix, { unknownWriteOutcomes: 1 }));
    assert.equal(decision.satisfied, false);
    assert.ok(decision.results.some((r) => r.verifierId === 'no-unknown-writes' && r.status === 'unknown'));
  });

  test('an unresolved error blocks completion', () => {
    const ws = projectWorkingState('v1', [
      { type: 'failure_recorded', failureClass: 'domain', summary: 'still broken' },
    ]);
    const decision = verifyCompletion(input(bugFix, { workingState: ws }));
    assert.equal(decision.satisfied, false);
    assert.ok(decision.results.some((r) => r.verifierId === 'no-unresolved-errors' && r.status === 'failed'));
  });
});

describe('VerificationCoordinator — simple questions are unaffected', () => {
  test('a conversational question passes through unverified and unchanged', () => {
    const question = compileTaskContract('What is the base branch?', options, 'q1');
    const original = 'The base branch is main.';
    const decision = verifyCompletion(input(question, { proposedOutput: original }));
    assert.equal(decision.satisfied, true);
    assert.equal(decision.output, original);
    assert.equal(decision.results.length, 0);
  });
});
