import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import type { ApprovalBinding } from '../../../src/core/events/schema';
import type { InternalEnrichedToolCall, InternalToolCallInfo } from '../../../src/core/llm/LLMTypes';
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
import { computeExpectedApprovalBinding } from '../../../src/core/runtime/contextUtils';
import { DeferredTool } from '../../../src/core/runtime/DeferredTool';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';
import { makeSilentLogger } from '../harnessMocks';

const OBJECT_SCHEMA = { type: 'object' as const, properties: {} };

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

/** ToolSource whose single tool `writer` records how many times it dispatched. */
function makeUnderlyingSource(): { source: ToolSource; dispatched: () => number } {
  let dispatched = 0;
  const source: ToolSource = {
    name: 'writer-server',
    id: 'writer-server',
    listTools: (): Promise<ListToolsResolvedResponse> =>
      Promise.resolve({
        result: { tools: [{ name: 'writer', description: 'writes', inputSchema: OBJECT_SCHEMA, preload: false }] },
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

/**
 * Deferred (preload:false) approval-gated ToolSet over the source. `requireApprovalForTools: ['@all']`
 * makes `writer` an approval-required write; the deferred wrapper is what the model calls via
 * `call_tool`.
 */
function makeUnderlyingToolSet(source: ToolSource, approvalSelectors: string[] = ['@all']): ToolSet {
  return new ToolSet({
    source,
    selectors: {
      enableTools: ['@all'],
      disableTools: [],
      preloadTools: [],
      requireApprovalForTools: approvalSelectors,
    },
    preload: false,
  });
}

function makeDeferred(toolSet: ToolSet): DeferredTool {
  return new DeferredTool([toolSet], { tracing: NOOP_AGENT_TRACING, logger: makeSilentLogger() });
}

/** The root `call_tool` model arguments the agent emits to invoke the underlying `writer`. */
function callToolArgs(input: Record<string, unknown> = { path: 'a' }): Record<string, unknown> {
  return { mcp_server: 'writer-server', tool_name: 'writer', input };
}

/**
 * Mint the durable binding exactly as production does for a deferred call: enrich the root `call_tool`
 * assistant call through the DeferredTool (so `tool_info.policy_identity` is the *underlying* server's
 * snapshot and `original_tool_name` is the underlying tool), then compute the expected binding over the
 * full root `call_tool` arguments. No hand-rolled fingerprints or identities.
 */
async function persistedBinding(deferred: DeferredTool, args: Record<string, unknown>): Promise<ApprovalBinding> {
  const tool_info = await deferred.toolCallInfo({ name: 'call_tool', arguments: args });
  const toolCall: InternalEnrichedToolCall = {
    id: 'call-1',
    type: 'function',
    function: { name: 'call_tool', arguments: JSON.stringify(args) },
    tool_info,
  };
  const binding = computeExpectedApprovalBinding({ toolCall, threadId: 'main', modelMessageId: 'message-1' });
  if (binding === undefined) {
    throw new Error('expected a durable binding for the deferred call');
  }
  return binding;
}

function deferredAllowInvocation(input: {
  deferred: DeferredTool;
  args: Record<string, unknown>;
  binding: ApprovalBinding | undefined;
}): ToolExecutionInvocation {
  return {
    tool_call_id: 'call-1',
    tool_set: input.deferred,
    tool_name: 'call_tool',
    arguments: JSON.stringify(input.args),
    approval_decision: { status: 'allow' },
    approval_binding: input.binding,
    model_message_id: 'message-1',
  };
}

function textOf(response: CallToolResponse): string {
  if (!isCallToolResponseResult(response)) {
    return '';
  }
  const first = response.result.content[0];
  return first?.type === 'text' ? first.text : '';
}

describe('DeferredTool approval binding regression', () => {
  it('emits the underlying policy snapshot for an approval-required write behind call_tool', async () => {
    const { source } = makeUnderlyingSource();
    const toolSet = makeUnderlyingToolSet(source);
    const deferred = makeDeferred(toolSet);
    const args = callToolArgs();

    // Enriching the wrapper call resolves the underlying tool's approval + policy identity, not the
    // wrapper's. This is the snapshot the durable binding is minted from.
    const info = await deferred.toolCallInfo({ name: 'call_tool', arguments: args });
    expect(info.is_deferred).toBe(true);
    expect(info.is_approval_required).toBe(true);
    expect(info.original_tool_name).toBe('writer');
    expect(info.policy_identity).toEqual({
      stable_tool_set_id: 'writer-server',
      policy_id: 'writer-server',
      policy_version: toolSet.policyIdentity().policy_version,
    });

    // The request-aware approval target follows wrapper delegation to the underlying server/tool/policy.
    expect(deferred.approvalTargetIdentity({ name: 'call_tool', arguments: args })).toEqual({
      stable_tool_set_id: 'writer-server',
      original_tool_name: 'writer',
      policy_id: 'writer-server',
      policy_version: toolSet.policyIdentity().policy_version,
    });
  });

  it('dispatches once when the exact persisted binding matches the underlying target', async () => {
    const { source, dispatched } = makeUnderlyingSource();
    const toolSet = makeUnderlyingToolSet(source);
    const deferred = makeDeferred(toolSet);
    const args = callToolArgs();
    const binding = await persistedBinding(deferred, args);
    const coordinator = new ToolExecutionCoordinator();

    const outcome = await coordinator.executeInvocation({
      invocation: deferredAllowInvocation({ deferred, args, binding }),
      context: CONTEXT,
    });

    expect(outcome.status).toBe('succeeded');
    expect(dispatched()).toBe(1);
    expect(textOf(outcome.response)).toBe('writer:done');
  });

  it('fails closed with zero dispatch when the underlying policy advanced after approval', async () => {
    // Binding minted under approval selectors ['@all']; live policy now approves nothing ([]).
    const { source, dispatched } = makeUnderlyingSource();
    const args = callToolArgs();
    const boundBinding = await persistedBinding(makeDeferred(makeUnderlyingToolSet(source, ['@all'])), args);

    const liveDeferred = makeDeferred(makeUnderlyingToolSet(source, []));
    const coordinator = new ToolExecutionCoordinator();
    const outcome = await coordinator.executeInvocation({
      invocation: deferredAllowInvocation({ deferred: liveDeferred, args, binding: boundBinding }),
      context: CONTEXT,
    });

    expect(dispatched()).toBe(0);
    expect(outcome.status).toBe('failed');
    expect(outcome.failure_class).toBe('policy');
    expect(textOf(outcome.response)).toContain('approval_binding_mismatch');
  });

  it('fails closed with zero dispatch when the underlying target tool changed after approval', async () => {
    const { source, dispatched } = makeUnderlyingSource();
    const toolSet = makeUnderlyingToolSet(source);
    const deferred = makeDeferred(toolSet);
    // Binding minted for writer(path:a); the live call now targets writer(path:b) — a different fingerprint.
    const boundBinding = await persistedBinding(deferred, callToolArgs({ path: 'a' }));
    const coordinator = new ToolExecutionCoordinator();

    const outcome = await coordinator.executeInvocation({
      invocation: deferredAllowInvocation({ deferred, args: callToolArgs({ path: 'b' }), binding: boundBinding }),
      context: CONTEXT,
    });

    expect(dispatched()).toBe(0);
    expect(outcome.status).toBe('failed');
    expect(outcome.failure_class).toBe('policy');
    expect(textOf(outcome.response)).toContain('approval_binding_mismatch');
  });

  it('fails closed with zero dispatch on a persisted allow decision that carries no binding', async () => {
    const { source, dispatched } = makeUnderlyingSource();
    const deferred = makeDeferred(makeUnderlyingToolSet(source));
    const coordinator = new ToolExecutionCoordinator();

    const outcome = await coordinator.executeInvocation({
      invocation: deferredAllowInvocation({ deferred, args: callToolArgs(), binding: undefined }),
      context: CONTEXT,
    });

    expect(dispatched()).toBe(0);
    expect(outcome.status).toBe('failed');
    expect(outcome.failure_class).toBe('policy');
    expect(textOf(outcome.response)).toContain('approval_binding_missing');
  });

  it('keeps a denial terminal with zero dispatch', async () => {
    const { source, dispatched } = makeUnderlyingSource();
    const deferred = makeDeferred(makeUnderlyingToolSet(source));
    const coordinator = new ToolExecutionCoordinator();

    const outcome = await coordinator.executeInvocation({
      invocation: {
        tool_call_id: 'call-1',
        tool_set: deferred,
        tool_name: 'call_tool',
        arguments: JSON.stringify(callToolArgs()),
        approval_decision: { status: 'deny', reason: 'not allowed' },
        approval_binding: undefined,
        model_message_id: 'message-1',
      },
      context: CONTEXT,
    });

    expect(dispatched()).toBe(0);
    expect(outcome.status).toBe('failed');
    expect(textOf(outcome.response)).toContain('User denied tool call');
  });
});
