import { logger } from '../utils/logger.js';

/** Await local response retirement without turning acknowledged acceptance into a retry. */
export async function retireDeliveryResponse(response: Response): Promise<void> {
  try { await response.body?.cancel(); }
  catch {
    try { logger.warn('Delivery response cleanup failed', { reason: 'response-cleanup-failed' }); }
    catch { /* Diagnostic failure cannot change an already received outcome. */ }
  }
}

/** Only actual numeric HTTP status, never arbitrary error text or its cause. */
export function deliveryHttpStatus(error: unknown): number | undefined {
  try {
    if (error === null || typeof error !== 'object') return undefined;
    for (const key of ['status', 'statusCode']) {
      const value = (error as Record<string, unknown>)[key];
      if (typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599) return value;
    }
  } catch { /* Unreadable fields do not become diagnostics. */ }
  return undefined;
}

export function describeStructuralDeliveryError(error: unknown): string {
  const status = deliveryHttpStatus(error);
  return status === undefined ? 'Delivery failed' : `HTTP ${status}`;
}
