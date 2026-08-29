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
  threadId = 'main',
  turnId = 't1',
): ToolInvocation {
  return {
    key: { sessionId: 's1', turnId, threadId, toolCallId },
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

function gate(): ToolCallGate {
  return new ToolCallGate(policy, new EvidenceLedger(), Buffer.alloc(32, 3));
}

const fileArgs = {
  owner: 'truefoundry',
  repo: 'example',
  branch: 'fix/cart',
  path: 'fixture/src/cart.js',
  content: 'export const fixed = true;',
};

describe('ToolCallGate policy', () => {
  test('allows a valid write only through fresh approval', () => {
    const result = gate().evaluate(invocation('create_or_update_file', fileArgs));
    assert.equal(result.decision.type, 'require_approval');
    assert.equal(result.attempt.state, 'awaiting_approval');
  });

  test('blocks a repository mismatch', () => {
    const result = gate().evaluate(
      invocation('create_or_update_file', { ...fileArgs, owner: 'attacker' }),
    );
    assert.deepEqual(result.decision.type === 'deny' && result.decision.code, 'repository_mismatch');
  });

  test('blocks traversal, absolute, and credential-sensitive paths', () => {
    for (const path of [
      'fixture/../../src/runtime/gate.ts',
      '/fixture/src/cart.js',
      'C:\\fixture\\src\\cart.js',
      'fixture/.env.production',
    ]) {
      const result = gate().evaluate(
        invocation('create_or_update_file', { ...fileArgs, path }, `call_${path}`),
      );
      assert.equal(result.decision.type, 'deny', path);
    }
  });

  test('blocks direct protected-branch writes and destructive tools', () => {
    const protectedWrite = gate().evaluate(
      invocation('create_or_update_file', { ...fileArgs, branch: 'main' }),
    );
    assert.equal(protectedWrite.decision.type, 'deny');
    assert.equal(
      protectedWrite.decision.type === 'deny' && protectedWrite.decision.code,
      'protected_branch',
    );

    const destructive = gate().evaluate(
      invocation('delete_file', {
        owner: 'truefoundry',
        repo: 'example',
        branch: 'fix/cart',
        path: 'fixture/src/cart.js',
      }),
    );
    assert.equal(destructive.decision.type, 'deny');
    assert.equal(
      destructive.decision.type === 'deny' && destructive.decision.code,
      'destructive_operation',
    );
  });

  test('fails closed for an unknown approval-gated tool', () => {
    const result = gate().evaluate(invocation('future_write_everything', {}));
    assert.equal(result.decision.type, 'deny');
    assert.equal(
      result.decision.type === 'deny' && result.decision.code,
      'unknown_sensitive_tool',
    );
  });
});

describe('bounded repair and approval identity', () => {
  test('requests structured repair and requires a new call ID for the correction', () => {
    const firewall = gate();
    const invalid = firewall.evaluate(
      invocation('create_or_update_file', { ...fileArgs, path: undefined }, 'bad_1'),
    );
    assert.equal(invalid.decision.type, 'repair');
    assert.match(invalid.decision.type === 'repair' ? invalid.decision.feedback : '', /missing_required/);

    const sameId = firewall.evaluate(invocation('create_or_update_file', fileArgs, 'bad_1', 'main', 't2'));
    assert.equal(sameId.decision.type, 'deny');
    assert.equal(sameId.decision.type === 'deny' && sameId.decision.code, 'new_call_required');

    const corrected = firewall.evaluate(invocation('create_or_update_file', fileArgs, 'fixed_2', 'main', 't2'));
    assert.equal(corrected.decision.type, 'require_approval');
    assert.equal(corrected.repairAttempt, 1);
  });

  test('stops a repeated invalid fingerprint deterministically', () => {
    const firewall = gate();
    const badArgs = { ...fileArgs, path: undefined };
    assert.equal(
      firewall.evaluate(invocation('create_or_update_file', badArgs, 'bad_1', 'repeat')).decision.type,
      'repair',
    );
    const repeated = firewall.evaluate(
      invocation('create_or_update_file', badArgs, 'bad_2', 'repeat', 't2'),
    );
    assert.equal(repeated.decision.type, 'deny');
    assert.equal(
      repeated.decision.type === 'deny' && repeated.decision.code,
      'repeated_fingerprint',
    );
  });

  test('invalidates an approval when semantics change under the same call ID', () => {
    const firewall = gate();
    const original = invocation('create_or_update_file', fileArgs);
    const evaluation = firewall.evaluate(original);
    firewall.recordHumanDecision(original, evaluation.fingerprint, 'allow');

    const changed = invocation('create_or_update_file', { ...fileArgs, content: 'changed' });
    const replay = firewall.processedDecision(changed);
    assert.equal(replay?.status, 'deny');
    assert.match(replay?.reason ?? '', /identity changed/i);
  });

  test('rejects invalid attempt-state transitions', () => {
    const firewall = gate();
    const evaluation = firewall.evaluate(invocation('create_or_update_file', fileArgs));
    assert.throws(() => firewall.transition(evaluation.attempt, 'succeeded'), /Invalid/);
  });
});


describe('provenance and terminal lineage', () => {
  test('rejects a same-named tool from an untrusted MCP connector', () => {
    const call = invocation('create_or_update_file', fileArgs);
    call.toolSetId = 'other-id';
    call.toolSetName = 'github';
    const result = gate().evaluate(call);
    assert.equal(result.decision.type, 'deny');
    assert.equal(
      result.decision.type === 'deny' && result.decision.code,
      'untrusted_tool_origin',
    );
  });

  test('makes a human denial terminal across fresh call IDs', () => {
    const firewall = gate();
    const original = invocation('create_or_update_file', fileArgs, 'original', 'denied');
    const evaluation = firewall.evaluate(original);
    firewall.recordHumanDecision(original, evaluation.fingerprint, 'deny', 'No');

    const descendant = firewall.evaluate(
      invocation('create_or_update_file', fileArgs, 'fresh-id', 'denied', 't2'),
    );
    assert.equal(descendant.decision.type, 'deny');
    assert.equal(
      descendant.decision.type === 'deny' && descendant.decision.code,
      'human_denial_terminal',
    );
  });

  test('does not credit a same-turn sibling as a correction', () => {
    const firewall = gate();
    firewall.evaluate(
      invocation('create_or_update_file', { ...fileArgs, path: undefined }, 'bad', 'batch'),
    );
    const sibling = firewall.evaluate(
      invocation('create_or_update_file', fileArgs, 'sibling', 'batch'),
    );
    assert.equal(sibling.decision.type, 'deny');
    assert.equal(
      sibling.decision.type === 'deny' && sibling.decision.code,
      'repair_not_continuation',
    );
  });

  test('validates every push_files element before path policy', () => {
    const result = gate().evaluate(
      invocation('push_files', {
        owner: 'truefoundry',
        repo: 'example',
        branch: 'fix/cart',
        files: [
          { path: 'fixture/src/cart.js', content: 'ok' },
          { content: 'missing path' },
        ],
      }),
    );
    assert.equal(result.decision.type, 'repair');
    assert.match(result.decision.type === 'repair' ? result.decision.feedback : '', /files\[1\]/);
  });
});
