import path from 'node:path';

/**
 * Learning-log settings, read from the environment. Off by default: with nothing set, no file is made and no call is recorded.
 * A bad value is an error at start-up, as RENOR_ON_DEMAND is, so a typo can never leave the log on or off by accident.
 */
export const DEFAULT_LEARNING_RETENTION_DAYS = 30;
export const MAX_LEARNING_RETENTION_DAYS = 365;

export interface LearningSettings {
  /** RENOR_LEARNING_LOG: record retrievals, memory operations and cites. */
  enabled: boolean;
  /** RENOR_LEARNING_RETENTION_DAYS: rows older than this are deleted. */
  retentionDays: number;
  /** RENOR_LEARNING_RAW_QUERY: keep the query text too. Only with the log on, and never for a query the secret scanner flags. */
  rawQueries: boolean;
  /** The one file: inside the memory folder, next to the derived index, which the walker, the watcher and release packing already skip. */
  dbPath: string;
}

/** The learning log's file for one memory folder. Each tenant has its own memory folder, so each tenant has its own log. */
export function learningDbPath(memoryDir: string): string {
  return path.join(path.resolve(memoryDir), '.memory-index', 'learning.sqlite');
}

function onOff(name: string, raw: string | undefined): boolean {
  const value = (raw ?? '').trim().toLowerCase();
  if (value === '' || value === '0' || value === 'false') return false;
  if (value === '1' || value === 'true') return true;
  throw new Error(`${name} must be 1/true or 0/false`);
}

/** RENOR_LEARNING_RETENTION_DAYS, validated. The management commands read it too, whether or not the log is on. */
export function learningRetentionDays(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env.RENOR_LEARNING_RETENTION_DAYS ?? '').trim();
  const days = raw === '' ? DEFAULT_LEARNING_RETENTION_DAYS : Number(raw);
  if (!Number.isInteger(days) || days < 1 || days > MAX_LEARNING_RETENTION_DAYS) {
    throw new Error(`RENOR_LEARNING_RETENTION_DAYS must be an integer between 1 and ${MAX_LEARNING_RETENTION_DAYS}`);
  }
  return days;
}

export function learningSettings(memoryDir: string, env: NodeJS.ProcessEnv = process.env): LearningSettings {
  const enabled = onOff('RENOR_LEARNING_LOG', env.RENOR_LEARNING_LOG);
  const rawQueries = onOff('RENOR_LEARNING_RAW_QUERY', env.RENOR_LEARNING_RAW_QUERY);
  if (rawQueries && !enabled) {
    throw new Error('RENOR_LEARNING_RAW_QUERY needs RENOR_LEARNING_LOG=1: a query is only ever kept by a log that is on');
  }
  return { enabled, retentionDays: learningRetentionDays(env), rawQueries, dbPath: learningDbPath(memoryDir) };
}
