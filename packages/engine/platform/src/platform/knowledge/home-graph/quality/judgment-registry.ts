import { BatteryRegistry } from '@goodvibes/judgment';
import { homeGraphQualityBatteries } from './batteries.js';

export const registry = new BatteryRegistry();
for (const battery of Object.values(homeGraphQualityBatteries)) registry.register(battery);
