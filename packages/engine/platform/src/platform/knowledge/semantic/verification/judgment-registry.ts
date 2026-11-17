import { BatteryRegistry } from '@goodvibes-jev/judgment';
import { generatedFactBatchSupport } from './batteries.js';

export const registry = new BatteryRegistry();
registry.register(generatedFactBatchSupport);
