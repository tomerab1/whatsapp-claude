import test from 'node:test'
import assert from 'node:assert/strict'
import { matchesTrigger, isBotEcho, isAck, shouldReply, parseOwnerCommand, parseAdminCommand, parseDuration } from './trigger.mjs'

const TRIGGERS = ['@boaz', '@בועז']

test('matchesTrigger is case-insensitive and matches either language', () => {
  assert.equal(matchesTrigger('hey @Boaz what is 2+2', TRIGGERS), true)
  assert.equal(matchesTrigger('שאלה ל@בועז', TRIGGERS), true)
  assert.equal(matchesTrigger('no mention here', TRIGGERS), false)
})

test('isBotEcho detects the bot prefix at the start', () => {
  assert.equal(isBotEcho('🤖 the answer is 4', '🤖'), true)
  assert.equal(isBotEcho('a human saying 🤖', '🤖'), false)
})

test('isAck flags thanks/lol/emoji-only, not real questions', () => {
  assert.equal(isAck('תודה'), true)
  assert.equal(isAck('thanks!'), true)
  assert.equal(isAck('😂😂'), true)
  assert.equal(isAck('חחחח'), true)
  assert.equal(isAck('ok'), true)
  assert.equal(isAck('ומה עם מחר?'), false)
  assert.equal(isAck('and what about tomorrow?'), false)
})

test('shouldReply: explicit tag fires; bot echo never does', () => {
  assert.equal(shouldReply({ text: '@boaz hi', id: 'A', botPrefix: '🤖', triggers: TRIGGERS, sentIds: new Set() }), true)
  const sent = new Set(['B'])
  assert.equal(shouldReply({ text: '@boaz x', id: 'B', botPrefix: '🤖', triggers: TRIGGERS, sentIds: sent }), false)
  assert.equal(shouldReply({ text: '🤖 @boaz echo', id: 'C', botPrefix: '🤖', triggers: TRIGGERS, sentIds: sent }), false)
})

test('shouldReply: follow-up (reply to Boaz) fires unless it is an ack', () => {
  const base = { id: 'X', botPrefix: '🤖', triggers: TRIGGERS, sentIds: new Set() }
  assert.equal(shouldReply({ ...base, text: 'ומה לגבי יום ראשון?', quotedIsBot: true }), true) // real follow-up
  assert.equal(shouldReply({ ...base, text: 'תודה!', quotedIsBot: true }), false)               // ack → skip
  assert.equal(shouldReply({ ...base, text: 'ומה לגבי יום ראשון?', quotedIsBot: false }), false) // not a follow-up, no tag
})

test('parseDuration handles units and Hebrew', () => {
  assert.equal(parseDuration('30m'), 1800)
  assert.equal(parseDuration('1h'), 3600)
  assert.equal(parseDuration('2d'), 172800)
  assert.equal(parseDuration('90s'), 90)
  assert.equal(parseDuration('שעה'), 3600)
  assert.equal(parseDuration('45'), 2700) // bare number → minutes
  assert.equal(parseDuration('nonsense'), null)
})

test('parseOwnerCommand still works for on/off (owner only)', () => {
  assert.equal(parseOwnerCommand('@boaz off', 'owner@x', 'owner@x', TRIGGERS), 'off')
  assert.equal(parseOwnerCommand('@בועז on', 'owner@x', 'owner@x', TRIGGERS), 'on')
  assert.equal(parseOwnerCommand('@boaz off', 'stranger@x', 'owner@x', TRIGGERS), null)
})

test('parseAdminCommand: on/off/stats/sarcasm/mute/unmute, owner only', () => {
  const ctx = (over) => ({ senderJid: 'owner@x', ownerJid: 'owner@x', triggers: TRIGGERS, ...over })
  assert.deepEqual(parseAdminCommand('@boaz on', ctx()), { cmd: 'on' })
  assert.deepEqual(parseAdminCommand('@boaz stats', ctx()), { cmd: 'stats' })
  assert.deepEqual(parseAdminCommand('@boaz sarcasm 2', ctx()), { cmd: 'sarcasm', level: 2 })
  assert.deepEqual(parseAdminCommand('@boaz sarcasm off', ctx()), { cmd: 'sarcasm', level: 0 })
  assert.deepEqual(parseAdminCommand('@boaz sarcasm 9', ctx()), { cmd: 'sarcasm', level: 3 }) // clamped
  // mute the person whose message the owner replied to, default 1h
  assert.deepEqual(parseAdminCommand('@boaz mute', ctx({ quotedSenderJid: 'v@x' })), { cmd: 'mute', target: 'v@x', durationSec: 3600 })
  assert.deepEqual(parseAdminCommand('@boaz mute 30m', ctx({ quotedSenderJid: 'v@x' })), { cmd: 'mute', target: 'v@x', durationSec: 1800 })
  assert.deepEqual(parseAdminCommand('@boaz unmute', ctx({ mentionedJids: ['v@x'] })), { cmd: 'unmute', target: 'v@x' })
  assert.equal(parseAdminCommand('@boaz mute', ctx()), null)          // no target
  assert.equal(parseAdminCommand('@boaz off', ctx({ senderJid: 's@x' })), null) // not owner
})
