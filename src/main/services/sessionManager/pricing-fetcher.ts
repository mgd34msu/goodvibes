// ============================================================================
// PRICING FETCHER - Automatic pricing updates from Anthropic
// Supports historical pricing so sessions retain their original costs
// ============================================================================

import fs from 'fs';
import path from 'path';
import https from 'https';

// ============================================================================
// TYPES
// ============================================================================

export interface ModelPricing {
  input: number;
  output: number;
  cacheWrite5m?: number;
  cacheWrite1h?: number;
  cacheRead?: number;
}

/**
 * A single pricing entry with an effective date.
 * Used to track pricing changes over time.
 */
export interface PricingEntry {
  /** ISO date string when this pricing became effective */
  effectiveDate: string;
  /** Model pricing data for this period */
  models: Record<string, ModelPricing>;
}

/**
 * Cache structure that stores pricing history.
 * Allows historical sessions to use their original pricing.
 */
export interface PricingCache {
  /** When we last fetched from Anthropic */
  lastFetchedAt: string;
  /** Pricing history sorted by effectiveDate descending (newest first) */
  history: PricingEntry[];
}

// ============================================================================
// CONSTANTS
// ============================================================================

const PRICING_URL = 'https://platform.claude.com/docs/en/about-claude/pricing.md';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// Fallback pricing from constants.ts
const FALLBACK_PRICING: Record<string, ModelPricing> = {
  'claude-opus-4-5': { input: 5, output: 25 },
  'claude-opus-4-1': { input: 15, output: 75 },
  'claude-opus-4': { input: 15, output: 75 },
  'claude-opus-3': { input: 15, output: 75 },
  'claude-sonnet-4-5': { input: 3, output: 15 },
  'claude-sonnet-4': { input: 3, output: 15 },
  'claude-sonnet-3-7': { input: 3, output: 15 },
  'claude-sonnet-3-5': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
  'claude-haiku-3-5': { input: 0.8, output: 4 },
  'claude-haiku-3': { input: 0.25, output: 1.25 },
};

// ============================================================================
// CACHE MANAGEMENT
// ============================================================================

function getCachePath(): string {
  const homeDir = process.env.HOME || process.env.USERPROFILE || '';
  const configDir = path.join(homeDir, '.config', 'goodvibes');
  
  // Ensure directory exists
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }
  
  return path.join(configDir, 'pricing-cache.json');
}

/**
 * Loads full cache with history. Returns null only if file doesn't exist or is corrupted.
 * Does NOT check TTL - that's handled by the fetch logic.
 */
function loadFullCache(): PricingCache | null {
  try {
    const cachePath = getCachePath();
    if (!fs.existsSync(cachePath)) {
      return null;
    }
    
    const data = fs.readFileSync(cachePath, 'utf-8');
    const cache = JSON.parse(data) as PricingCache;
    
    // Migrate old format to new format if needed
    if (!cache.history && (cache as any).models) {
      const oldCache = cache as any;
      return {
        lastFetchedAt: oldCache.fetchedAt || new Date().toISOString(),
        history: [{
          effectiveDate: oldCache.fetchedAt || new Date().toISOString(),
          models: oldCache.models,
        }],
      };
    }
    
    return cache;
  } catch (error) {
    console.error('Failed to load pricing cache:', error);
    return null;
  }
}

/**
 * Checks if we need to fetch new pricing (TTL expired)
 */
function isCacheExpired(cache: PricingCache): boolean {
  const fetchedAt = new Date(cache.lastFetchedAt).getTime();
  const now = Date.now();
  return now - fetchedAt > CACHE_TTL_MS;
}

function saveCache(cache: PricingCache): void {
  try {
    const cachePath = getCachePath();
    fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2), 'utf-8');
  } catch (error) {
    console.error('Failed to save pricing cache:', error);
  }
}

// ============================================================================
// PRICING FETCH AND PARSE
// ============================================================================

function fetchPricingMarkdown(): Promise<string> {
  return new Promise((resolve, reject) => {
    https.get(PRICING_URL, (res) => {
      let data = '';
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        resolve(data);
      });
    }).on('error', (error) => {
      reject(error);
    });
  });
}

function parseModelName(rawName: string): string {
  // Convert "Claude Opus 4.5" -> "claude-opus-4-5"
  return rawName
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/\./g, '-');
}

function parsePrice(priceStr: string): number {
  // Extract number from "$5 / MTok" or "$6.25 / MTok"
  const match = priceStr.match(/\$([\d.]+)/);
  return match ? parseFloat(match[1]) : 0;
}

function parsePricingTable(markdown: string): Record<string, ModelPricing> {
  const pricing: Record<string, ModelPricing> = {};
  
  // Find table rows - format: | Claude Opus 4.5 | $5 / MTok | $25 / MTok | $6.25 / MTok | $12.50 / MTok | $0.50 / MTok |
  const tableRows = markdown.match(/^\|\s*Claude[^|]+\|[^\n]+$/gm);
  
  if (!tableRows) {
    throw new Error('Could not find pricing table in markdown');
  }
  
  for (const row of tableRows) {
    const cells = row.split('|').map(c => c.trim()).filter(c => c);
    
    if (cells.length < 6) continue;
    
    const modelName = parseModelName(cells[0]);
    // Updated column mapping for new table format:
    // Column 1: Base Input Tokens
    // Column 2: 5m Cache Writes  
    // Column 3: 1h Cache Writes
    // Column 4: Cache Hits & Refreshes
    // Column 5: Output Tokens
    const inputPrice = parsePrice(cells[1]);
    const outputPrice = parsePrice(cells[5]);
    
    // Optional cache pricing columns
    const cacheWrite5m = cells[2] ? parsePrice(cells[2]) : undefined;
    const cacheWrite1h = cells[3] ? parsePrice(cells[3]) : undefined;
    const cacheRead = cells[4] ? parsePrice(cells[4]) : undefined;
    
    pricing[modelName] = {
      input: inputPrice,
      output: outputPrice,
      ...(cacheWrite5m && { cacheWrite5m }),
      ...(cacheWrite1h && { cacheWrite1h }),
      ...(cacheRead && { cacheRead }),
    };
  }
  
  return pricing;
}

/**
 * Compares two pricing records to detect changes.
 * Returns true if there are meaningful differences.
 */
function hasPricingChanged(
  oldPricing: Record<string, ModelPricing>,
  newPricing: Record<string, ModelPricing>
): boolean {
  // Check for new models
  const oldModels = Object.keys(oldPricing);
  const newModels = Object.keys(newPricing);
  
  if (oldModels.length !== newModels.length) return true;
  
  // Check each model's pricing
  for (const model of newModels) {
    const oldPrice = oldPricing[model];
    const newPrice = newPricing[model];
    
    if (!oldPrice) return true; // New model
    
    // Compare prices (using small epsilon for floating point)
    const epsilon = 0.001;
    if (Math.abs(oldPrice.input - newPrice.input) > epsilon) return true;
    if (Math.abs(oldPrice.output - newPrice.output) > epsilon) return true;
    
    // Compare cache pricing if present
    if (newPrice.cacheWrite5m !== undefined && oldPrice.cacheWrite5m !== undefined) {
      if (Math.abs(oldPrice.cacheWrite5m - newPrice.cacheWrite5m) > epsilon) return true;
    }
    if (newPrice.cacheWrite1h !== undefined && oldPrice.cacheWrite1h !== undefined) {
      if (Math.abs(oldPrice.cacheWrite1h - newPrice.cacheWrite1h) > epsilon) return true;
    }
    if (newPrice.cacheRead !== undefined && oldPrice.cacheRead !== undefined) {
      if (Math.abs(oldPrice.cacheRead - newPrice.cacheRead) > epsilon) return true;
    }
  }
  
  return false;
}

/**
 * Fetches pricing from Anthropic and updates the cache history.
 * Only adds a new entry if pricing has actually changed.
 */
async function fetchAndUpdateCache(): Promise<PricingCache> {
  const existingCache = loadFullCache();
  const now = new Date().toISOString();
  
  try {
    const markdown = await fetchPricingMarkdown();
    const newPricing = parsePricingTable(markdown);
    
    // Get the most recent pricing from history
    const latestPricing = existingCache?.history?.[0]?.models;
    
    // Check if pricing has changed
    const hasChanged = !latestPricing || hasPricingChanged(latestPricing, newPricing);
    
    if (hasChanged) {
      // Create new history entry
      const newEntry: PricingEntry = {
        effectiveDate: now,
        models: newPricing,
      };
      
      // Prepend to history (newest first)
      const history = existingCache?.history || [];
      const updatedCache: PricingCache = {
        lastFetchedAt: now,
        history: [newEntry, ...history],
      };
      
      saveCache(updatedCache);
      console.log(`Pricing updated: ${Object.keys(newPricing).length} models, new entry added`);
      return updatedCache;
    } else {
      // No price changes, just update the fetch timestamp
      const updatedCache: PricingCache = {
        lastFetchedAt: now,
        history: existingCache?.history || [],
      };
      
      saveCache(updatedCache);
      console.log(`Pricing checked: no changes detected`);
      return updatedCache;
    }
  } catch (error) {
    console.error('Failed to fetch pricing from Anthropic:', error);
    
    // Return existing cache or create fallback
    if (existingCache && existingCache.history.length > 0) {
      return existingCache;
    }
    
    // Create fallback cache with hardcoded pricing
    return {
      lastFetchedAt: now,
      history: [{
        effectiveDate: '2024-01-01T00:00:00.000Z', // Historical baseline
        models: FALLBACK_PRICING,
      }],
    };
  }
}

/**
 * Gets pricing for a specific date from the history.
 * Returns the pricing that was in effect at that time.
 */
function getPricingForDate(
  cache: PricingCache,
  targetDate: string | Date
): Record<string, ModelPricing> {
  const targetTime = new Date(targetDate).getTime();
  
  // Find the pricing entry that was in effect at the target date
  // History is sorted newest first, so find the first entry <= target date
  for (const entry of cache.history) {
    const entryTime = new Date(entry.effectiveDate).getTime();
    if (entryTime <= targetTime) {
      return entry.models;
    }
  }
  
  // If no entry found (target date before all entries), use oldest entry
  const oldest = cache.history[cache.history.length - 1];
  return oldest?.models || FALLBACK_PRICING;
}

// ============================================================================
// PUBLIC API
// ============================================================================

let cachedPricingData: PricingCache | null = null;

/**
 * Ensures pricing cache is loaded and up-to-date.
 * Fetches from Anthropic if cache is expired or missing.
 */
async function ensureCacheLoaded(): Promise<PricingCache> {
  // Load from disk if not in memory
  if (!cachedPricingData) {
    cachedPricingData = loadFullCache();
  }
  
  // Fetch from Anthropic if missing or expired
  if (!cachedPricingData || isCacheExpired(cachedPricingData)) {
    cachedPricingData = await fetchAndUpdateCache();
  }
  
  return cachedPricingData;
}

/**
 * Get pricing for a specific model.
 * 
 * @param model - Model identifier (e.g., "claude-opus-4-5")
 * @param asOfDate - Optional date to get historical pricing (defaults to now)
 * @returns Pricing information for the model, or undefined if not found
 */
export async function getPricing(
  model: string,
  asOfDate?: string | Date
): Promise<ModelPricing | undefined> {
  const cache = await ensureCacheLoaded();
  
  // Get pricing for the specified date (or current if not specified)
  const pricing = getPricingForDate(cache, asOfDate || new Date());
  
  return pricing[model];
}

/**
 * Get all available model pricing.
 * 
 * @param asOfDate - Optional date to get historical pricing (defaults to now)
 * @returns Record of all model pricing
 */
export async function getAllPricing(
  asOfDate?: string | Date
): Promise<Record<string, ModelPricing>> {
  const cache = await ensureCacheLoaded();
  return getPricingForDate(cache, asOfDate || new Date());
}

/**
 * Get the full pricing cache with history.
 * Useful for debugging or displaying pricing timeline.
 */
export async function getPricingHistory(): Promise<PricingCache> {
  return ensureCacheLoaded();
}

/**
 * Force refresh pricing from Anthropic, bypassing cache TTL.
 */
export async function refreshPricing(): Promise<void> {
  cachedPricingData = await fetchAndUpdateCache();
}
