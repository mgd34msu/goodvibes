/**
 * The files that make up one installed program, per product and target, and
 * the release asset each is published as: the one statement of it. The table
 * between the two markers below is strict JSON, and the release script
 * (.github/scripts/release_asset_pins.py) reads it from this file; the
 * installer's and CI's member lists are checked against it. `mode` is the
 * file mode (493 = 0o755, 420 = 0o644); `reader` is false for a member the
 * daemon's native cohort carries that its reader evidence does not.
 *
 * `packages` names each product as its release evidence and install records
 * name it (`packageName`). These are the product identifiers in release
 * evidence; they are a contract with installed updaters and are not the
 * workspace package names. An identifier changes only in a release that still
 * reads the old one, and is written one release after that.
 */
const table = /* cohort-table:begin */ {
  "packages": {"goodvibes": "@goodvibes-jev/tui", "goodvibes-agent": "@goodvibes-jev/agent", "goodvibes-daemon": "@goodvibes-jev/daemon"},
  "members": [
    {"product": "goodvibes", "target": "linux-x64", "path": "goodvibes-linux-x64", "asset": "goodvibes-linux-x64", "mode": 493, "reader": true},
    {"product": "goodvibes", "target": "linux-x64", "path": "goodvibes-linux-x64.bun", "asset": "goodvibes-linux-x64.bun", "mode": 493, "reader": true},
    {"product": "goodvibes", "target": "linux-x64", "path": "goodvibes-linux-x64.bun.LICENSE.md", "asset": "goodvibes-linux-x64.bun.LICENSE.md", "mode": 420, "reader": true},
    {"product": "goodvibes", "target": "linux-x64", "path": "goodvibes-linux-x64.bun.json", "asset": "goodvibes-linux-x64.bun.json", "mode": 420, "reader": true},
    {"product": "goodvibes", "target": "linux-arm64", "path": "goodvibes-linux-arm64", "asset": "goodvibes-linux-arm64", "mode": 493, "reader": true},
    {"product": "goodvibes", "target": "linux-arm64", "path": "goodvibes-linux-arm64.bun", "asset": "goodvibes-linux-arm64.bun", "mode": 493, "reader": true},
    {"product": "goodvibes", "target": "linux-arm64", "path": "goodvibes-linux-arm64.bun.LICENSE.md", "asset": "goodvibes-linux-arm64.bun.LICENSE.md", "mode": 420, "reader": true},
    {"product": "goodvibes", "target": "linux-arm64", "path": "goodvibes-linux-arm64.bun.json", "asset": "goodvibes-linux-arm64.bun.json", "mode": 420, "reader": true},
    {"product": "goodvibes", "target": "darwin-x64", "path": "goodvibes-macos-x64", "asset": "goodvibes-macos-x64", "mode": 493, "reader": true},
    {"product": "goodvibes", "target": "darwin-arm64", "path": "goodvibes-macos-arm64", "asset": "goodvibes-macos-arm64", "mode": 493, "reader": true},
    {"product": "goodvibes-agent", "target": "linux-x64", "path": "goodvibes-agent-linux-x64", "asset": "goodvibes-agent-linux-x64", "mode": 493, "reader": true},
    {"product": "goodvibes-agent", "target": "linux-x64", "path": "goodvibes-agent-linux-x64.bun", "asset": "goodvibes-agent-linux-x64.bun", "mode": 493, "reader": true},
    {"product": "goodvibes-agent", "target": "linux-x64", "path": "goodvibes-agent-linux-x64.bun.LICENSE.md", "asset": "goodvibes-agent-linux-x64.bun.LICENSE.md", "mode": 420, "reader": true},
    {"product": "goodvibes-agent", "target": "linux-x64", "path": "goodvibes-agent-linux-x64.bun.json", "asset": "goodvibes-agent-linux-x64.bun.json", "mode": 420, "reader": true},
    {"product": "goodvibes-agent", "target": "linux-arm64", "path": "goodvibes-agent-linux-arm64", "asset": "goodvibes-agent-linux-arm64", "mode": 493, "reader": true},
    {"product": "goodvibes-agent", "target": "linux-arm64", "path": "goodvibes-agent-linux-arm64.bun", "asset": "goodvibes-agent-linux-arm64.bun", "mode": 493, "reader": true},
    {"product": "goodvibes-agent", "target": "linux-arm64", "path": "goodvibes-agent-linux-arm64.bun.LICENSE.md", "asset": "goodvibes-agent-linux-arm64.bun.LICENSE.md", "mode": 420, "reader": true},
    {"product": "goodvibes-agent", "target": "linux-arm64", "path": "goodvibes-agent-linux-arm64.bun.json", "asset": "goodvibes-agent-linux-arm64.bun.json", "mode": 420, "reader": true},
    {"product": "goodvibes-agent", "target": "darwin-x64", "path": "goodvibes-agent-macos-x64", "asset": "goodvibes-agent-macos-x64", "mode": 493, "reader": true},
    {"product": "goodvibes-agent", "target": "darwin-arm64", "path": "goodvibes-agent-macos-arm64", "asset": "goodvibes-agent-macos-arm64", "mode": 493, "reader": true},
    {"product": "goodvibes-daemon", "target": "linux-x64", "path": "goodvibes-daemon-linux-x64", "asset": "goodvibes-daemon-linux-x64", "mode": 493, "reader": true},
    {"product": "goodvibes-daemon", "target": "linux-x64", "path": "goodvibes-daemon-linux-x64.bun", "asset": "goodvibes-daemon-linux-x64.bun", "mode": 493, "reader": true},
    {"product": "goodvibes-daemon", "target": "linux-x64", "path": "goodvibes-daemon-linux-x64.bun.LICENSE.md", "asset": "goodvibes-daemon-linux-x64.bun.LICENSE.md", "mode": 420, "reader": true},
    {"product": "goodvibes-daemon", "target": "linux-x64", "path": "goodvibes-daemon-linux-x64.bun.json", "asset": "goodvibes-daemon-linux-x64.bun.json", "mode": 420, "reader": true},
    {"product": "goodvibes-daemon", "target": "linux-x64", "path": "lib/sqlite-vec-linux-x64/vec0.so", "asset": "sqlite-vec-linux-x64.so", "mode": 420, "reader": false},
    {"product": "goodvibes-daemon", "target": "linux-arm64", "path": "goodvibes-daemon-linux-arm64", "asset": "goodvibes-daemon-linux-arm64", "mode": 493, "reader": true},
    {"product": "goodvibes-daemon", "target": "linux-arm64", "path": "goodvibes-daemon-linux-arm64.bun", "asset": "goodvibes-daemon-linux-arm64.bun", "mode": 493, "reader": true},
    {"product": "goodvibes-daemon", "target": "linux-arm64", "path": "goodvibes-daemon-linux-arm64.bun.LICENSE.md", "asset": "goodvibes-daemon-linux-arm64.bun.LICENSE.md", "mode": 420, "reader": true},
    {"product": "goodvibes-daemon", "target": "linux-arm64", "path": "goodvibes-daemon-linux-arm64.bun.json", "asset": "goodvibes-daemon-linux-arm64.bun.json", "mode": 420, "reader": true},
    {"product": "goodvibes-daemon", "target": "linux-arm64", "path": "lib/sqlite-vec-linux-arm64/vec0.so", "asset": "sqlite-vec-linux-arm64.so", "mode": 420, "reader": false},
    {"product": "goodvibes-daemon", "target": "darwin-x64", "path": "goodvibes-daemon-macos-x64", "asset": "goodvibes-daemon-macos-x64", "mode": 493, "reader": true},
    {"product": "goodvibes-daemon", "target": "darwin-x64", "path": "lib/sqlite-vec-darwin-x64/vec0.dylib", "asset": "sqlite-vec-darwin-x64.dylib", "mode": 420, "reader": true},
    {"product": "goodvibes-daemon", "target": "darwin-x64", "path": "lib/sqlite-darwin-x64/libsqlite3.dylib", "asset": "sqlite-darwin-x64.dylib", "mode": 420, "reader": true},
    {"product": "goodvibes-daemon", "target": "darwin-x64", "path": "lib/sqlite-darwin-x64/libsqlite3.dylib.json", "asset": "sqlite-darwin-x64.dylib.json", "mode": 420, "reader": true},
    {"product": "goodvibes-daemon", "target": "darwin-arm64", "path": "goodvibes-daemon-macos-arm64", "asset": "goodvibes-daemon-macos-arm64", "mode": 493, "reader": true},
    {"product": "goodvibes-daemon", "target": "darwin-arm64", "path": "lib/sqlite-vec-darwin-arm64/vec0.dylib", "asset": "sqlite-vec-darwin-arm64.dylib", "mode": 420, "reader": true},
    {"product": "goodvibes-daemon", "target": "darwin-arm64", "path": "lib/sqlite-darwin-arm64/libsqlite3.dylib", "asset": "sqlite-darwin-arm64.dylib", "mode": 420, "reader": true},
    {"product": "goodvibes-daemon", "target": "darwin-arm64", "path": "lib/sqlite-darwin-arm64/libsqlite3.dylib.json", "asset": "sqlite-darwin-arm64.dylib.json", "mode": 420, "reader": true}
  ]
} /* cohort-table:end */ as const;

export type NativeCohortProduct = 'goodvibes' | 'goodvibes-agent' | 'goodvibes-daemon';
export type NativeCohortTarget = 'linux-x64' | 'linux-arm64' | 'darwin-x64' | 'darwin-arm64';

export interface NativeCohortMember {
  readonly product: NativeCohortProduct;
  readonly target: NativeCohortTarget;
  /** Installed path, relative to the program's directory. */
  readonly path: string;
  /** Flat release asset name the member is published as. */
  readonly asset: string;
  /** File mode: 0o755 for the launcher and runtime, 0o644 otherwise. */
  readonly mode: number;
  /** False for a member the daemon's native cohort carries that its reader evidence does not. */
  readonly reader: boolean;
}

const MEMBERS: readonly NativeCohortMember[] = Object.freeze(
  (table.members as readonly NativeCohortMember[]).map((member) => Object.freeze({ ...member })),
);

/** The product identifiers in release evidence; they are a contract with installed updaters and are not the workspace package names. */
export const RELEASE_EVIDENCE_PRODUCT_IDS = Object.freeze({ ...table.packages });
/** One product identifier in release evidence (`@goodvibes-jev/tui`, `@goodvibes-jev/agent`, `@goodvibes-jev/daemon`). */
export type ReleaseEvidenceProductId = typeof table.packages[NativeCohortProduct];
/** The terminal app's identifier in release evidence. */
export const TUI_RELEASE_EVIDENCE_ID = table.packages['goodvibes'];
/** The Agent's identifier in release evidence. */
export const AGENT_RELEASE_EVIDENCE_ID = table.packages['goodvibes-agent'];
/** The daemon's identifier in release evidence and in its install record. */
export const DAEMON_RELEASE_EVIDENCE_ID = table.packages['goodvibes-daemon'];
const PACKAGES: Readonly<Record<NativeCohortProduct, ReleaseEvidenceProductId>> = RELEASE_EVIDENCE_PRODUCT_IDS;

/** Members of one product on one target, in table order (the launcher first). */
export function nativeCohortMembers(product: NativeCohortProduct, target: NativeCohortTarget): readonly NativeCohortMember[] {
  return MEMBERS.filter((member) => member.product === product && member.target === target);
}

/** The product named by a release evidence identifier, or undefined for one that names no native program. */
export function nativeCohortProductOf(packageName: string): NativeCohortProduct | undefined {
  return (Object.keys(PACKAGES) as NativeCohortProduct[]).find((product) => PACKAGES[product] === packageName);
}
