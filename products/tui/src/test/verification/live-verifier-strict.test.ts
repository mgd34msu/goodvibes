import { describe, expect, it } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildLiveVerificationReport } from '../../verification/live-verifier.ts';

const projectRoot = resolve(join(import.meta.dir, '..', '..', '..'));

describe('live verification strict mode', () => {
  it('does not pass when checks were skipped for lack of a daemon token', async () => {
    const root = mkdtempSync(join(tmpdir(), 'goodvibes-live-verifier-strict-'));
    try {
      const binaryPath = join(root, 'goodvibes-fake');
      writeFileSync(binaryPath, '#!/usr/bin/env bash\necho \'{"ok":true}\'\nexit 0\n', 'utf8');
      chmodSync(binaryPath, 0o755);
      const options = { homeDir: join(root, 'home'), binaryPath, projectRoot };
      const lenient = await buildLiveVerificationReport(options);
      const strict = await buildLiveVerificationReport({ ...options, strict: true });
      expect(strict.counts.skip).toBeGreaterThan(0);
      expect(strict.counts.fail).toBe(0);
      expect(strict.counts.warn).toBe(0);
      expect(lenient.ok).toBe(true);
      expect(strict.ok).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
