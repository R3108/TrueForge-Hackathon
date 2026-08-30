import { MAIN_THREAD_ID } from '../../src/agent-session/models/TurnRecord';
import { EventType } from '../../src/agent-session/schemas/events';
import { Sessions } from '../../src/agent-session/Sessions';
import { InMemorySessionStore } from '../../src/agent-session/store/InMemorySessionStore';
import type { TurnHandle } from '../../src/agent-session/TurnHandle';
import { TurnResourceResolver } from '../../src/agent-session/TurnResourceResolver';
import {
  ADAPTIVE_CONTROL_STATE_KEY,
  AdaptiveControlStateSchema,
} from '../../src/core/capabilities/builtins/AdaptiveControls';
import type { AgentDefinition } from '../../src/core/runtime/AgentDefinition';
import { emptyLlmStream, makeAgentSpec, makeMockILLM, makeSilentLogger, mintTestTurnId } from './testHelpers';

function makeResolver(options: {
  models: string[];
  reasoningEfforts?: readonly string[];
  rejectModel?: string;
}): TurnResourceResolver {
  return new TurnResourceResolver({
    llm: model => {
      options.models.push(model);
      if (model === options.rejectModel) {
        return Promise.reject(new Error(`unknown configured model: ${model}`));
      }
      const modelProperties: AgentDefinition['modelProperties'] = {
        contextLength: 100_000,
        reasoningEfforts: options.reasoningEfforts,
      };
      return Promise.resolve({
        modelClient: makeMockILLM({
          create: jest.fn().mockImplementation(() => emptyLlmStream()),
        }),
        defaultModelParams: {},
        modelProperties,
      });
    },
    mcp: name => Promise.reject(new Error(`unexpected MCP lookup: ${name}`)),
    mcpRequestTimeoutMs: 60_000,
    mcpConnectTimeoutMs: 5_000,
    logger: makeSilentLogger(),
  });
}

async function drain(turn: TurnHandle) {
  for await (const event of turn.stream()) {
    void event;
  }
}

function makeSession() {
  const store = new InMemorySessionStore();
  const sessions = new Sessions({ sessionStore: store });
  const sessionPromise = sessions.create({
    tenant_id: 'tenant-1',
    session_id: 'adaptive-session',
    created_by: 'user-1',
    agent: {
      type: 'inline' as const,
      spec: makeAgentSpec({ model: { name: 'provider/base' } }),
    },
  });
  return { store, sessionPromise };
}

describe('SessionHandle adaptive controls', () => {
  it('resolves the effective model, sanitizes model context, and preserves original public input', async () => {
    const { store, sessionPromise } = makeSession();
    const session = await sessionPromise;
    const models: string[] = [];
    const original = '/model provider/other\n/effort high\n/goal ship it\nImplement now.';
    const turn = await session.createTurn({
      turn_id: mintTestTurnId(),
      input: [{ type: EventType.USER_MESSAGE, content: original }],
      previous_turn_id: 'none',
      signal: new AbortController().signal,
      resolver: makeResolver({ models, reasoningEfforts: ['low', 'high'] }),
    });

    expect(models).toEqual(['provider/other']);
    const stored = await store.getTurn({ session_id: session.session_id, turn_id: turn.id });
    expect(stored?.input).toEqual([{ type: EventType.USER_MESSAGE, content: original }]);
    const main = stored?.snapshot.threads[MAIN_THREAD_ID];
    expect(main?.context).toContainEqual({ role: 'user', content: 'Implement now.' });
    expect(main?.capability_state?.[ADAPTIVE_CONTROL_STATE_KEY]).toMatchObject({
      model: 'provider/other',
      effort: 'high',
      goal: 'ship it',
    });
    await drain(turn);
  });

  it('rehydrates state on the next turn and allows deterministic fork clearing', async () => {
    const { store, sessionPromise } = makeSession();
    const session = await sessionPromise;
    const firstModels: string[] = [];
    const first = await session.createTurn({
      turn_id: mintTestTurnId(),
      input: [{ type: EventType.USER_MESSAGE, content: '/model provider/other\n/goal durable\nstart' }],
      previous_turn_id: 'none',
      signal: new AbortController().signal,
      resolver: makeResolver({ models: firstModels }),
    });
    await drain(first);

    const secondModels: string[] = [];
    const second = await session.createTurn({
      turn_id: mintTestTurnId(),
      input: [{ type: EventType.USER_MESSAGE, content: 'continue' }],
      previous_turn_id: 'auto',
      signal: new AbortController().signal,
      resolver: makeResolver({ models: secondModels }),
    });
    expect(secondModels).toEqual(['provider/other']);
    const secondStored = await store.getTurn({ session_id: session.session_id, turn_id: second.id });
    expect(
      secondStored?.snapshot.threads[MAIN_THREAD_ID]?.capability_state?.[ADAPTIVE_CONTROL_STATE_KEY],
    ).toMatchObject({
      model: 'provider/other',
      goal: 'durable',
    });
    await drain(second);

    const forkModels: string[] = [];
    const fork = await session.createTurn({
      turn_id: mintTestTurnId(),
      input: [{ type: EventType.USER_MESSAGE, content: '/model clear\n/goal clear\nuse defaults' }],
      previous_turn_id: first.id,
      signal: new AbortController().signal,
      resolver: makeResolver({ models: forkModels }),
    });
    expect(forkModels).toEqual(['provider/base']);
    const forkStored = await store.getTurn({ session_id: session.session_id, turn_id: fork.id });
    const rawState = forkStored?.snapshot.threads[MAIN_THREAD_ID]?.capability_state?.[ADAPTIVE_CONTROL_STATE_KEY];
    const state = AdaptiveControlStateSchema.parse(rawState);
    expect(state?.model).toBeNull();
    expect(state?.goal).toBeNull();
    await drain(fork);
  });

  it('rejects unsupported efforts and unknown models before committing a turn', async () => {
    const { store, sessionPromise } = makeSession();
    const session = await sessionPromise;
    const unsupportedTurnId = mintTestTurnId();

    await expect(
      session.createTurn({
        turn_id: unsupportedTurnId,
        input: [{ type: EventType.USER_MESSAGE, content: '/effort extreme\nwork' }],
        previous_turn_id: 'none',
        signal: new AbortController().signal,
        resolver: makeResolver({ models: [], reasoningEfforts: ['low', 'medium', 'high'] }),
      }),
    ).rejects.toThrow("Adaptive reasoning effort 'extreme' is not supported");
    expect(await store.getTurn({ session_id: session.session_id, turn_id: unsupportedTurnId })).toBeUndefined();

    const unknownTurnId = mintTestTurnId();
    await expect(
      session.createTurn({
        turn_id: unknownTurnId,
        input: [{ type: EventType.USER_MESSAGE, content: '/model provider/missing\nwork' }],
        previous_turn_id: 'none',
        signal: new AbortController().signal,
        resolver: makeResolver({ models: [], rejectModel: 'provider/missing' }),
      }),
    ).rejects.toThrow('unknown configured model: provider/missing');
    expect(await store.getTurn({ session_id: session.session_id, turn_id: unknownTurnId })).toBeUndefined();
  });
});
