/** Manager-owned host-alternative projection. Raw catalogs never become model evidence. */
import { isDeepStrictEqual } from 'node:util';
import type { EntryType } from '@goodvibes-jev/judgment';
import { captureJsonEntry } from '../gate/judgment-input.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ProjectedToolCall } from '../tools/input-projection.js';
import { captureCurrentAutonomousChoices, type AutonomousToolChoices } from './autonomous.js';
import { assertPermissionActive } from './cancellation.js';

declare const autonomousChoiceProjection: unique symbol;
/** Opaque, manager-local authority. A caller cannot supply projected catalog JSON. */
export interface AutonomousChoiceProjection {
  readonly [autonomousChoiceProjection]: true;
}

interface CatalogAuthority {
  readonly autonomousChoices: AutonomousToolChoices;
}

interface CapturedCatalog {
  readonly sourceId: string;
  readonly rawAuthority: EntryType;
  readonly choices: AutonomousToolChoices;
  readonly calls: readonly ProjectedToolCall[];
  readonly registry: ToolRegistry;
  readonly signal: AbortSignal | undefined;
  readonly assertCurrent: () => void;
  released: boolean;
  releasePromise?: Promise<void>;
}

function stale(): never { throw new Error('Autonomous choice projection is stale or belongs to another source or manager'); }
function authorityChanged(): never { throw new Error('Autonomous admission authority, source or scope changed'); }

/** Each PermissionManager owns one instance; only its own handles can select a catalog. */
export class AutonomousChoiceProjectionOwner {
  private readonly captures = new WeakMap<AutonomousChoiceProjection, CapturedCatalog>();
  private projectionSequence = 0;

  async project(sourceId: string, callId: string, registry: ToolRegistry,
    authorityOf: () => CatalogAuthority, signal?: AbortSignal): Promise<AutonomousChoiceProjection> {
    assertPermissionActive(signal);
    const original = authorityOf();
    const rawAuthority = captureJsonEntry(original);
    const projectionId = (++this.projectionSequence).toString(36);
    const calls: ProjectedToolCall[] = [];
    let released = false;
    const assertCurrent = () => {
      assertPermissionActive(signal);
      if (released) stale();
      const current = captureJsonEntry(authorityOf());
      if (released) stale();
      if (!isDeepStrictEqual(current, rawAuthority)) authorityChanged();
      assertPermissionActive(signal);
    };
    try {
      const revisions = [];
      for (const revision of original.autonomousChoices.revisions ?? []) {
        assertCurrent();
        // Use the logical call's original identity. Selection later reuses this
        // exact registry-owned args object, never a new capture or raw fallback.
        const projected = await registry.projectCall(callId, revision.toolName, revision.args, { signal, assertCurrent });
        calls.push(projected);
        assertCurrent();
        registry.assertProjected(projected);
        revisions.push(Object.freeze({
          ref: Object.freeze({ ...revision.ref, revision: `catalog-${projectionId}-${revisions.length.toString(36)}` }),
          toolName: revision.toolName, args: projected.args,
        }));
      }
      const inspected = captureCurrentAutonomousChoices({ revisions, resumeConditions: original.autonomousChoices.resumeConditions });
      // The public selector makes another inspected copy. Keep our registry
      // identities privately and restore the selected one in the manager.
      const choices = Object.freeze({ ...inspected, revisions: Object.freeze(revisions) });
      const handle = Object.freeze({}) as AutonomousChoiceProjection;
      this.captures.set(handle, {
        sourceId, rawAuthority, choices, calls: Object.freeze(calls), registry, signal,
        assertCurrent, get released() { return released; }, set released(value) { released = value; },
      });
      assertCurrent();
      for (const call of calls) registry.assertProjected(call);
      assertCurrent();
      for (const call of calls) registry.assertProjectedSnapshot(call);
      return handle;
    } catch (error) {
      released = true;
      await Promise.allSettled(calls.map(call => registry.releaseProjected(call)));
      throw error;
    }
  }

  choices(handle: AutonomousChoiceProjection, sourceId: string, authority: CatalogAuthority): AutonomousToolChoices {
    const capture = this.captures.get(handle);
    if (!capture || capture.released || capture.sourceId !== sourceId) stale();
    if (!isDeepStrictEqual(captureJsonEntry(authority), capture.rawAuthority)) authorityChanged();
    assertPermissionActive(capture.signal);
    // The manager just captured this coherent host frame. An empty catalog has
    // no projector callbacks to stage, so that checked frame is already final.
    // Recapturing it here would add reentrant host reads to the claim boundary.
    if (capture.calls.length === 0) return capture.choices;
    capture.assertCurrent();
    for (const call of capture.calls) capture.registry.assertProjected(call);
    // A later projector callback may revoke an earlier alternative or the raw
    // host frame. Stage all callbacks, then finish with callback-free checks.
    capture.assertCurrent();
    for (const call of capture.calls) capture.registry.assertProjectedSnapshot(call);
    return capture.choices;
  }

  release(handle: AutonomousChoiceProjection): Promise<void> {
    const capture = this.captures.get(handle);
    if (!capture) stale();
    if (capture.releasePromise) return capture.releasePromise;
    capture.released = true;
    capture.releasePromise = Promise.resolve().then(async () => {
      const results = await Promise.allSettled(capture.calls.map(call => capture.registry.releaseProjected(call)));
      if (results.some(result => result.status === 'rejected')) throw new Error('Autonomous choice projection release failed');
    });
    return capture.releasePromise;
  }
}
