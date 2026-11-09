import {
  createTerminalUiServices,
  type TerminalUiRuntimeSharedServices,
  type TerminalUiRuntimeServices,
} from '@goodvibes-jev/engine/terminal-shell/ui-services';
import type { RuntimeServices } from './services.ts';
import { createUiReadModels, type UiReadModelOptions } from './ui-read-models.ts';
import type { ForensicsRegistry } from '@/runtime/index.ts';
import type { ControlPlaneRecentEvent } from '@goodvibes-jev/engine/platform/platform/control-plane';
import type { SharedSessionBroker } from '@goodvibes-jev/engine/platform/platform/control-plane';
import type { HostServiceStatus } from '@/runtime/index.ts';
import type { SecretsManager } from '../config/secrets.ts';

type PlatformExtras = {
  readonly secretsManager: SecretsManager;
  readonly externalServices?: {
    inspect(): {
      readonly connectedHostRunning: boolean;
      readonly connectedHostPortInUse?: boolean;
      readonly httpListenerRunning: boolean;
      readonly httpListenerPortInUse?: boolean;
      readonly connectedHostStatus?: HostServiceStatus;
      readonly httpListenerStatus?: HostServiceStatus;
    };
    restart(): Promise<{
      readonly connectedHostRunning: boolean;
      readonly connectedHostPortInUse?: boolean;
      readonly httpListenerRunning: boolean;
      readonly httpListenerPortInUse?: boolean;
      readonly connectedHostStatus?: HostServiceStatus;
      readonly httpListenerStatus?: HostServiceStatus;
    }>;
  };
};
type RuntimeExtras = {};
export type UiRuntimeSharedServices = TerminalUiRuntimeSharedServices<RuntimeServices, SharedSessionBroker, PlatformExtras, RuntimeExtras>;
export type UiRuntimeServices = TerminalUiRuntimeServices<RuntimeServices, SharedSessionBroker, PlatformExtras, RuntimeExtras>;
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
}

export function createUiRuntimeServices(runtimeServices: RuntimeServices, options: UiRuntimeServicesOptions = {}): UiRuntimeServices {
  return createTerminalUiServices(runtimeServices, {
    sessionBroker: runtimeServices.automationSessionRegister,
    platform: {},
    runtime: {},
    readModels: createUiReadModels(runtimeServices, options),
  });
}
