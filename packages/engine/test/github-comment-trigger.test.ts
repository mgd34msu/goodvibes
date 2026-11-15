/**
 * Who may start an agent by mentioning it in a GitHub comment.
 */
import { describe, expect, test } from 'bun:test';
import { GitHubIntegration, type GitHubWebhookEvent } from '../platform/src/platform/integrations/github.ts';

function comment(overrides: { association?: string; senderType?: string; userType?: string; body?: string }): GitHubWebhookEvent {
  return {
    type: 'issue_comment',
    action: 'created',
    payload: {
      repository: { full_name: 'acme/app' },
      issue: { number: 7, author_association: 'OWNER' },
      sender: { type: overrides.senderType ?? 'User' },
      comment: {
        body: overrides.body ?? '@goodvibes explain this',
        ...(overrides.association === undefined ? {} : { author_association: overrides.association }),
        user: { type: overrides.userType ?? 'User' },
      },
    },
  };
}

describe('GitHub comment trigger', () => {
  test('a mention from a repository member starts an agent', () => {
    for (const association of ['OWNER', 'MEMBER', 'COLLABORATOR']) {
      expect(GitHubIntegration.eventToPrompt(comment({ association }))).toContain('explain this');
    }
  });

  test('a mention from someone outside the repository does not, even on a maintainer\'s issue', () => {
    for (const association of ['NONE', 'CONTRIBUTOR', 'FIRST_TIME_CONTRIBUTOR', undefined]) {
      expect(GitHubIntegration.eventToPrompt(comment(association === undefined ? {} : { association }))).toBeNull();
    }
  });

  test('a mention written by a bot does not, so an agent reply that quotes the trigger cannot start another', () => {
    expect(GitHubIntegration.eventToPrompt(comment({ association: 'OWNER', senderType: 'Bot' }))).toBeNull();
    expect(GitHubIntegration.eventToPrompt(comment({ association: 'MEMBER', userType: 'Bot' }))).toBeNull();
  });

  test('a reply this integration posted with a maintainer token does not start an agent when it quotes the trigger', async () => {
    const savedFetch = globalThis.fetch;
    let posted = '';
    globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
      posted = (JSON.parse(String(init?.body)) as { body: string }).body;
      return new Response('{}', { status: 201 });
    }) as unknown as typeof fetch;
    try {
      await new GitHubIntegration().postIssueComment('acme', 'app', 7, 'You asked: @goodvibes explain this', 'maintainer-pat');
    } finally {
      globalThis.fetch = savedFetch;
    }
    // GitHub reports the maintainer's own association and a User type for that reply.
    expect(posted).toContain('@goodvibes explain this');
    expect(GitHubIntegration.eventToPrompt(comment({ association: 'OWNER', body: posted }))).toBeNull();
  });

  test('an agent reply that follows the prompt\'s closing instruction is not a trigger, even from a maintainer quoting the mention', () => {
    const prompt = GitHubIntegration.eventToPrompt(comment({ association: 'OWNER' }));
    expect(prompt).not.toBeNull();
    // The agent posts with its own tools; the marker line it was told to end with is the only identifier of its reply.
    const marker = String(prompt).split('\n').filter((line) => line.startsWith('<!--') && line.endsWith('-->'));
    expect(marker).toHaveLength(1);
    const reply = `You asked: @goodvibes explain this\n\n${marker[0]}`;
    expect(GitHubIntegration.eventToPrompt(comment({ association: 'OWNER', body: reply }))).toBeNull();
  });

  test('a comment by the account the configured token authenticates as does not start an agent, even without the marker line', async () => {
    const savedFetch = globalThis.fetch;
    let authorization = '';
    globalThis.fetch = (async (_url: unknown, init?: { headers?: Record<string, string> }) => {
      authorization = init?.headers?.Authorization ?? '';
      return new Response(JSON.stringify({ login: 'Maintainer-Bot' }), { status: 200 });
    }) as unknown as typeof fetch;
    let ownLogin: string | null;
    try {
      ownLogin = await GitHubIntegration.resolveAuthenticatedLogin('maintainer-pat');
    } finally {
      globalThis.fetch = savedFetch;
    }
    expect(authorization).toBe('Bearer maintainer-pat');
    expect(ownLogin).toBe('Maintainer-Bot');
    const own = comment({ association: 'OWNER', body: '@goodvibes noted, replying' });
    (own.payload.comment as { user: Record<string, unknown> }).user.login = 'maintainer-bot';
    expect(GitHubIntegration.eventToPrompt(own, { ownLogin })).toBeNull();
    // Another maintainer's mention still starts an agent.
    const other = comment({ association: 'OWNER' });
    (other.payload.comment as { user: Record<string, unknown> }).user.login = 'someone-else';
    expect(GitHubIntegration.eventToPrompt(other, { ownLogin })).toContain('explain this');
  });
});
