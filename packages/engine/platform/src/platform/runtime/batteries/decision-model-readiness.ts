/**
 * `engine.runtime.decision-model-readiness`: the one request that checks a
 * decision model answers with the key it was given (runtime/judgment-services.ts,
 * `decisionModelReadiness` with a check). Whether the request is answered at
 * all is what is read; the reading itself decides nothing.
 *
 * Band: low stakes. Nothing is allowed, denied or blocked because of it.
 */
import { defineBattery, STAKES_BANDS, yesNo } from '@goodvibes/judgment';

export const decisionModelReadinessCheck = defineBattery({
  name: 'engine.runtime.decision-model-readiness',
  version: 1,
  description: 'Whether a short text asks to confirm that the decision model is reachable and answering.',
  accuracyFloor: 0.9,
  items: {
    answering: yesNo(
      'Does this text ask to confirm that the decision model is reachable and answering requests?',
      STAKES_BANDS.low.yesNo,
    ),
  },
  fixtures: [
    { name: 'readiness check', state: 'Confirm that the decision model is reachable and answering.', expect: { answering: 'yes' } },
    { name: 'unrelated note', state: 'Water the tomato beds on Tuesday.', expect: { answering: 'no' } },
  ],
});
