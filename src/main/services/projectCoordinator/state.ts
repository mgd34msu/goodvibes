// ============================================================================
// PROJECT COORDINATOR - State management
// ============================================================================
//
// Centralized state storage and accessor functions for the project coordinator.
// This module owns all mutable state and provides controlled access.
//
// ============================================================================

import { EventEmitter } from 'events';
import type {
  CrossProjectAgent,
  SharedSkillConfig,
  ProjectState,
  ProjectEvent,
} from './types.js';

// ============================================================================
// SERVICE STATE
// ============================================================================

let crossProjectAgents: Map<number, CrossProjectAgent> = new Map();
let sharedSkillConfigs: Map<number, SharedSkillConfig> = new Map();
let projectStates: Map<number, ProjectState> = new Map();
let eventQueue: ProjectEvent[] = [];
let eventEmitter: EventEmitter | null = null;
let initialized = false;

// ============================================================================
// STATE ACCESSORS
// ============================================================================

/**
 * Check if the coordinator is initialized
 */
export function isInitialized(): boolean {
  return initialized;
}

/**
 * Set initialized state
 */
export function setInitialized(value: boolean): void {
  initialized = value;
}

/**
 * Get the event emitter instance
 */
export function getEventEmitter(): EventEmitter | null {
  return eventEmitter;
}

/**
 * Set the event emitter instance
 */
export function setEventEmitter(emitter: EventEmitter): void {
  eventEmitter = emitter;
}

/**
 * Ensure event emitter exists, creating if needed
 */
export function ensureEventEmitter(): EventEmitter {
  if (!eventEmitter) {
    eventEmitter = new EventEmitter();
  }
  return eventEmitter;
}

// ============================================================================
// CROSS-PROJECT AGENTS STATE
// ============================================================================

/**
 * Get the cross-project agents map
 */
export function getCrossProjectAgentsMap(): Map<number, CrossProjectAgent> {
  return crossProjectAgents;
}

/**
 * Get a specific cross-project agent
 */
export function getCrossProjectAgent(agentId: number): CrossProjectAgent | undefined {
  return crossProjectAgents.get(agentId);
}

/**
 * Set a cross-project agent
 */
export function setCrossProjectAgent(agentId: number, agent: CrossProjectAgent): void {
  crossProjectAgents.set(agentId, agent);
}

/**
 * Delete a cross-project agent
 */
export function deleteCrossProjectAgent(agentId: number): boolean {
  return crossProjectAgents.delete(agentId);
}

/**
 * Get all cross-project agents as an array
 */
export function getAllCrossProjectAgents(): CrossProjectAgent[] {
  return Array.from(crossProjectAgents.values());
}

/**
 * Get cross-project agents entries
 */
export function getCrossProjectAgentEntries(): IterableIterator<[number, CrossProjectAgent]> {
  return crossProjectAgents.entries();
}

/**
 * Get the count of cross-project agents
 */
export function getCrossProjectAgentCount(): number {
  return crossProjectAgents.size;
}

// ============================================================================
// SHARED SKILL CONFIGS STATE
// ============================================================================

/**
 * Get the shared skill configs map
 */
export function getSharedSkillConfigsMap(): Map<number, SharedSkillConfig> {
  return sharedSkillConfigs;
}

/**
 * Get a specific shared skill config
 */
export function getSharedSkillConfigFromState(skillId: number): SharedSkillConfig | undefined {
  return sharedSkillConfigs.get(skillId);
}

/**
 * Set a shared skill config
 */
export function setSharedSkillConfig(skillId: number, config: SharedSkillConfig): void {
  sharedSkillConfigs.set(skillId, config);
}

/**
 * Delete a shared skill config
 */
export function deleteSharedSkillConfig(skillId: number): boolean {
  return sharedSkillConfigs.delete(skillId);
}

/**
 * Get all shared skill configs as an array
 */
export function getAllSharedSkillConfigsFromState(): SharedSkillConfig[] {
  return Array.from(sharedSkillConfigs.values());
}

/**
 * Get the count of shared skill configs
 */
export function getSharedSkillConfigCount(): number {
  return sharedSkillConfigs.size;
}

// ============================================================================
// PROJECT STATES
// ============================================================================

/**
 * Get the project states map
 */
export function getProjectStatesMap(): Map<number, ProjectState> {
  return projectStates;
}

/**
 * Get a specific project state
 */
export function getProjectStateFromMap(projectId: number): ProjectState | undefined {
  return projectStates.get(projectId);
}

/**
 * Set a project state
 */
export function setProjectState(projectId: number, state: ProjectState): void {
  projectStates.set(projectId, state);
}

/**
 * Delete a project state
 */
export function deleteProjectState(projectId: number): boolean {
  return projectStates.delete(projectId);
}

/**
 * Get all project states as an array
 */
export function getAllProjectStatesFromMap(): ProjectState[] {
  return Array.from(projectStates.values());
}

/**
 * Get all project IDs
 */
export function getAllProjectIds(): number[] {
  return Array.from(projectStates.keys());
}

// ============================================================================
// EVENT QUEUE STATE
// ============================================================================

/**
 * Get the event queue
 */
export function getEventQueue(): ProjectEvent[] {
  return eventQueue;
}

/**
 * Add an event to the queue
 */
export function addEventToQueue(event: ProjectEvent): void {
  eventQueue.push(event);
}

/**
 * Set the event queue (for cleanup operations)
 */
export function setEventQueue(queue: ProjectEvent[]): void {
  eventQueue = queue;
}

/**
 * Get pending events count
 */
export function getPendingEventCount(): number {
  return eventQueue.filter(e => !e.handled).length;
}
