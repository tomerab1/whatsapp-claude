import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { initSpam, noteSpam } from '../src/gate/spam.mjs'

const db0 = () => initSpam(new Database(':memory:'))
const COOLDOWN = 10_000

test('first violation posts sarcasm; rapid follow-ups escalate but stay quiet', () => {
  const db = db0()
  let t = 0
  const a = noteSpam(db, 'u', COOLDOWN, () => t)
  assert.deepEqual(a, { violations: 1, sarcasm: true })
  t = 2_000
  const b = noteSpam(db, 'u', COOLDOWN, () => t) // within cooldown → escalate, no sarcasm
  assert.deepEqual(b, { violations: 2, sarcasm: false })
  t = 3_000
  const c = noteSpam(db, 'u', COOLDOWN, () => t)
  assert.deepEqual(c, { violations: 3, sarcasm: false })
})

test('sarcasm is allowed again once a cooldown window has passed', () => {
  const db = db0()
  let t = 0
  noteSpam(db, 'u', COOLDOWN, () => t)      // sarcasm at t=0
  t = 11_000
  const r = noteSpam(db, 'u', COOLDOWN, () => t) // >10s later → sarcasm again
  assert.equal(r.sarcasm, true)
  assert.equal(r.violations, 2)
})

test('a separate sender has independent state', () => {
  const db = db0()
  noteSpam(db, 'u', COOLDOWN, () => 0)
  const v = noteSpam(db, 'other', COOLDOWN, () => 100)
  assert.deepEqual(v, { violations: 1, sarcasm: true })
})

test('escalation resets after a long calm period', () => {
  const db = db0()
  let t = 0
  noteSpam(db, 'u', COOLDOWN, () => t) // violations=1
  noteSpam(db, 'u', COOLDOWN, () => (t = 1_000)) // violations=2
  t = 1_000 + 3_600_001 // over an hour of calm
  const r = noteSpam(db, 'u', COOLDOWN, () => t)
  assert.equal(r.violations, 1) // reset then +1
})
