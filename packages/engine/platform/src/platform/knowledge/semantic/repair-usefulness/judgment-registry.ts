import { BatteryRegistry } from '@goodvibes-jev/judgment';
import { repairFactUsefulness } from './battery.js';
export const registry = new BatteryRegistry();
registry.register(repairFactUsefulness);

import { knowledgePageFactUsefulness } from './page-battery.js';
registry.register(knowledgePageFactUsefulness);
import { enrichmentFactUsefulness } from './batch.js';
registry.register(enrichmentFactUsefulness);
