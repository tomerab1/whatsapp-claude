// trigger.mjs — pure detection of @claude triggers and owner on/off commands.

export function matchesTrigger(text, triggers) {
  if (!text) return false
  const hay = text.toLowerCase()
  return triggers.some((t) => hay.includes(t.toLowerCase()))
}

export function isBotEcho(text, botPrefix) {
  return (text || '').trimStart().startsWith(botPrefix)
}

export function shouldReply({ text, id, botPrefix, triggers, sentIds }) {
  if (id && sentIds && sentIds.has(id)) return false // our own send, echoed back
  if (isBotEcho(text, botPrefix)) return false        // any bot-prefixed line
  return matchesTrigger(text, triggers)
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Recognizes "<trigger> on" / "<trigger> off" for any configured trigger word,
// owner only. Derived from `triggers` so a rename needs no code change here.
export function parseOwnerCommand(text, senderJid, ownerJid, triggers) {
  if (!ownerJid || senderJid !== ownerJid) return null
  const words = (triggers || []).map((t) => escapeRe(t.replace(/^@/, ''))).filter(Boolean)
  if (!words.length) return null
  const re = new RegExp(`^@(?:${words.join('|')})\\s+(on|off)$`, 'i')
  const m = (text || '').trim().match(re)
  return m ? m[1].toLowerCase() : null
}
