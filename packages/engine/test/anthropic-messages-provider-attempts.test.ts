/**
 * anthropic-messages-provider-attempts.test.ts
 *
 * The shared Bedrock/Vertex base provider builds its vendor client only for an
 * attempt that is going to be sent.
 */
import { describe, expect, test } from 'bun:test';
import { AnthropicMessagesProvider } from '../platform/src/platform/providers/anthropic-messages-provider.ts';

describe('AnthropicMessagesProvider client construction', () => {
  test('no client is built for an attempt the host denies', async () => {
    let built = 0;
    const provider = new AnthropicMessagesProvider({
      name: 'test-anthropic-sdk',
      label: 'Test',
      defaultModel: 'claude-x',
      models: ['claude-x'],
      createClient: () => { built += 1; return { messages: { stream: () => { throw new Error('unreachable'); } } }; },
      auth: { mode: 'api-key', configured: true, detail: 'test' },
      streamProtocol: 'anthropic-sdk-stream',
    });
    await expect(provider.chat({
      model: 'claude-x',
      messages: [{ role: 'user', content: 'hi' }],
      beforeAttempt: async () => { throw new Error('denied by policy'); },
    })).rejects.toThrow('denied by policy');
    expect(built).toBe(0);
  });
});
