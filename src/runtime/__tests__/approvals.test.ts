import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { stdin } from 'node:process';

import { requestClearance, type PendingCall } from '../approvals.ts';

/**
 * The safety claim of this project is that the agent cannot write to a
 * repository while nobody is watching. These tests hold that claim to account.
 */

const call = (overrides: Partial<PendingCall> = {}): PendingCall => ({
  threadId: 'main',
  toolCallId: 'call_1',
  toolName: 'create_pull_request',
  args: { title: 'Fix null deref in cart.ts' },
  ...overrides,
});

describe('requestClearance', () => {
  let originalIsTTY: boolean | undefined;

  before(() => {
    originalIsTTY = stdin.isTTY;
  });

  after(() => {
    // `isTTY` is absent (not false) on a real non-TTY stream, so restore shape.
    if (originalIsTTY === undefined) delete (stdin as { isTTY?: boolean }).isTTY;
    else stdin.isTTY = originalIsTTY;
  });

  test('returns no decisions when nothing is pending', async () => {
    const decisions = await requestClearance([]);
    assert.deepEqual(decisions, []);
  });

  test('denies every pending write when there is no interactive terminal', async () => {
    stdin.isTTY = false;

    const decisions = await requestClearance([
      call({ toolCallId: 'call_a', toolName: 'create_branch' }),
      call({ toolCallId: 'call_b', toolName: 'create_pull_request' }),
    ]);

    assert.equal(decisions.length, 2, 'every pending call must be answered');
    for (const decision of decisions) {
      assert.equal(decision.type, 'user.tool_approval');
      assert.equal(
        decision.approval.status,
        'deny',
        'an unattended session must never auto-approve a repository write',
      );
    }
  });

  test('gives the agent a reason when it denies, so it can explain itself', async () => {
    stdin.isTTY = false;

    const [decision] = await requestClearance([call()]);
    assert.ok(decision, 'expected a decision');
    assert.equal(decision.approval.status, 'deny');
    assert.match(
      (decision.approval as { reason: string }).reason,
      /non-interactive/i,
      'the denial reason should tell the agent why it was refused',
    );
  });

  test('denies a write outside the perimeter without asking a human', async () => {
    // A TTY is present, so the only reason this can be denied is the perimeter.
    stdin.isTTY = true;

    const decisions = await requestClearance(
      [call({ toolName: 'create_or_update_file', args: { path: 'src/agent/spec.ts' } })],
      ['fixture/**'],
    );

    assert.equal(decisions.length, 1);
    assert.equal(decisions[0]?.approval.status, 'deny');
    assert.match(
      (decisions[0]?.approval as { reason: string }).reason,
      /perimeter/i,
      'the agent should be told which boundary it hit',
    );
  });

  test('does not let a perimeter breach ride along with a legitimate write', async () => {
    stdin.isTTY = false;

    const decisions = await requestClearance(
      [
        call({ toolCallId: 'inside', args: { path: 'fixture/src/cart.js' } }),
        call({ toolCallId: 'outside', args: { path: 'src/runtime/approvals.ts' } }),
      ],
      ['fixture/**'],
    );

    assert.equal(decisions.length, 2, 'every call must still be answered');
    for (const decision of decisions) {
      assert.equal(decision.approval.status, 'deny');
    }
  });

  test('answers each pending call with its own id, not a shared one', async () => {
    stdin.isTTY = false;

    const decisions = await requestClearance([
      call({ toolCallId: 'call_a', threadId: 'main' }),
      call({ toolCallId: 'call_b', threadId: 'sub_7f2a' }),
    ]);

    assert.deepEqual(
      decisions.map((d) => [d.toolCallId, d.threadId]),
      [
        ['call_a', 'main'],
        ['call_b', 'sub_7f2a'],
      ],
      'a decision routed to the wrong call would approve something unreviewed',
    );
  });
});
