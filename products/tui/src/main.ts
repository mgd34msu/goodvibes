#!/usr/bin/env bun
import './runtime/native-data-writer.ts';
import { installedReaderCommand } from '@goodvibes-jev/engine/platform/platform/runtime/self-update';
import { COMPILED_VERSION } from './version.ts';

// Installation reader checks never load the UI/config/provider runtime.
const readerDescription = installedReaderCommand(process.argv.slice(2), COMPILED_VERSION);
if (readerDescription !== undefined) {
  process.stdout.write(readerDescription + '\n');
} else {
  await import('./interactive.ts');
}
