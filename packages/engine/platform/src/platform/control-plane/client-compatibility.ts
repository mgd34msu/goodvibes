/**
 * Client build compatibility floor, the daemon's half.
 *
 * A daemon update swaps the daemon binary. It does NOT restart the clients
 * already attached to it: a terminal UI or agent process started days earlier
 * keeps running its old build, keeps heartbeating into the shared session
 * store, and keeps executing shared-session work with whatever rules that old
 * build shipped with. A behavioral fix landed in the daemon is therefore
 * INVISIBLE for as long as one stale client is still attached.
 *
 * That is what this floor is for. The daemon publishes the minimum client
 * build it will let participate; every client compares its own build against
 * it on attach and, when it is below the floor, says so plainly and stops
 * claiming ownership of shared sessions rather than quietly executing work
 * under superseded rules.
 *
 * The floor is announced as a RESPONSE HEADER on `/status` rather than as a
 * body field: `/status` has a closed response schema, and a header is
 * additive, ignorable by older clients, and readable from the liveness probe
 * every client already performs.
 *
 * The comparison and the verdict live in build-compatibility.ts, which
 * imports nothing so the web UI reads the same rule.
 */
import { VERSION } from '../version.js';
import { clientCompatibilityFloorFor } from './build-compatibility.js';

export {
  CLIENT_COMPATIBILITY_FLOOR_HEADER,
  clientCompatibilityFloorFor,
  compareBuildVersions,
  evaluateClientCompatibility,
  readClientCompatibilityFloor,
  type ClientCompatibilityStatus,
  type ClientCompatibilityVerdict,
  type ClientRestartWording,
} from './build-compatibility.js';

/**
 * The minimum client build this daemon accepts as a full participant: the
 * daemon's own release line, derived from its version, so a client from the
 * previous release is fenced after an update without anyone raising a number.
 */
export const CLIENT_COMPATIBILITY_FLOOR = clientCompatibilityFloorFor(VERSION);
