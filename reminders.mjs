// reminders.mjs — "@בועז תזכיר לכולם בעוד שעה ש..." → Boaz posts it when it's due.
import { parseDuration } from './trigger.mjs'
const now0 = () => Date.now()

export function initReminders(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS reminders (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_jid   TEXT NOT NULL,
    due_ts     INTEGER NOT NULL,
    text       TEXT NOT NULL,
    created_by TEXT,
    created_ts INTEGER,
    sent       INTEGER NOT NULL DEFAULT 0
  )`)
  return db
}

// NB: no \b — JS word boundaries don't fire around Hebrew letters; use a separator lookahead.
const REMIND_VERB = /^(?:remind(?:\s+(?:me|us|everyone|the\s+group))?|תזכיר(?:\s+(?:לי|לנו|לכולם))?)(?=[\s:\-]|$)\s*[:\-]?\s*/i
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function stripTriggers(text, triggers) {
  let t = (text || '').trim()
  for (const tr of triggers || []) t = t.replace(new RegExp(escapeRe(tr), 'ig'), ' ')
  return t.replace(/\s+/g, ' ').trim()
}

// "30 דקות" → "30דק" so parseDuration can read it; plural Hebrew units → singular stems.
const normHebDur = (s) => s.replace(/דקות|דקה/g, 'דק').replace(/שעות|שעה/g, 'שע').replace(/ימים|יום/g, 'יו').replace(/\s+/g, '')

// Returns { dueTs (ms), text } or null. Supports "in <dur>"/"בעוד <dur>" and "at HH:MM"/"ב-HH:MM".
export function parseReminder(text, triggers, nowMs = now0()) {
  const t = stripTriggers(text, triggers)
  const vm = t.match(REMIND_VERB)
  if (!vm) return null
  let rest = t.slice(vm[0].length).trim()
  let dueTs = null

  let m = rest.match(/^(?:in|בעוד)\s+([0-9]+\s*[a-zא-ת"']+|[a-zא-ת"']+)/i)
  if (m) {
    const dur = parseDuration(m[1]) || parseDuration(normHebDur(m[1])) // raw first (bare "שעה"), then "30 דקות"
    if (dur) { dueTs = nowMs + dur * 1000; rest = rest.slice(m[0].length).trim() }
  }
  if (dueTs == null && (m = rest.match(/(?:at|ב-?|בשעה)\s*([0-2]?\d):([0-5]\d)/i))) {
    const d = new Date(nowMs); d.setHours(+m[1], +m[2], 0, 0)
    let due = d.getTime(); if (due <= nowMs) due += 86_400_000 // next occurrence
    dueTs = due
    rest = (rest.slice(0, m.index) + rest.slice(m.index + m[0].length)).trim()
  }
  if (dueTs == null) return null

  rest = rest.replace(/^(?:that|to|ש|כדי\s+ל?|-|:)\s*/i, '').trim()
  return { dueTs, text: rest || 'תזכורת ⏰' }
}

export function addReminder(db, { chatJid, dueTs, text, createdBy }, now = now0) {
  return db.prepare(`INSERT INTO reminders (chat_jid, due_ts, text, created_by, created_ts, sent) VALUES (?,?,?,?,?,0)`)
    .run(chatJid, dueTs, text, createdBy ?? null, now()).lastInsertRowid
}

export function dueReminders(db, nowMs = now0()) {
  return db.prepare(`SELECT * FROM reminders WHERE sent = 0 AND due_ts <= ? ORDER BY due_ts`).all(nowMs)
}

export function markReminderSent(db, id) {
  db.prepare(`UPDATE reminders SET sent = 1 WHERE id = ?`).run(id)
}
