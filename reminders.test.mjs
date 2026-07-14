import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { initReminders, parseReminder, addReminder, dueReminders, markReminderSent } from './reminders.mjs'

const TRIGGERS = ['@boaz', '@בועז']

test('parseReminder: Hebrew relative "בעוד שעה"', () => {
  const r = parseReminder('@בועז תזכיר לכולם בעוד שעה שיש אימון', TRIGGERS, 0)
  assert.equal(r.dueTs, 3600 * 1000)
  assert.match(r.text, /אימון/)
})

test('parseReminder: English relative "in 30m"', () => {
  const r = parseReminder('@boaz remind us in 30m to leave for the airport', TRIGGERS, 0)
  assert.equal(r.dueTs, 30 * 60 * 1000)
  assert.match(r.text, /airport/)
})

test('parseReminder: "בעוד 45 דקות" plural unit', () => {
  const r = parseReminder('@בועז תזכיר בעוד 45 דקות שהתבשיל מוכן', TRIGGERS, 0)
  assert.equal(r.dueTs, 45 * 60 * 1000)
})

test('parseReminder: absolute "ב-20:00" resolves to a future ts', () => {
  const r = parseReminder('@בועז תזכיר ב-20:00 שיש משחק', TRIGGERS, 1000)
  assert.ok(r && r.dueTs > 1000)
})

test('parseReminder: non-reminder returns null', () => {
  assert.equal(parseReminder('@בועז מה השעה עכשיו', TRIGGERS, 0), null)
})

test('reminder lifecycle: add → due → sent', () => {
  const db = initReminders(new Database(':memory:'))
  addReminder(db, { chatJid: 'g@g.us', dueTs: 1000, text: 'hi', createdBy: 'u@x' }, () => 0)
  assert.equal(dueReminders(db, 500).length, 0)  // not due yet
  const due = dueReminders(db, 1500)
  assert.equal(due.length, 1)
  assert.equal(due[0].text, 'hi')
  markReminderSent(db, due[0].id)
  assert.equal(dueReminders(db, 1500).length, 0) // already sent
})
