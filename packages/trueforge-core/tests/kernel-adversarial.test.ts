import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { AdaptiveAgentKernel, type KernelOptions } from '../../../src/runtime/kernel/index.ts';
import {
  BUILTIN_VERIFIERS,
  verifyCompletion,
  type VerificationInput,
} from '../../../src/runtime/kernel/verification.ts';
import { compileTaskContract, isSimpleQuestion, type CompilerOptions } from '../../../src/runtime/kernel/contract.ts';
import { projectWorkingState } from '../../../src/runtime/kernel/working-state.ts';
import { deriveDelegation, type ParentAuthority, type DelegationRequest } from '../../../src/runtime/kernel/delegation.ts';
import type { EvidenceSummary } from '../../../src/runtime/evidence.ts';

const compilerOptions: CompilerOptions = {
  requireTestEvidence: true,
  writePaths: ['fixture/**'],
  targetRepo: 'truefoundry/example',
  baseBranch: 'main',
  policyVersion: 'v1',
};

const kernelOptions: KernelOptions = {
  enabled: true,
  ...compilerOptions,
  modelLimits: { contextWindow: 128000, maxOutputTokens: 8192 },
};

function evidence(over: Partial<EvidenceSummary> = {}): EvidenceSummary {
  return {
    workspaceEpoch: 1,
    regressionObserved: true,
    regressionIsHistorical: false,
    targetedTestPassed: true,
    fullSuitePassed: true,
    unverifiedSuccessObserved: false,
    records: [],
    ...over,
  };
}

// ---------------------------------------------------------------------------
// AUDIT PROBE: does the policy-version verifier ever fire in the live wiring?
// ---------------------------------------------------------------------------
describe('AUDIT — policy version staleness verifier wiring', () => {
  test('the verifier itself CAN detect a stale policy version (unit level)', () => {
    const contract = compileTaskContract('Fix the null deref crash in cart', compilerOptions, 't1');
    const input: VerificationInput = {
      contract,
      workingState: projectWorkingState(contract.taskId, [{ type: 'criteria_set', criteria: [] }]),
      evidence: evidence(),
      pendingRequiredActions: 0,
      unknownWriteOutcomes: 0,
      activePolicyVersion: 'v2',
      contractPolicyVersion: 'v1',
      proposedOutput: 'done',
    };
    const decision = verifyCompletion(input, BUILTIN_VERIFIERS);
    // A drift between contract-time and active policy must block completion.
    assert.equal(decision.satisfied, false);
    assert.ok(decision.results.some((r) => r.verifierId === 'current-policy-version' && r.status === 'stale'));
  });

  test('CONNECTED: the contract captures its compile-time policy version', () => {
    // FIX VERIFICATION: the contract now carries the policy version it was
    // compiled under, so verification compares it against the live active
    // version rather than comparing a value against itself.
    const contract = compileTaskContract('Fix the crash in cart', { ...compilerOptions, policyVersion: 'v1' }, 't2');
    assert.equal(contract.policyVersion, 'v1');

    // Same contract, but the harness now runs under an advanced policy version.
    const input: VerificationInput = {
      contract,
      workingState: projectWorkingState(contract.taskId, [{ type: 'criteria_set', criteria: [] }]),
      evidence: evidence(),
      pendingRequiredActions: 0,
      unknownWriteOutcomes: 0,
      activePolicyVersion: 'v2',
      contractPolicyVersion: contract.policyVersion,
      proposedOutput: 'done',
    };
    const decision = verifyCompletion(input, BUILTIN_VERIFIERS);
    assert.equal(decision.satisfied, false);
    assert.ok(decision.results.some((r) => r.verifierId === 'current-policy-version' && r.status === 'stale'));
  });

  test('a matching policy version passes the policy verifier through the kernel', () => {
    const kernel = new AdaptiveAgentKernel(kernelOptions);
    kernel.admit('Fix the null deref crash in cart', 'session-audit');
    const decision = kernel.verify('done', evidence(), 0, 0);
    const policyResult = decision.results.find((r) => r.verifierId === 'current-policy-version');
    assert.ok(policyResult);
    assert.equal(policyResult.status, 'passed');
  });
});

// ---------------------------------------------------------------------------
// AUDIT PROBE: false completion cannot be produced by prose alone.
// ---------------------------------------------------------------------------
describe('AUDIT — false completion blocking', () => {
  test('success prose without typed evidence is blocked and rewritten', () => {
    const kernel = new AdaptiveAgentKernel(kernelOptions);
    kernel.admit('Fix the null deref crash in cart', 'session-fc');
    const decision = kernel.verify(
      'All done — merged and shipped, everything is green!',
      evidence({ targetedTestPassed: false, fullSuitePassed: false, regressionObserved: false }),
      0,
      0,
    );
    assert.equal(decision.satisfied, false);
    assert.equal(decision.falseCompletionBlocked, true);
    assert.match(decision.output, /INCOMPLETE/);
  });

  test('a pending required action blocks completion even with full evidence', () => {
    const kernel = new AdaptiveAgentKernel(kernelOptions);
    kernel.admit('Fix the null deref crash in cart', 'session-pending');
    const decision = kernel.verify('done', evidence(), /* pending */ 1, 0);
    assert.equal(decision.satisfied, false);
  });

  test('an unknown write outcome blocks completion even with full evidence', () => {
    const kernel = new AdaptiveAgentKernel(kernelOptions);
    kernel.admit('Fix the null deref crash in cart', 'session-unknown');
    const decision = kernel.verify('done', evidence(), 0, /* unknown writes */ 1);
    assert.equal(decision.satisfied, false);
  });
});

// ---------------------------------------------------------------------------
// AUDIT PROBE: misclassification of an action as a question cannot bypass writes.
// ---------------------------------------------------------------------------
describe('AUDIT — question classification cannot widen authority', () => {
  test('destructive verbs phrased as questions are NOT simple questions', () => {
    assert.equal(isSimpleQuestion('Should I merge this PR to main and delete the branch?'), false);
    assert.equal(isSimpleQuestion('Can you push the fix to main?'), false);
  });

  test('a genuine question is bypassed but produces no write-enabling contract fields', () => {
    const contract = compileTaskContract('What is the base branch?', compilerOptions, 'q1');
    assert.equal(contract.bypassed, true);
    assert.equal(contract.requiredEvidence.length, 0);
    // A bypassed question contract carries no referenced write resources or
    // acceptance criteria that could be mistaken for authority.
    assert.equal(contract.acceptanceCriteria.length, 0);
  });
});

// ---------------------------------------------------------------------------
// AUDIT PROBE: delegation cannot widen authority via profile or denials.
// ---------------------------------------------------------------------------
describe('AUDIT — delegation authority is a strict floor', () => {
  function parent(over: Partial<ParentAuthority> = {}): ParentAuthority {
    return {
      parentTaskId: 'p',
      allowedToolCapabilities: ['read', 'search'],
      ownedResources: [],
      depth: 0,
      maxDepth: 3,
      profileToolCapabilities: ['read', 'search', 'write', 'destructive'],
      ...over,
    };
  }
  function request(over: Partial<DelegationRequest> = {}): DelegationRequest {
    return {
      objective: 'x',
      constraints: [],
      expectedOutput: [],
      requestedToolCapabilities: ['read'],
      deniedToolCapabilities: [],
      resourceOwnership: [],
      evidenceRequirements: [],
      maxSteps: 4,
      ...over,
    };
  }

  test('a profile richer than the parent cannot lift the child above the parent', () => {
    // Child requests write, which the profile allows but the parent does not.
    const outcome = deriveDelegation(parent(), request({ requestedToolCapabilities: ['read', 'write'] }));
    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.equal(outcome.code, 'permission_widening');
  });

  test('the granted set never exceeds the parent even when profile is broad', () => {
    const outcome = deriveDelegation(parent(), request({ requestedToolCapabilities: ['read', 'search'] }));
    assert.equal(outcome.ok, true);
    if (outcome.ok) {
      for (const cap of outcome.contract.allowedToolCapabilities) {
        assert.ok(parent().allowedToolCapabilities.includes(cap));
      }
    }
  });
});

// ---------------------------------------------------------------------------
// AUDIT PROBE: working-state replay is deterministic; secrets never persist.
// ---------------------------------------------------------------------------
describe('AUDIT — working state replay and secret rejection', () => {
  test('replaying identical events yields identical durable fields (event replay)', () => {
    const events = [
      { type: 'phase_changed' as const, phase: 'executing' as const },
      { type: 'fact_observed' as const, text: 'cart.js line 12 throws', provenance: 'tool-discovered' as const, verified: true },
      { type: 'failure_recorded' as const, failureClass: 'domain', summary: 'null deref persists' },
    ];
    const a = projectWorkingState('t', events);
    const b = projectWorkingState('t', events);
    assert.deepEqual({ ...a, updatedAt: '' }, { ...b, updatedAt: '' });
  });

  test('a fact carrying a secret is rejected outright (fail closed)', () => {
    const state = projectWorkingState('t', [
      { type: 'fact_observed', text: 'the bearer token is abc123', provenance: 'tool-discovered', verified: true },
    ]);
    assert.equal(state.observedFacts.length, 0);
  });
});
