import {
  createTerminalUiServices,
  type TerminalUiRuntimeSharedServices,
  type TerminalUiRuntimeServices,
} from '@goodvibes-jev/engine/terminal-shell/ui-services';
import type { RuntimeServices } from './services.ts';
import { createUiReadModels, type UiReadModelOptions } from './ui-read-models.ts';
import type { ForensicsRegistry } from '@/runtime/index.ts';
import type { ControlPlaneRecentEvent } from '@goodvibes-jev/engine/sdk/platform/control-plane';
import { SessionUnionCache, type SessionReadFacade } from '@goodvibes-jev/engine/sdk/platform/runtime/session-spine';
import type { HostServiceStatus } from '@/runtime/index.ts';
import type { SecretsManager } from '../config/secrets.ts';
import type { RelayReadAccessors } from './relay-reachability-bridge.ts';

type PlatformExtras = {
  readonly secretsManager: SecretsManager;
  readonly pairingTokens: RuntimeServices['pairingTokens'];
  readonly externalServices?: RelayReadAccessors & {
    inspect(): {
      readonly daemonRunning: boolean;
      readonly daemonPortInUse?: boolean;
      readonly httpListenerRunning: boolean;
      readonly httpListenerPortInUse?: boolean;
      readonly daemonStatus?: HostServiceStatus;
      readonly httpListenerStatus?: HostServiceStatus;
      // Honest session-spine posture for the footer segment, driven by
      // the spine client's own live wire attempts (not the one-shot adopt probe).
      readonly sessionSpineActive?: boolean;
      readonly sessionSpineStatus?: 'unknown' | 'online' | 'offline';
    };
    restart(): Promise<{
      readonly daemonRunning: boolean;
      readonly daemonPortInUse?: boolean;
      readonly httpListenerRunning: boolean;
      readonly httpListenerPortInUse?: boolean;
      readonly daemonStatus?: HostServiceStatus;
      readonly httpListenerStatus?: HostServiceStatus;
    }>;
  };
};
type RuntimeExtras = {
  readonly processRegistry: RuntimeServices['processRegistry'];
  readonly fleetReadModel: RuntimeServices['fleetReadModel'];
  readonly runtimeBus: RuntimeServices['runtimeBus'];
};
export type UiRuntimeSharedServices = TerminalUiRuntimeSharedServices<RuntimeServices, SessionReadFacade, PlatformExtras, RuntimeExtras>;
export type UiRuntimeServices = TerminalUiRuntimeServices<RuntimeServices, SessionReadFacade, PlatformExtras, RuntimeExtras>;
export type UiEnvironmentServices = UiRuntimeSharedServices['environment'];
export type UiShellServices = UiRuntimeSharedServices['shell'];
export type UiAgentServices = UiRuntimeSharedServices['agents'];
export type UiProviderServices = UiRuntimeSharedServices['providers'];
export type UiSessionServices = UiRuntimeSharedServices['sessions'];
export type UiPlatformServices = UiRuntimeSharedServices['platform'];
export type UiPlanningServices = UiRuntimeSharedServices['planning'];
export type UiCoordinationServices = UiRuntimeSharedServices['coordination'];

export interface UiRuntimeServicesOptions extends UiReadModelOptions {
  readonly forensicsRegistry?: ForensicsRegistry;
  readonly getControlPlaneRecentEvents?: (limit: number) => readonly ControlPlaneRecentEvent[];
  /**
   * The shared session read facade constructed in bootstrap-core (so
   * bootstrap.ts can drive its adopted-external/local mode). When omitted
   * (test callers), a local-only passthrough facade over the broker is auto-created.
   */
  readonly sessionUnionCache?: SessionUnionCache;
}

export function createUiRuntimeServices(runtimeServices: RuntimeServices, options: UiRuntimeServicesOptions = {}): UiRuntimeServices {
  return createTerminalUiServices(runtimeServices, {
    sessionBroker: options.sessionUnionCache ?? new SessionUnionCache({ local: runtimeServices.sessionBroker }),
    platform: { pairingTokens: runtimeServices.pairingTokens },
    runtime: {
      processRegistry: runtimeServices.processRegistry,
      fleetReadModel: runtimeServices.fleetReadModel,
      runtimeBus: runtimeServices.runtimeBus,
    },
    readModels: createUiReadModels(runtimeServices, options),
  });
}
