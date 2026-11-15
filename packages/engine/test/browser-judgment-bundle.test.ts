import { describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { bundleBrowserEntrypoint } from './_helpers/browser-bundle.ts';
import { BROWSER_SPEECH_SEAM_BAND } from '@goodvibes-jev/engine/daemon-api/browser-judgment-contract';

describe('browser judgment public boundary', () => {
  test('publishes the shared speech band through the browser-safe contract subpath', () => {
    expect(BROWSER_SPEECH_SEAM_BAND.yes).toEqual({ actAt: 0.6, confirmAt: 0.55 });
    expect(Object.isFrozen(BROWSER_SPEECH_SEAM_BAND)).toBe(true);
  });

  test('bundles the public browser judgment contract without Node builtins', async () => {
    // Bun stubs a Node builtin to an empty object in a browser bundle, so a plain build cannot fail on one. Keeping builtins external leaves the specifier in the output.
    const output = await bundleBrowserEntrypoint(
      fileURLToPath(import.meta.resolve('@goodvibes-jev/engine/daemon-api/browser-judgment-contract')),
      { externals: ['node:*', 'fs', 'path', 'os', 'crypto', 'child_process', 'net', 'http', 'https', 'url', 'util', 'stream', 'buffer'] },
    );
    expect(output.length).toBeGreaterThan(0);
    expect(output.match(/(?:from|import|require)\s*\(?\s*["'](?:node:[^"']+|fs|path|os|crypto|child_process|net|http|https|url|util|stream|buffer)["']/g) ?? []).toEqual([]);
  });
});
