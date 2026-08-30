import {
  EventType,
  ToolExecutionLifecycleEventSchema,
  type ToolExecutionLifecycleEvent,
} from '../../../src/core/events/schema';
import {
  InternalEnrichedAssistantMessageSchema,
  type InternalEnrichedAssistantMessage,
} from '../../../src/core/llm/LLMTypes';
import { executeToolCalls } from '../../../src/core/mcp/executeToolCalls';
import type { IToolSet } from '../../../src/core/mcp/IMCPServer';
import { isCallToolResponseResult, toolResultResponse } from '../../../src/core/mcp/IMCPServer';
import { ToolCapabilityRegistry, type ToolCapability } from '../../../src/core/mcp/ToolCapabilityRegistry';
import {
  ToolExecutionCoordinator,
  inheritedToolExecutionContext,
  type ToolExecutionContext,
  type ToolExecutionInvocation,
} from '../../../src/core/mcp/ToolExecutionCoordinator';
import { makeMockIMCPServer } from '../harnessMocks';

const CONTEXT: ToolExecutionContext = {
  session_id: 'session-1',
  turn_id: 'turn-1',
  thread_id: 'main',
  model_message_id: 'message-1',
  root_tool_call_id: null,
  parent_tool_call_id: null,
  signal: undefined,
  event_recorder: undefined,
};

function capability(input: {
  toolName: string;
  sideEffectClass: ToolCapability['side_effect_class'];
  concurrency: ToolCapability['concurrency'];
}): ToolCapability {
  return {
    stable_tool_set_id: 'server',
    tool_name: input.toolName,
    side_effect_class: input.sideEffectClass,
    retry_capability: input.sideEffectClass === 'read_only' ? 'safe' : 'never',
    concurrency: input.concurrency,
    timeout_ms: null,
    output_schema: null,
    result_size_class: 'small',
    evidence_capabilities: [],
    sensitive_argument_paths: [],
    tags: [],
  };
}

function invocation(input: {
  id: string;
  server: IToolSet | undefined;
  toolName: string;
  arguments: unknown;
}): ToolExecutionInvocation {
  return {
    tool_call_id: input.id,
    tool_set: input.server,
    tool_name: input.toolName,
    arguments: input.arguments,
    approval_decision: undefined,
  };
}

function successfulServer(toolNames: string[] = ['a', 'b']): IToolSet {
  const server = makeMockIMCPServer({ name: 'server', preload: true });
  jest
    .mocked(server.callTool)
    .mockImplementation(params => Promise.resolve(toolResultResponse({ text: `${params.name}:ok` })));
  jest.mocked(server.toolCallInfo).mockResolvedValue({
    type: 'mcp',
    mcp_server_id: 'server',
    mcp_server_name: 'server',
    original_tool_name: toolNames[0] ?? 'a',
    is_approval_required: false,
  });
  return server;
}

function textOf(response: Awaited<ReturnType<IToolSet['callTool']>>): string {
  if (!isCallToolResponseResult(response)) {
    return '';
  }
  const first = response.result.content[0];
  return first?.type === 'text' ? first.text : '';
}

function assistantMessage(): InternalEnrichedAssistantMessage {
  return InternalEnrichedAssistantMessageSchema.parse({
    role: 'assistant',
    content: null,
    tool_calls: [
      {
        id: 'unknown',
        type: 'function',
        function: { name: 'missing', arguments: '{}' },
        tool_info: {
          type: 'mcp',
          mcp_server_id: 'missing',
          mcp_server_name: 'missing',
          original_tool_name: 'missing',
          is_approval_required: false,
        },
      },
      {
        id: 'malformed',
        type: 'function',
        function: { name: 'valid', arguments: '{bad' },
        tool_info: {
          type: 'mcp',
          mcp_server_id: 'server',
          mcp_server_name: 'server',
          original_tool_name: 'valid',
          is_approval_required: false,
        },
      },
      {
        id: 'valid',
        type: 'function',
        function: { name: 'valid', arguments: '{"value":1}' },
        tool_info: {
          type: 'mcp',
          mcp_server_id: 'server',
          mcp_server_name: 'server',
          original_tool_name: 'valid',
          is_approval_required: false,
        },
      },
    ],
  });
}

describe('ToolExecutionCoordinator', () => {
  it('prepares every batch member before dispatch and fails malformed/unknown calls closed', async () => {
    const server = successfulServer();
    const coordinator = new ToolExecutionCoordinator();
    const batch = await coordinator.prepareBatch({
      invocations: [
        invocation({ id: 'valid', server, toolName: 'a', arguments: '{}' }),
        invocation({ id: 'invalid', server, toolName: 'b', arguments: '{bad' }),
        invocation({ id: 'unknown', server: undefined, toolName: 'missing', arguments: '{}' }),
      ],
      context: CONTEXT,
    });

    expect(server.callTool).not.toHaveBeenCalled();
    expect(batch.invocations.map(item => item.kind)).toEqual(['ready', 'terminal', 'terminal']);

    const outcomes = await coordinator.executeBatch({ batch, signal: undefined });
    expect(server.callTool).toHaveBeenCalledTimes(1);
    expect(outcomes.map(item => item.status)).toEqual(['succeeded', 'failed', 'failed']);
    expect(textOf(outcomes[1]?.response ?? toolResultResponse({ text: '' }))).toContain('invalid_arguments');
    expect(textOf(outcomes[2]?.response ?? toolResultResponse({ text: '' }))).toContain('unknown_tool');
  });

  it('serializes unregistered tools by conservative default', async () => {
    const server = successfulServer();
    let active = 0;
    let maximumActive = 0;
    jest.mocked(server.callTool).mockImplementation(async params => {
      active++;
      maximumActive = Math.max(maximumActive, active);
      await new Promise(resolve => setTimeout(resolve, 5));
      active--;
      return toolResultResponse({ text: params.name });
    });
    const coordinator = new ToolExecutionCoordinator();
    const batch = await coordinator.prepareBatch({
      invocations: [
        invocation({ id: 'one', server, toolName: 'a', arguments: '{}' }),
        invocation({ id: 'two', server, toolName: 'b', arguments: '{}' }),
      ],
      context: CONTEXT,
    });

    await coordinator.executeBatch({ batch, signal: undefined });
    expect(maximumActive).toBe(1);
  });

  it('parallelizes only explicitly safe calls and keeps result order', async () => {
    const server = successfulServer();
    let active = 0;
    let maximumActive = 0;
    jest.mocked(server.callTool).mockImplementation(async params => {
      active++;
      maximumActive = Math.max(maximumActive, active);
      await new Promise(resolve => setTimeout(resolve, params.name === 'a' ? 12 : 2));
      active--;
      return toolResultResponse({ text: params.name });
    });
    const registry = new ToolCapabilityRegistry([
      capability({ toolName: 'a', sideEffectClass: 'read_only', concurrency: { kind: 'parallel_safe' } }),
      capability({ toolName: 'b', sideEffectClass: 'read_only', concurrency: { kind: 'parallel_safe' } }),
    ]);
    const coordinator = new ToolExecutionCoordinator({ capabilities: registry });
    const batch = await coordinator.prepareBatch({
      invocations: [
        invocation({ id: 'one', server, toolName: 'a', arguments: '{}' }),
        invocation({ id: 'two', server, toolName: 'b', arguments: '{}' }),
      ],
      context: CONTEXT,
    });

    const outcomes = await coordinator.executeBatch({ batch, signal: undefined });
    expect(maximumActive).toBe(2);
    expect(outcomes.map(item => item.invocation_key.tool_call_id)).toEqual(['one', 'two']);
    expect(outcomes.map(item => textOf(item.response))).toEqual(['a', 'b']);
  });

  it('serializes conflicting resources while allowing disjoint resources to overlap', async () => {
    const server = successfulServer(['same-a', 'same-b', 'other']);
    let active = 0;
    let maximumActive = 0;
    jest.mocked(server.callTool).mockImplementation(async params => {
      active++;
      maximumActive = Math.max(maximumActive, active);
      await new Promise(resolve => setTimeout(resolve, 5));
      active--;
      return toolResultResponse({ text: params.name });
    });
    const registry = new ToolCapabilityRegistry([
      capability({
        toolName: 'same-a',
        sideEffectClass: 'workspace_write',
        concurrency: { kind: 'resource_scoped', resources: ['file:a'] },
      }),
      capability({
        toolName: 'same-b',
        sideEffectClass: 'workspace_write',
        concurrency: { kind: 'resource_scoped', resources: ['file:a'] },
      }),
      capability({
        toolName: 'other',
        sideEffectClass: 'workspace_write',
        concurrency: { kind: 'resource_scoped', resources: ['file:b'] },
      }),
    ]);
    const coordinator = new ToolExecutionCoordinator({ capabilities: registry });
    const batch = await coordinator.prepareBatch({
      invocations: [
        invocation({ id: 'one', server, toolName: 'same-a', arguments: '{}' }),
        invocation({ id: 'two', server, toolName: 'same-b', arguments: '{}' }),
        invocation({ id: 'three', server, toolName: 'other', arguments: '{}' }),
      ],
      context: CONTEXT,
    });

    await coordinator.executeBatch({ batch, signal: undefined });
    expect(maximumActive).toBe(2);
    expect(server.callTool).toHaveBeenCalledTimes(3);
  });

  it('distinguishes cancellation before dispatch', async () => {
    const server = successfulServer();
    const controller = new AbortController();
    controller.abort('stop');
    const coordinator = new ToolExecutionCoordinator();
    const batch = await coordinator.prepareBatch({
      invocations: [invocation({ id: 'cancelled', server, toolName: 'a', arguments: '{}' })],
      context: { ...CONTEXT, signal: controller.signal },
    });
    const outcomes = await coordinator.executeBatch({ batch, signal: controller.signal });

    expect(server.callTool).not.toHaveBeenCalled();
    expect(outcomes[0]?.failure_class).toBe('cancelled');
    expect(outcomes[0]?.started_at).toBeNull();
  });

  it('marks a thrown unclassified write unknown and never retries it', async () => {
    const server = successfulServer();
    jest.mocked(server.callTool).mockRejectedValue(new Error('connection lost'));
    const coordinator = new ToolExecutionCoordinator();
    const events: ToolExecutionLifecycleEvent[] = [];
    const outcome = await coordinator.executeInvocation({
      invocation: invocation({ id: 'write', server, toolName: 'write', arguments: '{}' }),
      context: {
        ...CONTEXT,
        event_recorder: event => {
          events.push(event);
          return Promise.resolve();
        },
      },
    });

    expect(server.callTool).toHaveBeenCalledTimes(1);
    expect(outcome.status).toBe('unknown');
    expect(outcome.failure_class).toBe('transport_after_dispatch');
    const completed = events.find(event => event.type === EventType.TOOL_ATTEMPT_COMPLETED);
    expect(completed).toMatchObject({ status: 'unknown', failure_class: 'transport_after_dispatch' });
    expect(textOf(outcome.response)).toContain('tool_completion_unknown');
    await expect(coordinator.reconcile({ outcome })).resolves.toEqual({
      status: 'unknown',
      retry_allowed: false,
      reason: 'No host reconciliation adapter is registered; fail closed and require human review.',
    });
  });

  it('persists prepared, started, and completed lifecycle events around dispatch', async () => {
    const server = successfulServer();
    const events: ToolExecutionLifecycleEvent[] = [];
    jest.mocked(server.callTool).mockImplementation(params => {
      expect(events.some(event => event.type === EventType.TOOL_ATTEMPT_STARTED)).toBe(true);
      return Promise.resolve(toolResultResponse({ text: params.name }));
    });
    const coordinator = new ToolExecutionCoordinator();
    const context: ToolExecutionContext = {
      ...CONTEXT,
      event_recorder: event => {
        events.push(ToolExecutionLifecycleEventSchema.parse(event));
        return Promise.resolve();
      },
    };

    const batch = await coordinator.prepareBatch({
      invocations: [
        invocation({ id: 'valid', server, toolName: 'a', arguments: '{}' }),
        invocation({ id: 'invalid', server, toolName: 'b', arguments: '{bad' }),
      ],
      context,
    });

    expect(events.map(event => event.type)).toEqual([EventType.TOOL_PREPARED, EventType.TOOL_PREPARED]);
    const outcomes = await coordinator.executeBatch({ batch, signal: undefined });
    expect(outcomes).toHaveLength(2);
    expect(events.map(event => event.type)).toEqual([
      EventType.TOOL_PREPARED,
      EventType.TOOL_PREPARED,
      EventType.TOOL_ATTEMPT_STARTED,
      EventType.TOOL_ATTEMPT_COMPLETED,
      EventType.TOOL_ATTEMPT_COMPLETED,
    ]);
    expect(events.every(event => event.session_id === 'session-1' && event.turn_id === 'turn-1')).toBe(true);
    expect(events.filter(event => event.tool_call_id === 'valid').map(event => event.attempt_id)).toEqual([
      batch.invocations[0]?.attempt_id,
      batch.invocations[0]?.attempt_id,
      batch.invocations[0]?.attempt_id,
    ]);
  });

  it('does not dispatch when the durable attempt-start barrier fails', async () => {
    const server = successfulServer();
    const coordinator = new ToolExecutionCoordinator();
    const batch = await coordinator.prepareBatch({
      invocations: [invocation({ id: 'blocked', server, toolName: 'a', arguments: '{}' })],
      context: {
        ...CONTEXT,
        event_recorder: event =>
          event.type === EventType.TOOL_ATTEMPT_STARTED
            ? Promise.reject(new Error('store unavailable'))
            : Promise.resolve(),
      },
    });

    await expect(coordinator.executeBatch({ batch, signal: undefined })).rejects.toThrow('store unavailable');
    expect(server.callTool).not.toHaveBeenCalled();
  });

  it('resolves required actions before dispatch without recording a false attempt start', async () => {
    const server = successfulServer();
    server.prepareToolCall = jest.fn().mockResolvedValue({
      kind: 'required_action',
      response: {
        approvalRequired: {
          tool_info: {
            type: 'mcp',
            mcp_server_id: 'server',
            mcp_server_name: 'server',
            original_tool_name: 'write',
            is_approval_required: true,
          },
        },
      },
    });
    const events: ToolExecutionLifecycleEvent[] = [];
    const coordinator = new ToolExecutionCoordinator();
    const outcome = await coordinator.executeInvocation({
      invocation: invocation({ id: 'approval', server, toolName: 'write', arguments: '{}' }),
      context: {
        ...CONTEXT,
        event_recorder: event => {
          events.push(ToolExecutionLifecycleEventSchema.parse(event));
          return Promise.resolve();
        },
      },
    });

    expect(server.prepareToolCall).toHaveBeenCalledTimes(1);
    expect(server.callTool).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ status: 'required_action', failure_class: null, started_at: null });
    expect(events.map(event => event.type)).toEqual([EventType.TOOL_PREPARED, EventType.TOOL_ATTEMPT_COMPLETED]);
    expect(events[1]).toMatchObject({
      type: EventType.TOOL_ATTEMPT_COMPLETED,
      status: 'required_action',
      failure_class: null,
      started_at: null,
    });
  });

  it('leaves a started-without-completed record when completion persistence fails after dispatch', async () => {
    const server = successfulServer();
    const persistedTypes: string[] = [];
    const coordinator = new ToolExecutionCoordinator();
    const execution = coordinator.executeInvocation({
      invocation: invocation({ id: 'write', server, toolName: 'write', arguments: '{}' }),
      context: {
        ...CONTEXT,
        event_recorder: event => {
          if (event.type === EventType.TOOL_ATTEMPT_COMPLETED) {
            return Promise.reject(new Error('completion store failure'));
          }
          persistedTypes.push(event.type);
          return Promise.resolve();
        },
      },
    });

    await expect(execution).rejects.toThrow('completion store failure');
    expect(server.callTool).toHaveBeenCalledTimes(1);
    expect(persistedTypes).toEqual([EventType.TOOL_PREPARED, EventType.TOOL_ATTEMPT_STARTED]);
  });

  it('records cancellation after dispatch as unknown for an unclassified write', async () => {
    const server = successfulServer();
    const controller = new AbortController();
    const events: ToolExecutionLifecycleEvent[] = [];
    jest.mocked(server.callTool).mockImplementation(() => {
      controller.abort('stop');
      return new Promise<Awaited<ReturnType<IToolSet['callTool']>>>(() => undefined);
    });
    const coordinator = new ToolExecutionCoordinator();
    const outcome = await coordinator.executeInvocation({
      invocation: invocation({ id: 'cancelled-write', server, toolName: 'write', arguments: '{}' }),
      context: {
        ...CONTEXT,
        signal: controller.signal,
        event_recorder: event => {
          events.push(event);
          return Promise.resolve();
        },
      },
    });

    expect(outcome.status).toBe('unknown');
    expect(outcome.failure_class).toBe('cancelled_after_dispatch');
    expect(events.map(event => event.type)).toEqual([
      EventType.TOOL_PREPARED,
      EventType.TOOL_ATTEMPT_STARTED,
      EventType.TOOL_ATTEMPT_COMPLETED,
    ]);
    const completed = events[2];
    expect(completed?.type).toBe(EventType.TOOL_ATTEMPT_COMPLETED);
    if (completed?.type !== EventType.TOOL_ATTEMPT_COMPLETED) throw new Error('expected completion event');
    expect(completed.status).toBe('unknown');
    expect(completed.failure_class).toBe('cancelled_after_dispatch');
  });

  it('inherits durable root and parent identity for nested coordinator calls', async () => {
    const outerServer = successfulServer(['outer']);
    const innerServer = successfulServer(['inner']);
    const events: ToolExecutionLifecycleEvent[] = [];
    const coordinator = new ToolExecutionCoordinator();
    jest.mocked(outerServer.callTool).mockImplementation(async () => {
      const nestedContext = inheritedToolExecutionContext({ fallbackThreadId: 'unused' });
      const innerOutcome = await coordinator.executeInvocation({
        invocation: invocation({ id: 'code:outer:1', server: innerServer, toolName: 'inner', arguments: '{}' }),
        context: nestedContext,
      });
      return innerOutcome.response;
    });

    await coordinator.executeInvocation({
      invocation: invocation({ id: 'outer', server: outerServer, toolName: 'outer', arguments: '{}' }),
      context: {
        ...CONTEXT,
        event_recorder: event => {
          events.push(event);
          return Promise.resolve();
        },
      },
    });

    const nestedPrepared = events.find(
      event => event.type === EventType.TOOL_PREPARED && event.tool_call_id === 'code:outer:1',
    );
    expect(nestedPrepared).toMatchObject({
      session_id: 'session-1',
      turn_id: 'turn-1',
      thread_id: 'main',
      model_message_id: 'message-1',
      root_tool_call_id: 'outer',
      parent_tool_call_id: 'outer',
      stable_tool_set_id: 'server',
      tool_name: 'inner',
    });
  });

  it('fingerprints canonical arguments and preserves complete invocation identity', async () => {
    const server = successfulServer();
    const coordinator = new ToolExecutionCoordinator();
    const batch = await coordinator.prepareBatch({
      invocations: [
        invocation({ id: 'one', server, toolName: 'a', arguments: '{"b":2,"a":1}' }),
        invocation({ id: 'two', server, toolName: 'a', arguments: { a: 1, b: 2 } }),
      ],
      context: { ...CONTEXT, root_tool_call_id: 'root', parent_tool_call_id: 'parent' },
    });

    expect(batch.invocations[0]?.argument_fingerprint).toBe(batch.invocations[1]?.argument_fingerprint);
    expect(batch.invocations[0]?.invocation_key).toEqual({
      session_id: 'session-1',
      turn_id: 'turn-1',
      thread_id: 'main',
      model_message_id: 'message-1',
      stable_tool_set_id: 'server',
      tool_name: 'a',
      tool_call_id: 'one',
      root_tool_call_id: 'root',
      parent_tool_call_id: 'parent',
    });
  });

  it('projects exactly one ordered model-visible result for unknown, malformed, and successful calls', async () => {
    const server = successfulServer(['valid']);
    const result = await executeToolCalls({
      assistantMessage: assistantMessage(),
      toolMapping: new Map([['valid', { toolSet: server, originalToolName: 'valid' }]]),
      threadId: 'main',
      approvalDecisions: new Map(),
    });

    expect(result.toolCallResults).toHaveLength(3);
    expect(result.toolCallResults.map(item => item.message.tool_call_id)).toEqual(['unknown', 'malformed', 'valid']);
    expect(server.callTool).toHaveBeenCalledTimes(1);
  });

  it('keeps returned MCP domain errors eligible for normal response offloading', async () => {
    const server = successfulServer(['valid']);
    jest
      .mocked(server.callTool)
      .mockResolvedValue(toolResultResponse({ text: 'provider domain error details', isError: true }));

    const result = await executeToolCalls({
      assistantMessage: assistantMessage(),
      toolMapping: new Map([['valid', { toolSet: server, originalToolName: 'valid' }]]),
      threadId: 'main',
      approvalDecisions: new Map(),
    });

    expect(result.toolCallResults.map(item => item.failure)).toEqual([true, true, false]);
    expect(result.toolCallResults[2]?.message.content).toContain('provider domain error details');
  });

  it('retries a host-classified safe read once with a fresh durable attempt id', async () => {
    const server = successfulServer(['read']);
    server.getToolCapability = () =>
      capability({ toolName: 'read', sideEffectClass: 'read_only', concurrency: { kind: 'parallel_safe' } });
    jest
      .mocked(server.callTool)
      .mockRejectedValueOnce(new Error('transient disconnect'))
      .mockResolvedValueOnce(toolResultResponse({ text: 'recovered' }));
    const events: ToolExecutionLifecycleEvent[] = [];
    const coordinator = new ToolExecutionCoordinator();

    const outcome = await coordinator.executeInvocation({
      invocation: invocation({ id: 'safe-read', server, toolName: 'read', arguments: '{}' }),
      context: {
        ...CONTEXT,
        event_recorder: event => {
          events.push(ToolExecutionLifecycleEventSchema.parse(event));
          return Promise.resolve();
        },
      },
    });

    expect(outcome.status).toBe('succeeded');
    expect(textOf(outcome.response)).toBe('recovered');
    expect(server.callTool).toHaveBeenCalledTimes(2);
    expect(events.map(event => event.type)).toEqual([
      EventType.TOOL_PREPARED,
      EventType.TOOL_ATTEMPT_STARTED,
      EventType.TOOL_ATTEMPT_COMPLETED,
      EventType.TOOL_PREPARED,
      EventType.TOOL_ATTEMPT_STARTED,
      EventType.TOOL_ATTEMPT_COMPLETED,
    ]);
    expect(new Set(events.map(event => event.attempt_id)).size).toBe(2);
    expect(events[2]).toMatchObject({ status: 'failed', failure_class: 'transport_after_dispatch' });
    expect(events[5]).toMatchObject({ status: 'succeeded', failure_class: null });
  });

  it('does not retry a host-classified write after dispatch', async () => {
    const server = successfulServer(['write']);
    server.getToolCapability = () =>
      capability({ toolName: 'write', sideEffectClass: 'remote_write', concurrency: { kind: 'exclusive' } });
    jest.mocked(server.callTool).mockRejectedValue(new Error('ambiguous disconnect'));

    const outcome = await new ToolExecutionCoordinator().executeInvocation({
      invocation: invocation({ id: 'write', server, toolName: 'write', arguments: '{}' }),
      context: CONTEXT,
    });

    expect(server.callTool).toHaveBeenCalledTimes(1);
    expect(outcome).toMatchObject({ status: 'unknown', failure_class: 'transport_after_dispatch' });
  });
});
