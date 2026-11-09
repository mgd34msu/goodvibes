// The live daemon route dispatch is daemon-api's; this barrel re-exports it.
// The former platform-local dispatcher copies (automation/tasks/operator/remote/
// sessions + their context types) were a superseded, unreachable parallel,
// deleted in the session-spine integration cleanup (see CHANGELOG 1.0.0; 0 callers, 0 api.md
// presence; every test imports the daemon-api originals). Pay-its-way rule.
export { dispatchDaemonApiRoutes } from './api-router.js';
