// import-export.mjs — load a WhatsApp "Export chat" _chat.txt into messages.db so the KG can
// reach history from before Boaz was paired. Imports only messages OLDER than the earliest
// stored (live) message, so nothing the daemon already captured is duplicated.
//   node bin/import-export.mjs <path/to/_chat.txt>
import { readFileSync } from 'node:fs'
import { loadConfig, DB_PATH } from '../src/config.mjs'
import { openDb } from '../src/wa/store.mjs'
import { parseExport } from '../src/kg/parse-export.mjs'

const file = process.argv[2]
if (!file) { console.error('usage: node bin/import-export.mjs <_chat.txt>'); process.exit(1) }
const config = loadConfig()
const db = openDb(DB_PATH)

const rows = parseExport(readFileSync(file, 'utf8'), { chatJid: config.groupJid })
const boundary = db.prepare('SELECT MIN(ts) m FROM messages').get().m ?? Infinity
const older = rows.filter((r) => r.ts < boundary)

const ins = db.prepare(`INSERT OR IGNORE INTO messages (id, chat_jid, sender_jid, sender_name, ts, kind, text, quoted_id, raw)
                        VALUES (?,?,?,?,?,?,?,NULL,NULL)`)
let n = 0
db.transaction(() => { for (const r of older) n += ins.run(r.id, r.chat_jid, null, r.sender_name, r.ts, r.kind, r.text).changes })()

const t = db.prepare("SELECT COUNT(*) c, datetime(MIN(ts),'unixepoch') e, datetime(MAX(ts),'unixepoch') l FROM messages").get()
console.log(`parsed ${rows.length} text msgs; imported ${n} older than the live boundary.`)
console.log(`store now: ${t.c} messages, ${t.e} → ${t.l}`)
db.close()
