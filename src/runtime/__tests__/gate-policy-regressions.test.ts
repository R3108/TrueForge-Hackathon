import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { ToolInvocation } from '../contracts.ts';
import { EvidenceLedger } from '../evidence.ts';
import { ToolCallGate } from '../gate.ts';

const policy = {
  targetRepo: 'truefoundry/example',
  baseBranch: 'main',
  writePaths: ['fixture/**'],
  githubConnector: 'github',
  githubConnectorId: 'github-id',
  policyVersion: 'test-v1',
  requireTestEvidence: false,
};

function invocation(
  toolName: string,
  args: unknown,
  toolCallId = 'call_1',
  turnId = 'turn_1',
): ToolInvocation {
  return {
    key: { sessionId: 'session_1', turnId, threadId: 'main', toolCallId },
    sourceEventId: `event_${toolCallId}`,
    origin: 'agent',
    toolSetId: 'github-id',
    toolSetName: 'github',
    toolType: 'mcp',
    toolName,
    arguments: args,
    policyVersion: 'test-v1',
    validationViolations: [],
  };
}

const fileArgs = {
  owner: 'truefoundry',
  repo: 'example',
  branch: 'fix/cart',
  path: 'fixture/cart.js',
  content: 'fixed',
};

function gate(evidence = new EvidenceLedger()): ToolCallGate {
  return new ToolCallGate(policy, evidence, Buffer.alloc(32, 11));
}

describe('gate audit regressions', () => {
  test('fails closed on invocation policy-version skew and binds it into identity', () => {
    const firewall = gate();
    const current = invocation('create_or_update_file', fileArgs);
    const stale = { ...current, policyVersion: 'stale-v0' };

    assert.notEqual(firewall.fingerprint(current), firewall.fingerprint(stale));
    const result = firewall.evaluate(stale);
    assert.equal(result.decision.type, 'deny');
    assert.equal(result.decision.type === 'deny' && result.decision.code, 'policy_version_mismatch');
  });

  test('a denied call contributes no policy or repository evidence', () => {
    const evidence = new EvidenceLedger();
    const result = gate(evidence).evaluate(
      invocation('create_or_update_file', { ...fileArgs, path: 'src/runtime/gate.ts' }),
    );

    assert.equal(result.decision.type, 'deny');
    assert.deepEqual(evidence.summary().records, []);
  });

  test('unknown side-effect outcomes cannot transition back toward dispatch', () => {
    const firewall = gate();
    const call = invocation('create_or_update_file', fileArgs);
    const evaluation = firewall.evaluate(call);
    firewall.recordHumanDecision(call, evaluation.fingerprint, 'allow');
    firewall.transition(evaluation.attempt, 'executing');
    firewall.transition(evaluation.attempt, 'unknown');

    assert.throws(() => firewall.transition(evaluation.attempt, 'approved'), /Invalid/);
    assert.throws(() => firewall.transition(evaluation.attempt, 'executing'), /Invalid/);
    assert.doesNotThrow(() => firewall.transition(evaluation.attempt, 'blocked'));
  });

  test('human review and human decisions have truthful attempt states', () => {
    const reviewGate = new ToolCallGate(
      { ...policy, requireTestEvidence: true },
      new EvidenceLedger(),
      Buffer.alloc(32, 12),
    );
    const call = invocation('create_pull_request', {
      owner: 'truefoundry',
      repo: 'example',
      title: 'Fix',
      head: 'fix/cart',
      base: 'main',
    });
    const review = reviewGate.evaluate(call);
    assert.equal(review.decision.type, 'human_review');
    assert.equal(review.attempt.state, 'human_review');
    reviewGate.recordHumanDecision(call, review.fingerprint, 'deny', 'Missing proof');
    assert.equal(review.attempt.state, 'blocked');

    const approvalGate = gate();
    const write = invocation('create_or_update_file', fileArgs, 'write_2');
    const approval = approvalGate.evaluate(write);
    assert.equal(approval.attempt.state, 'awaiting_approval');
    approvalGate.recordHumanDecision(write, approval.fingerprint, 'allow');
    assert.equal(approval.attempt.state, 'approved');
  });

  test('managed repair results close the original attempt without closing the repair lineage', () => {
    const firewall = gate();
    const malformed = invocation('create_or_update_file', { ...fileArgs, path: undefined }, 'bad');
    const first = firewall.evaluate(malformed);
    assert.equal(first.decision.type, 'repair');
    if (first.decision.type !== 'repair') return;
    firewall.recordManagedDenial(malformed, first.fingerprint, first.decision.feedback);
    assert.equal(first.attempt.state, 'blocked');

    const corrected = firewall.evaluate(
      invocation('create_or_update_file', fileArgs, 'fixed', 'turn_2'),
    );
    assert.equal(corrected.decision.type, 'require_approval');
  });

  test('blocks equivalent sensitive calls across fresh IDs without resetting on approval', () => {
    const firewall = gate();
    const firstCall = invocation('create_or_update_file', fileArgs, 'first');
    const first = firewall.evaluate(firstCall);
    assert.equal(first.decision.type, 'require_approval');
    firewall.recordHumanDecision(firstCall, first.fingerprint, 'allow');

    const repeated = firewall.evaluate(
      invocation('create_or_update_file', fileArgs, 'second', 'turn_2'),
    );
    assert.equal(repeated.decision.type, 'deny');
    assert.equal(
      repeated.decision.type === 'deny' && repeated.decision.code,
      'repeated_no_progress',
    );
  });

  test('requires a body for issue comments before approval', () => {
    const result = gate().evaluate(
      invocation('add_issue_comment', {
        owner: 'truefoundry',
        repo: 'example',
        issueNumber: 7,
      }),
    );
    assert.equal(result.decision.type, 'repair');
    assert.match(result.decision.type === 'repair' ? result.decision.feedback : '', /body/);
  });
});
