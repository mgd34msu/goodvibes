import { speechSeamsBattery } from './speech-seams.js';
import { BatteryRegistry } from '@goodvibes-jev/judgment';
import { catalogProviderMatchBattery } from './webui-specs.js';

/** Calibration and lint discovery; HTTP admission remains a separate registry. */
export const registry = new BatteryRegistry();
registry.register(speechSeamsBattery);
registry.register(catalogProviderMatchBattery);
