// ============================================================================
// PROJECT COORDINATOR - Event broadcasting
// ============================================================================
//
// Handles event emission and cross-project event broadcasting.
//
// ============================================================================

import type { ProjectEvent } from './types.js';
import {
  getEventEmitter,
  getEventQueue,
  addEventToQueue,
  setEventQueue,
  getAllProjectIds,
} from './state.js';

// ============================================================================
// INTERNAL EVENT EMISSION
// ============================================================================

/**
 * Emit an internal coordinator event
 */
export function emitEvent(event: string, data: Record<string, unknown>): void {
  const eventEmitter = getEventEmitter();
  if (eventEmitter) {
    eventEmitter.emit(event, data);
    eventEmitter.emit('coordinator:*', { event, ...data });
  }
}

// ============================================================================
// EVENT BROADCASTING
// ============================================================================

/**
 * Broadcast an event to specific projects
 */
export function broadcastToProjects(
  type: string,
  data: Record<string, unknown>,
  targetProjectIds: number[],
  sourceProjectId?: number
): ProjectEvent {
  const event: ProjectEvent = {
    id: generateEventId(),
    type,
    sourceProjectId: sourceProjectId ?? null,
    targetProjectIds,
    data,
    timestamp: new Date(),
    handled: false,
  };

  addEventToQueue(event);
  processEventQueue();

  return event;
}

/**
 * Broadcast an event to all projects
 */
export function broadcastToAllProjects(
  type: string,
  data: Record<string, unknown>,
  sourceProjectId?: number
): ProjectEvent {
  const allProjectIds = getAllProjectIds();
  return broadcastToProjects(type, data, allProjectIds, sourceProjectId);
}

// ============================================================================
// EVENT QUERIES
// ============================================================================

/**
 * Get pending events for a project
 */
export function getPendingEventsForProject(projectId: number): ProjectEvent[] {
  const eventQueue = getEventQueue();
  return eventQueue.filter(
    e => !e.handled && e.targetProjectIds.includes(projectId)
  );
}

/**
 * Mark an event as handled
 */
export function markEventHandled(eventId: string): void {
  const eventQueue = getEventQueue();
  const event = eventQueue.find(e => e.id === eventId);
  if (event) {
    event.handled = true;
  }
}

// ============================================================================
// EVENT PROCESSING
// ============================================================================

/**
 * Process event queue
 */
export function processEventQueue(): void {
  const eventQueue = getEventQueue();
  const pendingEvents = eventQueue.filter(e => !e.handled);

  for (const event of pendingEvents) {
    for (const projectId of event.targetProjectIds) {
      emitEvent('coordinator:event-broadcast', {
        eventId: event.id,
        type: event.type,
        projectId,
        data: event.data,
      });
    }
  }

  // Clean up old handled events
  cleanupOldEvents();
}

/**
 * Generate unique event ID
 */
function generateEventId(): string {
  return `evt_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

// ============================================================================
// EVENT CLEANUP
// ============================================================================

/**
 * Clean up old handled events
 */
export function cleanupOldEvents(maxAgeMs: number = 60 * 60 * 1000): void {
  const cutoff = new Date(Date.now() - maxAgeMs);
  const eventQueue = getEventQueue();

  const filteredQueue = eventQueue.filter(
    e => !e.handled || e.timestamp > cutoff
  );

  setEventQueue(filteredQueue);
}
