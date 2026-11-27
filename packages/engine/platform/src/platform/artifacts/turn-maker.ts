/**
 * turn-maker.ts, whose a file the daemon's store keeps is: every artifact records its maker and its project when it is
 * made, in the store itself (store.ts `withTurnMaker`), however it was made.
 * - Inside a daemon turn: the chat's or session's whose turn made it, its maker and its project (the one check of what a
 *   caller may reach reads both, control-plane/caller-reach.ts, daemon/record-owners.ts), so the caller whose chat it is
 *   reaches the file, and a caller of another project does not. Set once by the daemon (it knows its chats and sessions).
 * - Otherwise, inside a call the daemon runs for a caller (`capabilities.run`: a device's or member's save, the owner's,
 *   a carried file): that caller and the project its call names (`withArtifactMaker`).
 * - Otherwise: the details as given (a route that names its maker, such as `artifacts.create`). A file kept from before
 *   this record names no maker and is the owner's only.
 * A program's own store sets nothing and keeps what its saves name.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

/** Who made a file and the project it belongs to. */
export interface ArtifactTurnMaker {
  readonly createdBy?: string | undefined;
  readonly project?: string | undefined;
}

let makerOfTurn: (() => ArtifactTurnMaker | undefined) | null = null;
const callMaker = new AsyncLocalStorage<ArtifactTurnMaker>();

/** The daemon's reader of the turn being run: its chat's or session's maker and project, or undefined outside a turn. */
export function setArtifactMakerOfTurn(reader: (() => ArtifactTurnMaker | undefined) | null): void {
  makerOfTurn = reader;
}

/** Runs `fn` as a call made by `maker` (its caller and the project its call names): a file it saves is that caller's. */
export function withArtifactMaker<T>(maker: ArtifactTurnMaker | undefined, fn: () => T): T {
  return maker && (maker.createdBy !== undefined || maker.project !== undefined) ? callMaker.run(maker, fn) : fn();
}

/** Whether a caller's call already names the maker (an outer call: a capability run whose nested method call adds). */
export function hasArtifactMaker(): boolean {
  const maker = callMaker.getStore();
  return maker !== undefined && (maker.createdBy !== undefined || maker.project !== undefined);
}

/**
 * A new file's details with its maker and project: inside a daemon turn the turn's chat decides both (a maker a call
 * inside the turn names is the turn's own credential, not a person); inside a caller's call, that caller and its
 * project; outside both, the details as given.
 */
export function withTurnMaker(metadata: Record<string, unknown>): Record<string, unknown> {
  let maker: ArtifactTurnMaker | undefined;
  try { maker = makerOfTurn?.(); } catch { maker = undefined; }
  if (!maker || (maker.createdBy === undefined && maker.project === undefined)) maker = callMaker.getStore();
  if (!maker || (maker.createdBy === undefined && maker.project === undefined)) return metadata;
  const rest: Record<string, unknown> = { ...metadata };
  delete rest['createdBy'];
  delete rest['project'];
  return { ...rest, ...(maker.createdBy ? { createdBy: maker.createdBy } : {}), ...(maker.project ? { project: maker.project } : {}) };
}
