import { formatProviderAuthRoute as format, formatProviderAuthRouteId, formatProviderAuthRouteLabel } from '@goodvibes-jev/engine/sdk/platform/providers/auth-route-presentation';
import type { ProviderAuthRouteDescriptor } from '@goodvibes-jev/engine/sdk/platform/providers';
export * from '@goodvibes-jev/engine/sdk/platform/providers/auth-route-presentation';
export const formatProviderAuthRoute = (route: ProviderAuthRouteDescriptor) => format(route, { id: formatProviderAuthRouteId, label: formatProviderAuthRouteLabel });
