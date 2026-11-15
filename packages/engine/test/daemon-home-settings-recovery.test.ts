/** An unreadable daemon-settings.json is set aside, not overwritten, and writers never share a temp file. */
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { readDaemonSetting, writeDaemonSetting, writeOperatorTokenFile } from '../platform/src/platform/workspace/daemon-home.js';

describe('daemon settings writes', () => {
  test('a corrupt settings file keeps its original bytes next to the fresh file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'daemon-home-corrupt-'));
    try {
      const original = '{"pairing": "abc", "torn":';
      writeFileSync(join(dir, 'daemon-settings.json'), original);
      writeDaemonSetting(dir, 'name', 'value');
      expect(readDaemonSetting(dir, 'name')).toBe('value');
      const aside = readdirSync(dir).filter((f) => f.startsWith('daemon-settings.json.corrupt-'));
      expect(aside).toHaveLength(1);
      expect(readFileSync(join(dir, aside[0]!), 'utf8')).toBe(original);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('repeated writes merge keys and leave no temp files behind', () => {
    const dir = mkdtempSync(join(tmpdir(), 'daemon-home-merge-'));
    try {
      writeDaemonSetting(dir, 'a', '1');
      writeDaemonSetting(dir, 'b', '2');
      writeOperatorTokenFile(dir, 'tokens');
      expect([readDaemonSetting(dir, 'a'), readDaemonSetting(dir, 'b')]).toEqual(['1', '2']);
      expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
