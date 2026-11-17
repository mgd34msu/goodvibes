/**
 * Revoking the shared operator token is the daemon's act, because only the
 * daemon can replace the value it serves with: it writes the new one to its
 * operator-tokens.json, where this terminal reads its bearer for every call,
 * so the apps on the daemon's machine stay signed in while every copy another
 * device holds stops working. This terminal therefore asks the daemon
 * (`pairing.tokens.revokeShared`) instead of writing the pairing store itself.
 */
import { describeOperatorRpcError, type OperatorRpc } from './operator-endpoint.ts';

export type SharedTokenRevocation =
  | { readonly ok: true; readonly message: string }
  | { readonly ok: false; readonly message: string };

/** The line shown after the daemon revoked and replaced the shared token. */
export const SHARED_TOKEN_REVOKED_MESSAGE = 'Revoked the shared token. Every device still using it is signed out and pairs again for its own token; '
  + 'the daemon wrote a new one to its operator-tokens.json, so the apps on its machine (this terminal, the Agent, the daemon CLI) stay signed in.';

export async function revokeSharedTokenOnDaemon(rpc: OperatorRpc): Promise<SharedTokenRevocation> {
  if (!rpc.available) return { ok: false, message: `The shared token was not revoked: ${rpc.reason}` };
  try {
    await rpc.platformClient.operator.invoke('pairing.tokens.revokeShared', {});
    return { ok: true, message: SHARED_TOKEN_REVOKED_MESSAGE };
  } catch (error) {
    return { ok: false, message: `The shared token was not revoked: ${describeOperatorRpcError(error)}` };
  }
}
