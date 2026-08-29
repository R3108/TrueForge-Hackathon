import { EventType, type ToolExecutionLifecycleEvent } from '../../../src/core/events/schema';
import type { IToolSet } from '../../../src/core/mcp/IMCPServer';
import { isCallToolResponseResult, toolResultResponse } from '../../../src/core/mcp/IMCPServer';
import {
  ToolExecutionCoordinator,
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

const NAME_SCHEMA = {
  type: 'object' as const,
  properties: { name: { type: 'string' } },
  required: ['name'],
  additionalProperties: false,
};

function serverWithSchema(schemas: Record<string, unknown>): IToolSet {
  const server = makeMockIMCPServer({ name: 'server', preload: true, inputSchemas: schemas });
  jest
    .mocked(server.callTool)
    .mockImplementation(params => Promise.resolve(toolResultResponse({ text: `${params.name}:ok` })));
  jest.mocked(server.toolCallInfo).mockResolvedValue({
    type: 'mcp',
    mcp_server_id: 'server',
    mcp_server_name: 'server',
    original_tool_name: 'do',
    is_approval_required: false,
  });
  return server;
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

function textOf(response: Awaited<ReturnType<IToolSet['callTool']>>): string {
  if (!isCallToolResponseResult(response)) {
    return '';
  }
  const first = response.result.content[0];
  return first?.type === 'text' ? first.text : '';
}

describe('ToolExecutionCoordinator input-schema validation', () => {
  it('fails an input-schema violation closed before dispatch and never reaches callTool', async () => {
    const server = serverWithSchema({ do: NAME_SCHEMA });
    const coordinator = new ToolExecutionCoordinator();
    const batch = await coordinator.prepareBatch({
      invocations: [invocation({ id: 'bad', server, toolName: 'do', arguments: '{"name":5}' })],
      context: CONTEXT,
    });

    expect(batch.invocations[0]?.kind).toBe('terminal');
    const outcomes = await coordinator.executeBatch({ batch, signal: undefined });
    expect(server.callTool).not.toHaveBeenCalled();
    expect(outcomes[0]?.status).toBe('failed');
    expect(outcomes[0]?.failure_class).toBe('validation');

    const body = JSON.parse(textOf(outcomes[0]?.response ?? toolResultResponse({ text: '{}' }))) as {
      error: string;
      violations: { path: string; keyword: string }[];
      truncated: boolean;
    };
    expect(body.error).toBe('input_schema_validation_failed');
    expect(body.violations).toEqual([{ path: '/name', keyword: 'type', message: expect.any(String) }]);
    expect(body.truncated).toBe(false);
  });

  it('never reaches preflight/policy for an invalid input', async () => {
    const server = serverWithSchema({ do: NAME_SCHEMA });
    server.prepareToolCall = jest.fn();
    const coordinator = new ToolExecutionCoordinator();
    const outcome = await coordinator.executeInvocation({
      invocation: invocation({ id: 'bad', server, toolName: 'do', arguments: '{}' }),
      context: CONTEXT,
    });

    expect(server.prepareToolCall).not.toHaveBeenCalled();
    expect(server.callTool).not.toHaveBeenCalled();
    expect(outcome.failure_class).toBe('validation');
  });

  it('lets an exactly valid input reach callTool', async () => {
    const server = serverWithSchema({ do: NAME_SCHEMA });
    const coordinator = new ToolExecutionCoordinator();
    const outcome = await coordinator.executeInvocation({
      invocation: invocation({ id: 'good', server, toolName: 'do', arguments: '{"name":"ok"}' }),
      context: CONTEXT,
    });

    expect(server.callTool).toHaveBeenCalledTimes(1);
    expect(outcome.status).toBe('succeeded');
    expect(textOf(outcome.response)).toBe('do:ok');
  });

  it('skips validation safely when the tool set exposes no schema for the tool', async () => {
    const server = serverWithSchema({ other: NAME_SCHEMA }); // no schema for `do`
    const coordinator = new ToolExecutionCoordinator();
    const outcome = await coordinator.executeInvocation({
      invocation: invocation({ id: 'skip', server, toolName: 'do', arguments: '{"anything":1}' }),
      context: CONTEXT,
    });

    expect(server.callTool).toHaveBeenCalledTimes(1);
    expect(outcome.status).toBe('succeeded');
  });

  it('preserves batch ordering across valid, invalid, unknown, and malformed members', async () => {
    const server = serverWithSchema({ do: NAME_SCHEMA });
    const coordinator = new ToolExecutionCoordinator();
    const batch = await coordinator.prepareBatch({
      invocations: [
        invocation({ id: 'valid', server, toolName: 'do', arguments: '{"name":"ok"}' }),
        invocation({ id: 'schema-invalid', server, toolName: 'do', arguments: '{"name":1}' }),
        invocation({ id: 'malformed', server, toolName: 'do', arguments: '{bad' }),
        invocation({ id: 'unknown', server: undefined, toolName: 'missing', arguments: '{}' }),
      ],
      context: CONTEXT,
    });

    expect(batch.invocations.map(i => i.kind)).toEqual(['ready', 'terminal', 'terminal', 'terminal']);
    const outcomes = await coordinator.executeBatch({ batch, signal: undefined });
    expect(outcomes.map(o => o.invocation_key.tool_call_id)).toEqual([
      'valid',
      'schema-invalid',
      'malformed',
      'unknown',
    ]);
    expect(outcomes.map(o => o.status)).toEqual(['succeeded', 'failed', 'failed', 'failed']);
    expect(server.callTool).toHaveBeenCalledTimes(1);
    expect(textOf(outcomes[1]?.response ?? toolResultResponse({ text: '' }))).toContain(
      'input_schema_validation_failed',
    );
    expect(textOf(outcomes[2]?.response ?? toolResultResponse({ text: '' }))).toContain('invalid_arguments');
    expect(textOf(outcomes[3]?.response ?? toolResultResponse({ text: '' }))).toContain('unknown_tool');
  });

  it('emits a complete lifecycle terminating on the validation failure without a start', async () => {
    const server = serverWithSchema({ do: NAME_SCHEMA });
    const events: ToolExecutionLifecycleEvent[] = [];
    const coordinator = new ToolExecutionCoordinator();
    const outcome = await coordinator.executeInvocation({
      invocation: invocation({ id: 'bad', server, toolName: 'do', arguments: '{"name":1}' }),
      context: {
        ...CONTEXT,
        event_recorder: event => {
          events.push(event);
          return Promise.resolve();
        },
      },
    });

    expect(outcome.status).toBe('failed');
    expect(outcome.started_at).toBeNull();
    expect(events.map(e => e.type)).toEqual([EventType.TOOL_PREPARED, EventType.TOOL_ATTEMPT_COMPLETED]);
    const prepared = events[0];
    if (prepared?.type !== EventType.TOOL_PREPARED) throw new Error('expected prepared event');
    expect(prepared.disposition).toBe('terminal');
    expect(prepared.failure_class).toBe('validation');
    const completed = events[1];
    if (completed?.type !== EventType.TOOL_ATTEMPT_COMPLETED) throw new Error('expected completed event');
    expect(completed.status).toBe('failed');
    expect(completed.failure_class).toBe('validation');
    expect(completed.started_at).toBeNull();
  });
});
