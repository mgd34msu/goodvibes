import { describe, expect, spyOn, test } from 'bun:test';

import { join } from 'node:path';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as crypto from 'node:crypto';
import {
  CHECKSUM_MANIFEST_NAME,
  parseChecksumFile,
  requireChecksum,
  resolveArtifactNames,
  sha256,
  verifyChecksum,
} from '../../runtime/release-artifacts.ts';
// postinstall.js re-exports these same bindings (its download-verify loop
// calls them directly), importing it here proves that wiring holds, and
// is safe: import.meta.main is only true when the file is the process
// entry point, so this import does not trigger its network install.
import * as postinstall from '../../../scripts/postinstall.js';

describe('verifyChecksum', () => {
  test('passes silently when the checksum matches', () => {
    expect(() => verifyChecksum('goodvibes-linux-x64', 'abc123', 'abc123')).not.toThrow();
  });

  test('throws on a mismatching checksum', () => {
    expect(() => verifyChecksum('goodvibes-linux-x64', 'abc123', 'def456')).toThrow(
      /checksum mismatch for goodvibes-linux-x64: expected def456, got abc123/,
    );
  });

  test('throws when the manifest has NO entry for the artifact; a missing entry is a hard failure, not a skip', () => {
    expect(() => verifyChecksum('goodvibes-linux-x64', 'abc123', undefined)).toThrow(
      /no checksum entry for goodvibes-linux-x64/,
    );
  });

  test('missing-entry error names both the artifact and the manifest', () => {
    let thrown: unknown;
    try {
      verifyChecksum('goodvibes-daemon-linux-arm64', 'deadbeef', undefined);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain('goodvibes-daemon-linux-arm64');
    expect(message).toContain(CHECKSUM_MANIFEST_NAME);
  });

  test('missing-entry error names a caller-supplied manifest name', () => {
    expect(() => verifyChecksum('goodvibes-macos-x64', 'abc123', undefined, 'custom-manifest.txt')).toThrow(
      /custom-manifest\.txt/,
    );
  });

  test('an empty-string expected checksum is still a real (mismatching) entry, not a missing one', () => {
    // Guards against a `if (expected)` style falsy check silently treating
    // an entry with an empty checksum the same as no entry at all.
    expect(() => verifyChecksum('goodvibes-linux-x64', 'abc123', '')).toThrow(/checksum mismatch/);
  });
});

describe('parseChecksumFile', () => {
  test('parses standard sha256sum output lines', () => {
    const contents = [
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  goodvibes-linux-x64',
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb  goodvibes-daemon-linux-x64',
    ].join('\n');
    const checksums = parseChecksumFile(contents);
    expect(checksums.get('goodvibes-linux-x64')).toBe('a'.repeat(64));
    expect(checksums.get('goodvibes-daemon-linux-x64')).toBe('b'.repeat(64));
  });

  test('an artifact absent from the file has no map entry at all', () => {
    const contents = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  goodvibes-linux-x64';
    const checksums = parseChecksumFile(contents);
    expect(checksums.has('goodvibes-daemon-linux-x64')).toBe(false);
    expect(checksums.get('goodvibes-daemon-linux-x64')).toBeUndefined();
  });

  test('ignores blank lines and tolerates a leading "*" binary-mode marker', () => {
    const contents = [
      '',
      `${'c'.repeat(64)} *goodvibes-macos-arm64`,
      '',
    ].join('\n');
    const checksums = parseChecksumFile(contents);
    expect(checksums.get('goodvibes-macos-arm64')).toBe('c'.repeat(64));
  });
});

describe('resolveArtifactNames', () => {
  test('resolves known platform/arch pairs', () => {
    expect(resolveArtifactNames('linux', 'x64')).toEqual({
      app: 'goodvibes-linux-x64',
      daemon: 'goodvibes-daemon-linux-x64',
    });
    expect(resolveArtifactNames('darwin', 'arm64')).toEqual({
      app: 'goodvibes-macos-arm64',
      daemon: 'goodvibes-daemon-macos-arm64',
    });
  });

  test('returns null for unsupported platform/arch pairs', () => {
    expect(resolveArtifactNames('win32', 'x64')).toBeNull();
  });
});

describe('postinstall.js wiring', () => {
  test('re-exports the same verification functions it uses internally', () => {
    // Guards against postinstall.js drifting back to its own copy of this
    // logic instead of the shared src/runtime/release-artifacts.ts module.
    expect(postinstall.verifyChecksum).toBe(verifyChecksum);
    expect(postinstall.requireChecksum).toBe(requireChecksum);
    expect(postinstall.parseChecksumFile).toBe(parseChecksumFile);
    expect(postinstall.sha256).toBe(sha256);
    expect(postinstall.resolveArtifactNames).toBe(resolveArtifactNames);
    expect(postinstall.CHECKSUM_MANIFEST_NAME).toBe(CHECKSUM_MANIFEST_NAME);
  });
});

describe('the actual postinstall download-verify operation', () => {
  test('a missing manifest entry refuses before download, hashing or destination changes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tui-postinstall-pin-'));
    const destination = join(root, 'goodvibes-linux-x64');
    const fetch = spyOn(globalThis, 'fetch');
    const hash = spyOn(crypto, 'createHash');
    try {
      await expect(postinstall.installVerifiedReleaseBinary('goodvibes-linux-x64', new Map(), 'https://unused.test', destination))
        .rejects.toThrow(/no checksum entry for goodvibes-linux-x64/);
      expect(fetch).not.toHaveBeenCalled(); expect(hash).not.toHaveBeenCalled();
      expect(existsSync(destination)).toBe(false); expect(existsSync(destination + '.download')).toBe(false);
    } finally { fetch.mockRestore(); hash.mockRestore(); rmSync(root, { recursive: true, force: true }); }
  });

  test('a real downloaded payload is hashed and installed only for its matching manifest pin', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tui-postinstall-bytes-'));
    const destination = join(root, 'goodvibes-linux-x64');
    const bytes = Buffer.from('actual owned synthetic binary bytes');
    const pin = sha256(bytes);
    const fetch = spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(Uint8Array.from(bytes)));
    const hash = spyOn(crypto, 'createHash');
    try {
      await postinstall.installVerifiedReleaseBinary('goodvibes-linux-x64', new Map([['goodvibes-linux-x64', pin]]), 'https://owned.test', destination);
      expect(fetch).toHaveBeenCalledTimes(1); expect(hash).toHaveBeenCalledTimes(1);
      expect(readFileSync(destination)).toEqual(bytes);
      await expect(postinstall.installVerifiedReleaseBinary('goodvibes-linux-x64', new Map([['goodvibes-linux-x64', 'f'.repeat(64)]]), 'https://owned.test', destination))
        .rejects.toThrow(/checksum mismatch/);
      expect(hash).toHaveBeenCalledTimes(2); expect(readFileSync(destination)).toEqual(bytes);
      expect(existsSync(destination + '.download')).toBe(false);
    } finally { fetch.mockRestore(); hash.mockRestore(); rmSync(root, { recursive: true, force: true }); }
  });
});

/**
 * The wake-word model is installed as part of installing, and the rule that
 * makes that acceptable is that it can never fail the install. These cover the
 * TUI's own seam; the policy's never-throw contract (offline, DNS, HTTP error,
 * unwritable tree, a provisioner that itself threw) is exercised in the engine.
 */
describe('the wake-word model install step in postinstall', () => {
  test('postinstall exposes the step, and running it in a source checkout is a stated skip', async () => {
    expect(typeof postinstall.installWakeWordModel).toBe('function');
    // This repository IS a source checkout, so the step must decline rather than
    // pull 6 MB into the developer's home on every `bun install`, the same rule
    // the release-binary install already follows.
    const messages: string[] = [];
    const originalLog = console.log;
    try {
      console.log = (value?: unknown) => { messages.push(String(value)); };
      await expect(postinstall.installWakeWordModel()).resolves.toBeUndefined();
    } finally { console.log = originalLog; }
    expect(messages).toContain('postinstall: source checkout detected; skipping the wake-word model install');
    // The shared network guard remains active; an attempted provision is a failure.

  });
});
