// Proves: A stored gate value that cannot be read is dropped and the weaker shipped default takes effect after a restart.
// Red when: Settings ingestion sets aside an unreadable safety-gate value and carries on with its default instead of refusing the file.
/**
 * The owner stored `permissions.tools.exec: "deny"`; a typo makes it "dney".
 * Reading the file back at the next start must not quietly put the shipped
 * default (prompt) in its place: the settings file is refused, naming the key.
 * A value outside the gate list that cannot be read is set aside instead: that
 * key reads as its default, the rest of the file keeps its stored values, and
 * the set-aside key is reported. The real ConfigManager on a temp home.
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager } from '../platform/src/platform/config/manager.ts';
import { DEFAULT_CONFIG } from '../platform/src/platform/config/schema.ts';

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

test('an unreadable gate value refuses the file; an unreadable value outside the gate list is set aside', () => {
  const gate = open({ permissions: { tools: { exec: 'dney' } }, hostedSessions: { maxSessions: 7 } });
  const other = open({ display: { theme: 5 }, hostedSessions: { maxSessions: 7 } });
  if (other instanceof Error) throw other;
  expect({
    gate: gate instanceof Error ? gate.message.includes('permissions.tools.exec') : `opened with exec ${String(gate.get('permissions.tools.exec'))}`,
    theme: other.get('display.theme') === DEFAULT_CONFIG.display.theme,
    kept: other.get('hostedSessions.maxSessions'),
    setAside: other.getIngestionQuarantine().map((notice) => notice.key),
  }).toEqual({ gate: true, theme: true, kept: 7, setAside: ['display.theme'] });
});
