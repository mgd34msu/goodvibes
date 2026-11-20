import { describeStructuralDeliveryError } from '@goodvibes/engine/platform/platform/integrations';

/** Private provider errors remain retry inputs; only this projection may reach CLI output. */
export function describeSendFailure(error: unknown): string {
  return describeStructuralDeliveryError(error);
}
