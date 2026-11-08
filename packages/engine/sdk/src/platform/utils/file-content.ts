/** File comparisons use fixed memory, including for archives and generated assets. */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

const CHUNK_BYTES = 64 * 1024;
export async function fileContentDigest(path: string, signal?: AbortSignal): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) throw new Error('Expected a regular file');
    const hash = createHash('sha256');
    const chunk = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, Number(before.size)));
    let count = 0;
    while (count < Number(before.size)) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, Number(before.size) - count), count);
      if (!bytesRead) break;
      hash.update(chunk.subarray(0, bytesRead)); count += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (BigInt(count) !== before.size || after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) throw new Error('File changed while comparing content');
    return hash.digest('hex');
  } finally { await handle.close(); }
}
