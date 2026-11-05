import { resolve } from 'node:path';
import { types as nodeTypes } from 'node:util';
import { canonicalJson } from '@goodvibes-jev/judgment';
import { captureJsonValue, captureOwnedJson } from '../../gate/judgment-input.js';
import { isInvocationAdmitted } from '../../gate/execution-context.js';
import type { AppendProfileProseInput, ForgetProfileInput, SetProfileFieldInput, UndoProfileInput } from '../../owner-profile/store-types.js';
import type { OccasionProfileMutation } from '../../occasions/capture.js';
import type { GatewayMethodCatalog } from '../method-catalog.js';
import type { GatewayMethodHandler, GatewayMethodInvocation } from '../method-catalog-shared.js';
import { normalizeContext } from '../host-handlers.js';
import { requestsNativeAdmission, retainNativeMutationRequest, runNativeMutation, type NativeMutationHost } from '../native-mutation.js';
import { bindProfileDelegationToInvocation, captureNativeProfileDelegation, profileDelegationForInvocation, profileMutationOptionsForInvocation, readProfileAdmittedInvocation, readProfileDelegation, type ProfileMutationOptions, type RecordedProfileDelegation, type RecordedProfileMutation } from '../../owner-profile/delegation.js';
import type { OccasionMutationOptions } from '../../occasions/operation.js';
import { readStoppedNativeNudge } from '../../occasions/push.js';
import { captureFileMutation, captureMutationDescriptors } from '../../utils/file-mutation.js';
import { GatewayVerbError } from './gateway-verb-error.js';
import { readInvocationParams } from './invocation-params.js';

export interface NativeProfileTarget {
  readonly profilePath: string;
  readonly statePath?: string | undefined;
  readonly captureProfileRead: () => { readonly assertCurrent: () => void };
  readonly captureStateRead?: (() => { readonly assertCurrent: () => void }) | undefined;
  readonly assertOwnerCurrent: () => void;
  readonly projectProfileMutation?: ((method: string, request: Readonly<Record<string, unknown>>) => OccasionProfileMutation | undefined) | undefined;
}
type NativeProfileOptions = OccasionMutationOptions;
type NativeNudgeDelivery = NonNullable<OccasionMutationOptions['withNudgeDelivery']>;
// These are native nudge producer identities, never caller-authored message
// text. Keep their exact lossless identity without PAN-shaped protocol clocks.
const nativeNudgeIdentity = (value: string) => `native-id:${Buffer.from(value).toString('hex').replace(/[0-9a-f]/g, digit =>
  String.fromCharCode(97 + Number.parseInt(digit, 16)))}`;
const mutationOptions = new WeakMap<object, NativeProfileOptions>();
const targets = new WeakMap<GatewayMethodCatalog, ReadonlyMap<string, NativeProfileTarget>>();

/** Only the actual registrar publishes these native owner descriptors. */
export function registerNativeProfileTargets(catalog: GatewayMethodCatalog, methods: readonly string[], target: NativeProfileTarget): void {
  const next = new Map(targets.get(catalog));
  for (const method of methods) next.set(method, target);
  targets.set(catalog, next);
}
export function captureOccasionsGatewayTarget(catalog: GatewayMethodCatalog, method: string): NativeProfileTarget | undefined {
  const target = targets.get(catalog)?.get(method);
  target?.assertOwnerCurrent();
  return target;
}

export function profileMutationOptions(invocation: GatewayMethodInvocation, scopes?: readonly string[]): NativeProfileOptions {
  const retained = mutationOptions.get(invocation) ?? profileMutationOptionsForInvocation(invocation);
  const signal = invocation.signal && retained?.signal ? AbortSignal.any([invocation.signal, retained.signal]) : invocation.signal ?? retained?.signal;
  return { ...retained, signal, delegation: profileDelegationForInvocation(invocation), assertCurrent: () => {
    signal?.throwIfAborted();
    if (invocation.isAuthorized?.(scopes) === false) throw new Error('Profile request is no longer authorized.');
    retained?.assertCurrent?.();
  } };
}

/** Selects fresh server admission. The original human protocol remains independently enforced. */
export function nativeProfileMutation(catalog: GatewayMethodCatalog, method: string, handler: GatewayMethodHandler,
  host: NativeMutationHost | undefined, target: NativeProfileTarget | undefined, provenance = true): GatewayMethodHandler {
  return async invocation => {
    if (!requestsNativeAdmission(invocation.body)) {
      const delegation = profileDelegationForInvocation(invocation);
      const retained = profileMutationOptionsForInvocation(invocation);
      if (delegation && retained && target && targets.get(catalog)?.get(method) === target) {
        const requestCurrent = retainNativeMutationRequest({ body: invocation.body ?? null, query: invocation.query ?? null });
        const targetCurrent = captureMutationDescriptors(target, ['profilePath', 'captureProfileRead', 'assertOwnerCurrent', 'projectProfileMutation']);
        const profileRead = target.captureProfileRead();
        const profileFile = captureFileMutation(target.profilePath);
        let publishing = false;
        const current = () => {
          if (targets.get(catalog)?.get(method) !== target) throw new Error('Native profile target changed.');
          requestCurrent(); targetCurrent(); target.assertOwnerCurrent(); retained.signal?.throwIfAborted(); retained.assertCurrent?.();
          if (!publishing) profileRead.assertCurrent();
          profileFile.assertCurrent();
        };
        const lifetime: ProfileMutationOptions = { ...retained, delegation, assertCurrent: current,
          onWriteIntent: () => { current(); retained.onWriteIntent?.(); publishing = true; current(); },
          onEffect: published => { retained.onEffect?.(published); profileFile.onEffect(published); requestCurrent(); targetCurrent(); target.assertOwnerCurrent(); },
        };
        const admittedMutation = captureProfileMutationAdmission(delegation, invocation, method, target, lifetime);
        mutationOptions.set(invocation, { ...lifetime, admittedMutation });
        try { return await handler(invocation); }
        finally { mutationOptions.delete(invocation); }
      }
      return handler(invocation);
    }
    const sourceCurrent = retainNativeMutationRequest({ body: invocation.body ?? null, query: invocation.query ?? null, context: invocation.context });
    sourceCurrent();
    const body = invocation.body;
    if (provenance && (!body || typeof body !== 'object' || !('authority' in body) || body.authority !== 'autonomous'
      || ('said' in body && body.said !== ''))) {
      throw new GatewayVerbError('Native autonomous provenance requires authority autonomous and no claimed human quote.', 'INVALID_ARGUMENT', 400);
    }
    if (!target || targets.get(catalog)?.get(method) !== target) throw new GatewayVerbError('Native profile target is unavailable.', 'NATIVE_MUTATION_FORBIDDEN', 403);
    const descriptor = catalog.get(method);
    const invocationCurrent = captureMutationDescriptors(invocation, ['body', 'query', 'context', 'signal', 'isAuthorized', 'nativeExecutionAuthority']);
    const ownerCurrent = captureMutationDescriptors(target, ['profilePath', 'statePath', 'captureProfileRead', 'captureStateRead', 'assertOwnerCurrent', 'projectProfileMutation']);
    const profileRead = target.captureProfileRead();
    const profileFile = captureFileMutation(target.profilePath);
    const stateRead = target.captureStateRead?.();
    const stateFile = target.statePath ? captureFileMutation(target.statePath) : undefined;
    let profileIntent = false, stateIntent = false;
    const assertTargetCurrent = () => {
      if (targets.get(catalog)?.get(method) !== target) throw new Error('Native profile target changed.');
      sourceCurrent(); invocationCurrent(); ownerCurrent(); target.assertOwnerCurrent();
      if (catalog.get(method) !== descriptor) throw new Error('Native profile method changed.');
      if (!profileIntent) profileRead.assertCurrent();
      if (!stateIntent) stateRead?.assertCurrent();
      profileFile.assertCurrent(); stateFile?.assertCurrent();
    };
    return runNativeMutation({ host, method, invocation, body: { admission: 'autonomous', body: invocation.body ?? null, query: invocation.query ?? null },
      context: { ...normalizeContext(invocation.context), signal: invocation.signal,
        nativeExecutionAuthority: invocation.nativeExecutionAuthority, isAuthorized: invocation.isAuthorized },
      target: { domain: 'owner-profile', method }, assertTargetCurrent,
      scopes: descriptor?.scopes ?? [], confirmation: 'none', mutate: async (assertCurrent, admission, withPublication) => {
        if (!admission) throw new Error('Recorded native profile admission is unavailable.');
        const delegation = captureNativeProfileDelegation(admission, invocation);
        bindProfileDelegationToInvocation(delegation, invocation);
        const lifetime: NativeProfileOptions = { assertCurrent, delegation, withPublication,
          onWriteIntent: () => { assertCurrent(); profileIntent = true; },
          onEffect: published => { sourceCurrent(); invocationCurrent(); target.assertOwnerCurrent(); profileFile.onEffect(published); stateFile?.onEffect(); },
          onStateWriteIntent: () => { assertCurrent(); stateIntent = true; },
          onStateEffect: published => { sourceCurrent(); invocationCurrent(); target.assertOwnerCurrent(); stateFile?.onEffect(published); profileFile.onEffect(); },
          ...(method === 'occasions.sweep' ? { withNudgeDelivery: async (request: Parameters<NativeNudgeDelivery>[0], operation: Parameters<NativeNudgeDelivery>[1]) => {
            assertCurrent();
            const deliveryCurrent = retainNativeMutationRequest(request);
            const nudgeMeaning = { ...request.nudge, id: nativeNudgeIdentity(request.nudge.id),
              raisedAt: new Date(request.nudge.raisedAt).toISOString(),
              subjects: request.nudge.subjects.map(subject => ({ ...subject, occasionId: nativeNudgeIdentity(subject.occasionId) })) };
            return runNativeMutation({ host, method: 'occasions.sweep.deliver', invocation,
              body: { admission: 'autonomous', parent: { body: invocation.body ?? null, query: invocation.query ?? null },
                delivery: { channel: request.channel, nudge: nudgeMeaning } },
              context: { ...normalizeContext(invocation.context), signal: invocation.signal,
                nativeExecutionAuthority: invocation.nativeExecutionAuthority, isAuthorized: invocation.isAuthorized },
              target: { domain: 'occasion-nudge', channel: request.channel, nudge: nudgeMeaning },
              assertTargetCurrent: () => { assertCurrent(); deliveryCurrent(); }, scopes: descriptor?.scopes ?? [],
              confirmation: 'none', effect: 'send', mutate: async (sendCurrent, _sendAdmission, withDeliveryPublication) => operation({
                signal: AbortSignal.any([...(host ? [host.signal] : []), ...(invocation.signal ? [invocation.signal] : [])]),
                assertCurrent: () => { assertCurrent(); sendCurrent(); },
                withPublication: withDeliveryPublication,
              }) });
          } } : {}),
        };
        const admittedMutation = captureProfileMutationAdmission(delegation, invocation, method, target, lifetime);
        mutationOptions.set(invocation, { ...lifetime, admittedMutation });
        try { return await handler(invocation); }
        catch (error) {
          const delivery = mutationOptions.get(invocation)?.withNudgeDelivery;
          const receipt = delivery ? readStoppedNativeNudge(error, delivery) : undefined;
          if (receipt) return receipt;
          throw error;
        }
        finally { mutationOptions.delete(invocation); }
      } });
  };
}

type ProfileMethod = 'profile.set' | 'profile.append' | 'profile.forget' | 'profile.undo';
type ProfileInput = SetProfileFieldInput | AppendProfileProseInput | ForgetProfileInput | UndoProfileInput;
const mutations = new WeakMap<RecordedProfileMutation, {
  readonly method: ProfileMethod;
  readonly path: string;
  readonly payload: string;
  readonly options: ProfileMutationOptions;
  consumed: boolean;
}>();

function payload(method: ProfileMethod, input: object): string {
  captureOwnedJson(input, nodeTypes.isProxy);
  const read = (key: string): unknown => Object.getOwnPropertyDescriptor(input, key)?.value;
  const keys = method === 'profile.set' ? ['fieldId', 'value', 'authority', 'said', 'surface', 'date']
    : method === 'profile.append' ? ['section', 'text', 'authority', 'said', 'surface', 'date']
      : method === 'profile.forget' ? ['fieldId', 'section', 'text', 'lineIndex', 'authority']
        : ['fieldId', 'authority'];
  return canonicalJson(captureJsonValue(Object.fromEntries(keys.map(key => [key, read(key)]))));
}

function toolRequest(name: 'profile' | 'occasions', args: Record<string, unknown>): { readonly method: string; readonly input: object } | undefined {
  const text = (key: string): string => typeof args[key] === 'string' ? args[key].trim() : '';
  const action = text('action') || text('mode');
  const authority = !text('authority') || text('authority') === 'owner-direct' ? 'autonomous' : text('authority');
  const identity = { authority, said: authority === 'autonomous' ? '' : text('said'), surface: 'agent' };
  const fieldId = text('fieldId') || text('field');
  if (name === 'occasions') {
    if (action === 'confirm') return { method: 'occasions.confirm', input: { title: text('title'), date: text('date'), kind: text('kind'),
      ...(text('person') ? { person: text('person') } : {}), ...(text('recurrence') ? { recurrence: text('recurrence') } : {}),
      ...(typeof args.leadDays === 'number' ? { leadDays: args.leadDays } : {}), ...identity } };
    if (action === 'plan_confirm') return { method: 'occasions.plans.confirm', input: { title: text('title'), from: text('from'), to: text('to'),
      ...(args.away === undefined ? {} : { away: args.away === true }), ...(text('destination') ? { destination: text('destination') } : {}), ...identity } };
    if (action === 'remove') return { method: 'occasions.remove', input: { occasionId: text('occasionId'), confirmed: args.confirmed === true, authority } };
    return undefined;
  }
  if (action === 'set') return { method: 'profile.set', input: { fieldId, value: text('value'), ...identity } };
  if (action === 'append') return { method: 'profile.append', input: { section: text('section'), text: text('text'), ...identity } };
  if (action === 'forget') return { method: 'profile.forget', input: fieldId ? { fieldId, authority } : { section: text('section'), text: text('text'), authority } };
  if (action === 'undo') return { method: 'profile.undo', input: { fieldId, authority } };
  return undefined;
}

/** The actual native registrar binds an exact admitted request to its selected file owner. */
function captureProfileMutationAdmission(
  delegation: RecordedProfileDelegation,
  invocation: GatewayMethodInvocation,
  method: string,
  target: NativeProfileTarget,
  lifetime: ProfileMutationOptions,
): RecordedProfileMutation | undefined {
  const input = readInvocationParams(invocation);
  const source = readProfileAdmittedInvocation(delegation);
  const current = readProfileDelegation(delegation);
  if (!source || !current) return undefined;
  if (source.kind === 'native') {
    if (source.invocation !== invocation || source.method !== method) return undefined;
  } else {
    if (!isInvocationAdmitted(source.name, source.args)) return undefined;
    const expected = toolRequest(source.name, source.args);
    if (!expected || expected.method !== method) return undefined;
    if (method === 'profile.set' || method === 'profile.append' || method === 'profile.forget' || method === 'profile.undo') {
      if (payload(method, expected.input) !== payload(method, input)) return undefined;
    } else if (canonicalJson(captureJsonValue(expected.input)) !== canonicalJson(captureJsonValue(input))) return undefined;
  }
  const assertCurrent = () => { current.assertCurrent(); lifetime.signal?.throwIfAborted(); lifetime.assertCurrent?.(); };
  assertCurrent();
  const effect: { readonly method: ProfileMethod; readonly input: object } | undefined = method === 'profile.set' || method === 'profile.append' || method === 'profile.forget' || method === 'profile.undo'
    ? { method, input } : target.projectProfileMutation?.(method, input);
  if (!effect) return undefined;
  const captured = payload(effect.method, effect.input);
  assertCurrent();
  const token: RecordedProfileMutation = Object.freeze({ kind: 'recorded-profile-mutation' });
  mutations.set(token, { method: effect.method, path: resolve(target.profilePath), payload: captured, options: Object.freeze({ ...lifetime, delegation, assertCurrent }), consumed: false });
  return token;
}

/** Consume once for the actual store, target, operation and complete effect payload. */
export function consumeProfileMutationAdmission(token: RecordedProfileMutation | undefined,
  method: ProfileMethod, path: string, input: ProfileInput): ProfileMutationOptions | undefined {
  if (!token) return undefined;
  const mutation = mutations.get(token);
  if (!mutation || mutation.consumed) throw new Error('Unknown or consumed profile mutation admission.');
  mutation.options.assertCurrent?.();
  if (mutation.method !== method || mutation.path !== resolve(path) || mutation.payload !== payload(method, input)) {
    throw new Error('Profile mutation does not match the admitted effect.');
  }
  mutation.consumed = true;
  const assertCurrent = () => {
    mutation.options.signal?.throwIfAborted();
    mutation.options.assertCurrent?.();
    if (mutation.payload !== payload(method, input)) throw new Error('Profile mutation input changed after admission.');
  };
  return Object.freeze({ ...mutation.options, assertCurrent });
}
