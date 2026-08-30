import { BraveWebSearchProvider } from '../../../src/runtime/webSearch';

const originalFetch = globalThis.fetch;

function provider(options?: { maxResults?: number; signal?: AbortSignal; timeoutMs?: number }): BraveWebSearchProvider {
  return new BraveWebSearchProvider({
    apiKey: 'test-api-key',
    timeoutMs: options?.timeoutMs ?? 5_000,
    maxResults: options?.maxResults ?? 10,
    signal: options?.signal ?? new AbortController().signal,
  });
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
}

describe('BraveWebSearchProvider', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('calls only the fixed endpoint with credentials in headers and bounded query controls', async () => {
    let requestedUrl = '';
    let requestedHeaders = new Headers();
    globalThis.fetch = async (input, init) => {
      requestedUrl = String(input);
      requestedHeaders = new Headers(init?.headers);
      return jsonResponse({
        web: {
          results: [
            {
              title: 'First result',
              url: 'https://example.com/first',
              description: 'First snippet',
              page_age: '2026-03-01',
            },
            { title: 'Unsafe', url: 'javascript:alert(1)', description: 'drop me' },
            { title: 'Second result', url: 'http://example.org/second', description: 'Second snippet' },
          ],
        },
      });
    };

    const result = await provider({ maxResults: 2 }).search({
      query: 'latest compiler release',
      count: 8,
      freshness: 'week',
    });

    const url = new URL(requestedUrl);
    expect(`${url.origin}${url.pathname}`).toBe('https://api.search.brave.com/res/v1/web/search');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      q: 'latest compiler release',
      count: '2',
      freshness: 'pw',
      safesearch: 'moderate',
      text_decorations: 'false',
      search_lang: 'en',
    });
    expect(requestedHeaders.get('X-Subscription-Token')).toBe('test-api-key');
    expect(requestedHeaders.get('Accept')).toBe('application/json');
    expect(requestedUrl).not.toContain('test-api-key');
    expect(result).toEqual({
      query: 'latest compiler release',
      results: [
        {
          title: 'First result',
          url: 'https://example.com/first',
          snippet: 'First snippet',
          published_at: '2026-03-01',
        },
        {
          title: 'Second result',
          url: 'http://example.org/second',
          snippet: 'Second snippet',
          published_at: null,
        },
      ],
    });
  });

  it('rejects provider HTTP errors, malformed JSON, and malformed provider shapes', async () => {
    const cases = [
      new Response('unavailable', { status: 503 }),
      new Response('{not json', { status: 200 }),
      jsonResponse({ web: { results: 'not-an-array' } }),
    ];

    for (const response of cases) {
      globalThis.fetch = async () => response;
      await expect(provider().search({ query: 'q', count: 1 })).rejects.toBeInstanceOf(Error);
    }
  });

  it('rejects a declared response larger than one megabyte', async () => {
    globalThis.fetch = async () => new Response('{}', { status: 200, headers: { 'Content-Length': '1000001' } });

    await expect(provider().search({ query: 'q', count: 1 })).rejects.toThrow('safety limit');
  });

  it('stops a streamed response once it exceeds one megabyte', async () => {
    const chunk = new Uint8Array(600_000);
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(chunk);
        if (pulls === 2) controller.close();
      },
    });
    globalThis.fetch = async () => new Response(body, { status: 200 });

    await expect(provider().search({ query: 'q', count: 1 })).rejects.toThrow('safety limit');
    expect(pulls).toBe(2);
  });

  it('normalizes host cancellation as AbortError', async () => {
    const controller = new AbortController();
    controller.abort('turn cancelled');
    globalThis.fetch = async (_input, init) => {
      if (init?.signal instanceof AbortSignal && init.signal.aborted) {
        throw new Error('fetch-specific cancellation detail');
      }
      return jsonResponse({});
    };

    const search = provider({ signal: controller.signal }).search({ query: 'q', count: 1 });
    await expect(search).rejects.toMatchObject({ name: 'AbortError' });
    await expect(search).rejects.not.toThrow('fetch-specific cancellation detail');
  });
});
