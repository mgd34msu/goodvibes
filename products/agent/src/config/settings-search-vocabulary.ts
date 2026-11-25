/**
 * settings-search-vocabulary.ts, the plain words a person uses for a settings
 * domain, and the guided flow that domain has when settings alone cannot finish
 * the job.
 *
 * Setting keys and descriptions are written in the platform's vocabulary:
 * `payments.budget.dailyItem` says neither "spending limit" nor "credit card",
 * which is what people ask for. When a settings search is exactly one of the
 * phrases below, the search is narrowed to that domain's settings before the
 * reading ranks them (`settingDomainForPhrase`): one map lookup, and the phrases
 * written down here no longer depend on the reading to find their domain. The
 * phrases are never shown as if the schema said them, and nothing here can add,
 * hide, or rename a setting.
 *
 * Every domain named here must exist in CONFIG_SCHEMA (a test pins that), so a
 * phrase for a domain that was renamed or removed fails the build instead of
 * narrowing a search to nothing.
 */

export interface SettingDomainVocabulary {
  /** Plain-language words and phrases that should reach this domain. */
  readonly aliases: readonly string[];
  /**
   * A guided flow that does what settings cannot. Named in the search result so
   * a caller who found the budgets also learns how the card is entered.
   */
  readonly relatedCommand?: { readonly command: string; readonly why: string };
}

export const SETTING_DOMAIN_VOCABULARY: Readonly<Record<string, SettingDomainVocabulary>> = {
  payments: {
    aliases: [
      'payment', 'payments', 'pay', 'paying', 'card', 'credit card', 'debit card', 'card on file',
      'money', 'spend', 'spending', 'spending limit', 'spend limit', 'budget', 'daily budget',
      'purchase', 'purchasing', 'buy', 'buying', 'order', 'checkout', 'cart', 'commerce',
      'billing', 'billing address', 'shipping', 'shipping address', 'delivery', 'retailer',
      'price', 'cost', 'charge', 'refund', 'cvv', 'expiry', 'approval window', 'veto window',
    ],
    relatedCommand: {
      command: '/payments add-card',
      why: 'The card number, expiry and verification code are never settings, they are typed at a local terminal through a masked prompt ("Add a card" in the Money place). The Money place also sets the two addresses and shows what is set.',
    },
  },
  occasions: {
    aliases: ['birthday', 'birthdays', 'anniversary', 'occasion', 'occasions', 'reminder', 'important date', 'gift'],
  },
  voice: {
    aliases: ['voice', 'speech', 'wake word', 'talk', 'speak', 'microphone', 'listening', 'push to talk'],
  },
  surfaces: {
    aliases: ['telegram', 'discord', 'slack', 'signal', 'whatsapp', 'ntfy', 'email', 'channel', 'messaging', 'notify me'],
  },
  provider: {
    aliases: ['model', 'llm', 'api key', 'anthropic', 'openai', 'reasoning effort', 'which model'],
  },
  permissions: {
    aliases: ['permission', 'approval', 'ask me first', 'auto approve', 'allowed tools', 'confirmation'],
  },
  sandbox: {
    aliases: ['sandbox', 'isolation', 'shell safety', 'command safety', 'exec guard'],
  },
  memory: {
    aliases: ['memory', 'remember', 'recall', 'context window', 'compaction'],
  },
  profile: {
    aliases: ['about me', 'owner profile', 'my details', 'personal details', 'who i am'],
  },
  display: {
    aliases: ['theme', 'dark mode', 'light mode', 'appearance', 'colours', 'colors', 'look'],
  },
  update: {
    aliases: ['update', 'upgrade', 'new version', 'auto update'],
  },
};

const normalizePhrase = (text: string): string => text.trim().toLowerCase().replace(/\s+/g, ' ');

/** Phrase to domain, built once; a phrase listed under two domains belongs to the first. */
const DOMAIN_BY_PHRASE: ReadonlyMap<string, string> = (() => {
  const map = new Map<string, string>();
  for (const [domain, vocabulary] of Object.entries(SETTING_DOMAIN_VOCABULARY)) {
    for (const alias of vocabulary.aliases) {
      const phrase = normalizePhrase(alias);
      if (!map.has(phrase)) map.set(phrase, domain);
    }
  }
  return map;
})();

/** The settings domain a search names exactly by one of its plain phrases ("spending limit" is payments). */
export function settingDomainForPhrase(query: string): string | undefined {
  return DOMAIN_BY_PHRASE.get(normalizePhrase(query));
}

/** The guided flow for a key's domain, when it has one. */
export function settingDomainRelatedCommand(key: string): SettingDomainVocabulary['relatedCommand'] {
  const domain = key.split('.')[0] ?? '';
  return SETTING_DOMAIN_VOCABULARY[domain]?.relatedCommand;
}
