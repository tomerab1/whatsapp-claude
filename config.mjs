// config.mjs — paths, defaults, load/save for the whatsapp-claude skill.
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const DATA_DIR = join(homedir(), '.claude', 'whatsapp-claude')
export const AUTH_DIR = join(DATA_DIR, 'auth')
export const DB_PATH = join(DATA_DIR, 'messages.db')
export const CFG_PATH = join(DATA_DIR, 'config.json')
export const SETTINGS_PATH = join(DATA_DIR, 'settings.locked.json')
export const USAGE_PATH = join(DATA_DIR, 'usage.jsonl')
export const SCRATCH_DIR = join(DATA_DIR, 'scratch') // empty cwd for claude -p

export const DEFAULT_CONFIG = {
  groupJid: null,
  groupName: null,
  ownerJid: null,          // set at `set` time; used for owner-only @claude on/off
  enabled: true,
  botPrefix: '🤖',
  triggers: ['@claude', '@קלוד'],
  model: 'claude-sonnet-5',
  allowWebFetch: true,
  perUserCooldownSec: 20,
  hourlyCap: 30,
  maxReplyChars: 1500,
  contextMessages: 20,
  claudeTimeoutSec: 60,
}

export function mergeConfig(fileCfg) {
  return { ...DEFAULT_CONFIG, ...(fileCfg || {}) }
}

export function loadConfig() {
  const fileCfg = existsSync(CFG_PATH) ? JSON.parse(readFileSync(CFG_PATH, 'utf8')) : {}
  return mergeConfig(fileCfg)
}

export function saveConfig(cfg) {
  mkdirSync(DATA_DIR, { recursive: true })
  writeFileSync(CFG_PATH, JSON.stringify(cfg, null, 2) + '\n')
}
