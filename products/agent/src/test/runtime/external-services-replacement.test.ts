/**
 * The adopted connected-host handle is replaced by boot discovery, the boot-time
 * autostart and the restart route. Whatever replaces it must stop the handle it
 * displaces, and an earlier start finishing late must not overwrite the status
 * a later start already published.
 */
import { describe, expect, test } from 'bun:test';
import type { HookDispatcher } from '@goodvibes-jev/engine/platform/platform/hooks';
import type { DaemonServiceControl } from '@goodvibes-jev/engine/platform/platform/runtime/client';
import type { RuntimeEventBus, DeferredStartupCoordinator, ExternalServicesHandle, HostServiceStatus } from '@/runtime/index.ts';
import { wireAgentExternalServices } from '../../runtime/bootstrap-external-services.ts';
import { AgentDaemonReceiptFeed } from '../../runtime/daemon-receipts.ts';
import type { SystemMessageRouter } from '../../core/system-message-router.ts';
import type { RuntimeServices } from '../../runtime/services.ts';
import type { UiRuntimeServices } from '../../runtime/ui-services.ts';

function statusOf(mode: HostServiceStatus['mode']): HostServiceStatus {
  return { mode, host: '127.0.0.1', port: 3421, baseUrl: 'http://127.0.0.1:3421' };
}

function handleOf(mode: HostServiceStatus['mode'], stops: string[], label: string): ExternalServicesHandle {
  return {
    daemonServer: null,
    httpListener: null,
    daemonStatus: statusOf(mode),
    httpListenerStatus: statusOf('disabled'),
    listRecentControlPlaneEvents: () => [],
    stop: async () => { stops.push(label); },
  };
}

function immediateCoordinator(): DeferredStartupCoordinator {
  return {
    schedule: (task) => Promise.resolve().then(() => task.run()).catch((error) => { task.onError?.(error); }),
    drain: async () => {},
  };
}

function wire(startServices: unknown, control?: DaemonServiceControl) {
  const router = { high: () => {}, low: () => {} } as unknown as SystemMessageRouter;
  const uiServices = { platform: {} } as unknown as UiRuntimeServices;
  const controller = wireAgentExternalServices({
    configManager: { get: () => undefined },
    runtimeBus: {} as RuntimeEventBus,
    hookDispatcher: {} as HookDispatcher,
    services: {
      daemonReceiptFeed: new AgentDaemonReceiptFeed(),
      memoryConsolidationReceiptFeed: new AgentDaemonReceiptFeed(),
      asDaemonGradeView: () => ({}) as never,
    } as unknown as RuntimeServices,
    uiServices,
    deferredStartup: immediateCoordinator(),
    systemMessageRouter: router,
    requestRender: () => {},
    startServices: startServices as typeof import('@/runtime/index.ts').startExternalServices,
    connectedHostAutostart: {
      control: control ?? { snapshot: () => [], start: () => ({ ok: true }) },
      probeReachability: async () => 'online',
      waitTimeoutMs: 10,
      pollIntervalMs: 1,
      sleep: async () => {},
    },
  });
  return { controller, uiServices };
}

describe('replacing the adopted connected-host handle', () => {
  test('the autostart replacement stops the handle discovery adopted instead of dropping it', async () => {
    const stops: string[] = [];
    const handles = [handleOf('unavailable', stops, 'discovery'), handleOf('external', stops, 'after-autostart')];
    let call = 0;
    const control: DaemonServiceControl = {
      snapshot: () => [{ serviceName: 'goodvibes-daemon', platform: 'systemd', unitPath: '/u', installed: true, running: false, startSupported: true }],
      start: () => ({ ok: true }),
    };
    const { controller } = wire(async () => handles[Math.min(call++, 1)]!, control);
    await controller.whenDiscovered();
    expect(controller.getStatus().daemonStatus.mode).toBe('external');
    expect(stops).toEqual(['discovery']);
  });

  test('a start that finishes after a newer one is stopped and does not overwrite the newer status', async () => {
    const stops: string[] = [];
    const releases: Array<(handle: ExternalServicesHandle) => void> = [];
    const startServices = () => new Promise<ExternalServicesHandle>((resolve) => { releases.push(resolve); });
    const { controller, uiServices } = wire(startServices);
    // Boot discovery is the first start; settle it so restart has a settled base.
    await Promise.resolve();
    releases[0]!(handleOf('unavailable', stops, 'boot'));
    await controller.whenDiscovered();

    const restart = (uiServices.platform as { externalServices: { restart(): Promise<unknown> } }).externalServices.restart;
    const first = restart();
    const second = restart();
    await Promise.resolve();
    await Promise.resolve();
    // releases[1] belongs to the first restart, releases[2] to the second.
    releases[2]!(handleOf('external', stops, 'newer'));
    await second;
    releases[1]!(handleOf('incompatible', stops, 'older'));
    await first;

    expect(controller.getStatus().daemonStatus.mode).toBe('external');
    expect(stops).toContain('older');
    expect(stops).not.toContain('newer');
  });
});
