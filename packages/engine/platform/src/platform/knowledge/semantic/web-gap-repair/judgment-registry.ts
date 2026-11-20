import { BatteryRegistry } from '@goodvibes/judgment';
import { webGapQuery, webGapRelevance, webGapCoverage } from './battery.js';
export const registry = new BatteryRegistry();
registry.register(webGapQuery);
registry.register(webGapRelevance);

registry.register(webGapCoverage);
