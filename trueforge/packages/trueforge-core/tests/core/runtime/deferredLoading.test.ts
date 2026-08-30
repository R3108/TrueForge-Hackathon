import { InstructionBuilder } from '../../../src/core/InstructionBuilder';
import { EventType, type ToolExecutionLifecycleEvent } from '../../../src/core/events/schema';
import { isCallToolResponseResult, toolResultResponse, type IToolSet } from '../../../src/core/mcp/IMCPServer';
import { ToolExecutionCoordinator } from '../../../src/core/mcp/ToolExecutionCoordinator';
import { DeferredTool } from '../../../src/core/runtime/DeferredTool';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';
import '../harnessMocks';
import { makeMockIMCPServer, makeSilentLogger } from '../harnessMocks';

const DEFERRED_TOOLS_INSTRUCTION = 'deferred-tools-instructions';

const silentLogger = makeSilentLogger();

function deferredInstructionText(servers: IToolSet[]): string {
  const builder = InstructionBuilder.createSystemPrompt('test');
  const capabilities = builder.beginSection('agent-capabilities');
  new DeferredTool(servers, { tracing: NOOP_AGENT_TRACING, logger: silentLogger }).buildInstruction(capabilities);
  return builder.build();
}

describe('DeferredTool deferred loading behavior', () => {
  it('includes preload:false servers in deferred-tools instructions', () => {
    const text = deferredInstructionText([
      makeMockIMCPServer({ name: 'eager-server', preload: true }),
      makeMockIMCPServer({ name: 'lazy-server', preload: false }),
    ]);
    expect(text).toContain(`<${DEFERRED_TOOLS_INSTRUCTION}>`);
    expect(text).toContain('lazy-server');
    expect(text).not.toContain('eager-server');
  });

  it('omits deferred-tools instructions when every server is preload:true', () => {
    const text = deferredInstructionText([makeMockIMCPServer({ name: 'all-eager', preload: true })]);
    expect(text).not.toContain(`<${DEFERRED_TOOLS_INSTRUCTION}>`);
  });

  it('lists preload:false servers even when hasPreloadedTools is true (selective preload)', () => {
    const text = deferredInstructionText([
      makeMockIMCPServer({
        name: 'partial-preload-server',
        preload: false,
        hasPreloadedTools: true,
        preloadTools: ['tool_a'],
      }),
    ]);
    expect(text).toContain('partial-preload-server');
  });

  it('lists preload:false with no preloads and omits preload:true', () => {
    const text = deferredInstructionText([
      makeMockIMCPServer({ name: 'lazy-empty', preload: false, hasPreloadedTools: false }),
      makeMockIMCPServer({ name: 'eager', preload: true, hasPreloadedTools: true }),
    ]);
    expect(text).toContain('lazy-empty');
    expect(text).not.toContain('eager');
  });

  it('inherits root and parent identity for nested deferred calls', async () => {
    const server = makeMockIMCPServer({ name: 'lazy-server', preload: false });
    jest.mocked(server.callTool).mockResolvedValue(toolResultResponse({ text: 'inner-ok' }));
    const deferred = new DeferredTool([server], { tracing: NOOP_AGENT_TRACING, logger: makeSilentLogger() });
    const events: ToolExecutionLifecycleEvent[] = [];
    const coordinator = new ToolExecutionCoordinator();

    await coordinator.executeInvocation({
      invocation: {
        tool_call_id: 'outer-call',
        tool_set: deferred,
        tool_name: 'call_tool',
        arguments: { mcp_server: 'lazy-server', tool_name: 'tool_a', input: {} },
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
      events.find(event => event.type === EventType.TOOL_PREPARED && event.tool_call_id === 'deferred:outer-call:1'),
    ).toMatchObject({
      root_tool_call_id: 'outer-call',
      parent_tool_call_id: 'outer-call',
      stable_tool_set_id: 'lazy-server',
      tool_name: 'tool_a',
    });
  });

  it('logs nested transport failures and returns a deferred error result', async () => {
    const server = makeMockIMCPServer({ name: 'lazy-server', preload: false });
    jest.mocked(server.callTool).mockRejectedValue(new Error('connection lost'));
    const logger = makeSilentLogger();
    const errorSpy = jest.spyOn(logger, 'error');
    const deferred = new DeferredTool([server], { tracing: NOOP_AGENT_TRACING, logger });

    const response = await deferred.callTool({
      name: 'call_tool',
      arguments: { mcp_server: 'lazy-server', tool_name: 'tool_a', input: {} },
    });

    expect(errorSpy).toHaveBeenCalledWith(
      'call_tool failed',
      expect.objectContaining({ mcpServer: 'lazy-server', toolName: 'tool_a' }),
    );
    expect(isCallToolResponseResult(response)).toBe(true);
    if (!isCallToolResponseResult(response)) throw new Error('expected tool result');
    expect(response.result.isError).toBe(true);
    expect(response.result.content).toEqual([
      { type: 'text', text: JSON.stringify({ error: 'Tool call failed: connection lost' }) },
    ]);
  });
});
