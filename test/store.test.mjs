import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb, storeMessages, recentContext, getMessageText, extractText } from '../src/wa/store.mjs'

const JID = 'group@g.us'
const mk = (id, ts, text) => ({
  key: { id, remoteJid: JID, participant: `u${id}@x` },
  pushName: `User ${id}`,
  messageTimestamp: ts,
  message: { conversation: text },
})

test('extractText reads plain and extended text', () => {
  assert.deepEqual(extractText({ message: { conversation: 'hi' } }), { kind: 'text', text: 'hi' })
  assert.deepEqual(
    extractText({ message: { extendedTextMessage: { text: 'yo' } } }),
    { kind: 'text', text: 'yo' },
  )
})

test('storeMessages dedups by id and filters to the chat', () => {
  const db = openDb(':memory:')
  const n1 = storeMessages(db, [mk('1', 100, 'a'), mk('2', 200, 'b')], JID)
  assert.equal(n1, 2)
  const n2 = storeMessages(db, [mk('2', 200, 'b')], JID) // dup
  assert.equal(n2, 0)
  const other = { ...mk('9', 300, 'x'), key: { id: '9', remoteJid: 'other@g.us' } }
  assert.equal(storeMessages(db, [other], JID), 0) // wrong chat filtered out
})

test('recentContext returns the last N oldest→newest', () => {
  const db = openDb(':memory:')
  storeMessages(db, [mk('1', 100, 'a'), mk('2', 200, 'b'), mk('3', 300, 'c')], JID)
  const ctx = recentContext(db, JID, 2)
  assert.deepEqual(ctx.map((r) => r.text), ['b', 'c'])
  assert.equal(ctx[0].sender_name, 'User 2')
})

test('getMessageText looks up one message by id', () => {
  const db = openDb(':memory:')
  storeMessages(db, [mk('7', 100, 'quoted body')], JID)
  assert.deepEqual(getMessageText(db, '7'), { sender_name: 'User 7', text: 'quoted body' })
  assert.equal(getMessageText(db, 'nope'), null)
})
