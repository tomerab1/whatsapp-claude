import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_CONFIG, mergeConfig } from './config.mjs'

test('DEFAULT_CONFIG has the required knobs with sane defaults', () => {
  assert.equal(DEFAULT_CONFIG.enabled, true)
  assert.equal(DEFAULT_CONFIG.botPrefix, '🤖')
  assert.equal(DEFAULT_CONFIG.botName, 'Boaz')
  assert.deepEqual(DEFAULT_CONFIG.triggers, ['@boaz', '@בועז'])
  assert.equal(DEFAULT_CONFIG.model, 'claude-sonnet-5')
  assert.equal(DEFAULT_CONFIG.allowWebFetch, true)
  assert.equal(DEFAULT_CONFIG.perUserCooldownSec, 10)
  assert.equal(DEFAULT_CONFIG.hourlyCap, 30)
  assert.equal(DEFAULT_CONFIG.maxReplyChars, 1500)
  assert.equal(DEFAULT_CONFIG.contextMessages, 20)
  assert.equal(DEFAULT_CONFIG.claudeTimeoutSec, 150)
  assert.equal(DEFAULT_CONFIG.workerPollMs, 700)
  assert.equal(DEFAULT_CONFIG.maxSendAttempts, 3)
  assert.equal(DEFAULT_CONFIG.sarcasmLevel, 3)
  assert.equal(DEFAULT_CONFIG.reminderTickSec, 30)
  assert.equal(DEFAULT_CONFIG.followUps, true)
  assert.equal(DEFAULT_CONFIG.voice, true)
  assert.equal(DEFAULT_CONFIG.vision, true)
})

test('mergeConfig overlays file values but keeps unspecified defaults', () => {
  const merged = mergeConfig({ hourlyCap: 5, groupJid: '123@g.us' })
  assert.equal(merged.hourlyCap, 5)          // overridden
  assert.equal(merged.groupJid, '123@g.us')  // added
  assert.equal(merged.model, 'claude-sonnet-5') // default preserved
  assert.equal(merged.enabled, true)
})
