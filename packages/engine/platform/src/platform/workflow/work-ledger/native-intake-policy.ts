/** Browser-safe provenance for host-owned Classic conversation admission. */
import { enum as enumSchema, literal, strictObject } from 'zod/v4';
export interface NativeClassicConversationAdmission {
  readonly provenance: 'owner'; readonly policy: 'Preferred' | 'Classic - Off'; readonly reason: 'selected' | 'unavailable';
}
export const nativeClassicConversationAdmissionSchema = strictObject({ provenance: literal('owner'),
  policy: enumSchema(['Preferred', 'Classic - Off']), reason: enumSchema(['selected', 'unavailable']) })
  .refine(value => value.policy === 'Preferred' ? value.reason === 'unavailable' : value.reason === 'selected', 'Policy and Classic reason must agree');
