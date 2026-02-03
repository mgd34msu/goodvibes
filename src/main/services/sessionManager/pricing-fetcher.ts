// ============================================================================
// PRICING FETCHER - Automatic pricing updates from Anthropic
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

export interface PricingCache {
  fetchedAt: string;
  models: Record<string, ModelPricing>;
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

function loadCache(): PricingCache | null {
  try {
    const cachePath = getCachePath();
    if (!fs.existsSync(cachePath)) {
      return null;
    }
    
    const data = fs.readFileSync(cachePath, 'utf-8');
    const cache = JSON.parse(data) as PricingCache;
    
    // Check if cache is expired
    const fetchedAt = new Date(cache.fetchedAt).getTime();
    const now = Date.now();
    
    if (now - fetchedAt > CACHE_TTL_MS) {
      return null; // Cache expired
    }
    
    return cache;
  } catch (error) {
    console.error('Failed to load pricing cache:', error);
    return null;
  }
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
    
    if (cells.length < 3) continue;
    
    const modelName = parseModelName(cells[0]);
    const inputPrice = parsePrice(cells[1]);
    const outputPrice = parsePrice(cells[2]);
    
    // Optional cache pricing columns
    const cacheWrite5m = cells[3] ? parsePrice(cells[3]) : undefined;
    const cacheWrite1h = cells[4] ? parsePrice(cells[4]) : undefined;
    const cacheRead = cells[5] ? parsePrice(cells[5]) : undefined;
    
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

async function fetchAndCachePricing(): Promise<Record<string, ModelPricing>> {
  try {
    const markdown = await fetchPricingMarkdown();
    const pricing = parsePricingTable(markdown);
    
    // Save to cache
    const cache: PricingCache = {
      fetchedAt: new Date().toISOString(),
      models: pricing,
    };
    
    saveCache(cache);
    
    return pricing;
  } catch (error) {
    console.error('Failed to fetch pricing from Anthropic:', error);
    return FALLBACK_PRICING;
  }
}

// ============================================================================
// PUBLIC API
// ============================================================================

let pricingData: Record<string, ModelPricing> | null = null;

/**
 * Get pricing for a specific model.
 * 
 * Fetches from cache if available and not expired.
 * If cache is expired or missing, fetches from Anthropic.
 * Falls back to hardcoded values if fetch fails.
 * 
 * @param model - Model identifier (e.g., "claude-opus-4-5")
 * @returns Pricing information for the model, or undefined if not found
 */
export async function getPricing(model: string): Promise<ModelPricing | undefined> {
  // Initialize pricing data if not loaded
  if (!pricingData) {
    const cache = loadCache();
    
    if (cache) {
      pricingData = cache.models;
    } else {
      pricingData = await fetchAndCachePricing();
    }
  }
  
  return pricingData[model];
}

/**
 * Get all available model pricing.
 * 
 * @returns Record of all model pricing
 */
export async function getAllPricing(): Promise<Record<string, ModelPricing>> {
  if (!pricingData) {
    const cache = loadCache();
    
    if (cache) {
      pricingData = cache.models;
    } else {
      pricingData = await fetchAndCachePricing();
    }
  }
  
  return pricingData;
}

/**
 * Force refresh pricing from Anthropic, bypassing cache.
 */
export async function refreshPricing(): Promise<void> {
  pricingData = await fetchAndCachePricing();
}
