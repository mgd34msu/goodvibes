import type { ProviderAuthRouteDescriptor } from './interface.js';

function routeUsable(route: ProviderAuthRouteDescriptor): boolean {
  return route.usable ?? route.configured;
}

export function summarizeProviderAuthRoutes(routes: readonly ProviderAuthRouteDescriptor[] | undefined): string {
  if (!routes?.length) return 'n/a';
  const configured = routes.filter((route) => route.configured).length;
  const usable = routes.filter(routeUsable).length;
  return `${configured}/${routes.length} configured, ${usable}/${routes.length} usable`;
}

export interface ProviderAuthRoutePresentation {
  readonly id: (route: string) => string;
  readonly label: (route: string, label: string) => string;
}
export function formatProviderAuthRoute(route: ProviderAuthRouteDescriptor, presentation?: ProviderAuthRoutePresentation): string {
  const status = [
    route.configured ? 'configured' : 'not configured',
    routeUsable(route) ? 'usable' : 'not usable',
    route.freshness,
  ].filter((part): part is string => Boolean(part));
  const detail = route.detail?.trim();
  return `${presentation?.label(route.route, route.label) ?? route.label} [${presentation?.id(route.route) ?? route.route}; ${status.join(', ')}]${detail ? ` - ${detail}` : ''}`;
}

export function formatProviderAuthRouteId(route: string): string {
  return route === 'service-oauth' ? 'provider-oauth' : route;
}

export function formatProviderAuthRouteLabel(route: string, label?: string): string {
  if (route === 'service-oauth') return 'Provider OAuth';
  const trimmed = label?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : formatProviderAuthRouteId(route);
}
