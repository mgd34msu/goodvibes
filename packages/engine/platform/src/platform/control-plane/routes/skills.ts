/**
 * routes/skills.ts
 *
 * Handlers for the skills.* gateway verbs over the canonical `SkillService`
 * (../../skills, service.ts). Thin verb registration, not new machinery: each
 * handler reads the invocation params, calls the service, and maps a
 * `SkillServiceError` to an honest wire status (INVALID_ARGUMENT -> 400,
 * NOT_FOUND -> 404, ALREADY_EXISTS -> 409).
 *
 * Wired via `GatewayMethodCatalog.register(descriptor, handler)`, the same
 * mechanism fleet.* / checkpoints.* / push.* use, against descriptors already
 * cataloged (without a handler) from ../method-catalog-skills.ts. Attaching the
 * handler and the descriptor together is what keeps a skills verb from being a
 * cataloged-but-unhandled 501.
 */
import type { GatewayMethodCatalog } from '../method-catalog.js';
import type { GatewayMethodHandler, GatewayMethodInvocation } from '../method-catalog-shared.js';
import { makesOwnerOnlyAct, ownersAgentProgram, ownersOwnPress } from '../../daemon/method-owner-decision.js';
import { authorAfterChange, newRecordAuthor, readRecordAuthor, type MemoryAuthor } from '../../state/memory-author.js';
import { GatewayVerbError } from './gateway-verb-error.js';
import { readInvocationParams, requireString } from './invocation-params.js';
import { attachHandler } from './attach-handler.js';
import type { SkillFrontmatterValue } from '../../skills/index.js';
import { SkillService, SkillServiceError } from '../../skills/index.js';

/** The subset of SkillService the verb handlers need. */
export type SkillsGatewayService = Pick<SkillService, 'list' | 'get' | 'create' | 'update' | 'delete'>;

const ERROR_STATUS: Readonly<Record<string, number>> = {
  INVALID_ARGUMENT: 400,
  NOT_FOUND: 404,
  ALREADY_EXISTS: 409,
};

function rethrowAsVerbError(error: unknown): never {
  if (error instanceof SkillServiceError) {
    throw new GatewayVerbError(error.message, error.code, ERROR_STATUS[error.code] ?? 400);
  }
  throw error;
}


/** Coerce an untyped wire value into the frontmatter metadata shape (string / string[] values only). */
function readMetadata(value: unknown): Readonly<Record<string, SkillFrontmatterValue>> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new GatewayVerbError('metadata must be an object', 'INVALID_ARGUMENT', 400, 'metadata');
  }
  const out: Record<string, SkillFrontmatterValue> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === 'string') {
      out[key] = raw;
    } else if (Array.isArray(raw) && raw.every((item) => typeof item === 'string')) {
      out[key] = raw as string[];
    } else {
      throw new GatewayVerbError(`metadata.${key} must be a string or string array`, 'INVALID_ARGUMENT', 400, `metadata.${key}`);
    }
  }
  return out;
}

export type SkillsGatewayServiceResolver = SkillsGatewayService | ((project: string | undefined) => SkillsGatewayService);

function resolveSkillsService(resolver: SkillsGatewayServiceResolver, invocation: GatewayMethodInvocation, params?: Record<string, unknown>): SkillsGatewayService {
  if (typeof resolver !== 'function') return resolver;
  const rawProject = invocation.context.call?.project
    ?? (typeof params?.['workingDirectory'] === 'string' && params['workingDirectory'].trim() ? params['workingDirectory'].trim() : undefined);
  return resolver(rawProject);
}

function createSkillsListHandler(resolver: SkillsGatewayServiceResolver): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    return { skills: await resolveSkillsService(resolver, invocation, params).list() };
  };
}

function createSkillsGetHandler(resolver: SkillsGatewayServiceResolver): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    const name = requireString(params, 'name');
    try {
      return { skill: await resolveSkillsService(resolver, invocation, params).get(name) };
    } catch (error) {
      rethrowAsVerbError(error);
    }
  };
}

/** The frontmatter keys that say who wrote a skill (skills/library.ts): kept by the daemon, never taken from a body. */
const AUTHOR_KEYS = ['author', 'author-who', 'author-accepted-at'] as const;
/** The marks only the owner's own review sets: reviewed, when, and switched on. */
const REVIEW_KEYS = ['review', 'reviewed-at', 'enabled'] as const;

/**
 * Who writes through this call (state/memory-author.ts), from the credential the daemon checked: the owner's own press
 * (method-owner-decision.ts `ownersOwnPress`), the owner's model (the Agent's credential for the owner), or anyone else, named.
 */
function writerOf(invocation: GatewayMethodInvocation): MemoryAuthor {
  const actor = invocation.context.actor;
  // The owner's signed-in session is their press on every request; elsewhere, a person's claim in their own program.
  const press = ownersOwnPress({
    actor, credentialKind: invocation.context.credentialKind ?? undefined, registration: invocation.context.call?.registration,
    personAsked: invocation.context.metadata?.['explicitUserRequest'] === true,
  });
  if (press) return { kind: 'owner' };
  // The owner's model, by who calls (method-owner-decision.ts): their Agent program (its credential with its registration, or a
  // turn the daemon hosts), or their registered terminal program with no person's press. The Agent's credential alone is
  // a script, named below.
  const caller = { actor, credentialKind: invocation.context.credentialKind ?? undefined, registration: invocation.context.call?.registration,
    daemonHosted: invocation.context.call?.daemonHosted === true };
  // Their registered program or their own command line (method-owner-decision.ts `makesOwnerOnlyAct`, the one test).
  // Any credential of the user without a press writes as their program does (their model's words); never someone else's.
  if (ownersAgentProgram(caller) || makesOwnerOnlyAct(caller)) return { kind: 'owner-model' };
  return { kind: 'other', who: `a caller that is not the user (${actor ? `${actor.class} ${actor.id}` : 'not named'})` };
}

/**
 * The frontmatter a skills.* write keeps: the caller's own keys, never an author it claims, and the review marks only
 * when the owner in person writes; the author is who writes it (a change by someone else makes it that caller's words, waiting).
 */
function keptMetadata(
  given: Readonly<Record<string, SkillFrontmatterValue>> | undefined,
  existing: Readonly<Record<string, SkillFrontmatterValue>> | undefined,
  by: MemoryAuthor,
): Record<string, SkillFrontmatterValue> {
  const out: Record<string, SkillFrontmatterValue> = { ...(given ?? existing ?? {}) };
  for (const key of AUTHOR_KEYS) delete out[key];
  if (by.kind !== 'owner') for (const key of REVIEW_KEYS) if (given !== undefined) delete out[key];
  const scalar = (value: SkillFrontmatterValue | undefined): string => typeof value === 'string' ? value.trim() : '';
  const before = existing === undefined || existing['author'] === undefined ? undefined : readRecordAuthor({
    kind: scalar(existing['author']), ...(scalar(existing['author-who']) ? { who: scalar(existing['author-who']) } : {}),
    ...(scalar(existing['author-accepted-at']) ? { acceptedAt: Number(scalar(existing['author-accepted-at'])) } : {}),
  });
  const author = existing === undefined ? newRecordAuthor(by) : authorAfterChange(before, by, Date.now());
  if (author !== undefined) {
    out['author'] = author.kind;
    if (author.who) out['author-who'] = author.who.replace(/\s+/g, ' ').trim();
    if (author.acceptedAt !== undefined) out['author-accepted-at'] = String(author.acceptedAt);
  }
  return out;
}

function createSkillsCreateHandler(resolver: SkillsGatewayServiceResolver): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    try {
      const skill = await resolveSkillsService(resolver, invocation, params).create({
        name: requireString(params, 'name'),
        description: requireString(params, 'description'),
        body: typeof params.body === 'string' ? params.body : '',
        metadata: keptMetadata(readMetadata(params.metadata), undefined, writerOf(invocation)),
      });
      return { skill };
    } catch (error) {
      rethrowAsVerbError(error);
    }
  };
}

function createSkillsUpdateHandler(resolver: SkillsGatewayServiceResolver): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    const name = requireString(params, 'name');
    try {
      const service = resolveSkillsService(resolver, invocation, params);
      const existing = await service.get(name);
      const skill = await service.update(name, {
        description: typeof params.description === 'string' ? params.description : undefined,
        body: typeof params.body === 'string' ? params.body : undefined,
        metadata: keptMetadata(readMetadata(params.metadata), existing.metadata, writerOf(invocation)),
      });
      return { skill };
    } catch (error) {
      rethrowAsVerbError(error);
    }
  };
}

function createSkillsDeleteHandler(resolver: SkillsGatewayServiceResolver): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    const name = requireString(params, 'name');
    try {
      return await resolveSkillsService(resolver, invocation, params).delete(name);
    } catch (error) {
      rethrowAsVerbError(error);
    }
  };
}

/**
 * Attach the skills.* handlers to the descriptors already registered (without a
 * handler) from ../method-catalog-skills.ts. A missing descriptor is logged and
 * skipped: construction never fails because a wire verb failed to register.
 */
export function registerSkillsGatewayMethods(catalog: GatewayMethodCatalog, service: SkillsGatewayServiceResolver): void {
  attachHandler(catalog, 'skills.list', createSkillsListHandler(service));
  attachHandler(catalog, 'skills.get', createSkillsGetHandler(service));
  attachHandler(catalog, 'skills.create', createSkillsCreateHandler(service));
  attachHandler(catalog, 'skills.update', createSkillsUpdateHandler(service));
  attachHandler(catalog, 'skills.delete', createSkillsDeleteHandler(service));
}
