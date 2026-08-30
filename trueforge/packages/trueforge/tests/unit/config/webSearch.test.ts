import { parseWebSearchEnvironment } from '../../../src/config';

describe('parseWebSearchEnvironment', () => {
  it('defaults to disabled with bounded operational defaults', () => {
    expect(parseWebSearchEnvironment({})).toEqual({
      provider: 'disabled',
      timeoutMs: 15_000,
      maxResults: 10,
    });
  });

  it('accepts a configured Brave provider and coerces numeric environment values', () => {
    expect(
      parseWebSearchEnvironment({
        provider: 'brave',
        apiKey: ' provider-secret ',
        timeoutMs: '2500',
        maxResults: '4',
      }),
    ).toEqual({
      provider: 'brave',
      apiKey: 'provider-secret',
      timeoutMs: 2_500,
      maxResults: 4,
    });
  });

  it.each([
    { provider: 'unknown' },
    { provider: 'brave' },
    { provider: 'brave', apiKey: '   ' },
    { timeoutMs: '0' },
    { timeoutMs: 'not-a-number' },
    { maxResults: '0' },
    { maxResults: '11' },
  ])('rejects invalid configuration %#', input => {
    expect(() => parseWebSearchEnvironment(input)).toThrow();
  });

  it('does not include a valid credential in unrelated validation errors', () => {
    let thrown: unknown;
    try {
      parseWebSearchEnvironment({
        provider: 'brave',
        apiKey: 'must-not-appear-in-errors',
        maxResults: '11',
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    if (!(thrown instanceof Error)) {
      throw new Error('expected configuration validation to throw');
    }
    expect(thrown.message).not.toContain('must-not-appear-in-errors');
  });
});
