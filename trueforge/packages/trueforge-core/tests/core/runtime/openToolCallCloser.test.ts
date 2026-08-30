import type { AgentContextProcessorAppendContext } from '../../../src/core/capabilities/AgentContextProcessor';
import type { InternalEnrichedAssistantMessage, InternalEnrichedToolCall } from '../../../src/core/llm/LLMTypes';
import type { ContextMessage } from '../../../src/core/runtime/AgentThread.types';
import { getClosableOpenToolCallIds, OpenToolCallCloser } from '../../../src/core/runtime/OpenToolCallCloser';
import { getEmptyCurrentContextUsage } from '../../../src/core/runtime/contextUsage';
import '../harnessMocks';

function makeToolCall(
  id: string,
  toolInfo: Partial<InternalEnrichedToolCall['tool_info']> = {},
): InternalEnrichedToolCall {
  return {
    id,
    type: 'function',
    function: { name: 'test_tool', arguments: '{}' },
    tool_info: {
      type: 'mcp',
      mcp_server_id: 'test-server',
      mcp_server_name: 'test-server',
      original_tool_name: 'test_tool',
      is_approval_required: false,
      is_client_side: false,
      ...toolInfo,
    },
  };
}

function assistantWithToolCalls(toolCalls: InternalEnrichedToolCall[]): ContextMessage[] {
  const assistant: InternalEnrichedAssistantMessage = {
    role: 'assistant',
    content: '',
    tool_calls: toolCalls,
  };
  return [assistant];
}

describe('getClosableOpenToolCallIds', () => {
  it('closes ordinary dangling tool calls on the last assistant message', () => {
    const context = assistantWithToolCalls([makeToolCall('tc-1'), makeToolCall('tc-2')]);
    expect(getClosableOpenToolCallIds(context)).toEqual(new Set(['tc-1', 'tc-2']));
  });

  it('excludes tool calls that already have a matching tool response', () => {
    const context: ContextMessage[] = [
      ...assistantWithToolCalls([makeToolCall('tc-1'), makeToolCall('tc-2')]),
      { role: 'tool', tool_call_id: 'tc-1', content: 'done' },
    ];
    expect(getClosableOpenToolCallIds(context)).toEqual(new Set(['tc-2']));
  });

  it('keeps approval calls open while closing ordinary siblings', () => {
    const context = assistantWithToolCalls([
      makeToolCall('tc-ordinary'),
      makeToolCall('tc-approval', { is_approval_required: true }),
    ]);
    expect(getClosableOpenToolCallIds(context)).toEqual(new Set(['tc-ordinary']));
  });

  it('keeps client-side calls open while closing ordinary siblings', () => {
    const context = assistantWithToolCalls([
      makeToolCall('tc-ordinary'),
      makeToolCall('tc-client', { is_client_side: true }),
    ]);
    expect(getClosableOpenToolCallIds(context)).toEqual(new Set(['tc-ordinary']));
  });

  it('excludes thread-creation tool calls (is_thread_creation)', () => {
    const context = assistantWithToolCalls([
      makeToolCall('tc-regular'),
      makeToolCall('tc-sub-agent', { is_thread_creation: true }),
    ]);
    expect(getClosableOpenToolCallIds(context)).toEqual(new Set(['tc-regular']));
  });

  it('treats legacy sub-agent calls without is_thread_creation as ordinary closable calls', () => {
    const context = assistantWithToolCalls([
      makeToolCall('tc-legacy-sub-agent', {
        mcp_server_id: 'legacy-sub-agents',
        mcp_server_name: 'legacy-sub-agents',
        original_tool_name: 'create_sub_agent',
      }),
    ]);
    expect(getClosableOpenToolCallIds(context)).toEqual(new Set(['tc-legacy-sub-agent']));
  });

  it('only inspects tool calls on the last assistant message', () => {
    const context: ContextMessage[] = [
      {
        role: 'assistant',
        content: '',
        tool_calls: [makeToolCall('old-tc')],
      },
      { role: 'tool', tool_call_id: 'old-tc', content: 'resolved' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [makeToolCall('new-tc')],
      },
    ];
    expect(getClosableOpenToolCallIds(context)).toEqual(new Set(['new-tc']));
  });

  it('returns empty when there is no assistant message with tool calls', () => {
    expect(getClosableOpenToolCallIds([{ role: 'user', content: 'hello' }])).toEqual(new Set());
  });

  it('projects ambiguous write recovery as reconciliation-required without retry guidance', async () => {
    const context = assistantWithToolCalls([
      makeToolCall('tc-write'),
      makeToolCall('tc-approval', { is_approval_required: true }),
    ]);
    const closer = new OpenToolCallCloser({
      recovery_decisions: new Map([
        [
          'tc-write',
          {
            tool_call_id: 'tc-write',
            thread_id: 'main',
            attempt_id: '00000000-0000-4000-8000-000000000001',
            disposition: 'reconciliation_required',
            automatic_retry_allowed: false,
            completion_unknown: true,
            attempts_observed: 1,
            reason: 'Dispatch began without a durable completion; reconcile before any new write.',
          },
        ],
      ]),
    });

    const outputs: AgentContextProcessorAppendContext[] = [];
    for await (const output of closer.processPreSend({
      threadId: 'main',
      currentContextUsage: getEmptyCurrentContextUsage(),
      context,
    })) {
      outputs.push(output);
    }

    expect(outputs).toHaveLength(1);
    const message = outputs[0]?.context[0];
    expect(message).toMatchObject({ role: 'tool', tool_call_id: 'tc-write' });
    if (message === undefined || !('content' in message) || typeof message.content !== 'string') {
      throw new Error('expected structured tool recovery message');
    }
    expect(JSON.parse(message.content)).toEqual({
      error: 'interrupted_tool_execution',
      recovery_disposition: 'reconciliation_required',
      automatic_retry_allowed: false,
      completion_unknown: true,
      attempts_observed: 1,
      message: 'Dispatch began without a durable completion; reconcile before any new write.',
    });
  });
});
