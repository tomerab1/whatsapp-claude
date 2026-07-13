// daemon.mjs — CLI + the always-on watcher for whatsapp-claude.
import { execSync } from 'node:child_process'
import { mkdirSync, existsSync, readFileSync } from 'node:fs'
import { connect } from './connect.mjs'
import {
  loadConfig, saveConfig, DATA_DIR, DB_PATH, SETTINGS_PATH, SCRATCH_DIR, USAGE_PATH,
} from './config.mjs'
import { openDb, storeMessages } from './store.mjs'
import { createGuardrails } from './guardrails.mjs'
import { writeLockedSettings } from './sandbox.mjs'
import { handleMessage, appendUsage } from './orchestrate.mjs'

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
  const replies = lines.map((l) => JSON.parse(l)).filter((e) => e.reply)
  console.log(`replies logged: ${replies.length}`)
  console.log(`skipped: ${lines.length - replies.length}`)
  if (replies.length) console.log(`avg ms: ${Math.round(replies.reduce((a, e) => a + (e.ms || 0), 0) / replies.length)}`)
  process.exit(0)
} else if (cmd === 'start') {
  if (!config.groupJid) { console.error('no target group — run groups then set first.'); process.exit(1) }
  mkdirSync(DATA_DIR, { recursive: true }); mkdirSync(SCRATCH_DIR, { recursive: true })
  writeLockedSettings(SETTINGS_PATH, config)
  const claudePath = resolveClaude()
  const db = openDb(DB_PATH)
  const guardrails = createGuardrails(config)
  const sentIds = new Set()
  let sock
  console.log(`watching ${config.groupName || config.groupJid} — @claude bot ${config.enabled ? 'ON' : 'OFF'}`)
  sock = await connect({ onMessages: async (messages) => {
    storeMessages(db, messages, config.groupJid) // keep context fresh
    for (const msg of messages) {
      try {
        await handleMessage({
          sock, msg, db, guardrails, config,
          paths: { settingsPath: SETTINGS_PATH, scratchDir: SCRATCH_DIR },
          claudePath, sentIds, log: (e) => appendUsage(USAGE_PATH, e),
        })
      } catch (e) { console.error('handleMessage error:', e?.message || e) }
    }
  } })
} else {
  console.log('usage: node daemon.mjs <login|groups|set "<jid>"|start|on|off|stats>')
  process.exit(1)
}
