import type { ConfigManager, DaemonCredentialStore } from '@goodvibes/engine/platform/platform/config';
import type { GatewayMethodCatalog } from './contracts.js';
import type { NativeMutationHost } from '@goodvibes/engine/platform/platform/control-plane';

export interface HandlerLogger {
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
}

/** Host-owned paths and ports, preserving the pinned daemon handler context. */
export interface HandlerContext {
  readonly catalog: GatewayMethodCatalog;
  readonly credentials: DaemonCredentialStore;
  readonly configManager: Pick<ConfigManager, 'get' | 'getCategory'>
    & Partial<Pick<ConfigManager, 'getIngestionQuarantine'>>;
  readonly workingDirectory: string;
  readonly homeDirectory: string;
  readonly logger: HandlerLogger;
  readonly nativeMutationHost?: NativeMutationHost | undefined;
  /** Whether this daemon holds a profile with that id; used to flag a mistyped routing assignment. */
  readonly hasProfile?: ((profileId: string) => boolean) | undefined;
  /** Keeps a one-line notice for the next terminal or web UI that attaches (a store that had to start empty after damage). */
  readonly recordReceipt?: ((text: string) => void) | undefined;
}

/** A real surface registration with an explicit completion boundary. */
export interface OwnedHandlerSurface {
  readonly ready?: Promise<void>;
  close(): Promise<void>;
}

export type SurfaceRegister = (ctx: HandlerContext) => OwnedHandlerSurface | Promise<OwnedHandlerSurface>;
