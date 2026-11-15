import { expect, test } from 'bun:test';
import { createControlTool } from '@goodvibes-jev/engine/platform/platform/tools';
import type { CommandRegistry } from '../../input/command-registry.ts';
import { bindControlCommands, controlSurfacesFor } from '../../runtime/control-surfaces.ts';
import type { RuntimeServices } from '../../runtime/services.ts';

const registryHolding = (...commands: Array<{ name: string; description: string }>): CommandRegistry =>
  ({ getVisible: () => commands }) as unknown as CommandRegistry;

test('the control tool lists every visible command of the bound registry', async () => {
  const services = {} as RuntimeServices;
  const tool = createControlTool(controlSurfacesFor(services));
  expect(JSON.parse((await tool.execute({ mode: 'commands' })).output!).count).toBe(0);
  const visible = [{ name: 'setup', description: 'Set up' }, { name: 'schedule', description: 'Schedules' }];
  bindControlCommands(services, registryHolding(...visible));
  const listed = JSON.parse((await tool.execute({ mode: 'commands' })).output!);
  expect(listed.count).toBe(visible.length);
  expect(listed.commands).toEqual(visible);
});

test('the Agent shell says it has no panels', async () => {
  const tool = createControlTool(controlSurfacesFor({} as RuntimeServices));
  expect(JSON.parse((await tool.execute({ mode: 'panels' })).output!).available).toBe(false);
});
