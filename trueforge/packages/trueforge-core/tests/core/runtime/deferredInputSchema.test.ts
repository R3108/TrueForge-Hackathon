import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import type { InternalToolCallInfo } from '../../../src/core/llm/LLMTypes';
import {
  isCallToolResponseResult,
  toolResultResponse,
  type CallToolResponse,
  type ListToolsResolvedResponse,
  type ToolSource,
} from '../../../src/core/mcp/IMCPServer';
import {
  ToolExecutionCoordinator,
  type ToolExecutionContext,
  type ToolExecutionInvocation,
} from '../../../src/core/mcp/ToolExecutionCoordinator';
import { ToolSet } from '../../../src/core/mcp/ToolSet';
import { DeferredTool } from '../../../src/core/runtime/DeferredTool';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';
import { makeSilentLogger } from '../harnessMocks';

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

// Underlying tool `writer` requires a string `path` and forbids extra properties.
const WRITER_SCHEMA = {
  type: 'object' as const,
  properties: { path: { type: 'string' } },
  required: ['path'],
  additionalProperties: false,
};

function makeUnderlyingSource(): { source: ToolSource; dispatched: () => number } {
  let dispatched = 0;
  const source: ToolSource = {
    name: 'writer-server',
    id: 'writer-server',
    listTools: (): Promise<ListToolsResolvedResponse> =>
      Promise.resolve({
        result: { tools: [{ name: 'writer', description: 'writes', inputSchema: WRITER_SCHEMA, preload: false }] },
        wasInitialized: undefined,
      }),
    callTool: (params: CallToolRequest['params']): Promise<CallToolResponse> => {
      dispatched++;
      return Promise.resolve(toolResultResponse({ text: `${params.name}:done` }));
    },
    toolCallInfo: (params: CallToolRequest['params']): Promise<InternalToolCallInfo> =>
      Promise.resolve({
        type: 'mcp',
        mcp_server_id: 'writer-server',
        mcp_server_name: 'writer-server',
        original_tool_name: params.name,
      }),
  };
  return { source, dispatched: () => dispatched };
}

function makeUnderlyingToolSet(source: ToolSource): ToolSet {
  return new ToolSet({
    source,
    selectors: { enableTools: ['@all'], disableTools: [], preloadTools: [], requireApprovalForTools: [] },
    preload: false,
  });
}

function invocation(input: { id: string; toolSet: DeferredTool; arguments: unknown }): ToolExecutionInvocation {
  return {
    tool_call_id: input.id,
    tool_set: input.toolSet,
    tool_name: 'call_tool',
    arguments: input.arguments,
    approval_decision: undefined,
  };
}

function textOf(response: CallToolResponse): string {
  if (!isCallToolResponseResult(response)) {
    return '';
  }
  const first = response.result.content[0];
  return first?.type === 'text' ? first.text : '';
}

describe('DeferredTool input-schema validation', () => {
  it('validates the call_tool wrapper schema at the root and never dispatches on a wrapper violation', async () => {
    const { source, dispatched } = makeUnderlyingSource();
    const deferred = new DeferredTool([makeUnderlyingToolSet(source)], {
      tracing: NOOP_AGENT_TRACING,
      logger: makeSilentLogger(),
    });
    const coordinator = new ToolExecutionCoordinator();

    // Missing the required `mcp_server`/`tool_name` wrapper fields.
    const batch = await coordinator.prepareBatch({
      invocations: [invocation({ id: 'root', toolSet: deferred, arguments: '{"input":{}}' })],
      context: CONTEXT,
    });

    expect(batch.invocations[0]?.kind).toBe('terminal');
    const outcomes = await coordinator.executeBatch({ batch, signal: undefined });
    expect(outcomes[0]?.failure_class).toBe('validation');
    expect(textOf(outcomes[0]?.response ?? toolResultResponse({ text: '{}' }))).toContain(
      'input_schema_validation_failed',
    );
    expect(dispatched()).toBe(0);
  });

  it('validates the underlying tool schema on the nested invocation and blocks a bad underlying input', async () => {
    const { source, dispatched } = makeUnderlyingSource();
    const underlying = makeUnderlyingToolSet(source);
    // Discover so the underlying view caches `writer`'s schema (production lists before dispatch).
    await underlying.listTools();
    const deferred = new DeferredTool([underlying], { tracing: NOOP_AGENT_TRACING, logger: makeSilentLogger() });
    const coordinator = new ToolExecutionCoordinator();

    // Well-formed wrapper, but the underlying `input` violates the underlying schema (path must be a string).
    const outcome = await coordinator.executeInvocation({
      invocation: invocation({
        id: 'root',
        toolSet: deferred,
        arguments: JSON.stringify({ mcp_server: 'writer-server', tool_name: 'writer', input: { path: 5 } }),
      }),
      context: CONTEXT,
    });

    // The nested underlying validation fails closed; the underlying source is never dispatched.
    expect(dispatched()).toBe(0);
    const text = textOf(outcome.response);
    expect(text).toContain('input_schema_validation_failed');
  });

  it('dispatches the underlying tool when both wrapper and underlying inputs are valid', async () => {
    const { source, dispatched } = makeUnderlyingSource();
    const underlying = makeUnderlyingToolSet(source);
    await underlying.listTools();
    const deferred = new DeferredTool([underlying], { tracing: NOOP_AGENT_TRACING, logger: makeSilentLogger() });
    const coordinator = new ToolExecutionCoordinator();

    const outcome = await coordinator.executeInvocation({
      invocation: invocation({
        id: 'root',
        toolSet: deferred,
        arguments: JSON.stringify({ mcp_server: 'writer-server', tool_name: 'writer', input: { path: 'a' } }),
      }),
      context: CONTEXT,
    });

    expect(dispatched()).toBe(1);
    expect(textOf(outcome.response)).toBe('writer:done');
  });
});
