import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureBinary } from '../sdk/src/platform/intelligence/lsp/binary-downloader.js';
import { makeProjectTempDir } from './_helpers/project-temp.ts';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const assets: Record<string, string> = {
  'linux-x64': 'rust-analyzer-x86_64-unknown-linux-gnu.gz',
  'linux-arm64': 'rust-analyzer-aarch64-unknown-linux-gnu.gz',
  'darwin-x64': 'rust-analyzer-x86_64-apple-darwin.gz',
  'darwin-arm64': 'rust-analyzer-aarch64-apple-darwin.gz',
};
const assetName = assets[`${process.platform}-${process.arch}`];
const plain = Buffer.from('synthetic language server executable');
const compressed = Bun.gzipSync(plain);
const expected = createHash('sha256').update(compressed).digest('hex');

test.skipIf(!assetName).each(['missing', 'unavailable', 'malformed', 'ambiguous', 'other-file', 'mismatch', 'valid'] as const)(
  'automatic LSP install requires the exact publisher checksum: %s', async scenario => {
    const directory = makeProjectTempDir('lsp-download-pin');
    let payloadRequests = 0;
    globalThis.fetch = (async input => {
      const url = String(input);
      if (url.startsWith('https://api.github.com/')) return Response.json({ assets: [
        { name: assetName, browser_download_url: 'https://downloads.invalid/payload' },
        ...(scenario === 'missing' ? [] : [{ name: `${assetName}.sha256`, browser_download_url: 'https://downloads.invalid/checksum' }]),
      ] });
      if (url.endsWith('/checksum')) {
        if (scenario === 'unavailable') return new Response('', { status: 503 });
        const line = scenario === 'malformed' ? 'invalid-checksum'
          : scenario === 'ambiguous' ? `${expected}\n${expected}`
          : `${scenario === 'mismatch' ? '0'.repeat(64) : expected}  ${scenario === 'other-file' ? 'other-binary.gz' : assetName}`;
        return new Response(line);
      }
      if (url.endsWith('/payload')) { payloadRequests++; return new Response(compressed); }
      throw new Error('Unexpected test URL');
    }) as typeof fetch;
    const result = await ensureBinary(directory, 'rust-analyzer');
    if (scenario === 'valid') {
      expect(result).toBe(join(directory, 'rust-analyzer'));
      expect(readFileSync(result!)).toEqual(plain);
      expect(payloadRequests).toBe(1);
    } else {
      expect(result).toBeNull();
      expect(existsSync(join(directory, 'rust-analyzer'))).toBe(false);
      expect(existsSync(join(directory, 'rust-analyzer.tmp'))).toBe(false);
      expect(payloadRequests).toBe(scenario === 'mismatch' ? 1 : 0);
    }
  },
);
