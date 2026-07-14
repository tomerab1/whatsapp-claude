// parse-export.mjs — parse a WhatsApp iOS "Export chat" _chat.txt into message rows.
// Format: `[DD/MM/YYYY, HH:MM:SS] Sender Name: text` (optional LRM/RTL marks), with
// multi-line messages continuing on unbracketed lines. Attachments/system → dropped.

const LINE = /^‎?\[(\d{2})\/(\d{2})\/(\d{4}),\s(\d{1,2}):(\d{2}):(\d{2})\]\s([^:]+?):\s([\s\S]*)$/
const ATTACH = /‎?(image|video|audio|sticker|GIF|document|Contact card) omitted/gi
const EDITED = /‎?<This message was edited>\s*$/
const ATTACHED = /‎?<attached:[^>]*>/g

// Strip WhatsApp control marks + attachment/edit markers; '' if nothing meaningful remains.
export function cleanText(t) {
  return (t || '')
    .replace(EDITED, '')
    .replace(ATTACHED, '')
    .replace(ATTACH, '')
    .replace(/‎|‏/g, '')
    .trim()
}

const hash = (s) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36) }

// Returns [{ id, chat_jid, sender_name, ts (unix sec), kind, text }] — only non-empty text.
export function parseExport(text, { chatJid } = {}) {
  const lines = (text || '').split('\n')
  const blocks = []
  for (const raw of lines) {
    const m = raw.match(LINE)
    if (m) blocks.push({ d: m[1], mo: m[2], y: m[3], h: m[4], mi: m[5], s: m[6], sender: m[7].trim(), text: m[8] })
    else if (blocks.length) blocks[blocks.length - 1].text += '\n' + raw // continuation
  }
  const out = []
  for (const b of blocks) {
    const clean = cleanText(b.text)
    if (!clean) continue // attachment-only / system notice
    const ts = Math.floor(Date.UTC(+b.y, +b.mo - 1, +b.d, +b.h, +b.mi, +b.s) / 1000)
    out.push({ id: 'imp-' + hash(`${ts}|${b.sender}|${clean}`), chat_jid: chatJid ?? null, sender_name: b.sender, ts, kind: 'text', text: clean })
  }
  return out
}
