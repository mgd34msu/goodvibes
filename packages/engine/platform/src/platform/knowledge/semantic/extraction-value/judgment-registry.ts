import { BatteryRegistry } from '@goodvibes/judgment';
import { knowledgeExtractionValue } from './battery.js';

export const registry = new BatteryRegistry();
registry.register(knowledgeExtractionValue);
