// Deliberately per-repo test scaffolding, kept per repo and not expected to match the sibling product's copy: it binds to this repo's own working tree, source layout and Bun test lifecycle, so a shared home would mean inventing a test-only published package rather than hoisting anything.
import type { UiRuntimeServices } from '../../runtime/ui-services.ts';
import { createUiRuntimeServices } from '../../runtime/ui-services.ts';
import { getTestRuntimeServices } from './runtime-services.ts';

export async function createDefaultUiRuntimeServices(): Promise<UiRuntimeServices> {
  return createUiRuntimeServices((await getTestRuntimeServices()));
}
