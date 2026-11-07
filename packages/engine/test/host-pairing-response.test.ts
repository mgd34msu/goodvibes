import { expect, test } from 'bun:test';
import { readHostPairingResponse } from '../terminal-shell/src/native/native-paired-principal.ts';

test('pairing response decodes UTF-8 across chunks and releases its stream reader', async () => {
  const bytes = new TextEncoder().encode('{"name":"Café"}');
  const accent = bytes.indexOf(0xc3);
  const response = new Response(new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(bytes.subarray(0, accent + 1));
    controller.enqueue(bytes.subarray(accent + 1));
    controller.close();
  } }));
  expect(await readHostPairingResponse(response)).toEqual({ name: 'Café' });
  expect(response.body!.locked).toBe(false);
});

test('oversized pairing response cancels upstream without accepting a truncated record', async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(new Uint8Array(16_385));
  }, cancel() { cancelled = true; } }));
  expect(await readHostPairingResponse(response)).toBeNull();
  expect(cancelled).toBe(true);
  expect(response.body!.locked).toBe(false);
});

test.each([new Uint8Array([0xff]), new TextEncoder().encode('{"partial":')])('invalid pairing bytes never yield credentials', async bytes => {
  const response = new Response(bytes);
  await expect(readHostPairingResponse(response)).rejects.toBeDefined();
  expect(response.body!.locked).toBe(false);
});
