import { createOnboardingFileHelpers } from '@goodvibes-jev/engine/terminal-shell/onboarding-file-helpers';
import { writeStoreFile } from '@/utils/store-file.ts';
export type { RollbackAction } from '@goodvibes-jev/engine/terminal-shell/onboarding-file-helpers';
export const { isPlainObject, readJsonObject, writeJsonObject, setNestedValue, restoreFile, snapshotFileRollback, runRollbacks } = createOnboardingFileHelpers({ write: writeStoreFile, describeError: error => error instanceof Error ? error.message : String(error) });
