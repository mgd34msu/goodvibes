/**
 * Compile-time pin: `IntegrationHelperService` is constructed with exactly one
 * storage scope, a `SessionSurface`.
 *
 * A service reads and writes surface-scoped paths, the same ones the product
 * writes with. The loose `workingDirectory` / `homeDirectory` pair that once
 * read unscoped legacy paths is retired: accepting it, alone or beside a
 * surface, would leave "which paths does this service actually mean?"
 * answerable only at runtime, the exact ambiguity that produced continuity
 * answers from directories nothing had written to. The assertions below fail to
 * compile if the loose pair is ever accepted again or the surface stops being
 * required.
 *
 * Everything resolves through the package NAME so the exports map is exercised
 * exactly as a consumer install would (checked by `bun run types:check`).
 */
import type { ui } from '@goodvibes/engine/platform/platform/runtime';

declare function stub<T>(): T;

const services = stub<ui.IntegrationHelpersServices>();
const surface = stub<ui.IntegrationHelpersSurfaceScope['surface']>();

// The surface-scoped construction is valid.
const surfaceScoped: ui.IntegrationHelpersContext = { ...services, surface };

// The retired loose pair is not, alone or beside a surface.
// @ts-expect-error, a service names its surface; the loose workingDirectory/homeDirectory pair is retired.
const legacyScoped: ui.IntegrationHelpersContext = { ...services, workingDirectory: '/project', homeDirectory: '/home/user' };
// @ts-expect-error, the surface already names the project root; the loose pair cannot ride beside it.
const mixed: ui.IntegrationHelpersContext = { ...services, surface, workingDirectory: '/project', homeDirectory: '/home/user' };

// A context with no scope is not a valid construction either.
// @ts-expect-error, the scope is required: a service must know which directories it means.
const scopeless: ui.IntegrationHelpersContext = { ...services };

// Reference the bindings so they are not reported as unused.
export type Pinned = [typeof surfaceScoped, typeof legacyScoped, typeof mixed, typeof scopeless];
