import test from 'node:test'
import assert from 'node:assert/strict'
import { matchesTrigger, isBotEcho, shouldReply, parseOwnerCommand } from './trigger.mjs'

const TRIGGERS = ['@claude', '@קלוד']

test('matchesTrigger is case-insensitive and matches either language', () => {
  assert.equal(matchesTrigger('hey @Claude what is 2+2', TRIGGERS), true)
  assert.equal(matchesTrigger('שאלה ל@קלוד', TRIGGERS), true)
  assert.equal(matchesTrigger('no mention here', TRIGGERS), false)
  assert.equal(matchesTrigger('', TRIGGERS), false)
})

test('isBotEcho detects the bot prefix at the start', () => {
  assert.equal(isBotEcho('🤖 the answer is 4', '🤖'), true)
  assert.equal(isBotEcho('   🤖 padded', '🤖'), true)
  assert.equal(isBotEcho('a human saying 🤖', '🤖'), false)
})

test('shouldReply fires on a trigger from a normal message', () => {
  assert.equal(
    shouldReply({ text: '@claude hi', id: 'A', botPrefix: '🤖', triggers: TRIGGERS, sentIds: new Set() }),
    true,
  )
})

test('shouldReply never fires on the bot own output (sent id or prefix echo)', () => {
  const sent = new Set(['B'])
  // same id the bot sent
  assert.equal(
    shouldReply({ text: '@claude anything', id: 'B', botPrefix: '🤖', triggers: TRIGGERS, sentIds: sent }),
    false,
  )
  // prefixed echo even with a new id (defense in depth)
  assert.equal(
    shouldReply({ text: '🤖 @claude echo', id: 'C', botPrefix: '🤖', triggers: TRIGGERS, sentIds: sent }),
    false,
  )
})

test('parseOwnerCommand only honors the owner and known verbs', () => {
  assert.equal(parseOwnerCommand('@claude off', 'owner@x', 'owner@x'), 'off')
  assert.equal(parseOwnerCommand('  @Claude ON ', 'owner@x', 'owner@x'), 'on')
  assert.equal(parseOwnerCommand('@claude off', 'stranger@x', 'owner@x'), null)
  assert.equal(parseOwnerCommand('@claude what is off', 'owner@x', 'owner@x'), null)
})
