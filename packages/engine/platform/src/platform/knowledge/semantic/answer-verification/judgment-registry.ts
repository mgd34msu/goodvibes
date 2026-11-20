import { BatteryRegistry } from '@goodvibes/judgment';
import { answerCandidateQuality, answerEvidenceSufficiency, answerCandidatePreference } from './batteries.js';
/** Labelled synthetic fixtures require real endpoint calibration before accuracy claims. */
export const registry = new BatteryRegistry();
registry.register(answerCandidateQuality);
registry.register(answerEvidenceSufficiency);
registry.register(answerCandidatePreference);
