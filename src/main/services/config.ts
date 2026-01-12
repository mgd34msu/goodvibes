// ============================================================================
// CONFIGURATION MANAGEMENT SERVICE
// ============================================================================

import fs from 'fs';
import path from 'path';
import { app } from 'electron';
import { Logger } from './logger.js';

const logger = new Logger('Config');

export interface AppConfig {
  // Application
  version: string;
  environment: 'development' | 'production' | 'test';

  // Paths
  paths: {
    userData: string;
    logs: string;
    database: string;
    sessions: string;
  };

  // Features
  features: {
    sessionWatching: boolean;
    autoUpdate: boolean;
    telemetry: boolean;
  };

  // Limits
  limits: {
    maxTerminals: number;
    maxSessionMessageCache: number;
    sessionScanBatchSize: number;
    databaseVacuumIntervalMs: number;
  };

  // Logging
  logging: {
    level: 'debug' | 'info' | 'warn' | 'error';
    enableFile: boolean;
    maxFiles: number;
  };

  // Performance
  performance: {
    enableVirtualScrolling: boolean;
    sessionListPageSize: number;
    debounceSearchMs: number;
  };
}

// Default configuration
const defaultConfig: AppConfig = {
  version: app.getVersion?.() || '1.0.0',
  environment: (process.env.NODE_ENV as AppConfig['environment']) || 'development',

  paths: {
    userData: '',
    logs: '',
    database: '',
    sessions: '',
  },

  features: {
    sessionWatching: true,
    autoUpdate: true,
    telemetry: false,
  },

  limits: {
    maxTerminals: 20,
    maxSessionMessageCache: 1000,
    sessionScanBatchSize: 100,
    databaseVacuumIntervalMs: 24 * 60 * 60 * 1000, // 24 hours
  },

  logging: {
    level: 'info',
    enableFile: true,
    maxFiles: 5,
  },

  performance: {
    enableVirtualScrolling: true,
    sessionListPageSize: 50,
    debounceSearchMs: 300,
  },
};

class ConfigManager {
  private config: AppConfig;
  private configPath: string;
  private initialized: boolean = false;

  constructor() {
    this.config = { ...defaultConfig };
    this.configPath = '';
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      // Set up paths
      const userData = app.getPath('userData');
      this.configPath = path.join(userData, 'config.json');

      this.config.paths = {
        userData,
        logs: path.join(userData, 'logs'),
        database: path.join(userData, 'goodvibes.db'),
        sessions: this.getSessionsPath(),
      };

      // Load user config if exists
      await this.loadConfig();

      // Apply environment overrides
      this.applyEnvironmentOverrides();

      this.initialized = true;
      logger.info('Configuration initialized', { configPath: this.configPath });
    } catch (error) {
      logger.error('Failed to initialize config', error);
      throw error;
    }
  }

  private getSessionsPath(): string {
    const homeDir = process.env.HOME || process.env.USERPROFILE || '';

    // Check common locations for Claude sessions
    const possiblePaths = [
      path.join(homeDir, '.claude', 'projects'),
      path.join(homeDir, 'AppData', 'Roaming', 'Claude', 'projects'),
      path.join(homeDir, '.config', 'claude', 'projects'),
    ];

    for (const p of possiblePaths) {
      if (fs.existsSync(p)) {
        return p;
      }
    }

    // Default to first option
    return possiblePaths[0];
  }

  private async loadConfig(): Promise<void> {
    try {
      if (fs.existsSync(this.configPath)) {
        const content = await fs.promises.readFile(this.configPath, 'utf-8');
        const userConfig = JSON.parse(content);
        this.config = this.mergeConfig(this.config, userConfig);
        logger.debug('Loaded user config');
      }
    } catch (error) {
      logger.warn('Failed to load user config, using defaults', error);
    }
  }

  private mergeConfig(base: AppConfig, override: Partial<AppConfig>): AppConfig {
    return {
      ...base,
      ...override,
      paths: { ...base.paths, ...override.paths },
      features: { ...base.features, ...override.features },
      limits: { ...base.limits, ...override.limits },
      logging: { ...base.logging, ...override.logging },
      performance: { ...base.performance, ...override.performance },
    };
  }

  private applyEnvironmentOverrides(): void {
    // Environment variable overrides
    if (process.env.CLAUSITRON_LOG_LEVEL) {
      this.config.logging.level = process.env.CLAUSITRON_LOG_LEVEL as AppConfig['logging']['level'];
    }

    if (process.env.CLAUSITRON_SESSIONS_PATH) {
      this.config.paths.sessions = process.env.CLAUSITRON_SESSIONS_PATH;
    }

    // Development overrides
    if (this.config.environment === 'development') {
      this.config.logging.level = 'debug';
      this.config.logging.enableFile = false;
    }

    // Test overrides
    if (this.config.environment === 'test') {
      this.config.features.telemetry = false;
      this.config.features.autoUpdate = false;
    }
  }

  async saveConfig(): Promise<void> {
    try {
      const configDir = path.dirname(this.configPath);
      if (!fs.existsSync(configDir)) {
        await fs.promises.mkdir(configDir, { recursive: true });
      }

      await fs.promises.writeFile(
        this.configPath,
        JSON.stringify(this.config, null, 2),
        'utf-8'
      );

      logger.info('Configuration saved');
    } catch (error) {
      logger.error('Failed to save config', error);
      throw error;
    }
  }

  get<K extends keyof AppConfig>(key: K): AppConfig[K] {
    return this.config[key];
  }

  set<K extends keyof AppConfig>(key: K, value: AppConfig[K]): void {
    this.config[key] = value;
  }

  getAll(): AppConfig {
    return { ...this.config };
  }

  // Type-safe getters for nested properties
  getPath(key: keyof AppConfig['paths']): string {
    return this.config.paths[key];
  }

  isFeatureEnabled(feature: keyof AppConfig['features']): boolean {
    return this.config.features[feature];
  }

  getLimit(key: keyof AppConfig['limits']): number {
    return this.config.limits[key];
  }

  getPerformanceSetting<K extends keyof AppConfig['performance']>(
    key: K
  ): AppConfig['performance'][K] {
    return this.config.performance[key];
  }
}

// Singleton instance
export const config = new ConfigManager();
