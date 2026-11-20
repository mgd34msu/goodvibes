import { BatteryRegistry } from '@goodvibes/judgment';
import { homeGraphTriageApplicability, homeGraphBatteryFacts, homeGraphManualFact } from './batteries.js';

export const registry = new BatteryRegistry();
registry.register(homeGraphTriageApplicability);
registry.register(homeGraphBatteryFacts);
registry.register(homeGraphManualFact);
