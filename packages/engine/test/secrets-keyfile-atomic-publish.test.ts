import { describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { loadOrCreateKeyfile } from '../platform/src/platform/config/secrets-keyfile.js';
import { makeProjectTempDir } from './_helpers/project-temp.ts';

describe('the encryption keyfile', () => {
  test('is published by linking a complete temp file into place, never created empty and filled', () => {
    const root = makeProjectTempDir('keyfile-atomic');
    const keyfilePath = join(root, '.goodvibes', 'secrets.key');
    const original = fs.linkSync;
    const seen: { from: string; to: string; keyfileExisted: boolean; tempContent: string }[] = [];
    const spy = spyOn(fs, 'linkSync').mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
      seen.push({
        from: String(from),
        to: String(to),
        keyfileExisted: fs.existsSync(keyfilePath),
        tempContent: fs.readFileSync(from, 'utf8'),
      });
      return original(from, to);
    }) as typeof fs.linkSync);
    try {
      const key = loadOrCreateKeyfile(keyfilePath);
      expect(seen).toHaveLength(1);
      const [link] = seen;
      expect(link!.to).toBe(keyfilePath);
      expect(link!.from).not.toBe(keyfilePath);
      expect(link!.keyfileExisted).toBe(false);
      expect(link!.tempContent.trim()).toBe(key.toString('hex'));
    } finally {
      spy.mockRestore();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
