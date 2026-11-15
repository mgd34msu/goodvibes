import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager, type WriteOrigin } from '../platform/src/platform/config/manager.ts';
import type { ConfigKey } from '../platform/src/platform/config/schema.ts';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'config-set-many-'));
  const configDir = join(root, 'surface');
  const daemonTierPath = join(root, 'daemon', 'settings.json');
  const manager = new ConfigManager({ configDir, daemonTierPath });
  return { manager, configDir, daemonTierPath, close: () => rmSync(root, { recursive: true, force: true }) };
}

const owner: WriteOrigin = { kind: 'owner', surface: 'fixture' };
const agent = (decision?: Extract<WriteOrigin, { kind: 'agent' }>['decision']): WriteOrigin => ({ kind: 'agent', surface: 'fixture', decision });

describe('one settings update', () => {
  test('settings that are valid together are admitted together, saved once and move the revision once', () => {
    const f = fixture();
    try {
      const before = f.manager.revisionSource.revision();
      // Either change alone would leave the tiers out of order; together they are ordered.
      const result = f.manager.setMany([
        { key: 'memory.tier.elevatedPct' as ConfigKey, value: 85 },
        { key: 'memory.tier.highPct' as ConfigKey, value: 90 },
      ], owner);
      expect(result).toMatchObject({ ok: true, saved: ['memory.tier.elevatedPct', 'memory.tier.highPct'] });
      expect(f.manager.revisionSource.revision()).toBe(before + 1);
      const reopened = new ConfigManager({ configDir: f.configDir, daemonTierPath: f.daemonTierPath });
      expect(reopened.get('memory.tier.elevatedPct' as ConfigKey)).toBe(85);
      expect(reopened.get('memory.tier.highPct' as ConfigKey)).toBe(90);
    } finally { f.close(); }
  });

  test('an agent cannot loosen security unless the owner, the owner\'s rule or the mode settled the call', () => {
    const f = fixture();
    try {
      const before = f.manager.revisionSource.revision();
      const change = [{ key: 'permissions.mode' as ConfigKey, value: 'yolo' }];
      for (const refused of [agent(), agent({ state: 'allowed-by-jev', decidedBy: 'jev', reason: 'fixture' })]) {
        const result = f.manager.setMany(change, refused);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.refusal.code).toBe('OWNER_ONLY');
          expect(result.refusal.next.length).toBeGreaterThan(0);
          expect(result.saved).toEqual([]);
        }
      }
      expect(f.manager.revisionSource.revision()).toBe(before);
      expect(f.manager.get('permissions.mode')).not.toBe('yolo');
      // Tightening needs no one's say.
      expect(f.manager.setMany([{ key: 'permissions.mode' as ConfigKey, value: 'plan' }], agent()).ok).toBe(true);
      expect(f.manager.setMany(change, agent({ state: 'allowed', decidedBy: 'owner', reason: 'fixture' })).ok).toBe(true);
      expect(f.manager.get('permissions.mode')).toBe('yolo');
    } finally { f.close(); }
  });

  test('a credential is kept only as a reference, card material never reaches a settings file, and no value is echoed', () => {
    const f = fixture();
    try {
      const literal = f.manager.setMany([{ key: 'surfaces.slack.botToken' as ConfigKey, value: 'fixture-private-token' }], owner);
      const card = f.manager.setMany([{ key: 'payments.cardNumber' as ConfigKey, value: 'fixture-private-card' }], owner);
      for (const [result, code] of [[literal, 'CONFIG_SECRET_LITERAL'], [card, 'CONFIG_CARD_MATERIAL']] as const) {
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.refusal.code).toBe(code);
          expect(JSON.stringify(result.refusal)).not.toContain('fixture-private');
        }
      }
      expect(existsSync(f.daemonTierPath)).toBe(false);
      const reference = 'goodvibes://secrets/goodvibes/SLACK_BOT_TOKEN';
      expect(f.manager.setMany([{ key: 'surfaces.slack.botToken' as ConfigKey, value: reference }], owner).ok).toBe(true);
      expect(readFileSync(f.daemonTierPath, 'utf8')).toContain(reference);
    } finally { f.close(); }
  });
});
