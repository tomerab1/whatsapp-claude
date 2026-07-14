// daemon.mjs — CLI + the always-on watcher for whatsapp-claude (bot: Boaz).
import { execSync } from 'node:child_process'
import { mkdirSync, existsSync, readFileSync } from 'node:fs'
import { connect } from './connect.mjs'
import {
  loadConfig, saveConfig, DATA_DIR, DB_PATH, SETTINGS_PATH, SCRATCH_DIR, USAGE_PATH,
} from './config.mjs'
import { openDb, storeMessages } from './store.mjs'
import { createGuardrails } from './guardrails.mjs'
import { writeLockedSettings } from './sandbox.mjs'
import { handleIncoming, processNext, appendUsage } from './orchestrate.mjs'
import { initOutbox, recover, statusCounts, pendingCount } from './outbox.mjs'
import { initSpam } from './spam.mjs'

const cmd = process.argv[2]
const config = loadConfig()

function resolveClaude() {
  try { return execSync('command -v claude', { shell: '/bin/zsh' }).toString().trim() }
  catch { throw new Error('cannot find the `claude` binary on PATH') }
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
} else if (cmd === 'start') {
  if (!config.groupJid) { console.error('no target group — run groups then set first.'); process.exit(1) }
  mkdirSync(DATA_DIR, { recursive: true }); mkdirSync(SCRATCH_DIR, { recursive: true })
  writeLockedSettings(SETTINGS_PATH, config)
  const claudePath = resolveClaude()
  const db = openDb(DB_PATH)
  initOutbox(db); initSpam(db)
  const requeued = recover(db) // resume any work a previous crash left mid-flight
  if (requeued) console.log(`recovered ${requeued} interrupted outbox item(s)`)
  const guardrails = createGuardrails(config)
  const sentIds = new Set()
  const paths = { settingsPath: SETTINGS_PATH, scratchDir: SCRATCH_DIR }
  const log = (e) => appendUsage(USAGE_PATH, e)
  // Never TRIGGER on backlog / messages WhatsApp replays on reconnect (5s grace).
  const asTs = (t) => (typeof t === 'number' ? t : t?.toNumber ? t.toNumber() : Number(t) || 0)
  const startedAt = Math.floor(Date.now() / 1000) - 5
  let sock

  // Single worker: drains the outbox one reply at a time (bounds cost, preserves order).
  async function workerLoop() {
    let did = false
    try { if (sock) did = await processNext({ sock, db, config, paths, claudePath, sentIds, log }) }
    catch (e) { console.error('worker error:', e?.message || e) }
    setTimeout(workerLoop, did ? 0 : config.workerPollMs)
  }

  console.log(`watching ${config.groupName || config.groupJid} — @${config.botName} bot ${config.enabled ? 'ON' : 'OFF'}`)
  sock = await connect({ onMessages: async (messages) => {
    storeMessages(db, messages, config.groupJid) // keep context fresh (all messages)
    for (const msg of messages) {
      if (asTs(msg.messageTimestamp) < startedAt) continue // skip backlog / replayed
      try {
        await handleIncoming({ sock, msg, db, guardrails, config, sentIds, log })
      } catch (e) { console.error('handleIncoming error:', e?.message || e) }
    }
  } })
  workerLoop()
} else {
  console.log('usage: node daemon.mjs <login|groups|set "<jid>"|start|on|off|stats>')
  process.exit(1)
}
