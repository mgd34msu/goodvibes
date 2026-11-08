import { expect, test } from 'bun:test';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { readCatastrophic, readToolCall } from '../sdk/src/platform/gate/reading.js';
import { captureExternalRequestEvidence } from '../sdk/src/platform/permissions/external-request-evidence.js';
import { runSafetyChecks } from '../sdk/src/platform/runtime/permissions/safety-checks.js';
import { gateReadingsPort } from './_helpers/gate-readings.js';

const command = 'rm -rf ./*';
const sandbox = '/tmp/isolated-fixture';
const ownerDirectory = '/home/owner-fixture';
const externalMarker = 'EXTERNAL_CATASTROPHE_CONTEXT';
const readings = () => gateReadingsPort([
  [externalMarker, { catastrophic: true }],
  [ownerDirectory, { catastrophic: true }],
  [sandbox, { catastrophic: false }],
]);

test('identical command text cannot inherit a verdict from another working directory or external request', async () => {
  const fake = readings();
  expect((await readToolCall({ toolName: 'exec', args: { command }, workingDirectory: sandbox, askObfuscated: true, port: fake.port })).boundary.catastrophic).toBe('no');
  expect(await readCatastrophic(command, 'context-home', undefined, { workingDirectory: ownerDirectory, port: fake.port }))
    .toEqual({ verdict: 'yes', readByGate: false });
  const evidence = captureExternalRequestEvidence({ instructionSource: externalMarker });
  expect(await readCatastrophic(command, 'context-external', undefined, { workingDirectory: sandbox, externalRequestEvidence: evidence, port: fake.port }))
    .toEqual({ verdict: 'yes', readByGate: false });
  expect(await readCatastrophic(command, 'context-sandbox', undefined, { workingDirectory: sandbox, port: fake.port }))
    .toEqual({ verdict: 'no', readByGate: false });
  expect(fake.requests).toHaveLength(4);
  expect(fake.requests[1]?.state).toMatchObject({ workingDirectory: ownerDirectory, arguments: { command } });
  expect(fake.requests[2]?.state).toMatchObject({ externalRequest: { instructionSource: externalMarker } });
});

test('standalone readings snapshot borrowed context before asynchronous provider work', async () => {
  const fake = readings();
  const original = captureExternalRequestEvidence({ instructionSource: 'ORIGINAL_CONTEXT' });
  const changed = captureExternalRequestEvidence({ instructionSource: externalMarker });
  const options = { workingDirectory: sandbox, externalRequestEvidence: original, port: fake.port };
  const pending = readCatastrophic(command, 'context-snapshot', undefined, options);
  options.workingDirectory = ownerDirectory; options.externalRequestEvidence = changed;
  expect(await pending).toEqual({ verdict: 'no', readByGate: false });
  expect(fake.requests[0]?.state).toMatchObject({ workingDirectory: sandbox, externalRequest: { instructionSource: 'ORIGINAL_CONTEXT' } });
});

test('the public safety API forwards the actual supplied context and scoped port', async () => {
  const fake = readings();
  expect((await runSafetyChecks({ command }, { workingDirectory: sandbox, port: fake.port })).blocked).toBe(false);
  expect((await runSafetyChecks({ command }, { workingDirectory: ownerDirectory, port: fake.port })).blocked).toBe(true);
  expect(fake.requests).toHaveLength(2);
  const controller = new AbortController(); controller.abort(new Error('cancelled fixture'));
  await expect(runSafetyChecks({ command }, { signal: controller.signal, port: fake.port })).rejects.toBeDefined();
  expect(fake.requests).toHaveLength(2);
});

test('replacing borrowed options cannot detach the original cancellation owner', async () => {
  const fake = readings();
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const port: JudgmentPort = { ...fake.port, async ask(request) { entered.resolve(); await release.promise; return fake.port.ask(request); } };
  const controller = new AbortController();
  const options = { signal: controller.signal, workingDirectory: sandbox, port };
  const work = runSafetyChecks({ command }, options).catch((error: unknown) => error);
  try {
    await entered.promise;
    controller.abort(new Error('original owner cancelled')); options.signal = new AbortController().signal;
    const early = await Promise.race([work, new Promise<null>(resolve => setTimeout(() => resolve(null), 100))]);
    expect(early).not.toBeNull(); expect(early).toBe(controller.signal.reason);
  } finally { release.resolve(); await work; }
});
