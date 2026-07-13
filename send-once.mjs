// send-once.mjs — post a single message to the CONFIGURED group, then exit.
// Guard: refuses any jid that isn't config.groupJid (so it can only ever hit the
// group this install is set to — never some other group).
// Usage: node send-once.mjs "<jid>" "<text>"
import { connect } from './connect.mjs'
import { loadConfig } from './config.mjs'

const config = loadConfig()
const jid = process.argv[2]
const text = process.argv[3]

if (!jid || !text) { console.error('usage: node send-once.mjs "<jid>" "<text>"'); process.exit(1) }
if (jid !== config.groupJid) {
  console.error(`ABORT: ${jid} is not the configured group (${config.groupJid}). Refusing.`)
  process.exit(2)
}

const sock = await connect({ onReady: async (s) => {
  try {
    const meta = await s.groupMetadata(jid)
    console.log('target group subject:', JSON.stringify(meta.subject))
    const sent = await s.sendMessage(jid, { text })
    console.log('sent ✓ id:', sent?.key?.id)
  } catch (e) { console.error('send failed:', e?.message || e); process.exit(3) }
  setTimeout(() => process.exit(0), 2000) // let the send flush
} })

setTimeout(() => { console.error('timeout — did not connect/send'); process.exit(4) }, 40000)
