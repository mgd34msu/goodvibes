import { BatteryRegistry } from '@goodvibes/judgment';
import { answerIntegrationIntent, answerObjectAlignment } from './battery.js';
export const registry = new BatteryRegistry();
registry.register(answerIntegrationIntent);
registry.register(answerObjectAlignment);
