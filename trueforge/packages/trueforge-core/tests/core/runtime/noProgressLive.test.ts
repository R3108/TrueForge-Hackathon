import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import type { CapabilityState } from '../../../src/core/capabilities/AgentCapability';
import { EventType } from '../../../src/core/events/schema';
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
  type IToolSet,
  type ListToolsResolvedResponse,
  type ToolSource,
} from '../../../src/core/mcp/IMCPServer';
import {
  NO_PROGRESS_STATE_KEY,
  NoProgressStateSchema,
  type NoProgressOverride,
} from '../../../src/core/mcp/NoProgressController';
import { ToolSet } from '../../../src/core/mcp/ToolSet';
import { AgentThread } from '../../../src/core/runtime/AgentThread';
import type { AgentThreadEvent, ContextMessage } from '../../../src/core/runtime/AgentThread.types';
import { InternalEventType } from '../../../src/core/runtime/AgentThread.types';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';
import { makeSilentLogger } from '../harnessMocks';

const OBJECT_SCHEMA = { type: 'object' as const, properties: {} };
const SYSTEM_TAG_START = '<tfy-internal>';

interface ScriptedTurn {
  /** A single tool call to emit (name + args), or `null` to stop with content. */
  toolCall: { name: string; arguments: string } | null;
  /** Optionally emit multiple tool calls in one assistant message (a mixed batch). Takes precedence. */
  toolCalls?: { name: string; arguments: string }[];
}

/** ILLM driven by a script; captures every request body it receives for ephemeral-injection asserts. */
function makeScriptedLLM(script: ScriptedTurn[]): {
  llm: ILLM;
  requests: LLMCreateParamsStreaming[];
  turnCount: () => number;
} {
  const requests: LLMCreateParamsStreaming[] = [];
  let turn = 0;
  async function* stream(
    body: LLMCreateParamsStreaming,
  ): AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown> {
    requests.push(body);
    const step = script[Math.min(turn, script.length - 1)];
    turn++;
    const batch = step?.toolCalls ?? (step?.toolCall ? [step.toolCall] : []);
    if (batch.length > 0) {
      const tcs = batch.map((call, index) => ({
        id: `call-${String(turn)}-${String(index)}`,
        type: 'function' as const,
        function: { name: call.name, arguments: call.arguments },
      }));
      yield {
        id: `chunk-${String(turn)}`,
        object: 'chat.completion.chunk',
        created: 0,
        model: 'test',
        choices: [
          {
            index: 0,
            delta: { role: 'assistant', tool_calls: tcs.map((tc, index) => ({ index, ...tc })) },
            finish_reason: 'tool_calls',
          },
        ],
      };
      return {
        output: { role: 'assistant', content: null, tool_calls: tcs },
        usage: getEmptyUsage(),
        finish_reason: 'tool_calls',
      };
    }
    yield {
      id: `chunk-${String(turn)}`,
      object: 'chat.completion.chunk',
      created: 0,
      model: 'test',
      choices: [{ index: 0, delta: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }],
    };
    return { output: { role: 'assistant', content: 'done' }, usage: getEmptyUsage(), finish_reason: 'stop' };
  }
  return { llm: { create: stream, createNonStream: jest.fn() }, requests, turnCount: () => turn };
}

/** ToolSource with a single tool that returns a fixed result and counts dispatches. */
function makeToolSource(result = 'same-output'): { source: ToolSource; dispatched: () => number } {
  let dispatched = 0;
  const source: ToolSource = {
    name: 'server',
    id: 'server',
    listTools: (): Promise<ListToolsResolvedResponse> =>
      Promise.resolve({
        result: { tools: [{ name: 'op', description: 'op', inputSchema: OBJECT_SCHEMA, preload: true }] },
        wasInitialized: undefined,
      }),
    callTool: (): Promise<CallToolResponse> => {
      dispatched++;
      return Promise.resolve(toolResultResponse({ text: result }));
    },
    toolCallInfo: (params: CallToolRequest['params']): Promise<InternalToolCallInfo> =>
      Promise.resolve({
        type: 'mcp',
        mcp_server_id: 'server',
        mcp_server_name: 'server',
        original_tool_name: params.name,
      }),
  };
  return { source, dispatched: () => dispatched };
}

function makeToolSet(source: ToolSource, requireApproval = false): ToolSet {
  return new ToolSet({
    source,
    selectors: {
      enableTools: ['@all'],
      disableTools: [],
      preloadTools: [],
      requireApprovalForTools: requireApproval ? ['@all'] : [],
    },
    preload: true,
  });
}

function makeThread(options: {
  llm: ILLM;
  toolSet: ToolSet;
  extraToolSets?: readonly IToolSet[];
  noProgress?: NoProgressOverride | undefined;
  context?: ContextMessage[] | undefined;
  capabilityState?: CapabilityState | undefined;
}): AgentThread {
  return new AgentThread({
    definition: {
      modelClient: options.llm,
      toolSets: [options.toolSet, ...(options.extraToolSets ?? [])],
      iterationLimit: 50,
      ...(options.noProgress !== undefined ? { noProgress: options.noProgress } : {}),
    },
    threadId: 'main',
    title: 'test',
    ...(options.context ? { context: options.context } : {}),
    ...(options.capabilityState ? { capabilityState: options.capabilityState } : {}),
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

/** Count how many injected LLM requests carried an ephemeral tfy-internal no-progress guidance. */
function ephemeralGuidanceCount(requests: LLMCreateParamsStreaming[]): number {
  let count = 0;
  for (const req of requests) {
    for (const msg of req.messages) {
      if (
        msg.role === 'user' &&
        typeof msg.content === 'string' &&
        msg.content.startsWith(SYSTEM_TAG_START) &&
        /no progress|re-?plan|change your approach/i.test(msg.content)
      ) {
        count++;
      }
    }
  }
  return count;
}

function lastCapabilityStateEvent(events: AgentThreadEvent[]): { key: string; state: unknown } | undefined {
  const stateEvents = events.filter(e => e.type === InternalEventType.CAPABILITY_STATE);
  const last = stateEvents.at(-1);
  return last && last.type === InternalEventType.CAPABILITY_STATE ? { key: last.key, state: last.state } : undefined;
}

describe('AgentThread live no-progress enforcement', () => {
  it('injects ephemeral reminder then replan guidance before the LLM call as the loop repeats', async () => {
    const script: ScriptedTurn[] = Array.from({ length: 6 }, () => ({
      toolCall: { name: 'op', arguments: '{"x":1}' },
    }));
    const { llm, requests } = makeScriptedLLM(script);
    const { source } = makeToolSource();
    const thread = makeThread({
      llm,
      toolSet: makeToolSet(source),
      noProgress: { reminder_threshold: 1, replan_threshold: 2, stop_threshold: 3 },
    });

    const events = await drain(thread.execute());

    const doneError = events.find(e => e.type === InternalEventType.AGENT_DONE && e.status === 'error');
    expect(doneError).toBeDefined();

    expect(ephemeralGuidanceCount(requests)).toBeGreaterThanOrEqual(2);

    // Ephemeral guidance is never persisted into durable context.
    const snapshot = thread.toSnapshot();
    const durableInternal = snapshot.context.filter(
      m => 'role' in m && m.role === 'user' && typeof m.content === 'string' && m.content.startsWith(SYSTEM_TAG_START),
    );
    expect(durableInternal).toHaveLength(0);

    const metrics = thread.getAgentThreadMetrics();
    expect(metrics.total_no_progress_reminders ?? 0).toBeGreaterThanOrEqual(1);
    expect(metrics.total_no_progress_replans ?? 0).toBeGreaterThanOrEqual(1);
    expect(metrics.total_no_progress_stops).toBe(1);
  });

  it('stops before another LLM/tool dispatch once the stop threshold is reached', async () => {
    const script: ScriptedTurn[] = Array.from({ length: 10 }, () => ({
      toolCall: { name: 'op', arguments: '{"x":1}' },
    }));
    const { llm, requests } = makeScriptedLLM(script);
    const { source, dispatched } = makeToolSource();
    const thread = makeThread({
      llm,
      toolSet: makeToolSet(source),
      noProgress: { reminder_threshold: 1, replan_threshold: 2, stop_threshold: 3 },
    });

    const events = await drain(thread.execute());
    const doneError = events.find(e => e.type === InternalEventType.AGENT_DONE && e.status === 'error');
    if (doneError?.type !== InternalEventType.AGENT_DONE || doneError.status !== 'error') {
      throw new Error('expected an error done event');
    }
    expect(doneError.error).toMatch(/no progress/i);

    // Batch 1 opens the epoch (count 0); 2→count1; 3→count2; 4→count3 == stop. The stop is enforced
    // at the following llm-call-required boundary, so exactly 4 tool dispatches and 4 LLM calls.
    expect(dispatched()).toBe(4);
    expect(requests.length).toBe(4);
  });

  it('a changed strategy resets the budget and avoids a stop', async () => {
    const script: ScriptedTurn[] = [
      { toolCall: { name: 'op', arguments: '{"x":1}' } },
      { toolCall: { name: 'op', arguments: '{"x":1}' } },
      { toolCall: { name: 'op', arguments: '{"x":2}' } },
      { toolCall: null },
    ];
    const { llm } = makeScriptedLLM(script);
    const source: ToolSource = {
      name: 'server',
      id: 'server',
      listTools: () =>
        Promise.resolve({
          result: { tools: [{ name: 'op', description: 'op', inputSchema: OBJECT_SCHEMA, preload: true }] },
          wasInitialized: undefined,
        }),
      callTool: (params: CallToolRequest['params']) => {
        const arg = params.arguments ? JSON.stringify(params.arguments) : '{}';
        return Promise.resolve(toolResultResponse({ text: `out-${arg}` }));
      },
      toolCallInfo: (params: CallToolRequest['params']) =>
        Promise.resolve({
          type: 'mcp',
          mcp_server_id: 'server',
          mcp_server_name: 'server',
          original_tool_name: params.name,
        }),
    };
    const thread = makeThread({
      llm,
      toolSet: makeToolSet(source),
      noProgress: { reminder_threshold: 1, replan_threshold: 2, stop_threshold: 3 },
    });

    const events = await drain(thread.execute());
    expect(events.some(e => e.type === InternalEventType.AGENT_DONE && e.status === 'done')).toBe(true);
    expect(events.some(e => e.type === InternalEventType.AGENT_DONE && e.status === 'error')).toBe(false);
    expect(thread.getAgentThreadMetrics().total_no_progress_stops ?? 0).toBe(0);
  });

  it('does not stop while waiting for approval (stop only fires at llm-call-required)', async () => {
    const script: ScriptedTurn[] = [{ toolCall: { name: 'op', arguments: '{"x":1}' } }];
    const { llm } = makeScriptedLLM(script);
    const { source, dispatched } = makeToolSource();
    const thread = makeThread({
      llm,
      toolSet: makeToolSet(source, true),
      noProgress: { reminder_threshold: 1, replan_threshold: 2, stop_threshold: 3 },
    });

    const events = await drain(thread.execute());
    expect(events.some(e => e.type === EventType.TOOL_APPROVAL_REQUIRED)).toBe(true);
    expect(dispatched()).toBe(0);
    expect(events.some(e => e.type === InternalEventType.AGENT_DONE && e.status === 'error')).toBe(false);
    // No ordinary tool batch completed, so no no-progress state was written this turn.
    expect(lastCapabilityStateEvent(events)).toBeUndefined();
  });

  it('persists no-progress state via CAPABILITY_STATE and survives a store-backed restart to stop without another dispatch', async () => {
    // --- Run 1: one clean llm→tool→stop turn. Capture the persisted no-progress state. ---
    const run1 = makeScriptedLLM([{ toolCall: { name: 'op', arguments: '{"x":1}' } }, { toolCall: null }]);
    const { source: sourceA, dispatched: dispatchedA } = makeToolSource();
    const threadA = makeThread({
      llm: run1.llm,
      toolSet: makeToolSet(sourceA),
      noProgress: { reminder_threshold: 1, replan_threshold: 2, stop_threshold: 3 },
    });
    const eventsA = await drain(threadA.execute());
    expect(dispatchedA()).toBe(1);

    // The CAPABILITY_STATE event was emitted under the reserved key and mirrored into the snapshot.
    const stateEvent = lastCapabilityStateEvent(eventsA);
    expect(stateEvent?.key).toBe(NO_PROGRESS_STATE_KEY);
    const snapshotA = threadA.toSnapshot();
    const persisted = NoProgressStateSchema.parse(snapshotA.capability_state?.[NO_PROGRESS_STATE_KEY]);
    expect(persisted.no_progress_count).toBe(0); // one batch: epoch opened

    // Simulate the store carrying state to the brink of a stop (count == stop_threshold - 1) with the
    // same action/outcome signatures the next identical batch will reproduce.
    const brink = { ...persisted, no_progress_count: 2, first_failure_counted: false };
    const rehydrateState: CapabilityState = { [NO_PROGRESS_STATE_KEY]: brink };

    // --- Run 2 (restart): rebuild from the persisted snapshot. One identical batch → stop. ---
    const run2 = makeScriptedLLM(
      Array.from({ length: 10 }, () => ({ toolCall: { name: 'op', arguments: '{"x":1}' } })),
    );
    const { source: source2, dispatched: dispatched2 } = makeToolSource();
    const thread2 = makeThread({
      llm: run2.llm,
      toolSet: makeToolSet(source2),
      noProgress: { reminder_threshold: 1, replan_threshold: 2, stop_threshold: 3 },
      capabilityState: rehydrateState,
    });

    const events2 = await drain(thread2.execute());
    expect(events2.some(e => e.type === InternalEventType.AGENT_DONE && e.status === 'error')).toBe(true);
    // Exactly one more tool batch executed after restart before the stop halted further dispatch,
    // and no further LLM dispatch beyond that single batch's llm→tool step.
    expect(dispatched2()).toBe(1);
    expect(run2.turnCount()).toBe(1);
  });

  it('scores the ordinary member of a mixed ordinary+client-side batch so the model cannot evade the stop by pairing a client-side sibling', async () => {
    // One tool set exposes an ordinary `op` and a `csig` whose client-side nature surfaces only at
    // dispatch (via `clientSideToolRequired`). When the model emits BOTH in one batch, executeToolCalls
    // yields a `toolCallResults` entry for `op` AND a `clientSideToolCalls` entry for `csig`: the mixed
    // batch the audit targets. Historically a nonempty clientSideToolCalls suppressed ALL scoring, so
    // the ordinary `op` never advanced the budget and the model could loop forever behind a client
    // sibling. The fix scores the ordinary subset (matched via toolCallResults) while never scoring the
    // pending client-side call and never touching its result cardinality.
    let opDispatched = 0;
    let csigDispatched = 0;
    const mixedSource: ToolSource = {
      name: 'server',
      id: 'server',
      listTools: (): Promise<ListToolsResolvedResponse> =>
        Promise.resolve({
          result: {
            tools: [
              { name: 'op', description: 'op', inputSchema: OBJECT_SCHEMA, preload: true },
              { name: 'csig', description: 'client sibling', inputSchema: OBJECT_SCHEMA, preload: true },
            ],
          },
          wasInitialized: undefined,
        }),
      callTool: (params: CallToolRequest['params']): Promise<CallToolResponse> => {
        if (params.name === 'csig') {
          csigDispatched++;
          return Promise.resolve({
            clientSideToolRequired: {
              tool_info: {
                type: 'mcp',
                mcp_server_id: 'server',
                mcp_server_name: 'server',
                original_tool_name: 'csig',
                is_client_side: true,
              },
            },
          });
        }
        opDispatched++;
        // A hard failure (rejected dispatch) so the ordinary member scores as failed, not a domain result.
        return Promise.reject(new Error('op failed'));
      },
      toolCallInfo: (params: CallToolRequest['params']): Promise<InternalToolCallInfo> =>
        Promise.resolve({
          type: 'mcp',
          mcp_server_id: 'server',
          mcp_server_name: 'server',
          original_tool_name: params.name,
        }),
    };

    // Drive it live: run a first mixed batch, capture the persisted state, lift to the brink, then run
    // a second thread from that state and confirm ONE more identical mixed batch stops.
    const run1 = makeScriptedLLM([
      {
        toolCall: null,
        toolCalls: [
          { name: 'op', arguments: '{"x":1}' },
          { name: 'csig', arguments: '{"q":1}' },
        ],
      },
    ]);
    const thread1 = makeThread({
      llm: run1.llm,
      toolSet: makeToolSet(mixedSource),
      noProgress: { reminder_threshold: 1, replan_threshold: 2, stop_threshold: 3 },
    });
    const events1 = await drain(thread1.execute());
    // The mixed batch was scored despite the client-side sibling: a CAPABILITY_STATE event was emitted
    // under the reserved key, the ordinary `op` was dispatched, and the client sibling stayed pending
    // (no ordinary result recorded for it — cardinality untouched).
    const stateEvent1 = lastCapabilityStateEvent(events1);
    expect(stateEvent1?.key).toBe(NO_PROGRESS_STATE_KEY);
    expect(opDispatched).toBe(1);
    expect(csigDispatched).toBe(1);
    const persisted = NoProgressStateSchema.parse(thread1.toSnapshot().capability_state?.[NO_PROGRESS_STATE_KEY]);
    expect(persisted.first_failure_counted).toBe(true); // the ordinary failure was counted
    expect(persisted.no_progress_count).toBe(1);

    // Lift to the brink (stop_threshold - 1 == 2) keeping the same signatures the next batch reproduces.
    const brink = { ...persisted, no_progress_count: 2 };
    const rehydrateState: CapabilityState = { [NO_PROGRESS_STATE_KEY]: brink };

    opDispatched = 0;
    csigDispatched = 0;
    const run2 = makeScriptedLLM(
      Array.from({ length: 6 }, () => ({
        toolCall: null,
        toolCalls: [
          { name: 'op', arguments: '{"x":1}' },
          { name: 'csig', arguments: '{"q":1}' },
        ],
      })),
    );
    const thread2 = makeThread({
      llm: run2.llm,
      toolSet: makeToolSet(mixedSource),
      noProgress: { reminder_threshold: 1, replan_threshold: 2, stop_threshold: 3 },
      capabilityState: rehydrateState,
    });
    const events2 = await drain(thread2.execute());

    // One more identical mixed batch scored the ordinary `op` failure → the no-progress count reached
    // the stop threshold and the stop latched in durable state, persisted via CAPABILITY_STATE before
    // any further dispatch. The client-side sibling could not shield the loop from the budget.
    const scored2 = NoProgressStateSchema.parse(thread2.toSnapshot().capability_state?.[NO_PROGRESS_STATE_KEY]);
    expect(scored2.no_progress_count).toBe(3); // brink (2) + one scored ordinary failure
    expect(scored2.stopped).toBe(true); // stop latched from the mixed batch's ordinary member
    expect(opDispatched).toBe(1); // exactly one more ordinary dispatch was scored
    expect(csigDispatched).toBe(1);
    expect(thread2.getAgentThreadMetrics().total_no_progress_stops ?? 0).toBe(1);
    // A terminal error event was produced (the stop halts the loop before any further LLM/tool dispatch).
    expect(events2.some(e => e.type === InternalEventType.AGENT_DONE && e.status === 'error')).toBe(true);
  });
});
