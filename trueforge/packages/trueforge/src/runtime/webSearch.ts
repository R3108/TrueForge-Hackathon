import type { WebSearchProvider, WebSearchRequest, WebSearchResponse } from '@truefoundry/trueforge-core/core';
import { z } from 'zod';

const BRAVE_SEARCH_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';
const MAX_RESPONSE_BYTES = 1_000_000;

const BraveResultSchema = z
  .object({
    title: z.string().default(''),
    url: z.string().default(''),
    description: z.string().default(''),
    age: z.string().optional(),
    page_age: z.string().optional(),
  })
  .loose();

const BraveResponseSchema = z
  .object({
    web: z
      .object({
        results: z.array(BraveResultSchema).max(50).default([]),
      })
      .optional(),
  })
  .loose();

function publicHttpUrl(raw: string): string | undefined {
  try {
    const parsed = new URL(raw);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}

async function readBoundedStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  for await (const chunk of stream) {
    totalBytes += chunk.byteLength;
    if (totalBytes > MAX_RESPONSE_BYTES) {
      throw new Error('Web search provider response exceeded the configured safety limit.');
    }
    chunks.push(chunk);
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function readBoundedResponseBody(response: Response): Promise<Uint8Array> {
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null && Number(declaredLength) > MAX_RESPONSE_BYTES) {
    throw new Error('Web search provider response exceeded the configured safety limit.');
  }

  if (response.body !== null) {
    return readBoundedStream(response.body);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_RESPONSE_BYTES) {
    throw new Error('Web search provider response exceeded the configured safety limit.');
  }
  return bytes;
}

export class BraveWebSearchProvider implements WebSearchProvider {
  constructor(
    private readonly options: {
      apiKey: string;
      timeoutMs: number;
      maxResults: number;
      signal: AbortSignal;
    },
  ) {}

  async search(input: WebSearchRequest): Promise<WebSearchResponse> {
    const count = Math.min(input.count, this.options.maxResults);
    const url = new URL(BRAVE_SEARCH_ENDPOINT);
    url.searchParams.set('q', input.query);
    url.searchParams.set('count', String(count));
    url.searchParams.set('safesearch', 'moderate');
    url.searchParams.set('text_decorations', 'false');
    url.searchParams.set('search_lang', 'en');
    if (input.freshness !== undefined) {
      url.searchParams.set(
        'freshness',
        `p${input.freshness === 'day' ? 'd' : input.freshness === 'week' ? 'w' : input.freshness === 'month' ? 'm' : 'y'}`,
      );
    }

    const requestSignal = AbortSignal.any([this.options.signal, AbortSignal.timeout(this.options.timeoutMs)]);
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          'X-Subscription-Token': this.options.apiKey,
        },
        signal: requestSignal,
      });
    } catch (error) {
      if (requestSignal.aborted) {
        const abortError = new Error('Web search request was cancelled or timed out.');
        abortError.name = 'AbortError';
        throw abortError;
      }
      throw error;
    }
    if (!response.ok) {
      throw new Error(`Web search provider returned HTTP ${String(response.status)}.`);
    }

    const bytes = await readBoundedResponseBody(response);
    const decoded: unknown = JSON.parse(new TextDecoder().decode(bytes));
    const parsed = BraveResponseSchema.parse(decoded);
    const results: WebSearchResponse['results'] = [];
    for (const item of parsed.web?.results ?? []) {
      const safeUrl = publicHttpUrl(item.url);
      if (safeUrl === undefined) {
        continue;
      }
      results.push({
        title: item.title.slice(0, 300),
        url: safeUrl.slice(0, 2_048),
        snippet: item.description.slice(0, 2_000),
        published_at: (item.page_age ?? item.age ?? null)?.slice(0, 100) ?? null,
      });
      if (results.length >= count) {
        break;
      }
    }
    return { query: input.query, results };
  }
}
