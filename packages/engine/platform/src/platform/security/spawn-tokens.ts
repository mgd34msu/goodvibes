import { randomUUID } from 'node:crypto';
import { logger } from '../utils/logger.js';

const DEFAULT_TOKEN_TTL_MS = 3_600_000;

/** A registered local spawn grant. The ID resolves to the issuer's saved record. */
export interface SpawnToken {
  id: string;
  type: 'orchestrator' | 'agent';
  sessionId: string;
  issuedTo: string;
  issuedBy: string;
  depth: number;
  maxDepth: number;
  canGenerate: boolean;
  expiresAt: number;
}

export interface OrchestrationPolicyConfig {
  recursionEnabled: boolean;
  maxDepth: number;
  maxActiveAgents: number;
}
interface ValidateResult { valid: boolean; reason?: string | undefined; }
interface CanSpawnResult { allowed: boolean; reason?: string | undefined; }
type ResolvedToken = { valid: true; token: Readonly<SpawnToken> } | { valid: false; reason: string };
const TOKEN_FIELDS = ['id', 'type', 'sessionId', 'issuedTo', 'issuedBy', 'depth', 'maxDepth', 'canGenerate', 'expiresAt'] as const;

/** Local ownership, revocation and expiry; callers retain their execution boundary. */
export class SpawnTokenManager {
  private readonly tokens = new Map<string, Readonly<SpawnToken>>();
  constructor(private readonly sessionId: string) {}

  private issue(fields: Omit<SpawnToken, 'id'>): SpawnToken {
    const token = Object.freeze({ ...fields, id: randomUUID() });
    this.tokens.set(token.id, token);
    // A recipient may serialize/edit its copy; it cannot alter the issued grant.
    return { ...token };
  }

  private resolve(token: SpawnToken): ResolvedToken {
    if (!token || typeof token !== 'object') return { valid: false, reason: 'token is not an object' };
    try {
      const id = Object.getOwnPropertyDescriptor(token, 'id');
      if (!id || !('value' in id) || typeof id.value !== 'string') return { valid: false, reason: 'token has no registered ID' };
      const issued = this.tokens.get(id.value);
      if (!issued) return { valid: false, reason: 'token not registered (revoked or foreign)' };
      for (const key of TOKEN_FIELDS) {
        const field = Object.getOwnPropertyDescriptor(token, key);
        if (!field || !('value' in field) || field.value !== issued[key]) return { valid: false, reason: 'token fields differ from the issued grant' };
      }
      if (this.tokens.get(issued.id) !== issued) return { valid: false, reason: 'token revoked while being inspected' };
      if (Date.now() > issued.expiresAt) return { valid: false, reason: 'token expired' };
      return { valid: true, token: issued };
    } catch {
      return { valid: false, reason: 'token cannot be inspected' };
    }
  }

  createOrchestratorToken(ttlMs: number = DEFAULT_TOKEN_TTL_MS): SpawnToken {
    return this.issue({ type: 'orchestrator', sessionId: this.sessionId, issuedTo: 'main', issuedBy: 'system',
      depth: 0, maxDepth: 1, canGenerate: true, expiresAt: Date.now() + ttlMs });
  }

  generateAgentToken(orchestratorToken: SpawnToken, agentId: string, ttlMs: number = DEFAULT_TOKEN_TTL_MS): SpawnToken | null {
    const result = this.resolve(orchestratorToken);
    if (!result.valid) { logger.info('generateAgentToken: invalid grant', { reason: result.reason }); return null; }
    const owner = result.token;
    if (!owner.canGenerate || owner.type !== 'orchestrator') return null;
    return this.issue({ type: 'agent', sessionId: owner.sessionId, issuedTo: agentId, issuedBy: 'main',
      depth: 1, maxDepth: owner.maxDepth, canGenerate: false, expiresAt: Date.now() + ttlMs });
  }

  validate(token: SpawnToken): ValidateResult {
    const result = this.resolve(token);
    return result.valid ? { valid: true } : { valid: false, reason: result.reason };
  }

  canSpawn(token: SpawnToken, config: OrchestrationPolicyConfig, currentAgentCount: number): CanSpawnResult {
    if (!config.recursionEnabled) return { allowed: false, reason: 'recursive orchestration is disabled in policy' };
    if (currentAgentCount >= config.maxActiveAgents) return { allowed: false, reason: `fleet.maxSize limit reached (${currentAgentCount}/${config.maxActiveAgents})` };
    const result = this.resolve(token);
    if (!result.valid) return { allowed: false, reason: `invalid token: ${result.reason}` };
    if (result.token.depth > config.maxDepth) return { allowed: false, reason: `depth ${result.token.depth} exceeds maxDepth ${config.maxDepth}` };
    return { allowed: true };
  }

  revoke(tokenId: string): boolean { return this.tokens.delete(tokenId); }
}
