import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { stdin } from 'node:process';
import { requestResponses } from '../approvals.ts';
import type { PendingAction, PendingResponse, ToolInvocation } from '../contracts.ts';
import { EvidenceLedger } from '../evidence.ts';
import { ToolCallGate } from '../gate.ts';
import { resolveRequiredAction, toolCallsOf, type StreamEvent } from '../protocol.ts';
import { invocationFromCall, orderContinuationInputs, type IncidentPolicy } from '../run.ts';

const policy: IncidentPolicy = {
  targetRepo: 'truefoundry/example',
  baseBranch: 'main',
  writePaths: ['fixture/**'],
  githubConnector: 'github',
  githubConnectorId: 'github-id',
  policyVersion: 'test-v1',
  requireTestEvidence: false,
  trustedExecutionTool: {
    toolSetId: 'trusted-host-id',
    toolSetName: 'trusted-host',
    toolType: 'truefoundry-system',
  },
};

function writeInvocation(id: string): ToolInvocation {
  return {
    key: { sessionId: 's1', turnId: 't1', threadId: 'main', toolCallId: id },
    sourceEventId: `event_${id}`,
    origin: 'client',
    toolSetId: 'github-id',
    toolSetName: 'github',
    toolType: 'mcp',
    toolName: 'create_or_update_file',
    arguments: {
      owner: 'truefoundry',
      repo: 'example',
      branch: 'fix/cart',
      path: 'fixture/cart.js',
      content: 'fixed',
    },
    policyVersion: 'test-v1',
    validationViolations: [],
  };
}

describe('live-path audit regressions', () => {
  let originalIsTTY: boolean | undefined;

  before(() => {
    originalIsTTY = stdin.isTTY;
  });

  after(() => {
    if (originalIsTTY === undefined) delete (stdin as { isTTY?: boolean }).isTTY;
    else stdin.isTTY = originalIsTTY;
  });

  test('derives sandbox origin only from the configured stable execution identity', () => {
    const event: StreamEvent = {
      type: 'model.message',
      id: 'message_1',
      threadId: 'main',
      toolCalls: [
        {
          id: 'exec_1',
          function: { name: 'sandbox_exec', arguments: '{"command":"npm test"}' },
          toolInfo: {
            type: 'truefoundry-system',
            serverId: 'trusted-host-id',
            serverName: 'trusted-host',
          },
        },
      ],
    };
    const [call] = toolCallsOf(event);
    assert.ok(call);
    const trusted = invocationFromCall('s1', 't1', event, call, policy);
    assert.equal(trusted.origin, 'sandbox');

    const untrusted = invocationFromCall('s1', 't1', event, { ...call, toolSetId: 'other' }, policy);
    assert.equal(untrusted.origin, 'agent');
  });

  test('rejects an incomplete sibling reference instead of silently dropping it', () => {
    const source: StreamEvent = {
      type: 'model.message',
      id: 'message_1',
      threadId: 'main',
      toolCalls: [{ id: 'call_1', function: { name: 'create_branch', arguments: '{}' } }],
    };
    const action: StreamEvent = {
      type: 'tool.approval_required',
      id: 'approval_1',
      threadId: 'main',
      toolCalls: [
        { id: 'call_1', sourceEventId: 'message_1' },
        { id: 'missing-source' },
      ],
    };
    assert.throws(
      () =>
        resolveRequiredAction(action, new Map([['message_1', source]]), {
          sessionId: 's1',
          turnId: 't1',
          policyVersion: 'test-v1',
        }),
      /both call ID and source event ID/,
    );
  });

  test('rejects a configured GitHub write delivered through response_required', async () => {
    stdin.isTTY = false;
    const invocation = writeInvocation('write_response');
    const pending: PendingResponse = { kind: 'response', actionId: 'response_1', invocation };
    const gate = new ToolCallGate(policy, new EvidenceLedger(), Buffer.alloc(32, 13));

    const [decision] = await requestResponses([pending], gate);
    assert.equal(decision?.type, 'user.tool_response');
    assert.match(decision?.content ?? '', /unexpected_required_action_kind/);
    assert.equal(gate.attempts.length, 1);
    assert.equal(gate.attempts[0]?.state, 'blocked');
  });

  test('preserves original mixed action order and rejects missing results', () => {
    const approvalInvocation = writeInvocation('approval_1');
    const responseInvocation = { ...writeInvocation('response_1'), toolName: 'ask_user' };
    const pending: PendingAction[] = [
      { kind: 'response', actionId: 'r', invocation: responseInvocation },
      { kind: 'approval', actionId: 'a', invocation: approvalInvocation },
    ];
    const approvals = [
      {
        type: 'user.tool_approval' as const,
        threadId: 'main',
        toolCallId: 'approval_1',
        approval: { status: 'deny' as const, reason: 'no' },
      },
    ];
    const responses = [
      {
        type: 'user.tool_response' as const,
        threadId: 'main',
        toolCallId: 'response_1',
        content: 'answer',
      },
    ];

    assert.deepEqual(
      orderContinuationInputs(pending, approvals, responses).map((item) => item.type),
      ['user.tool_response', 'user.tool_approval'],
    );
    assert.throws(() => orderContinuationInputs(pending, approvals, []), /No user.tool_response/);
  });
});
