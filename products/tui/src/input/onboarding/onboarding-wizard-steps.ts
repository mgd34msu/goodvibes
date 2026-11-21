import { normalizePermissionMode } from '@goodvibes/engine/platform/platform/gate';
import { NETWORK_MODE_OPTIONS, REASONING_OPTIONS, HITL_MODE_OPTIONS, GUIDANCE_MODE_OPTIONS, PERMISSION_MODE_OPTIONS, SECRET_POLICY_OPTIONS } from './onboarding-wizard-constants.ts';
import { shouldShowCloudflareStep } from './onboarding-wizard-cloudflare.ts';
import { buildCloudflareStep } from './onboarding-wizard-cloudflare-step.ts';
import {
  EXTERNAL_SURFACE_SPECS,
  getExternalSurfaceAutoStartDefaultValue,
  getExternalSurfaceAutoStartFieldId,
  getNtfyProtocolTopicLines,
  isExternalSurfaceSelectedByDefault,
  type ExternalSurfaceSpec,
} from './onboarding-wizard-external-surfaces.ts';
import { buildFeatureUnitSteps } from './onboarding-feature-units.ts';
import { getBlockingFieldLabels } from './onboarding-wizard-state.ts';
import { countSelected, modelSelectionLabel, normalizeText } from './onboarding-wizard-helpers.ts';
import { deriveProviderKeyCaptureTargets } from '../../runtime/onboarding/provider-key-capture.ts';
import { buildProviderKeyInventoryField, buildProviderKeyMaskedFields, buildSubscriptionPosture } from './onboarding-provider-key-fields.ts';
import { DAEMON_SOURCE_FIELD_ID, getDaemonSource, pushDaemonAdoptionFields } from './onboarding-wizard-network-adopt.ts';
import type { OnboardingWizardControllerLike, OnboardingWizardTopic } from './onboarding-wizard-types.ts';
import type { OnboardingStep1CapabilityId } from '../../runtime/onboarding/index.ts';
import { SETUP_TOPICS } from '@goodvibes/engine/terminal-shell/setup-command';
import type { OnboardingWizardAcknowledgementFieldDefinition, OnboardingWizardActionFieldDefinition, OnboardingWizardChecklistFieldDefinition, OnboardingWizardExternalSurfaceStepId, OnboardingWizardFieldDefinition, OnboardingWizardModelPickerFieldDefinition, OnboardingWizardRadioFieldDefinition, OnboardingWizardRadioOption, OnboardingWizardStepDefinition } from './onboarding-wizard-types.ts';

/** The capability a topic switches on, shown as that topic's first row. */
const TOPIC_CAPABILITY: Partial<Record<OnboardingWizardTopic, string>> = {
  'local-only': 'local-tui-only',
  'browser': 'browser-access',
  'other-devices': 'network-access',
  'webhooks': 'webhook-events',
  'chat-apps': 'external-integrations',
  'cloudflare': 'cloudflare-batch',
};

/** The network rows each reach topic shows (the rest of the network page belongs to the others). */
const TOPIC_NETWORK_FIELDS: Partial<Record<OnboardingWizardTopic, readonly string[]>> = {
  'browser': ['network.mode', 'network.shared-ip', 'network.shared-ip-address', 'network.service-', 'network.browser-', 'network.tls-warn'],
  'other-devices': ['network.mode', 'network.shared-ip', 'network.shared-ip-address', 'network.service-', 'network.tls-warn'],
  'webhooks': ['network.mode', 'network.shared-ip', 'network.shared-ip-address', 'network.webhook-', 'network.cors-note', 'network.tls-warn'],
};

const FEATURE_TOPIC_STEP: Partial<Record<OnboardingWizardTopic, OnboardingWizardStepDefinition['id']>> = {
  'safety': 'features-safety',
  'memory': 'features-context',
  'telemetry': 'features-telemetry',
  'automation': 'features-automation',
  'devices-voice': 'features-devices',
  'provider-behaviour': 'features-provider',
  'advanced': 'features-advanced',
};

const KEY_FIELD_PREFIXES = ['providers.api-key.', 'providers.api-key-inventory'];
const isKeyField = (id: string): boolean => KEY_FIELD_PREFIXES.some((prefix) => id.startsWith(prefix));
const ACCOUNT_ADMIN_FIELDS = ['accounts.admin-username', 'accounts.admin-password', 'accounts.admin-password-confirm', 'accounts.auth', 'accounts.bootstrap', 'accounts.user-store'];
/** The sign-in account rows a reach topic adds when it opens the computer to the network. */
const REACH_ADMIN_FIELDS = ['accounts.admin-username', 'accounts.admin-password', 'accounts.admin-password-confirm', 'accounts.auth'];

function pick(step: OnboardingWizardStepDefinition, keep: (id: string) => boolean): OnboardingWizardFieldDefinition[] {
  return step.fields.filter((field) => keep(field.id));
}

/** The rows of one topic's form, from the page builders that hold them. */
function topicFields(controller: OnboardingWizardControllerLike, topic: OnboardingWizardTopic): { readonly id: OnboardingWizardStepDefinition['id']; readonly description: string; readonly fields: OnboardingWizardFieldDefinition[] } {
  const capabilityId = TOPIC_CAPABILITY[topic];
  const capabilityRow = capabilityId ? pick(buildCapabilitiesStep(controller), (id) => id === `capabilities.${capabilityId}` || (topic === 'local-only' && id === 'capabilities.clear')) : [];
  const capabilityOn = capabilityId ? controller.isCapabilitySelected(capabilityId as OnboardingStep1CapabilityId) : false;
  // A reach topic that opens the machine to the network asks for the account that signs in.
  const adminRows = (): OnboardingWizardFieldDefinition[] => controller.requiresAuthBootstrap()
    ? pick(buildAccessStep(controller), (id) => REACH_ADMIN_FIELDS.includes(id))
    : [];
  switch (topic) {
    case 'model': {
      const step = buildDefaultModelStep(controller);
      return { id: step.id, description: 'The model new conversations use, and how hard it thinks.', fields: [...step.fields] };
    }
    case 'sign-in': {
      const providers = buildProviderAccessStep(controller);
      return {
        id: providers.id,
        description: 'Sign in to a provider with your browser, finish a sign-in, and confirm which providers GoodVibes may use.',
        fields: [...pick(providers, (id) => !isKeyField(id)), ...pick(buildAccessStep(controller), (id) => id === 'accounts.subscriptions')],
      };
    }
    case 'store-key': {
      const providers = buildProviderAccessStep(controller);
      return {
        id: providers.id,
        description: 'Paste a provider\'s API key, and choose how keys are stored. A key is kept in the secret store, never shown.',
        fields: [...pick(providers, isKeyField), ...pick(buildExternalServicesStep(controller), (id) => id === 'external-services.secret-policy')],
      };
    }
    case 'local-only':
      return { id: 'capabilities', description: 'Use GoodVibes only in this terminal: no browser access, no network access, no webhooks. The background service on this computer still runs.', fields: capabilityRow };
    case 'browser':
    case 'other-devices':
    case 'webhooks': {
      const prefixes = TOPIC_NETWORK_FIELDS[topic] ?? [];
      const network = capabilityOn ? pick(buildNetworkStep(controller), (id) => prefixes.some((prefix) => id.startsWith(prefix))) : [];
      const description = topic === 'browser'
        ? 'Turn on the web UI and choose where it listens.'
        : topic === 'other-devices'
          ? 'Let your other devices reach GoodVibes, and choose the addresses and ports. Someone must sign in from those devices.'
          : 'Turn on the receiver for webhooks and events from other tools, and choose where it listens.';
      return { id: 'network', description, fields: [...capabilityRow, ...network, ...(capabilityOn ? adminRows() : [])] };
    }
    case 'connect-daemon': {
      // Which daemon this terminal dials is a client-side choice: no capability, no exposure of this machine, no sign-in account.
      const network = pick(buildNetworkStep(controller), (id) => id === DAEMON_SOURCE_FIELD_ID || id.startsWith('network.adopt-'));
      return { id: 'network', description: 'Point this terminal at a GoodVibes daemon already running on another computer, with its address and token, or go back to the daemon on this computer. Nothing here opens this computer to the network.', fields: network };
    }
    case 'chat-apps': {
      const services = capabilityOn ? pick(buildExternalServicesStep(controller), (id) => id !== 'external-services.secret-policy') : [];
      const surfaces = capabilityOn ? getSelectedExternalSurfaceSpecs(controller).flatMap((surface) => {
        const step = buildExternalSurfaceStep(controller, surface);
        return [{ kind: 'status' as const, id: `${step.id}.heading`, label: step.title, hint: step.description, defaultValue: '', spacerBeforeRows: 1 }, ...step.fields];
      }) : [];
      return { id: 'external-services', description: 'Choose the chat apps and services GoodVibes connects to, and fill in each one.', fields: [...capabilityRow, ...services, ...surfaces, ...(capabilityOn ? adminRows() : [])] };
    }
    case 'cloudflare': {
      const cloudflare = shouldShowCloudflareStep(controller) ? buildCloudflareStep(controller) : null;
      return { id: 'cloudflare', description: cloudflare?.description ?? 'Use Cloudflare Workers and Queues for batch and remote work.', fields: [...capabilityRow, ...(cloudflare?.fields ?? [])] };
    }
    case 'who-signs-in': {
      const access = buildAccessStep(controller);
      return { id: access.id, description: 'The account that signs in to this GoodVibes from a browser or another device.', fields: pick(access, (id) => ACCOUNT_ADMIN_FIELDS.includes(id)) };
    }
    case 'how-it-works': {
      const step = buildExperienceStep(controller);
      return { id: step.id, description: 'How much GoodVibes tells you while it works, how much guidance it gives, and who decides when it should ask.', fields: [...step.fields] };
    }
    default: {
      const stepId = FEATURE_TOPIC_STEP[topic];
      const step = buildFeatureUnitSteps(controller).find((candidate) => candidate.id === stepId);
      return { id: stepId ?? 'features-advanced', description: step?.description ?? '', fields: [...(step?.fields ?? [])] };
    }
  }
}

/**
 * One form for the topic `/setup` opened: its rows, any message from the last
 * save at the top, and Save at the bottom. Save applies only what changed on
 * this form (the apply drops every write equal to what was read).
 */
export function buildOnboardingWizardSteps(controller: OnboardingWizardControllerLike): readonly OnboardingWizardStepDefinition[] {
  if (controller.hydrationPending || controller.hydrationError !== null) return [buildLoadingStep(controller)];
  const topic = controller.topic;
  const form = topicFields(controller, topic);
  const blockers = getBlockingFieldLabels(controller, [{ id: form.id, title: '', shortLabel: '', description: '', summaryTitle: '', summaryLines: [], fields: form.fields }]);
  const feedback = controller.applyFeedback;
  const feedbackFields: OnboardingWizardFieldDefinition[] = feedback
    ? [
        {
          kind: 'status',
          id: 'save.feedback',
          label: feedback.title,
          hint: feedback.summary,
          defaultValue: feedback.severity === 'error' ? 'Needs attention' : feedback.severity === 'warning' ? 'Warning' : 'Info',
        },
        ...feedback.messages.slice(0, 8).map((message, index): OnboardingWizardFieldDefinition => ({
          kind: 'status',
          id: `save.feedback.${index}`,
          label: message,
          hint: message,
          defaultValue: feedback.severity === 'error' ? 'Error' : feedback.severity === 'warning' ? 'Warning' : 'Info',
        })),
      ]
    : [];
  const save: OnboardingWizardActionFieldDefinition = {
    kind: 'action',
    id: 'save',
    action: 'apply',
    label: 'Save',
    hint: blockers.length > 0
      ? `Finish these first: ${blockers.join(' · ')}`
      : 'Save what changed on this form and check that it works. Nothing else is changed.',
    defaultValue: blockers.length > 0 ? 'Blocked' : 'Ready',
    spacerBeforeRows: 1,
  };
  return [{
    id: form.id,
    title: SETUP_TOPICS[topic].label,
    shortLabel: SETUP_TOPICS[topic].label,
    description: form.description,
    summaryTitle: SETUP_TOPICS[topic].label,
    summaryLines: [],
    fields: [...feedbackFields, ...form.fields, save],
  }];
}

export function buildLoadingStep(controller: OnboardingWizardControllerLike): OnboardingWizardStepDefinition {
    const failed = controller.hydrationError !== null;
    return {
      id: 'loading',
      title: failed ? 'Current settings unavailable' : 'Loading current settings',
      shortLabel: 'Loading',
      description: failed
        ? 'The wizard is locked because current runtime settings could not be collected. Fix the reported issue, then press Enter to load them again (Esc closes setup).'
        : 'Collecting the current daemon, listener, provider, subscription, auth, and surface settings before the wizard becomes editable.',
      summaryTitle: failed ? 'Preload failed' : 'Preload required',
      summaryLines: [
        failed
          ? 'Editable fields remain locked to avoid applying defaults over existing configuration.'
          : 'Editable fields are locked until runtime settings are loaded.',
        failed
          ? controller.hydrationError ?? 'Unknown snapshot failure.'
          : 'This prevents the wizard from applying defaults over existing configuration.',
      ],
      fields: [
        {
          kind: 'status',
          id: 'loading.runtime-snapshot',
          label: failed ? 'Runtime settings snapshot failed' : 'Runtime settings snapshot',
          hint: failed
            ? `${controller.hydrationError ?? 'The runtime snapshot did not complete.'} Press Enter to retry.`
            : 'Waiting for the current GoodVibes configuration and account state.',
          defaultValue: failed ? 'Enter: retry' : 'Loading',
        },
      ],
    };
  }

export function buildCapabilitiesStep(controller: OnboardingWizardControllerLike): OnboardingWizardStepDefinition {
    const capabilities = controller.getCapabilitySelectionState();
    const selectedCount = countSelected(capabilities);
    const fields: OnboardingWizardFieldDefinition[] = [
      ...capabilities.map((capability) => ({
        kind: 'checklist' as const,
        id: `capabilities.${capability.id}`,
        capabilityId: capability.id,
        label: capability.label,
        hint: capability.detail,
        defaultValue: capability.selected,
      })),
      {
        kind: 'action',
        id: 'capabilities.select-all',
        action: 'select-all-capabilities',
        label: 'Select all server-backed capabilities',
        hint: 'Enable browser access, LAN reachability, webhooks/events, and external app surfaces. Local TUI Only is turned off.',
        defaultValue: 'Action',
      },
      {
        kind: 'action',
        id: 'capabilities.clear',
        action: 'clear-capabilities',
        label: 'Turn off everything but this terminal',
        hint: 'Clear all server-backed capabilities: no browser access, LAN reachability, webhooks/events, or external app surfaces. The loopback-only background daemon still runs by default.',
        defaultValue: 'Action',
      },
    ];

    return {
      id: 'capabilities',
      title: 'Choose GoodVibes capabilities',
      shortLabel: 'Capabilities',
      description: 'Choose what GoodVibes should be able to do. Local TUI Only opens no network surface and leaves the daemon\'s service as it is; any other choice also turns on service mode and autostart.',
      summaryTitle: 'Selected capabilities',
      summaryLines: [
        `${selectedCount}/${capabilities.length} option(s) selected`,
        `Mode: ${controller.mode === 'edit' ? 'edit existing shell state' : controller.mode === 'reopen' ? 'reopen review flow' : 'new setup'}`,
        controller.runtimeSnapshot?.collectionIssues.length
          ? `${controller.runtimeSnapshot.collectionIssues.length} runtime collection issue(s)`
          : 'Runtime snapshot collected cleanly',
      ],
      fields,
    };
  }

export function buildProvidersStep(controller: OnboardingWizardControllerLike): OnboardingWizardStepDefinition {
    const providerAck = controller.runtimeDerived.reopenEditAcknowledgements.providers;
    const activeSubscriptions = controller.runtimeSnapshot?.subscriptions.active ?? [];
    const pendingSubscriptions = controller.runtimeSnapshot?.subscriptions.pending ?? [];
    // Provider-agnostic subscription posture: one status row per
    // subscription-capable provider (registration truth), plus any provider with
    // a live/pending session, and which provider's in-wizard sign-in applies now.
    const subscription = buildSubscriptionPosture(
      activeSubscriptions.map((entry) => entry.provider),
      pendingSubscriptions.map((entry) => entry.provider),
      controller.runtimeSnapshot?.providerAccounts?.providers,
    );
    const signInPending = subscription.signInPending;
    // Provider-agnostic key capture: one field per provider the registry knows
    // accepts an API key (derived from registration truth, never a hardcoded
    // vendor list). No provider is named as the only option.
    const keyTargets = deriveProviderKeyCaptureTargets(controller.runtimeSnapshot?.providerAccounts?.providers);
    const configuredKeyCount = keyTargets.filter((target) => target.configured).length;
    const providerReviewField: OnboardingWizardAcknowledgementFieldDefinition = {
      kind: 'acknowledgement',
      id: 'providers.reviewed',
      label: 'Confirm provider access review',
      hint: providerAck.detail,
      defaultValue: providerAck.accepted,
      required: controller.mode !== 'new' && providerAck.required,
      reason: providerAck.reason,
      target: 'providers',
    };

    const fields: OnboardingWizardFieldDefinition[] = [
      ...subscription.statusFields,
      buildProviderKeyInventoryField(keyTargets),
      // One masked field per key-accepting provider. Entered values are stored
      // through the secret manager at apply and the provider re-registers live.
      ...buildProviderKeyMaskedFields(keyTargets),
      ...(!subscription.signInProviderId ? [] : [
        {
          kind: 'action' as const,
          id: 'providers.openai-subscription-start',
          action: 'start-openai-subscription' as const,
          label: signInPending ? 'Restart OpenAI subscription sign-in' : 'Start OpenAI subscription sign-in',
          hint: 'Opens the OpenAI sign-in flow from the wizard and records pending login state here.',
          defaultValue: signInPending ? 'Restart' : 'Start',
        },
        ...(signInPending ? [
          {
            kind: 'text' as const,
            id: 'providers.openai-authorization-url',
            label: 'OpenAI authorization URL',
            hint: 'If the browser did not open, use this URL to continue sign-in without leaving the wizard.',
            placeholder: 'authorization URL appears after start',
            defaultValue: '',
          },
          {
            // Masked so the single-use authorization code is never shown or written to the saved wizard progress.
            kind: 'masked' as const,
            id: 'providers.openai-callback-code',
            label: 'OpenAI callback code or URL',
            hint: 'Paste the callback code or redirected URL after completing browser sign-in. It is hidden and never saved with wizard progress.',
            placeholder: 'code or callback URL',
            defaultValue: '',
          },
          {
            kind: 'action' as const,
            id: 'providers.openai-subscription-finish',
            action: 'finish-openai-subscription' as const,
            label: 'Finish OpenAI subscription sign-in',
            hint: 'Completes the pending OpenAI subscription login using the code above.',
            defaultValue: 'Finish',
          },
        ] : []),
      ]),
      providerReviewField,
    ];

    return {
      id: 'provider-access',
      title: 'AI provider access',
      shortLabel: 'Providers',
      description: 'Review subscription posture and optionally add an API key for any provider that accepts one, directly through the wizard.',
      summaryTitle: 'Provider access summary',
      summaryLines: [
        subscription.summaryLine,
        keyTargets.length === 0
          ? 'Provider API keys: no key-accepting providers registered'
          : `Provider API keys: ${configuredKeyCount}/${keyTargets.length} configured`,
        `Review: ${controller.getFieldValueLabel(providerReviewField)}`,
      ],
      fields,
    };
  }

export function buildProviderAccessStep(controller: OnboardingWizardControllerLike): OnboardingWizardStepDefinition {
    return buildProvidersStep(controller);
  }

export function buildDefaultModelStep(controller: OnboardingWizardControllerLike): OnboardingWizardStepDefinition {
    const routing = controller.runtimeSnapshot?.providerRouting;
    const primarySelectionField: OnboardingWizardModelPickerFieldDefinition = {
      kind: 'modelPicker',
      id: 'default-model.primary-model',
      label: 'Model for new conversations',
      hint: "Open the nested model picker for the shell's main routing target.",
      target: 'main',
      defaultSelection: {
        providerId: normalizeText(routing?.primaryProviderId),
        modelId: normalizeText(routing?.primaryModelId),
        enabled: true,
      },
    };
    const reasoningField: OnboardingWizardRadioFieldDefinition = {
      kind: 'radio',
      id: 'default-model.reasoning',
      label: 'Reasoning effort',
      hint: 'Use the shell reasoning default that matches the current provider routing.',
      options: REASONING_OPTIONS,
      defaultValue: normalizeText(routing?.primaryReasoningEffort) || 'medium',
    };

    return {
      id: 'default-model',
      title: 'Default model',
      shortLabel: 'Model',
      description: 'Choose the default model routing the shell should use after onboarding.',
      summaryTitle: 'Default model summary',
      summaryLines: [
        `Main: ${modelSelectionLabel(controller.modelSelectionState.get('main') ?? primarySelectionField.defaultSelection)}`,
        `Reasoning: ${controller.getFieldValueLabel(reasoningField)}`,
      ],
      fields: [
        primarySelectionField,
        reasoningField,
      ],
    };
  }

export function buildExternalServicesStep(controller: OnboardingWizardControllerLike): OnboardingWizardStepDefinition {
    const selectedCount = EXTERNAL_SURFACE_SPECS
      .filter((surface) => controller.getBooleanFieldValue(
        surface.enabledFieldId,
        isExternalSurfaceSelectedByDefault(surface, controller.runtimeSnapshot),
      ))
      .length;
    const fields: OnboardingWizardFieldDefinition[] = [];

    for (const surface of EXTERNAL_SURFACE_SPECS) {
      fields.push({
        kind: 'checklist',
        id: surface.enabledFieldId,
        label: surface.label,
        hint: `${surface.hint} Selecting this opens a dedicated setup screen; auto-start is chosen on that screen.`,
        defaultValue: isExternalSurfaceSelectedByDefault(surface, controller.runtimeSnapshot),
      });
    }

    fields.push(
      {
        kind: 'action',
        id: 'external-services.select-all',
        action: 'select-all-external-surfaces',
        label: 'Select all external surfaces',
        hint: 'Show setup screens for every supported external surface. Auto-start stays controlled per surface.',
        defaultValue: 'Action',
      },
      {
        kind: 'action',
        id: 'external-services.clear',
        action: 'clear-external-surfaces',
        label: 'Clear all external surfaces',
        hint: 'Hide all external surface setup screens. The HTTP listener can still be enabled separately by webhook/event capabilities.',
        defaultValue: 'Action',
      },
      {
        kind: 'radio',
        id: 'external-services.secret-policy',
        label: 'Secret storage policy',
        hint: 'Choose how selected surface secrets should be stored. Secret values are never shown in the wizard.',
        options: SECRET_POLICY_OPTIONS,
        defaultValue: controller.runtimeSnapshot?.runtimeDefaults.secretStoragePolicy ?? 'preferred_secure',
      },
    );

    return {
      id: 'external-services',
      title: 'Choose external surfaces',
      shortLabel: 'Services',
      description: 'Select the apps and integration surfaces GoodVibes should prepare. Each selected surface gets its own setup screen and its own auto-start choice.',
      summaryTitle: 'External surfaces',
      summaryLines: [
        `${selectedCount} external surface(s) selected for setup`,
        `Secret policy: ${controller.getStringFieldValue('external-services.secret-policy', controller.runtimeSnapshot?.runtimeDefaults.secretStoragePolicy ?? 'preferred_secure')}`,
        selectedCount > 0 ? 'Selected surfaces appear as separate setup screens.' : 'No external surfaces selected.',
      ],
      fields,
    };
  }

function getSelectedExternalSurfaceSpecs(controller: OnboardingWizardControllerLike): readonly ExternalSurfaceSpec[] {
    return EXTERNAL_SURFACE_SPECS.filter((surface) => (
      controller.getBooleanFieldValue(
        surface.enabledFieldId,
        isExternalSurfaceSelectedByDefault(surface, controller.runtimeSnapshot),
      )
    ));
  }

const SURFACE_AUTO_START_OPTIONS: readonly OnboardingWizardRadioOption[] = [
  {
    id: 'yes',
    label: 'Yes',
    hint: 'Start this surface automatically when the GoodVibes service starts.',
  },
  {
    id: 'no',
    label: 'No',
    hint: 'Save these settings but leave the surface idle until it is enabled from Settings > Surfaces.',
  },
];

function buildExternalSurfaceStep(
  controller: OnboardingWizardControllerLike,
  surface: ExternalSurfaceSpec,
): OnboardingWizardStepDefinition {
    let setupCount = 0;
    let setupCompleteCount = 0;
    const autoStartFieldId = getExternalSurfaceAutoStartFieldId(surface);
    const autoStartDefault = getExternalSurfaceAutoStartDefaultValue(surface, controller.runtimeSnapshot);
    const autoStartValue = controller.getStringFieldValue(autoStartFieldId, autoStartDefault);
    const setupFields = surface.fields.map((setupField): OnboardingWizardFieldDefinition => {
      const suggested = controller.isRequiredExternalSetupField(setupField.id);
      if (suggested) {
        setupCount += 1;
        if (normalizeText(setupField.defaultValue(controller.runtimeSnapshot)).length > 0
          || normalizeText(controller.getStringFieldValue(setupField.id, '')).length > 0) {
          setupCompleteCount += 1;
        }
      }

      const hint = suggested
        ? `${setupField.hint} Recommended because ${surface.label} is selected, but it will not block saving.`
        : setupField.hint;

      if (setupField.kind === 'radio') {
        return {
          kind: 'radio',
          id: setupField.id,
          label: setupField.label,
          hint,
          options: setupField.options ?? [],
          defaultValue: setupField.defaultValue(controller.runtimeSnapshot),
        };
      }

      return {
        kind: setupField.kind,
        id: setupField.id,
        label: setupField.label,
        hint,
        placeholder: setupField.placeholder,
        defaultValue: setupField.defaultValue(controller.runtimeSnapshot),
      };
    });
    // What the step will save for each topic: the entered value, else the saved one.
    const ntfyFieldValue = (configKey: string): string => {
      const field = surface.fields.find((candidate) => candidate.configKey === configKey);
      return field ? controller.getStringFieldValue(field.id, field.defaultValue(controller.runtimeSnapshot)) : '';
    };
    const ntfyTopicSummary = surface.id === 'ntfy'
      ? getNtfyProtocolTopicLines({
          chatTopic: ntfyFieldValue('surfaces.ntfy.chatTopic'),
          agentTopic: ntfyFieldValue('surfaces.ntfy.agentTopic'),
          remoteTopic: ntfyFieldValue('surfaces.ntfy.remoteTopic'),
          baseUrl: ntfyFieldValue('surfaces.ntfy.baseUrl'),
        })
      : [];
    const title = `${surface.label.replace(/ surface$/i, '')} setup`;
    const setupSummary = setupCount === 0
      ? 'Suggested setup: none'
      : `Suggested setup entered: ${setupCompleteCount}/${setupCount}`;

    return {
      id: `external-surface:${surface.id}` as OnboardingWizardExternalSurfaceStepId,
      title,
      shortLabel: surface.label.replace(/ surface$/i, ''),
      description: `Configure ${surface.label}. Settings are saved either way; auto-start controls whether this surface starts with the background service.`,
      summaryTitle: `${surface.label} setup`,
      summaryLines: [
        `Auto-start: ${autoStartValue === 'yes' ? 'yes' : 'no'}`,
        ...ntfyTopicSummary,
        setupSummary,
        `Secret policy: ${controller.getStringFieldValue('external-services.secret-policy', controller.runtimeSnapshot?.runtimeDefaults.secretStoragePolicy ?? 'preferred_secure')}`,
        autoStartValue === 'yes'
          ? 'The surface will be enabled after apply.'
          : 'Start it later from Settings > Surfaces by turning Enabled on.',
      ],
      fields: [
        {
          kind: 'radio',
          id: autoStartFieldId,
          label: 'Auto-start this surface',
          hint: `Yes turns on ${surface.enabledConfigKey}. No saves setup values but keeps the surface off until Settings > Surfaces enables it.`,
          options: SURFACE_AUTO_START_OPTIONS,
          defaultValue: autoStartDefault,
        },
        ...setupFields,
      ],
    };
  }

export function buildAccessStep(controller: OnboardingWizardControllerLike): OnboardingWizardStepDefinition {
    const step = buildAccountsStep(controller);
    return {
      ...step,
      id: 'access',
      title: 'Access and accounts',
      shortLabel: 'Access',
    };
  }

export function buildExperienceStep(controller: OnboardingWizardControllerLike): OnboardingWizardStepDefinition {
    return {
      id: 'experience',
      title: 'Shell experience',
      shortLabel: 'Experience',
      description: 'Tune review noise, guidance, and permission posture for day-to-day use.',
      summaryTitle: 'Experience posture',
      summaryLines: [
        `Human-in-the-Loop (HITL): ${controller.getStringFieldValue('experience.hitl', controller.runtimeSnapshot?.runtimeDefaults.behavior.hitlMode ?? 'balanced')}`,
        `Guidance: ${controller.getStringFieldValue('experience.guidance', controller.runtimeSnapshot?.runtimeDefaults.behavior.guidanceMode ?? 'minimal')}`,
        `Permissions: ${controller.getStringFieldValue('experience.permissions', controller.runtimeSnapshot?.runtimeDefaults.permissionsMode ?? 'prompt')}`,
      ],
      fields: [
        {
          kind: 'radio',
          id: 'experience.hitl',
          label: 'How much GoodVibes tells you',
          hint: 'Choose how much operational activity should be surfaced.',
          options: HITL_MODE_OPTIONS,
          defaultValue: controller.runtimeSnapshot?.runtimeDefaults.behavior.hitlMode ?? 'balanced',
        },
        {
          kind: 'radio',
          id: 'experience.guidance',
          label: 'How much guidance it gives',
          hint: 'Choose how much explanation the shell should provide.',
          options: GUIDANCE_MODE_OPTIONS,
          defaultValue: controller.runtimeSnapshot?.runtimeDefaults.behavior.guidanceMode ?? 'minimal',
        },
        {
          kind: 'radio',
          id: 'experience.permissions',
          label: 'Who decides when it should ask',
          hint: 'Choose owner-reviewed safety, Jev-reviewed safety, or unrestricted YOLO execution.',
          options: PERMISSION_MODE_OPTIONS,
          defaultValue: normalizePermissionMode(controller.runtimeSnapshot?.runtimeDefaults.permissionsMode),
        },
      ],
    };
  }

export function buildNetworkStep(controller: OnboardingWizardControllerLike): OnboardingWizardStepDefinition {
    const bindSettings = controller.runtimeSnapshot?.bindSettings;
    const browserEnabled = controller.shouldEnableBrowserSurface();
    const listenerEnabled = controller.shouldExposeHttpListenerNetworkFields();
    const listenerWillApply = controller.shouldEnableHttpListener();
    const controlPlaneRemote = controller.shouldExposeControlPlaneNetwork();
    const networkEnabled = { controlPlane: controlPlaneRemote, httpListener: listenerEnabled, web: browserEnabled };
    const mode = controller.getStringFieldValue('network.mode', controller.runtimeDerived.step1_5NetworkMode);
    const custom = mode === 'custom';
    const fields: OnboardingWizardFieldDefinition[] = [
      {
        kind: 'radio',
        id: 'network.mode',
        label: 'Network mode',
        hint: 'Choose Local Network for the default LAN setup, or Custom to set IP addresses and ports.',
        options: NETWORK_MODE_OPTIONS,
        defaultValue: controller.runtimeDerived.step1_5NetworkMode,
      },
    ];

    // Recognize an adoptable already-running daemon (see onboarding-wizard-network-adopt.ts).
    const daemonSource = getDaemonSource(controller);
    pushDaemonAdoptionFields(fields, controller, daemonSource, bindSettings);

    if (custom) {
      const sharedIpField: OnboardingWizardChecklistFieldDefinition = {
        kind: 'checklist',
        id: 'network.shared-ip',
        label: 'Use the same IP address for all services',
        hint: 'When included, browser, GoodVibes service, and webhook listener network bindings share one IP address.',
        defaultValue: controller.getSharedIpDefault(networkEnabled),
      };
      const sharedIp = controller.getBooleanFieldValue(sharedIpField.id, sharedIpField.defaultValue);
      fields.push(sharedIpField);
      if (sharedIp) {
        fields.push({
          kind: 'text',
          id: 'network.shared-ip-address',
          label: 'Shared IP address',
          hint: 'IP address used by each enabled service.',
          placeholder: '0.0.0.0',
          defaultValue: controller.getSharedIpHostDefault(networkEnabled),
        });
      }

      if (controlPlaneRemote) {
        fields.push({
          kind: 'text',
          id: 'network.service-port',
          label: 'GoodVibes service port',
          hint: 'Port for the background service and control plane.',
          placeholder: '3421',
          defaultValue: String(bindSettings?.controlPlane.port ?? 3421),
        });
        if (!sharedIp) {
          fields.push({
            kind: 'text',
            id: 'network.service-ip',
            label: 'GoodVibes service IP address',
            hint: 'IP address for the background service and control plane.',
            placeholder: '0.0.0.0',
            defaultValue: normalizeText(bindSettings?.controlPlane.host) || '0.0.0.0',
          });
        }
      }

      if (browserEnabled) {
        fields.push({
          kind: 'text',
          id: 'network.browser-port',
          label: 'Browser surface port',
          hint: 'Port for browser access to GoodVibes.',
          placeholder: '3423',
          defaultValue: String(bindSettings?.web.port ?? 3423),
        });
        if (!sharedIp) {
          fields.push({
            kind: 'text',
            id: 'network.browser-ip',
            label: 'Browser surface IP address',
            hint: 'IP address for browser access.',
            placeholder: '0.0.0.0',
            defaultValue: normalizeText(bindSettings?.web.host) || '0.0.0.0',
          });
        }
      }

      if (listenerEnabled) {
        fields.push({
          kind: 'text',
          id: 'network.webhook-port',
          label: 'HTTP listener port',
          hint: 'Port for incoming webhooks and events.',
          placeholder: '3422',
          defaultValue: String(bindSettings?.httpListener.port ?? 3422),
        });
        if (!sharedIp) {
          fields.push({
            kind: 'text',
            id: 'network.webhook-ip',
            label: 'HTTP listener IP address',
            hint: 'IP address for incoming webhooks and events.',
            placeholder: '0.0.0.0',
            defaultValue: normalizeText(bindSettings?.httpListener.host) || '0.0.0.0',
          });
        }
      }
    }

    if (controlPlaneRemote || listenerEnabled || browserEnabled) { // TLS warn + CORS notice.
      const cpOff = controlPlaneRemote && String(controller.runtimeSnapshot?.config.controlPlane?.tls?.mode ?? 'off') === 'off';
      const hlOff = listenerEnabled && String(controller.runtimeSnapshot?.config.httpListener?.tls?.mode ?? 'off') === 'off';
      if (cpOff || hlOff) { const a = [cpOff ? 'control plane' : '', hlOff ? 'HTTP listener' : ''].filter(Boolean).join(' and '); fields.push({ kind: 'status', id: 'network.tls-warn', label: `TLS off: ${a} transmits plaintext`, defaultValue: 'Warning', hint: `The ${a} is network-reachable but TLS is off. Traffic travels in plaintext. Enable TLS or use a terminating reverse proxy.` }); }
      if (listenerEnabled) { fields.push({ kind: 'status', id: 'network.cors-note', label: 'Browser CORS is off by default', defaultValue: 'Info', hint: 'The webhook/control-plane HTTP listener honors controlPlane.cors.enabled and controlPlane.cors.allowedOrigins. Set both from Settings > Control Plane (or /settings controlPlane) to allow browser origins, then restart the daemon. CORS stays off until you enable it.' }); }
    }
    return {
      id: 'network',
      title: 'Network setup',
      shortLabel: 'Network',
      description: 'Choose the LAN default or customize IP addresses and ports for the enabled browser, service, and listener surfaces.',
      summaryTitle: 'Bind posture',
      summaryLines: [
        `Mode: ${custom ? 'custom' : 'local network default'}`,
        `Daemon source: ${daemonSource === 'adopt' ? 'connect to an existing running daemon' : 'start a new daemon'}`,
        `Browser surface: ${browserEnabled ? 'enabled' : 'not selected'}`,
        `HTTP listener: ${listenerWillApply ? 'enabled' : listenerEnabled ? 'available for selected external apps' : 'not selected'}`,
      ],
      fields,
    };
  }

export function buildAccountsStep(controller: OnboardingWizardControllerLike): OnboardingWizardStepDefinition {
    const subscriptionsAck = controller.runtimeDerived.reopenEditAcknowledgements.subscriptions;
    const authAck = controller.runtimeDerived.reopenEditAcknowledgements.auth;
    const auth = controller.runtimeSnapshot?.auth.snapshot;
    const needsAuthBootstrap = controller.requiresAuthBootstrap();
    const needsExistingAuthAcknowledgement = controller.hasServerCapabilitiesSelected()
      && !needsAuthBootstrap
      && controller.hasLocalAuthUser();
    const fields: OnboardingWizardFieldDefinition[] = [];
    const defaultAdminUsername = controller.getDefaultAdminUsername();

    fields.push(
      {
        kind: 'text',
        id: 'accounts.admin-username',
        label: 'Local auth admin username',
        hint: needsAuthBootstrap
          ? 'Required before any background service, browser surface, or listener is exposed.'
          : 'Optional. Enter an existing admin username to rotate its password, or a new username to create another admin.',
        placeholder: defaultAdminUsername,
        defaultValue: defaultAdminUsername,
        required: needsAuthBootstrap,
      },
      {
        kind: 'masked',
        id: 'accounts.admin-password',
        label: 'Local auth admin password',
        hint: needsAuthBootstrap
          ? controller.hasBootstrapCredentialPresent()
            ? 'Creates or updates the named local admin, removes the bootstrap credential file, and retires the bootstrap admin when it is a different user.'
            : 'Creates the first local admin user and an initial session before LAN/server settings are applied.'
          : 'Optional. Leave blank to keep existing local auth unchanged; enter a password to create or rotate the named admin user.',
        placeholder: needsAuthBootstrap ? 'password required' : 'leave blank to keep unchanged',
        defaultValue: '',
        required: needsAuthBootstrap,
      },
      {
        kind: 'masked',
        id: 'accounts.admin-password-confirm',
        label: 'Confirm local auth admin password',
        hint: 'Type the same password again. Nothing is created or rotated until both entries match, so one mistyped character cannot lock you out (a rotation signs the account out everywhere).',
        placeholder: 'type the password again',
        defaultValue: '',
        required: false,
      },
    );

    fields.push(
      {
        kind: 'acknowledgement',
        id: 'accounts.subscriptions',
        label: 'Confirm stored subscription state',
        hint: subscriptionsAck.detail,
        defaultValue: subscriptionsAck.accepted,
        required: controller.mode !== 'new' && subscriptionsAck.required,
        reason: subscriptionsAck.reason,
        target: 'subscriptions',
      },
      {
        kind: 'acknowledgement',
        id: 'accounts.auth',
        label: 'Confirm local auth posture',
        hint: authAck.detail,
        defaultValue: authAck.accepted,
        required: needsExistingAuthAcknowledgement || (controller.mode !== 'new' && authAck.required),
        reason: authAck.reason,
        target: 'auth',
      },
      {
        kind: 'status',
        id: 'accounts.bootstrap',
        label: 'Local auth readiness',
        hint: needsAuthBootstrap
          ? 'The wizard will create local auth before applying network-accessible settings.'
          : controller.hasAdminAuthUser()
            ? 'An existing local auth admin user was detected and will be kept.'
            : controller.hasLocalAuthUser()
              ? 'Existing local auth users were detected and will be kept.'
              : 'No server-backed capability is selected, so local auth is not required.',
        defaultValue: needsAuthBootstrap
          ? controller.hasBootstrapCredentialPresent() ? 'Bootstrap replacement required' : 'Local admin required'
          : controller.hasAdminAuthUser() ? 'Admin detected' : controller.hasLocalAuthUser() ? 'Local auth detected' : 'Not required',
      },
      {
        kind: 'status',
        id: 'accounts.user-store',
        label: 'Local auth store path',
        hint: 'Carry the current auth store location into edit/review mode.',
        defaultValue: normalizeText(auth?.userStorePath) || 'No local auth store path',
      },
    );

    return {
      id: 'access',
      title: 'Subscriptions and auth review',
      shortLabel: 'Accounts',
      description: needsAuthBootstrap
        ? 'Create wizard-owned local auth before any LAN, browser, service, or listener settings are applied.'
        : 'Review existing subscription and local auth state. Existing local auth is kept unless you change it elsewhere.',
      summaryTitle: 'Stored account state',
      summaryLines: [
        `Subscriptions: ${controller.runtimeSnapshot?.subscriptions.active.length ?? 0} active / ${controller.runtimeSnapshot?.subscriptions.pending.length ?? 0} pending`,
        `Auth: ${auth?.userCount ?? 0} users / ${auth?.sessionCount ?? 0} sessions`,
        needsAuthBootstrap
          ? controller.hasBootstrapCredentialPresent()
            ? 'Bootstrap credentials will be replaced before network settings are applied'
            : 'Local admin will be created before network settings are applied'
          : controller.hasLocalAuthUser() ? 'Existing local auth will be kept' : 'Local auth is not required for this setup',
      ],
      fields,
    };
  }
