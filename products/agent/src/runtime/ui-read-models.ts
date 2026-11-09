import { createUiReadModels as create, type UiReadModelOptions, type UiReadModels } from '@goodvibes-jev/engine/platform/platform/runtime/ui';
import type { RuntimeServices } from './services.ts';
export * from '@goodvibes-jev/engine/platform/platform/runtime/ui';
/** The Agent's read-only daemon view keeps dispatch ownership out of read models. */
export function createUiReadModels(services: RuntimeServices, options: UiReadModelOptions = {}): UiReadModels { return create(services.asDaemonGradeView(), options); }
