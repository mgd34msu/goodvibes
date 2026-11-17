/**
 * surface-turn.ts, how a hosted session runs as one product's own turn.
 *
 * A hosted session is created FOR a surface (`originSurface`), and until a
 * product says otherwise its turns run with the host's prompt and the platform
 * tool set. A product that wants a session created for its surface to answer
 * as that product states it here, as data: which tools it adds to the
 * session's registry and how a model request's system prompt is composed. The
 * daemon hands one of these per surface to the hosted-session engine
 * (`DaemonHostedSessionsOptions.surfaceTurns`); the engine applies it on create
 * and on every rebuild, keyed by the session record's persisted origin, so a
 * session keeps the composition it was created with across restarts.
 *
 * The engine owns when it applies and the lifetime: the tools are registered
 * after the platform tools and disposed with the session, and the prompt is
 * asked for once per model request signal (a turn's retries and tool rounds
 * share one composition). The product owns what the tools and the prompt are.
 */

import type { ToolRegistry } from '../tools/registry.js';
import type { HostedWorkspaceFloor } from './workspace-floor.js';

/** The provider registry a session's requests use: the floor's, with the session's own model selection. */
export type HostedSessionProviderRegistry = HostedWorkspaceFloor['services']['providerRegistry'];

/** What a surface's tools are registered with, once per composed session. */
export interface HostedSurfaceToolsInput {
  /** The session's own registry; the platform tools are already in it. */
  readonly registry: ToolRegistry;
  readonly sessionId: string;
  /** The absolute workspace root the session's tools operate in. */
  readonly workspaceRoot: string;
  /** The workspace floor the session runs on. */
  readonly floor: HostedWorkspaceFloor;
  readonly providerRegistry: HostedSessionProviderRegistry;
}

/** What a surface's system prompt is composed from, once per model request. */
export interface HostedSurfacePromptInput {
  readonly sessionId: string;
  readonly workspaceRoot: string;
  /** The host's own base prompt for this session: what it is and where it runs. */
  readonly basePrompt: string;
  readonly providerRegistry: HostedSessionProviderRegistry;
  /** The user message the current turn answers; null before the first one. */
  readonly turnText: string | null;
  /** The model request's signal; a composition stops when it aborts. */
  readonly signal?: AbortSignal | undefined;
}

/** What a surface registered for one session; released when the session's loop is disposed. */
export interface HostedSurfaceTools {
  dispose?(): void | Promise<void>;
}

/** A product's turn for sessions created for its surface. */
export interface HostedSurfaceTurn {
  /** Adds the surface's tools to one session's registry; returns what to release with the session, if anything. */
  registerTools(input: HostedSurfaceToolsInput): HostedSurfaceTools | undefined;
  /** The system prompt for one model request of a session. */
  systemPrompt(input: HostedSurfacePromptInput): string | Promise<string>;
}

/** The surface turns a host offers, by origin surface (`agent`, `tui`, `webui`). */
export type HostedSurfaceTurns = Readonly<Partial<Record<string, HostedSurfaceTurn>>>;
