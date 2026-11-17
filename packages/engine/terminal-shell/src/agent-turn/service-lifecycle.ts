/**
 * When to install, start or restart the host service, and what counts as
 * success, in one place. The operator-method tool applies it to every
 * services.* receipt it returns; setup names the same criteria on its repair
 * cards and points at that receipt instead of restating the rule.
 */

export type ServiceMethodId = 'services.status' | 'services.install' | 'services.start' | 'services.restart';

export const SERVICE_METHOD_IDS: ReadonlySet<string> = new Set<ServiceMethodId>(['services.status', 'services.install', 'services.start', 'services.restart']);

export function isServiceMethodId(methodId: string): methodId is ServiceMethodId {
  return SERVICE_METHOD_IDS.has(methodId);
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function serviceMethodRoute(methodId: ServiceMethodId): string {
  return `agent_operator_method methodId:"${methodId}" input:{}`;
}

export const SERVICE_RECOVERY_ROUTE = 'setup action:"item" setupItemId:"connected-host-readiness" includeParameters:true';

export interface ServiceExpectedOutcome {
  readonly target: string;
  readonly successCriteria: readonly string[];
  readonly evidenceFields: readonly string[];
  readonly verificationRoute: string;
  readonly recoveryRoute: string;
}

/** What a successful call of this method looks like in its receipt. */
export function serviceExpectedOutcome(methodId: ServiceMethodId): ServiceExpectedOutcome {
  const target = methodId === 'services.status' ? 'read-current-posture'
    : methodId === 'services.install' ? 'installed-service'
      : methodId === 'services.start' ? 'running-service' : 'restarted-running-service';
  const successCriteria = methodId === 'services.status'
    ? ['The receipt has installed, autostart and running booleans.', 'The receipt has no actionError.']
    : [
      methodId === 'services.install' ? 'The receipt reports installed:true.' : 'The receipt reports running:true.',
      'The receipt has no actionError.',
      `Read ${serviceMethodRoute('services.status')} before retrying a lifecycle action.`,
    ];
  return {
    target,
    successCriteria,
    evidenceFields: ['installed', 'autostart', 'running', 'pid', 'lastAction', 'actionError', 'network.controlPlane.ready'],
    verificationRoute: serviceMethodRoute('services.status'),
    recoveryRoute: SERVICE_RECOVERY_ROUTE,
  };
}

export function serviceReceiptEvidence(body: unknown): JsonRecord {
  if (!isRecord(body)) return { receipt: 'not-json-object' };
  const network = isRecord(body.network) ? body.network : {};
  const controlPlane = isRecord(network.controlPlane) ? network.controlPlane : {};
  return {
    installed: typeof body.installed === 'boolean' ? body.installed : null,
    autostart: typeof body.autostart === 'boolean' ? body.autostart : null,
    running: typeof body.running === 'boolean' ? body.running : null,
    pid: typeof body.pid === 'number' ? body.pid : null,
    lastAction: typeof body.lastAction === 'string' ? body.lastAction : null,
    actionError: typeof body.actionError === 'string' ? body.actionError : null,
    controlPlaneReady: typeof controlPlane.ready === 'boolean' ? controlPlane.ready : null,
  };
}

/** The lifecycle decision a services.status receipt supports: install, start, restart or nothing. */
export function serviceLifecycleDecisionFromStatus(body: unknown): JsonRecord {
  const common = { evidence: serviceReceiptEvidence(body), statusRoute: serviceMethodRoute('services.status'), setupRoute: SERVICE_RECOVERY_ROUTE };
  if (!isRecord(body)) {
    return { status: 'needs-follow-up', action: 'read-status', reason: 'The service status receipt was not a JSON object.', modelRoute: serviceMethodRoute('services.status'), ...common };
  }
  const actionError = typeof body.actionError === 'string' ? body.actionError.trim() : '';
  if (actionError) {
    return { status: 'needs-diagnostics', action: 'inspect-diagnostics', reason: 'The service status receipt includes actionError; inspect diagnostics before any lifecycle mutation.', modelRoute: 'host action:"services" includeParameters:true', ...common };
  }
  if (typeof body.installed !== 'boolean' || typeof body.running !== 'boolean' || typeof body.autostart !== 'boolean') {
    return { status: 'needs-follow-up', action: 'read-status', reason: 'The service status receipt is missing installed, autostart, or running booleans.', modelRoute: serviceMethodRoute('services.status'), ...common };
  }
  if (body.installed === false) {
    return { status: 'action-recommended', action: 'install-service', methodId: 'services.install', modelRoute: serviceMethodRoute('services.install'), reason: 'services.status reports installed:false.', ...common };
  }
  if (body.running === false) {
    return { status: 'action-recommended', action: 'start-service', methodId: 'services.start', modelRoute: serviceMethodRoute('services.start'), reason: 'services.status reports installed:true and running:false.', ...common };
  }
  const network = isRecord(body.network) ? body.network : {};
  const controlPlane = isRecord(network.controlPlane) ? network.controlPlane : {};
  if (controlPlane.ready === false) {
    return { status: 'action-recommended', action: 'restart-service', methodId: 'services.restart', modelRoute: serviceMethodRoute('services.restart'), reason: 'services.status reports the service is installed and running, but network.controlPlane.ready:false.', ...common };
  }
  return { status: 'no-action-needed', action: 'none', reason: 'services.status reports the service is installed and running with no failed control-plane readiness evidence.', modelRoute: 'host action:"status" includeParameters:true', ...common };
}

/** The decision a services.* call's receipt supports; a mutation's receipt is verified with services.status. */
export function serviceLifecycleDecision(methodId: ServiceMethodId, responseOk: boolean, body: unknown): JsonRecord {
  if (!responseOk) {
    return {
      status: 'needs-follow-up',
      action: 'read-status',
      reason: `The ${methodId} daemon call failed; do not retry a lifecycle mutation until services.status or host action:"services" explains the failure.`,
      evidence: serviceReceiptEvidence(body),
      statusRoute: serviceMethodRoute('services.status'),
      setupRoute: SERVICE_RECOVERY_ROUTE,
      modelRoute: 'host action:"services" includeParameters:true',
    };
  }
  if (methodId === 'services.status') return serviceLifecycleDecisionFromStatus(body);
  return {
    status: 'verify-status',
    action: 'read-status',
    reason: `${methodId} returned a receipt; verify services.status before closing or advancing setup.`,
    evidence: serviceReceiptEvidence(body),
    statusRoute: serviceMethodRoute('services.status'),
    setupRoute: SERVICE_RECOVERY_ROUTE,
    modelRoute: serviceMethodRoute('services.status'),
  };
}

/** True when the receipt meets the method's success criteria. */
export function serviceOutcomeCertified(methodId: ServiceMethodId, responseOk: boolean, body: unknown): boolean {
  if (!responseOk || !isRecord(body) || (typeof body.actionError === 'string' && body.actionError.trim())) return false;
  if (methodId === 'services.status') {
    return typeof body.installed === 'boolean'
      && typeof body.autostart === 'boolean'
      && typeof body.running === 'boolean';
  }
  if (methodId === 'services.install') return body.installed === true;
  if (methodId === 'services.start') return body.running === true;
  return body.running === true;
}
