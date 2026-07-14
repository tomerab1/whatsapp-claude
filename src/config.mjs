// config.mjs — paths, defaults, load/save for the whatsapp-claude skill.
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const DATA_DIR = join(homedir(), '.claude', 'whatsapp-claude')
export const AUTH_DIR = join(DATA_DIR, 'auth')
export const DB_PATH = join(DATA_DIR, 'messages.db')
export const CFG_PATH = join(DATA_DIR, 'config.json')
export const SETTINGS_PATH = join(DATA_DIR, 'settings.locked.json')
export const VISION_SETTINGS_PATH = join(DATA_DIR, 'settings.vision.json')
export const USAGE_PATH = join(DATA_DIR, 'usage.jsonl')
export const SCRATCH_DIR = join(DATA_DIR, 'scratch') // empty cwd for claude -p
export const MEDIA_DIR = join(DATA_DIR, 'media')     // downloaded voice notes / images
export const PID_PATH = join(DATA_DIR, 'daemon.pid') // running daemon's pid (for reset-cap)
export const TOOLS_CONFIG_PATH = join(DATA_DIR, 'tools-config.json') // --mcp-config for boaz-tools

export const DEFAULT_CONFIG = {
  groupJid: null,
  groupName: null,
  ownerJid: null,          // set at `set` time; used for owner-only @boaz on/off
  enabled: true,
  botPrefix: '🤖',
  botName: 'Boaz',
  triggers: ['@boaz', '@בועז'],
  model: 'claude-sonnet-5',
  allowWebFetch: true,
  perUserCooldownSec: 10,
  hourlyCap: 30,
  maxReplyChars: 1500,
  contextMessages: 20,
  claudeTimeoutSec: 150,   // web search can need several queries; 60s was killing them
  workerPollMs: 700,       // how often the outbox worker checks for queued work
  maxSendAttempts: 3,      // outbox delivery retries before a row is marked failed
  sarcasmLevel: 3,         // 0 = no sarcasm to spammers; 1..3 = escalation ceiling
  reminderTickSec: 30,     // how often to check for due reminders
  followUps: true,         // reply when someone replies to Boaz without re-tagging
  voice: true,             // allow voice-note replies (on request) + voice-question transcription
  vision: true,            // allow image understanding on @boaz-captioned images
  voiceWakeword: true,     // transcribe any voice note (local/free) + reply if "בועז" is spoken
  voiceMaxSec: 60,         // don't wake-scan voice notes longer than this (bounds CPU)
  tvEnabled: false,        // owner opt-in; while true, anyone can make Boaz drive the TV
  tvHost: null,            // "192.168.x.x:5555" — the TV's ADB endpoint
  tvMaxTurns: 12,          // cap the TV tool-use loop (bounds cost)
  whisperModel: 'small',   // 'small' handles Hebrew far better than 'base' (still local/free)
  whisperLang: 'he',       // pin Hebrew so a clip isn't mis-detected as Arabic ('auto' to detect)
  voiceWakeExtra: ['בועס', 'בוז', 'boas', 'בועאז'], // common mis-transcriptions of "בועז"
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
