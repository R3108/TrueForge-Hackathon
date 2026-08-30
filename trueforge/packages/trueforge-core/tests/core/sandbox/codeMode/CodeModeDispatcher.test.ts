import { McpConnectionError } from '../../../../src/core/errors';
import { EventType, type ToolExecutionLifecycleEvent } from '../../../../src/core/events/schema';
import {
  toolResultResponse,
  type CallToolResponse,
  type IToolSet,
  type ListToolsResponse,
} from '../../../../src/core/mcp/IMCPServer';
import { ToolExecutionCoordinator } from '../../../../src/core/mcp/ToolExecutionCoordinator';
import { CodeModeDispatcher } from '../../../../src/core/sandbox/codeMode/CodeModeDispatcher';
import { makeMockIMCPServer, makeSilentLogger, OBJECT_INPUT_SCHEMA } from '../../harnessMocks';

function makeDispatcher(toolSets: readonly IToolSet[]): CodeModeDispatcher {
  return new CodeModeDispatcher({ toolSets, logger: makeSilentLogger() });
}

describe('CodeModeDispatcher', () => {
  it('list_tools returns the tool list', async () => {
    const server = makeMockIMCPServer({ name: 'github', preload: true });
    const dispatcher = makeDispatcher([server]);

    const reply = await dispatcher.dispatch({
      request: { op: 'list_tools', server: 'github' },
      traceCarrier: {},
    });

    expect(reply).toEqual({
      ok: true,
      result: {
        tools: [{ name: 'tool_a', description: 'A', inputSchema: OBJECT_INPUT_SCHEMA, preload: true }],
      },
    });
  });

  it('call_tool returns the tool result', async () => {
    const server = makeMockIMCPServer({ name: 'github', preload: true });
    jest.mocked(server.callTool).mockResolvedValue({
      result: { content: [{ type: 'text', text: 'ok' }], isError: false },
      wasInitialized: undefined,
    } satisfies CallToolResponse);

    const dispatcher = makeDispatcher([server]);
    const reply = await dispatcher.dispatch({
      request: { op: 'call_tool', server: 'github', tool: 'tool_a', arguments: { x: 1 } },
      traceCarrier: {},
    });

    expect(reply).toEqual({
      ok: true,
      result: { content: [{ type: 'text', text: 'ok' }], isError: false },
    });
    expect(server.callTool).toHaveBeenCalledWith({ name: 'tool_a', arguments: { x: 1 } });
  });

  it('inherits root and parent identity for nested call_tool dispatch', async () => {
    const inner = makeMockIMCPServer({ name: 'github', preload: true });
    jest.mocked(inner.callTool).mockResolvedValue(toolResultResponse({ text: 'inner-ok' }));
    const dispatcher = makeDispatcher([inner]);
    const outer = makeMockIMCPServer({ name: 'outer', preload: true });
    jest.mocked(outer.callTool).mockImplementation(async () => {
      const reply = await dispatcher.dispatch({
        request: { op: 'call_tool', server: 'github', tool: 'tool_a', arguments: {} },
        traceCarrier: {},
      });
      return toolResultResponse({ text: JSON.stringify(reply) });
    });
    const events: ToolExecutionLifecycleEvent[] = [];
    const coordinator = new ToolExecutionCoordinator();

    await coordinator.executeInvocation({
      invocation: {
        tool_call_id: 'outer-call',
        tool_set: outer,
        tool_name: 'outer_tool',
        arguments: {},
        approval_decision: undefined,
      },
      context: {
        session_id: 'session-1',
        turn_id: 'turn-1',
        thread_id: 'main',
        model_message_id: 'message-1',
        root_tool_call_id: null,
        parent_tool_call_id: null,
        signal: undefined,
        event_recorder: event => {
          events.push(event);
          return Promise.resolve();
        },
      },
    });

    expect(
      events.find(event => event.type === EventType.TOOL_PREPARED && event.tool_call_id === 'code:outer-call:1'),
    ).toMatchObject({
      root_tool_call_id: 'outer-call',
      parent_tool_call_id: 'outer-call',
      stable_tool_set_id: 'github',
      tool_name: 'tool_a',
    });
  });

  it('unknown server is caller fault', async () => {
    const dispatcher = makeDispatcher([makeMockIMCPServer({ name: 'github', preload: true })]);

    const reply = await dispatcher.dispatch({
      request: { op: 'list_tools', server: 'missing' },
      traceCarrier: {},
    });

    expect(reply.ok).toBe(false);
    if (reply.ok) throw new Error('unreachable');
    expect(reply.source).toBe('caller');
    expect(reply.error).toContain('missing');
  });

  it('OAuth list_tools is caller fault', async () => {
    const server = makeMockIMCPServer({ name: 'github', preload: true });
    jest.mocked(server.listTools).mockResolvedValue({
      authRequired: { servers: [{ id: 'github', name: 'github', auth_url: 'https://example.com/oauth' }] },
    } satisfies ListToolsResponse);

    const dispatcher = makeDispatcher([server]);
    const reply = await dispatcher.dispatch({
      request: { op: 'list_tools', server: 'github' },
      traceCarrier: {},
    });

    expect(reply.ok).toBe(false);
    if (reply.ok) throw new Error('unreachable');
    expect(reply.source).toBe('caller');
    expect(reply.error).toMatch(/OAuth/);
  });

  it('sub-agent tool is caller fault', async () => {
    const server = makeMockIMCPServer({ name: 'github', preload: true });
    jest.mocked(server.callTool).mockResolvedValue({
      createSubAgent: { type: 'dynamic', name: 'Sub', input: 'do work' },
    } satisfies CallToolResponse);

    const dispatcher = makeDispatcher([server]);
    const reply = await dispatcher.dispatch({
      request: { op: 'call_tool', server: 'github', tool: 'spawn' },
      traceCarrier: {},
    });

    expect(reply.ok).toBe(false);
    if (reply.ok) throw new Error('unreachable');
    expect(reply.source).toBe('caller');
    expect(reply.error).toMatch(/sub-agent/);
  });

  it('4xx McpConnectionError is caller fault', async () => {
    const server = makeMockIMCPServer({ name: 'github', preload: true });
    jest.mocked(server.callTool).mockRejectedValue(new McpConnectionError('bad request', 400));

    const dispatcher = makeDispatcher([server]);
    const reply = await dispatcher.dispatch({
      request: { op: 'call_tool', server: 'github', tool: 'tool_a' },
      traceCarrier: {},
    });

    expect(reply.ok).toBe(false);
    if (reply.ok) throw new Error('unreachable');
    expect(reply.source).toBe('caller');
  });

  it('non-Error 4xx status rejection is caller fault', async () => {
    const server = makeMockIMCPServer({ name: 'github', preload: true });
    jest.mocked(server.callTool).mockRejectedValue({ status: 404 });

    const dispatcher = makeDispatcher([server]);
    const reply = await dispatcher.dispatch({
      request: { op: 'call_tool', server: 'github', tool: 'tool_a' },
      traceCarrier: {},
    });

    expect(reply.ok).toBe(false);
    if (reply.ok) throw new Error('unreachable');
    expect(reply.source).toBe('caller');
  });

  it('unexpected errors are internal fault', async () => {
    const server = makeMockIMCPServer({ name: 'github', preload: true });
    jest.mocked(server.callTool).mockRejectedValue(new Error('boom'));

    const dispatcher = makeDispatcher([server]);
    const reply = await dispatcher.dispatch({
      request: { op: 'call_tool', server: 'github', tool: 'tool_a' },
      traceCarrier: {},
    });

    expect(reply.ok).toBe(false);
    if (reply.ok) throw new Error('unreachable');
    expect(reply.source).toBe('internal');
    expect(reply.error).toBe('boom');
  });

  it('closed dispatcher returns transport source without calling tools', async () => {
    const server = makeMockIMCPServer({ name: 'github', preload: true });
    const dispatcher = makeDispatcher([server]);
    dispatcher.close();

    const reply = await dispatcher.dispatch({
      request: { op: 'list_tools', server: 'github' },
      traceCarrier: {},
    });

    expect(reply).toEqual({
      ok: false,
      error: 'Code Mode dispatcher is closed',
      source: 'transport',
    });
    expect(server.listTools).not.toHaveBeenCalled();
  });
});
