import { expect, test } from 'bun:test';
import { createControlTool } from '@goodvibes-jev/engine/platform/platform/tools';
import type { CommandRegistry } from '../../input/command-registry.ts';
import { bindControlCommands, controlSurfacesFor } from '../../runtime/control-surfaces.ts';
import type { RuntimeServices } from '../../runtime/services.ts';

const registryHolding = (...names: string[]): CommandRegistry =>
  ({ get: (name: string) => (names.includes(name) ? {} : undefined) }) as unknown as CommandRegistry;

test('the control tool names only the commands this shell registered, once its registry is bound', async () => {
  const services = {} as RuntimeServices;
  const tool = createControlTool(controlSurfacesFor(services));
  expect(JSON.parse((await tool.execute({ mode: 'commands' })).output!).commands).toEqual([]);
  bindControlCommands(services, registryHolding('setup', 'login', 'not-a-control-command'));
  expect(JSON.parse((await tool.execute({ mode: 'commands' })).output!).commands).toEqual(['setup', 'login']);
});

test('the Agent shell has no panels to name', async () => {
  const tool = createControlTool(controlSurfacesFor({} as RuntimeServices));
  expect(JSON.parse((await tool.execute({ mode: 'panels' })).output!).panels).toEqual([]);
});
