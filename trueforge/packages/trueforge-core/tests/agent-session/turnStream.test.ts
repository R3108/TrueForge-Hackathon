import { EventType } from '../../src/agent-session/schemas/events';
import { CancellationReason } from '../../src/agent-session/schemas/turn';
import { Sessions } from '../../src/agent-session/Sessions';
import { InMemorySessionStore } from '../../src/agent-session/store/InMemorySessionStore';
import { TurnResourceResolver } from '../../src/agent-session/TurnResourceResolver';
import { newEventId, ToolExecutionLifecycleEventSchema } from '../../src/core/events/schema';
import {
  getEmptyUsage,
  type ExtendedChatCompletionChunk,
  type RawAssistantMessageWithUsage,
} from '../../src/core/llm/LLMTypes';
import { toolResultResponse } from '../../src/core/mcp/IMCPServer';
import { RemoteMCP } from '../../src/core/mcp/RemoteMCP';
import { makeMockIMCPServer, makeStubPublicSandbox } from '../core/harnessMocks';
import {
  emptyLlmStream,
  makeAgentSpec,
  makeMockILLM,
  makeSilentLogger,
  makeTestResolver,
  mintTestTurnId,
} from './testHelpers';

async function* toolCallLlmStream(): AsyncGenerator<
  ExtendedChatCompletionChunk,
  RawAssistantMessageWithUsage,
  unknown
> {
  const toolCall = {
    id: 'call-1',
    type: 'function' as const,
    function: { name: 'tool_a', arguments: '{}' },
  };
  yield {
    id: 'chunk-tool',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'test-model',
    choices: [
      {
        index: 0,
        delta: { role: 'assistant', tool_calls: [{ index: 0, ...toolCall }] },
        finish_reason: 'tool_calls',
      },
    ],
  };
  return {
    output: { role: 'assistant', content: null, tool_calls: [toolCall] },
    usage: getEmptyUsage(),
    finish_reason: 'tool_calls',
  };
}

describe('TurnHandle.stream()', () => {
  const tenant = 'tenant-1';

  async function createSession() {
    const store = new InMemorySessionStore();
    const sessions = new Sessions({ sessionStore: store });
    const session = await sessions.create({
      tenant_id: tenant,
      session_id: 's1',
      created_by: 'user-1',
      agent: {
        type: 'inline',
        spec: makeAgentSpec({
          config: {
            sandbox: { enabled: true, file_downloads: true },
          },
        }),
      },
    });
    return { store, session };
  }

  it('run commits running turn; stream is sole terminal writer → done', async () => {
    const { store, session } = await createSession();
    const turn = await session.createTurn({
      turn_id: mintTestTurnId(),
      input: [{ type: EventType.USER_MESSAGE, content: 'hello' }],
      previous_turn_id: 'none',
      signal: new AbortController().signal,
      resolver: makeTestResolver(),
    });
    expect(turn.state.status).toBe('running');

    const types: string[] = [];
    for await (const event of turn.stream()) {
      types.push(event.type);
    }
    expect(types[0]).toBe(EventType.TURN_CREATED);
    expect(types[types.length - 1]).toBe(EventType.TURN_DONE);
    expect(turn.state).toMatchObject({
      status: 'done',
      metrics: {},
    });
    if (turn.state.status === 'done') {
      // Token counts are always reported, so an unbilled turn aggregates to 0. Cost and the
      // cache counts stay undefined until a provider actually reports them.
      expect(turn.state.metrics?.total_input_tokens).toBe(0);
      expect(turn.state.metrics?.total_output_tokens).toBe(0);
      expect(turn.state.metrics?.total_tokens).toBe(0);
      expect(turn.state.metrics?.total_cache_read_tokens).toBeUndefined();
      expect(turn.state.metrics?.total_cost_in_usd).toBeUndefined();
    }

    const { data } = await turn.listEvents({ limit: 50 });
    expect(data.some(e => e.type === EventType.TURN_CREATED)).toBe(true);
    expect(data.some(e => e.type === EventType.TURN_DONE)).toBe(true);

    const stored = await store.getTurn({
      session_id: 's1',
      turn_id: turn.id,
    });
    expect(stored?.state.status).toBe('done');
  });

  it('persists and replays complete tool lifecycle identity for a live turn', async () => {
    const { session } = await createSession();
    const server = makeMockIMCPServer({ name: 'tools', preload: true });
    jest.mocked(server.toolCallInfo).mockResolvedValue({
      type: 'mcp',
      mcp_server_id: 'tools',
      mcp_server_name: 'tools',
      original_tool_name: 'tool_a',
      is_approval_required: false,
    });
    jest.mocked(server.callTool).mockResolvedValue(toolResultResponse({ text: 'tool-ok' }));
    let modelCall = 0;
    const llm = makeMockILLM({
      create: jest.fn().mockImplementation(() => {
        modelCall++;
        return modelCall === 1 ? toolCallLlmStream() : emptyLlmStream();
      }),
    });
    const turn = await session.createTurn({
      turn_id: 'turn-tool-lifecycle',
      input: [{ type: EventType.USER_MESSAGE, content: 'use the tool' }],
      previous_turn_id: 'none',
      signal: new AbortController().signal,
      resolver: makeTestResolver({
        llm,
        extraCapabilities: [{ systemToolSets: [server] }],
      }),
    });

    for await (const event of turn.stream()) void event;

    const { data } = await turn.listEvents({ limit: 100, order: 'asc' });
    const lifecycle = data.flatMap(event => {
      const parsed = ToolExecutionLifecycleEventSchema.safeParse(event);
      return parsed.success ? [parsed.data] : [];
    });
    expect(lifecycle.map(event => event.type)).toEqual([
      EventType.TOOL_PREPARED,
      EventType.TOOL_ATTEMPT_STARTED,
      EventType.TOOL_ATTEMPT_COMPLETED,
    ]);
    const modelMessage = data.find(
      event => event.type === EventType.MODEL_MESSAGE && event.tool_calls?.some(call => call.id === 'call-1'),
    );
    expect(modelMessage?.id).toBeDefined();
    expect(modelMessage).not.toHaveProperty('model_message_id');
    expect(lifecycle.every(event => event.session_id === 's1')).toBe(true);
    expect(lifecycle.every(event => event.turn_id === 'turn-tool-lifecycle')).toBe(true);
    expect(lifecycle.every(event => event.thread_id === 'main')).toBe(true);
    expect(lifecycle.every(event => event.model_message_id === modelMessage?.id)).toBe(true);
    expect(lifecycle.every(event => event.tool_call_id === 'call-1')).toBe(true);
    expect(lifecycle.every(event => event.root_tool_call_id === 'call-1')).toBe(true);
    expect(lifecycle.every(event => event.parent_tool_call_id === null)).toBe(true);
    expect(lifecycle.every(event => event.stable_tool_set_id === 'tools')).toBe(true);
    expect(new Set(lifecycle.map(event => event.attempt_id)).size).toBe(1);
    expect(data.some(event => event.type === EventType.TOOL_RESPONSE && event.tool_call_id === 'call-1')).toBe(true);
  });

  it('projects a prior started write without completion as a reconciliation blocker on restart', async () => {
    const { store, session } = await createSession();
    const first = await session.createTurn({
      turn_id: 'turn-interrupted-write',
      input: [{ type: EventType.USER_MESSAGE, content: 'perform the write' }],
      previous_turn_id: 'none',
      signal: new AbortController().signal,
      resolver: makeTestResolver(),
    });
    await store.appendToThreadContext({
      session_id: 's1',
      turn_id: first.id,
      thread_id: 'main',
      context: [
        {
          role: 'assistant',
          content: null,
          model_message_id: 'model-write',
          tool_calls: [
            {
              id: 'call-write',
              type: 'function',
              function: { name: 'create_issue', arguments: '{"title":"incident"}' },
              tool_info: {
                type: 'mcp',
                mcp_server_id: 'github',
                mcp_server_name: 'github',
                original_tool_name: 'create_issue',
                is_approval_required: false,
                is_client_side: false,
              },
            },
          ],
        },
      ],
      current_context_usage: null,
      completion: null,
    });
    const attemptId = '00000000-0000-4000-8000-000000000010';
    const identity = {
      session_id: 's1',
      turn_id: first.id,
      thread_id: 'main',
      model_message_id: 'model-write',
      stable_tool_set_id: 'github',
      tool_name: 'create_issue',
      tool_call_id: 'call-write',
      root_tool_call_id: 'call-write',
      parent_tool_call_id: null,
      attempt_id: attemptId,
    };
    await store.appendToEvents({
      session_id: 's1',
      turn_id: first.id,
      events: [
        ToolExecutionLifecycleEventSchema.parse({
          ...identity,
          type: EventType.TOOL_PREPARED,
          id: newEventId(),
          created_at: '2026-01-01T00:00:00.000Z',
          argument_fingerprint: 'b'.repeat(64),
          capability: {
            side_effect_class: 'remote_write',
            retry_capability: 'never',
            concurrency: { kind: 'exclusive' },
            timeout_ms: null,
            result_size_class: 'small',
          },
          disposition: 'ready',
          failure_class: null,
        }),
        ToolExecutionLifecycleEventSchema.parse({
          ...identity,
          type: EventType.TOOL_ATTEMPT_STARTED,
          id: newEventId(),
          created_at: '2026-01-01T00:00:01.000Z',
          started_at: '2026-01-01T00:00:01.000Z',
        }),
      ],
    });

    const second = await session.createTurn({
      turn_id: 'turn-after-interrupted-write',
      previous_turn_id: first.id,
      signal: new AbortController().signal,
      resolver: makeTestResolver(),
    });
    const stored = await store.getTurn({ session_id: 's1', turn_id: second.id });
    const recoveryMessage = stored?.snapshot.threads['main']?.context.find(
      message => 'role' in message && message.role === 'tool' && message.tool_call_id === 'call-write',
    );

    expect(recoveryMessage).toBeDefined();
    if (
      recoveryMessage === undefined ||
      !('content' in recoveryMessage) ||
      typeof recoveryMessage.content !== 'string'
    ) {
      throw new Error('expected persisted recovery tool result');
    }
    expect(JSON.parse(recoveryMessage.content)).toMatchObject({
      error: 'interrupted_tool_execution',
      recovery_disposition: 'reconciliation_required',
      automatic_retry_allowed: false,
      completion_unknown: true,
    });
  });

  it('closes an old call on an empty restart even when no lifecycle event was persisted', async () => {
    const { store, session } = await createSession();
    const first = await session.createTurn({
      turn_id: 'turn-before-prepared',
      input: [{ type: EventType.USER_MESSAGE, content: 'perform the write' }],
      previous_turn_id: 'none',
      signal: new AbortController().signal,
      resolver: makeTestResolver(),
    });
    await store.appendToThreadContext({
      session_id: 's1',
      turn_id: first.id,
      thread_id: 'main',
      context: [
        {
          role: 'assistant',
          content: null,
          model_message_id: 'model-before-prepared',
          tool_calls: [
            {
              id: 'call-before-prepared',
              type: 'function',
              function: { name: 'create_issue', arguments: '{"title":"incident"}' },
              tool_info: {
                type: 'mcp',
                mcp_server_id: 'github',
                mcp_server_name: 'github',
                original_tool_name: 'create_issue',
                is_approval_required: false,
                is_client_side: false,
              },
            },
          ],
        },
      ],
      current_context_usage: null,
      completion: null,
    });

    const second = await session.createTurn({
      turn_id: 'turn-after-before-prepared',
      previous_turn_id: first.id,
      signal: new AbortController().signal,
      resolver: makeTestResolver(),
    });
    const stored = await store.getTurn({ session_id: 's1', turn_id: second.id });
    const closure = stored?.snapshot.threads['main']?.context.find(
      message => 'role' in message && message.role === 'tool' && message.tool_call_id === 'call-before-prepared',
    );

    expect(closure).toMatchObject({
      role: 'tool',
      tool_call_id: 'call-before-prepared',
      content: JSON.stringify({ error: 'Tool call was not executed. Please retry this tool call.' }),
    });
  });

  it('persists final turn usage from orchestrator metrics', async () => {
    const { session } = await createSession();
    const turn = await session.createTurn({
      turn_id: 'turn-usage',
      input: [{ type: EventType.USER_MESSAGE, content: 'hello' }],
      previous_turn_id: 'none',
      signal: new AbortController().signal,
      resolver: makeTestResolver({
        usage: {
          input_tokens: 12,
          output_tokens: 5,
          total_tokens: 17,
          cache_read_tokens: 4,
          reasoning_tokens: 3,
          cost_in_usd: 0.42,
        },
      }),
    });

    for await (const event of turn.stream()) void event;

    expect(turn.state).toMatchObject({
      status: 'done',
      metrics: {
        total_input_tokens: 12,
        total_output_tokens: 5,
        total_tokens: 17,
        total_cache_read_tokens: 4,
        total_reasoning_tokens: 3,
        total_cost_in_usd: 0.42,
      },
    });
  });

  it('isolates billable usage across turns (Turn 2 does not include Turn 1)', async () => {
    const { session } = await createSession();

    const turn1 = await session.createTurn({
      turn_id: 'turn-isolation-1',
      input: [{ type: EventType.USER_MESSAGE, content: 'turn one' }],
      previous_turn_id: 'none',
      signal: new AbortController().signal,
      resolver: makeTestResolver({
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          total_tokens: 150,
          cache_read_tokens: 20,
          cost_in_usd: 1.5,
        },
      }),
    });
    for await (const event of turn1.stream()) void event;
    expect(turn1.state).toMatchObject({
      status: 'done',
      metrics: {
        total_input_tokens: 100,
        total_output_tokens: 50,
        total_tokens: 150,
        total_cache_read_tokens: 20,
        total_cost_in_usd: 1.5,
      },
    });

    const turn2 = await session.createTurn({
      turn_id: 'turn-isolation-2',
      input: [{ type: EventType.USER_MESSAGE, content: 'turn two' }],
      previous_turn_id: 'auto',
      signal: new AbortController().signal,
      resolver: makeTestResolver({
        usage: {
          input_tokens: 7,
          output_tokens: 3,
          total_tokens: 10,
          cache_read_tokens: 1,
          cost_in_usd: 0.05,
        },
      }),
    });
    for await (const event of turn2.stream()) void event;

    expect(turn2.state).toMatchObject({
      status: 'done',
      metrics: {
        total_input_tokens: 7,
        total_output_tokens: 3,
        total_tokens: 10,
        total_cache_read_tokens: 1,
        total_cost_in_usd: 0.05,
      },
    });
    // Explicitly not a sum with turn 1.
    expect(turn2.state.status === 'done' && turn2.state.metrics).not.toMatchObject({
      total_input_tokens: 107,
      total_output_tokens: 53,
      total_tokens: 160,
      total_cost_in_usd: 1.55,
    });
  });

  it('persists cache-read tokens on turn usage', async () => {
    const { session } = await createSession();
    const turn = await session.createTurn({
      turn_id: 'turn-cache-read',
      input: [{ type: EventType.USER_MESSAGE, content: 'hello' }],
      previous_turn_id: 'none',
      signal: new AbortController().signal,
      resolver: makeTestResolver({
        usage: {
          input_tokens: 12,
          output_tokens: 5,
          total_tokens: 17,
          cache_read_tokens: 4,
          cost_in_usd: 0.42,
        },
      }),
    });

    for await (const event of turn.stream()) void event;

    expect(turn.state).toMatchObject({
      status: 'done',
      metrics: { total_cache_read_tokens: 4 },
    });
  });

  it('background drain reaches terminal done', async () => {
    const { session } = await createSession();
    const turn = await session.createTurn({
      turn_id: mintTestTurnId(),
      input: [{ type: EventType.USER_MESSAGE, content: 'hello' }],
      previous_turn_id: 'none',
      signal: new AbortController().signal,
      resolver: makeTestResolver(),
    });
    await (async () => {
      for await (const event of turn.stream()) {
        void event;
        // drain
      }
    })();
    expect(turn.state.status).toBe('done');
  });

  it('second stream() call throws', async () => {
    const { session } = await createSession();
    const turn = await session.createTurn({
      turn_id: mintTestTurnId(),
      input: [{ type: EventType.USER_MESSAGE, content: 'hello' }],
      previous_turn_id: 'none',
      signal: new AbortController().signal,
      resolver: makeTestResolver(),
    });
    for await (const event of turn.stream()) {
      void event;
      // drain
    }
    await expect(
      (async () => {
        for await (const event of turn.stream()) {
          void event;
          // should throw before yielding
        }
      })(),
    ).rejects.toThrow(/single-use/);
  });

  it('consumer break/abandon without abort writes cancelled ClientCancelled', async () => {
    const { store, session } = await createSession();
    let closeCalls = 0;
    const turn = await session.createTurn({
      turn_id: mintTestTurnId(),
      input: [{ type: EventType.USER_MESSAGE, content: 'hello' }],
      previous_turn_id: 'none',
      signal: new AbortController().signal,
      resolver: makeTestResolver({
        close: () => {
          closeCalls += 1;
          return Promise.resolve();
        },
      }),
    });
    for await (const event of turn.stream()) {
      expect(event.type).toBe(EventType.TURN_CREATED);
      break;
    }
    expect(turn.state.status).toBe('cancelled');
    if (turn.state.status === 'cancelled') {
      expect(turn.state.reason).toBe(CancellationReason.ClientCancelled);
    }
    expect(closeCalls).toBe(1);
    const stored = await store.getTurn({
      session_id: 's1',
      turn_id: turn.id,
    });
    expect(stored?.state.status).toBe('cancelled');
  });

  it('abort mid-drain writes terminal cancelled', async () => {
    const { store, session } = await createSession();
    const controller = new AbortController();
    const turn = await session.createTurn({
      turn_id: mintTestTurnId(),
      input: [{ type: EventType.USER_MESSAGE, content: 'hello' }],
      previous_turn_id: 'none',
      signal: controller.signal,
      resolver: makeTestResolver(),
    });
    controller.abort(CancellationReason.ClientCancelled);
    for await (const event of turn.stream()) {
      void event;
      // drain
    }
    expect(turn.state.status).toBe('cancelled');
    if (turn.state.status === 'cancelled') {
      expect(turn.state.reason).toBe(CancellationReason.ClientCancelled);
    }
    const stored = await store.getTurn({
      session_id: 's1',
      turn_id: turn.id,
    });
    expect(stored?.state.status).toBe('cancelled');
  });

  it('abort with Abandoned persists reason abandoned', async () => {
    const { store, session } = await createSession();
    const controller = new AbortController();
    const turn = await session.createTurn({
      turn_id: mintTestTurnId(),
      input: [{ type: EventType.USER_MESSAGE, content: 'hello' }],
      previous_turn_id: 'none',
      signal: controller.signal,
      resolver: makeTestResolver(),
    });
    controller.abort(CancellationReason.Abandoned);
    for await (const event of turn.stream()) {
      void event;
    }
    expect(turn.state.status).toBe('cancelled');
    if (turn.state.status === 'cancelled') {
      expect(turn.state.reason).toBe(CancellationReason.Abandoned);
    }
    const stored = await store.getTurn({
      session_id: 's1',
      turn_id: turn.id,
    });
    expect(stored?.state.status).toBe('cancelled');
    if (stored?.state.status === 'cancelled') {
      expect(stored.state.reason).toBe(CancellationReason.Abandoned);
    }
  });

  it('abort with ServerExecutionTimeout persists reason server-execution-timeout', async () => {
    const { store, session } = await createSession();
    const controller = new AbortController();
    const turn = await session.createTurn({
      turn_id: mintTestTurnId(),
      input: [{ type: EventType.USER_MESSAGE, content: 'hello' }],
      previous_turn_id: 'none',
      signal: controller.signal,
      resolver: makeTestResolver(),
    });
    controller.abort(CancellationReason.ServerExecutionTimeout);
    for await (const event of turn.stream()) {
      void event;
    }
    expect(turn.state.status).toBe('cancelled');
    if (turn.state.status === 'cancelled') {
      expect(turn.state.reason).toBe(CancellationReason.ServerExecutionTimeout);
    }
    const stored = await store.getTurn({
      session_id: 's1',
      turn_id: turn.id,
    });
    expect(stored?.state.status).toBe('cancelled');
    if (stored?.state.status === 'cancelled') {
      expect(stored.state.reason).toBe(CancellationReason.ServerExecutionTimeout);
    }
  });

  it('resolver.close() called once in finally; throwing close does not flip terminal state', async () => {
    const { store, session } = await createSession();
    let closeCalls = 0;
    const turn = await session.createTurn({
      turn_id: mintTestTurnId(),
      input: [{ type: EventType.USER_MESSAGE, content: 'hello' }],
      previous_turn_id: 'none',
      signal: new AbortController().signal,
      resolver: makeTestResolver({
        close: () => {
          closeCalls += 1;
          return Promise.reject(new Error('close boom'));
        },
      }),
    });
    for await (const event of turn.stream()) {
      void event;
      // drain
    }
    expect(closeCalls).toBe(1);
    expect(turn.state.status).toBe('done');
    const stored = await store.getTurn({
      session_id: 's1',
      turn_id: turn.id,
    });
    expect(stored?.state.status).toBe('done');
  });

  it('TurnResourceResolver.close() closes sandbox handle once and is idempotent', async () => {
    const sandbox = makeStubPublicSandbox();
    const closeSpy = jest.spyOn(sandbox, 'close').mockResolvedValue(undefined);
    const logger = makeSilentLogger();
    const resolver = new TurnResourceResolver({
      llm: () =>
        Promise.resolve({
          modelClient: makeMockILLM({ create: jest.fn().mockImplementation(() => emptyLlmStream()) }),
          defaultModelParams: {},
        }),
      mcp: () => Promise.resolve({ url: 'http://localhost' }),
      mcpRequestTimeoutMs: 60_000,
      mcpConnectTimeoutMs: 5_000,
      sandboxProvider: () => Promise.resolve(sandbox),
      logger,
    });
    const { session } = await createSession();
    // Spec already has sandbox.enabled from createSession helper.
    const turn = await session.createTurn({
      turn_id: mintTestTurnId(),
      input: [{ type: EventType.USER_MESSAGE, content: 'hello' }],
      previous_turn_id: 'none',
      signal: new AbortController().signal,
      resolver,
    });
    for await (const event of turn.stream()) {
      void event;
      // drain
    }
    expect(closeSpy).toHaveBeenCalledTimes(1);
    await resolver.close();
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });
});

describe('TurnResourceResolver caches', () => {
  it('getOrCreateToolSource single-flights by id', async () => {
    const logger = makeSilentLogger();
    let creates = 0;
    const resolver = new (class extends TurnResourceResolver {
      async resolveTwice() {
        const create = async () => {
          creates += 1;
          await new Promise(r => setTimeout(r, 10));
          return new RemoteMCP({
            id: 'svc',
            name: 'svc',
            url: 'http://example.invalid',
            headers: {},
            logger,
            tracing: this.createTracing(),
            requestTimeoutMs: 60_000,
            connectTimeoutMs: 5_000,
            signal: new AbortController().signal,
          });
        };
        const [a, b] = await Promise.all([
          this.getOrCreateToolSource({ id: 'svc', create }),
          this.getOrCreateToolSource({ id: 'svc', create }),
        ]);
        expect(a).toBe(b);
      }
    })({
      llm: () => Promise.resolve({ modelClient: makeMockILLM(), defaultModelParams: {} }),
      mcp: () => Promise.resolve({ url: 'http://example.invalid' }),
      mcpRequestTimeoutMs: 60_000,
      mcpConnectTimeoutMs: 5_000,
      logger,
    });
    await resolver.resolveTwice();
    expect(creates).toBe(1);
  });

  it('resolveSandbox called once per run via SessionHandle.createTurn', async () => {
    const sandbox = makeStubPublicSandbox();
    jest.spyOn(sandbox, 'close').mockResolvedValue(undefined);
    let sandboxCreates = 0;
    const logger = makeSilentLogger();
    const resolver = new TurnResourceResolver({
      llm: () =>
        Promise.resolve({
          modelClient: makeMockILLM({ create: jest.fn().mockImplementation(() => emptyLlmStream()) }),
          defaultModelParams: {},
        }),
      mcp: () => Promise.resolve({ url: 'http://localhost' }),
      mcpRequestTimeoutMs: 60_000,
      mcpConnectTimeoutMs: 5_000,
      sandboxProvider: () => {
        sandboxCreates += 1;
        return Promise.resolve(sandbox);
      },
      logger,
    });
    const store = new InMemorySessionStore();
    const sessions = new Sessions({ sessionStore: store });
    const session = await sessions.create({
      tenant_id: 't',
      session_id: 's',
      created_by: 'user-1',
      agent: {
        type: 'inline',
        spec: makeAgentSpec({
          config: {
            sandbox: { enabled: true, file_downloads: true },
          },
        }),
      },
    });
    const turn = await session.createTurn({
      turn_id: mintTestTurnId(),
      input: [{ type: EventType.USER_MESSAGE, content: 'hi' }],
      previous_turn_id: 'none',
      signal: new AbortController().signal,
      resolver,
    });
    for await (const event of turn.stream()) {
      void event;
      // drain
    }
    expect(sandboxCreates).toBe(1);
  });
});
