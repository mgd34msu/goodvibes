import { BatteryRegistry } from '@goodvibes/judgment';
import { catalogProviderMatchBattery } from './webui-specs.js';

/** Calibration and lint discovery; HTTP admission remains a separate registry. */
export const registry = new BatteryRegistry();
registry.register(catalogProviderMatchBattery);
