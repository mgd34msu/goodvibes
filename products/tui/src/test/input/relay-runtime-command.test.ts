import { describe, expect, test } from 'bun:test';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { registerRelayRuntimeCommands } from '../../input/commands/relay-runtime.ts';
import { createRelayReadAccessors, type RelayReadAccessors } from '../../runtime/relay-reachability-bridge.ts';

const RELAY_CONFIG: Record<string, unknown> = {
  'relay.enabled': true,
  'relay.url': 'wss://relay.example.com',
  'relay.rendezvousId': 'abc123',
  'relay.label': 'my-daemon',
};

function ctx(options: {
  readonly out: string[];
  readonly configOverrides?: Record<string, unknown>;
  readonly flagOn?: boolean;
  readonly externalServices?: RelayReadAccessors;
}): CommandContext {
  const config = { ...RELAY_CONFIG, ...options.configOverrides };
  return {
    print: (m: string) => options.out.push(m),
    platform: {
      configManager: { get: (key: string) => config[key] },
      featureFlagManager: { isEnabled: () => options.flagOn ?? true },
      externalServices: options.externalServices,
    },
  } as unknown as CommandContext;
}

/** Accessors over a daemon that answers each verb from `answers`, or throws `failure`. */
function daemon(answers: Record<string, unknown>, failure?: string): { accessors: RelayReadAccessors; calls: string[] } {
  const calls: string[] = [];
  const accessors = createRelayReadAccessors({
    probe: () => ({ available: true }),
    invoke: async (method: string) => {
      calls.push(method);
      if (failure) throw new Error(failure);
      return answers[method];
    },
  } as unknown as Parameters<typeof createRelayReadAccessors>[0]);
  return { accessors, calls };
}

async function run(args: string[], options: Parameters<typeof ctx>[0]): Promise<string> {
  const registry = new CommandRegistry();
  registerRelayRuntimeCommands(registry);
  await registry.execute('relay', args, ctx(options));
  return options.out.join('\n');
}

describe('/relay command', () => {
  test('status reports disabled when relay.enabled is off, without asking the daemon', async () => {
    const { accessors, calls } = daemon({});
    const text = await run(['status'], { out: [], configOverrides: { 'relay.enabled': false }, externalServices: accessors });
    expect(text).toContain('Relay: disabled');
    expect(calls).toEqual([]);
  });

  test('status shows the state the daemon reports, in one request', async () => {
    const { accessors, calls } = daemon({ 'relay.reachability.get': { status: 'registered', configured: true } });
    const text = await run([], { out: [], externalServices: accessors });
    expect(text).toContain('Relay: registered');
    expect(text).toContain('abc123');
    expect(calls).toEqual(['relay.reachability.get']);
  });

  test('status says the daemon could not be asked, and why, instead of a relay state', async () => {
    const { accessors } = daemon({}, 'the daemon is disabled');
    const text = await run(['status'], { out: [], externalServices: accessors });
    expect(text).toContain('Relay: unavailable');
    expect(text).toContain('the daemon is disabled');
  });

  test('pair prints the encoded payload the daemon minted', async () => {
    const pairing = { protocol: 1, relayUrl: 'wss://relay.example.com', rid: 'abc123', daemonPublicKey: 'key' };
    const { accessors, calls } = daemon({ 'relay.pairing.mint': { pairing, status: 'registered' } });
    const text = await run(['pair'], { out: [], externalServices: accessors });
    expect(text).toContain('Relay pairing payload');
    expect(calls).toEqual(['relay.pairing.mint']);
  });

  test('pair names the daemon state when there is no registration to pair against', async () => {
    const { accessors } = daemon({ 'relay.pairing.mint': { pairing: null, status: 'connecting' } });
    const text = await run(['pair'], { out: [], externalServices: accessors });
    expect(text).toContain('no live relay registration yet (state: connecting)');
  });

  test('pair refuses when relay is disabled', async () => {
    const text = await run(['pair'], { out: [], configOverrides: { 'relay.enabled': false } });
    expect(text).toContain('Relay is disabled');
  });
});
