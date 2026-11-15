/**
 * Lists that two or more package scripts must agree on, kept in one place so a
 * one-sided edit cannot make a gate fail or a build delete a shipped file.
 */

/**
 * Platform modules with an `index.ts` that are deliberately NOT part of the
 * published surface, each with the reason it is unreachable by design.
 *
 * A module belongs here when consumers reach its behaviour through the control
 * plane rather than by importing it, the daemon owns the instance, and handing
 * out the class would invite a second one.
 */
export const INTENTIONALLY_INTERNAL: Readonly<Record<string, string>> = {
  'channel-profiles': 'daemon-owned registry; consumers reach it through the channel-profiles.* verbs',
  checkin: 'daemon-owned scheduler; consumers configure it through checkin.* config keys and verbs',
  principals: 'daemon-owned registry; consumers reach it through the principals.* verbs',
  push: 'daemon-owned subscription store; consumers reach it through the push.* verbs',
};

/**
 * Hand-written declarations, relative to `platform/src`, that `prepare:engine`
 * copies into `platform/dist`. They carry a tsc output suffix without being tsc
 * output, so the build's orphan sweep must leave them alone.
 */
export const AMBIENT_DECLARATIONS: readonly string[] = ['platform/types/sql-js.d.ts'];
