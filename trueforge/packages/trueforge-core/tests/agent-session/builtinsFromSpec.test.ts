import { builtinsFromSpec } from '../../src/agent-session/builtinsFromSpec';
import { AgentSpecSchema } from '../../src/agent-session/schemas/agentSpec';
import { SUB_AGENTS_SERVER_ID, SUB_AGENT_TOOL_NAME } from '../../src/core/capabilities/builtins/DynamicSubAgents';
import {
  GET_OPENUI_INSTRUCTIONS_TOOL_NAME,
  OPENUI_SERVER_ID,
  buildOpenUIInstruction,
} from '../../src/core/capabilities/builtins/OpenUI';
import type { WebSearchProvider } from '../../src/core/capabilities/builtins/WebSearch';
import { WEB_SEARCH_SERVER_ID } from '../../src/core/capabilities/builtins/WebSearch';
import type { AgentDefinition } from '../../src/core/runtime/AgentDefinition';
import { NOOP_AGENT_TRACING } from '../../src/core/tracing/NoopAgentTracing';
import { makeMockILLM, makeSilentLogger } from '../core/harnessMocks';

function makeDefinition(webSearchProvider?: WebSearchProvider): AgentDefinition {
  return {
    modelClient: makeMockILLM(),
    webSearchProvider,
  };
}

function runBuiltins(input: {
  spec: ReturnType<typeof AgentSpecSchema.parse>;
  isChild?: boolean;
  webSearchProvider?: WebSearchProvider;
}): ReturnType<typeof builtinsFromSpec> {
  return builtinsFromSpec({
    spec: input.spec,
    definition: makeDefinition(input.webSearchProvider),
    isChild: input.isChild ?? false,
    sandboxAvailable: false,
    tracing: NOOP_AGENT_TRACING,
    logger: makeSilentLogger(),
  });
}

function hasOpenUITool(capabilities: ReturnType<typeof builtinsFromSpec>): boolean {
  return capabilities.some(cap => cap.systemToolSets?.some(ts => ts.name === OPENUI_SERVER_ID));
}

function hasCompactionProcessor(capabilities: ReturnType<typeof builtinsFromSpec>): boolean {
  return capabilities.some(cap => (cap.preLLMProcessors?.length ?? 0) > 0);
}

describe('builtinsFromSpec compaction', () => {
  it('enables compaction by default', () => {
    const capabilities = runBuiltins({
      spec: AgentSpecSchema.parse({ model: { name: 'provider/model' } }),
    });
    expect(hasCompactionProcessor(capabilities)).toBe(true);
  });

  it('disables compaction from the context-management Agent Spec setting', () => {
    const capabilities = runBuiltins({
      spec: AgentSpecSchema.parse({
        model: { name: 'provider/model' },
        config: { context_management: { compaction: { enabled: false } } },
      }),
    });
    expect(hasCompactionProcessor(capabilities)).toBe(false);
  });
});

describe('builtinsFromSpec generative_ui', () => {
  it('enables OpenUI with preload false when generative_ui is omitted', () => {
    const capabilities = runBuiltins({
      spec: AgentSpecSchema.parse({ model: { name: 'provider/model' } }),
    });
    expect(hasOpenUITool(capabilities)).toBe(true);
    const openUICap = capabilities.find(cap => cap.systemToolSets?.some(ts => ts.name === OPENUI_SERVER_ID));
    expect(openUICap?.instructionBuilders?.[0]).not.toBe(buildOpenUIInstruction);
    expect(openUICap?.instructionBuilders).toHaveLength(1);
  });

  it('disables OpenUI when generative_ui.enabled is false', () => {
    const capabilities = runBuiltins({
      spec: AgentSpecSchema.parse({
        model: { name: 'provider/model' },
        config: { generative_ui: { enabled: false } },
      }),
    });
    expect(hasOpenUITool(capabilities)).toBe(false);
  });

  it('never enables OpenUI on child threads', () => {
    const capabilities = runBuiltins({
      spec: AgentSpecSchema.parse({ model: { name: 'provider/model' } }),
      isChild: true,
    });
    expect(hasOpenUITool(capabilities)).toBe(false);
  });

  it('registers get_openui_instructions for root threads', async () => {
    const capabilities = runBuiltins({
      spec: AgentSpecSchema.parse({ model: { name: 'provider/model' } }),
    });
    const toolSet = capabilities
      .flatMap(cap => [...(cap.systemToolSets ?? [])])
      .find(ts => ts.name === OPENUI_SERVER_ID);
    const listed = await toolSet?.listTools();
    if (!listed || 'authRequired' in listed) {
      throw new Error('expected listTools result');
    }
    expect(listed.result.tools.map(t => t.name)).toEqual([GET_OPENUI_INSTRUCTIONS_TOOL_NAME]);
  });
});

describe('builtinsFromSpec web search', () => {
  const spec = AgentSpecSchema.parse({ model: { name: 'provider/model' } });
  const provider: WebSearchProvider = { search: async input => ({ query: input.query, results: [] }) };

  function hasWebSearch(capabilities: ReturnType<typeof builtinsFromSpec>): boolean {
    return capabilities.some(capability =>
      capability.systemToolSets?.some(toolSet => toolSet.name === WEB_SEARCH_SERVER_ID),
    );
  }

  it('does not expose web search without a host provider', () => {
    expect(hasWebSearch(runBuiltins({ spec }))).toBe(false);
  });

  it.each([false, true])('exposes web search with a host provider when isChild=%s', isChild => {
    expect(hasWebSearch(runBuiltins({ spec, isChild, webSearchProvider: provider }))).toBe(true);
  });
});

describe('builtinsFromSpec adaptive controls and model routing', () => {
  const spec = AgentSpecSchema.parse({ model: { name: 'provider/model' } });

  it('registers durable adaptive controls only on the root thread', () => {
    expect(runBuiltins({ spec }).some(capability => capability.state?.key === 'tfy.adaptive_controls')).toBe(true);
    expect(
      runBuiltins({ spec, isChild: true }).some(capability => capability.state?.key === 'tfy.adaptive_controls'),
    ).toBe(false);
  });

  it('limits create_sub_agent model selection to the host-owned configured set', async () => {
    const capabilities = builtinsFromSpec({
      spec,
      definition: {
        ...makeDefinition(),
        dynamicSubAgentModels: {
          'provider/fast': { description: 'Fast configured model.' },
          'provider/deep': { description: 'Deep configured model.' },
        },
      },
      isChild: false,
      sandboxAvailable: false,
      tracing: NOOP_AGENT_TRACING,
      logger: makeSilentLogger(),
    });
    const toolSet = capabilities
      .flatMap(capability => [...(capability.systemToolSets ?? [])])
      .find(candidate => candidate.name === SUB_AGENTS_SERVER_ID);
    const listed = await toolSet?.listTools();
    if (!listed || 'authRequired' in listed) {
      throw new Error('expected dynamic subagent tool list');
    }
    const tool = listed.result.tools.find(candidate => candidate.name === SUB_AGENT_TOOL_NAME);
    expect(tool?.inputSchema).toMatchObject({
      properties: {
        model: { enum: ['provider/fast', 'provider/deep'] },
      },
      required: expect.arrayContaining(['model']),
    });
  });
});
