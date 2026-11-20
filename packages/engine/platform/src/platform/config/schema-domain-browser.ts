/**
 * schema-domain-browser.ts, how the browser reaches the network (`browser.*`).
 *
 * The browser holds every request a page makes to the destination rule
 * (runtime/network/destination.ts) before it leaves: each host is resolved once
 * per browser context and checked. Chromium then resolves the name again for
 * itself, so a name whose answer changes between the two (DNS rebinding) can
 * reach what the check refused. `browser.network.pinned` closes that: every
 * request is fetched by this process through `egress`, connected to the
 * address that was checked, and handed to the page.
 */
import type { ConfigSettingDefinition } from './schema-shared.js';

/** The browser's network posture (`browser.*`). */
export interface BrowserConfig {
  network: {
    pinned: boolean;
  };
}

export const browserConfigDefaults: { browser: BrowserConfig } = {
  browser: {
    network: {
      pinned: false,
    },
  },
};

export const browserConfigSettings: ConfigSettingDefinition[] = [
  {
    key: 'browser.network.pinned',
    label: 'Fetch browser pages through the checked address',
    type: 'boolean',
    description:
      'Off (default): the browser checks each host a page asks for (resolved once per browser context) and lets the browser connect itself, which is fastest but lets a name that answers differently a moment later (DNS rebinding) reach an address the check refused. On: every request a page makes is fetched by GoodVibes through the address that was checked, redirects are checked hop by hop, and the answer is handed to the page, so a name that re-resolves to a private or metadata address after the check is never reached. Costs a copy of every response through this process. Turn it on when browsing sites you do not trust from a machine on a private network. Applies to browser sessions started after the change',
  },
];
