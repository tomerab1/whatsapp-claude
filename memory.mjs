// memory.mjs — give Boaz recall over the whole group history (not just the last 20).
// Two mechanisms: catch-up windowing (summaries) and keyword recall of older messages.

export const CATCHUP_PATTERNS = [
  /\b(summar(y|ize|ise)|recap|tl;?dr|catch ?up)\b/i,
  /(סכם|תסכם|סיכום|מה פספסתי|מה היה פה|תעדכן אותי|על מה דיברתם)/,
]

export function wantsCatchup(text) {
  return CATCHUP_PATTERNS.some((re) => re.test(text || ''))
}

// The most recent `cap` non-empty messages (a wider window than normal context).
export function catchupContext(db, chatJid, cap) {
  const rows = db
    .prepare(`SELECT ts, sender_name, text FROM messages WHERE chat_jid = ? AND text <> '' ORDER BY ts DESC LIMIT ?`)
    .all(chatJid, cap)
  return rows.reverse()
}

const STOPWORDS = new Set([
  'the', 'and', 'for', 'what', 'when', 'who', 'how', 'why', 'you', 'your', 'about', 'with', 'that', 'this',
  'boaz', 'בועז', 'claude', 'קלוד', 'את', 'של', 'על', 'מה', 'מי', 'זה', 'לא', 'כן', 'אני', 'אתה', 'הוא',
  'אנחנו', 'הם', 'יש', 'אם', 'גם', 'רק', 'עם', 'כי', 'או', 'לי', 'לך', 'לו',
])

// Salient search terms from a question: words length>=3, minus stopwords + trigger words.
export function keywordsFrom(text, triggers = []) {
  const trig = new Set(triggers.map((t) => t.replace(/^@/, '').toLowerCase()))
  const words = (text || '').toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || []
  const seen = new Set()
  const out = []
  for (const w of words) {
    if (STOPWORDS.has(w) || trig.has(w) || seen.has(w)) continue
    seen.add(w)
    out.push(w)
  }
  return out.slice(0, 6)
}

// Older messages matching any keyword, excluding the recent window (ts >= sinceTs).
export function searchHistory(db, chatJid, keywords, { limit = 8, sinceTs = null } = {}) {
  if (!keywords.length) return []
  const likes = keywords.map(() => 'text LIKE ?').join(' OR ')
  const params = keywords.map((k) => `%${k}%`)
  let sql = `SELECT ts, sender_name, text FROM messages WHERE chat_jid = ? AND text <> '' AND (${likes})`
  const args = [chatJid, ...params]
  if (sinceTs != null) { sql += ` AND ts < ?`; args.push(sinceTs) }
  sql += ` ORDER BY ts DESC LIMIT ?`; args.push(limit)
  return db.prepare(sql).all(...args).reverse()
}
