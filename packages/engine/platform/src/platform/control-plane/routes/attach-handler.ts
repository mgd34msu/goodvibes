/**
 * routes/attach-handler.ts, binding a handler to a descriptor the method
 * catalog already holds.
 *
 * Descriptors are registered from the method-catalog files and handlers are
 * attached later by the composition that owns the service. A handler whose
 * descriptor is missing is logged with its id rather than dropped in silence,
 * so contract drift shows at start instead of as a 501 at first use.
 * Construction does not fail over it.
 */
import type { GatewayMethodCatalog } from '../method-catalog.js';
import type { GatewayMethodHandler } from '../method-catalog-shared.js';
import { logger } from '../../utils/logger.js';

/** Attach `handler` to descriptor `id`; true when attached, false (and logged) when there is no such descriptor. */
export function attachHandler(catalog: GatewayMethodCatalog, id: string, handler: GatewayMethodHandler): boolean {
  const descriptor = catalog.get(id);
  if (!descriptor) {
    logger.warn('gateway handler has no descriptor; not attached', { id });
    return false;
  }
  catalog.register(descriptor, handler, { replace: true });
  return true;
}
