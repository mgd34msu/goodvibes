import { RefusalError, refusal } from '@goodvibes/engine/errors';

/**
 * Who may mark a persona, skill, skill bundle or routine reviewed, and who may
 * enable one that is not. "Reviewed" is the one flag that lets the record's
 * text into every later prompt, so it is the owner's decision: a model may
 * propose (create, edit, disable) but marking reviewed, and enabling a record
 * nobody reviewed, count only from the owner's own keystrokes. Every route that
 * reaches these registry methods (slash commands, the registry tool, the
 * workspace actions, the VIBE.md import) calls the same two checks with the
 * actor it is acting for, so the answer does not depend on the route.
 */
export type RegistryActor = 'owner' | 'model';

export type ReviewedKind = 'persona' | 'skill' | 'skill bundle' | 'routine';

/** The command the owner types to review a record of each kind. */
const OWNER_REVIEW_COMMAND: Readonly<Record<ReviewedKind, string>> = {
  persona: '/personas review',
  skill: '/skills review',
  'skill bundle': '/skills bundle review',
  routine: '/routines review',
};

function ownerOnly(kind: ReviewedKind, id: string, reason: string): RefusalError {
  return new RefusalError(refusal({
    code: 'OWNER_REVIEW_REQUIRED',
    state: `Agent ${kind} ${id} is unchanged`,
    reason,
    next: [`Ask the owner to run ${OWNER_REVIEW_COMMAND[kind]} ${id}`],
    status: 403,
  }));
}

/** Throws unless `actor` may mark the record reviewed. */
export function assertActorMayMarkReviewed(actor: RegistryActor, kind: ReviewedKind, id: string): void {
  if (actor === 'owner') return;
  throw ownerOnly(kind, id, `Marking a ${kind} reviewed is the owner's decision that its text may reach the prompt, so it only counts when the owner types it. This request came from the model, the route content it just read could steer`);
}

/** Throws unless `actor` may enable the record in its current review state. */
export function assertActorMayEnable(actor: RegistryActor, kind: ReviewedKind, id: string, reviewState: string | undefined): void {
  if (actor === 'owner' || reviewState === 'reviewed') return;
  throw ownerOnly(kind, id, `Agent ${kind} ${id} has not been reviewed, and only the owner can enable a ${kind} nobody reviewed`);
}
