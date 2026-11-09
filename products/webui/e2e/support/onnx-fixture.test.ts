/** Fixture cost/transfer contracts, not model quality or real device proof. */
import { expect, spyOn, test } from 'bun:test';
import * as crypto from 'node:crypto';
import { wakeModelChunkResponse, wakeProvisionResponse, wakeStatusResponse } from './mock-daemon';
import { wakeClassifierBytes, wakeClassifierFixture, wakeEmbeddingBytes, wakeNoticeBytes } from './onnx-fixture';

test('status and provision sizes never calculate discarded model integrity pins', () => {
  const classifier = wakeClassifierBytes().length, embedding = wakeEmbeddingBytes().length, notice = wakeNoticeBytes().length;
  const hash = spyOn(crypto, 'createHash');
  try {
    expect(wakeStatusResponse().classifier.bytes).toBe(0);
    const status = wakeStatusResponse(true, true);
    expect(status.classifier.bytes).toBe(classifier); expect(status.embedding.bytes).toBe(embedding);
    expect(status.notice.bytes).toBe(notice); expect(status.vad.bytes).toBe(embedding);
    const provision = wakeProvisionResponse();
    expect(provision.outcomes.map(row => row.bytes)).toEqual([embedding, notice, classifier, notice, embedding, notice, classifier]);
    expect(hash).not.toHaveBeenCalled();
  } finally { hash.mockRestore(); }
});

test('actual model transfer publishes its required original pin while corrupt-wire control needs none', () => {
  const original = wakeClassifierFixture(), hash = spyOn(crypto, 'createHash');
  try {
    const response = wakeModelChunkResponse('classifier', 0, { chunkBytes: original.bytes.length, corruptSha: false });
    expect(response.sha256).toBe(original.sha256); expect(response.complete).toBe(true);
    expect(Buffer.from(response.dataBase64, 'base64')).toEqual(Buffer.from(original.bytes));
    expect(hash).toHaveBeenCalledTimes(1); hash.mockClear();
    expect(wakeModelChunkResponse('classifier', 0, { chunkBytes: 10, corruptSha: true }).sha256).toBe('f'.repeat(64));
    expect(hash).not.toHaveBeenCalled();
  } finally { hash.mockRestore(); }
  const first = wakeClassifierBytes(); first.fill(0);
  expect(wakeClassifierBytes()).not.toEqual(first);
});
