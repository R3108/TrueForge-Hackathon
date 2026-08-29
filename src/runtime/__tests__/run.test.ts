import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { TrueForge } from '@truefoundry/trueforge-sdk';
import { runIncident, type IncidentPolicy } from '../run.ts';
import type { StreamEvent } from '../protocol.ts';

const policy: IncidentPolicy = {
  targetRepo: 'truefoundry/example',
  baseBranch: 'main',
  writePaths: ['fixture/**'],
  githubConnector: 'github',
  githubConnectorId: 'github-id',
  policyVersion: 'test-v1',
  requireTestEvidence: false,
};

function fakeClient(events: StreamEvent[]): TrueForge {
  return {
    sessions: {
      createTurnStream: async () => ({
        withMetadata: () =>
          (async function* () {
            for (const data of events) yield { data };
          })(),
      }),
    },
  } as unknown as TrueForge;
}

describe('runIncident terminal truthfulness', () => {
  test('returns only for an explicit done state', async () => {
    const client = fakeClient([
      { type: 'turn.created', id: 'created', turnId: 'turn_1' },
      {
        type: 'turn.done',
        id: 'done',
        state: { status: 'done', output: { content: 'resolved' }, requiredActions: [] },
      },
    ]);
    const result = await runIncident(client, 'session_1', 'brief', policy);
    assert.equal(result.status, 'done');
    assert.equal(result.finalOutput, 'resolved');
    assert.equal(result.turns, 1);
  });

  test('does not report an errored turn as closed', async () => {
    const client = fakeClient([
      { type: 'turn.created', id: 'created', turnId: 'turn_1' },
      { type: 'turn.done', id: 'failed', state: { status: 'error', message: 'connector failed' } },
    ]);
    await assert.rejects(() => runIncident(client, 'session_1', 'brief', policy), /turn failed.*connector failed/i);
  });

  test('does not report a cancelled turn as closed', async () => {
    const client = fakeClient([
      { type: 'turn.created', id: 'created', turnId: 'turn_1' },
      { type: 'turn.done', id: 'cancelled', state: { status: 'cancelled', reason: 'user' } },
    ]);
    await assert.rejects(() => runIncident(client, 'session_1', 'brief', policy), /cancelled.*user/i);
  });

  test('fails closed on an unknown or nonterminal final state', async () => {
    const client = fakeClient([
      { type: 'turn.created', id: 'created', turnId: 'turn_1' },
      { type: 'turn.done', id: 'running', state: { status: 'running' } },
    ]);
    await assert.rejects(() => runIncident(client, 'session_1', 'brief', policy), /non-success state running/i);
  });
});


test('discards buffered actions when the turn later fails', async () => {
  const client = fakeClient([
    { type: 'turn.created', id: 'created', turnId: 'turn_1' },
    {
      type: 'model.message',
      id: 'message_1',
      threadId: 'main',
      toolCalls: [
        {
          id: 'call_1',
          function: { name: 'create_branch', arguments: '{}' },
          toolInfo: { type: 'mcp', name: 'create_branch', serverId: 'github-id', serverName: 'github' },
        },
      ],
    },
    {
      type: 'tool.approval_required',
      id: 'approval_1',
      threadId: 'main',
      toolCalls: [{ id: 'call_1', sourceEventId: 'message_1' }],
    },
    { type: 'turn.done', id: 'failed', state: { status: 'error', message: 'late failure' } },
  ]);
  await assert.rejects(() => runIncident(client, 'session_1', 'brief', policy), /late failure/);
});



test('run path admits structured evidence only from the configured host producer', async () => {
  const command = 'npm test -- cart';
  const client = fakeClient([
    { type: 'turn.created', id: 'created', turnId: 'turn_1' },
    {
      type: 'model.message',
      id: 'message_exec',
      threadId: 'main',
      toolCalls: [
        {
          id: 'exec_1',
          function: { name: 'sandbox_exec', arguments: JSON.stringify({ command }) },
          toolInfo: {
            type: 'truefoundry-system',
            serverId: 'trusted-host-id',
            serverName: 'trusted-host',
          },
        },
      ],
    },
    {
      type: 'tool.response',
      id: 'response_exec',
      threadId: 'main',
      toolCallId: 'exec_1',
      executionFacts: { version: 1, status: 'succeeded', exitCode: 0, timedOut: false },
      content: 'tests passed',
    },
    {
      type: 'turn.done',
      id: 'done',
      state: { status: 'done', output: { content: 'verified' }, requiredActions: [] },
    },
  ]);

  const result = await runIncident(client, 'session_1', 'brief', {
    ...policy,
    targetedCommand: command,
    trustedExecutionTool: {
      toolSetId: 'trusted-host-id',
      toolSetName: 'trusted-host',
      toolType: 'truefoundry-system',
    },
  });
  assert.equal(result.evidence.targetedTestPassed, true);
  assert.equal(result.evidence.workspaceEpoch, 0);
});

describe('informational kernel display is additive and separate from required actions', () => {
  const kernelModelLimits = { contextWindow: 100_000, maxOutputTokens: 20_000 };

  test('routes informational blocks to a supplied sink without touching required actions', async () => {
    const client = fakeClient([
      { type: 'turn.created', id: 'created', turnId: 'turn_1' },
      {
        type: 'turn.done',
        id: 'done',
        state: { status: 'done', output: { content: 'looks fixed to me' }, requiredActions: [] },
      },
    ]);

    const blocks: string[] = [];
    const result = await runIncident(client, 'session_1', 'Fix the null deref in cart.js', {
      ...policy,
      requireTestEvidence: true,
      kernel: { enabled: true, modelLimits: kernelModelLimits },
      onKernelInfo: (block) => blocks.push(block.key),
    });

    // Every informational surface the task requires appeared, keyed by stable
    // reserved capability_state names.
    assert.ok(blocks.includes('kernel.task_contract'), 'task objective/status');
    assert.ok(blocks.includes('kernel.context_plan'), 'context plan / compaction');
    assert.ok(blocks.includes('kernel.working_state'), 'phase / plan progress');
    assert.ok(blocks.includes('kernel.verification'), 'verification status');

    // Informational display never fabricates a terminal status: an unverified
    // "looks fixed" is still rewritten by the verifier.
    assert.equal(result.status, 'done');
    assert.match(result.finalOutput, /INCOMPLETE/);
  });

  test('a client that ignores informational events stays fully compatible (kernel disabled)', async () => {
    const client = fakeClient([
      { type: 'turn.created', id: 'created', turnId: 'turn_1' },
      {
        type: 'turn.done',
        id: 'done',
        state: { status: 'done', output: { content: 'resolved' }, requiredActions: [] },
      },
    ]);

    // No kernel, no sink: legacy behavior is byte-for-byte unchanged.
    const result = await runIncident(client, 'session_1', 'brief', policy);
    assert.equal(result.status, 'done');
    assert.equal(result.finalOutput, 'resolved');
    assert.equal(result.contract, undefined);
  });
});
