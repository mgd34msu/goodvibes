/**
 * artifact-saves-through-daemon.ts: a terminal program's turns save their artifacts (generated media, model comparisons,
 * research reports, review packets) through the daemon's `artifacts.save` capability, never into the store's folder from
 * this process. The daemon's one store holds each and announces it (LIST_CHANGED `artifacts`), so an open Artifacts list
 * follows with no key in every program and the web UI; this program then takes the saved artifact up from the same
 * folder (`ArtifactStore.takeUp`) and reads it as its own. A save the daemon refuses or cannot be reached for fails in
 * its own words; nothing is written here instead (the daemon owns the artifacts, with no in-process fallback).
 *
 * A save made inside a model's tool call (a media, research or comparison tool) is a nested `capability_run` call of
 * it (capability-tools.ts `daemonCapabilityRunner`): `artifacts.save` is judged by its own risk by the one gate a
 * model's capability call goes through. A save made outside one is sent with no mark of that gate, so the daemon
 * decides it under the owner's mode as any outside caller's.
 */
import type { ArtifactCreateInput, ArtifactDescriptor, ArtifactStore } from '@goodvibes/engine/platform/platform/artifacts';
import type { ShellPathService } from '@goodvibes/engine/platform/platform/runtime/shell';
import type { ConnectedHostConfigReader } from './connected-host-client.js';
import { daemonCapabilityRunner } from './capability-tools.js';

/** Route every save of this program's artifact store through the daemon (ArtifactStore `routeCreate`). */
export function routeArtifactSavesThroughDaemon(
  store: Pick<ArtifactStore, 'routeCreate' | 'takeUp'>,
  shellPaths: ShellPathService,
  configManager: ConnectedHostConfigReader,
  program: 'tui' | 'agent',
): void {
  const run = daemonCapabilityRunner({ shellPaths, configManager, program });
  store.routeCreate(async (input: ArtifactCreateInput): Promise<ArtifactDescriptor> => {
    const inputs: Record<string, string> = input.dataBase64 !== undefined
      ? { content: input.dataBase64, encoding: 'base64' }
      : { content: input.text ?? '', encoding: 'text' };
    if (input.filename) inputs.filename = input.filename;
    if (input.mimeType) inputs.mimeType = input.mimeType;
    if (input.kind) inputs.kind = input.kind;
    if (input.sourceUri) inputs.source = input.sourceUri;
    if (input.metadata) inputs.metadata = JSON.stringify(input.metadata);
    if (input.retentionMs !== undefined && input.retentionMs > 0) inputs.retention = String(Math.trunc(input.retentionMs));
    const answer = await run('artifacts.save', inputs);
    if (!answer.ok) throw new Error(`The artifact was not saved: ${answer.error}`);
    const saved = answer.data['artifact'] as { readonly id?: unknown } | undefined;
    const id = typeof saved?.id === 'string' ? saved.id : '';
    const taken = id ? store.takeUp(id) : null;
    if (!taken) throw new Error(`The daemon saved the artifact${id ? ` ${id}` : ''}, but this program could not read it from the store's folder.`);
    return taken;
  });
}
