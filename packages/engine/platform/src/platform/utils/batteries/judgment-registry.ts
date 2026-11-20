import { BatteryRegistry } from '@goodvibes/judgment';
import { profileDistinctive } from './redaction.js';
import { exportCredentialSpans } from './export-credential-spans.js';

export const registry = new BatteryRegistry();
registry.register(profileDistinctive);
registry.register(exportCredentialSpans);
