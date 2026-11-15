import { describe, expect, test } from 'bun:test';
import { readSetupWizardLiveDurableReceipts } from '../../input/setup-wizard-live-receipts.ts';
import type { CommandContext } from '../../input/command-registry.ts';
import { buildSetupWizard } from '../../tools/agent-harness-setup-smoke.ts';

function contextWith(setupReceipts: unknown): CommandContext {
  return { platform: { readModels: { setup: { receipts: setupReceipts } } }, clients: {} } as unknown as CommandContext;
}

describe('setup receipts from the host read models', () => {
  test('a read model that throws is reported as unavailable, not as having no receipts', () => {
    const result = readSetupWizardLiveDurableReceipts(contextWith({ list: () => { throw new Error('host unreachable'); } }));
    expect(result.receipts).toEqual([]);
    expect(result.unavailable).toContain('context.platform.readModels.setup.receipts');
  });

  test('a read model that answers asynchronously is reported as unavailable and its rejection stays handled', async () => {
    const rejected = Promise.reject(new Error('late failure'));
    const result = readSetupWizardLiveDurableReceipts(contextWith({ list: () => rejected }));
    expect(result.unavailable).toContain('context.platform.readModels.setup.receipts');
    // No unhandled rejection: the promise already has a handler attached.
    await rejected.catch(() => {});
  });

  test('a context with no read models has nothing unavailable', () => {
    const result = readSetupWizardLiveDurableReceipts({ platform: {}, clients: {} } as unknown as CommandContext);
    expect(result.unavailable).toEqual([]);
  });

  test('the setup wizard says its receipts are unavailable instead of presenting an empty list', () => {
    const wizard = buildSetupWizard([], contextWith({ list: () => { throw new Error('host unreachable'); } }));
    expect(wizard.next).toContain('receipts unavailable: context.platform.readModels.setup.receipts');
    const healthy = buildSetupWizard([], { platform: {}, clients: {} } as unknown as CommandContext);
    expect(healthy.next).not.toContain('receipts unavailable');
  });
});
