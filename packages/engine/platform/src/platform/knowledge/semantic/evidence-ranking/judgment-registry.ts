import { BatteryRegistry } from '@goodvibes/judgment';
import { answerEvidenceRelevance } from './battery.js';
export const registry = new BatteryRegistry();
registry.register(answerEvidenceRelevance);
