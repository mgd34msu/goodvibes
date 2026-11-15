import { speechSeamsBattery } from './speech-seams.js';
import { BatteryRegistry } from '@goodvibes-jev/judgment';
import { catalogProviderMatchBattery, daemonRefusalBattery, mailReplySubjectBattery } from './webui-specs.js';

/** Calibration and lint discovery; HTTP admission remains a separate registry. */
export const registry = new BatteryRegistry();
registry.register(daemonRefusalBattery);
registry.register(mailReplySubjectBattery);
registry.register(speechSeamsBattery);
registry.register(catalogProviderMatchBattery);
