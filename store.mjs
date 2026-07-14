// store.mjs — rolling SQLite store of recent group messages (context for replies).
// Schema mirrors whatsapp-kg so the ingestion logic is familiar.
import Database from 'better-sqlite3'

export function openDb(path) {
  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id          TEXT PRIMARY KEY,
      chat_jid    TEXT NOT NULL,
      sender_jid  TEXT,
      sender_name TEXT,
      ts          INTEGER,
      kind        TEXT,
      text        TEXT,
      quoted_id   TEXT,
      raw         TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_messages_ts   ON messages(ts);
    CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_jid);
  `)
  return db
}

const safeJson = (o) => JSON.stringify(o, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))
const toTs = (t) => (typeof t === 'number' ? t : t?.toNumber ? t.toNumber() : Number(t) || null)

export function extractText(msg) {
  const m = msg.message
  if (!m) return { kind: 'empty', text: '' }
  if (m.conversation) return { kind: 'text', text: m.conversation }
  if (m.extendedTextMessage?.text) return { kind: 'text', text: m.extendedTextMessage.text }
  if (m.imageMessage) return { kind: 'image', text: m.imageMessage.caption || '' }
  if (m.videoMessage) return { kind: 'video', text: m.videoMessage.caption || '' }
  if (m.documentMessage)
    return { kind: 'document', text: m.documentMessage.caption || m.documentMessage.fileName || '' }
  if (m.audioMessage) return { kind: m.audioMessage.ptt ? 'voice' : 'audio', text: '' }
  if (m.stickerMessage) return { kind: 'sticker', text: '' }
  return { kind: Object.keys(m)[0] || 'other', text: '' }
}

export function storeMessages(db, messages, chatJid) {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO messages
      (id, chat_jid, sender_jid, sender_name, ts, kind, text, quoted_id, raw)
    VALUES (@id, @chat_jid, @sender_jid, @sender_name, @ts, @kind, @text, @quoted_id, @raw)
  `)
  let n = 0
  const tx = db.transaction((arr) => {
    for (const msg of arr) {
      const jid = msg.key?.remoteJid
      if (!jid || jid !== chatJid) continue
      const { kind, text } = extractText(msg)
      const info = insert.run({
        id: msg.key.id,
        chat_jid: jid,
        sender_jid: msg.key.participant || msg.participant || (msg.key.fromMe ? 'me' : jid),
        sender_name: msg.pushName || null,
        ts: toTs(msg.messageTimestamp),
        kind,
        text,
        quoted_id: msg.message?.extendedTextMessage?.contextInfo?.stanzaId || null,
        raw: safeJson(msg),
      })
      n += info.changes
    }
  })
  tx(messages)
  return n
}

export function recentContext(db, chatJid, limit) {
  const rows = db
    .prepare(
      `SELECT ts, sender_name, text FROM messages
       WHERE chat_jid = ? AND text <> '' ORDER BY ts DESC LIMIT ?`,
    )
    .all(chatJid, limit)
  return rows.reverse() // oldest → newest for prompt readability
}

export function getMessageText(db, id) {
  const row = db.prepare(`SELECT sender_name, text FROM messages WHERE id = ?`).get(id)
  return row || null
}

// The full stored Baileys message object (for quoting a reply). Null if unknown.
export function getRawMessage(db, id) {
  const row = db.prepare(`SELECT raw FROM messages WHERE id = ?`).get(id)
  if (!row?.raw) return null
  try { return JSON.parse(row.raw) } catch { return null }
}
