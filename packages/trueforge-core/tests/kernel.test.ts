import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { AdaptiveAgentKernel, CAPABILITY_STATE_KEYS, type KernelOptions } from '../../../src/runtime/kernel/index.ts';
import type { EvidenceSummary } from '../../../src/runtime/evidence.ts';

const options: KernelOptions = {
  enabled: true,
  policyVersion: 'v1',
  requireTestEvidence: true,
  writePaths: ['fixture/**'],
  targetRepo: 'truefoundry/example',
  baseBranch: 'main',
  modelLimits: { contextWindow: 128000, maxOutputTokens: 8192 },
};

function evidence(over: Partial<EvidenceSummary> = {}): EvidenceSummary {
  return {
    workspaceEpoch: 1,
    regressionObserved: false,
    regressionIsHistorical: false,
    targetedTestPassed: false,
    fullSuitePassed: false,
    unverifiedSuccessObserved: false,
    records: [],
    ...over,
  };
}

describe('AdaptiveAgentKernel — reserved keys and additive events', () => {
  test('exposes stable fixed-core capability_state keys', () => {
    assert.equal(CAPABILITY_STATE_KEYS.taskContract, 'kernel.task_contract');
    assert.equal(CAPABILITY_STATE_KEYS.verification, 'kernel.verification');
    // Keys are stable strings; consumers may ignore unknown future keys.
    assert.equal(Object.values(CAPABILITY_STATE_KEYS).every((k) => k.startsWith('kernel.')), true);
  });

  test('admitting a brief emits an additive contract_created event', () => {
    const kernel = new AdaptiveAgentKernel(options);
    kernel.admit('Fix the null deref crash in cart', 'session-1');
    assert.ok(kernel.events.some((e) => e.type === 'task.contract_created'));
    assert.equal(kernel.metrics.requestCompilations, 1);
  });

  test('a blocking ambiguity emits a contract_blocked event', () => {
    const kernel = new AdaptiveAgentKernel(options);
    kernel.admit('Fix this by either patching the caller or the callee', 'session-2');
    assert.ok(kernel.events.some((e) => e.type === 'task.contract_blocked'));
  });
});

describe('AdaptiveAgentKernel — verification integration', () => {
  test('blocks a false success for an action task lacking evidence', () => {
    const kernel = new AdaptiveAgentKernel(options);
    kernel.admit('Fix the null deref crash in cart', 'session-3');
    const decision = kernel.verify('All done, tests pass!', evidence(), 0, 0);
    assert.equal(decision.satisfied, false);
    assert.equal(decision.falseCompletionBlocked, true);
    assert.equal(kernel.metrics.falseCompletionsBlocked, 1);
  });

  test('a simple question passes verification unchanged', () => {
    const kernel = new AdaptiveAgentKernel(options);
    kernel.admit('What is the base branch?', 'session-4');
    const original = 'The base branch is main.';
    const decision = kernel.verify(original, evidence(), 0, 0);
    assert.equal(decision.satisfied, true);
    assert.equal(decision.output, original);
  });

  test('pinned context is provenance-tagged and inspectable without secrets', () => {
    const kernel = new AdaptiveAgentKernel(options);
    kernel.admit('Fix the null deref crash in cart', 'session-5');
    const debug = kernel.debugPinned();
    assert.ok(debug.sections.some((s) => s.provenance === 'core-policy'));
    assert.ok(debug.totalTokenEstimate > 0);
  });

  test('a user correction bumps the contract revision', () => {
    const kernel = new AdaptiveAgentKernel(options);
    kernel.admit('Fix the bug in cart.js', 'session-6');
    const revised = kernel.applyCorrection('Actually fix server.js instead, do not touch cart.js');
    assert.equal(revised.revision, 2);
    assert.equal(kernel.metrics.contractRevisions, 1);
  });
});
