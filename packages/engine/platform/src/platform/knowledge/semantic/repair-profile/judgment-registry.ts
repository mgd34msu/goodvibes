import { BatteryRegistry } from '@goodvibes/judgment';
import { repairProfileCategory, repairProfileValue, repairProfileSupport } from './battery.js';
export const registry = new BatteryRegistry();
registry.register(repairProfileCategory);
registry.register(repairProfileValue);
registry.register(repairProfileSupport);
