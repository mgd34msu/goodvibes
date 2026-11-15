import type { GatewayMethodCatalog } from '../../control-plane/method-catalog.js';
import type { NativeMutationHost } from '../../control-plane/native-mutation.js';

/** The host-owned catalog, path and diagnostics needed by routing registration. */
export interface RoutingHostContext {
  readonly catalog: GatewayMethodCatalog;
  readonly workingDirectory: string;
  readonly nativeMutationHost?: NativeMutationHost | undefined;
  /**
   * Whether this host holds a profile with that id. Profiles belong to the
   * surface that answers as them and may live outside this host, so a miss is
   * reported in the log and the assignment is still kept.
   */
  readonly hasProfile?: ((profileId: string) => boolean) | undefined;
  readonly logger: {
    info(message: string, meta?: unknown): void;
    warn(message: string, meta?: unknown): void;
    error(message: string, meta?: unknown): void;
  };
}
