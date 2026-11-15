/**
 * The guided /payments address flow with a connected host: the host owns
 * payments.*, so each answer is written to it, a refusal is named, and the
 * local file is left alone. (Without a host the flow writes locally; that
 * fallback is covered by the payments containment suite.)
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import { installAgentDaemonConfigClient } from '../../config/daemon-config-routing.ts';
import type { CommandContext } from '../../input/command-registry.ts';
import { addressFields, startAddressEntryFlow } from '../../input/commands/payment-card-intake.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

let root: string;
let cm: ConfigManager;
let sets: Array<{ key: string; value: unknown }>;
let refuseKey: string | null;

beforeEach(() => {
  root = makeProjectTempDir('gv-payments-address-routing');
  cm = new ConfigManager({ surfaceRoot: 'agent', workingDir: root, homeDir: root, configDir: join(root, '.goodvibes', 'global-agent') });
  sets = [];
  refuseKey = null;
  installAgentDaemonConfigClient({
    ownsKey: (key: string) => key.startsWith('payments.'),
    set: async (key: string, value: unknown) => {
      if (key === refuseKey) throw new Error('host refused the address');
      sets.push({ key, value });
    },
    get: async () => undefined,
    snapshot: async () => null,
  });
});

afterEach(() => {
  installAgentDaemonConfigClient(null);
  rmSync(root, { recursive: true, force: true });
});

/** Drives the flow; `submit` resolves once the flow has moved on (next prompt, or the final summary). */
function drive(kind: 'billing' | 'shipping') {
  const printed: string[] = [];
  let answer: ((value: string) => void | Promise<void>) | null = null;
  let moved: (() => void) | null = null;
  const ctx = {
    print: (text: string) => { printed.push(text); },
    renderRequest: () => { moved?.(); },
    beginPlainInput: (request: { onSubmit: (value: string) => void | Promise<void> }) => {
      answer = request.onSubmit;
      moved?.();
    },
    platform: { configManager: cm },
  } as unknown as CommandContext;
  startAddressEntryFlow(ctx, kind);
  const submit = async (value: string): Promise<void> => {
    const fn = answer;
    answer = null;
    expect(fn).not.toBeNull();
    const next = new Promise<void>((resolve) => { moved = resolve; });
    await fn!(value);
    await next;
  };
  return { printed, submit };
}

describe('/payments address with a connected host', () => {
  test('every answered field is written to the host under its own key and nothing lands in the local file', async () => {
    const { printed, submit } = drive('shipping');
    const fields = addressFields('shipping');
    for (const field of fields) await submit(`value for ${field.label}`);

    expect(sets).toEqual(fields.map((field) => ({ key: field.key, value: `value for ${field.label}` })));
    for (const field of fields) expect<unknown>(cm.get(field.key as never)).toBe('');
    expect(printed.join('\n')).toContain('Shipping address saved to the daemon-owned config tier (on the connected host).');
  });

  test('a blank answer sends nothing to the host', async () => {
    const { submit } = drive('billing');
    const fields = addressFields('billing');
    await submit('   ');
    await submit('1 Main St');
    expect(sets).toEqual([{ key: fields[1]!.key, value: '1 Main St' }]);
  });

  test('a refused field is named, is not written locally, and the flow reports a partial save', async () => {
    const fields = addressFields('shipping');
    refuseKey = fields[1]!.key;
    const { printed, submit } = drive('shipping');
    for (const field of fields) await submit(`value for ${field.label}`);

    const transcript = printed.join('\n');
    expect(transcript).toContain(`Failed to set ${fields[1]!.label}: host refused the address`);
    expect(transcript).toContain(`only partly saved: ${fields[1]!.label} was NOT saved`);
    expect(sets.map((entry) => entry.key)).not.toContain(fields[1]!.key);
    expect(sets).toHaveLength(fields.length - 1);
    expect<unknown>(cm.get(fields[1]!.key as never)).toBe('');
  });
});
