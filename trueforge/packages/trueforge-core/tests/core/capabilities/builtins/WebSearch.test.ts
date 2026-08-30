import {
  WEB_SEARCH_SERVER_ID,
  WEB_SEARCH_TOOL_NAME,
  WebSearch,
  type WebSearchProvider,
  type WebSearchResponse,
} from '../../../../src/core/capabilities/builtins/WebSearch';
import { isCallToolResponseResult } from '../../../../src/core/mcp/IMCPServer';
import { NOOP_AGENT_TRACING } from '../../../../src/core/tracing/NoopAgentTracing';

const response: WebSearchResponse = {
  query: 'current TypeScript release',
  results: [
    {
      title: 'TypeScript',
      url: 'https://www.typescriptlang.org/',
      snippet: 'Typed JavaScript at any scale.',
      published_at: null,
    },
  ],
};

function makeTool(provider: WebSearchProvider): WebSearch {
  return new WebSearch({ provider, tracing: NOOP_AGENT_TRACING });
}

function resolvedResult(result: Awaited<ReturnType<WebSearch['callTool']>>) {
  if (!isCallToolResponseResult(result)) {
    throw new Error('expected resolved tool response');
  }
  return result.result;
}

describe('WebSearch', () => {
  it('advertises bounded input and host-owned safe read metadata', async () => {
    const tool = makeTool({ search: async () => response });
    const listed = await tool.listTools();
    if ('authRequired' in listed) {
      throw new Error('expected resolved tool list');
    }

    expect(listed.result.tools).toHaveLength(1);
    expect(listed.result.tools[0]).toMatchObject({
      name: WEB_SEARCH_TOOL_NAME,
      inputSchema: {
        additionalProperties: false,
        properties: {
          query: { maxLength: 500, minLength: 1, type: 'string' },
          count: { default: 5, maximum: 10, minimum: 1, type: 'integer' },
        },
      },
    });

    expect(tool.getToolCapability(WEB_SEARCH_TOOL_NAME)).toMatchObject({
      stable_tool_set_id: WEB_SEARCH_SERVER_ID,
      tool_name: WEB_SEARCH_TOOL_NAME,
      side_effect_class: 'read_only',
      retry_capability: 'safe',
      concurrency: { kind: 'parallel_safe' },
      evidence_capabilities: ['web_search_results'],
    });
    expect(tool.getToolCapability(WEB_SEARCH_TOOL_NAME)?.output_schema).not.toBeNull();
  });

  it('applies defaults and returns matching text plus structured content', async () => {
    const search = jest.fn(async () => response);
    const result = resolvedResult(
      await makeTool({ search }).callTool({
        name: WEB_SEARCH_TOOL_NAME,
        arguments: { query: 'current TypeScript release' },
      }),
    );

    expect(search).toHaveBeenCalledWith({ query: 'current TypeScript release', count: 5 });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual(response);
    expect(JSON.parse(result.content[0]?.type === 'text' ? result.content[0].text : '')).toEqual(response);
  });

  it('blocks out-of-bounds and unknown input before provider dispatch', async () => {
    const search = jest.fn(async () => response);
    const tool = makeTool({ search });

    for (const arguments_ of [
      { query: '', count: 5 },
      { query: 'x'.repeat(501), count: 5 },
      { query: 'news', count: 11 },
      { query: 'news', extra: true },
    ]) {
      const result = resolvedResult(await tool.callTool({ name: WEB_SEARCH_TOOL_NAME, arguments: arguments_ }));
      expect(result.isError).toBe(true);
    }
    expect(search).not.toHaveBeenCalled();
  });

  it('normalizes provider failures and invalid provider output without leaking details', async () => {
    for (const provider of [
      { search: async () => Promise.reject(new Error('secret provider detail')) },
      {
        search: async () => ({
          query: 'q',
          results: [{ title: 'bad', url: 'not-a-url', snippet: '', published_at: null }],
        }),
      },
    ]) {
      const result = resolvedResult(
        await makeTool(provider).callTool({ name: WEB_SEARCH_TOOL_NAME, arguments: { query: 'q' } }),
      );
      const text = result.content[0]?.type === 'text' ? result.content[0].text : '';
      expect(result.isError).toBe(true);
      expect(text).toContain('web_search_failed');
      expect(text).not.toContain('secret provider detail');
    }
  });

  it('reports cancellation distinctly', async () => {
    const abortError = new Error('turn stopped');
    abortError.name = 'AbortError';
    const result = resolvedResult(
      await makeTool({ search: async () => Promise.reject(abortError) }).callTool({
        name: WEB_SEARCH_TOOL_NAME,
        arguments: { query: 'q' },
      }),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ type: 'text' });
    expect(result.content[0]?.type === 'text' ? result.content[0].text : '').toContain('web_search_cancelled');
  });
});
