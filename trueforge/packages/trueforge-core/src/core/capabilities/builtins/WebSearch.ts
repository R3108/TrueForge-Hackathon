import { z } from 'zod';
import { type CallToolResponse, toolResultResponse } from '../../mcp/IMCPServer';
import { defineTool, LocalToolMCP, type ToolDefinition } from '../../mcp/LocalToolMCP';
import type { AgentTracing } from '../../tracing/AgentTracing';
import type { AgentCapability } from '../AgentCapability';

export const WEB_SEARCH_SERVER_ID = 'web-search';
export const WEB_SEARCH_TOOL_NAME = 'web_search';

export const WebSearchRequestSchema = z
  .object({
    query: z.string().trim().min(1).max(500),
    count: z.number().int().min(1).max(10).default(5),
    freshness: z.enum(['day', 'week', 'month', 'year']).optional(),
  })
  .strict();

export const WebSearchResultSchema = z
  .object({
    title: z.string().max(300),
    url: z.url().max(2_048),
    snippet: z.string().max(2_000),
    published_at: z.string().max(100).nullable(),
  })
  .strict();

export const WebSearchResponseSchema = z
  .object({
    query: z.string().max(500),
    results: z.array(WebSearchResultSchema).max(10),
  })
  .strict();

export type WebSearchRequest = z.infer<typeof WebSearchRequestSchema>;
export type WebSearchResponse = z.infer<typeof WebSearchResponseSchema>;

/** Host-owned provider. Implementations keep credentials outside AgentSpec, events, and model context. */
export interface WebSearchProvider {
  search(input: WebSearchRequest): Promise<WebSearchResponse>;
}

export class WebSearch extends LocalToolMCP {
  readonly name = WEB_SEARCH_SERVER_ID;
  readonly displayName = 'Web Search';
  override readonly description = 'Searches the public web for current information using a host-configured provider.';

  private readonly tools: ToolDefinition[];

  constructor(options: { provider: WebSearchProvider; tracing: AgentTracing }) {
    super({ tracing: options.tracing });
    const outputSchema = WebSearchResponseSchema.toJSONSchema({ io: 'output' });
    this.tools = [
      defineTool({
        name: WEB_SEARCH_TOOL_NAME,
        description:
          'Search the public web for current information. Returns bounded titles, URLs, snippets, and optional publication timestamps.',
        schema: WebSearchRequestSchema,
        capability: {
          side_effect_class: 'read_only',
          retry_capability: 'safe',
          concurrency: { kind: 'parallel_safe' },
          timeout_ms: null,
          output_schema: outputSchema,
          result_size_class: 'medium',
          evidence_capabilities: ['web_search_results'],
          sensitive_argument_paths: [],
          tags: ['web', 'search', 'realtime', 'read'],
        },
        handler: async input => await this.search(options.provider, input),
      }),
    ];
  }

  protected getTools(): ToolDefinition[] {
    return this.tools;
  }

  private async search(provider: WebSearchProvider, input: WebSearchRequest): Promise<CallToolResponse> {
    try {
      const response = WebSearchResponseSchema.parse(await provider.search(input));
      return toolResultResponse({
        text: JSON.stringify(response),
        structuredContent: response,
      });
    } catch (error) {
      const aborted = error instanceof Error && error.name === 'AbortError';
      return toolResultResponse({
        text: JSON.stringify({
          error: aborted ? 'web_search_cancelled' : 'web_search_failed',
          message: aborted
            ? 'The web search was cancelled or timed out.'
            : 'The configured web search provider could not complete the request.',
        }),
        isError: true,
      });
    }
  }
}

export function webSearch(options: { provider: WebSearchProvider; tracing: AgentTracing }): AgentCapability {
  return { systemToolSets: [new WebSearch(options)] };
}
