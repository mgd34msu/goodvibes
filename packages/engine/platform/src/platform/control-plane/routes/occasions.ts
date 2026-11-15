/**
 * routes/occasions.ts
 *
 * Handlers for the `occasions.*` gateway verbs over `OccasionsService`
 * (../../occasions/service.js). Thin verb registration in the same shape as
 * routes/owner-profile.ts: read the invocation params, call the service, answer.
 *
 * ## Every rule lives below this file
 *
 * Nothing here decides anything. The kind is not defaulted here, the nudge is
 * not composed here, quiet hours are not evaluated here, and no date is
 * formatted here. That is the point: a surface calls a verb and renders the
 * answer, and this layer is the only thing between the two. A rule implemented
 * in a route is a rule the next transport gets wrong.
 *
 * ## The two writes that touch the owner's file
 *
 * `occasions.confirm` and `occasions.plans.confirm` append a line to the owner
 * profile, `occasions.remove` and `occasions.plans.remove` delete one, and
 * `occasions.update` and `occasions.plans.update` rewrite one. Each takes
 * `authority` as a required body parameter and goes through `OwnerProfileStore`,
 * which runs the profile's own write gate before a line lands.
 * `refuseNonUserRequest` runs first on each, for the same reason it does on
 * `profile.set`: "you told
 * me this was not a user request" deserves its own answer rather than being
 * folded into a trust refusal naming a surface the caller never claimed.
 */
import type { GatewayMethodCatalog } from '../method-catalog.js';
import type { GatewayMethodHandler, GatewayMethodInvocation } from '../method-catalog-shared.js';
import { GatewayVerbError } from './gateway-verb-error.js';
import { readInvocationParams, requireStringValue } from './invocation-params.js';
import { attachHandler } from './attach-handler.js';
import { refuseNonUserRequest } from './explicit-user-request.js';
import type { AuthoritySurface } from '../../security/untrusted-content.js';
import { isProfileSurface, type ProfileSurface } from '../../owner-profile/index.js';
import {
  OCCASION_ACK_SOURCES,
  OCCASION_ANSWERS,
  isOccasionAckSource,
  isOccasionAnswer,
  type OccasionAckSource,
  type OccasionAnswer,
} from '../../occasions/types.js';
import type { OccasionsService } from '../../occasions/service.js';
import { profileDelegationForInvocation } from '../../owner-profile/delegation.js';
import { nativeProfileMutation, profileMutationOptions, registerNativeProfileTargets, type NativeProfileTarget } from './native-profile-mutation.js';
import type { NativeMutationHost } from '../native-mutation.js';

/** The surface of the service these verbs need. */
export type OccasionsGatewayService = Pick<
  OccasionsService,
  | 'list'
  | 'listPlans'
  | 'proposeOccasion'
  | 'confirmOccasion'
  | 'proposePlan'
  | 'confirmPlan'
  | 'removeOccasion'
  | 'updateOccasion'
  | 'updatePlan'
  | 'removePlan'
  | 'answer'
  | 'acknowledge'
  | 'interview'
  | 'answerInterview'
  | 'recordGiftOutcome'
  | 'giftHistory'
  | 'pending'
  | 'sweep'
  | 'resolveConflict'
  | 'disclose'
>;

const AUTHORITY_SURFACES: readonly AuthoritySurface[] = [
  'owner-direct',
  'web-page',
  'email',
  'channel-message',
  'document',
];

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** `self: true` says the date is the owner's own; anything else is left out. */
function readSelf(value: unknown): { readonly self?: true } {
  if (value === undefined || value === false) return {};
  if (value === true) return { self: true };
  throw new GatewayVerbError('self must be true or false', 'INVALID_ARGUMENT', 400, 'self');
}

/** A plan's details, one per entry, exactly as the owner gave them. */
function readDetails(value: unknown): { readonly details?: readonly string[] } {
  if (value === undefined) return {};
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new GatewayVerbError('details must be a list of strings, one detail each', 'INVALID_ARGUMENT', 400, 'details');
  }
  return value.length === 0 ? {} : { details: value as string[] };
}

/**
 * The authority the caller claims. REQUIRED, and never defaulted.
 *
 * Same reasoning as `routes/owner-profile.ts`: it is a body parameter of these
 * verbs rather than a transport-populated context field, so requiring it costs
 * one word and closes the case where omitting it granted the one tier that
 * carries write authority. A removal with no authority at all would otherwise
 * be a delete with no gate.
 */
function readAuthority(value: unknown, invocation: GatewayMethodInvocation): AuthoritySurface | 'autonomous' {
  if (value === 'autonomous' && profileDelegationForInvocation(invocation)) return 'autonomous';
  if (typeof value !== 'string' || !(AUTHORITY_SURFACES as readonly string[]).includes(value)) {
    throw new GatewayVerbError(
      `authority is required and must be one of ${AUTHORITY_SURFACES.join(', ')}`,
      'INVALID_ARGUMENT',
      400,
      'authority',
    );
  }
  return value as AuthoritySurface;
}

function readSaid(value: unknown, authority: unknown, invocation: GatewayMethodInvocation): string {
  if (authority === 'autonomous' && profileDelegationForInvocation(invocation)) return '';
  return requireStringValue(value, 'said', { verbatim: true });
}

function readSurface(value: unknown): ProfileSurface {
  const surface = requireStringValue(value, 'surface');
  if (!isProfileSurface(surface)) {
    throw new GatewayVerbError(
      'surface must be one of tui, agent, webui, voice, hand-edit',
      'INVALID_ARGUMENT',
      400,
      'surface',
    );
  }
  return surface;
}

/**
 * Where an acknowledgement came from, defaulting to `explicit`.
 *
 * A verb call with no source IS a surface offering the action, which is what
 * `explicit` means, so this defaults rather than refusing. Refusing would make
 * the provenance label, which only explains a mute, capable of preventing one.
 */
function readAckSource(value: unknown): OccasionAckSource {
  const source = optionalString(value);
  if (source === undefined) return 'explicit';
  if (!isOccasionAckSource(source)) {
    throw new GatewayVerbError(
      `source must be one of ${OCCASION_ACK_SOURCES.join(', ')}`,
      'INVALID_ARGUMENT',
      400,
      'source',
    );
  }
  return source;
}

/**
 * The answer, checked against the ones the owner can give.
 *
 * `later` is one of them and is not a decline, a caller that sends anything
 * else is refused rather than folded into `no`, because reading an unknown word
 * as a refusal would silence an occasion the owner never declined.
 */
function readAnswer(value: unknown): OccasionAnswer {
  const answer = requireStringValue(value, 'answer');
  if (!isOccasionAnswer(answer)) {
    throw new GatewayVerbError(
      `answer must be one of ${OCCASION_ANSWERS.join(', ')}`,
      'INVALID_ARGUMENT',
      400,
      'answer',
    );
  }
  return answer;
}

function interviewAnswer(progress: unknown): { present: boolean; interview: unknown } {
  return { present: progress !== null, interview: progress };
}

export function registerOccasionsGatewayMethods(
  catalog: GatewayMethodCatalog,
  service: OccasionsGatewayService,
  native?: { readonly host?: NativeMutationHost | undefined; readonly target: NativeProfileTarget } | undefined,
): void {
  const profileMethods = ['occasions.confirm', 'occasions.plans.confirm', 'occasions.remove', 'occasions.conflict.resolve',
    'occasions.update', 'occasions.plans.update', 'occasions.plans.remove'];
  const nativeMethods = [...profileMethods, 'occasions.answer', 'occasions.acknowledge', 'occasions.interview.answer',
    'occasions.interview.record', 'occasions.sweep'];
  const attach = (id: string, handler: GatewayMethodHandler): void => {
    attachHandler(catalog, id, nativeMethods.includes(id) ? nativeProfileMutation(catalog, id, handler, native?.host, native?.target, profileMethods.includes(id)) : handler);
  };
  if (native) registerNativeProfileTargets(catalog, [...nativeMethods, 'occasions.list', 'occasions.plans.list', 'occasions.state',
    'occasions.pending', 'occasions.interview.get', 'occasions.gifts'], native.target);

  attach('occasions.list', invocation => service.list(readingOptions(invocation, catalog.get('occasions.list')?.scopes)));
  attach('occasions.plans.list', invocation => { readingOptions(invocation, catalog.get('occasions.plans.list')?.scopes).assertCurrent?.(); return service.listPlans(); });
  attach('occasions.state', invocation => service.disclose(readingOptions(invocation, catalog.get('occasions.state')?.scopes)));
  attach('occasions.pending', invocation => service.pending(readingOptions(invocation, catalog.get('occasions.pending')?.scopes)));
  attach('occasions.sweep', invocation => service.sweep(readingOptions(invocation, catalog.get('occasions.sweep')?.scopes)));

  attach('occasions.propose', (invocation: GatewayMethodInvocation) => {
    const params = readInvocationParams(invocation);
    return service.proposeOccasion({
      title: requireStringValue(params.title, 'title'),
      date: requireStringValue(params.date, 'date'),
      ...(optionalString(params.kind) === undefined ? {} : { kind: optionalString(params.kind) }),
      ...(optionalString(params.person) === undefined ? {} : { person: optionalString(params.person) }),
      ...(optionalString(params.recurrence) === undefined ? {} : { recurrence: optionalString(params.recurrence) }),
      ...(optionalNumber(params.leadDays) === undefined ? {} : { leadDays: optionalNumber(params.leadDays) }),
      ...readSelf(params.self),
    });
  });

  attach('occasions.confirm', (invocation: GatewayMethodInvocation) => {
    if (!profileDelegationForInvocation(invocation)) refuseNonUserRequest(invocation, 'occasions.confirm');
    const params = readInvocationParams(invocation);
    return service.confirmOccasion({
      title: requireStringValue(params.title, 'title'),
      date: requireStringValue(params.date, 'date'),
      kind: requireStringValue(params.kind, 'kind'),
      ...(optionalString(params.person) === undefined ? {} : { person: optionalString(params.person) }),
      ...(optionalString(params.recurrence) === undefined ? {} : { recurrence: optionalString(params.recurrence) }),
      ...(optionalNumber(params.leadDays) === undefined ? {} : { leadDays: optionalNumber(params.leadDays) }),
      ...readSelf(params.self),
      surface: readSurface(params.surface),
      said: readSaid(params.said, params.authority, invocation),
      authority: readAuthority(params.authority, invocation),
    }, readingOptions(invocation, catalog.get('occasions.confirm')?.scopes));
  });

  attach('occasions.remove', (invocation: GatewayMethodInvocation) => {
    if (!profileDelegationForInvocation(invocation)) refuseNonUserRequest(invocation, 'occasions.remove');
    const params = readInvocationParams(invocation);
    return service.removeOccasion({
      occasionId: requireStringValue(params.occasionId, 'occasionId'),
      confirmed: params.confirmed === true,
      authority: readAuthority(params.authority, invocation),
    }, readingOptions(invocation, catalog.get('occasions.remove')?.scopes));
  });

  attach('occasions.update', (invocation: GatewayMethodInvocation) => {
    if (!profileDelegationForInvocation(invocation)) refuseNonUserRequest(invocation, 'occasions.update');
    const params = readInvocationParams(invocation);
    return service.updateOccasion({
      occasionId: requireStringValue(params.occasionId, 'occasionId'),
      title: optionalString(params.title),
      date: optionalString(params.date),
      kind: optionalString(params.kind),
      person: optionalString(params.person),
      recurrence: optionalString(params.recurrence),
      leadDays: params.leadDays === null ? null : optionalNumber(params.leadDays),
      self: typeof params.self === 'boolean' ? params.self : undefined,
      confirmed: params.confirmed === true,
      surface: readSurface(params.surface),
      said: readSaid(params.said, params.authority, invocation),
      authority: readAuthority(params.authority, invocation),
    }, readingOptions(invocation, catalog.get('occasions.update')?.scopes));
  });

  attach('occasions.answer', (invocation: GatewayMethodInvocation) => {
    const params = readInvocationParams(invocation);
    return service.answer({
      occasionId: requireStringValue(params.occasionId, 'occasionId'),
      answer: readAnswer(params.answer),
      ...(optionalString(params.occurrence) === undefined
        ? {}
        : { occurrence: optionalString(params.occurrence) }),
    }, readingOptions(invocation, catalog.get('occasions.answer')?.scopes));
  });

  attach('occasions.acknowledge', (invocation: GatewayMethodInvocation) => {
    const params = readInvocationParams(invocation);
    return service.acknowledge({
      occasionId: requireStringValue(params.occasionId, 'occasionId'),
      // A verb call is a surface offering the action, unless it says otherwise.
      source: readAckSource(params.source),
      ...(optionalString(params.occurrence) === undefined
        ? {}
        : { occurrence: optionalString(params.occurrence) }),
    }, readingOptions(invocation, catalog.get('occasions.acknowledge')?.scopes));
  });

  attach('occasions.interview.get', async (invocation: GatewayMethodInvocation) => {
    const params = readInvocationParams(invocation);
    return interviewAnswer(await service.interview(requireStringValue(params.interviewId, 'interviewId'), readingOptions(invocation, catalog.get('occasions.interview.get')?.scopes)));
  });

  attach('occasions.interview.answer', async (invocation: GatewayMethodInvocation) => {
    const params = readInvocationParams(invocation);
    return interviewAnswer(await service.answerInterview({
      interviewId: requireStringValue(params.interviewId, 'interviewId'),
      stepId: requireStringValue(params.stepId, 'stepId'),
      text: requireStringValue(params.text, 'text', { verbatim: true }),
    }, readingOptions(invocation, catalog.get('occasions.interview.answer')?.scopes)));
  });

  attach('occasions.interview.record', async (invocation: GatewayMethodInvocation) => {
    const params = readInvocationParams(invocation);
    return interviewAnswer(await service.recordGiftOutcome({
      interviewId: requireStringValue(params.interviewId, 'interviewId'),
      landedOn: requireStringValue(params.landedOn, 'landedOn'),
    }, readingOptions(invocation, catalog.get('occasions.interview.record')?.scopes)));
  });

  attach('occasions.gifts', async (invocation: GatewayMethodInvocation) => {
    const params = readInvocationParams(invocation);
    const occasionId = requireStringValue(params.occasionId, 'occasionId');
    return { occasionId, gifts: await service.giftHistory(occasionId, readingOptions(invocation, catalog.get('occasions.gifts')?.scopes)) };
  });

  attach('occasions.conflict.resolve', async (invocation: GatewayMethodInvocation) => {
    const params = readInvocationParams(invocation);
    const occasionId = requireStringValue(params.occasionId, 'occasionId');
    const keep = optionalString(params.keep);
    // Naming a date removes the other lines from the owner's profile, so it is
    // a profile write with the same admission as a removal. Without one, the
    // call changes nothing and answers with the dates to choose from.
    if (keep !== undefined && !profileDelegationForInvocation(invocation)) refuseNonUserRequest(invocation, 'occasions.conflict.resolve');
    return service.resolveConflict({
      occasionId,
      ...(keep === undefined ? {} : { keep, authority: readAuthority(params.authority, invocation) }),
    }, readingOptions(invocation, catalog.get('occasions.conflict.resolve')?.scopes));
  });

  attach('occasions.plans.propose', (invocation: GatewayMethodInvocation) => {
    const params = readInvocationParams(invocation);
    return service.proposePlan({
      title: requireStringValue(params.title, 'title'),
      from: requireStringValue(params.from, 'from'),
      to: requireStringValue(params.to, 'to'),
      ...(params.away === undefined ? {} : { away: params.away === true }),
      ...(optionalString(params.destination) === undefined
        ? {}
        : { destination: optionalString(params.destination) }),
      ...readDetails(params.details),
    });
  });

  attach('occasions.plans.confirm', (invocation: GatewayMethodInvocation) => {
    if (!profileDelegationForInvocation(invocation)) refuseNonUserRequest(invocation, 'occasions.plans.confirm');
    const params = readInvocationParams(invocation);
    return service.confirmPlan({
      title: requireStringValue(params.title, 'title'),
      from: requireStringValue(params.from, 'from'),
      to: requireStringValue(params.to, 'to'),
      ...(params.away === undefined ? {} : { away: params.away === true }),
      ...(optionalString(params.destination) === undefined
        ? {}
        : { destination: optionalString(params.destination) }),
      ...readDetails(params.details),
      surface: readSurface(params.surface),
      said: readSaid(params.said, params.authority, invocation),
      authority: readAuthority(params.authority, invocation),
    }, readingOptions(invocation, catalog.get('occasions.plans.confirm')?.scopes));
  });

  attach('occasions.plans.update', (invocation: GatewayMethodInvocation) => {
    if (!profileDelegationForInvocation(invocation)) refuseNonUserRequest(invocation, 'occasions.plans.update');
    const params = readInvocationParams(invocation);
    return service.updatePlan({
      planId: requireStringValue(params.planId, 'planId'),
      planFrom: optionalString(params.planFrom),
      title: optionalString(params.title),
      from: optionalString(params.from),
      to: optionalString(params.to),
      away: typeof params.away === 'boolean' ? params.away : undefined,
      destination: optionalString(params.destination),
      ...readDetails(params.details),
      confirmed: params.confirmed === true,
      surface: readSurface(params.surface),
      said: readSaid(params.said, params.authority, invocation),
      authority: readAuthority(params.authority, invocation),
    }, readingOptions(invocation, catalog.get('occasions.plans.update')?.scopes));
  });

  attach('occasions.plans.remove', (invocation: GatewayMethodInvocation) => {
    if (!profileDelegationForInvocation(invocation)) refuseNonUserRequest(invocation, 'occasions.plans.remove');
    const params = readInvocationParams(invocation);
    return service.removePlan({
      planId: requireStringValue(params.planId, 'planId'),
      planFrom: optionalString(params.planFrom),
      confirmed: params.confirmed === true,
      authority: readAuthority(params.authority, invocation),
    }, readingOptions(invocation, catalog.get('occasions.plans.remove')?.scopes));
  });
}

/** Transport scope/lifetime restriction remains independent of semantic observations. */
function readingOptions(invocation: GatewayMethodInvocation, requiredScopes?: readonly string[]) {
  return profileMutationOptions(invocation, requiredScopes);
}
