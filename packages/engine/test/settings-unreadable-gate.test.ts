// Proves: A stored gate value that cannot be read is dropped and the weaker shipped default takes effect after a restart.
// Red when: Settings ingestion sets aside an unreadable safety-gate value and carries on with its default instead of holding the gate at its strictest value.
/**
 * The owner stored `permissions.tools.exec: "deny"`; a typo makes it "dney".
 * Reading the file back at the next start must not quietly put the shipped
 * default (prompt) in its place: the file still loads, the gate is held at its
 * strictest value (deny) and the held key is reported. A value outside the gate
 * list that cannot be read is set aside instead: that key reads as its default,
 * the rest of the file keeps its stored values, and the set-aside key is
 * reported. The real ConfigManager on a temp home.
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager } from '../platform/src/platform/config/manager.ts';
import { DEFAULT_CONFIG } from '../platform/src/platform/config/schema.ts';
import { readMerchantPolicy } from '../platform/src/platform/payments/payments-config.ts';
import { classifyMerchant, windowForPurchase } from '../platform/src/platform/payments/merchant-recourse.ts';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/** A manager opened over a settings file holding `stored`, or the refusal it was opened with. */
function open(stored: Record<string, unknown>): ConfigManager | Error {
  const dir = mkdtempSync(join(tmpdir(), 'gv-unreadable-gate-'));
  dirs.push(dir);
  const configDir = join(dir, 'config');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, 'settings.json'), JSON.stringify(stored));
  try {
    return new ConfigManager({ configDir });
  } catch (error) {
    return error as Error;
  }
}

test('an unreadable gate value holds the gate at its strictest value; an unreadable value outside the gate list is set aside', () => {
  const gate = open({ permissions: { tools: { exec: 'dney' } }, hostedSessions: { maxSessions: 7 } });
  const other = open({ display: { theme: 5 }, hostedSessions: { maxSessions: 7 } });
  if (gate instanceof Error) throw gate;
  if (other instanceof Error) throw other;
  expect({
    exec: gate.get('permissions.tools.exec'),
    gateKept: gate.get('hostedSessions.maxSessions'),
    held: gate.getIngestionQuarantine().map((notice) => [notice.key, notice.action]),
    theme: other.get('display.theme') === DEFAULT_CONFIG.display.theme,
    kept: other.get('hostedSessions.maxSessions'),
    setAside: other.getIngestionQuarantine().map((notice) => notice.key),
  }).toEqual({
    exec: 'deny',
    gateKept: 7,
    held: [['permissions.tools.exec', 'held']],
    theme: true,
    kept: 7,
    setAside: ['display.theme'],
  });
});

test('a stored shop exclusion list that names no shop makes a purchase at an established shop ask', async () => {
  // The decision model's reading: target.com is an established shop with recourse.
  const judge = { judge: async () => ({ qualifies: true, confident: true, recourse: 'an established retailer with a returns process' }) };
  const windowAt = async (stored: unknown): Promise<string> => {
    const config = open({ payments: { majorRetailersExcluded: stored } });
    if (config instanceof Error) throw config;
    const verdict = await classifyMerchant({ checkoutHost: 'www.target.com' }, judge, readMerchantPolicy(config));
    return windowForPurchase({ aboveBudget: false, merchantIsMajor: verdict.isMajor });
  };
  expect({
    text: await windowAt('bestbuy.com, amazon'),
    list: await windowAt(['bestbuy.com', 'amazon']),
    // Control: a list that reads lets the same purchase go on the silent window.
    readable: await windowAt('bestbuy.com'),
  }).toEqual({ text: 'approval', list: 'approval', readable: 'veto' });
});
