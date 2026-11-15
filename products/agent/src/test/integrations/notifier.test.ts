// Deliberately a per-repo test: the module it exercises is this repo's own, so the sibling product's tests do not stand in for it.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SecretsManager } from '../../config/secrets.ts';
import { ServiceRegistry } from '@goodvibes-jev/engine/platform/platform/config';
import { SubscriptionManager } from '@goodvibes-jev/engine/platform/platform/config';
import { Notifier } from '@goodvibes-jev/engine/platform/platform/integrations';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

describe('Notifier.fromConfig', () => {
  let root: string;
  let previousCwd: string;

  beforeEach(() => {
    previousCwd = process.cwd();
    root = makeProjectTempDir('gv-notifier');
    mkdirSync(join(root, '.goodvibes', 'agent'), { recursive: true });
    writeFileSync(join(root, '.goodvibes', 'agent', 'services.json'), JSON.stringify({
      slack: {
        name: 'Slack',
        baseUrl: 'https://slack.com/api',
        authType: 'bearer',
        tokenKey: 'SLACK_BOT_TOKEN',
        webhookUrlKey: 'SLACK_WEBHOOK_URL',
      },
      discord: {
        name: 'Discord',
        baseUrl: 'https://discord.com/api',
        authType: 'bearer',
        tokenKey: 'DISCORD_BOT_TOKEN',
        webhookUrlKey: 'DISCORD_WEBHOOK_URL',
      },
    }), 'utf-8');
    process.chdir(root);
    process.env.SLACK_BOT_TOKEN = 'xoxb-test';
    process.env.SLACK_WEBHOOK_URL = 'https://hooks.slack.test/example';
    process.env.DISCORD_BOT_TOKEN = 'discord-test-token';
  });

  afterEach(() => {
    process.chdir(previousCwd);
    delete process.env.SLACK_BOT_TOKEN;
    delete process.env.SLACK_WEBHOOK_URL;
    delete process.env.DISCORD_BOT_TOKEN;
    delete process.env.DISCORD_WEBHOOK_URL;
    rmSync(root, { recursive: true, force: true });
  });

  test('builds a channel where there is a webhook; a bot token alone is reported as a gap', async () => {
    const notifier = await Notifier.fromConfig(new ServiceRegistry(join(root, '.goodvibes', 'agent', 'services.json'), {
      secretsManager: new SecretsManager({ projectRoot: root, globalHome: root }),
      subscriptionManager: new SubscriptionManager(join(root, '.goodvibes', 'agent', 'subscriptions.json')),
    }));
    const channels = notifier.getQueueStatus().map((entry) => entry.channel).sort();
    expect(channels).toEqual(['slack']);
    expect(notifier.channelGaps().map((gap) => gap.channel)).toEqual(['discord']);
  });
});
