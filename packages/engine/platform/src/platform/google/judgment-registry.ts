import { BatteryRegistry } from '@goodvibes-jev/judgment';
import { consoleStatus } from './console-reading.js';
export const registry = new BatteryRegistry();
registry.register(consoleStatus);

import { googleGrantFailure } from './failure-readings.js';
registry.register(googleGrantFailure);

import { verificationArtifact } from './verification-reading.js';
registry.register(verificationArtifact);
