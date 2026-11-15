import { afterEach, describe, expect, spyOn, test } from 'bun:test';

import { logger } from '../platform/src/platform/utils/logger.js';

const restores: Array<() => void> = [];
afterEach(() => { for (const restore of restores.splice(0)) restore(); });

function stubFetch(impl: (url: string | URL | Request, init?: RequestInit) => Promise<Response>) {
  const stub = spyOn(globalThis, 'fetch').mockImplementation(impl as typeof fetch);
  restores.push(() => stub.mockRestore());
  return stub;
}

describe('instrumentedFetch', () => {
  test('forwards the url and init to fetch untouched and returns its response', async () => {
    const { instrumentedFetch } = await import('../platform/src/platform/utils/fetch-with-timeout.js');
    const response = new Response('ok', { status: 201 });
    const stub = stubFetch(async () => response);
    const init = { method: 'POST', body: 'payload' };
    const result = await instrumentedFetch('https://api.example.com/v1/chat?token=SECRET', init);
    expect(result).toBe(response);
    expect(stub).toHaveBeenCalledTimes(1);
    expect(stub.mock.calls[0]).toEqual(['https://api.example.com/v1/chat?token=SECRET', init]);
  });

  test('rethrows the original fetch failure unchanged', async () => {
    const { instrumentedFetch } = await import('../platform/src/platform/utils/fetch-with-timeout.js');
    const failure = new TypeError('fetch failed');
    stubFetch(async () => { throw failure; });
    await expect(instrumentedFetch('https://api.example.com/v1/models')).rejects.toBe(failure);
  });

  test('logs the outbound call with the redacted url and the response status', async () => {
    const { instrumentedFetch } = await import('../platform/src/platform/utils/fetch-with-timeout.js');
    stubFetch(async () => new Response('', { status: 204 }));
    const info = spyOn(logger, 'info').mockImplementation(() => undefined);
    restores.push(() => info.mockRestore());
    await instrumentedFetch('https://api.example.com/v1/chat?api_key=SECRET');
    expect(info).toHaveBeenCalledTimes(1);
    const [name, fields] = info.mock.calls[0]!;
    expect(name).toBe('OUTBOUND_HTTP');
    expect(fields).toMatchObject({ method: 'GET', url: 'https://api.example.com/v1/chat?[redacted]', status: 204 });
  });

  test('sanitizeUrlForLog withholds every query key and value uniformly', async () => {
    const { sanitizeUrlForLog } = await import('../platform/src/platform/utils/fetch-with-timeout.js');
    const input = 'https://api.example.com/v1/chat?api_key=SECRET&token=TOKEN&foo=bar';
    const safe = sanitizeUrlForLog(input);
    expect(safe).toBe('https://api.example.com/v1/chat?[redacted]');
    expect(safe).not.toContain('SECRET');
    expect(safe).not.toContain('TOKEN');
  });

  test('sanitizeUrlForLog does not infer disclosure permission from parameter names', async () => {
    const { sanitizeUrlForLog } = await import('../platform/src/platform/utils/fetch-with-timeout.js');
    const input = 'https://api.example.com/v1/models?version=2&stream=true';
    const safe = sanitizeUrlForLog(input);
    expect(safe).toBe('https://api.example.com/v1/models?[redacted]');
  });

  test('sanitizeUrlForLog handles URL with no query params', async () => {
    const { sanitizeUrlForLog } = await import('../platform/src/platform/utils/fetch-with-timeout.js');
    const input = 'https://api.example.com/v1/models';
    const safe = sanitizeUrlForLog(input);
    expect(safe).toBe('https://api.example.com/v1/models');
  });
});
