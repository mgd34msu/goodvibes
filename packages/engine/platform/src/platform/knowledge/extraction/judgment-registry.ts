import { htmlDocumentTitle, htmlMainContent } from '../batteries/html-content.js';
import { BatteryRegistry } from '@goodvibes/judgment';
import { extractionReadability } from '../batteries/extraction-readability.js';

/** Extraction decisions, independently discoverable by calibration and lint. */
export const registry = new BatteryRegistry();
registry.register(extractionReadability);
registry.register(htmlMainContent);
registry.register(htmlDocumentTitle);
