import { BatteryRegistry } from '@goodvibes/judgment';
import { knowledgeUriRef } from './battery.js';
export const registry = new BatteryRegistry();
registry.register(knowledgeUriRef);
