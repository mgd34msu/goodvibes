/** Browser-safe provenance for an owner conversation admitted while no decision model is in use. */
import { enum as enumSchema, literal, strictObject } from 'zod/v4';
export interface NativeClassicConversationAdmission {
  readonly provenance: 'owner';
  readonly policy: 'Hybrid' | 'Decision Model Only' | 'No Decision Model';
  /** `selected`: No Decision Model; `not-set`: none is set; `unavailable`: Hybrid found the set model failing. */
  readonly reason: 'selected' | 'not-set' | 'unavailable';
}
export const nativeClassicConversationAdmissionSchema = strictObject({ provenance: literal('owner'),
  policy: enumSchema(['Hybrid', 'Decision Model Only', 'No Decision Model']), reason: enumSchema(['selected', 'not-set', 'unavailable']) })
  .refine(value => value.policy === 'No Decision Model' ? value.reason === 'selected'
    : value.reason === 'not-set' || (value.policy === 'Hybrid' && value.reason === 'unavailable'), 'Policy and reason must agree');
