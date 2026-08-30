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

  test('a green evidence ledger completes harness-inferred criteria instead of always blocking', async () => {
    // Regression: admission seeded every criterion as remaining and nothing
    // ever emitted criterion_satisfied, so even a fully verified repair was
    // rewritten as INCOMPLETE. The evidence projection must clear the
    // harness-inferred criteria their typed evidence vouches for.
    const targeted = 'npm test -- --test-name-pattern cart';
    const fullSuite = 'npm test';
    const execEvent = (callId: string, eventId: string, command: string, exitCode: number) => [
      {
        type: 'model.message',
        id: eventId,
        threadId: 'main',
        toolCalls: [
          {
            id: callId,
            function: { name: 'sandbox_exec', arguments: JSON.stringify({ command }) },
            toolInfo: { type: 'truefoundry-system', serverId: 'trusted-host-id', serverName: 'trusted-host' },
          },
        ],
      },
      {
        type: 'tool.response',
        id: `response_${callId}`,
        threadId: 'main',
        toolCallId: callId,
        executionFacts: { version: 1, status: exitCode === 0 ? 'succeeded' : 'failed', exitCode, timedOut: false },
        content: 'tests passed',
      },
    ];

    // A failing run first (regression observed), then the green targeted and
    // full-suite runs - all through the trusted host producer.
    const client = fakeClient([
      { type: 'turn.created', id: 'created', turnId: 'turn_1' },
      ...execEvent('exec_red', 'event_red', targeted, 1),
      ...execEvent('exec_targeted', 'event_targeted', targeted, 0),
      ...execEvent('exec_suite', 'event_suite', fullSuite, 0),
      {
        type: 'turn.done',
        id: 'done',
        state: {
          status: 'done',
          output: { content: 'Fixed. The failing test is green and the suite passes.' },
          requiredActions: [],
        },
      },
    ]);

    const result = await runIncident(
      client,
      'session_1',
      'Production incident: fix the null deref in cart.js',
      {
        ...policy,
        requireTestEvidence: true,
        targetedCommand: targeted,
        fullSuiteCommand: fullSuite,
        trustedExecutionTool: {
          toolSetId: 'trusted-host-id',
          toolSetName: 'trusted-host',
          toolType: 'truefoundry-system',
        },
        kernel: { enabled: true, modelLimits: { contextWindow: 100_000, maxOutputTokens: 20_000 } },
      },
    );

    assert.equal(result.evidence.regressionObserved, true);
    assert.equal(result.evidence.targetedTestPassed, true);
    assert.equal(result.evidence.fullSuitePassed, true);
    assert.doesNotMatch(result.finalOutput, /INCOMPLETE/, 'green evidence must complete the task');
  });

  test('the flagship flow - red test, fix write, green tests, opened PR - completes', async () => {
    // The real repair sequence, with every epoch bump: the fix write and the
    // PR creation are both remote mutations, so the red record necessarily
    // ends historical and the green records are only current until the PR
    // response arrives. Treating the historical red as stale blocked every
    // genuine repair; this test pins the whole flow to completion.
    const targeted = 'npm test -- --test-name-pattern cart';
    const fullSuite = 'npm test';
    const githubWrite = (callId: string, eventId: string, toolName: string, args: unknown) => [
      {
        type: 'model.message',
        id: eventId,
        threadId: 'main',
        toolCalls: [
          {
            id: callId,
            function: { name: toolName, arguments: JSON.stringify(args) },
            toolInfo: { type: 'mcp', serverId: 'github-id', serverName: 'github' },
          },
        ],
      },
      {
        type: 'tool.response',
        id: `response_${callId}`,
        threadId: 'main',
        toolCallId: callId,
        content: 'done',
      },
    ];
    const execEvent = (callId: string, eventId: string, command: string, exitCode: number) => [
      {
        type: 'model.message',
        id: eventId,
        threadId: 'main',
        toolCalls: [
          {
            id: callId,
            function: { name: 'sandbox_exec', arguments: JSON.stringify({ command }) },
            toolInfo: { type: 'truefoundry-system', serverId: 'trusted-host-id', serverName: 'trusted-host' },
          },
        ],
      },
      {
        type: 'tool.response',
        id: `response_${callId}`,
        threadId: 'main',
        toolCallId: callId,
        executionFacts: { version: 1, status: exitCode === 0 ? 'succeeded' : 'failed', exitCode, timedOut: false },
        content: 'tests passed',
      },
    ];

    const client = fakeClient([
      { type: 'turn.created', id: 'created', turnId: 'turn_1' },
      // 1. Red test at epoch 0.
      ...execEvent('exec_red', 'event_red', targeted, 1),
      // 2. The fix write - a remote mutation, epoch 1, red record invalidated.
      ...githubWrite('write_fix', 'event_fix', 'create_or_update_file', {
        owner: 'truefoundry',
        repo: 'example',
        branch: 'fix/cart',
        path: 'src/cart.js',
        content: '// the fix',
      }),
      // 3. Green targeted + suite at epoch 1.
      ...execEvent('exec_targeted', 'event_targeted', targeted, 0),
      ...execEvent('exec_suite', 'event_suite', fullSuite, 0),
      // 4. The PR. Publication does NOT bump the workspace epoch (it changes
      //    no code the tests ran against - only content mutations do), so the
      //    green records stay current. That is exactly why completion holds.
      ...githubWrite('open_pr', 'event_pr', 'create_pull_request', {
        owner: 'truefoundry',
        repo: 'example',
        title: 'Fix null deref',
        head: 'fix/cart',
        base: 'main',
      }),
      {
        type: 'turn.done',
        id: 'done',
        state: {
          status: 'done',
          output: { content: 'Fixed and the pull request is open.' },
          requiredActions: [],
        },
      },
    ]);

    const result = await runIncident(
      client,
      'session_1',
      'Production incident: fix the null deref in cart.js',
      {
        ...policy,
        requireTestEvidence: true,
        targetedCommand: targeted,
        fullSuiteCommand: fullSuite,
        trustedExecutionTool: {
          toolSetId: 'trusted-host-id',
          toolSetName: 'trusted-host',
          toolType: 'truefoundry-system',
        },
        kernel: { enabled: true, modelLimits: { contextWindow: 100_000, maxOutputTokens: 20_000 } },
      },
    );

    assert.equal(result.evidence.regressionObserved, true);
    assert.equal(result.evidence.regressionIsHistorical, true, 'the fix write preceded the green runs');
    assert.equal(result.evidence.targetedTestPassed, true, 'PR publication does not invalidate green evidence');
    assert.doesNotMatch(result.finalOutput, /INCOMPLETE/, 'the flagship flow must complete');
  });
});
