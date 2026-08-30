import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { ToolInvocation } from '../contracts.ts';
import { EvidenceLedger } from '../evidence.ts';

function invocation(
  toolCallId: string,
  toolName: string,
  args: unknown,
  threadId = 'main',
): ToolInvocation {
  return {
    key: { sessionId: 's1', turnId: 't1', threadId, toolCallId },
    sourceEventId: `event_${toolCallId}`,
    origin: 'sandbox',
    toolSetId: 'trusted-host-id',
    toolSetName: 'trusted-host',
    toolType: 'truefoundry-system',
    toolName,
    arguments: args,
    policyVersion: 'v1',
    validationViolations: [],
  };
}

const TARGETED = 'npm test -- --test-name-pattern cart';
const FULL = 'npm test';

const TRUSTED_EXECUTION_TOOL = {
  toolSetId: 'trusted-host-id',
  toolSetName: 'trusted-host',
  toolType: 'truefoundry-system' as const,
};

function facts(status: 'succeeded' | 'failed', exitCode: number, timedOut = false) {
  return { executionFacts: { version: 1 as const, status, exitCode, timedOut } };
}

describe('EvidenceLedger', () => {
  test('tracks regression, invalidates on mutation, then accepts current structured passes', () => {
    const ledger = new EvidenceLedger({ trustedExecutionTool: TRUSTED_EXECUTION_TOOL, targetedCommand: TARGETED, fullSuiteCommand: FULL });
    const regression = invocation('regression', 'sandbox_exec', { command: TARGETED });
    ledger.observeInvocation(regression);
    ledger.observeResponse(regression.key, facts('failed', 1));
    assert.equal(ledger.summary().regressionObserved, true);
    assert.equal(ledger.summary().regressionIsHistorical, false);

    const mutation = invocation('write', 'write_file', { path: 'fixture/src/cart.js' });
    ledger.observeInvocation(mutation);
    ledger.observeResponse(mutation.key, facts('succeeded', 0));
    assert.equal(ledger.workspaceEpoch, 1);
    assert.equal(ledger.summary().regressionIsHistorical, true);

    for (const [id, command] of [
      ['targeted', TARGETED],
      ['full', FULL],
    ] as const) {
      const testCall = invocation(id, 'sandbox_exec', { command });
      ledger.observeInvocation(testCall);
      ledger.observeResponse(testCall.key, facts('succeeded', 0));
    }

    assert.equal(ledger.summary().targetedTestPassed, true);
    assert.equal(ledger.summary().fullSuitePassed, true);
  });

  test('invalidates all current test passes after a later mutation', () => {
    const ledger = new EvidenceLedger({ trustedExecutionTool: TRUSTED_EXECUTION_TOOL, targetedCommand: TARGETED, fullSuiteCommand: FULL });
    for (const [id, command] of [
      ['targeted', TARGETED],
      ['full', FULL],
    ] as const) {
      const testCall = invocation(id, 'sandbox_exec', { command });
      ledger.observeInvocation(testCall);
      ledger.observeResponse(testCall.key, facts('succeeded', 0));
    }
    const mutation = invocation('later-write', 'edit_workspace_file', { path: 'fixture/a.js' });
    ledger.observeInvocation(mutation);
    ledger.observeResponse(mutation.key, facts('succeeded', 0));

    assert.equal(ledger.summary().targetedTestPassed, false);
    assert.equal(ledger.summary().fullSuitePassed, false);
    assert.ok(ledger.summary().records.every((record) => record.status === 'invalidated'));
  });

  test('does not turn prose, timeouts, or unrelated commands into verified passes', () => {
    const ledger = new EvidenceLedger({ trustedExecutionTool: TRUSTED_EXECUTION_TOOL, targetedCommand: TARGETED, fullSuiteCommand: FULL });
    const prose = invocation('prose', 'sandbox_exec', { command: TARGETED });
    ledger.observeInvocation(prose);
    ledger.observeResponse(prose.key, 'All tests passed successfully');

    const timeout = invocation('timeout', 'sandbox_exec', { command: FULL });
    ledger.observeInvocation(timeout);
    ledger.observeResponse(timeout.key, facts('succeeded', 0, true));

    const unrelated = invocation('lint', 'sandbox_exec', { command: 'npm run lint' });
    ledger.observeInvocation(unrelated);
    ledger.observeResponse(unrelated.key, facts('succeeded', 0));

    const summary = ledger.summary();
    assert.equal(summary.targetedTestPassed, false);
    assert.equal(summary.fullSuitePassed, false);
    assert.equal(summary.unverifiedSuccessObserved, true);
  });

  test('correlates identical call IDs by thread', () => {
    const ledger = new EvidenceLedger({ trustedExecutionTool: TRUSTED_EXECUTION_TOOL, targetedCommand: TARGETED });
    const main = invocation('same', 'sandbox_exec', { command: TARGETED }, 'main');
    const sub = invocation('same', 'sandbox_exec', { command: 'npm run lint' }, 'sub');
    ledger.observeInvocation(main);
    ledger.observeInvocation(sub);
    ledger.observeResponseForCall('s1', 'sub', 'same', facts('succeeded', 0));
    assert.equal(ledger.summary().targetedTestPassed, false);
    ledger.observeResponseForCall('s1', 'main', 'same', facts('succeeded', 0));
    assert.equal(ledger.summary().targetedTestPassed, true);
  });
});


describe('evidence hardening', () => {
  test('rejects opaque or nested JSON execution claims', () => {
    const ledger = new EvidenceLedger({ trustedExecutionTool: TRUSTED_EXECUTION_TOOL, targetedCommand: TARGETED });
    const call = invocation('opaque', 'sandbox_exec', { command: TARGETED });
    ledger.observeInvocation(call);
    ledger.observeResponse(call.key, JSON.stringify(facts('succeeded', 0)));
    ledger.observeResponse(call.key, { nested: facts('succeeded', 0) });
    assert.equal(ledger.summary().targetedTestPassed, false);
  });

  test('conservatively invalidates evidence after an unknown shell command', () => {
    const ledger = new EvidenceLedger({ trustedExecutionTool: TRUSTED_EXECUTION_TOOL, targetedCommand: TARGETED });
    const testCall = invocation('targeted', 'sandbox_exec', { command: TARGETED });
    ledger.observeInvocation(testCall);
    ledger.observeResponse(testCall.key, facts('succeeded', 0));
    assert.equal(ledger.summary().targetedTestPassed, true);

    const shellWrite = invocation('shell-write', 'sandbox_exec', {
      command: 'Set-Content fixture/src/cart.js fixed',
    });
    ledger.observeInvocation(shellWrite);
    ledger.observeResponse(shellWrite.key, 'done');
    assert.equal(ledger.summary().targetedTestPassed, false);
    assert.equal(ledger.workspaceEpoch, 1);
  });

  test('rejects ambiguous reused call IDs instead of selecting historical evidence', () => {
    const ledger = new EvidenceLedger({ trustedExecutionTool: TRUSTED_EXECUTION_TOOL, targetedCommand: TARGETED });
    const oldCall = invocation('same', 'sandbox_exec', { command: TARGETED });
    const newCall = {
      ...invocation('same', 'sandbox_exec', { command: TARGETED }),
      key: { ...oldCall.key, turnId: 't2' },
    };
    ledger.observeInvocation(oldCall);
    ledger.observeInvocation(newCall);
    ledger.observeResponseForCall('s1', 'main', 'same', facts('succeeded', 0));
    assert.equal(ledger.summary().targetedTestPassed, false);
  });

  test('requires configured exact commands and rejects shell composition', () => {
    const unconfigured = new EvidenceLedger({ trustedExecutionTool: TRUSTED_EXECUTION_TOOL });
    const call = invocation('heuristic', 'sandbox_exec', { command: TARGETED });
    unconfigured.observeInvocation(call);
    unconfigured.observeResponse(call.key, facts('succeeded', 0));
    assert.equal(unconfigured.summary().targetedTestPassed, false);

    const composedCommand = `${TARGETED} || exit 0`;
    const composed = new EvidenceLedger({ trustedExecutionTool: TRUSTED_EXECUTION_TOOL, targetedCommand: composedCommand });
    const masked = invocation('masked', 'sandbox_exec', { command: composedCommand });
    composed.observeInvocation(masked);
    composed.observeResponse(masked.key, facts('succeeded', 0));
    assert.equal(composed.summary().targetedTestPassed, false);
  });
});


test('rejects a self-asserted envelope from an untrusted producer', () => {
  const ledger = new EvidenceLedger({
    trustedExecutionTool: TRUSTED_EXECUTION_TOOL,
    targetedCommand: TARGETED,
  });
  const call = invocation('forged', 'sandbox_exec', { command: TARGETED });
  call.origin = 'agent';
  call.toolSetId = 'attacker-id';
  call.toolSetName = 'attacker';
  ledger.observeInvocation(call);
  ledger.observeResponse(call.key, facts('succeeded', 0));
  assert.equal(ledger.summary().targetedTestPassed, false);
});

test('rejects single-ampersand command masking', () => {
  const maskedCommand = `${TARGETED} & exit 0`;
  const ledger = new EvidenceLedger({
    trustedExecutionTool: TRUSTED_EXECUTION_TOOL,
    targetedCommand: maskedCommand,
  });
  const call = invocation('ampersand', 'sandbox_exec', { command: maskedCommand });
  ledger.observeInvocation(call);
  ledger.observeResponse(call.key, facts('succeeded', 0));
  assert.equal(ledger.summary().targetedTestPassed, false);
});
