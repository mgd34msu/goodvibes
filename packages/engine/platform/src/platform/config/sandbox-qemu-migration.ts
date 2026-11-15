/**
 * Retiring the QEMU sandbox backend from settings files.
 *
 * The QEMU backend is gone, and with it every setting that only configured it:
 * the binary, the disk image, the host wrapper, the guest host, port, user and
 * workspace, the guest session mode, and the guest JavaScript command the REPL
 * ran inside the VM. The two settings that chose between VMs go with them:
 * `sandbox.vmBackend` (one legal value left, `local`) and
 * `sandbox.replIsolation` (which VM the REPL shared, when there was one).
 *
 * Without this pass an old settings file would keep those keys forever: the
 * ingestion screen leaves unknown keys in the file untouched. So the retired
 * keys are removed and the owner gets one receipt saying what changed.
 *
 * Nothing is carried to a new name. There is no setting left that means what
 * these keys meant, and the backend they configured no longer exists.
 */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The retired leaf names under `sandbox`, in the order the schema declared them. */
export const RETIRED_SANDBOX_QEMU_FIELDS: readonly string[] = [
  'qemuBinary',
  'qemuImagePath',
  'qemuExecWrapper',
  'qemuGuestHost',
  'qemuGuestPort',
  'qemuGuestUser',
  'qemuWorkspacePath',
  'qemuSessionMode',
  'replJavaScriptCommand',
];

/** The retired keys as full dot-paths, for receipts and the settings screen. */
export const RETIRED_SANDBOX_QEMU_KEYS: readonly string[] =
  RETIRED_SANDBOX_QEMU_FIELDS.map((field) => `sandbox.${field}`);

/** The settings that chose a VM backend and how the REPL shared one; retired with the backend. */
export const RETIRED_SANDBOX_VM_CHOICE_FIELDS: readonly string[] = ['vmBackend', 'replIsolation'];

/** Outcome of removing the QEMU sandbox settings from one parsed file. */
export interface SandboxQemuMigrationResult {
  readonly config: Record<string, unknown>;
  /** True when a retired key was removed. */
  readonly migrated: boolean;
  /** The retired dot-path keys that were present and removed, in schema order. */
  readonly removedKeys: readonly string[];
  /** True when `sandbox.vmBackend` was `"qemu"`: the owner had chosen the VM backend. */
  readonly removedQemuBackend: boolean;
}

/**
 * Remove the retired `sandbox.qemu*`, `sandbox.replJavaScriptCommand`,
 * `sandbox.vmBackend` and `sandbox.replIsolation` keys.
 *
 * Every other `sandbox` key is left exactly as written. A `sandbox` section left
 * empty goes too, so the file does not keep an empty `sandbox: {}` behind.
 *
 * Idempotent; a file with none of the retired state is returned untouched,
 * same reference.
 */
export function migrateSandboxQemuRemoval(parsed: Record<string, unknown>): SandboxQemuMigrationResult {
  const sandbox = parsed['sandbox'];
  if (!isPlainObject(sandbox)) {
    return { config: parsed, migrated: false, removedKeys: [], removedQemuBackend: false };
  }
  const presentFields = [...RETIRED_SANDBOX_QEMU_FIELDS, ...RETIRED_SANDBOX_VM_CHOICE_FIELDS].filter((field) => field in sandbox);
  if (presentFields.length === 0) {
    return { config: parsed, migrated: false, removedKeys: [], removedQemuBackend: false };
  }

  const config = structuredClone(parsed);
  const section = config['sandbox'] as Record<string, unknown>;
  for (const field of presentFields) delete section[field];
  if (Object.keys(section).length === 0) delete config['sandbox'];
  return {
    config,
    migrated: true,
    removedKeys: presentFields.map((field) => `sandbox.${field}`),
    removedQemuBackend: sandbox['vmBackend'] === 'qemu',
  };
}
