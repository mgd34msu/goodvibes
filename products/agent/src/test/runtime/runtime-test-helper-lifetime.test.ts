import { expect, spyOn, test } from 'bun:test';
import { drainTestRuntimeServices, getTestRuntimeServices, resetTestRuntimeServices } from '../helpers/runtime-services.ts';

test('reset retires the actual owned graph before a fresh helper graph is reused', async () => {
  const first = await getTestRuntimeServices();
  const close = spyOn(first, 'close');
  const fleet = spyOn(first.processRegistry, 'dispose');
  try {
    resetTestRuntimeServices();
    expect(close).toHaveBeenCalledTimes(1);
    await drainTestRuntimeServices();
    expect(fleet).toHaveBeenCalledTimes(1);
    const next = await getTestRuntimeServices();
    expect(next).not.toBe(first);
    expect(next.workingDirectory).not.toBe(first.workingDirectory);
    await drainTestRuntimeServices();
    expect(close).toHaveBeenCalledTimes(1);
  } finally { fleet.mockRestore(); close.mockRestore(); }
});

test('the helper reports a real close failure after draining and permits a separate fresh owner', async () => {
  const services = await getTestRuntimeServices(), nativeClose = services.close.bind(services);
  const failure = new Error('Synthetic owned close failure after actual drain');
  const close = spyOn(services, 'close').mockImplementation(async () => { await nativeClose(); throw failure; });
  try {
    resetTestRuntimeServices();
    await expect(drainTestRuntimeServices()).rejects.toMatchObject({ errors: [failure] });
    expect(close).toHaveBeenCalledTimes(1);
  } finally { close.mockRestore(); await nativeClose(); }
  const next = await getTestRuntimeServices();
  expect(next).not.toBe(services);
  await drainTestRuntimeServices();
});

test('the live fleet remains readable after the actual first credential key is created', async () => {
  const services = await getTestRuntimeServices();
  await services.secretsManager.set('GV_AGENT_FIXTURE_LIFETIME', 'synthetic-owned-value');
  expect(() => services.processRegistry.query()).not.toThrow();
  await services.secretsManager.delete('GV_AGENT_FIXTURE_LIFETIME');
});
