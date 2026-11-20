import { BatteryRegistry } from '@goodvibes/judgment';
import { answerExcerptSelection } from './battery.js';
export const registry = new BatteryRegistry();
registry.register(answerExcerptSelection);
