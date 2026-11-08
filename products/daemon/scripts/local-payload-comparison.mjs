import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';

const CHUNK_BYTES = 64 * 1024;
const sameFile = (left, right) => ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'mode'].every(key => left[key] === right[key]);

/** Compare actual local bytes against a separately retained baseline. This is
 * a mutation/relocation check, not verification of a downloaded release pin.
 * Fixed buffers avoid loading complete native runtimes into the Node heap. */
export async function assertLocalPayloadEqual(baselinePath, selectedPath, label) {
  let baseline, selected;
  try {
    baseline = await open(baselinePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    selected = await open(selectedPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const original = await baseline.stat({ bigint: true }), before = await selected.stat({ bigint: true });
    assert(original.isFile() && before.isFile(), `${label}: payload is not a regular file`);
    assert(original.size <= BigInt(Number.MAX_SAFE_INTEGER), `${label}: payload is too large`);
    assert.equal(before.size, original.size, `${label}: payload length changed`);
    assert(sameFile(original, await lstat(baselinePath, { bigint: true }))
      && sameFile(before, await lstat(selectedPath, { bigint: true })), `${label}: payload path changed`);
    const left = Buffer.allocUnsafe(CHUNK_BYTES), right = Buffer.allocUnsafe(CHUNK_BYTES);
    const size = Number(original.size);
    const fill = async (file, buffer, length, position) => {
      let read = 0;
      while (read < length) {
        const part = await file.read(buffer, read, length - read, position + read);
        if (part.bytesRead === 0) break;
        read += part.bytesRead;
      }
      return read;
    };
    for (let position = 0; position < size; position += CHUNK_BYTES) {
      const length = Math.min(CHUNK_BYTES, size - position);
      const [leftRead, rightRead] = await Promise.all([
        fill(baseline, left, length, position), fill(selected, right, length, position),
      ]);
      assert(leftRead === length && rightRead === length && left.subarray(0, length).equals(right.subarray(0, length)),
        `${label}: payload bytes changed`);
    }
    assert(sameFile(original, await baseline.stat({ bigint: true })) && sameFile(before, await selected.stat({ bigint: true }))
      && sameFile(original, await lstat(baselinePath, { bigint: true })) && sameFile(before, await lstat(selectedPath, { bigint: true })),
    `${label}: payload changed during comparison`);
    return size;
  } finally {
    await Promise.all([baseline?.close(), selected?.close()]);
  }
}
