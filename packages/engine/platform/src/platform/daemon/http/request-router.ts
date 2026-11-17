/**
 * The path every daemon API request takes, in one place: routes that need no
 * credential, the one authentication, the access rule of the advertised
 * method, the route table, and the not-found answer.
 *
 * It needs two things to run: who is calling (`authenticate`) and what is
 * served (`routes`). Everything else is optional and supplied by the daemon's
 * composition, so a request can be driven through the real path with the real
 * handlers of one route family and nothing else of the daemon.
 */
import { dispatchDaemonApiRoutes } from '../../control-plane/routes/index.js';
import { AppError } from '../../types/errors.js';
import type { RequestContext } from '../http-policy.js';
import { jsonErrorResponse } from './error-response.js';

/**
 * The handlers the daemon serves and the extra dispatchers tried after them.
 * Built once: a handler keeps what it holds for as long as the table lives.
 */
export interface DaemonRouteTable {
  readonly handlers: Parameters<typeof dispatchDaemonApiRoutes>[1];
  readonly extensions?: Parameters<typeof dispatchDaemonApiRoutes>[2];
}

export interface DaemonRequestRouterOptions {
  /**
   * The request's principal, or null when it carries no valid credential.
   * Only the principal's presence is read here; handlers read the rest.
   */
  readonly authenticate: (req: Request) => Pick<RequestContext, 'principal'> | null;
  /**
   * The route table, or the function that builds it. A function runs on the
   * first request that reaches the table and never again.
   */
  readonly routes: DaemonRouteTable | (() => DaemonRouteTable);
  /** Routes answered without a credential (sign-in, peer handshake, webhooks). Null: not one of them. */
  readonly preAuth?: ((req: Request) => Promise<Response | null> | Response | null) | undefined;
  /** The answer to a request without a valid credential. Absent: the plain authentication refusal. */
  readonly refuseUnauthenticated?: ((req: Request) => Response) | undefined;
  /** A refusal for an authenticated request before any route sees it, or null to let it through. */
  readonly admit?: ((req: Request) => Response | null) | undefined;
  /** Route families served outside the table, tried before it. Null: not one of theirs. */
  readonly beforeTable?: ((req: Request) => Promise<Response | null> | Response | null) | undefined;
}

export class DaemonRequestRouter {
  private table: DaemonRouteTable | null;

  constructor(private readonly options: DaemonRequestRouterOptions) {
    this.table = typeof options.routes === 'function' ? null : options.routes;
  }

  /** The route table; built by the first caller when the host gave a builder. */
  routeTable(): DaemonRouteTable {
    if (this.table) return this.table;
    const routes = this.options.routes;
    const table = typeof routes === 'function' ? routes() : routes;
    this.table = table;
    return table;
  }

  /** The route that serves this request, without the credential check. Null: no route matched. */
  async dispatch(req: Request): Promise<Response | null> {
    const early = await this.options.beforeTable?.(req);
    if (early) return early;
    const table = this.routeTable();
    return dispatchDaemonApiRoutes(req, table.handlers, table.extensions);
  }

  /** One request, start to answer. */
  async route(req: Request): Promise<Response> {
    const preAuth = await this.options.preAuth?.(req);
    if (preAuth) return preAuth;

    // The one authentication of this request; every check after this reads the bound context.
    if (!this.options.authenticate(req)) {
      return this.options.refuseUnauthenticated?.(req) ?? authenticationRequired();
    }

    const refusal = this.options.admit?.(req);
    if (refusal) return refusal;

    const response = await this.dispatch(req);
    if (response) return response;
    const url = new URL(req.url);
    return jsonErrorResponse(
      new AppError(`Route not found: ${url.pathname}`, 'NOT_FOUND', false, {
        category: 'not_found',
        source: 'runtime',
        guidance: 'Check the daemon API path and version. New platform-facing routes are published under /api/v1.',
      }),
      { status: 404 },
    );
  }
}

/** The refusal for a request that carries no valid credential. */
export function authenticationRequired(): Response {
  return jsonErrorResponse(
    new AppError('Authentication required', 'AUTH_REQUIRED', false, {
      category: 'authentication',
      source: 'runtime',
      guidance: 'Authenticate with the operator shared token or an authenticated user session before calling daemon APIs.',
    }),
    { status: 401 },
  );
}
