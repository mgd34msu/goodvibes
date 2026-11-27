/** Choice meanings both terminal programs show for the same settings. */
export const SHARED_SETTING_ENUM_DESCRIPTIONS = {
  // Each way in one line; the full words (what it does, needs, gains, sends) are the setting's description and the "Secure address now" list.
  'secureAddress.certificate': {
    'lets-encrypt': 'Let\'s Encrypt for a name under a domain you own: give the name and a Cloudflare token once; every phone trusts it with nothing installed. The name appears in public certificate logs.',
    'own-files': 'A certificate you made: give the certificate and key files; phones that trust its signer get https. Nothing leaves this computer.',
    'local-authority': 'GoodVibes\' own certificate: install it once on each phone from the link for phones that goodvibes-daemon pair prints (the page on the https address, with the certificate\'s fingerprint; never over plain http). Nothing leaves this computer. Not yet tried on a real phone.',
  },
  'behavior.hitlMode': {
    off: 'Keep the baseline notification delivery policy; verbosity mode changes are rejected.',
    quiet: 'Minimize operational interruptions and surface fewer Human-in-the-Loop prompts.',
    balanced: 'Show important Human-in-the-Loop prompts without turning routine work into noise.',
  },
  'behavior.guidanceMode': {
    off: 'Do not add extra guidance beyond direct command output.',
    minimal: 'Show concise guidance only when it helps avoid mistakes.',
    guided: 'Provide more explanation and next-step context during configuration and operations.',
  },
  'storage.secretPolicy': {
    preferred_secure: 'Use secure secret storage when available, with supported fallback behavior.',
    require_secure: 'Require secure secret storage and reject plaintext fallback.',
    plaintext_allowed: 'Allow plaintext fallback when secure storage is unavailable.',
  },
  'ui.systemMessages': {
    conversation: 'Show system messages inline in the transcript.',
  },
  'ui.operationalMessages': {
    conversation: 'Show operational messages inline in the transcript.',
  },
  'surfaces.whatsapp.provider': {
    'meta-cloud': 'Use Meta Cloud API credentials and identifiers.',
  },
  'batch.mode': {
    off: 'Keep daemon work on the immediate local path.',
    explicit: 'Use batch only when callers explicitly request batch execution.',
    'eligible-by-default': 'Queue every non-streaming OpenAI-compatible chat completion as a batch unless it asks to run live; terminal and web chat stays live.',
  },
  'batch.fallback': {
    live: 'A batch job for a provider that cannot batch runs at once on the live path, at live prices, and comes back already finished.',
    fail: 'A batch job for a provider that cannot batch is refused, and nothing is sent.',
  },
} as const;
