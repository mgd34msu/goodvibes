/**
 * places/, the place framework both terminal programs use (BUILDING-A-PLACE.md
 * in the overhaul records says how to declare one).
 *
 * `wirePlaces` is the one call a program makes: it gives its command
 * context, its owner path, its key table and its way to the daemon, and gets
 * back how to open the menu and a place. Every place is declared once here;
 * each place's keys are registered as its key context in the program's table,
 * and the calls the program's gate holds are posted to the daemon's owner
 * inbox, where Waiting for you reads them with everything else.
 */
import type { SurfaceModalHost } from '../surface-modal-host.js';
import { createPlaceHost, type PlaceHost, type PlaceHostOptions, type PlaceKeyTable } from './place-host.js';
import { PlaceMenu } from './place-menu.js';
import { PlaceModal } from './place-modal.js';
import type { AnyPlace } from './place-types.js';
import { AUTOMATION_PLACE } from './automation-place.js';
import { KEYS_PLACE, keysProgramActions, keysSource } from './keys-place.js';
import { WAITING_PLACE } from './waiting-place.js';
import { placeKeyContext } from './place-keys.js';
import { bridgeHeldCallsToDaemonInbox } from './held-calls-inbox.js';

export type { AnyPlace, PlaceAction, PlaceAnswer, PlaceCapabilityAction, PlaceCount, PlaceDeclaration, PlaceDetailLine, PlaceFollow, PlaceGroupId, PlaceItem, PlaceList, PlaceProgramAction, PlaceRow, PlaceSource } from './place-types.js';
export { definePlace } from './place-types.js';
export type { PlaceHost, PlaceHostOptions, PlaceKeyTable, PlaceProgramSource, PlacePrograms, PlaceRunOutcome, ResolvedCapability } from './place-host.js';
export { createPlaceHost, resolveCapability } from './place-host.js';
export { PlaceModal, READ_AGAIN_KEY } from './place-modal.js';
export { PlaceMenu } from './place-menu.js';
export { AUTOMATION_PLACE } from './automation-place.js';
export { WAITING_PLACE } from './waiting-place.js';
export { KEYS_PLACE } from './keys-place.js';
export { placeKeyContext, placeKeyContextId, READ_AGAIN_ACTION } from './place-keys.js';
export { bridgeHeldCallsToDaemonInbox } from './held-calls-inbox.js';

/** Every place, in menu order of their groups (the menu orders by group, not by this list). */
export const PLACES: readonly AnyPlace[] = [WAITING_PLACE, AUTOMATION_PLACE, KEYS_PLACE];

export type WirePlacesOptions = Omit<PlaceHostOptions, 'openPlace' | 'sources' | 'programActions' | 'modals' | 'keys'> & {
  readonly modals: Pick<SurfaceModalHost, 'push' | 'close'>;
  readonly keys: PlaceKeyTable;
  /** The program's own name, on the held calls it posts (`tui`, `agent`). */
  readonly program: 'tui' | 'agent';
};

export interface WiredPlaces {
  readonly host: PlaceHost;
  /** Open the menu of every place. */
  openMenu(): void;
  /** Open one place by id; false when there is none by that id. */
  openPlace(id: string): boolean;
  /** Stop what the places hold open (the held-call bridge). */
  stop(): void;
}

/** Wire the places into one program: the menu, each place, their keys, sources and program actions, and its held calls. */
export function wirePlaces(options: WirePlacesOptions): WiredPlaces {
  // Each place's keys are a context of the program's key table: rebindable, checked for conflicts, listed in Keys.
  for (const place of PLACES) options.keys.registerContext(placeKeyContext(place));
  const sources = { keys: keysSource(options.keys) };
  let host: PlaceHost | undefined;
  const openPlace = (id: string): boolean => {
    const place = PLACES.find((candidate) => candidate.id === id);
    if (!place || !host) return false;
    options.modals.push(new PlaceModal(place, host));
    options.requestRender();
    return true;
  };
  host = createPlaceHost({
    ...options,
    sources,
    programActions: keysProgramActions(options.keys),
    openPlace: (id) => { openPlace(id); },
    modals: options.modals,
  });
  const wired = host;
  // The calls this program's gate holds go to the daemon's owner inbox, beside the daemon's own.
  const stopHeld = bridgeHeldCallsToDaemonInbox({
    invoke: options.invoke,
    daemonEndpoint: options.daemonEndpoint,
    onDaemonBack: options.onDaemonBack,
    program: options.program,
  });
  return {
    host: wired,
    openMenu: () => { options.modals.push(new PlaceMenu(PLACES, wired)); options.requestRender(); },
    openPlace,
    stop: stopHeld,
  };
}
