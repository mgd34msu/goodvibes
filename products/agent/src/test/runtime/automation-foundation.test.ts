import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigManager } from '../../config/index.ts';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../../config/surface.ts';
import { withRuntimeServices, type CliCommandRuntime } from '../../cli/management.ts';
import { parseGoodVibesCli } from '../../cli/parser.ts';
import { createRuntimeStore } from '../../runtime/store/index.ts';
import { type RuntimeEventBus, configureRuntimeEventBusDefaults } from '@/runtime/index.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

describe('automation/control-plane foundation', () => {
  let root = '';

  beforeEach(() => {
    root = makeProjectTempDir('gv-automation-foundation');
  });

  test('initial runtime store includes automation, routes, control-plane, and watcher domains', () => {
    const store = createRuntimeStore();
    const state = store.getState();

    expect(state.automation.jobs.size).toBe(0);
    expect(state.routes.bindings.size).toBe(0);
    expect(state.controlPlane.clients.size).toBe(0);
    expect(state.deliveries.deliveryAttempts.size).toBe(0);
    expect(state.watchers.watchers.size).toBe(0);
    expect(state.surfaces.surfaces.size).toBe(0);
    expect(state.routes.bindingIds).toEqual([]);
    expect(state.controlPlane.connectionState).toBe('disabled');
  });

  /**
   * integrations.routeBinding and runtime.eventBus.maxListeners, driven through the
   * real composition root (withRuntimeServices): the manager and the bus it builds
   * are the ones a command runs with, so dropping featureFlags from the
   * RouteBindingManager, or the bus-cap call before the first bus, fails here.
   */
  function commandRuntime(configure: (configManager: ConfigManager) => void): CliCommandRuntime {
    const workingDirectory = join(root, 'workspace');
    const homeDirectory = join(root, 'home');
    mkdirSync(workingDirectory, { recursive: true });
    mkdirSync(homeDirectory, { recursive: true });
    const configManager = new ConfigManager({ surfaceRoot: GOODVIBES_AGENT_SURFACE_ROOT, workingDir: workingDirectory, homeDir: homeDirectory });
    configure(configManager);
    return { cli: parseGoodVibesCli(['help']), configManager, workingDirectory, homeDirectory };
  }

  const telegramBinding = { kind: 'session', surfaceKind: 'telegram', surfaceId: 'surface:telegram', externalId: 'chat-1' } as const;

  test('integrations.routeBinding unset binds and resolves a route, the shipped default', async () => {
    await withRuntimeServices(commandRuntime(() => {}), async (services) => {
      expect(services.routeBindings.isRouteBindingEnabled()).toBe(true);
      const binding = await services.routeBindings.upsertBinding(telegramBinding);
      expect(services.routeBindings.resolve('telegram', 'chat-1')?.id).toBe(binding.id);
    }, { modelData: 'skip', homeSingleWriter: 'off' });
  }, 30000);

  test('integrations.routeBinding false refuses to bind and resolves nothing', async () => {
    await withRuntimeServices(commandRuntime((config) => config.set('integrations.routeBinding', false)), async (services) => {
      expect(services.routeBindings.isRouteBindingEnabled()).toBe(false);
      await expect(services.routeBindings.upsertBinding(telegramBinding)).rejects.toThrow('route binding is turned off');
      expect(services.routeBindings.resolve('telegram', 'chat-1')).toBeUndefined();
    }, { modelData: 'skip', homeSingleWriter: 'off' });
  }, 30000);

  describe('runtime.eventBus.maxListeners', () => {
    afterEach(() => {
      // Leave the process-wide default where the rest of the suite expects it.
      configureRuntimeEventBusDefaults({ maxListeners: 100 });
    });

    /**
     * The message of the cap error the bus raises once listeners pile up, or undefined if 300
     * more never trip it. The cap only throws in development, and the composed graph holds its
     * own listeners, so this fills the domain from wherever it stands and reads the cap off the error.
     */
    function capReportedBy(bus: RuntimeEventBus): string | undefined {
      const previous = process.env['NODE_ENV'];
      process.env['NODE_ENV'] = 'development';
      try {
        for (let i = 0; i < 300; i++) bus.onDomain('session', () => {});
        return undefined;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      } finally {
        if (previous === undefined) delete process.env['NODE_ENV'];
        else process.env['NODE_ENV'] = previous;
      }
    }

    test('a lower configured cap reaches the command bus', async () => {
      await withRuntimeServices(commandRuntime((config) => config.set('runtime.eventBus.maxListeners', 3)), (services) => {
        expect(capReportedBy(services.runtimeBus)).toContain('maxListeners=3 ');
      }, { modelData: 'skip', homeSingleWriter: 'off' });
    }, 30000);

    test('a higher configured cap reaches the command bus instead of the platform default of 100', async () => {
      await withRuntimeServices(commandRuntime((config) => config.set('runtime.eventBus.maxListeners', 150)), (services) => {
        expect(capReportedBy(services.runtimeBus)).toContain('maxListeners=150 ');
      }, { modelData: 'skip', homeSingleWriter: 'off' });
    }, 30000);
  });
});
