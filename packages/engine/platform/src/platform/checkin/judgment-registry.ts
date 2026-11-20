import { BatteryRegistry } from '@goodvibes/judgment';
import { worthInterrupting, checkinNoteFidelity } from './batteries/worth-interrupting.js';
export const registry = new BatteryRegistry();
registry.register(worthInterrupting);
registry.register(checkinNoteFidelity);
