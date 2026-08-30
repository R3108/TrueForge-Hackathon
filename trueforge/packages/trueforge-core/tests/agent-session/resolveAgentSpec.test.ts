import { AgentSpecSchema } from '../../src/agent-session/schemas/agentSpec';
import { EventType } from '../../src/agent-session/schemas/events';
import { Sessions } from '../../src/agent-session/Sessions';
import { InMemorySessionStore } from '../../src/agent-session/store/InMemorySessionStore';
import { TurnResourceResolver } from '../../src/agent-session/TurnResourceResolver';
import { makeAgentSpec, makeMockILLM, makeSilentLogger, makeTestResolver, mintTestTurnId } from './testHelpers';

describe('TurnResourceResolver.resolveAgentSpec', () => {
  it('fails closed when deps.agent is not wired for a named lookup', async () => {
    const resolver = new TurnResourceResolver({
      llm: () => Promise.resolve({ modelClient: makeMockILLM(), defaultModelParams: {} }),
      mcp: () => Promise.reject(new Error('unused')),
      mcpRequestTimeoutMs: 1_000,
      mcpConnectTimeoutMs: 1_000,
      logger: makeSilentLogger(),
    });

    await expect(resolver.resolveAgentSpec({ agent_id: 'missing' })).rejects.toThrow(/no agent lookup configured/);
  });
});

describe('TurnResourceResolver.resolveAgentDefinition', () => {
  it('allows existing model resolvers to omit an unknown context length', async () => {
    const resolver = new TurnResourceResolver({
      llm: () => Promise.resolve({ modelClient: makeMockILLM(), defaultModelParams: {} }),
      mcp: () => Promise.reject(new Error('unused')),
      mcpRequestTimeoutMs: 1_000,
      mcpConnectTimeoutMs: 1_000,
      logger: makeSilentLogger(),
    });

    const { definition } = await resolver.resolveAgentDefinition({
      spec: makeAgentSpec(),
      signal: new AbortController().signal,
      tracing: resolver.createTracing(),
    });

    expect(definition.modelProperties).toBeUndefined();
  });

  it('propagates host-owned MCP tool capabilities into the resolved ToolSet', async () => {
    const resolver = new TurnResourceResolver({
      llm: () => Promise.resolve({ modelClient: makeMockILLM(), defaultModelParams: {} }),
      mcp: () =>
        Promise.resolve({
          url: 'http://example.invalid',
          tool_capabilities: [
            {
              tool_name: 'read_issue',
              side_effect_class: 'read_only',
              retry_capability: 'safe',
              concurrency: { kind: 'parallel_safe' },
              timeout_ms: 5_000,
              output_schema: null,
              result_size_class: 'small',
              evidence_capabilities: ['issue_state'],
              sensitive_argument_paths: [],
              tags: ['issue', 'read'],
            },
          ],
        }),
      mcpRequestTimeoutMs: 1_000,
      mcpConnectTimeoutMs: 1_000,
      logger: makeSilentLogger(),
    });
    const spec = AgentSpecSchema.parse({
      model: { name: 'provider/model' },
      mcp_servers: [{ name: 'github' }],
    });

    const { definition } = await resolver.resolveAgentDefinition({
      spec,
      signal: new AbortController().signal,
      tracing: resolver.createTracing(),
    });

    expect(definition.toolSets?.[0]?.getToolCapability?.('read_issue')).toEqual({
      stable_tool_set_id: 'github',
      tool_name: 'read_issue',
      side_effect_class: 'read_only',
      retry_capability: 'safe',
      concurrency: { kind: 'parallel_safe' },
      timeout_ms: 5_000,
      output_schema: null,
      result_size_class: 'small',
      evidence_capabilities: ['issue_state'],
      sensitive_argument_paths: [],
      tags: ['issue', 'read'],
    });
  });

  it('propagates host model choices and drops root-only effort for a different child model', async () => {
    const dynamicSubAgentModels = {
      'provider/root': { description: 'Root model.' },
      'provider/child': { description: 'Child model.' },
    };
    const resolver = new TurnResourceResolver({
      llm: () =>
        Promise.resolve({
          modelClient: makeMockILLM(),
          defaultModelParams: { max_tokens: 2048 },
          dynamicSubAgentModels,
        }),
      mcp: () => Promise.reject(new Error('unused')),
      mcpRequestTimeoutMs: 1_000,
      mcpConnectTimeoutMs: 1_000,
      logger: makeSilentLogger(),
    });
    const spec = AgentSpecSchema.parse({
      model: {
        name: 'provider/root',
        params: { reasoning_effort: 'high', temperature: 0.2 },
      },
    });

    const { definition } = await resolver.resolveAgentDefinition({
      spec,
      agent_info: { type: 'dynamic', name: 'child', input: 'task', model: 'provider/child' },
      signal: new AbortController().signal,
      tracing: resolver.createTracing(),
    });

    expect(definition.dynamicSubAgentModels).toBe(dynamicSubAgentModels);
    expect(definition.modelParams).toEqual({ max_tokens: 2048, temperature: 0.2 });
  });

  it.each([
    {
      name: 'uses the resolved model default when the agent omits max_tokens',
      resolvedModelParams: { max_tokens: 4096 },
      agentModelParams: undefined,
      expected: 4096,
    },
    {
      name: 'lets the agent max_tokens override the resolved model default',
      resolvedModelParams: { max_tokens: 4096 },
      agentModelParams: { max_tokens: 8192 },
      expected: 8192,
    },
  ])('$name', async ({ resolvedModelParams, agentModelParams, expected }) => {
    const resolver = new TurnResourceResolver({
      llm: () =>
        Promise.resolve({
          modelClient: makeMockILLM(),
          defaultModelParams: resolvedModelParams,
          modelProperties: { contextLength: 128_000 },
        }),
      mcp: () => Promise.reject(new Error('unused')),
      mcpRequestTimeoutMs: 1_000,
      mcpConnectTimeoutMs: 1_000,
      logger: makeSilentLogger(),
    });
    const spec = AgentSpecSchema.parse({
      model: {
        name: 'provider/model',
        ...(agentModelParams === undefined ? {} : { params: agentModelParams }),
      },
    });

    const { definition } = await resolver.resolveAgentDefinition({
      spec,
      signal: new AbortController().signal,
      tracing: resolver.createTracing(),
    });

    expect(definition.modelParams?.['max_tokens']).toBe(expected);
    expect(definition.modelProperties?.contextLength).toBe(128_000);
  });
});

describe('SessionHandle.createTurn named resolve', () => {
  it('loads the live AgentSpec through resolver.agent for ref sessions', async () => {
    const store = new InMemorySessionStore();
    const sessions = new Sessions({ sessionStore: store });
    const session = await sessions.create({
      tenant_id: 'tenant-1',
      session_id: 's-named',
      created_by: 'user-1',
      agent: { type: 'reference', id: 'agent-abc', name: null },
    });

    const live = makeAgentSpec({ instructions: 'from-registry' });
    const agent = jest.fn().mockResolvedValue(live);
    const turn = await session.createTurn({
      turn_id: mintTestTurnId(),
      input: [{ type: EventType.USER_MESSAGE, content: 'hi' }],
      previous_turn_id: 'none',
      signal: new AbortController().signal,
      resolver: makeTestResolver({ agent }),
    });

    expect(turn.state.status).toBe('running');
    expect(agent).toHaveBeenCalledWith('agent-abc');
  });
});
