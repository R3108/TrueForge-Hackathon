import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import type { InternalToolCallInfo } from '../../../src/core/llm/LLMTypes';
import {
  toolResultResponse,
  type CallToolResponse,
  type ListToolsResolvedResponse,
  type ToolSource,
} from '../../../src/core/mcp/IMCPServer';
import { ToolSet } from '../../../src/core/mcp/ToolSet';

const NAME_SCHEMA = {
  type: 'object' as const,
  properties: { name: { type: 'string' } },
  required: ['name'],
};

/** ToolSource exposing one tool `do` with a discoverable input schema; counts listTools calls. */
function makeSource(): { source: ToolSource; listCount: () => number } {
  let listCount = 0;
  const source: ToolSource = {
    name: 'server',
    id: 'server',
    listTools: (): Promise<ListToolsResolvedResponse> => {
      listCount++;
      return Promise.resolve({
        result: { tools: [{ name: 'do', description: 'does', inputSchema: NAME_SCHEMA, preload: true }] },
        wasInitialized: undefined,
      });
    },
    callTool: (params: CallToolRequest['params']): Promise<CallToolResponse> =>
      Promise.resolve(toolResultResponse({ text: `${params.name}:done` })),
    toolCallInfo: (params: CallToolRequest['params']): Promise<InternalToolCallInfo> =>
      Promise.resolve({
        type: 'mcp',
        mcp_server_id: 'server',
        mcp_server_name: 'server',
        original_tool_name: params.name,
      }),
  };
  return { source, listCount: () => listCount };
}

function makeToolSet(source: ToolSource): ToolSet {
  return new ToolSet({
    source,
    selectors: { enableTools: ['@all'], disableTools: [], preloadTools: [], requireApprovalForTools: [] },
    preload: true,
  });
}

describe('ToolSet input-schema cache', () => {
  it('is empty before any discovery and populated synchronously after listTools', async () => {
    const { source } = makeSource();
    const toolSet = makeToolSet(source);

    expect(toolSet.getToolInputSchema('do')).toBeUndefined();
    await toolSet.listTools();
    expect(toolSet.getToolInputSchema('do')).toEqual(NAME_SCHEMA);
    expect(toolSet.getToolInputSchema('missing')).toBeUndefined();
  });

  it('populates the cache as a side effect of the dispatch preflight (prepareToolCall)', async () => {
    const { source } = makeSource();
    const toolSet = makeToolSet(source);

    expect(toolSet.getToolInputSchema('do')).toBeUndefined();
    await toolSet.prepareToolCall({ name: 'do', arguments: { name: 'x' } });
    expect(toolSet.getToolInputSchema('do')).toEqual(NAME_SCHEMA);
  });

  it('keeps caches instance-isolated across two views over one shared source', async () => {
    const { source } = makeSource();
    const viewA = makeToolSet(source);
    const viewB = makeToolSet(source);

    await viewA.listTools();
    // Only the view that performed discovery has a populated cache; policy/state never bleeds across views.
    expect(viewA.getToolInputSchema('do')).toEqual(NAME_SCHEMA);
    expect(viewB.getToolInputSchema('do')).toBeUndefined();
  });
});
