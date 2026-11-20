import { BatteryRegistry } from '@goodvibes/judgment';
import { repairSourceAuthority } from './battery.js';
export const registry = new BatteryRegistry();
registry.register(repairSourceAuthority);
