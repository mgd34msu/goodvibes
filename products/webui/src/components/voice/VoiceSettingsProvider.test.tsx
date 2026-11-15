import { afterEach, expect, mock, test } from 'bun:test';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const writes: { key: string; value: string }[] = [];
mock.module('../../lib/voice/useVoice', () => ({
  useVoiceStatus: () => ({
    availability: {
      enabled: true, ttsAvailable: true, sttAvailable: false, note: '', defaultTtsProviderId: 'a',
      providers: [
        { id: 'a', label: 'Provider A', capabilities: ['tts'] },
        { id: 'b', label: 'Provider B', capabilities: ['tts'] },
      ],
    },
    isLoading: false,
  }),
  useSharedVoiceConfig: () => ({ config: { provider: 'a', voice: 'alloy' }, isLoading: false }),
}));
mock.module('../../lib/goodvibes', () => ({
  invokeMethod: (_method: string, params: { key: string; value: string }) => { writes.push(params); return Promise.resolve({}); },
  client: { operator: { voice: { voices: () => Promise.resolve({ voices: [{ id: 'alloy', label: 'Alloy' }] }) } } },
}));
mock.module('../../hooks/useVoiceLocalSetup', () => ({
  useVoiceLocalStatus: () => ({ isPending: false, isError: false, isSuccess: false, data: undefined }),
  useVoiceLocalInstall: () => ({ isPending: false, isError: false, isSuccess: false, data: undefined, mutate: () => {} }),
}));
mock.module('./WakeWordSettings', () => ({ WakeWordSettings: () => null }));

const { VoiceSettings } = await import('./VoiceSettings');

let cleanup: (() => void) | null = null;
afterEach(() => { cleanup?.(); cleanup = null; writes.length = 0; });

test('switching provider clears the previous provider voice before writing the provider', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement('div'); document.body.appendChild(container);
  const root = createRoot(container);
  flushSync(() => root.render(<QueryClientProvider client={client}><VoiceSettings /></QueryClientProvider>));
  cleanup = () => { flushSync(() => root.unmount()); container.remove(); client.clear(); };
  flushSync(() => { (container.querySelector('.voice-settings-btn') as HTMLButtonElement).click(); });
  const trigger = document.body.querySelector('.voice-settings-provider') as HTMLButtonElement;
  flushSync(() => { trigger.click(); });
  const option = [...document.body.querySelectorAll('[role="option"]')].find((node) => node.textContent?.includes('Provider B')) as HTMLElement;
  flushSync(() => { option.click(); });
  for (let i = 0; i < 20 && writes.length < 2; i += 1) await new Promise((resolve) => setImmediate(resolve));
  expect(writes).toEqual([{ key: 'tts.voice', value: '' }, { key: 'tts.provider', value: 'b' }]);
});
