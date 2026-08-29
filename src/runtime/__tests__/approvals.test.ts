import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { stdin } from 'node:process';

import { requestClearance, requestResponses } from '../approvals.ts';
import type { PendingApproval, PendingResponse, ToolInvocation } from '../contracts.ts';
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

function gate(): ToolCallGate {
  return new ToolCallGate(policy, new EvidenceLedger(), Buffer.alloc(32, 7));
}

function invocation(overrides: Partial<ToolInvocation> = {}): ToolInvocation {
  return {
    key: {
      sessionId: 'session_1',
      turnId: 'turn_1',
      threadId: 'main',
      toolCallId: 'call_1',
    },
    sourceEventId: 'event_1',
    origin: 'agent',
    toolSetId: 'github-id',
    toolSetName: 'github',
    toolType: 'mcp',
    toolName: 'create_branch',
    arguments: { owner: 'truefoundry', repo: 'example', branch: 'fix/cart' },
    policyVersion: 'test-v1',
    validationViolations: [],
    ...overrides,
  };
}

function approval(overrides: Partial<ToolInvocation> = {}): PendingApproval {
  return { kind: 'approval', actionId: 'action_1', invocation: invocation(overrides) };
}

describe('required action handling', () => {
  let originalIsTTY: boolean | undefined;

  before(() => {
    originalIsTTY = stdin.isTTY;
  });

  after(() => {
    if (originalIsTTY === undefined) delete (stdin as { isTTY?: boolean }).isTTY;
    else stdin.isTTY = originalIsTTY;
  });

  test('returns no decisions when nothing is pending', async () => {
    assert.deepEqual(await requestClearance([], gate()), []);
  });

  test('denies every reviewable write when there is no interactive terminal', async () => {
    stdin.isTTY = false;
    const decisions = await requestClearance(
      [
        approval(),
        approval({ key: { ...invocation().key, toolCallId: 'call_b', threadId: 'sub_7f2a' } }),
      ],
      gate(),
    );

    assert.equal(decisions.length, 2);
    assert.deepEqual(
      decisions.map((decision) => [decision.toolCallId, decision.threadId, decision.approval.status]),
      [
        ['call_1', 'main', 'deny'],
        ['call_b', 'sub_7f2a', 'deny'],
      ],
    );
  });

  test('blocks a write outside the perimeter before asking a human', async () => {
    stdin.isTTY = true;
    const decisions = await requestClearance(
      [
        approval({
          toolName: 'create_or_update_file',
          arguments: {
            owner: 'truefoundry',
            repo: 'example',
            branch: 'fix/cart',
            path: 'src/runtime/approvals.ts',
            content: '// unsafe',
          },
        }),
      ],
      gate(),
    );

    assert.equal(decisions[0]?.approval.status, 'deny');
    assert.match((decisions[0]?.approval as { reason: string }).reason, /perimeter/i);
  });

  test('uses user.tool_response for response-required actions', async () => {
    stdin.isTTY = false;
    const pending: PendingResponse = {
      kind: 'response',
      actionId: 'response_1',
      invocation: invocation({ origin: 'client', toolName: 'ask_user' }),
    };

    const [decision] = await requestResponses([pending]);
    assert.equal(decision?.type, 'user.tool_response');
    assert.equal(decision?.toolCallId, 'call_1');
    assert.match(decision?.content ?? '', /human_response_unavailable/);
  });

  test('replays a prior decision without evaluating or prompting again', async () => {
    stdin.isTTY = false;
    const firewall = gate();
    const pending = approval();
    const first = await requestClearance([pending], firewall);
    const attempts = firewall.attempts.length;
    const second = await requestClearance([pending], firewall);

    assert.deepEqual(second, first);
    assert.equal(firewall.attempts.length, attempts, 'duplicate action must not create another attempt');
  });
});
