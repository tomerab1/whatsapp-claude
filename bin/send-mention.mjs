// send-mention.mjs — post a message to the CONFIGURED group that @-mentions members.
// The template uses {0},{1},… placeholders, one per mention jid (in order); each is
// replaced with @<id> so WhatsApp renders it as that member's name.
// Guard: refuses any jid that isn't config.groupJid.
// Usage: node send-mention.mjs "<jid>" "<template with {i}>" <mentionJid> [<mentionJid> …]
import { connect } from '../src/wa/connect.mjs'
import { loadConfig } from '../src/config.mjs'

const config = loadConfig()
const jid = process.argv[2]
const template = process.argv[3]
const targets = process.argv.slice(4)

if (!jid || !template || !targets.length) {
  console.error('usage: node send-mention.mjs "<jid>" "<template with {i}>" <jid>…'); process.exit(1)
}
if (jid !== config.groupJid) {
  console.error(`ABORT: ${jid} is not the configured group (${config.groupJid}).`); process.exit(2)
}

const sock = await connect({ onReady: async (s) => {
  try {
    const meta = await s.groupMetadata(jid)
    console.log('group:', JSON.stringify(meta.subject), '| participants:', meta.participants.length)
    // Resolve each target to the participant's canonical mention id (group may be lid- or phone-addressed).
    const resolved = targets.map((t) => {
      const p = meta.participants.find((pp) => pp.id === t || pp.lid === t || pp.jid === t)
      return { target: t, id: p ? p.id : t, found: !!p }
    })
    console.log('resolved mentions:', JSON.stringify(resolved))
    const mentions = resolved.map((r) => r.id)
    let text = template
    mentions.forEach((m, i) => { text = text.replaceAll(`{${i}}`, '@' + m.split('@')[0]) })
    const sent = await s.sendMessage(jid, { text, mentions })
    console.log('sent ✓ id:', sent?.key?.id)
    console.log('raw text:', JSON.stringify(text))
  } catch (e) { console.error('send failed:', e?.message || e); process.exit(3) }
  setTimeout(() => process.exit(0), 2500)
} })

setTimeout(() => { console.error('timeout — did not connect/send'); process.exit(4) }, 40000)
