import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRequiredAction, toolCallsOf, type StreamEvent } from '../protocol.ts';

const source: StreamEvent = {
  type: 'model.message',
  id: 'message_1',
  threadId: 'main',
  toolCalls: [
    {
      id: 'call_a',
      function: { name: 'create_branch', arguments: '{"branch":"fix/a"}' },
      toolInfo: { type: 'mcp', name: 'tool', serverId: 'github-id', serverName: 'github' },
    },
    {
      id: 'call_b',
      function: { name: 'create_pull_request', arguments: '{"head":"fix/b"}' },
      toolInfo: { type: 'mcp', name: 'tool', serverId: 'github-id', serverName: 'github' },
    },
  ],
};

const context = { sessionId: 'session_1', turnId: 'turn_1', policyVersion: 'v1' };

describe('exact required-action correlation', () => {
  test('resolves approval for the second call rather than tool_calls[0]', () => {
    const action: StreamEvent = {
      type: 'tool.approval_required',
      id: 'action_1',
      threadId: 'main',
      toolCalls: [{ id: 'call_b', sourceEventId: 'message_1' }],
    };
    const [pending] = resolveRequiredAction(action, new Map([['message_1', source]]), context);
    assert.equal(pending?.kind, 'approval');
    assert.equal(pending?.invocation.key.toolCallId, 'call_b');
    assert.equal(pending?.invocation.toolName, 'create_pull_request');
  });

  test('resolves every reference in toolCalls[]', () => {
    const action: StreamEvent = {
      type: 'tool.approval_required',
      id: 'action_1',
      threadId: 'main',
      toolCalls: [
        { id: 'call_a', sourceEventId: 'message_1' },
        { id: 'call_b', sourceEventId: 'message_1' },
      ],
    };
    const pending = resolveRequiredAction(action, new Map([['message_1', source]]), context);
    assert.deepEqual(pending.map((item) => item.invocation.key.toolCallId), ['call_a', 'call_b']);
  });

  test('preserves response actions instead of converting them to approvals', () => {
    const subSource: StreamEvent = { ...source, id: 'message_sub', threadId: 'sub_1' };
    const action: StreamEvent = {
      type: 'tool.response_required',
      id: 'response_1',
      threadId: 'sub_1',
      toolCalls: [{ id: 'call_a', sourceEventId: 'message_sub' }],
    };
    const [pending] = resolveRequiredAction(action, new Map([['message_sub', subSource]]), context);
    assert.equal(pending?.kind, 'response');
    assert.equal(pending?.invocation.key.threadId, 'sub_1');
  });

  test('fails closed on missing source events and unresolved IDs', () => {
    const missing: StreamEvent = {
      type: 'tool.approval_required',
      id: 'action_1',
      toolCalls: [{ id: 'call_a', sourceEventId: 'missing' }],
    };
    assert.throws(() => resolveRequiredAction(missing, new Map(), context), /missing model event/);

    const wrong: StreamEvent = {
      type: 'tool.approval_required',
      id: 'action_2',
      toolCalls: [{ id: 'call_z', sourceEventId: 'message_1' }],
    };
    assert.throws(
      () => resolveRequiredAction(wrong, new Map([['message_1', source]]), context),
      /exactly one addressable call/,
    );
  });

  test('reports invalid JSON without replacing it with an empty object', () => {
    const calls = toolCallsOf({
      type: 'model.message',
      toolCalls: [{ id: 'bad', function: { name: 'push_files', arguments: '{bad' } }],
    });
    assert.equal(calls[0]?.arguments, '{bad');
    assert.equal(calls[0]?.validationViolations[0]?.code, 'invalid_json');
  });

  test('keeps duplicate call IDs isolated by source event and thread', () => {
    const otherSource: StreamEvent = {
      ...source,
      id: 'message_2',
      threadId: 'sub_2',
      toolCalls: [
        {
          id: 'call_a',
          function: { name: 'create_issue', arguments: '{"title":"x"}' },
        },
      ],
    };
    const action: StreamEvent = {
      type: 'tool.approval_required',
      id: 'action_sub',
      threadId: 'sub_2',
      toolCalls: [{ id: 'call_a', sourceEventId: 'message_2' }],
    };
    const [pending] = resolveRequiredAction(
      action,
      new Map([
        ['message_1', source],
        ['message_2', otherSource],
      ]),
      context,
    );
    assert.equal(pending?.invocation.toolName, 'create_issue');
    assert.equal(pending?.invocation.key.threadId, 'sub_2');
  });
});


describe('continuation address integrity', () => {
  test('rejects a source/action thread mismatch', () => {
    const action: StreamEvent = {
      type: 'tool.approval_required',
      id: 'wrong-thread',
      threadId: 'sub',
      toolCalls: [{ id: 'call_a', sourceEventId: 'message_1' }],
    };
    assert.throws(
      () => resolveRequiredAction(action, new Map([['message_1', source]]), context),
      /does not match source thread/,
    );
  });

  test('rejects duplicate same-thread call IDs across model messages', () => {
    const duplicateSource: StreamEvent = {
      ...source,
      id: 'message_duplicate',
      toolCalls: [
        { id: 'call_a', function: { name: 'create_issue', arguments: '{}' } },
      ],
    };
    const action: StreamEvent = {
      type: 'tool.approval_required',
      id: 'ambiguous',
      threadId: 'main',
      toolCalls: [{ id: 'call_a', sourceEventId: 'message_1' }],
    };
    assert.throws(
      () =>
        resolveRequiredAction(
          action,
          new Map([
            ['message_1', source],
            ['message_duplicate', duplicateSource],
          ]),
          context,
        ),
      /exactly one addressable call/,
    );
  });

  test('rejects duplicate references in one required action', () => {
    const action: StreamEvent = {
      type: 'tool.approval_required',
      id: 'duplicate-ref',
      threadId: 'main',
      toolCalls: [
        { id: 'call_a', sourceEventId: 'message_1' },
        { id: 'call_a', sourceEventId: 'message_1' },
      ],
    };
    assert.throws(
      () => resolveRequiredAction(action, new Map([['message_1', source]]), context),
      /duplicate reference/,
    );
  });

  test('preserves trusted MCP provenance', () => {
    const [call] = toolCallsOf(source);
    assert.equal(call?.toolSetId, 'github-id');
    assert.equal(call?.toolSetName, 'github');
    assert.equal(call?.toolType, 'mcp');
  });
});
