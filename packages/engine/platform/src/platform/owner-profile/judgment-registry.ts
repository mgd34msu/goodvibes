import { BatteryRegistry } from '@goodvibes/judgment';
import { postalAddressExtraction } from './postal-reading.js';
export const registry = new BatteryRegistry();
registry.register(postalAddressExtraction);
