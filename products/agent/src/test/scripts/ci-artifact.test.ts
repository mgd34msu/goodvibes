import { expect, spyOn, test } from 'bun:test';
import * as crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordAgentCiArtifact, retainVerifiedAgentCiArtifact, verifyAgentCiArtifact } from '../../../scripts/ci-artifact.ts';
import { nativeReaderCapabilities } from '@goodvibes-jev/engine/platform/platform/runtime/self-update';

const revision = 'a'.repeat(40);
const metadata = { sourceTree: 'b'.repeat(40), headCommit: revision };
test('the archive round trip preserves binary, library, provenance and executable mode', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-ci-artifact-'));
  const source = join(dir, 'source');
  const restored = join(dir, 'restored');
  try {
    mkdirSync(join(source, 'dist/lib/sqlite-vec-linux-x64'), { recursive: true });
    mkdirSync(restored);
    writeFileSync(join(source, 'package.json'), JSON.stringify({ name: '@goodvibes-jev/agent', version: '3.1.2' }));
    writeFileSync(join(restored, 'package.json'), JSON.stringify({ name: '@goodvibes-jev/agent', version: '3.1.2' }));
    writeFileSync(join(source, 'dist/goodvibes-agent-linux-x64'), `#!/bin/sh\n[ "$1" = check-install-reader ] && [ "$2" = --describe ] || exit 2\nprintf '%s\\n' '${JSON.stringify(nativeReaderCapabilities('3.1.2'))}'\n`, { mode: 0o755 });
    writeFileSync(join(source, 'dist/goodvibes-agent-linux-x64.bun'), 'synthetic ordinary runtime', { mode: 0o755 });
    writeFileSync(join(source, 'dist/goodvibes-agent-linux-x64.bun.LICENSE.md'), 'synthetic runtime notices');
    writeFileSync(join(source, 'dist/goodvibes-agent-linux-x64.bun.json'), 'synthetic runtime provenance');
    writeFileSync(join(source, 'dist/lib/sqlite-vec-linux-x64/vec0.so'), 'synthetic native addon');
    recordAgentCiArtifact(source, revision, metadata);
    const archive = join(dir, 'artifact.tgz');
    expect(spawnSync('tar', ['-czf', archive, '-C', source, 'dist']).status).toBe(0);
    expect(spawnSync('tar', ['-xzf', archive, '-C', restored]).status).toBe(0);
    const hash = spyOn(crypto, 'createHash');
    try {
      const verified = retainVerifiedAgentCiArtifact(restored, revision, metadata);
      expect(hash).toHaveBeenCalledTimes(5);
      verified.retained.assertCurrent(); verified.retained.assertCurrent();
      const binary = verified.retained.files[0]!;
      const original = binary.bytes; binary.bytes.fill(0);
      expect(binary.bytes).toEqual(original);
      expect(hash).toHaveBeenCalledTimes(5);
      expect(Object.hasOwn(verified.retained.files.at(-1)!, 'sha256')).toBe(false);
      expect(() => verifyAgentCiArtifact(restored, revision, metadata)).not.toThrow();
      expect(hash).toHaveBeenCalledTimes(10); // independent cold consumer
    } finally { hash.mockRestore(); }
    expect(() => verifyAgentCiArtifact(restored, 'b'.repeat(40), metadata)).toThrow(/manifest/);
    chmodSync(join(restored, 'dist/goodvibes-agent-linux-x64'), 0o644);
    expect(() => verifyAgentCiArtifact(restored, revision, metadata)).toThrow(/executable/);
    chmodSync(join(restored, 'dist/goodvibes-agent-linux-x64'), 0o755);
    chmodSync(join(restored, 'dist/goodvibes-agent-linux-x64.bun'), 0o644);
    expect(() => verifyAgentCiArtifact(restored, revision, metadata)).toThrow(/executable/);
    chmodSync(join(restored, 'dist/goodvibes-agent-linux-x64.bun'), 0o755);
    writeFileSync(join(restored, 'dist/goodvibes-agent-linux-x64.bun.LICENSE.md'), 'changed notice');
    expect(() => verifyAgentCiArtifact(restored, revision, metadata)).toThrow(/manifest/);
    writeFileSync(join(restored, 'dist/lib/sqlite-vec-linux-x64/vec0.so'), 'changed addon');
    expect(() => verifyAgentCiArtifact(restored, revision, metadata)).toThrow(/manifest/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
