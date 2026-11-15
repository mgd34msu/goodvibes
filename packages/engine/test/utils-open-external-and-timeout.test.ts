import { describe, expect, test } from 'bun:test';
import { externalUrlLaunchers, openExternalUrl } from '../platform/src/platform/utils/open-external.js';
import { fetchWithTimeout } from '../platform/src/platform/utils/fetch-with-timeout.js';

const URL_WITH_AMPERSAND = 'https://auth.example/authorize?response_type=code&client_id=x&a=b|c^d';

describe('externalUrlLaunchers', () => {
  test('no platform hands the URL to the command interpreter', () => {
    for (const [platform, wsl] of [['win32', false], ['linux', true], ['linux', false], ['darwin', false]] as const) {
      for (const launcher of externalUrlLaunchers(URL_WITH_AMPERSAND, platform, wsl)) {
        expect(launcher.command.toLowerCase()).not.toBe('cmd.exe');
        expect(launcher.args).toContain(URL_WITH_AMPERSAND);
      }
    }
  });

  test('Windows uses a protocol handler that takes the URL as one argument', () => {
    expect(externalUrlLaunchers(URL_WITH_AMPERSAND, 'win32', false)).toEqual([
      { command: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', URL_WITH_AMPERSAND] },
    ]);
  });
});

describe('openExternalUrl', () => {
  test('refuses a non-http(s) URL without launching anything', async () => {
    expect(await openExternalUrl('file:///etc/passwd')).toBe(false);
    expect(await openExternalUrl('calc.exe')).toBe(false);
    expect(await openExternalUrl('javascript:alert(1)')).toBe(false);
  });
});

describe('fetchWithTimeout', () => {
  async function aborted(signal: AbortSignal | undefined, bodyFrom: { value?: AbortSignal }): Promise<boolean> {
    await fetchWithTimeout('http://example.invalid/', signal ? { signal } : {}, 5, async (_url, init) => {
      bodyFrom.value = init?.signal as AbortSignal;
      return new Response('x');
    });
    const timeoutSignal = bodyFrom.value!;
    if (!timeoutSignal.aborted) await new Promise<void>((resolve) => timeoutSignal.addEventListener('abort', () => resolve(), { once: true }));
    return timeoutSignal.aborted;
  }

  test('the timeout stays armed after the headers arrive, with and without a caller signal', async () => {
    expect(await aborted(undefined, {})).toBe(true);
    expect(await aborted(new AbortController().signal, {})).toBe(true);
  });
});
