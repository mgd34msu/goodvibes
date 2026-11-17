/**
 * profile-types.ts
 *
 * Response shapes for the owner-profile control-plane verbs (`profile.*`).
 *
 * ## The shapes come from the contract, not from a copy of it
 *
 * Every type below is derived from `OperatorMethodOutput<'profile.…'>`, the
 * types generated from the platform's own output schemas
 * (`platform/control-plane/method-catalog-owner-profile.ts`). Nothing here
 * restates a field name, so this file cannot drift from the contract.
 *
 * ## One runtime check, in the client
 *
 * The operator client validates every `profile.*` response against the verb's
 * output schema in the operator contract before `invoke` resolves, so a daemon
 * on a different version, or a 200 from something that is not this daemon,
 * fails there as a `ContractError` naming the verb and the field. A response
 * that reaches a renderer has the shape these types state; nothing here checks
 * it a second time.
 */
import type { OperatorMethodInput, OperatorMethodOutput } from '@goodvibes-jev/engine/platform';

/** The verbs this command calls. Typing the ids is what types the inputs. */
export type ProfileReadVerb = 'profile.read' | 'profile.provenance' | 'profile.status';
export type ProfileWriteVerb = 'profile.set' | 'profile.append' | 'profile.forget' | 'profile.undo';
export type ProfileVerb = ProfileReadVerb | ProfileWriteVerb;

/** The contract's own input shape for a verb, so a wrong field name will not compile. */
export type ProfileInput<TVerb extends ProfileVerb> = OperatorMethodInput<TVerb>;

/**
 * Every key of every member of a union. `keyof` on a union yields only the keys
 * the members SHARE, so a union target would be checked against that
 * intersection and would wave through a key belonging to a sibling verb.
 */
type UnionKeys<T> = T extends unknown ? keyof T : never;

/**
 * Reject a key the contract does not declare, including on a body that is not a
 * fresh object literal.
 *
 * DO NOT "simplify" this away to plain parameter typing. It is load-bearing,
 * not a belt-and-braces backstop, and the measurements say which cases it
 * carries alone. Four ways a stale key can arrive, all compiled against this
 * repo's TypeScript with a `profile.forget`-shaped input:
 *
 *   1. written inline in a fresh literal     , parameter typing already rejects
 *   2. written inline BESIDE a spread        , parameter typing already rejects
 *   3. body built as a variable first        , SLIPS PAST parameter typing
 *   4. carried in by the spread source's type, SLIPS PAST parameter typing
 *
 * A spread literal is not uniformly unchecked, which is the easy thing to get
 * wrong: anything written inline in one is still checked normally, and only what
 * arrives THROUGH the spread escapes, because it belongs to the source's type
 * rather than to the literal. Rows 3 and 4 are the two nothing else catches, and
 * this guard rejects both with TS2345, measured, not reasoned about.
 *
 * That is not hypothetical: `profile.forget` really did retire `lineIndex`, and
 * a body built one line earlier would have carried it silently past a correctly
 * typed parameter. Seeding inline literals proves only the cases someone thought
 * to seed; this closes the shape.
 *
 * There is a second reason it earns its place here. The platform's `invoke` is
 * OVERLOADED, a typed signature plus a loose
 * `invoke<T = unknown>(methodId: string, input?: Record<string, unknown>)`. At a
 * bare call site a body the typed overload rejects does not raise an
 * excess-property error at all; overload resolution simply falls through to the
 * loose one and the result degrades to `unknown`. Any error is then incidental,
 * downstream, and disappears entirely if the caller ignores or casts the result.
 * `ProfileInvoke` is a single generic signature with no such fallback, so a bad
 * body fails here, at the call, naming the offending key.
 *
 * Intersecting the parameter with this maps every undeclared key to `never`, so
 * no real value satisfies it however the object was built. Distributed over the
 * target union via {@link UnionKeys} so each member is checked rather than only
 * the keys they have in common.
 */
export type NoExcessKeys<TBody, TShape> = Record<Exclude<keyof TBody, UnionKeys<TShape>>, never>;

/** A body that conforms to a verb's declared input and carries nothing extra. */
export type ExactProfileInput<TVerb extends ProfileVerb, TBody> =
  TBody & NoExcessKeys<TBody, ProfileInput<TVerb>>;

/** What `profile.read` answers: the whole document, by section. */
export type ProfileDocumentView = OperatorMethodOutput<'profile.read'>;

/**
 * Load state, what `profile.status` answers, and the `state` half of a read.
 *
 * `kind` is `loaded` | `unavailable` | `disabled`. The counts belong to
 * `loaded` and `reason` to `unavailable`. There is no value property anywhere
 * in this shape, which is what makes the status output safe to show in a
 * diagnostic context (§11.3).
 */
export type ProfileStateView = OperatorMethodOutput<'profile.status'>;

/** What `profile.provenance` answers for one field. */
export type ProfileProvenanceReportView = OperatorMethodOutput<'profile.provenance'>;

/** What every write verb answers. `ok: false` always carries a reason. */
export type ProfileWriteResultView = OperatorMethodOutput<'profile.set'>;

/** One `## ` section, with the tier its content belongs to. */
export type ProfileSectionView = ProfileDocumentView['sections'][number];
/** One mechanical field. `valid: false` still carries the value, see §4.3. */
export type ProfileFieldView = ProfileSectionView['fields'][number];
/** One prose line, preserved as written. */
export type ProfileLineView = ProfileSectionView['prose'][number];
/** Where a line came from: which surface, when, and the owner's exact words. */
export type ProfileProvenanceView = NonNullable<ProfileFieldView['provenance']>;
/** A mechanical value that did not validate, and why. Never fails the file. */
export type ProfileInvalidFieldView = NonNullable<ProfileStateView['invalidFields']>[number];
/** A retained `<!-- was: … -->` predecessor, so a wrong correction is recoverable. */
export type ProfileSupersededView = ProfileProvenanceReportView['superseded'][number];
/** One thing a write did. Names the field; never repeats the value. */
export type ProfileChangeView = ProfileWriteResultView['changes'][number];

/**
 * Compile-time proof of two things this file assumes: that all four write verbs
 * really do answer one shape, and that `profile.status` really is the same
 * `state` a read carries.
 *
 * One write renderer serves four verbs and the status renderer reads both the
 * status response and a read's `state`. If the contract ever splits them,
 * `Exact` collapses to `never` and this assignment stops compiling, rather than
 * the difference going unnoticed until a response renders wrong.
 */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
export const PROFILE_CONTRACT_SHAPES_AGREE: Exact<OperatorMethodOutput<'profile.append'>, ProfileWriteResultView>
  & Exact<OperatorMethodOutput<'profile.forget'>, ProfileWriteResultView>
  & Exact<OperatorMethodOutput<'profile.undo'>, ProfileWriteResultView>
  & Exact<ProfileDocumentView['state'], ProfileStateView> = true;
