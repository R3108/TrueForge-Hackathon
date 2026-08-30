import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { InvalidAgentSendInputError } from '../../../src/core/errors';
import { EventType, type ApprovalBinding } from '../../../src/core/events/schema';
import type { ILLM, LLMCreateParamsStreaming } from '../../../src/core/llm/ILLM';
import type {
  ExtendedChatCompletionChunk,
  InternalToolCallInfo,
  RawAssistantMessageWithUsage,
} from '../../../src/core/llm/LLMTypes';
import { getEmptyUsage } from '../../../src/core/llm/LLMTypes';
import {
  toolResultResponse,
  type CallToolResponse,
  type ListToolsResolvedResponse,
  type ToolSource,
} from '../../../src/core/mcp/IMCPServer';
import { ToolSet } from '../../../src/core/mcp/ToolSet';
import { AgentThread } from '../../../src/core/runtime/AgentThread';
import type { AgentThreadEvent, ContextMessage } from '../../../src/core/runtime/AgentThread.types';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';
import { makeSilentLogger } from '../harnessMocks';

const OBJECT_SCHEMA = { type: 'object' as const, properties: {} };

/** ToolSource whose single tool `writer` records how many times it dispatched. */
function makeToolSource(): { source: ToolSource; dispatched: () => number } {
  let dispatched = 0;
  const source: ToolSource = {
    name: 'writer-server',
    id: 'writer-server',
    listTools: (): Promise<ListToolsResolvedResponse> =>
      Promise.resolve({
        result: {
          tools: [{ name: 'writer', description: 'writes', inputSchema: OBJECT_SCHEMA, preload: true }],
        },
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

/** Approval-gated ToolSet over the source: every tool requires approval. */
function makeApprovalGatedToolSet(source: ToolSource): ToolSet {
  return new ToolSet({
    source,
    selectors: {
      enableTools: ['@all'],
      disableTools: [],
      preloadTools: [],
      requireApprovalForTools: ['@all'],
    },
    preload: true,
  });
}

/**
 * ILLM that emits a single `writer` tool call on its first turn and a plain stop afterwards. The
 * tool-call arguments are configurable so a test can drive a specific canonical fingerprint.
 */
function makeToolCallThenStopLLM(args: string): ILLM {
  let calls = 0;
  async function* stream(
    body: LLMCreateParamsStreaming,
  ): AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown> {
    void body;
    calls++;
    if (calls === 1) {
      yield {
        id: 'chunk-1',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'test',
        choices: [
          {
            index: 0,
            delta: {
              role: 'assistant',
              tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'writer', arguments: args } }],
            },
            finish_reason: 'tool_calls',
          },
        ],
      };
      return {
        output: {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'writer', arguments: args } }],
        },
        usage: getEmptyUsage(),
        finish_reason: 'tool_calls',
      };
    }
    yield {
      id: 'chunk-2',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'test',
      choices: [{ index: 0, delta: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }],
    };
    return { output: { role: 'assistant', content: 'done' }, usage: getEmptyUsage(), finish_reason: 'stop' };
  }
  return { create: stream, createNonStream: jest.fn() };
}

function makeThread(llm: ILLM, toolSet: ToolSet): AgentThread {
  return new AgentThread({
    definition: { modelClient: llm, toolSets: [toolSet] },
    threadId: 'main',
    title: 'test',
    tracing: NOOP_AGENT_TRACING,
    logger: makeSilentLogger(),
  });
}

async function drain(gen: AsyncGenerator<AgentThreadEvent, void, unknown>): Promise<AgentThreadEvent[]> {
  const events: AgentThreadEvent[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

function findApprovalRequired(events: AgentThreadEvent[]) {
  return events.find(e => e.type === EventType.TOOL_APPROVAL_REQUIRED);
}

describe('AgentThread durable approval binding', () => {
  it('emits a durable binding in tool.approval_required, persists it on a bindingless approval, and dispatches', async () => {
    const { source, dispatched } = makeToolSource();
    const toolSet = makeApprovalGatedToolSet(source);
    const thread = makeThread(makeToolCallThenStopLLM('{"path":"a"}'), toolSet);

    const firstEvents = await drain(thread.execute());
    const approvalRequired = findApprovalRequired(firstEvents);
    if (approvalRequired?.type !== EventType.TOOL_APPROVAL_REQUIRED) {
      throw new Error('expected tool.approval_required');
    }
    const ref = approvalRequired.tool_calls[0];
    expect(ref?.binding).toBeDefined();
    expect(ref?.binding).toMatchObject({
      version: 1,
      thread_id: 'main',
      tool_call_id: 'call-1',
      stable_tool_set_id: 'writer-server',
      original_tool_name: 'writer',
      policy: { policy_id: 'writer-server' },
    });

    // Old client: approve without echoing the binding. The thread computes and persists it.
    await drain(
      thread.send([
        {
          type: EventType.USER_TOOL_APPROVAL,
          thread_id: 'main',
          tool_call_id: 'call-1',
          approval: { status: 'allow' },
        },
      ]),
    );
    const resumeEvents = await drain(thread.execute());

    expect(dispatched()).toBe(1);
    const toolResponse = resumeEvents.find(e => e.type === EventType.TOOL_RESPONSE);
    if (toolResponse?.type !== EventType.TOOL_RESPONSE) {
      throw new Error('expected tool.response');
    }
    expect(toolResponse.content).toContain('writer:done');
  });

  it('accepts a client-echoed binding that matches the expected binding', async () => {
    const { source, dispatched } = makeToolSource();
    const toolSet = makeApprovalGatedToolSet(source);
    const thread = makeThread(makeToolCallThenStopLLM('{"path":"a"}'), toolSet);

    const firstEvents = await drain(thread.execute());
    const approvalRequired = findApprovalRequired(firstEvents);
    if (approvalRequired?.type !== EventType.TOOL_APPROVAL_REQUIRED) {
      throw new Error('expected tool.approval_required');
    }
    const binding = approvalRequired.tool_calls[0]?.binding;
    if (binding === undefined) {
      throw new Error('expected a binding');
    }

    await drain(
      thread.send([
        {
          type: EventType.USER_TOOL_APPROVAL,
          thread_id: 'main',
          tool_call_id: 'call-1',
          approval: { status: 'allow' },
          binding,
        },
      ]),
    );
    await drain(thread.execute());
    expect(dispatched()).toBe(1);
  });

  it('rejects a client-echoed binding that mismatches the expected binding', async () => {
    const { source } = makeToolSource();
    const toolSet = makeApprovalGatedToolSet(source);
    const thread = makeThread(makeToolCallThenStopLLM('{"path":"a"}'), toolSet);

    const firstEvents = await drain(thread.execute());
    const approvalRequired = findApprovalRequired(firstEvents);
    if (approvalRequired?.type !== EventType.TOOL_APPROVAL_REQUIRED) {
      throw new Error('expected tool.approval_required');
    }
    const binding = approvalRequired.tool_calls[0]?.binding;
    if (binding === undefined) {
      throw new Error('expected a binding');
    }
    const tampered: ApprovalBinding = { ...binding, argument_fingerprint: 'f'.repeat(64) };

    await expect(
      drain(
        thread.send([
          {
            type: EventType.USER_TOOL_APPROVAL,
            thread_id: 'main',
            tool_call_id: 'call-1',
            approval: { status: 'allow' },
            binding: tampered,
          },
        ]),
      ),
    ).rejects.toBeInstanceOf(InvalidAgentSendInputError);
  });

  it('fails closed at execution when a legacy pending call carries a persisted allow decision without a binding', async () => {
    const { source, dispatched } = makeToolSource();
    const toolSet = makeApprovalGatedToolSet(source);
    // Legacy durable context: an assistant tool call with NO policy_identity snapshot, followed by a
    // persisted allow decision that carries NO binding. This is exactly the bound-less legacy allow.
    const legacyContext: ContextMessage[] = [
      {
        role: 'assistant',
        content: null,
        model_message_id: 'legacy-message',
        tool_calls: [
          {
            id: 'call-1',
            type: 'function',
            function: { name: 'writer', arguments: '{"path":"a"}' },
            tool_info: {
              type: 'mcp',
              mcp_server_id: 'writer-server',
              mcp_server_name: 'writer-server',
              original_tool_name: 'writer',
              is_approval_required: true,
            },
          },
        ],
      },
      { type: EventType.USER_TOOL_APPROVAL, tool_call_id: 'call-1', approval: { status: 'allow' } },
    ];
    const thread = new AgentThread({
      definition: { modelClient: makeToolCallThenStopLLM('{"path":"a"}'), toolSets: [toolSet] },
      threadId: 'main',
      title: 'test',
      context: legacyContext,
      tracing: NOOP_AGENT_TRACING,
      logger: makeSilentLogger(),
    });

    const events = await drain(thread.execute());
    // The bound-less legacy allow must never dispatch the underlying tool.
    expect(dispatched()).toBe(0);
    const toolResponse = events.find(e => e.type === EventType.TOOL_RESPONSE);
    if (toolResponse?.type !== EventType.TOOL_RESPONSE) {
      throw new Error('expected a tool.response carrying the fail-closed result');
    }
    expect(toolResponse.content).toContain('approval_binding_missing');
  });
});
