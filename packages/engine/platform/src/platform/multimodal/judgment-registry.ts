import { BatteryRegistry } from '@goodvibes/judgment';
import { entityCentrality } from './entity-centrality.js';
export const registry = new BatteryRegistry();
registry.register(entityCentrality);
