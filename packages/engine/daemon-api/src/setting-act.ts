/**
 * Who made a settings change and how it was decided: the record a change keeps wherever it goes (a machine group
 * carries it to every member, which keeps it and shows it). `how`: `press`, the owner's own press; `yes`, his yes to a
 * call that was put to him (`by` is the caller who asked); `rules`, admitted under his rules for the named caller (a
 * paired device, a sign-in, a model acting for him) with nothing asked.
 *
 * Its own module, with no imports, so the routes and the dispatch share it without an import cycle.
 */
export interface SettingAct {
  /** The principal that acted (the caller), as the daemon authenticated it. */
  readonly by: string;
  /** That principal is the owner himself (his own credential, no model acting for him). */
  readonly owner: boolean;
  /** `carried`: a shared change made before this record existed (released 3.5.0), marked the owner's once at the upgrade. */
  readonly how: 'press' | 'yes' | 'rules' | 'carried';
  /** The caller in the owner's words where the daemon knows them (`the paired device "kitchen tablet"`). */
  readonly name?: string | undefined;
}

/** The act of each settings request the daemon's dispatch made (bound in process; no header carries it). */
const settingActs = new WeakMap<Request, SettingAct>();

/** Bind who made a settings write and how it was decided (the daemon's dispatch only). */
export function bindSettingAct(req: Request, act: SettingAct | undefined): void {
  if (act) settingActs.set(req, act);
}

/** The act the dispatch bound to this settings request, or undefined: a write with none records no actor. */
export function readSettingAct(req: Request): SettingAct | undefined {
  return settingActs.get(req);
}
