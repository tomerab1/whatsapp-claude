import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { initMutes, setMute, clearMute, isMuted } from '../src/gate/mute.mjs'

const db0 = () => initMutes(new Database(':memory:'))

test('mute is active until its expiry, then lapses', () => {
  const db = db0()
  setMute(db, 'u@x', 1000)
  assert.equal(isMuted(db, 'u@x', () => 500), true)   // before expiry
  assert.equal(isMuted(db, 'u@x', () => 1500), false) // after expiry
  assert.equal(isMuted(db, 'other@x', () => 500), false)
})

test('clearMute removes it immediately', () => {
  const db = db0()
  setMute(db, 'u@x', 9_999_999_999)
  assert.equal(isMuted(db, 'u@x', () => 0), true)
  clearMute(db, 'u@x')
  assert.equal(isMuted(db, 'u@x', () => 0), false)
})

test('re-muting updates the expiry', () => {
  const db = db0()
  setMute(db, 'u@x', 1000)
  setMute(db, 'u@x', 5000)
  assert.equal(isMuted(db, 'u@x', () => 3000), true)
})
