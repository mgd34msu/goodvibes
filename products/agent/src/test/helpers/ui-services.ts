// This fixture binds the shared UI view to the Agent graph after its real project preparation.
import type { UiRuntimeServices } from '../../runtime/ui-services.ts';
import { createUiRuntimeServices } from '../../runtime/ui-services.ts';
import { getTestRuntimeServices } from './runtime-services.ts';

export async function createDefaultUiRuntimeServices(): Promise<UiRuntimeServices> {
  return createUiRuntimeServices((await getTestRuntimeServices()));
}
