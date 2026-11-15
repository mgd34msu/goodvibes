import { afterEach, describe, expect, test } from 'bun:test';
import { installAgentDaemonConfigClient } from '../../config/daemon-config-routing.ts';
import type { CommandContext } from '../../input/command-registry.ts';
import { addressFields, runPaymentsCommand, startAddressEntryFlow } from '../../input/commands/payment-card-intake.ts';

type PlainRequest = { readonly label: string; readonly onSubmit: (value: string) => void; readonly onCancel: () => void };

afterEach(() => { installAgentDaemonConfigClient(null); });

function rig(options: { readonly failLocalKey?: string } = {}) {
  const out: string[] = [];
  const requests: PlainRequest[] = [];
  const localWrites: Array<readonly [string, unknown]> = [];
  const configManager = {
    get: () => '',
    setDynamic: (key: string, value: unknown) => {
      if (key === options.failLocalKey) throw new Error('setting is read-only');
      localWrites.push([key, value]);
    },
  };
  const ctx = {
    print: (text: string) => { out.push(text); },
    renderRequest: () => {},
    platform: { configManager },
    beginPlainInput: (request: PlainRequest) => { requests.push(request); },
  } as unknown as CommandContext;
  /** Answers the current prompt, then lets a host write settle before the flow asks the next one. */
  const answer = async (value: string): Promise<void> => {
    requests.at(-1)!.onSubmit(value);
    for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
  };
  return { ctx, out, requests, localWrites, answer };
}

describe('/payments address', () => {
  test('a field that cannot be saved is named, and the flow does not claim the address was saved', async () => {
    const fields = addressFields('shipping');
    const { ctx, out, answer, localWrites } = rig({ failLocalKey: fields[2]!.key });
    startAddressEntryFlow(ctx, 'shipping');
    for (const [index] of fields.entries()) await answer(`value-${index}`);
    const last = out.at(-1)!;
    expect(last).toContain('only partly saved');
    expect(last).toContain(fields[2]!.label);
    expect(last).not.toContain('saved to the daemon-owned config tier');
    expect(localWrites).toHaveLength(fields.length - 1);
  });

  test('with every field saved the final line says so', async () => {
    const fields = addressFields('billing');
    const { ctx, out, answer } = rig();
    startAddressEntryFlow(ctx, 'billing');
    for (const [index] of fields.entries()) await answer(`value-${index}`);
    expect(out.at(-1)).toContain('Billing address saved to the daemon-owned config tier.');
  });

  test('with a connected host each field is written to the host and nothing is written locally', async () => {
    const fields = addressFields('shipping');
    const hostWrites: Array<readonly [string, unknown]> = [];
    installAgentDaemonConfigClient({
      ownsKey: () => true,
      set: async (key: string, value: unknown) => { hostWrites.push([key, value]); },
      get: async () => undefined,
      snapshot: async () => null,
    });
    const { ctx, out, answer, localWrites } = rig();
    startAddressEntryFlow(ctx, 'shipping');
    for (const [index] of fields.entries()) await answer(`value-${index}`);
    expect(hostWrites).toEqual(fields.map((field, index) => [field.key, `value-${index}`]));
    expect(localWrites).toEqual([]);
    expect(out.at(-1)).toContain('on the connected host');
  });

  test('a host that refuses a field is reported as not saved, with the host\'s reason', async () => {
    const fields = addressFields('shipping');
    installAgentDaemonConfigClient({
      ownsKey: () => true,
      set: async (key: string) => { if (key === fields[0]!.key) throw new Error('connected host is unreachable'); },
      get: async () => undefined,
      snapshot: async () => null,
    });
    const { ctx, out, answer } = rig();
    startAddressEntryFlow(ctx, 'shipping');
    for (const [index] of fields.entries()) await answer(`value-${index}`);
    expect(out.join('\n')).toContain(`Failed to set ${fields[0]!.label}: connected host is unreachable`);
    expect(out.at(-1)).toContain('only partly saved');
  });

  test('/payments status shows the values the connected host holds, not this machine\'s config', async () => {
    const fields = addressFields('shipping');
    installAgentDaemonConfigClient({
      ownsKey: () => true,
      set: async () => {},
      get: async (key: string) => (key === fields[1]!.key ? '9 Host Road' : undefined),
      snapshot: async () => null,
    });
    const { ctx, out } = rig();
    await runPaymentsCommand(['status'], ctx);
    expect(out.join('\n')).toContain('9 Host Road');
  });

  test('/payments status falls back to local config when the host cannot answer', async () => {
    installAgentDaemonConfigClient({
      ownsKey: () => true,
      set: async () => {},
      get: async () => { throw new Error('unreachable'); },
      snapshot: async () => null,
    });
    const { ctx, out } = rig();
    await runPaymentsCommand(['status'], ctx);
    expect(out.join('\n')).toContain('Shipping address:');
  });
});
