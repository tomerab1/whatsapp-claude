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

// Recognizes exactly "@claude on" / "@claude off" (any trigger word), owner only.
export function parseOwnerCommand(text, senderJid, ownerJid) {
  if (!ownerJid || senderJid !== ownerJid) return null
  const m = (text || '').trim().toLowerCase().match(/^@(?:claude|קלוד)\s+(on|off)$/)
  return m ? m[1] : null
}
