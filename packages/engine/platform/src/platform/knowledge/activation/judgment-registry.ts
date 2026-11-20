import { BatteryRegistry } from '@goodvibes/judgment';
import { nodeServingWithoutReview } from './battery.js';
export const registry = new BatteryRegistry();
registry.register(nodeServingWithoutReview);
