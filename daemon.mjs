// daemon.mjs — CLI + the always-on watcher for whatsapp-claude (bot: Boaz).
import { execSync } from 'node:child_process'
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { downloadMediaMessage } from 'baileys'
import { connect } from './src/wa/connect.mjs'
import {
  loadConfig, saveConfig, DATA_DIR, DB_PATH, SETTINGS_PATH, VISION_SETTINGS_PATH, SCRATCH_DIR, MEDIA_DIR, USAGE_PATH, PID_PATH, TOOLS_CONFIG_PATH,
} from './src/config.mjs'
import { openDb, storeMessages } from './src/wa/store.mjs'
import { createGuardrails } from './src/gate/guardrails.mjs'
import { writeLockedSettings } from './src/reply/sandbox.mjs'
import { writeVisionSettings } from './src/media/vision.mjs'
import { handleIncoming, processNext, appendUsage } from './src/reply/orchestrate.mjs'
import { initOutbox, recover, statusCounts, pendingCount } from './src/queue/outbox.mjs'
import { initSpam } from './src/gate/spam.mjs'
import { initMutes } from './src/gate/mute.mjs'
import { initReminders, dueReminders, markReminderSent } from './src/recall/reminders.mjs'

const cmd = process.argv[2]
const config = loadConfig()

function resolveClaude() {
  let p
  try { p = execSync('command -v claude', { shell: '/bin/zsh' }).toString().trim() }
  catch { throw new Error('cannot find the `claude` binary on PATH') }
  // Fail fast at startup instead of ENOENT-ing on every reply (e.g. a stale path
  // left behind mid-update). config.claudePath can override if resolution is wrong.
  const chosen = config.claudePath || p
  if (!chosen || !existsSync(chosen)) throw new Error(`claude binary not found at "${chosen || '(empty)'}"`)
  return chosen
}

if (cmd === 'login') {
  const phone = (process.argv[3] || '').replace(/[^0-9]/g, '')
  await connect({ pairPhone: phone || undefined, onReady: () => console.log('paired ✓  next: node daemon.mjs groups') })
} else if (cmd === 'groups') {
  await connect({ onReady: async (sock) => {
    const groups = await sock.groupFetchAllParticipating()
    for (const g of Object.values(groups)) console.log(`  ${g.id}   ${String(g.participants?.length ?? '?').padStart(3)}   ${g.subject}`)
    console.log('\nthen: node daemon.mjs set "<jid>"'); process.exit(0)
  } })
} else if (cmd === 'set') {
  const jid = process.argv[3]
  if (!jid) { console.error('usage: node daemon.mjs set "<group-jid>"'); process.exit(1) }
  config.groupJid = jid
  await connect({ onReady: async (sock) => {
    try {
      const meta = await sock.groupMetadata(jid); config.groupName = meta.subject
      const me = sock.user?.id?.replace(/:\d+@/, '@') // normalize device suffix
      config.ownerJid = me || config.ownerJid
    } catch {}
    saveConfig(config)
    console.log('target set:', jid, '| name:', config.groupName, '| owner:', config.ownerJid)
    process.exit(0)
  } })
} else if (cmd === 'on' || cmd === 'off') {
  config.enabled = cmd === 'on'; saveConfig(config); console.log('enabled =', config.enabled); process.exit(0)
} else if (cmd === 'stats') {
  const lines = existsSync(USAGE_PATH) ? readFileSync(USAGE_PATH, 'utf8').trim().split('\n').filter(Boolean) : []
  const entries = lines.map((l) => { try { return JSON.parse(l) } catch { return {} } })
  console.log(`replies sent:   ${entries.filter((e) => e.event === 'sent').length}`)
  console.log(`sarcasm posted: ${entries.filter((e) => e.event === 'sarcasm').length}`)
  console.log(`dropped:        ${entries.filter((e) => e.skipped).length} (cap/disabled)`)
  if (existsSync(DB_PATH)) {
    const db = openDb(DB_PATH); initOutbox(db)
    console.log(`outbox:         ${JSON.stringify(statusCounts(db))} | pending: ${pendingCount(db)}`)
  }
  process.exit(0)
} else if (cmd === 'reset-cap') {
  // Clear ONLY the group-wide hourly cap in the LIVE daemon — no restart, cooldowns/spam intact.
  if (!existsSync(PID_PATH)) { console.error('daemon not running (no pidfile); the cap clears itself on next start.'); process.exit(1) }
  const pid = Number(readFileSync(PID_PATH, 'utf8').trim())
  try {
    process.kill(pid, 'SIGUSR2')
    console.log(`reset-cap → signaled daemon pid ${pid}: group hourly cap cleared (cooldowns + spam untouched).`)
  } catch (e) {
    console.error(e.code === 'ESRCH' ? `stale pidfile: pid ${pid} isn't running — start the daemon first.` : `reset-cap failed: ${e.message}`)
    process.exit(1)
  }
  process.exit(0)
} else if (cmd === 'start') {
  if (!config.groupJid) { console.error('no target group — run groups then set first.'); process.exit(1) }
  mkdirSync(DATA_DIR, { recursive: true }); mkdirSync(SCRATCH_DIR, { recursive: true }); mkdirSync(MEDIA_DIR, { recursive: true })
  writeLockedSettings(SETTINGS_PATH, config)
  writeVisionSettings(VISION_SETTINGS_PATH, MEDIA_DIR, config)
  // boaz-tools MCP config (weather always; TV tools gated by allowlist in orchestrate).
  const serverPath = new URL('./src/tools/server.mjs', import.meta.url).pathname
  let adbBin = process.env.ADB_BIN || 'adb'
  try { adbBin = execSync('command -v adb', { shell: '/bin/zsh' }).toString().trim() || adbBin } catch {}
  writeFileSync(TOOLS_CONFIG_PATH, JSON.stringify({ mcpServers: { 'boaz-tools': {
    command: process.execPath, args: [serverPath],
    env: { TV_HOST: config.tvHost || '', ADB_BIN: adbBin },
  } } }, null, 2))
  if (config.tvEnabled && config.tvHost) { try { execSync(`adb connect ${config.tvHost}`, { stdio: 'ignore' }) } catch {} }
  const claudePath = resolveClaude()
  const db = openDb(DB_PATH)
  initOutbox(db); initSpam(db); initMutes(db); initReminders(db)
  const requeued = recover(db) // resume any work a previous crash left mid-flight
  if (requeued) console.log(`recovered ${requeued} interrupted outbox item(s)`)
  const guardrails = createGuardrails(config)
  writeFileSync(PID_PATH, String(process.pid)) // so `reset-cap` can signal us
  process.on('SIGUSR2', () => { guardrails.clearHourly(); console.log('group hourly-cap cleared (reset-cap)') })
  const sentIds = new Set()
  const paths = { settingsPath: SETTINGS_PATH, visionSettingsPath: VISION_SETTINGS_PATH, scratchDir: SCRATCH_DIR, mediaDir: MEDIA_DIR, toolsConfigPath: TOOLS_CONFIG_PATH }
  const log = (e) => appendUsage(USAGE_PATH, e)
  // Never TRIGGER on backlog / messages WhatsApp replays on reconnect (5s grace).
  const asTs = (t) => (typeof t === 'number' ? t : t?.toNumber ? t.toNumber() : Number(t) || 0)
  const startedAt = Math.floor(Date.now() / 1000) - 5
  let sock
  let connected = false // true only while the socket is open — pause sends otherwise

  // Download an incoming voice note / image to the media dir; returns the file path.
  const downloadMedia = async (msg, kind) => {
    const buf = await downloadMediaMessage(msg, 'buffer', {})
    const p = join(MEDIA_DIR, `${kind}-${msg.key.id}.${kind === 'image' ? 'jpg' : 'ogg'}`)
    writeFileSync(p, buf)
    return p
  }

  // Single worker: drains the outbox one reply at a time (bounds cost, preserves order).
  async function workerLoop() {
    let did = false
    try { if (sock && connected) did = await processNext({ sock, db, config, paths, claudePath, sentIds, log, guardrails }) }
    catch (e) { console.error('worker error:', e?.message || e) }
    setTimeout(workerLoop, did ? 0 : config.workerPollMs)
  }

  // Reminder scheduler: post any due reminders.
  async function reminderLoop() {
    try {
      if (sock && connected) for (const r of dueReminders(db)) {
        const s = await sock.sendMessage(config.groupJid, { text: `${config.botPrefix} ⏰ תזכורת: ${r.text}` })
        if (s?.key?.id) sentIds.add(s.key.id)
        markReminderSent(db, r.id)
        log({ ts: Date.now(), event: 'reminder-fired', id: r.id })
      }
    } catch (e) { console.error('reminder error:', e?.message || e) }
    setTimeout(reminderLoop, config.reminderTickSec * 1000)
  }

  console.log(`watching ${config.groupName || config.groupJid} — @${config.botName} bot ${config.enabled ? 'ON' : 'OFF'}`)
  sock = await connect({
    onReady: (s) => { sock = s; connected = true }, // refresh the socket on every (re)connect
    onClose: () => { connected = false },           // pause sends until it's back
    onMessages: async (messages) => {
    storeMessages(db, messages, config.groupJid) // keep context fresh (all messages)
    for (const msg of messages) {
      if (asTs(msg.messageTimestamp) < startedAt) continue // skip backlog / replayed
      try {
        await handleIncoming({ sock, msg, db, guardrails, config, sentIds, log, downloadMedia, saveConfig })
      } catch (e) { console.error('handleIncoming error:', e?.message || e) }
    }
  } })
  workerLoop()
  reminderLoop()
} else {
  console.log('usage: node daemon.mjs <login|groups|set "<jid>"|start|on|off|stats|reset-cap>')
  process.exit(1)
}
