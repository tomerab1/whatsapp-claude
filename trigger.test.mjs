import test from 'node:test'
import assert from 'node:assert/strict'
import { matchesTrigger, isBotEcho, shouldReply, parseOwnerCommand } from './trigger.mjs'

const TRIGGERS = ['@boaz', '@בועז']

test('matchesTrigger is case-insensitive and matches either language', () => {
  assert.equal(matchesTrigger('hey @Boaz what is 2+2', TRIGGERS), true)
  assert.equal(matchesTrigger('שאלה ל@בועז', TRIGGERS), true)
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
    shouldReply({ text: '@boaz hi', id: 'A', botPrefix: '🤖', triggers: TRIGGERS, sentIds: new Set() }),
    true,
  )
})

test('shouldReply never fires on the bot own output (sent id or prefix echo)', () => {
  const sent = new Set(['B'])
  assert.equal(
    shouldReply({ text: '@boaz anything', id: 'B', botPrefix: '🤖', triggers: TRIGGERS, sentIds: sent }),
    false,
  )
  assert.equal(
    shouldReply({ text: '🤖 @boaz echo', id: 'C', botPrefix: '🤖', triggers: TRIGGERS, sentIds: sent }),
    false,
  )
})

test('parseOwnerCommand only honors the owner and known verbs, derived from triggers', () => {
  assert.equal(parseOwnerCommand('@boaz off', 'owner@x', 'owner@x', TRIGGERS), 'off')
  assert.equal(parseOwnerCommand('  @Boaz ON ', 'owner@x', 'owner@x', TRIGGERS), 'on')
  assert.equal(parseOwnerCommand('@בועז off', 'owner@x', 'owner@x', TRIGGERS), 'off')
  assert.equal(parseOwnerCommand('@boaz off', 'stranger@x', 'owner@x', TRIGGERS), null)
  assert.equal(parseOwnerCommand('@boaz what is off', 'owner@x', 'owner@x', TRIGGERS), null)
  assert.equal(parseOwnerCommand('@claude off', 'owner@x', 'owner@x', TRIGGERS), null) // old word ignored
})
