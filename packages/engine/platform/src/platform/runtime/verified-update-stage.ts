/** platform-owned pin evidence for one synchronous native update admission. Pins
 * were computed during download verification; retained staging proves these
 * same bytes remain selected. A token is neither serializable authority nor
 * reusable after the admission callback returns. */
declare const verifiedStageBrand: unique symbol;
export interface VerifiedUpdateStage { readonly [verifiedStageBrand]: true }
export interface VerifiedUpdateMember {
  readonly path: string;
  readonly assetName: string;
  readonly sha256: string;
  readonly size: number;
  readonly mode: number;
}
interface StageOwner { active: boolean; readonly native: boolean; readonly members: readonly VerifiedUpdateMember[]; readonly assertCurrent: () => void }
const owners = new WeakMap<VerifiedUpdateStage, StageOwner>();
/** Internal producer; deliberately absent from the public runtime barrel. */
export function withVerifiedUpdateStage<T>(members: readonly VerifiedUpdateMember[], native: boolean, assertCurrent: () => void, operation: (stage: VerifiedUpdateStage) => T): T {
  const stage = Object.freeze({}) as VerifiedUpdateStage;
  const owner: StageOwner = { active: true, native, assertCurrent, members: Object.freeze(members.map(member => Object.freeze({ ...member }))) };
  owners.set(stage, owner);
  try { assertCurrent(); const result = operation(stage); assertCurrent(); return result; }
  finally { owner.active = false; }
}
/** Only real native staging may substitute its already-verified release pins
 * for a second payload hash. Borrowed adapters retain their existing exact-byte
 * verification path and cannot manufacture native provenance. */
export function verifiedUpdateStageMembers(stage: VerifiedUpdateStage): readonly VerifiedUpdateMember[] | undefined {
  const owner = owners.get(stage);
  if (!owner?.active) throw new Error('Verified update staging receipt is unavailable');
  owner.assertCurrent();
  return owner.native ? owner.members : undefined;
}
