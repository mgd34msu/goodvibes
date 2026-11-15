import { BatteryRegistry } from '@goodvibes-jev/judgment';
import { exportCredential, profileDistinctive, redactionCredential, residualCredential } from './redaction.js';
import { exportCredentialSpans } from './export-credential-spans.js';

export const registry = new BatteryRegistry();
registry.register(profileDistinctive);
registry.register(redactionCredential);
registry.register(exportCredential);
registry.register(residualCredential);
registry.register(exportCredentialSpans);
