// trigger.mjs — pure detection of @boaz triggers, thread follow-ups, and admin commands.

export function matchesTrigger(text, triggers) {
  if (!text) return false
  const hay = text.toLowerCase()
  return triggers.some((t) => hay.includes(t.toLowerCase()))
}

export function isBotEcho(text, botPrefix) {
  return (text || '').trimStart().startsWith(botPrefix)
}

// Trivial acknowledgements that should NOT pull Boaz back into a thread on a follow-up.
const ACK_PATTERNS = [
  /^(thanks?|thx|ty|ok(ay)?|k|cool|nice|great|lol+|haha+|hah)$/i,
  /^(תודה( רבה)?|סבבה|אחלה|יפה|מגניב|וואו|חחח*|חח|אוקיי?|אוקי|בסדר|יאללה|כן|לא|מעולה|סחתן)$/,
]

export function isAck(text) {
  const t = (text || '').trim()
  if (!t) return true
  const letters = (t.match(/\p{L}/gu) || []).join('')
  if (letters.length === 0) return true // emoji / punctuation only
  const core = t.replace(/[!?.…\s]+$/g, '').trim()
  return ACK_PATTERNS.some((re) => re.test(core))
}

// `quotedIsBot` = this message is a reply to one of Boaz's own messages (thread follow-up).
export function shouldReply({ text, id, botPrefix, triggers, sentIds, quotedIsBot }) {
  if (id && sentIds && sentIds.has(id)) return false // our own send, echoed back
  if (isBotEcho(text, botPrefix)) return false        // any bot-prefixed line
  if (matchesTrigger(text, triggers)) return true      // explicit @boaz
  if (quotedIsBot) return !isAck(text)                 // follow-up: unless it's just "thanks"
  return false
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// "30m" / "1h" / "2d" / "90s" / Hebrew "דקה"/"שעה"/"יום" → seconds (null if unparseable).
export function parseDuration(s) {
  if (!s) return null
  const t = String(s).trim().toLowerCase()
  const heb = { 'דקה': 60, 'שעה': 3600, 'יום': 86400, 'שעתיים': 7200, 'יומיים': 172800 }
  if (heb[t]) return heb[t]
  const m = t.match(/^(\d+)\s*(s|sec|m|min|h|hr|d|day|שנ|דק|שע|יו)?$/)
  if (!m) return null
  const n = parseInt(m[1], 10)
  const unit = m[2] || 'm'
  const mult = { s: 1, sec: 1, m: 60, min: 60, h: 3600, hr: 3600, d: 86400, day: 86400, 'דק': 60, 'שע': 3600, 'יו': 86400 }
  return n * (mult[unit] ?? 60)
}

const DEFAULT_MUTE_SEC = 3600
const SARCASM_MAX_LEVEL = 3

// Owner-only admin commands. ctx: { isOwner, senderJid, ownerJid, triggers, quotedSenderJid, mentionedJids }.
// `isOwner` (the message is fromMe — the paired account is the owner) is the reliable signal;
// senderJid===ownerJid is a fallback (fails in-group because members carry a @lid, not the phone jid).
// Returns { cmd, ... } or null. cmd ∈ on|off|stats|sarcasm|mute|unmute|tv.
export function parseAdminCommand(text, ctx) {
  const { isOwner, senderJid, ownerJid, triggers, quotedSenderJid, mentionedJids } = ctx || {}
  const owner = isOwner ?? (!!ownerJid && senderJid === ownerJid)
  if (!owner) return null
  const words = (triggers || []).map((t) => escapeRe(t.replace(/^@/, ''))).filter(Boolean)
  if (!words.length) return null
  const pfx = `^@(?:${words.join('|')})\\s+`
  const t = (text || '').trim()
  const re = (body) => new RegExp(pfx + body + '$', 'i')
  const target = () => (mentionedJids && mentionedJids[0]) || quotedSenderJid || null

  if (re('on').test(t)) return { cmd: 'on' }
  if (re('off').test(t)) return { cmd: 'off' }
  if (re('stats').test(t)) return { cmd: 'stats' }

  let mtv
  if ((mtv = t.match(re('(?:tv)\\s+(on|off)')))) return { cmd: 'tv', on: mtv[1].toLowerCase() === 'on' }

  let m
  if ((m = t.match(re('(?:sarcasm|סרקזם)\\s+(\\S+)')))) {
    const v = m[1].toLowerCase()
    if (v === 'off') return { cmd: 'sarcasm', level: 0 }
    const n = parseInt(v, 10)
    return Number.isNaN(n) ? null : { cmd: 'sarcasm', level: Math.max(0, Math.min(SARCASM_MAX_LEVEL, n)) }
  }
  if (re('(?:unmute|בטל השתקה)').test(t)) {
    const tg = target()
    return tg ? { cmd: 'unmute', target: tg } : null
  }
  if ((m = t.match(re('(?:mute|השתק)(?:\\s+(\\S+))?')))) {
    const tg = target()
    if (!tg) return null
    return { cmd: 'mute', target: tg, durationSec: (m[1] && parseDuration(m[1])) || DEFAULT_MUTE_SEC }
  }
  return null
}

// Kept for backward-compat (on/off only); parseAdminCommand supersedes it.
export function parseOwnerCommand(text, senderJid, ownerJid, triggers) {
  const r = parseAdminCommand(text, { senderJid, ownerJid, triggers })
  return r && (r.cmd === 'on' || r.cmd === 'off') ? r.cmd : null
}
